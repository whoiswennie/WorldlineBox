import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { dshInstanceSchema, dshSnapshotSchema, type DshInstance, type DshRuntime, type DshSnapshot,
  type DshLauncherRequest, type DshLauncherResponse } from '../../shared/dsh-launcher';
import { atomicJson, assertOwnedDirectory, copyTree, inventoryTree, readJson, removeManaged, type TreeInventoryProgress } from './files';
import type { OperationStore, OperationContext } from './operations';
import { inspectManagedProcess, instanceEnvironment, launchCli, parseReadyUrl, recoverOwnedProcess,
  sanitizeOutput, terminateOwnedProcess, verifyReadyUrl, type ProcessIdentity, type RuntimeLaunchPlan } from './instance-process';
import type { DshCliSelection } from './cli-terminal';
import { NativeHostClient } from './native-host-client';

export interface RuntimeServiceLike {
  list(): DshRuntime[]; get(id: string): DshRuntime; directory(id: string): string; plan(id: string): RuntimeLaunchPlan;
  verify(id: string, signal?: AbortSignal, force?: boolean, observe?: (progress: TreeInventoryProgress) => void): Promise<void>;
}
interface Options {
  rootPath: string; bridgePackagePath: string; runtimes: RuntimeServiceLike; operations: OperationStore; onChanged: () => void;
  openWorkbench: (instance: DshInstance, url: string) => Promise<void>;
  closeWorkbench: (instanceId: string) => Promise<void>; clearBrowserData: (instanceId: string) => Promise<void>;
  networkEnvironment?: (base: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>;
  isCliInUse?: (instanceId?: string) => boolean;
}
interface Host { child: ChildProcessWithoutNullStreams; client?: NativeHostClient; url?: string; stopping: boolean; finished: Promise<void> }
const manifestSchema = z.object({ format: z.literal('worldlinebox-native-dsh-backup-v1'), instance: dshInstanceSchema,
  runtimeContentSha256: z.string(), createdAt: z.string(), inventory: z.object({ contentSha256: z.string(), fileCount: z.number(), byteLength: z.number() }) });
// Dependencies are restored by the native package manager, never by rewriting pnpm links.
const skipData = (relative: string) => {
  const value = relative.replaceAll('\\', '/');
  return /^home\/(?:logs|cache)(?:\/|$)/.test(value)
    || /^home\/profiles\/[^/]+\/(?:node_modules|\.plugin-manager)(?:\/|$)/.test(value)
    || /^home\/.*(?:package\.json\.lock(?:\/|$)|\.(?:writer|process)\.lock$)/.test(value);
};

/** One native Web Host per instance, shared by Web UI and every partner Session. */
export class InstanceService {
  private instances: DshInstance[] = [];
  private snapshotRecords: DshSnapshot[] = [];
  private readonly hosts = new Map<string, Host>();
  private readonly starts = new Map<string, Promise<NativeHostClient>>();
  private readonly startControllers = new Map<string, AbortController>();
  private readonly busy = new Set<string>();
  private readonly recoveryBlocked = new Set<string>();
  private writes = Promise.resolve();
  private closing = false;
  constructor(private readonly options: Options) {}
  async init(): Promise<void> {
    for (const directory of ['instances', 'snapshots', 'staging']) await mkdir(path.join(this.options.rootPath, directory), { recursive: true });
    this.instances = (await readJson<unknown[]>(path.join(this.options.rootPath, 'native-instances.json')) ?? []).map(value => dshInstanceSchema.parse(value));
    this.snapshotRecords = (await readJson<unknown[]>(path.join(this.options.rootPath, 'native-snapshots.json')) ?? []).map(value => dshSnapshotSchema.parse(value));
    const ids = new Set<string>();
    for (const instance of this.instances) {
      if (ids.has(instance.id)) throw new Error('Duplicate DSH instance identity.'); ids.add(instance.id);
      const paths = this.paths(instance.id);
      if (instance.homePath !== paths.homePath || instance.agentsPath !== paths.agentsPath || instance.workspacePath !== paths.workspacePath
        || instance.browserPartition !== `persist:dsh-instance-${instance.id}`) throw new Error('DSH registry contains an unmanaged path.');
      await assertOwnedDirectory(this.options.rootPath, this.getRoot(instance.id));
      const journalPath = path.join(this.getRoot(instance.id), 'process.json');
      const journal = await readJson<ProcessIdentity>(journalPath);
      if (journal) {
        try {
          const plan = this.launchPlan(instance.id), key = (value: string) => path.resolve(value).toLowerCase();
          if (key(journal.executable) !== key(plan.executable) || key(journal.cli) !== key(plan.cli)) throw new Error('Owned process runtime identity differs.');
          await recoverOwnedProcess(journal); await rm(journalPath, { force: true });
        } catch (error) { this.recoveryBlocked.add(instance.id); instance.lastError = sanitizeOutput(String(error)); }
      }
      instance.status = this.recoveryBlocked.has(instance.id) ? 'failed' : 'stopped'; delete instance.pid; delete instance.port;
    }
    if (this.instances.length && !this.instances.some(value => value.isDefault)) this.instances[0]!.isDefault = true;
    await this.save();
  }
  list() { return this.instances.map(value => ({ ...value })); }
  snapshots() { return this.snapshotRecords.map(value => ({ ...value })); }
  getRoot(id: string): string { if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('Invalid instance ID.'); return path.join(this.options.rootPath, 'instances', id); }
  get(id: string): DshInstance { return { ...this.require(id) }; }
  getUrl(id: string) { return this.hosts.get(id)?.url; }
  launchPlan(id: string) { return this.options.runtimes.plan(this.require(id).runtimeId); }
  private require(id: string) { const value = this.instances.find(value => value.id === id); if (!value) throw new Error('DSH instance was not found.'); return value; }
  private paths(id: string) { const root = this.getRoot(id); return { homePath: path.join(root, 'home'), agentsPath: path.join(root, 'agents'), workspacePath: path.join(root, 'workspace') }; }
  private save() { const instances = this.list(), snapshots = this.snapshots(); const pending = this.writes.then(async () => {
    await atomicJson(path.join(this.options.rootPath, 'native-instances.json'), instances); await atomicJson(path.join(this.options.rootPath, 'native-snapshots.json'), snapshots);
  }); this.writes = pending.catch(() => undefined); return pending; }
  private async changed() { await this.save(); this.options.onChanged(); }
  private available(id: string, stopped = false) {
    const instance = this.require(id);
    if (this.closing || this.busy.has(id) || this.recoveryBlocked.has(id)) throw new Error('This DSH instance is busy or its previous process could not be recovered.');
    if (stopped && (this.hosts.has(id) || this.starts.has(id) || this.options.isCliInUse?.(id))) throw new Error('Stop this instance and its terminal before changing its data.');
    return instance;
  }
  async withStoppedInstance<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.available(id, true); this.busy.add(id); try { return await work(); } finally { this.busy.delete(id); }
  }
  private async environment(instance: DshInstance) {
    const env = await instanceEnvironment(this.getRoot(instance.id), instance, this.launchPlan(instance.id));
    return this.options.networkEnvironment ? this.options.networkEnvironment(env) : env;
  }
  /** User terminal uses exactly the same native profile; partner tasks never enter this path. */
  async prepareCli(id: string, signal?: AbortSignal): Promise<DshCliSelection> {
    signal?.throwIfAborted(); const instance = this.available(id), runtime = this.options.runtimes.get(instance.runtimeId);
    return { instance: { ...instance }, plan: this.launchPlan(id), env: await this.environment(instance), workspacePath: instance.workspacePath,
      nativeArgs: ['--profile', 'web'], runtimeVersion: runtime.version, runtime };
  }
  private async command(instance: DshInstance, args: string[], signal?: AbortSignal, cwd = instance.workspacePath): Promise<string> {
    signal?.throwIfAborted(); const child = await launchCli(this.launchPlan(instance.id), args, await this.environment(instance), cwd);
    let output = ''; const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-128000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const abort = () => { void terminateOwnedProcess(child).catch(() => undefined); }; signal?.addEventListener('abort', abort, { once: true });
    try { await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(sanitizeOutput(output) || `Native DSH command exited ${code}.`))); }); signal?.throwIfAborted(); return sanitizeOutput(output); }
    finally { signal?.removeEventListener('abort', abort); await terminateOwnedProcess(child); }
  }
  private async initializeProfile(instance: DshInstance, signal: AbortSignal) {
    const profile = path.join(instance.homePath, 'profiles', 'web');
    if (!await readJson(path.join(profile, 'package.json'))) await this.command(instance, ['web', '--dump-default-config'], signal);
    const names = ['package.json', 'index.js', 'cordis.patch.yml'];
    const sources = await Promise.all(names.map(name => readFile(path.join(this.options.bridgePackagePath, name))));
    const digest = createHash('sha256'); for (const source of sources) digest.update(source);
    const hash = digest.digest('hex'), target = path.join(instance.homePath, '.worldlinebox', 'bridge', hash);
    await mkdir(target, { recursive: true });
    for (let i = 0; i < names.length; i++) await writeFile(path.join(target, names[i]!), sources[i]!);
    const stamp = path.join(this.getRoot(instance.id), 'bridge.json');
    const installed = await readJson<{ hash: string }>(stamp);
    const entry = await readFile(path.join(profile, 'node_modules', '@worldlinebox', 'dsh-bridge', 'index.js')).catch(() => undefined);
    if (installed?.hash !== hash || !entry?.equals(sources[1]!)) {
      await this.command(instance, ['plugin', '--profile', 'web', 'add', `file:../../.worldlinebox/bridge/${hash}`, '--save-exact'], signal, profile);
      await atomicJson(stamp, { hash });
    }
  }
  async ensureHost(id: string, signal?: AbortSignal): Promise<NativeHostClient> {
    signal?.throwIfAborted(); const existing = this.hosts.get(id);
    if (existing?.stopping) throw new Error('The native DSH Host is stopping. Retry after it has stopped.');
    if (existing?.client && !existing.stopping) { await existing.client.health(signal); return existing.client; }
    let pending = this.starts.get(id);
    if (!pending) {
      this.available(id); const controller = new AbortController(); this.startControllers.set(id, controller);
      pending = this.startHost(id, controller.signal).finally(() => { this.starts.delete(id); this.startControllers.delete(id); });
      this.starts.set(id, pending);
    }
    // Cancelling one caller must not stop the shared Host or another partner's work.
    return signal ? new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      pending!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    }) : pending;
  }
  private async startHost(id: string, signal: AbortSignal): Promise<NativeHostClient> {
    const instance = this.require(id); instance.status = 'starting'; delete instance.lastError; await this.changed();
    let host: Host | undefined;
    try {
      await assertOwnedDirectory(this.options.rootPath, this.getRoot(id));
      await this.options.runtimes.verify(instance.runtimeId, signal);
      await this.initializeProfile(instance, signal); signal.throwIfAborted();
      const token = randomBytes(32).toString('hex');
      const child = await launchCli(this.launchPlan(id), ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
        { ...await this.environment(instance), WORLDLINEBOX_DSH_BRIDGE_TOKEN: token }, instance.workspacePath);
      let resolveExit!: () => void; const finished = new Promise<void>(resolve => { resolveExit = resolve; });
      host = { child, finished, stopping: false }; this.hosts.set(id, host); const owned = host;
      let ready!: () => void, fail!: (error: Error) => void;
      const readiness = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
      void readiness.catch(() => undefined);
      const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')]; const pending = ['', ''];
      const line = (value: string) => {
        owned.url ??= parseReadyUrl(value);
        const port = /^WORLDLINEBOX_DSH_BRIDGE_READY (\d+)\s*$/.exec(value)?.[1];
        if (port && child.pid) owned.client = new NativeHostClient(Number(port), token, child.pid);
        if (owned.url && owned.client) ready();
        void appendFile(path.join(this.getRoot(id), 'logs', 'host.log'), sanitizeOutput(value) + '\n').catch(() => undefined);
      };
      [child.stdout, child.stderr].forEach((stream, index) => stream.on('data', (chunk: Buffer) => {
        pending[index] += decoders[index]!.write(chunk); let boundary: number;
        while ((boundary = pending[index]!.indexOf('\n')) >= 0) { line(pending[index]!.slice(0, boundary).trimEnd()); pending[index] = pending[index]!.slice(boundary + 1); }
        if (pending[index]!.length > 256000) pending[index] = pending[index]!.slice(-128000);
      }));
      child.once('error', fail);
      child.once('close', code => {
        fail(new Error(`Native DSH Web Host exited ${code}. See instance logs.`));
        if (this.hosts.get(id) === owned) {
          this.hosts.delete(id); instance.status = owned.stopping ? 'stopped' : 'failed'; delete instance.pid; delete instance.port;
          void (async () => {
            await rm(path.join(this.getRoot(id), 'process.json'), { force: true });
            await this.changed(); await this.options.closeWorkbench(id);
          })().catch(error => { instance.lastError = sanitizeOutput(String(error)); }).finally(resolveExit);
        } else {
          resolveExit();
        }
      });
      const identity = await inspectManagedProcess(child);
      if (child.pid && identity) { const plan = this.launchPlan(id); await atomicJson(path.join(this.getRoot(id), 'process.json'), { pid: child.pid, executable: plan.executable, cli: plan.cli, createdAt: identity.createdAt }); }
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      await new Promise<void>((resolve, reject) => { const abort = () => reject(timeout.reason); timeout.addEventListener('abort', abort, { once: true });
        readiness.then(resolve, reject).finally(() => timeout.removeEventListener('abort', abort)); if (timeout.aborted) abort(); });
      await owned.client!.health(timeout); await verifyReadyUrl(owned.url!, timeout);
      instance.status = 'running'; delete instance.restartRequired; instance.pid = child.pid; instance.port = Number(new URL(owned.url!).port); await this.changed(); return owned.client!;
    } catch (error) {
      if (host) { host.stopping = true; await terminateOwnedProcess(host.child); await host.finished; }
      instance.status = 'failed'; instance.lastError = sanitizeOutput(String(error)); await this.changed(); throw error;
    }
  }
  async stop(id: string): Promise<void> {
    this.startControllers.get(id)?.abort(new Error('DSH instance stopped.'));
    await this.starts.get(id)?.catch(() => undefined);
    const host = this.hosts.get(id); if (!host) return;
    host.stopping = true; this.require(id).status = 'stopping'; await this.changed();
    try { await host.client?.request('/shutdown', {}, AbortSignal.timeout(5000));
      await Promise.race([host.finished, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Native Host shutdown timed out.')), 15000); timer.unref(); host.finished.finally(() => clearTimeout(timer)); })]);
    } finally { await terminateOwnedProcess(host.child); await host.finished; }
  }
  async create(name: string, runtimeId: string, op?: OperationContext): Promise<DshInstance> {
    if (this.closing) throw new Error('DSH launcher is closing.'); this.options.runtimes.get(runtimeId); op?.signal.throwIfAborted();
    const id = randomUUID(), now = new Date().toISOString();
    const instance = dshInstanceSchema.parse({ id, name, runtimeId, ...this.paths(id), browserPartition: `persist:dsh-instance-${id}`,
      profile: 'web', status: 'stopped', isDefault: !this.instances.length, createdAt: now, updatedAt: now });
    await instanceEnvironment(this.getRoot(id), instance, this.options.runtimes.plan(runtimeId));
    this.instances.push(instance); await this.changed(); return { ...instance };
  }
  async plugin(id: string, action: 'list' | 'add' | 'remove', spec: string | undefined, op: OperationContext): Promise<string> {
    const instance = this.require(id);
    if (action === 'remove' && spec === '@worldlinebox/dsh-bridge') throw new Error('The Host bridge is required for partner sessions.');
    const client = this.hosts.get(id)?.client;
    if (client) {
      const value = await client.request<{ application?: string; error?: unknown }>('/plugins', { action, spec }, op.signal);
      if (value.application === 'failed' || value.application === 'cancelled') throw new Error(`Native plugin ${value.application}: ${JSON.stringify(value.error ?? value)}`);
      await this.recordPluginChange(id, value);
      return JSON.stringify(value, null, 2);
    }
    return this.command(instance, ['plugin', '--profile', 'web', action, ...(spec ? [spec] : [])], op.signal);
  }
  async recordPluginChange(id: string, result: { application?: string }): Promise<void> {
    if (result.application !== 'restart-required') return;
    this.require(id).restartRequired = true; await this.changed();
  }
  /** Restore dependencies through the native manager instead of copying package-manager stores. */
  async installDependencies(id: string, signal?: AbortSignal): Promise<void> {
    await this.initializeProfile(this.require(id), signal ?? new AbortController().signal);
  }
  async exportTo(id: string, destination: string, op?: OperationContext): Promise<void> {
    await this.withStoppedInstance(id, () => this.exportData(id, destination, op));
  }
  private async exportData(id: string, destination: string, op?: OperationContext) {
    await mkdir(destination, { recursive: true }); if ((await readdir(destination)).length) throw new Error('Backup destination must be empty.');
    const data = path.join(destination, 'data'); await mkdir(data);
    for (const name of ['home', 'agents', 'workspace']) await copyTree(path.join(this.getRoot(id), name), path.join(data, name), { signal: op?.signal, skip: relative => skipData(`${name}/${relative}`) });
    const instance = this.get(id), inventory = await inventoryTree(data, op?.signal);
    await atomicJson(path.join(destination, 'manifest.json'), { format: 'worldlinebox-native-dsh-backup-v1', instance,
      runtimeContentSha256: this.options.runtimes.get(instance.runtimeId).contentSha256, createdAt: new Date().toISOString(), inventory });
    return inventory;
  }
  async restoreFrom(source: string, name: string, op?: OperationContext): Promise<DshInstance> {
    const manifest = manifestSchema.parse(await readJson(path.join(source, 'manifest.json')));
    const runtime = this.options.runtimes.list().find(value => value.contentSha256 === manifest.runtimeContentSha256);
    if (!runtime) throw new Error('Install the backup’s exact DSH version before restoration.');
    const data = path.join(source, 'data'), inventory = await inventoryTree(data, op?.signal);
    if (inventory.contentSha256 !== manifest.inventory.contentSha256 || inventory.fileCount !== manifest.inventory.fileCount || inventory.byteLength !== manifest.inventory.byteLength) throw new Error('Backup inventory differs.');
    if ((await readdir(data)).some(entry => !['home', 'agents', 'workspace'].includes(entry))) throw new Error('Unsupported native backup layout.');
    const instance = await this.create(name, runtime.id, op);
    try { await copyTree(data, this.getRoot(instance.id), { signal: op?.signal });
      await this.installDependencies(instance.id, op?.signal); return instance;
    } catch (error) { await this.remove(instance.id); throw error; }
  }
  async remove(id: string): Promise<void> {
    const instance = this.available(id, true); this.busy.add(id);
    try {
      await this.options.closeWorkbench(id); await this.options.clearBrowserData(id);
      await removeManaged(this.options.rootPath, this.getRoot(id)); this.instances = this.instances.filter(value => value.id !== id);
      if (instance.isDefault && this.instances[0]) this.instances[0].isDefault = true; await this.changed();
    } finally { this.busy.delete(id); }
  }
  async handle(request: DshLauncherRequest): Promise<DshLauncherResponse> {
    try {
      if (request.type === 'instance.rename') { this.available(request.instanceId).name = request.name; await this.changed(); return { ok: true }; }
      if (request.type === 'instance.default') { this.require(request.instanceId); for (const value of this.instances) value.isDefault = value.id === request.instanceId; await this.changed(); return { ok: true }; }
      if (request.type === 'instance.logs') return { ok: true, text: sanitizeOutput((await readFile(path.join(this.getRoot(request.instanceId), 'logs', 'host.log'), 'utf8').catch(() => '')).slice(-128000)) };
      if (request.type === 'snapshot.delete') { const snapshot = this.snapshotRecords.find(value => value.id === request.snapshotId); if (!snapshot) throw new Error('Snapshot not found.');
        await removeManaged(this.options.rootPath, path.join(this.options.rootPath, 'snapshots', snapshot.id)); this.snapshotRecords = this.snapshotRecords.filter(value => value.id !== snapshot.id); await this.changed(); return { ok: true }; }
      const id = 'instanceId' in request ? request.instanceId : undefined;
      const operationId = await this.options.operations.run(request.type, request.type, id, async op => {
        switch (request.type) {
          case 'instance.create': await this.create(request.name, request.runtimeId, op); break;
          case 'instance.start': case 'instance.open': {
            const started = performance.now(); await this.ensureHost(request.instanceId, op.signal);
            await op.log(`Native Web Host ready in ${Math.round(performance.now() - started)} ms`);
            await this.options.openWorkbench(this.get(request.instanceId), this.getUrl(request.instanceId)!); break;
          }
          case 'instance.stop': await this.stop(request.instanceId); break;
          case 'instance.delete': await this.remove(request.instanceId); break;
          case 'instance.plugin': await op.log(await this.plugin(request.instanceId, request.action, request.spec, op)); break;
          case 'instance.check': await this.options.runtimes.verify(this.require(request.instanceId).runtimeId, op.signal, true); break;
          case 'snapshot.restore': {
            const snapshot = this.snapshotRecords.find(value => value.id === request.snapshotId); if (!snapshot) throw new Error('Snapshot not found.');
            await this.restoreFrom(path.join(this.options.rootPath, 'snapshots', snapshot.id), request.name, op); break;
          }
          case 'snapshot.create': {
            await this.withStoppedInstance(request.instanceId, async () => {
              const snapshotId = randomUUID(), stage = path.join(this.options.rootPath, 'staging', snapshotId);
              try { const inventory = await this.exportData(request.instanceId, stage, op);
                await rename(stage, path.join(this.options.rootPath, 'snapshots', snapshotId));
                this.snapshotRecords.unshift({ id: snapshotId, instanceId: request.instanceId, name: request.name, runtimeId: this.require(request.instanceId).runtimeId,
                  createdAt: new Date().toISOString(), contentSha256: inventory.contentSha256, fileCount: inventory.fileCount, byteLength: inventory.byteLength }); await this.changed();
              } finally { await removeManaged(this.options.rootPath, stage); }
            }); break;
          }
          case 'instance.clone': {
            await this.withStoppedInstance(request.instanceId, async () => {
              const cloned = await this.create(request.name, request.runtimeId ?? this.require(request.instanceId).runtimeId, op);
              for (const name of ['home', 'agents']) await copyTree(path.join(this.getRoot(request.instanceId), name), path.join(this.getRoot(cloned.id), name),
                { signal: op.signal, skip: relative => skipData(`${name}/${relative}`) || name === 'home' && /^(sessions|attachments|storages)([/\\]|$)/.test(relative) });
              await this.installDependencies(cloned.id, op.signal);
            }); break;
          }
          default: throw new Error('Unsupported instance request.');
        }
      }); return { ok: true, operationId };
    } catch (error) { return { ok: false, error: sanitizeOutput(String(error)) }; }
  }
  async shutdown(): Promise<void> {
    this.closing = true; for (const controller of this.startControllers.values()) controller.abort(new Error('Launcher closing.'));
    await Promise.allSettled(this.starts.values()); await Promise.allSettled([...this.hosts.keys()].map(id => this.stop(id))); await this.writes;
  }
}
