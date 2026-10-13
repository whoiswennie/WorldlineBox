import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { rebaseInstancePnpmMetadata } from './pack-pnpm-metadata';
import { rebaseCopiedSessionData } from './instance-data-rebase';
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import {
  dshInstanceSchema, dshSnapshotSchema, dshSharedDataSchema, type DshInstance, type DshRuntime,
  type DshSnapshot, type DshLauncherRequest, type DshLauncherResponse,
} from '../../shared/dsh-launcher';
import { atomicJson, copyTree, inventoryTree, readJson, removeManaged, type TreeInventory } from './files';
import type { OperationStore, OperationContext } from './operations';
import { auditInstanceConfiguration, rebaseInstanceConfiguration } from './instance-configuration';
import {
  inspectManagedProcess, instanceEnvironment, launchCli, parseReadyUrl, recoverOwnedProcess,
  sanitizeOutput, terminateOwnedProcess, verifyReadyUrl, type ProcessIdentity, type RuntimeLaunchPlan,
} from './instance-process';
import type { SharedInstanceData } from './shared-instance-data';
import type { DshCliSelection } from './cli-terminal';
import { prepareNativeCliMode } from './cli-profile-mode';
import { writeSharedModels } from './shared-settings';
import { isolatedWorkspacePath, writeIsolatedRoutingPatch } from './isolated-routing';
import { supportsSharedDataRuntime } from './validated-runtime';
import { prepareManagedHostBootstrap, stopManagedHost, HOST_LIFECYCLE_TOKEN_ENV } from './host-lifecycle';

export interface RuntimeServiceLike {
  list(): DshRuntime[];
  get(id: string): DshRuntime;
  directory(id: string): string;
  plan(id: string): RuntimeLaunchPlan;
  verify(id: string, signal?: AbortSignal): Promise<void>;
}
interface Options {
  rootPath: string; runtimes: RuntimeServiceLike; operations: OperationStore; onChanged: () => void;
  openWorkbench: (instance: DshInstance, url: string) => Promise<void>;
  closeWorkbench: (instanceId: string) => Promise<void>;
  clearBrowserData: (instanceId: string) => Promise<void>;
  sharedData?: SharedInstanceData;
  networkEnvironment?: (base: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>;
  onSelectedWebInstance?: (selection: DshCliSelection) => Promise<boolean>;
  isCliInUse?: (instanceId?: string) => boolean;
}
interface ManagedProcess {
  child: ChildProcessWithoutNullStreams; url?: string; stopping: boolean;
  finished: Promise<void>; logWrites: Promise<void>;
  lifecycleToken?: string;
}
const backupManifestSchema = z.object({
  format: z.literal('worldlinebox-dsh-backup-v1'), instance: dshInstanceSchema,
  inventory: z.object({
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/), fileCount: z.number().int().nonnegative(), byteLength: z.number().int().nonnegative(),
    files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() })),
  }),
  runtimeContentSha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string(),
  sharedData: dshSharedDataSchema.optional(),
  sharedInventory: z.object({
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/), fileCount: z.number().int().nonnegative(), byteLength: z.number().int().nonnegative(),
    files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() })),
  }).optional(),
});

/** Only disposable caches and process locks are excluded. Session, plugin, skill and workspace data are copied together. */
function skipMutableFile(relative: string): boolean {
  const value = relative.replaceAll('\\', '/');
  const parts = value.split('/');
  if (value === 'home/logs' || value.startsWith('home/logs/')) return true;
  if (parts.some(part => ['.plugin-manager', '.DS_Store', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(part))) return true;
  if (/\.(?:writer|process)\.lock$/i.test(value) || /(?:^|\/)package\.json\.lock(?:\/|$)/i.test(value)) return true;
  if (value.startsWith('user/') && parts.some(part => ['Cache', 'Code Cache', 'GPUCache', 'Crashpad', 'Temp', '.cache'].includes(part))) return true;
  return false;
}

export class InstanceService {
  private instances: DshInstance[] = [];
  private snapshotRecords: DshSnapshot[] = [];
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly busy = new Set<string>();
  private readonly cliPreparations = new Map<string, Promise<void>>();
  private readonly recoveryBlocked = new Set<string>();
  private writes = Promise.resolve();
  private closing = false;
  private sharedBackupBusy = false;
  private starts: Promise<void> = Promise.resolve();
  constructor(private readonly options: Options) {}

  async init(): Promise<void> {
    for (const directory of ['instances', 'snapshots', 'staging']) await mkdir(path.join(this.options.rootPath, directory), { recursive: true });
    const stored = await readJson<unknown[]>(path.join(this.options.rootPath, 'instances.json')) ?? [];
    this.instances = stored.map(value => dshInstanceSchema.parse(value));
    this.snapshotRecords = (await readJson<unknown[]>(path.join(this.options.rootPath, 'snapshots.json')) ?? []).map(value => dshSnapshotSchema.parse(value));
    const ids = new Set<string>();
    for (const instance of this.instances) {
      if (ids.has(instance.id)) throw new Error('Duplicate Harness instance identity in registry.');
      ids.add(instance.id);
      const paths = this.paths(instance.id);
      if (instance.homePath !== paths.homePath || instance.agentsPath !== paths.agentsPath || instance.workspacePath !== paths.workspacePath
        || instance.browserPartition !== `persist:dsh-instance-${instance.id}`) throw new Error('Harness instance registry contains an unmanaged data path.');
      await this.ownedRoot(instance.id);
      const journal = await readJson<ProcessIdentity>(path.join(this.getRoot(instance.id), 'process.json'));
      if (journal) {
        try {
          const plan = this.options.runtimes.plan(instance.runtimeId);
          const identityPath = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
          if (identityPath(journal.executable) !== identityPath(plan.executable) || identityPath(journal.cli) !== identityPath(plan.cli)) throw new Error('Saved Harness process identity differs from the fixed runtime.');
          await recoverOwnedProcess(journal); await rm(path.join(this.getRoot(instance.id), 'process.json'), { force: true });
        }
        catch (error) { this.recoveryBlocked.add(instance.id); instance.lastError = sanitizeOutput(String(error)); }
      }
      if (instance.status !== 'stopped' || journal) {
        instance.status = 'failed';
        instance.lastError ??= 'The previous Harness launch was interrupted. Its owned process was stopped; data was retained.';
      }
      delete instance.pid; delete instance.port;
    }
    if (this.instances.length && !this.instances.some(instance => instance.isDefault)) this.instances[0]!.isDefault = true;
    await this.save();
  }

  list(): DshInstance[] { return this.instances.map(instance => ({ ...instance })); }
  snapshots(): DshSnapshot[] { return this.snapshotRecords.map(snapshot => ({ ...snapshot })); }
  getRoot(instanceId: string): string {
    if (!/^[a-z0-9-]{1,80}$/.test(instanceId)) throw new Error('Invalid Harness instance ID.');
    return path.join(this.options.rootPath, 'instances', instanceId);
  }
  getUrl(instanceId: string): string | undefined { return this.processes.get(instanceId)?.url; }
  get(instanceId: string): DshInstance { return { ...this.require(instanceId) }; }
  launchPlan(instanceId: string): RuntimeLaunchPlan { return this.options.runtimes.plan(this.require(instanceId).runtimeId); }
  async prepareCli(instanceId: string, signal?: AbortSignal, runtimeId?: string): Promise<DshCliSelection> {
    // Serialize only private profile preparation. The returned pinned CLI tasks
    // run concurrently; one prepare must not look like a conflicting mutation.
    const previous = this.cliPreparations.get(instanceId) ?? Promise.resolve();
    let release!: () => void;
    const own = new Promise<void>(resolve => { release = resolve; });
    const turn = previous.catch(() => undefined).then(() => own);
    this.cliPreparations.set(instanceId, turn);
    let removeAbort = () => {};
    try {
      signal?.throwIfAborted();
      await Promise.race([previous, new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        const abort = () => reject(signal.reason ?? new Error('CLI preparation cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', abort);
      })]);
      signal?.throwIfAborted();
      return await this.prepareCliNow(instanceId, signal, runtimeId);
    } finally {
      removeAbort(); release();
      if (this.cliPreparations.get(instanceId) === turn) {
        void turn.then(() => { if (this.cliPreparations.get(instanceId) === turn) this.cliPreparations.delete(instanceId); });
      }
    }
  }
  private async prepareCliNow(instanceId: string, signal?: AbortSignal, runtimeId?: string): Promise<DshCliSelection> {
    signal?.throwIfAborted();
    const original = this.ensureAvailable(instanceId);
    const instance = runtimeId ? { ...original, runtimeId } : original;
    if (instance.status === 'starting' || instance.status === 'stopping') throw new Error('Wait for the DSH instance to finish starting or stopping before selecting its CLI environment.');
    this.busy.add(instanceId);
    try {
      const runtime = this.options.runtimes.get(instance.runtimeId);
      await this.options.runtimes.verify(instance.runtimeId, signal); signal?.throwIfAborted();
      const plan = this.options.runtimes.plan(instance.runtimeId);
      let routingPatch = '';
      const workspacePath = instance.dataScope === 'isolated' ? isolatedWorkspacePath(this.getRoot(instanceId)) : this.options.sharedData?.paths.workspacePath ?? instance.workspacePath;
      if (instance.dataScope === 'isolated') {
        await mkdir(workspacePath, { recursive: true });
        routingPatch = await writeIsolatedRoutingPatch(this.getRoot(instanceId), this.options.runtimes.directory(instance.runtimeId), runtime.version);
      } else if (this.options.sharedData) {
        if (this.processes.has(instanceId)) routingPatch = await this.options.sharedData.routingForRunning(instance, runtime.version);
        else {
          const preparation: OperationContext | undefined = signal ? { id: randomUUID(), signal, update: async () => undefined, log: async () => undefined } : undefined;
          const shared = await this.options.sharedData.prepare(instance, runtime.version, preparation, this.processes.size === 0);
          routingPatch = shared.args[1]!;
        }
      }
      signal?.throwIfAborted();
      const nativeArgs = await prepareNativeCliMode(this.getRoot(instanceId), this.options.runtimes.directory(instance.runtimeId), runtime.version, signal);
      if (routingPatch) nativeArgs.push('--patch', routingPatch);
      return { instance: { ...instance }, plan, env: await this.environment(this.getRoot(instanceId), instance, plan),
        workspacePath, routingPatch, nativeCli: plan.cli, nativeArgs, runtimeVersion: runtime.version };
    } finally { this.busy.delete(instanceId); }
  }
  private async environment(root: string, instance: DshInstance, plan: RuntimeLaunchPlan): Promise<NodeJS.ProcessEnv> {
    const env = await instanceEnvironment(root, instance, plan);
    return this.options.networkEnvironment ? this.options.networkEnvironment(env) : env;
  }
  private paths(id: string) {
    const root = this.getRoot(id);
    return { homePath: path.join(root, 'home'), agentsPath: path.join(root, 'agents'), workspacePath: path.join(root, 'workspace') };
  }
  private require(id: string): DshInstance {
    const instance = this.instances.find(candidate => candidate.id === id);
    if (!instance) throw new Error('Harness instance was not found.');
    return instance;
  }
  private async ownedRoot(id: string): Promise<string> {
    const manager = await realpath(this.options.rootPath); const root = await realpath(this.getRoot(id));
    const relative = path.relative(manager, root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Harness instance directory points outside managed storage.');
    return root;
  }
  private save(): Promise<void> {
    const instances = this.list(); const snapshots = this.snapshots();
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await atomicJson(path.join(this.options.rootPath, 'instances.json'), instances);
      await atomicJson(path.join(this.options.rootPath, 'snapshots.json'), snapshots);
    });
    return this.writes;
  }
  private async changed(): Promise<void> { await this.save(); this.options.onChanged(); }
  private ensureAvailable(instanceId: string, stopped = false, allowTerminal = false): DshInstance {
    const instance = this.require(instanceId);
    if (this.closing) throw new Error('Harness launcher is closing.');
    if (this.sharedBackupBusy) throw new Error('Wait for the shared-data backup or restore to finish.');
    if (this.recoveryBlocked.has(instanceId)) throw new Error(instance.lastError ?? 'The previous Harness process must be stopped before editing its data.');
    if (this.busy.has(instanceId)) throw new Error('Another operation is already using this Harness instance.');
    if (stopped && !allowTerminal && this.options.isCliInUse?.(instanceId)) throw new Error('Close this instance’s CLI terminal before changing or copying its environment.');
    if (stopped && (this.processes.has(instanceId) || ['running', 'starting', 'stopping'].includes(instance.status))) throw new Error('Stop this Harness instance before changing or copying its data.');
    return instance;
  }
  async withStoppedInstance<T>(instanceId: string, work: () => Promise<T>, globalAccess = false): Promise<T> {
    this.ensureAvailable(instanceId, true); this.busy.add(instanceId);
    try { return await (this.options.sharedData ? this.options.sharedData.exclusive(work, globalAccess ? undefined : instanceId) : work()); } finally { this.busy.delete(instanceId); }
  }

  async handle(request: DshLauncherRequest): Promise<DshLauncherResponse> {
    try {
      switch (request.type) {
        case 'instance.create': {
          const operationId = await this.options.operations.run(request.type, `Create ${request.name}`, undefined,
            async op => { await this.create(request.name, request.runtimeId, op, request.dataScope); });
          return { ok: true, operationId };
        }
        case 'instance.rename': {
          this.ensureAvailable(request.instanceId); const instance = this.require(request.instanceId);
          instance.name = request.name; instance.updatedAt = new Date().toISOString(); await this.changed(); return { ok: true };
        }
        case 'instance.default': {
          this.require(request.instanceId); for (const instance of this.instances) instance.isDefault = instance.id === request.instanceId;
          await this.changed(); return { ok: true };
        }
        case 'instance.open': {
          const instance = this.require(request.instanceId); const url = this.getUrl(instance.id);
          if (instance.status !== 'running' || !url) throw new Error('Start this Harness instance before opening its workbench.');
          await this.options.openWorkbench({ ...instance }, url); return { ok: true };
        }
        case 'instance.logs': return { ok: true, text: await this.readLogs(request.instanceId) };
        case 'snapshot.restore': {
          const snapshot = this.requireSnapshot(request.snapshotId);
          const operationId = await this.options.operations.run(request.type, `Restore ${snapshot.name}`, undefined,
            async op => { await this.restoreFrom(path.join(this.options.rootPath, 'snapshots', snapshot.id), request.name, op); });
          return { ok: true, operationId };
        }
        case 'snapshot.delete': {
          const snapshot = this.requireSnapshot(request.snapshotId);
          if (this.options.operations.list().some(operation => operation.status === 'running' && operation.kind === 'snapshot.restore')) throw new Error('Wait for snapshot restoration to complete.');
          await removeManaged(this.options.rootPath, path.join(this.options.rootPath, 'snapshots', snapshot.id));
          this.snapshotRecords = this.snapshotRecords.filter(value => value.id !== snapshot.id); await this.changed(); return { ok: true };
        }
        case 'instance.clone': return await this.runForInstance(request.type, request.instanceId, true, async op => {
          await this.clone(request.instanceId, request.name, request.runtimeId, op);
        });
        case 'instance.start': return await this.runForInstance(request.type, request.instanceId, true, op => this.start(request.instanceId, op));
        case 'instance.switch-start': return await this.runForInstance(request.type, request.instanceId, true, op => this.start(request.instanceId, op, true));
        case 'instance.stop': return await this.runForInstance(request.type, request.instanceId, false, op => this.stop(request.instanceId, op));
        case 'instance.delete': return await this.runForInstance(request.type, request.instanceId, true, async () => { await this.remove(request.instanceId, true); });
        case 'instance.plugin': return await this.runForInstance(request.type, request.instanceId, true, async op => {
          const output = await this.plugin(request.instanceId, request.action, request.spec, op); await op.log(output);
        });
        case 'instance.check': return await this.runForInstance(request.type, request.instanceId, true, async op => {
          await this.options.runtimes.verify(this.require(request.instanceId).runtimeId, op.signal);
          await op.update('Checking isolated data paths', 70);
          await this.auditLinks(request.instanceId, op.signal); await op.log('Runtime seal and isolated data links verified.');
        });
        case 'snapshot.create': return await this.runForInstance(request.type, request.instanceId, true, op => this.snapshot(request.instanceId, request.name, op));
        default: throw new Error('This request is not handled by the Harness instance service.');
      }
    } catch (error) { return { ok: false, error: sanitizeOutput(error instanceof Error ? error.message : String(error)) }; }
  }

  private async runForInstance(kind: string, id: string, stopped: boolean, work: (op: OperationContext) => Promise<void>): Promise<DshLauncherResponse> {
    const launching = kind === 'instance.start' || kind === 'instance.switch-start';
    const instance = this.ensureAvailable(id, stopped, launching); this.busy.add(id);
    try {
      const operationId = await this.options.operations.run(kind, `${kind}: ${instance.name}`, id, async op => {
        try {
          if (stopped && !launching && this.options.sharedData) await this.options.sharedData.exclusive(() => work(op), id);
          else await work(op);
        }
        finally { this.busy.delete(id); this.options.onChanged(); }
      });
      return { ok: true, operationId };
    } catch (error) { this.busy.delete(id); throw error; }
  }

  async create(name: string, runtimeId: string, op?: OperationContext, requestedScope?: 'shared' | 'isolated'): Promise<DshInstance> {
    if (this.closing) throw new Error('Harness launcher is closing.');
    const runtime = this.options.runtimes.get(runtimeId);
    const id = randomUUID(); const now = new Date().toISOString();
    const instance: DshInstance = dshInstanceSchema.parse({
      id, name, runtimeId, createdAt: now, updatedAt: now, profile: 'web', status: 'stopped',
      ...this.paths(id), browserPartition: `persist:dsh-instance-${id}`, isDefault: this.instances.length === 0,
      dataScope: requestedScope ?? (this.options.sharedData && !supportsSharedDataRuntime(runtime.version) ? 'isolated' : 'shared'),
    });
    op?.signal.throwIfAborted();
    try {
      await instanceEnvironment(this.getRoot(id), instance, this.options.runtimes.plan(runtimeId));
      await mkdir(path.join(this.getRoot(id), 'logs'), { recursive: true });
      await atomicJson(path.join(this.getRoot(id), 'instance-lock.json'), {
        format: 1, runtimeId, runtimeContentSha256: this.options.runtimes.get(runtimeId).contentSha256, profile: 'web',
      });
      op?.signal.throwIfAborted(); this.instances.push(instance); await this.changed();
    }
    catch (error) { this.instances = this.instances.filter(value => value.id !== id); await removeManaged(this.options.rootPath, this.getRoot(id)); throw error; }
    return { ...instance };
  }

  private async start(id: string, op: OperationContext, switchCurrent = false): Promise<void> {
    const task = this.starts.then(async () => {
      const current = this.instances.filter(instance => instance.id !== id && (this.processes.has(instance.id) || ['starting', 'running', 'stopping'].includes(instance.status)));
      if (current.length && !switchCurrent) throw new Error(`Only one DSH WebUI can run at a time. Stop ${current[0]!.name} or choose Switch and start.`);
      for (const instance of current) {
        this.ensureAvailable(instance.id);
        this.busy.add(instance.id);
        try { await this.stop(instance.id, op); } finally { this.busy.delete(instance.id); }
      }
      await this.startPrepared(id, op);
    });
    this.starts = task.then(() => undefined, () => undefined);
    return task;
  }
  private async startPrepared(id: string, op: OperationContext): Promise<void> {
    const instance = this.require(id); const root = this.getRoot(id);
    const plan = this.options.runtimes.plan(instance.runtimeId);
    await op.update('Verifying fixed runtime', 5); await this.options.runtimes.verify(instance.runtimeId, op.signal);
    const runtimeVersion = this.options.runtimes.get(instance.runtimeId).version;
    const isolatedWorkspace = isolatedWorkspacePath(root);
    if (instance.dataScope === 'isolated') await mkdir(isolatedWorkspace, { recursive: true });
    const sharedLaunch = instance.dataScope === 'isolated'
      ? { args: ['--patch', await writeIsolatedRoutingPatch(root, this.options.runtimes.directory(instance.runtimeId), runtimeVersion, op.signal)], workspacePath: isolatedWorkspace }
      : await this.options.sharedData?.prepare(instance, runtimeVersion, op, this.processes.size === 0);
    await this.auditLinks(id, op.signal);
    const env = await this.environment(root, instance, plan);
    let selected = !this.options.onSelectedWebInstance;
    if (this.options.onSelectedWebInstance) {
      const nativeArgs = await prepareNativeCliMode(root, this.options.runtimes.directory(instance.runtimeId), this.options.runtimes.get(instance.runtimeId).version, op.signal);
      const routingPatch = sharedLaunch?.args[1] ?? '';
      if (routingPatch) nativeArgs.push('--patch', routingPatch);
      selected = await this.options.onSelectedWebInstance({ instance: { ...instance }, plan, env, workspacePath: sharedLaunch?.workspacePath ?? instance.workspacePath,
        routingPatch, nativeCli: plan.cli, nativeArgs, runtimeVersion: this.options.runtimes.get(instance.runtimeId).version });
    }
    if (selected) for (const value of this.instances) value.isDefault = value.id === id;
    instance.status = 'starting'; instance.lastError = undefined; instance.lastExitCode = undefined;
    await this.changed(); await op.update('Starting isolated Harness Host', 30);
    let managed: ManagedProcess | undefined;
    try {
      op.signal.throwIfAborted();
      const hostArgs = ['web', ...(sharedLaunch?.args ?? []), '--no-open', '--host', '127.0.0.1', '--port', '0'];
      const bootstrap = this.options.runtimes.get(instance.runtimeId).adapter === 'node-cli-web-v1'
        ? await prepareManagedHostBootstrap(root, plan.cli) : undefined;
      const child = await launchCli(bootstrap ? { ...plan, cli: bootstrap.bootstrapPath } : plan,
        bootstrap ? [bootstrap.nativeCli, ...hostArgs] : hostArgs, bootstrap ? { ...env, [HOST_LIFECYCLE_TOKEN_ENV]: bootstrap.token } : env,
        sharedLaunch?.workspacePath ?? instance.workspacePath, { ipc: !!bootstrap });
      let resolveReady!: (url: string) => void; let rejectReady!: (error: Error) => void;
      const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      void ready.catch(() => undefined);
      // A single observation owns the process. Readiness URLs never leave the main process or enter raw logs.
      managed = this.observe(id, child, line => { const url = parseReadyUrl(line); if (url) resolveReady(url); }, rejectReady);
      managed.lifecycleToken = bootstrap?.token;
      this.processes.set(id, managed);
      instance.pid = child.pid;
      if (!child.pid) throw new Error('Could not launch the fixed Harness executable.');
      const identity: ProcessIdentity = { pid: child.pid, executable: plan.executable, cli: plan.cli };
      await atomicJson(path.join(root, 'process.json'), identity);
      if (process.platform === 'win32') {
        const processIdentity = await inspectManagedProcess(child);
        if (!processIdentity) throw new Error('Harness exited before its process identity could be recorded.');
        identity.createdAt = processIdentity.createdAt;
        await atomicJson(path.join(root, 'process.json'), identity);
      }
      await this.changed();
      const timeout = setTimeout(() => rejectReady(new Error('Harness did not become ready within 120 seconds. Open logs for details.')), 120_000);
      const abort = () => rejectReady(new Error('Harness start cancelled.'));
      op.signal.addEventListener('abort', abort, { once: true });
      let url: string;
      try { op.signal.throwIfAborted(); url = await ready; } finally { clearTimeout(timeout); op.signal.removeEventListener('abort', abort); }
      await op.update('Verifying authenticated workbench', 85);
      await verifyReadyUrl(url, op.signal);
      if (child.exitCode !== null || child.signalCode !== null || this.processes.get(id) !== managed) throw new Error('Harness exited during readiness verification.');
      managed.url = url; instance.port = Number(new URL(url).port); instance.status = 'running';
      if (instance.dataScope !== 'isolated') await this.options.sharedData?.attach(instance, url);
      instance.updatedAt = new Date().toISOString(); await this.changed();
      op.signal.throwIfAborted(); await this.options.openWorkbench({ ...instance }, url);
    } catch (error) {
      await this.options.sharedData?.detach(id);
      if (managed) { managed.stopping = true; await terminateOwnedProcess(managed.child); await managed.finished; }
      instance.status = 'failed'; instance.lastError = sanitizeOutput(error instanceof Error ? error.message : String(error));
      delete instance.pid; delete instance.port; await this.changed(); throw error;
    }
  }

  private observe(id: string, child: ChildProcessWithoutNullStreams, onLine: (line: string) => void, onError: (error: Error) => void): ManagedProcess {
    const root = this.getRoot(id); let resolveFinished!: () => void;
    const managed: ManagedProcess = { child, stopping: false, logWrites: Promise.resolve(), finished: new Promise(resolve => { resolveFinished = resolve; }) };
    const output = (stream: NodeJS.ReadableStream) => {
      const decoder = new StringDecoder('utf8'); let pending = '';
      const line = (value: string) => {
        onLine(value);
        managed.logWrites = managed.logWrites.catch(() => undefined).then(() => appendFile(path.join(root, 'logs', 'host.log'), `${sanitizeOutput(value)}\n`));
      };
      stream.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk);
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) { line(pending.slice(0, newline).replace(/\r$/, '')); pending = pending.slice(newline + 1); }
        if (pending.length > 64_000) { line(pending.slice(0, 64_000)); pending = ''; }
      });
      stream.on('end', () => { pending += decoder.end(); if (pending) line(pending); });
    };
    output(child.stdout); output(child.stderr);
    child.once('error', error => onError(error));
    child.once('close', (code, signal) => {
      void (async () => {
        try {
          onError(new Error(`Harness exited before becoming ready (exit ${code ?? signal ?? 'unknown'}).`));
          await managed.logWrites;
          if (this.processes.get(id) !== managed) return;
          this.processes.delete(id); await rm(path.join(root, 'process.json'), { force: true });
          await this.options.sharedData?.detach(id);
          const instance = this.require(id);
          instance.lastExitCode = code; delete instance.pid; delete instance.port;
          instance.status = managed.stopping || code === 0 ? 'stopped' : 'failed';
          if (!managed.stopping && code !== 0) instance.lastError = `Harness Host exited with ${code ?? signal ?? 'unknown'}. Open the instance logs for details.`;
          await this.options.closeWorkbench(id); await this.changed();
        } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
        finally { resolveFinished(); }
      })();
    });
    return managed;
  }

  private async stop(id: string, op?: OperationContext): Promise<void> {
    const instance = this.require(id); const managed = this.processes.get(id);
    let preparationIssue = false;
    try { await this.options.sharedData?.detach(id, true); } catch { preparationIssue = true; await this.options.sharedData?.detach(id).catch(() => undefined); }
    try { await this.options.closeWorkbench(id); } catch { preparationIssue = true; }
    if (!managed) { instance.status = 'stopped'; delete instance.pid; delete instance.port; await this.changed(); return; }
    await op?.update('Stopping owned Harness process tree', 30);
    managed.stopping = true; instance.status = 'stopping'; await this.changed();
    try {
      const result = managed.lifecycleToken ? await stopManagedHost(managed.child, managed.lifecycleToken, () => terminateOwnedProcess(managed.child)) : undefined;
      if (!result) await terminateOwnedProcess(managed.child);
      await managed.finished;
      if (preparationIssue || result && !result.graceful) {
        instance.lastError = `The owned DSH Host stopped, but native shutdown could not confirm completion (${preparationIssue ? 'settings-or-window-cleanup' : result?.reason}). Existing files were preserved; inspect the instance log before retrying.`;
        await this.changed(); await op?.log(instance.lastError); throw new Error(instance.lastError);
      }
    }
    catch (error) { instance.status = 'failed'; instance.lastError = sanitizeOutput(String(error)); await this.changed(); throw error; }
    await op?.log('Only this instance’s owned Host process tree was terminated.');
  }

  async plugin(id: string, action: 'list' | 'add' | 'remove', spec: string | undefined, op: OperationContext): Promise<string> {
    const instance = this.require(id);
    if (this.processes.has(id)) throw new Error('Stop this Harness instance before modifying its plugins.');
    const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[^\s\\/;&|<>"'`]+)?$/i;
    if (action !== 'list' && (!spec || !packagePattern.test(spec))) throw new Error('Enter one npm package name, optionally with an exact version or tag.');
    if (action === 'remove' && spec?.slice(spec.startsWith('@') ? spec.indexOf('/') + 1 : 0).includes('@')) throw new Error('Remove a plugin by its package name without a version.');
    await op.update(`Managing this instance’s ${action === 'list' ? 'plugin list' : 'plugins'}`, 20);
    await this.options.runtimes.verify(instance.runtimeId, op.signal);
    await this.auditLinks(id, op.signal);
    const plan = this.options.runtimes.plan(instance.runtimeId); const env = await this.environment(this.getRoot(id), instance, plan);
    const args = action === 'list' ? ['list', '--depth', '0'] : action === 'add' ? ['add', spec!, '--save-exact'] : ['remove', spec!];
    const child = await launchCli(plan, ['plugin', '--profile', instance.profile, ...args], env, instance.workspacePath);
    const output: string[] = []; let bytes = 0;
    const managed = this.observe(id, child, line => { if (bytes < 512_000) { output.push(sanitizeOutput(line)); bytes += Buffer.byteLength(line); } }, () => undefined);
    this.processes.set(id, managed); managed.stopping = true;
    const abort = () => { void terminateOwnedProcess(child).catch(() => undefined); };
    op.signal.addEventListener('abort', abort, { once: true });
    try {
      if (!child.pid) throw new Error('Could not launch Harness plugin manager.');
      const identity: ProcessIdentity = { pid: child.pid, executable: plan.executable, cli: plan.cli };
      await atomicJson(path.join(this.getRoot(id), 'process.json'), identity);
      if (process.platform === 'win32') {
        identity.createdAt = (await inspectManagedProcess(child))?.createdAt;
        if (identity.createdAt && child.exitCode === null && child.signalCode === null) await atomicJson(path.join(this.getRoot(id), 'process.json'), identity);
      }
      if (op.signal.aborted) abort();
      await managed.finished; op.signal.throwIfAborted();
      if (child.exitCode !== 0) throw new Error(`Harness plugin manager failed (exit ${child.exitCode ?? child.signalCode}).\n${output.join('\n').slice(-8000)}`);
      await this.auditLinks(id, op.signal);
      instance.updatedAt = new Date().toISOString(); await this.changed();
      return output.join('\n');
    } catch (error) {
      await terminateOwnedProcess(child); await managed.finished; throw error;
    } finally {
      op.signal.removeEventListener('abort', abort);
      if (!this.processes.has(id)) await rm(path.join(this.getRoot(id), 'process.json'), { force: true });
    }
  }

  private async readLogs(id: string): Promise<string> {
    this.require(id);
    const logs = path.join(this.getRoot(id), 'logs');
    const file = path.join(logs, 'host.log');
    try {
      const handle = await open(file, 'r');
      try {
        const size = (await handle.stat()).size; const bytes = Math.min(size, 512_000); const buffer = Buffer.alloc(bytes);
        await handle.read(buffer, 0, bytes, Math.max(0, size - bytes)); return sanitizeOutput(buffer.toString('utf8'));
      } finally { await handle.close(); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'No Harness output has been recorded yet.'; throw error; }
  }

  private async auditLinks(id: string, signal?: AbortSignal): Promise<Set<string>> {
    const instance = this.require(id); const root = await this.ownedRoot(id);
    const runtime = await realpath(this.options.runtimes.directory(instance.runtimeId));
    const runtimeLinks = new Set<string>(); const seen = new Set<string>();
    const inside = (parent: string, value: string) => { const relative = path.relative(parent, value); return !relative.startsWith('..') && !path.isAbsolute(relative); };
    const walk = async (directory: string, prefix: string) => {
      signal?.throwIfAborted();
      const actual = await realpath(directory);
      if (!inside(root, actual)) throw new Error(`Instance data references an external path: ${prefix}.`);
      if (seen.has(actual.toLowerCase())) return;
      seen.add(actual.toLowerCase());
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const target = path.join(directory, entry.name); const stat = await lstat(target);
        if (stat.isSymbolicLink()) {
          const resolved = await realpath(target);
          if (inside(runtime, resolved)) {
            if (!/^home\/profiles\/[^/]+\/node_modules\/@deepseek-ai(?:\/|$)/.test(relative)) throw new Error(`Mutable instance data points into its fixed runtime: ${relative}.`);
            runtimeLinks.add(relative);
          }
          else if (inside(root, resolved)) { if ((await lstat(resolved)).isDirectory()) await walk(resolved, relative); }
          else throw new Error(`Instance data references an external path: ${relative}. Copy that data into its isolated workspace before cloning or starting.`);
        } else if (stat.isDirectory()) await walk(target, relative);
        else if (stat.isFile() && !skipMutableFile(relative) && prefix.startsWith('home') && !relative.split('/').some(part => ['node_modules', 'sessions', 'storages', 'attachments', 'credentials'].includes(part))
          && /(?:\.(?:json|ya?ml|toml)|(?:^|\/)\.env)$/i.test(relative)) {
          if (stat.size >= 2_000_000) throw new Error(`Instance configuration is too large to audit: ${relative}.`);
          auditInstanceConfiguration(await readFile(target, 'utf8'), relative, root, runtime);
        }
      }
    };
    for (const part of ['home', 'agents', 'workspace', 'user', 'cache']) await walk(path.join(root, part), part);
    return runtimeLinks;
  }

  private async copyData(id: string, destination: string, op?: OperationContext): Promise<TreeInventory> {
    const runtimeLinks = await this.auditLinks(id, op?.signal);
    const source = this.getRoot(id);
    const commonMigrated = this.require(id).dataScope !== 'isolated' && Boolean(await this.options.sharedData?.isPrepared(this.require(id)));
    await mkdir(destination, { recursive: true });
    for (const part of ['home', 'agents', 'workspace', 'user']) {
      await mkdir(path.join(destination, part), { recursive: true });
      await copyTree(path.join(source, part), path.join(destination, part), {
        signal: op?.signal, allowedLinkRoots: [source],
        skip: relative => { const full = relative ? `${part}/${relative}` : part;
          const common = commonMigrated && (['home/sessions', 'home/attachments', 'workspace', 'user/Documents/deepseek-harness/default-workspace'].some(value => full === value || full.startsWith(`${value}/`)) || full === 'home/.credentials.yaml' || full === 'home/.credentials.yaml.lock');
          return common || skipMutableFile(full) || [...runtimeLinks].some(link => full === link || full.startsWith(`${link}/`)); },
      });
    }
    if (commonMigrated) {
      const patch = path.join(destination, 'home', 'profiles', 'web', 'cordis.patch.yml');
      const text = await readFile(patch, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (text !== undefined) await writeFile(patch, writeSharedModels(text, {}));
    }
    return inventoryTree(destination, op?.signal);
  }

  private async clone(id: string, name: string, runtimeId: string | undefined, op: OperationContext): Promise<DshInstance> {
    const original = this.require(id); const selectedRuntime = runtimeId ?? original.runtimeId;
    this.options.runtimes.get(selectedRuntime);
    await this.options.closeWorkbench(id);
    await op.update('Copying isolated configuration, plugins, skills and workspace', 15);
    const stage = path.join(this.options.rootPath, 'staging', randomUUID());
    let cloned: DshInstance | undefined;
    try {
      await this.copyData(id, stage, op); op.signal.throwIfAborted();
      cloned = await this.create(name, selectedRuntime, op, selectedRuntime === original.runtimeId ? original.dataScope : undefined);
      this.busy.add(cloned.id);
      for (const part of ['home', 'agents', 'workspace', 'user']) {
        await removeManaged(this.options.rootPath, path.join(this.getRoot(cloned.id), part));
        await rename(path.join(stage, part), path.join(this.getRoot(cloned.id), part));
      }
      const record = this.require(cloned.id); record.parentInstanceId = id;
      await this.rebasePaths(this.getRoot(cloned.id), this.getRoot(id), op.signal);
      await rebaseInstancePnpmMetadata(this.getRoot(cloned.id), this.getRoot(id));
      await rebaseCopiedSessionData({ instanceRoot: this.getRoot(cloned.id), oldRoot: this.getRoot(id), runtimeVersion: this.options.runtimes.get(original.runtimeId).version, signal: op.signal });
      if (selectedRuntime !== original.runtimeId) await this.rebasePaths(this.getRoot(cloned.id), this.options.runtimes.directory(original.runtimeId), op.signal, this.options.runtimes.directory(selectedRuntime));
      await this.auditLinks(cloned.id, op.signal);
      await this.changed(); return { ...record };
    } catch (error) { if (cloned) await this.remove(cloned.id, true); throw error; }
    finally { if (cloned) this.busy.delete(cloned.id); await removeManaged(this.options.rootPath, stage); }
  }

  /** Explicit configuration paths under the old instance must follow the new copy; user workspace contents are not rewritten. */
  private async rebasePaths(root: string, oldRoot: string, signal?: AbortSignal, replacementRoot = root): Promise<void> {
    const homes = [path.join(root, 'home'), path.join(root, 'agents')];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted(); const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (['node_modules', 'sessions', 'storages', 'attachments', 'logs'].includes(entry.name)) continue; await walk(file); }
        else if (entry.isFile() && /\.(?:json|ya?ml|env|toml)$/i.test(entry.name) && (await lstat(file)).size < 2_000_000) {
          const text = await readFile(file, 'utf8'); const rewritten = rebaseInstanceConfiguration(text, oldRoot, replacementRoot);
          if (text !== rewritten) await writeFile(file, rewritten);
        }
      }
    };
    for (const home of homes) await walk(home);
  }

  async exportTo(id: string, destination: string, op?: OperationContext): Promise<void> {
    return this.withStoppedInstance(id, async () => {
      if (this.options.sharedData && (this.processes.size || this.options.isCliInUse?.() || [...this.busy].some(value => value !== id))) throw new Error('Stop all DSH instances and CLI terminals before exporting a complete shared-data backup.');
      this.sharedBackupBusy = true;
      try {
        await this.exportData(id, destination, op);
        if (this.require(id).dataScope !== 'isolated') await this.options.sharedData?.exportTo(path.join(destination, 'shared'), op?.signal);
        if (this.options.sharedData && this.require(id).dataScope !== 'isolated') {
          const manifest = backupManifestSchema.parse(await readJson(path.join(destination, 'manifest.json')));
          await atomicJson(path.join(destination, 'manifest.json'), { ...manifest, sharedData: this.options.sharedData.state(),
            sharedInventory: await inventoryTree(path.join(destination, 'shared'), op?.signal) });
        }
      } finally { this.sharedBackupBusy = false; }
    }, true);
  }

  private async exportData(id: string, destination: string, op?: OperationContext): Promise<void> {
    const instance = this.require(id);
    if (this.processes.has(id) || ['running', 'starting', 'stopping'].includes(instance.status)) throw new Error('Stop this Harness instance before backing it up.');
    await this.options.closeWorkbench(id);
    await mkdir(destination, { recursive: true });
    if ((await readdir(destination)).length) throw new Error('Backup destination must be empty.');
    await op?.update('Copying stopped instance data', 20);
    const inventory = await this.copyData(id, path.join(destination, 'data'), op);
    await atomicJson(path.join(destination, 'manifest.json'), {
      format: 'worldlinebox-dsh-backup-v1', instance: { ...instance, status: 'stopped', pid: undefined, port: undefined }, inventory,
      runtimeContentSha256: this.options.runtimes.get(instance.runtimeId).contentSha256, createdAt: new Date().toISOString(),
    });
  }

  async restoreFrom(source: string, name: string, op?: OperationContext): Promise<DshInstance> {
    return this.options.sharedData ? this.options.sharedData.exclusive(() => this.restoreData(source, name, op)) : this.restoreData(source, name, op);
  }
  private async restoreData(source: string, name: string, op?: OperationContext): Promise<DshInstance> {
    const manifest = backupManifestSchema.parse(await readJson(path.join(source, 'manifest.json')));
    const runtime = this.options.runtimes.list().find(value => value.contentSha256 === manifest.runtimeContentSha256);
    if (!runtime) throw new Error('Import the exact runtime used by this backup before restoring it.');
    await op?.update('Verifying the complete stopped-data backup', 10);
    const inventory = await inventoryTree(path.join(source, 'data'), op?.signal).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || manifest.inventory.files.length) throw error;
      return { files: [], contentSha256: createHash('sha256').update('[]').digest('hex'), fileCount: 0, byteLength: 0 };
    });
    if (inventory.contentSha256 !== manifest.inventory.contentSha256 || inventory.fileCount !== manifest.inventory.fileCount
      || inventory.byteLength !== manifest.inventory.byteLength || JSON.stringify(inventory.files) !== JSON.stringify(manifest.inventory.files)) throw new Error('Backup data differs from its sealed file inventory. Restore was refused.');
    const entries = await readdir(path.join(source, 'data')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' && !inventory.files.length) return []; throw error; });
    if (entries.some(entry => !['home', 'agents', 'workspace', 'user'].includes(entry))) throw new Error('Backup has an unsupported data layout.');
    const sharedImport = Boolean(manifest.sharedData && manifest.sharedInventory && this.options.sharedData);
    if (Boolean(manifest.sharedData) !== Boolean(manifest.sharedInventory)) throw new Error('Shared backup metadata is incomplete.');
    if (manifest.sharedInventory) {
      const shared = await inventoryTree(path.join(source, 'shared'), op?.signal);
      if (shared.contentSha256 !== manifest.sharedInventory.contentSha256 || shared.fileCount !== manifest.sharedInventory.fileCount
        || shared.byteLength !== manifest.sharedInventory.byteLength || JSON.stringify(shared.files) !== JSON.stringify(manifest.sharedInventory.files)) throw new Error('Shared backup differs from its sealed inventory.');
    }
    if (sharedImport) {
      if (this.sharedBackupBusy || this.processes.size || this.options.isCliInUse?.() || this.busy.size) throw new Error('Stop all DSH instances and CLI terminals before importing shared saves and accounts.');
      this.sharedBackupBusy = true;
    }
    const restored = await this.create(name, runtime.id, op, manifest.instance.dataScope).catch(error => { if (sharedImport) this.sharedBackupBusy = false; throw error; });
    this.busy.add(restored.id);
    try {
      await op?.update('Restoring into a new isolated instance', 45);
      for (const part of entries) {
        await removeManaged(this.options.rootPath, path.join(this.getRoot(restored.id), part));
        await copyTree(path.join(source, 'data', part), path.join(this.getRoot(restored.id), part), { signal: op?.signal });
      }
      await this.rebasePaths(this.getRoot(restored.id), path.dirname(manifest.instance.homePath), op?.signal);
      await rebaseInstancePnpmMetadata(this.getRoot(restored.id), path.dirname(manifest.instance.homePath));
      await rebaseCopiedSessionData({ instanceRoot: this.getRoot(restored.id), oldRoot: path.dirname(manifest.instance.homePath), runtimeVersion: runtime.version, signal: op?.signal });
      this.require(restored.id).parentInstanceId = manifest.instance.id;
      if (sharedImport) await this.options.sharedData!.restoreFrom(source, manifest.sharedData!, restored, runtime.version, op);
      await this.auditLinks(restored.id, op?.signal); op?.signal.throwIfAborted(); await this.changed();
      return this.get(restored.id);
    } catch (error) { await this.remove(restored.id, true); throw error; }
    finally { this.busy.delete(restored.id); if (sharedImport) this.sharedBackupBusy = false; }
  }

  private async snapshot(id: string, name: string, op: OperationContext): Promise<void> {
    const snapshotId = randomUUID(); const stage = path.join(this.options.rootPath, 'staging', snapshotId);
    try {
      await this.exportData(id, stage, op);
      const manifest = backupManifestSchema.parse(await readJson(path.join(stage, 'manifest.json')));
      op.signal.throwIfAborted(); await rename(stage, path.join(this.options.rootPath, 'snapshots', snapshotId));
      this.snapshotRecords.unshift({ id: snapshotId, instanceId: id, name, runtimeId: manifest.instance.runtimeId, createdAt: manifest.createdAt,
        contentSha256: manifest.inventory.contentSha256, fileCount: manifest.inventory.fileCount, byteLength: manifest.inventory.byteLength });
      await this.changed();
    } finally { await removeManaged(this.options.rootPath, stage); }
  }
  private requireSnapshot(id: string): DshSnapshot {
    const snapshot = this.snapshotRecords.find(value => value.id === id);
    if (!snapshot) throw new Error('Harness snapshot was not found.'); return snapshot;
  }

  async remove(id: string, alreadyLocked = false): Promise<void> {
    if (!alreadyLocked) this.ensureAvailable(id, true);
    const instance = this.require(id);
    if (this.processes.has(id)) throw new Error('Stop this Harness instance before deleting it.');
    await this.options.closeWorkbench(id); await this.options.clearBrowserData(id);
    await removeManaged(this.options.rootPath, this.getRoot(id));
    this.instances = this.instances.filter(value => value.id !== id);
    if (instance.isDefault && this.instances[0]) this.instances[0].isDefault = true;
    await this.changed();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    // Every owned Host gets its shutdown attempt, even if one native plugin cannot finish cleanly.
    await Promise.allSettled([...this.processes.keys()].map(id => this.stop(id)));
    await this.options.sharedData?.dispose();
    await this.writes;
  }
}
