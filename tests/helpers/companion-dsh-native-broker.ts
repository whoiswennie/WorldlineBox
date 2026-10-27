import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { InstanceService } from '../../src/main/dsh/instance-service';
import { DshTaskBroker } from '../../src/main/dsh/task-broker';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { dshInstanceSchema, dshRuntimeSchema, type DshInstance } from '../../src/shared/dsh-launcher';
import type { DshTaskExecutionOptions } from '../../src/main/dsh/task-execution';
import { OperationStore } from '../../src/main/dsh/operations';
import type { DshLauncher } from '../../src/main/dsh/launcher';

/** Metadata only: this does not boot a CLI, load an account or request a model. */
export async function installedNativeAcceptanceSource(userData = process.env.WORLDLINEBOX_USER_DATA_PATH ?? path.join(process.env.APPDATA!, 'WorldlineBox')) {
  const manager = path.join(userData, 'dsh');
  const instances = (JSON.parse(await readFile(path.join(manager, 'native-instances.json'), 'utf8')) as unknown[]).map(value => dshInstanceSchema.parse(value));
  const pinned = await readFile(path.join(manager, 'cli/native-selection.json'), 'utf8').then(text => JSON.parse(text) as { instanceId?: string }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;
  });
  const instance = instances.find(value => value.id === pinned?.instanceId) ?? instances.find(value => value.isDefault);
  if (!instance || path.resolve(instance.homePath) !== path.resolve(manager, 'instances', instance.id, 'home')) throw new Error('The selected native profile is unavailable.');
  const runtimes = (JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')) as unknown[]).map(value => dshRuntimeSchema.parse(value));
  const runtime = runtimes.find(value => value.id === instance.runtimeId);
  if (!runtime || runtime.adapter !== 'node-cli-web-v1') throw new Error('The selected profile does not use the installed native Node runtime.');
  return { program: path.join(manager, 'runtimes', runtime.id, 'program'),
    sourceProfile: { instance } };
}

type NativeAcceptanceOptions = { program: string; apiKey?: string; model?: string; baseURL?: string;
  sourceProfile?: { instance: DshInstance };
  onWorkerReadyChanged?: (instanceId: string, ready: boolean) => void };

/** Real native Web Host and production broker, isolated from the user's data. */
export async function createNativeAcceptanceBroker(options: NativeAcceptanceOptions) {
  const program = path.resolve(options.program), plan = { ...canonicalRuntimeEntryPaths(program, 'node-cli-web-v1'), env: {} };
  const manifest = JSON.parse(await readFile(path.join(program, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  const runtime = dshRuntimeSchema.parse({ id: 'runtime-native-acceptance', version: manifest.version, nodeVersion: '24', platform: 'win32-x64',
    adapter: 'node-cli-web-v1', source: program, sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: new Date().toISOString(), fileCount: 0, byteLength: 0 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-native-web-acceptance-'));
  const operations = new OperationStore(path.join(root, 'operations'), () => undefined); await operations.init();
  const instances = new InstanceService({ rootPath: root, bridgePackagePath: path.resolve('resources/dsh-bridge'), operations,
    runtimes: { list: () => [runtime], get: () => runtime, directory: () => program, plan: () => plan, verify: async () => undefined },
    onChanged: () => undefined, openWorkbench: async () => undefined, closeWorkbench: async () => undefined, clearBrowserData: async () => undefined });
  await instances.init(); const instance = await instances.create('Native acceptance', runtime.id);
  const guards: Record<string, string> = {};
  const sourceFile = async (filename: string) => { const bytes = await readFile(filename); guards[filename] = createHash('sha256').update(bytes).digest('hex'); return bytes; };
  let patch: unknown[];
  if (options.sourceProfile) {
    const home = options.sourceProfile.instance.homePath;
    const bytes = await sourceFile(path.join(home, 'cordis.patch.yml'));
    await writeFile(path.join(instance.homePath, 'cordis.patch.yml'), bytes, { mode: 0o600 });
    patch = [];
    await writeFile(path.join(instance.homePath, '.credentials.yaml'), await sourceFile(path.join(home, '.credentials.yaml')), { mode: 0o600 });
  } else {
    if (!options.apiKey || !options.model) throw new Error('A real model route is required.');
    patch = [{ id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', ...(options.baseURL ? { baseURL: options.baseURL } : {}) } },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: options.model } }];
    await writeFile(path.join(instance.homePath, '.credentials.yaml'), stringify({ version: 1, refs: { DEEPSEEK_API_KEY: options.apiKey } }), { mode: 0o600 });
  }
  if (!options.sourceProfile) await writeFile(path.join(instance.homePath, 'cordis.patch.yml'), stringify(patch), { mode: 0o600 });
  const broker = new DshTaskBroker({ rootPath: root, getHost: async () => {
    const client = await instances.ensureHost(instance.id); options.onWorkerReadyChanged?.(instance.id, true); return { instance, runtime, client };
  } });
  const execution: DshTaskExecutionOptions = { toolkit: true, interactive: true,
    recordScope: { actionId: randomUUID(), companionId: 'native-acceptance', conversationId: 'acceptance-conversation', sourceMessageId: 'acceptance-input' },
    workspaceRootPath: path.join(root, 'partner-work'), access: { mode: 'workspace-write' } };
  const configurationSnapshot = async () => {
    const result: Record<string, string> = {};
    const walk = async (directory: string) => { for (const name of await readdir(directory)) {
      if (['node_modules', 'storages', 'sessions', 'logs', 'cache'].includes(name)) continue;
      const filename = path.join(directory, name), info = await lstat(filename); if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(filename); else result[path.relative(root, filename)] = createHash('sha256').update(await readFile(filename)).digest('hex');
    } };
    await walk(instance.homePath); await walk(instance.agentsPath); return result;
  };
  const close = async () => { await broker.shutdown(); await instances.shutdown(); await operations.shutdown(); };
  return { root, broker, execution, instance, instances, runtimeVersion: manifest.version, configurationSnapshot,
    generation: async () => createHash('sha256').update(JSON.stringify(await configurationSnapshot())).digest('hex'),
    sourceConfigurationUnchanged: async () => (await Promise.all(Object.entries(guards).map(async ([filename, digest]) => createHash('sha256').update(await readFile(filename)).digest('hex') === digest))).every(Boolean),
    operation: () => ({ id: randomUUID(), signal: new AbortController().signal, log: async () => undefined, update: async () => undefined }),
    close, dispose: async () => { await close(); const relative = path.relative(os.tmpdir(), root); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unexpected fixture cleanup path.'); await rm(root, { recursive: true, force: true }); } };
}

/** Normal launcher task semantics over the real isolated broker. No model output,
 * task receipt, native event or ownership record is supplied by this fixture. */
export async function createNativeAcceptanceLauncher(native: Awaited<ReturnType<typeof createNativeAcceptanceBroker>>,
  limits: { maxTaskRuns: number; timeoutMs: number }) {
  if (!Number.isSafeInteger(limits.maxTaskRuns) || limits.maxTaskRuns < 1 || limits.maxTaskRuns > 20
    || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1000 || limits.timeoutMs > 300000) throw new Error('The real CLI acceptance budget is invalid.');
  const operationsRoot = path.join(native.root, 'operations'); await mkdir(operationsRoot);
  const operations = new OperationStore(operationsRoot, () => undefined); await operations.init();
  let taskRuns = 0, budgetExceeded = false;
  const launcher = {
    state: () => ({ tasks: native.broker.state(), operations: operations.list(), cli: { selectedInstanceId: native.instance.id },
      instances: [native.instance], runtimes: [{ id: native.instance.runtimeId, version: native.runtimeVersion }] }),
    taskCapabilities: (instanceId?: string, execution?: DshTaskExecutionOptions, query?: Parameters<DshLauncher['taskCapabilities']>[2]) =>
      native.broker.discover(instanceId, { ...native.execution, ...execution, ...(query ? { capabilityQuery: query } : {}) }),
    taskRecordScope: async (recordId: string) => (await native.broker.recordMetadata(recordId)).scope,
    readTaskRecord: (query: Parameters<DshLauncher['readTaskRecord']>[0]) => native.broker.readRecord(query),
    removeCompanionTaskRecords: (companionId: string) => native.broker.removeCompanionRecords(companionId),
    requestTask: async (request: Parameters<DshLauncher['requestTask']>[0], execution?: DshTaskExecutionOptions) => {
      if (request.type === 'task.run') {
        if (taskRuns >= limits.maxTaskRuns) { budgetExceeded = true; throw new Error('REAL_CLI_ACCEPTANCE_TASK_BUDGET'); }
        taskRuns++;
        return { ok: true, operationId: await operations.run('task.run', request.title ?? 'DSH task', native.instance.id, async operation => {
          await native.broker.execute({ prompt: request.prompt, title: request.title, instanceId: request.instanceId, sessionId: request.sessionId,
            timeoutMs: Math.min(request.timeoutMs ?? limits.timeoutMs, limits.timeoutMs), maxOutputBytes: request.maxOutputBytes }, operation,
          { ...native.execution, ...execution });
        }) };
      }
      if (request.type === 'task.result') return { ok: true, taskResult: native.broker.result(request.taskId) };
      if (request.type === 'task.events') return { ok: true, taskEvents: native.broker.events(request.taskId, request.after) };
      if (request.type === 'task.record') return { ok: true, taskRecord: await native.broker.readRecord(request.query) };
      if (request.type === 'task.message') await native.broker.sendInput(request.taskId, request.content, request.mode, request.messageId);
      if (request.type === 'task.cancel') { native.broker.cancel(request.taskId); operations.cancel(request.taskId); }
      if (request.type === 'task.terminate') { operations.cancel(request.taskId); await native.broker.terminate(request.taskId); }
      return { ok: true };
    },
  } as unknown as DshLauncher;
  return { launcher, telemetry: () => ({ root: native.root, taskRuns, taskLimit: limits.maxTaskRuns, taskTimeoutMs: limits.timeoutMs, budgetExceeded,
    nativeTurns: native.broker.state().reduce((sum, task) => sum + native.broker.events(task.id).filter(event => event.stage === 'turn_start').length, 0),
    modelLogicalCalls: null, modelHttpRequests: null, observation: 'Native turns and task runs only; CLI provider logical/HTTP calls are not covered by the Main fetch budget.',
    tasks: native.broker.state().map(task => ({ id: task.id, status: task.status, sessionId: task.sessionId, workspacePath: task.workspacePath, effective: task.effective })) }),
    close: async () => { await operations.shutdown(); await native.close(); } };
}
