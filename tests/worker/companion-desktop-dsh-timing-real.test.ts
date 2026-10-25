import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { Companion } from '../../src/shared/companions';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { createNativeAcceptanceBroker, createNativeAcceptanceLauncher, installedNativeAcceptanceSource } from '../helpers/companion-dsh-native-broker';

const port = vi.hoisted(() => ({ store: undefined as CompanionsStore | undefined,
  http: [] as Array<{ startedAt: string; headersAt?: string; finishedAt?: string; status?: number; model?: string }>,
  events: [] as Array<{ at: string; type: string; detail?: unknown }> }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = async (command: CompanionStorageCommand) => {
    if (command.type === 'loop.save') port.events.push({ at: new Date().toISOString(), type: 'loop.save', detail: {
      status: command.checkpoint.status, turns: command.checkpoint.turns.length, messageId: command.checkpoint.messageId } });
    if (command.type === 'action.update') port.events.push({ at: new Date().toISOString(), type: command.type,
      detail: { id: command.id, status: command.patch.status } });
    return port.store!.request(command);
  };
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: async (url: string, init?: RequestInit) => {
  const item: (typeof port.http)[number] = { startedAt: new Date().toISOString() };
  try { item.model = JSON.parse(String(init?.body)).model; } catch { /* Other traffic. */ }
  port.http.push(item);
  const response = await fetch(url, init); item.headersAt = new Date().toISOString(); item.status = response.status;
  void response.clone().arrayBuffer().then(() => { item.finishedAt = new Date().toISOString(); }).catch(() => undefined);
  return response;
} }, ipcMain: { handle: () => undefined }, dialog: {}, protocol: {}, shell: {},
safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() } }));

it.skipIf(process.env.WORLDLINEBOX_DESKTOP_TIMING_REAL !== '1')('times the current small fish brain listing the real desktop through its selected native DSH', async () => {
  const output = path.resolve(process.env.WORLDLINEBOX_DESKTOP_TIMING_OUTPUT ?? 'artifacts/desktop-dsh-timing/result.json');
  const sourceUserData = path.join(process.env.APPDATA!, 'WorldlineBox');
  const library = JSON.parse(await readFile(path.join(sourceUserData, 'companion-library.json'), 'utf8'));
  const sourceDatabase = path.join(library.libraryPath, '.worldlinebox/companions/messages.sqlite');
  const Database = BetterSqlite3 as { new (filename: string, options: { readonly: true; fileMustExist: true }): CompanionConnection };
  const sourceDb = new Database(sourceDatabase, { readonly: true, fileMustExist: true });
  let role: Companion;
  try { role = JSON.parse((sourceDb.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get('deepseek-flash') as { data: string }).data); }
  finally { sourceDb.close(); }
  if (role.llm) throw new Error('This benchmark expects the current fish to use its global model connection.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-desktop-timing-'));
  const config = await realGlobalChatConfig(path.join(root, 'profile'));
  const source = await installedNativeAcceptanceSource(sourceUserData);
  const native = await createNativeAcceptanceBroker(source);
  const bridge = await createNativeAcceptanceLauncher(native, { maxTaskRuns: 4, timeoutMs: 180000 });
  const dataRoot = path.join(root, 'companions'); await mkdir(dataRoot);
  const store = port.store = new CompanionsStore(path.join(dataRoot, 'messages.sqlite'), [{ ...role, proactive: false }]);
  const room = store.openPrivate(role.id);
  const errors: string[] = [], checkpoints: unknown[] = [], taskRequests: unknown[] = [], capabilityRequests: unknown[] = [];
  const requestTask = bridge.launcher.requestTask.bind(bridge.launcher);
  bridge.launcher.requestTask = async (request, execution) => {
    if (request.type === 'task.run') taskRequests.push({ at: new Date().toISOString(), request, task: execution?.task, access: execution?.access });
    return requestTask(request, execution);
  };
  const capabilities = bridge.launcher.taskCapabilities.bind(bridge.launcher);
  bridge.launcher.taskCapabilities = async (...args) => {
    const start = new Date().toISOString();
    try { const result = await capabilities(...args); capabilityRequests.push({ start, end: new Date().toISOString(), query: args[2] }); return result; }
    catch (error) { capabilityRequests.push({ start, end: new Date().toISOString(), failed: true }); throw error; }
  };
  const desktop = process.env.WORLDLINEBOX_BENCH_DESKTOP ?? path.join(os.homedir(), 'Desktop');
  const inventory = async () => (await readdir(desktop, { withFileTypes: true })).map(entry => ({ name: entry.name,
    type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' })).sort((a, b) => a.name.localeCompare(b.name));
  const expected = await inventory();
  const service = new CompanionService({ userData: path.join(root, 'profile'), dataRoot, workerPath: 'in-process-port',
    window: () => undefined, getConfig: () => config, hasConfig: () => true, dsh: () => bridge.launcher,
    report: error => errors.push(error instanceof Error ? error.message.replaceAll(config.apiKey, '[credential]') : String(error)) });
  let status = 'running', submittedAt: string | undefined, completedAt: string | undefined;
  let sourceId: string | undefined, finalLoop: ReturnType<CompanionsStore['request']>['loop'];
  const tasks = () => native.broker.state().map(record => ({ record, events: native.broker.events(record.id),
    result: native.broker.result(record.id) }));
  const snapshot = () => ({ status, isolationRoot: root, scope: 'current-source CompanionService + production native broker + selected installed DSH account/model/profile; in-process storage IPC; fresh isolated chat; no historical memory; no full launcher runtime admission',
    role: { id: role.id, name: role.name, revision: role.revision, personaSha256: createHash('sha256').update(role.persona).digest('hex') },
    mainModel: { model: config.model, apiFormat: config.apiFormat }, runtimeVersion: native.runtimeVersion,
    sourceInstance: { id: source.sourceProfile.instance.id, name: source.sourceProfile.instance.name },
    submittedAt, completedAt, elapsedMs: submittedAt && completedAt ? Date.parse(completedAt) - Date.parse(submittedAt) : undefined,
    sourceId, desktop, expected, taskRequests, capabilityRequests, tasks: tasks(), mainHttp: port.http,
    events: port.events, checkpoints, finalLoop, messages: store.messages({ conversationId: room.id, limit: 100 }).messages, errors });
  const save = async () => { const report = JSON.stringify(snapshot(), null, 2);
    if (report.includes(config.apiKey)) throw new Error('Credential found in benchmark report');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, report);
  };
  try {
    await service.handle({ type: 'state' });
    const content = '小肥鱼，请使用DSH实际查看我电脑当前Windows用户桌面目录顶层有哪些文件和文件夹，给我完整名称清单，并分别统计文件和文件夹的数量。不要递归子目录，不要修改任何文件。完成后直接在这里交付结果。';
    submittedAt = new Date().toISOString();
    console.log('DESKTOP_BENCH_SUBMIT', submittedAt);
    const sent = await service.handle({ type: 'message.send', conversationId: room.id, clientId: 'desktop_benchmark_' + randomUUID(), content });
    sourceId = sent.message!.id;
    let previous = '', nextSave = 0;
    const deadline = Date.now() + 360000;
    while (Date.now() < deadline) {
      finalLoop = store.request({ type: 'loop.get', sourceMessageId: sourceId, companionId: role.id }).loop;
      const current = JSON.stringify({ status: finalLoop?.status, turns: finalLoop?.turns.length,
        tasks: native.broker.state().map(task => ({ id: task.id, status: task.status })) });
      if (current !== previous) { checkpoints.push({ at: new Date().toISOString(), state: JSON.parse(current) });
        console.log('DESKTOP_BENCH_PROGRESS', current); previous = current; }
      if (finalLoop?.status === 'done') { completedAt = new Date().toISOString(); break; }
      if (Date.now() >= nextSave) { await save(); nextSave = Date.now() + 2000; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    status = completedAt ? 'completed' : 'timeout';
    await save();
    expect(completedAt, 'The actual companion final-delivery loop must finish.').toBeTruthy();
    const runs = native.broker.state().filter(task => task.title !== 'DSH capability discovery');
    expect(taskRequests.length, 'The companion must actually choose a DSH run.').toBeGreaterThan(0);
    expect(runs.some(task => task.status === 'succeeded')).toBe(true);
    const finalMessage = store.messages({ conversationId: room.id, limit: 100 }).messages.find(message => message.id === finalLoop?.messageId)!;
    const deliveredNames = new Set([...finalMessage.content.matchAll(/`([^`]+)`/gu)].map(match => match[1]));
    expect(expected.filter(entry => !deliveredNames.has(entry.name)), 'Every actual desktop name must be in the final delivery.').toEqual([]);
    expect(await inventory()).toEqual(expected);
    expect(await native.sourceConfigurationUnchanged()).toBe(true);
    status = 'passed';
    console.log('DESKTOP_BENCH_FINISH', JSON.stringify({ submittedAt, completedAt, elapsedMs: Date.parse(completedAt!) - Date.parse(submittedAt!), output }));
  } catch (error) {
    status = 'failed'; errors.push(error instanceof Error ? error.message.replaceAll(config.apiKey, '[credential]') : String(error)); throw error;
  } finally {
    await save();
    await service.shutdown(); await bridge.close();
    await save(); store.close();
    await native.dispose();
  }
}, 480000);
