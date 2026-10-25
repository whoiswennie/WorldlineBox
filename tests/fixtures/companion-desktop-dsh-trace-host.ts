import { app, net } from 'electron';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionStorageClient } from '../../src/main/companions/storage-client';
import { DshLauncher } from '../../src/main/dsh/launcher';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionModelConfig } from '../../src/main/companions/model';
import type { Companion } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

// Opt-in diagnostic only. The companion database and Electron session are
// isolated. The actual launcher uses the user's selected managed DSH runtime,
// including its integrity checks, preparation, worker pool and task archive.
const outputRoot = path.resolve(process.env.WORLDLINEBOX_DESKTOP_TRACE_ROOT!);
const sourceUserData = path.join(process.env.APPDATA!, 'WorldlineBox');
app.disableHardwareAcceleration();
app.getAppPath = () => process.cwd();
app.setPath('userData', path.join(outputRoot, 'profile'));
app.setPath('sessionData', path.join(outputRoot, 'profile'));

type Entry = { at: string; monotonicMs: number; kind: string; [key: string]: unknown };
const trace: Entry[] = [], errors: string[] = [], runs: Array<Record<string, unknown>> = [];
const origin = performance.now();
let config: CompanionModelConfig, launcher: DshLauncher | undefined, service: CompanionService | undefined;
let activeRun = -1, taskRuns = 0, httpCalls = 0;
const emit = (kind: string, details: Record<string, unknown> = {}) => {
  trace.push({ at: new Date().toISOString(), monotonicMs: performance.now() - origin, run: activeRun, kind, ...details });
};
const cleanError = (error: unknown) => String(error instanceof Error ? error.message : error).replaceAll(config?.apiKey || '\0', '[credential]');

// These wrappers observe actual implementations; they do not replace any
// response, bypass world readiness, change task parameters, or replay effects.
function instrument(target: object, name: string, prefix: string) {
  const holder = target as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = holder[name];
  if (typeof original !== 'function') throw new Error('Missing diagnostic method: ' + name);
  holder[name] = async function (...args) {
    const span = randomUUID(), started = performance.now();
    const detail = name === 'executeLoopTools' ? { toolCalls: (args[0] as { turn: { calls: unknown[] } }).turn.calls }
      : name === 'requestTask' && (args[0] as { type: string }).type === 'task.run' ? { request: args[0], execution: args[1] }
      : {};
    emit(prefix + '.' + name + '.begin', { span, ...detail });
    try {
      const result = await original.apply(this, args);
      emit(prefix + '.' + name + '.end', { span, elapsedMs: performance.now() - started,
        ...(name === 'executeLoopTools' || name === 'requestTask' || name === 'taskCapabilities' ? { result } : {}) });
      return result;
    } catch (error) {
      emit(prefix + '.' + name + '.error', { span, elapsedMs: performance.now() - started, error: cleanError(error) });
      throw error;
    }
  };
}

const requestStorage = CompanionStorageClient.prototype.request;
CompanionStorageClient.prototype.request = async function (command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
  const started = performance.now(), at = new Date().toISOString();
  const details = command.type === 'action.update' ? { id: command.id, patch: command.patch }
    : command.type === 'world.work.begin' || command.type === 'world.work.ready' ? { workId: command.workId }
    : {};
  if (command.type === 'loop.save') emit('loop.checkpoint', { checkpoint: structuredClone(command.checkpoint) });
  try {
    const result = await requestStorage.call(this, command);
    emit('storage', { command: command.type, startedAt: at, elapsedMs: performance.now() - started, ...details,
      ...(result.worldWork ? { worldWork: result.worldWork } : {}),
      ...(command.type === 'action.create' ? { action: result.action } : {}) });
    return result;
  } catch (error) {
    emit('storage.error', { command: command.type, startedAt: at, elapsedMs: performance.now() - started, error: cleanError(error) });
    throw error;
  }
};

const nativeFetch = net.fetch.bind(net);
net.fetch = async (input, init) => {
  if (++httpCalls > 20) throw new Error('Diagnostic main-model request budget exhausted.');
  const id = randomUUID(), started = performance.now();
  let model: unknown, purpose: unknown;
  try {
    const body = JSON.parse(String(init?.body)); model = body.model;
    const user = body.messages?.findLast((message: { role: string }) => message.role === 'user')?.content;
    if (typeof user === 'string') { try { purpose = JSON.parse(user).purpose; } catch { /* Normal dialogue. */ } }
  } catch { /* A request without a JSON body. */ }
  emit('http.begin', { id, model, purpose });
  const response = await nativeFetch(input, init);
  emit('http.headers', { id, elapsedMs: performance.now() - started, status: response.status });
  void response.clone().arrayBuffer().then(() => emit('http.body.end', { id, elapsedMs: performance.now() - started })).catch(() => undefined);
  return response;
};

const save = async () => {
  const report = JSON.stringify({ scope: 'Actual CompanionService, Electron utility-process SQLite transport, real DshLauncher and selected installed managed DSH. Fresh isolated companion chat/database; no historical memory or renderer polling load.',
    mainModel: config ? { model: config.model, apiFormat: config.apiFormat } : undefined, runs, trace, errors }, null, 2);
  if (config?.apiKey && report.includes(config.apiKey)) throw new Error('Credential must never enter diagnostic output.');
  await writeFile(path.join(outputRoot, 'trace.json'), report);
};

async function run() {
  await app.whenReady();
  config = await new Promise<CompanionModelConfig>(resolve => {
    process.once('message', message => resolve(message as CompanionModelConfig));
    process.send?.({ type: 'ready-for-config' });
  });
  const library = JSON.parse(await readFile(path.join(sourceUserData, 'companion-library.json'), 'utf8'));
  const Database = BetterSqlite3 as { new (filename: string, options: { readonly: true; fileMustExist: true }): CompanionConnection };
  const db = new Database(path.join(library.libraryPath, '.worldlinebox/companions/messages.sqlite'), { readonly: true, fileMustExist: true });
  let fish: Companion;
  try { fish = JSON.parse((db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get('deepseek-flash') as { data: string }).data); }
  finally { db.close(); }
  if (fish.llm) throw new Error('Current fish no longer uses the global model.');

  // Route only construction of the real launcher's root to the existing
  // manager. Chromium and companion data continue using the isolated profile.
  const getPath = app.getPath;
  app.getPath = function (name) { return name === 'userData' ? sourceUserData : getPath.call(app, name); };
  try { launcher = new DshLauncher(() => undefined, error => { errors.push(cleanError(error)); }); }
  finally { app.getPath = getPath; }
  const launcherInternals = launcher as unknown as { initialization: Promise<void>; tasks: object; runtimes: object };
  instrument(launcher, 'requestTask', 'launcher');
  instrument(launcher, 'taskCapabilities', 'launcher');
  instrument(launcherInternals.tasks, 'execute', 'broker');
  emit('launcher.initialization.begin');
  await launcherInternals.initialization;
  emit('launcher.initialization.end', { readiness: launcher.state().executionReadiness });

  const desktop = path.join(os.homedir(), 'Desktop');
  const inventory = async () => (await readdir(desktop, { withFileTypes: true })).map(entry => ({ name: entry.name,
    type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' })).sort((a, b) => a.name.localeCompare(b.name));
  const expected = await inventory();
  const timer = setInterval(() => { void save().catch(error => errors.push(cleanError(error))); }, 2000);
  try {
    for (activeRun = 0; activeRun < 2; activeRun++) {
      const dataRoot = path.join(outputRoot, 'companions-' + activeRun); await mkdir(dataRoot, { recursive: true });
      const seed = new CompanionsStore(path.join(dataRoot, 'messages.sqlite'), [{ ...fish, proactive: false }]);
      const room = seed.openPrivate(fish.id); seed.close();
      service = new CompanionService({ userData: path.join(outputRoot, 'profile'), dataRoot,
        workerPath: path.join(outputRoot, 'companion-worker.cjs'), appPath: process.cwd(),
        window: () => undefined, getConfig: () => config, hasConfig: () => true, dsh: () => launcher!,
        report: error => { errors.push(cleanError(error)); emit('reported.error', { error: cleanError(error) }); } });
      for (const name of ['executeLoopTools', 'captureExecutionEvidence', 'launchAction', 'queueAction', 'executeAction', 'assessAttention', 'executionEvidenceValid']) instrument(service, name, 'companion');
      const internals = service as unknown as { storage: CompanionStorageClient; world: object };
      instrument(internals.world, 'ready', 'world');
      await service.handle({ type: 'state' });
      const beforeTasks = new Set((launcher!.state().tasks ?? []).map(task => task.id));
      const content = '小肥鱼，请使用DSH实际查看我电脑当前Windows用户桌面目录顶层有哪些文件和文件夹，给我完整名称清单，并分别统计文件和文件夹的数量。不要递归子目录，不要修改任何文件。完成后直接在这里交付结果。';
      const started = performance.now(), submittedAt = new Date().toISOString();
      const observation: Record<string, unknown> = { index: activeRun, submittedAt, role: { id: fish.id, name: fish.name, revision: fish.revision,
        personaSha256: createHash('sha256').update(fish.persona).digest('hex') }, desktop, expected, readinessAtSubmit: launcher!.state().executionReadiness };
      runs.push(observation); emit('user.submit', { content }); process.send?.({ type: 'progress', run: activeRun, phase: 'submitted', at: submittedAt });
      const sent = await service.handle({ type: 'message.send', conversationId: room.id, clientId: 'desktop_trace_' + randomUUID(), content });
      const sourceId = sent.message!.id; observation.sourceId = sourceId;
      const deadline = Date.now() + 360000;
      let loop: CompanionLoopCheckpoint | undefined;
      while (Date.now() < deadline) {
        loop = (await internals.storage.request({ type: 'loop.get', companionId: fish.id, sourceMessageId: sourceId })).loop;
        if (loop?.status === 'done') break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const deliveredAt = new Date().toISOString();
      observation.finishedAt = deliveredAt; observation.elapsedMs = performance.now() - started;
      observation.status = loop?.status === 'done' ? 'completed' : 'timeout'; observation.loop = loop;
      const messages = (await internals.storage.request({ type: 'messages', conversationId: room.id, limit: 100 })).messages;
      observation.delivery = messages?.find(message => message.id === loop?.messageId);
      observation.tasks = (launcher!.state().tasks ?? []).filter(task => !beforeTasks.has(task.id));
      observation.operations = launcher!.state().operations.filter(operation => !beforeTasks.has(operation.id) && operation.startedAt >= submittedAt);
      observation.readinessAtFinish = launcher!.state().executionReadiness;
      const text = messages?.find(message => message.id === loop?.messageId)?.content ?? '';
      observation.missingNames = expected.filter(entry => !text.includes(entry.name)).map(entry => entry.name);
      observation.desktopInventoryUnchanged = JSON.stringify(await inventory()) === JSON.stringify(expected);
      emit('delivery.observed', { status: observation.status });
      process.send?.({ type: 'progress', run: activeRun, phase: observation.status, elapsedMs: observation.elapsedMs });
      await save();
      await service.shutdown(); service = undefined;
      if (observation.status !== 'completed') break;
    }
  } finally { clearInterval(timer); }
}

// Bound native runs without altering any model-selected task configuration.
const requestNative = DshLauncher.prototype.requestTask;
DshLauncher.prototype.requestTask = function (request, execution) {
  if (request.type === 'task.run') {
    if (++taskRuns > 4) throw new Error('Diagnostic native-task budget exhausted.');
    request = { ...request, timeoutMs: Math.min(request.timeoutMs ?? 180000, 180000) };
  }
  return requestNative.call(this, request, execution);
};

void run().catch(error => { errors.push(cleanError(error)); process.send?.({ type: 'error', error: cleanError(error) }); })
  .finally(async () => {
    await save();
    await service?.shutdown().catch(error => errors.push(cleanError(error)));
    await launcher?.shutdown().catch(error => errors.push(cleanError(error)));
    await save();
    const passed = runs.length === 2 && runs.every(run => run.status === 'completed' && (run.missingNames as unknown[]).length === 0 && run.desktopInventoryUnchanged);
    process.send?.({ type: 'finished', passed, output: path.join(outputRoot, 'trace.json') });
    app.exit(passed ? 0 : 1);
  });
