import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { DshTaskBroker } from '../../src/main/dsh/task-broker';
import { prepareNativeCliMode } from '../../src/main/dsh/cli-profile-mode';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { instanceEnvironment, launchCli, terminateOwnedProcess } from '../../src/main/dsh/instance-process';
import type { DshCliSelection } from '../../src/main/dsh/cli-terminal';
import type { DshTaskExecutionOptions } from '../../src/main/dsh/task-execution';
import { dshWorkerGeneration } from '../../src/main/dsh/warm-cli-pool';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { dshInstanceSchema, dshRuntimeSchema, type DshInstance } from '../../src/shared/dsh-launcher';
import { writeSharedModels } from '../../src/main/dsh/shared-settings';
import { credentialRoutingPatches } from '../../src/main/dsh/shared-credentials';
import { sharedSessionRoutingPatches } from '../../src/main/dsh/shared-session-data';
import { OperationStore } from '../../src/main/dsh/operations';
import type { DshLauncher } from '../../src/main/dsh/launcher';

/** Metadata only: this does not boot a CLI, load an account or request a model. */
export async function installedNativeAcceptanceSource(userData = process.env.WORLDLINEBOX_USER_DATA_PATH ?? path.join(process.env.APPDATA!, 'WorldlineBox')) {
  const manager = path.join(userData, 'dsh-launcher');
  const instances = (JSON.parse(await readFile(path.join(manager, 'instances.json'), 'utf8')) as unknown[]).map(value => dshInstanceSchema.parse(value));
  const pinned = await readFile(path.join(manager, 'cli/context.json'), 'utf8').then(text => JSON.parse(text) as { instanceId?: string }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;
  });
  const instance = instances.find(value => value.id === pinned?.instanceId) ?? instances.find(value => value.isDefault);
  if (!instance || path.resolve(instance.homePath) !== path.resolve(manager, 'instances', instance.id, 'home')) throw new Error('The selected native profile is unavailable.');
  const runtimes = (JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')) as unknown[]).map(value => dshRuntimeSchema.parse(value));
  const runtime = runtimes.find(value => value.id === instance.runtimeId);
  if (!runtime || runtime.adapter !== 'node-cli-web-v1') throw new Error('The selected profile does not use the installed native Node runtime.');
  return { program: path.join(manager, 'runtimes', runtime.id, 'program'),
    sourceProfile: { instance, sharedRoot: path.join(manager, 'shared') } };
}

type NativeAcceptanceOptions = { program: string; apiKey?: string; model?: string; baseURL?: string;
  sourceProfile?: { instance: DshInstance; sharedRoot: string };
  onWorkerReadyChanged?: (instanceId: string, ready: boolean) => void };

/** A temporary profile and real native Agent behind the production broker. No installed account/profile is changed. */
export async function createNativeAcceptanceBroker(options: NativeAcceptanceOptions) {
  if (options.sourceProfile && (options.apiKey !== undefined || options.model !== undefined || options.baseURL !== undefined))
    throw new Error('A source-profile acceptance must retain its own model and credential route.');
  if (!options.sourceProfile && (!options.apiKey || !options.model)) throw new Error('The native acceptance model route is missing.');
  const program = path.resolve(options.program);
  const sdk = path.join(program, 'dsh/node_modules');
  const anchor = path.join(sdk, '@deepseek-ai/dsh/package.json');
  const manifest = JSON.parse(await readFile(anchor, 'utf8')) as { version: string };
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-native-acceptance-'));
  const cleanup = async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('worldlinebox-native-acceptance-')) throw new Error('Unexpected native acceptance fixture root.');
    // This fixture links the actual installed runtime. Detach every link rather
    // than passing the tree to Electron's platform recursive remover.
    for (let attempt = 0; ; attempt++) {
      try { await removeOwnedDirectory(root); return; }
      catch (error) {
        if (attempt >= 20 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  };
  let broker: DshTaskBroker | undefined;
  try {
    const runtimeId = options.sourceProfile?.instance.runtimeId ?? 'runtime-acceptance';
    await mkdir(path.join(root, 'runtimes', runtimeId), { recursive: true });
    // The test resolves the real installed SDK through a directory link. Runtime sealing is covered separately.
    await symlink(program, path.join(root, 'runtimes', runtimeId, 'program'), process.platform === 'win32' ? 'junction' : 'dir');
    const instanceId = options.sourceProfile?.instance.id ?? 'acceptance';
    const instanceRoot = path.join(root, 'instances', instanceId);
    const workspace = path.join(root, 'workspace'); await mkdir(workspace);
    const instance: DshCliSelection['instance'] = { id: instanceId, name: 'Acceptance', runtimeId, profile: 'web', status: 'stopped',
      homePath: path.join(instanceRoot, 'home'), agentsPath: path.join(instanceRoot, 'agents'), workspacePath: workspace,
      browserPartition: 'temporary:acceptance', isDefault: true, createdAt: '', updatedAt: '' };
    const plan = { ...canonicalRuntimeEntryPaths(program, 'node-cli-web-v1'), env: {} };
    const env = await instanceEnvironment(instanceRoot, instance, plan); env.DSH_TELEMETRY_DISABLED = '1';
    const initialize = path.join(root, 'initialize.mjs');
    await writeFile(initialize, `import{createRequire}from'node:module';import{pathToFileURL}from'node:url';const load=createRequire(${JSON.stringify(anchor)});const native=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));native.initProfile(${JSON.stringify(path.join(instance.homePath, 'profiles/web'))},['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);`);
    const child = await launchCli({ ...plan, cli: initialize }, [], env, workspace); child.stdout.resume(); child.stderr.resume();
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      if (code !== 0) throw new Error('The temporary native acceptance profile could not be initialized.');
    } finally { await terminateOwnedProcess(child); }
    const configGuards: Record<string, string> = {};
    const sourceFile = async (filename: string, optional = false) => {
      const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => { if (optional && error.code === 'ENOENT') return undefined; throw error; });
      if (!info) return undefined;
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('The source profile configuration is not a small ordinary file.');
      const bytes = await readFile(filename); configGuards[filename] = createHash('sha256').update(bytes).digest('hex'); return bytes;
    };
    const nativeArgs = await prepareNativeCliMode(instanceRoot, program, manifest.version);
    if (options.sourceProfile) {
      const source = options.sourceProfile;
      for (const filename of ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
        const bytes = await sourceFile(path.join(source.instance.homePath, 'profiles/web', filename), true);
        if (bytes) await writeFile(path.join(instance.homePath, 'profiles/web', filename), bytes, { mode: 0o600 });
      }
      const settings = JSON.parse((await sourceFile(path.join(source.sharedRoot, 'model-settings.json')))!.toString('utf8')) as { values: unknown };
      const patch = path.join(instance.homePath, 'profiles/web/cordis.patch.yml');
      await writeFile(patch, writeSharedModels(await readFile(patch, 'utf8'), settings.values as Parameters<typeof writeSharedModels>[1]), { mode: 0o600 });
      const shared = path.join(root, 'shared');
      await Promise.all(['', 'sessions', 'documents', 'attachments/v1'].map(relative => mkdir(path.join(shared, relative), { recursive: true })));
      await writeFile(path.join(shared, '.credentials.yaml'), (await sourceFile(path.join(source.sharedRoot, '.credentials.yaml')))!, { mode: 0o600 });
      const routing = path.join(instanceRoot, 'isolated-data.patch.json');
      await writeFile(routing, JSON.stringify([...credentialRoutingPatches(shared), ...sharedSessionRoutingPatches(shared)]), { mode: 0o600 });
      nativeArgs.push('--patch', routing);
    } else {
      const profile = [{ id: 'agent-default-model', config: { provider: 'deepseek-official', model: options.model } },
        { id: 'llm-deepseek', config: { ...(options.baseURL ? { baseURL: options.baseURL } : {}), apiKeyEnv: 'WORLDLINEBOX_ACCEPTANCE_API_KEY', thinking: 'disabled' } }];
      await writeFile(path.join(instance.homePath, 'profiles/web/cordis.patch.yml'), JSON.stringify(profile));
      // Existing synthetic/explicit-key fixtures keep their original route.
      env.WORLDLINEBOX_ACCEPTANCE_API_KEY = options.apiKey!;
    }
    const selected: DshCliSelection = { instance, plan, env, nativeCli: plan.cli, nativeArgs, workspacePath: workspace, routingPatch: '',
      runtimeVersion: manifest.version, runtime: { id: runtimeId, version: manifest.version } as DshCliSelection['runtime'] };
    await mkdir(path.join(root, 'cli'));
    // This carrier only routes stdio to the real CLI. The broker, generated runtime, Agent, model, tools and sessions are production code.
    await writeFile(path.join(root, 'cli/shim.cjs'), String.raw`
const fs=require('node:fs'),{spawn}=require('node:child_process');
const context=JSON.parse(fs.readFileSync(process.env.WORLDLINEBOX_DSH_CLI_CONTEXT,'utf8'));
const child=spawn(context.executable,['--expose-internals',context.nativeCli,...context.nativeArgs,...process.argv.slice(2)],{cwd:context.workspacePath,env:process.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.once('error',()=>{process.exitCode=1;process.stdin.destroy()});
child.once('close',code=>{process.exitCode=code??1;process.stdin.destroy()});
`);
    broker = new DshTaskBroker({ rootPath: root, getSelection: async () => selected, onWorkerReadyChanged: options.onWorkerReadyChanged, pin: async selection => {
      const directory = path.join(root, 'cli', randomUUID()); await mkdir(directory);
      const contextFile = path.join(directory, 'context.json');
      await writeFile(contextFile, JSON.stringify({ executable: plan.executable, nativeCli: plan.cli, nativeArgs, workspacePath: selection.workspacePath }));
      return { contextFile, dispose: async () => { await rm(directory, { recursive: true, force: true }); } };
    } });
    const owner = { actionId: randomUUID(), companionId: 'native-acceptance', conversationId: 'acceptance-conversation', sourceMessageId: 'acceptance-input' };
    const execution: DshTaskExecutionOptions = { toolkit: true, interactive: true, recordScope: owner, workspaceRootPath: path.join(root, '.worldlinebox', 'companions', 'dsh-tasks'),
      access: { mode: 'workspace-write' } };
    const configurationSnapshot = async () => {
      const result: Record<string, string> = {}, excluded = new Set(['node_modules', '.git', 'storages', 'logs', 'cache', 'llm-deepseek', 'skills-disabled']);
      const walk = async (directory: string) => { for (const name of (await readdir(directory)).sort()) {
        if (excluded.has(name)) continue; const filename = path.join(directory, name), info = await lstat(filename);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await walk(filename);
        else if (info.isFile()) result[path.relative(instanceRoot, filename)] = createHash('sha256').update(await readFile(filename)).digest('hex').slice(0, 12);
      } };
      await walk(instance.homePath); await walk(instance.agentsPath); return result;
    };
    const sourceConfigurationUnchanged = async () => (await Promise.all(Object.entries(configGuards).map(async ([filename, digest]) =>
      createHash('sha256').update(await readFile(filename)).digest('hex') === digest))).every(Boolean);
    return { root, broker, execution, instance, runtimeVersion: manifest.version, sourceConfigurationUnchanged,
      generation: () => dshWorkerGeneration(root, selected, execution.access), configurationSnapshot,
      operation: () => ({ id: randomUUID(), signal: new AbortController().signal, log: async () => undefined, update: async () => undefined }),
      close: async () => { await broker!.shutdown(); },
      dispose: async () => { await broker!.shutdown(); await cleanup(); } };
  } catch (error) { await broker?.shutdown(); await cleanup(); throw error; }
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
      instances: [native.instance], runtimes: [{ id: native.instance.runtimeId, version: native.runtimeVersion }], taskAccess: { mode: 'read-only' } }),
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
