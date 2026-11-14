import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { dshArchivedInstanceSchema, dshInstanceSchema, dshSnapshotSchema, type DshArchivedInstance, type DshInstance, type DshRuntime, type DshSnapshot,
  type DshLauncherRequest, type DshLauncherResponse } from '../../shared/dsh-launcher';
import { atomicJson, assertOwnedDirectory, copyTree, inventoryTree, readJson, removeManaged, type TreeInventoryProgress } from './files';
import type { OperationStore, OperationContext } from './operations';
import { inspectManagedProcess, instanceEnvironment, launchCli, parseReadyUrl, recoverOwnedProcess,
  sanitizeOutput, terminateOwnedProcess, verifyReadyUrl, type ProcessIdentity, type RuntimeLaunchPlan } from './instance-process';
import type { DshCliSelection } from './cli-terminal';
import { NativeHostClient } from './native-host-client';
import { CompanionInstanceLeases, nativeIdleConfirmed, type CompanionInstanceLeaseKind } from './companion-instance-leases';
import { DshHostUnavailableError, isDshHostUnavailableError } from './host-errors';
import { compareDshVersions, dshVersionPattern } from '../../shared/dsh-version-order';

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
  isExternallyInUse?: (instanceId: string, exceptOperationId?: string) => boolean;
  companionIdleMs?: number;
  onStartup?: (progress: DshHostStartupProgress) => void;
  onManualStop?: (instanceId: string) => void;
}
export interface DshHostStartupProgress {
  instanceId: string;
  phase: 'preparing-profile' | 'starting-host' | 'ready' | 'failed';
  startedAt: string; updatedAt: string; elapsedMs: number;
  error?: string;
}
interface Host { child: ChildProcessWithoutNullStreams; client?: NativeHostClient; url?: string; stopping: boolean; finished: Promise<void> }
const upgradeJournalSchema = z.object({ format: z.literal('worldlinebox-dsh-upgrade-v1'), previousRuntimeId: z.string(), snapshotId: z.string().uuid() });
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
  private archived: DshArchivedInstance[] = [];
  private snapshotRecords: DshSnapshot[] = [];
  private readonly hosts = new Map<string, Host>();
  private readonly starts = new Map<string, Promise<NativeHostClient>>();
  private readonly startupPhases = new Map<string, DshHostStartupProgress['phase']>();
  private readonly startupListeners = new Map<string, Set<(phase: DshHostStartupProgress['phase']) => void>>();
  private readonly stops = new Map<string, Promise<void>>();
  private readonly startControllers = new Map<string, AbortController>();
  private readonly busy = new Set<string>();
  private readonly recoveryBlocked = new Set<string>();
  private sharedProvisioning?: Promise<DshInstance>;
  private readonly leases = new CompanionInstanceLeases();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleStops = new Map<string, Promise<boolean>>();
  private readonly manualStops = new Map<string, number>();
  private readonly suspendedCompanions = new Set<string>();
  private readonly lastCompanionUse = new Map<string, number>();
  private companionUseOrder = 0;
  private writes = Promise.resolve();
  private closing = false;
  constructor(private readonly options: Options) {}
  async init(): Promise<void> {
    for (const directory of ['instances', 'snapshots', 'staging']) await mkdir(path.join(this.options.rootPath, directory), { recursive: true });
    const registry = await readJson<unknown[]>(path.join(this.options.rootPath, 'native-instances.json')) ?? [];
    this.instances = [];
    this.archived = [];
    for (const value of registry) {
      if (value && typeof value === 'object' && 'archivedAt' in value) this.archived.push(dshArchivedInstanceSchema.parse(value));
      else this.instances.push(dshInstanceSchema.parse(value));
    }
    this.snapshotRecords = (await readJson<unknown[]>(path.join(this.options.rootPath, 'native-snapshots.json')) ?? []).map(value => dshSnapshotSchema.parse(value));
    const ids = new Set<string>();
    for (const instance of [...this.instances, ...this.archived]) {
      if (ids.has(instance.id)) throw new Error('Duplicate DSH instance identity.'); ids.add(instance.id);
      const paths = this.paths(instance.id);
      if (instance.homePath !== paths.homePath || instance.agentsPath !== paths.agentsPath || instance.workspacePath !== paths.workspacePath
        || instance.browserPartition !== `persist:dsh-instance-${instance.id}`) throw new Error('DSH registry contains an unmanaged path.');
      if ('archivedAt' in instance) continue;
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
      const upgrade = await readJson(path.join(this.getRoot(instance.id), 'upgrade.json'));
      if (upgrade && !this.recoveryBlocked.has(instance.id)) {
        try {
          const pending = upgradeJournalSchema.parse(upgrade); this.options.runtimes.get(pending.previousRuntimeId);
          await this.restoreUpgradeData(instance.id, pending.snapshotId);
          instance.runtimeId = pending.previousRuntimeId;
          await this.save(); await rm(path.join(this.getRoot(instance.id), 'upgrade.json'), { force: true });
        } catch (error) { this.recoveryBlocked.add(instance.id); instance.lastError = `升级恢复失败：${sanitizeOutput(String(error))}`; }
      }
      instance.status = this.recoveryBlocked.has(instance.id) ? 'failed' : 'stopped'; delete instance.pid; delete instance.port;
    }
    // Migrate selection only. Existing homes, browser logins and plugin data
    // remain untouched; legacy companion ownership is historical metadata.
    const defaults = this.instances.filter(value => value.isDefault);
    const selected = defaults[0] ?? this.instances.find(value => !value.companionId && value.name !== 'WorldlineBox 伙伴主脑')
      ?? [...this.instances].filter(value => value.name !== 'WorldlineBox 伙伴主脑')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    for (const instance of this.instances) instance.isDefault = instance.id === selected?.id;
    await this.save();
  }
  list() { return this.instances.map(value => ({ ...value })); }
  archivedInstances() { return this.archived.map(value => ({ ...value })); }
  snapshots() { return this.snapshotRecords.map(value => ({ ...value })); }
  getRoot(id: string): string { if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('Invalid instance ID.'); return path.join(this.options.rootPath, 'instances', id); }
  get(id: string): DshInstance { return { ...this.require(id) }; }
  getUrl(id: string) { return this.hosts.get(id)?.url; }
  /** Every companion uses the same explicit execution selection. Legacy owner
   * fields are retained for history and recovery, never used as a routing ACL. */
  companion(companionId: string): DshInstance | undefined { void companionId; return this.executionInstance(); }
  executionInstance(): DshInstance | undefined { const value = this.instances.find(instance => instance.isDefault); return value && { ...value }; }
  companionStopEpoch(id: string): number { return this.manualStops.get(id) ?? 0; }
  /** Compatibility IPC: create one shared profile from the selected runtime,
   * regardless of which character opened the first-run setup. */
  async createCompanion(companionId: string, name: string, runtimeId: string): Promise<DshInstance> {
    dshInstanceSchema.shape.companionId.unwrap().parse(companionId);
    dshInstanceSchema.shape.companionName.unwrap().parse(name);
    const runtime = this.options.runtimes.get(runtimeId);
    if (!runtime || runtime.adapter !== 'node-cli-web-v1') throw new Error('请选择已安装的原生 Node Web DSH 版本。');
    const existing = this.executionInstance();
    if (existing) {
      if (existing.runtimeId !== runtimeId) throw new Error('共享执行实例已经配置，请在启动器升级或切换共享实例。');
      return existing;
    }
    if (this.sharedProvisioning) return this.sharedProvisioning.then(instance => {
      if (instance.runtimeId !== runtimeId) throw new Error('共享实例正在使用另一版本完成配置，请在创建后升级或切换。');
      return instance;
    });
    const pending = this.create('共享 DSH', runtimeId).then(async instance => {
      await this.selectExecutionInstance(instance.id); return this.get(instance.id);
    });
    this.sharedProvisioning = pending;
    void pending.finally(() => { if (this.sharedProvisioning === pending) this.sharedProvisioning = undefined; }).catch(() => undefined);
    return pending;
  }
  /** Selecting an existing profile does not claim it, copy credentials or
   * disturb in-flight Sessions bound to the previously selected profile. */
  async bindCompanion(companionId: string, name: string, instanceId: string): Promise<DshInstance> {
    dshInstanceSchema.shape.companionId.unwrap().parse(companionId);
    dshInstanceSchema.shape.companionName.unwrap().parse(name);
    return this.selectExecutionInstance(instanceId);
  }
  async selectExecutionInstance(instanceId: string): Promise<DshInstance> {
    const instance = this.available(instanceId), runtime = this.options.runtimes.get(instance.runtimeId);
    if (!runtime || runtime.adapter !== 'node-cli-web-v1') throw new Error('请选择已安装的原生 Node Web DSH 实例。');
    const selected = await this.commitRegistry(async () => {
      // A queued selection must not publish a removed target or one which
      // entered an upgrade/data mutation while another registry write ran.
      const current = this.available(instanceId), currentRuntime = this.options.runtimes.get(current.runtimeId);
      if (!currentRuntime || currentRuntime.adapter !== 'node-cli-web-v1') throw new Error('请选择已安装的原生 Node Web DSH 实例。');
      const records = this.list();
      for (const record of records) record.isDefault = record.id === instanceId;
      await this.writeInstanceRegistry(records);
      for (const value of this.instances) value.isDefault = value.id === instanceId;
      return this.get(instanceId);
    });
    this.notifyChanged(); return selected;
  }
  /** Compatibility helper no longer allocates per-character environments. */
  async ensureCompanion(_companionId: string, _name: string, base: DshInstance): Promise<DshInstance> {
    return this.executionInstance() ?? this.selectExecutionInstance(base.id);
  }
  touchInstance(id: string): void {
    this.require(id); this.leases.touch(id);
    this.lastCompanionUse.set(id, ++this.companionUseOrder);
    const timer = this.idleTimers.get(id); if (timer) clearTimeout(timer); this.idleTimers.delete(id);
  }
  acquireCompanionLease(id: string, kind: CompanionInstanceLeaseKind): () => void {
    this.available(id); this.touchInstance(id);
    return this.leases.acquire(id, kind, () => { this.lastCompanionUse.set(id, ++this.companionUseOrder); this.scheduleIdle(id); });
  }
  async configureCompanion(id: string, keepAlive: boolean): Promise<DshInstance> {
    const instance = this.available(id);
    this.touchInstance(id); instance.keepAlive = keepAlive; instance.updatedAt = new Date().toISOString(); await this.changed();
    if (keepAlive) await this.ensureHost(id); else this.scheduleIdle(id);
    return this.get(id);
  }
  private held(id: string, exceptOperationId?: string): boolean {
    return this.leases.count(id) > 0 || !!this.options.isCliInUse?.(id) || !!this.options.isExternallyInUse?.(id, exceptOperationId);
  }
  /** A warm-cache target, never an admission limit: busy or unknown Hosts stay alive. */
  private async reclaimCompanionCacheBeforeStart(id: string): Promise<void> {
    const wanted = this.require(id); if (!wanted.companionId || wanted.isDefault || wanted.keepAlive) return;
    const warm = this.instances.filter(instance => instance.companionId && !instance.isDefault && !instance.keepAlive && this.hosts.has(instance.id));
    if (warm.length < 3) return;
    const candidates = warm.filter(instance => instance.id !== id && !this.held(instance.id) && !this.busy.has(instance.id) && !this.starts.has(instance.id))
      .sort((a, b) => (this.lastCompanionUse.get(a.id) ?? 0) - (this.lastCompanionUse.get(b.id) ?? 0));
    for (const candidate of candidates) if (await this.recycleCompanionIfIdle(candidate.id).catch(() => false)) break;
  }
  private scheduleIdle(id: string, soon = false): void {
    const instance = this.instances.find(value => value.id === id);
    if (soon) { const previous = this.idleTimers.get(id); if (previous) clearTimeout(previous); this.idleTimers.delete(id); }
    if (!instance?.companionId || instance.isDefault || this.closing || this.suspendedCompanions.has(id) || this.idleTimers.has(id)
      || !this.hosts.has(id) || this.leases.count(id) || instance.keepAlive && !instance.restartRequired) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(id);
      void this.recycleCompanionIfIdle(id).catch(() => false).finally(() => this.scheduleIdle(id));
    }, soon ? 1000 : this.options.companionIdleMs ?? 120_000);
    timer.unref(); this.idleTimers.set(id, timer);
  }
  /** An idle HTTP proof is mandatory even when no application lease remains. */
  async recycleCompanionIfIdle(id: string): Promise<boolean> {
    const previous = this.idleStops.get(id); if (previous) return previous;
    const instance = this.require(id);
    if (!instance.companionId || instance.isDefault || this.suspendedCompanions.has(id) || instance.keepAlive && !instance.restartRequired
      || this.closing || this.busy.has(id) || this.starts.has(id) || this.held(id)) return false;
    const host = this.hosts.get(id); if (!host?.client || host.stopping) return false;
    const epoch = this.leases.epoch(id), stopEpoch = this.manualStops.get(id) ?? 0;
    const pending = (async () => {
      const proof = await host.client!.request('/idle', {}, undefined, 5000).catch(() => undefined);
      if (!nativeIdleConfirmed(proof) || this.leases.epoch(id) !== epoch || this.held(id) || this.busy.has(id)
        || this.hosts.get(id) !== host || instance.keepAlive && !instance.restartRequired) return false;
      this.busy.add(id);
      const restart = instance.restartRequired === true;
      try { await this.stop(id, { automatic: true }); }
      finally { this.busy.delete(id); }
      if (restart && !this.closing && !this.suspendedCompanions.has(id) && (this.manualStops.get(id) ?? 0) === stopEpoch) {
        this.idleStops.delete(id); await this.ensureHost(id, undefined, { automatic: true });
      }
      return true;
    })();
    this.idleStops.set(id, pending);
    try { return await pending; } finally { if (this.idleStops.get(id) === pending) this.idleStops.delete(id); }
  }
  launchPlan(id: string) { return this.options.runtimes.plan(this.require(id).runtimeId); }
  private require(id: string) { const value = this.instances.find(value => value.id === id); if (!value) throw new Error('DSH instance was not found.'); return value; }
  private paths(id: string) { const root = this.getRoot(id); return { homePath: path.join(root, 'home'), agentsPath: path.join(root, 'agents'), workspacePath: path.join(root, 'workspace') }; }
  private commitRegistry<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(work);
    this.writes = pending.then(() => undefined, () => undefined); return pending;
  }
  private writeInstanceRegistry(instances: readonly DshInstance[], archived = this.archived): Promise<void> {
    return atomicJson(path.join(this.options.rootPath, 'native-instances.json'), [...instances, ...archived]);
  }
  private save() { const pending = this.writes.then(async () => {
    const instances = this.list(), snapshots = this.snapshots();
    await this.writeInstanceRegistry(instances); await atomicJson(path.join(this.options.rootPath, 'native-snapshots.json'), snapshots);
  }); this.writes = pending.catch(() => undefined); return pending; }
  private notifyChanged() { try { this.options.onChanged(); } catch { /* An observer cannot undo or obscure a completed durable mutation. */ } }
  private async changed() { await this.save(); this.notifyChanged(); }
  private available(id: string, stopped = false, operationId?: string) {
    const instance = this.require(id);
    if (this.closing || this.busy.has(id) || this.recoveryBlocked.has(id)) throw new Error('This DSH instance is busy or its previous process could not be recovered.');
    if (stopped) {
      if (this.hosts.has(id) || this.starts.has(id) || this.stops.has(id)) throw new Error('请先停止此 DSH 实例，再修改或删除它的数据。');
      if (this.leases.count(id)) throw new Error('此实例仍被任务或能力查询使用，请等待任务结束后再删除。');
      if (this.options.isCliInUse?.(id)) throw new Error('此实例的终端仍在运行，请先关闭该终端。');
      if (this.options.isExternallyInUse?.(id, operationId)) throw new Error('此实例的工作台或其他操作仍在使用中，请关闭工作台或等待操作结束。');
    }
    return instance;
  }
  async withStoppedInstance<T>(id: string, work: () => Promise<T>, operationId?: string): Promise<T> {
    this.available(id, true, operationId); this.busy.add(id); try { return await work(); } finally { this.busy.delete(id); }
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
    const names = ['package.json', 'index.js', 'workspace.js', 'idle.js', 'sessions.js', 'context.js', 'topics.js', 'cordis.patch.yml'];
    const sources = await Promise.all(names.map(name => readFile(path.join(this.options.bridgePackagePath, name))));
    const digest = createHash('sha256'); for (const source of sources) digest.update(source);
    const hash = digest.digest('hex'), target = path.join(instance.homePath, '.worldlinebox', 'bridge', hash);
    const stamp = path.join(this.getRoot(instance.id), 'bridge.json');
    const installed = await readJson<{ hash: string }>(stamp);
    if (installed?.hash === hash) {
      const entries = await Promise.all(names.map(name =>
        readFile(path.join(profile, 'node_modules', '@worldlinebox', 'dsh-bridge', name)).catch(() => undefined)));
      if (entries.every((entry, index) => entry?.equals(sources[index]!))) return;
    }
    await mkdir(target, { recursive: true });
    await Promise.all(names.map((name, index) => writeFile(path.join(target, name), sources[index]!)));
    await this.command(instance, ['plugin', '--profile', 'web', 'add', `file:../../.worldlinebox/bridge/${hash}`, '--save-exact'], signal, profile);
    await atomicJson(stamp, { hash });
  }
  async ensureHost(id: string, signal?: AbortSignal, options: { automatic?: boolean } = {}): Promise<NativeHostClient> {
    signal?.throwIfAborted();
    if (this.closing) throw new DshHostUnavailableError('closing', 'DSH 启动器正在关闭。', id);
    if (!this.instances.some(instance => instance.id === id)) throw new DshHostUnavailableError('configuration', 'DSH 实例不存在，请检查任务绑定的执行环境。', id);
    const stopEpoch = this.manualStops.get(id) ?? 0;
    const check = () => {
      signal?.throwIfAborted();
      if (this.closing) throw new DshHostUnavailableError('closing', 'DSH 启动器正在关闭。', id);
      if ((this.manualStops.get(id) ?? 0) !== stopEpoch || options.automatic && this.suspendedCompanions.has(id))
        throw new DshHostUnavailableError('stopped', 'DSH 实例已由用户关闭，请继续原任务或重新启动实例。', id);
    };
    check();
    if (!options.automatic) this.suspendedCompanions.delete(id);
    try {
      this.touchInstance(id);
      const wait = async (pending: Promise<unknown> | undefined) => {
        if (!pending) return;
        if (!signal) { await pending; return; }
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
          pending.then(() => resolve(), reject).finally(() => signal.removeEventListener('abort', abort));
          if (signal.aborted) abort();
        });
      };
      await wait(this.stops.get(id)); check();
      await wait(this.idleStops.get(id)); check();
      this.available(id);
      let pending = this.starts.get(id);
      if (!pending) {
        const existing = this.hosts.get(id);
        if (existing?.stopping) { await wait(existing.finished); check(); }
        // Never publish an early bridge client before the shared startup's
        // token exchange and readiness checks have finished.
        else if (existing?.client) { await existing.client.health(signal); check(); this.scheduleIdle(id); return existing.client; }
        await this.reclaimCompanionCacheBeforeStart(id); check(); this.available(id);
        // Another waiter may have started this environment during the LRU check.
        pending = this.starts.get(id);
        if (!pending) {
          const controller = new AbortController(); this.startControllers.set(id, controller);
          pending = this.startHost(id, controller.signal).finally(() => { this.starts.delete(id); this.startControllers.delete(id); });
          this.starts.set(id, pending);
        }
      }
      // Cancelling one caller must not stop another caller's shared startup.
      let client: NativeHostClient;
      if (!signal) client = await pending;
      else client = await new Promise<NativeHostClient>((resolve, reject) => {
        const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
        pending!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
      check(); return client;
    } catch (error) {
      if (signal?.aborted) throw error;
      check();
      if (isDshHostUnavailableError(error)) throw error;
      throw new DshHostUnavailableError('startup', 'DSH 执行环境暂时无法连接：' + sanitizeOutput(error instanceof Error ? error.message : String(error)), id, error);
    }
  }
  private async startHost(id: string, signal: AbortSignal): Promise<NativeHostClient> {
    // This shared preparation outlives an individual waiting turn, but profile
    // package-manager work cannot run forever before the old HTTP-only budget.
    signal = AbortSignal.any([signal, AbortSignal.timeout(360000)]);
    const started = performance.now(), startedAt = new Date().toISOString();
    const progress = (phase: DshHostStartupProgress['phase'], error?: string) => {
      this.startupPhases.set(id, phase);
      for (const listener of this.startupListeners.get(id) ?? []) listener(phase);
      try { this.options.onStartup?.({ instanceId: id, phase, startedAt, updatedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
        ...(error ? { error } : {}) }); } catch { /* Diagnostics cannot break native preparation. */ }
    };
    const instance = this.require(id); instance.status = 'starting'; delete instance.lastError; await this.changed();
    let host: Host | undefined;
    let startupCheck = '检查启动入口和准备实例配置', hostOutput = false, missingDependency = false;
    const logPath = path.join(this.getRoot(id), 'logs', 'host.log');
    const logStartup = async (message: string) => {
      await mkdir(path.dirname(logPath), { recursive: true })
        .then(() => appendFile(logPath, `[${new Date().toISOString()}] ${sanitizeOutput(message)}\n`)).catch(() => undefined);
    };
    try {
      progress('preparing-profile');
      await assertOwnedDirectory(this.options.rootPath, this.getRoot(id));
      let plan: RuntimeLaunchPlan;
      try { plan = this.launchPlan(id); }
      catch (cause) {
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw cause;
        throw new Error('DSH 启动入口缺失。请在「运行版本」中对当前版本执行完整性校验。', { cause });
      }
      startupCheck = '准备实例配置和插件';
      await this.initializeProfile(instance, signal); signal.throwIfAborted();
      progress('starting-host');
      startupCheck = '等待 DSH Web 地址和伙伴桥接服务就绪（最长 120 秒）';
      const prepared = performance.now();
      await logStartup(`Starting DSH Web Host. Profile preparation took ${Math.round(prepared - started)} ms. Waiting for Web and bridge readiness.`);
      const token = randomBytes(32).toString('hex');
      const child = await launchCli(plan, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
        { ...await this.environment(instance), WORLDLINEBOX_DSH_BRIDGE_TOKEN: token }, instance.workspacePath);
      let resolveExit!: () => void; const finished = new Promise<void>(resolve => { resolveExit = resolve; });
      host = { child, finished, stopping: false }; this.hosts.set(id, host); const owned = host;
      let ready!: () => void, fail!: (error: Error) => void;
      const readiness = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
      void readiness.catch(() => undefined);
      const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')]; const pending = ['', ''];
      const line = (value: string) => {
        hostOutput ||= !!value.trim();
        missingDependency ||= /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/.test(value);
        owned.url ??= parseReadyUrl(value);
        const port = /^WORLDLINEBOX_DSH_BRIDGE_READY (\d+)\s*$/.exec(value)?.[1];
        if (port && child.pid) owned.client = new NativeHostClient(Number(port), token, child.pid);
        if (owned.url && owned.client) ready();
        void appendFile(logPath, sanitizeOutput(value) + '\n').catch(() => undefined);
      };
      [child.stdout, child.stderr].forEach((stream, index) => stream.on('data', (chunk: Buffer) => {
        pending[index] += decoders[index]!.write(chunk); let boundary: number;
        while ((boundary = pending[index]!.indexOf('\n')) >= 0) { line(pending[index]!.slice(0, boundary).trimEnd()); pending[index] = pending[index]!.slice(boundary + 1); }
        if (pending[index]!.length > 256000) pending[index] = pending[index]!.slice(-128000);
      }));
      child.once('error', fail);
      child.once('close', (code, exitSignal) => {
        const failure = new Error(missingDependency && !owned.url
          ? 'DSH 启动时缺少模块。请先查看实例日志，再在「运行版本」中执行完整性校验。'
          : `Native DSH Web Host exited ${exitSignal ?? code}. See instance logs.`);
        fail(failure);
        if (this.hosts.get(id) === owned) {
          this.hosts.delete(id); instance.status = owned.stopping ? 'stopped' : 'failed'; delete instance.pid; delete instance.port;
          instance.lastExitCode = code;
          if (!owned.stopping) instance.lastError = sanitizeOutput(failure.message);
          void (async () => {
            await rm(path.join(this.getRoot(id), 'process.json'), { force: true });
            await this.changed(); await this.options.closeWorkbench(id);
          })().catch(error => { instance.lastError = sanitizeOutput(String(error)); }).finally(resolveExit);
        } else {
          resolveExit();
        }
      });
      const identity = await inspectManagedProcess(child);
      if (child.pid && identity) await atomicJson(path.join(this.getRoot(id), 'process.json'), { pid: child.pid, executable: plan.executable, cli: plan.cli, createdAt: identity.createdAt });
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      await new Promise<void>((resolve, reject) => { const abort = () => reject(timeout.reason); timeout.addEventListener('abort', abort, { once: true });
        readiness.then(resolve, reject).finally(() => timeout.removeEventListener('abort', abort)); if (timeout.aborted) abort(); });
      const announced = performance.now();
      startupCheck = '验证伙伴桥接服务身份和工作台登录';
      await Promise.all([
        owned.client!.health(timeout),
        verifyReadyUrl(owned.url!, timeout),
      ]);
      await logStartup(`DSH Web Host announced readiness in ${Math.round(announced - prepared)} ms. Authenticated checks took ${Math.round(performance.now() - announced)} ms.`);
      instance.status = 'running'; delete instance.restartRequired; instance.pid = child.pid; instance.port = Number(new URL(owned.url!).port); await this.changed(); progress('ready'); this.scheduleIdle(id); return owned.client!;
    } catch (error) {
      let failure = error;
      if (error instanceof Error && error.name === 'TimeoutError') {
        const readiness = host && startupCheck.startsWith('等待')
          ? !hostOutput ? '启动进程尚未输出就绪信息。'
            : `未收到${[!host?.url && '工作台地址', !host?.client && '伙伴桥接就绪信号'].filter(Boolean).join('、')}。`
          : '';
        failure = new Error(`DSH 启动超时：${startupCheck}。${readiness}请重试；若仍失败，请查看实例日志：${logPath}`, { cause: error });
      }
      await logStartup(`Startup failed while ${startupCheck}: ${failure instanceof Error ? failure.message : String(failure)}`);
      if (host) { host.stopping = true; await terminateOwnedProcess(host.child); await host.finished; }
      instance.status = 'failed'; instance.lastError = sanitizeOutput(String(failure)); await this.changed(); progress('failed', instance.lastError); throw failure;
    } finally { this.startupPhases.delete(id); }
  }
  async stop(id: string, options: { automatic?: boolean } = {}): Promise<void> {
    this.require(id);
    if (!options.automatic) {
      this.manualStops.set(id, (this.manualStops.get(id) ?? 0) + 1); this.suspendedCompanions.add(id);
      try { this.options.onManualStop?.(id); } catch { /* Observers cannot prevent the actual stop. */ }
    }
    this.touchInstance(id);
    this.startControllers.get(id)?.abort(new DshHostUnavailableError(this.closing ? 'closing' : options.automatic ? 'startup' : 'stopped', 'DSH 实例已停止。', id));
    const previous = this.stops.get(id); if (previous) return previous;
    const pending = (async () => {
      await this.starts.get(id)?.catch(() => undefined);
      const host = this.hosts.get(id);
      if (host) {
        host.stopping = true; this.require(id).status = 'stopping'; await this.changed();
        try { await host.client?.request('/shutdown', {}, AbortSignal.timeout(5000));
          await Promise.race([host.finished, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Native Host shutdown timed out.')), 15000); timer.unref(); host.finished.finally(() => clearTimeout(timer)); })]);
        } finally { await terminateOwnedProcess(host.child); await host.finished; }
      }
      const instance = this.require(id); instance.status = 'stopped'; delete instance.pid; delete instance.port;
      await this.changed();
    })().finally(() => { if (this.stops.get(id) === pending) this.stops.delete(id); });
    this.stops.set(id, pending); return pending;
  }
  async create(name: string, runtimeId: string, op?: OperationContext, companion?: Pick<DshInstance, 'companionId' | 'companionName' | 'parentInstanceId' | 'keepAlive'>): Promise<DshInstance> {
    if (this.closing) throw new Error('DSH launcher is closing.'); this.options.runtimes.get(runtimeId); op?.signal.throwIfAborted();
    const id = randomUUID(), now = new Date().toISOString();
    const instance = dshInstanceSchema.parse({ id, name, runtimeId, ...this.paths(id), browserPartition: `persist:dsh-instance-${id}`,
      profile: 'web', status: 'stopped', isDefault: !companion && !this.instances.some(value => value.isDefault), createdAt: now, updatedAt: now, ...companion });
    try {
      await instanceEnvironment(this.getRoot(id), instance, this.options.runtimes.plan(runtimeId));
      await this.commitRegistry(async () => {
        if (this.closing) throw new Error('DSH launcher is closing.'); op?.signal.throwIfAborted();
        instance.isDefault = !companion && !this.instances.some(value => value.isDefault);
        await this.writeInstanceRegistry([...this.list(), instance]);
        this.instances.push(instance);
      });
    }
    catch (error) {
      await removeManaged(this.options.rootPath, this.getRoot(id)); throw error;
    }
    this.notifyChanged(); return { ...instance };
  }
  /** Switch code only; all stable environment paths and browser identity are retained. */
  async upgradeCompanion(id: string, runtimeId: string, op: OperationContext): Promise<void> {
    const instance = this.available(id), next = this.options.runtimes.get(runtimeId);
    if (next.adapter !== 'node-cli-web-v1') throw new Error('伙伴需要原生 Node Web 运行环境。');
    if (runtimeId === instance.runtimeId) return;
    if (this.held(id, op.id) || this.starts.has(id)) throw new Error('伙伴环境仍在使用中，请等待任务、问题或工作台结束后升级。');
    this.touchInstance(id); this.busy.add(id);
    const previousRuntimeId = instance.runtimeId, previousVersion = this.options.runtimes.get(previousRuntimeId).version;
    const journal = path.join(this.getRoot(id), 'upgrade.json');
    const wasRunning = this.hosts.has(id), wasSuspended = this.suspendedCompanions.has(id), stopEpoch = this.manualStops.get(id) ?? 0;
    const stillAuthorized = () => {
      op.signal.throwIfAborted();
      if ((this.manualStops.get(id) ?? 0) !== stopEpoch) throw new Error('伙伴环境升级期间被明确停止，已取消本次升级。');
    };
    let snapshotId: string | undefined, switched = false;
    try {
      const host = this.hosts.get(id);
      if (host && (!host.client || !nativeIdleConfirmed(await host.client.request('/idle', {}, op.signal, 5000)))) throw new Error('原生执行器仍有活动或无法确认空闲，请稍后升级。');
      if (this.held(id, op.id)) throw new Error('伙伴环境仍在使用中。');
      await this.options.runtimes.verify(runtimeId, op.signal);
      stillAuthorized();
      await this.stop(id, { automatic: true }); op.signal.throwIfAborted(); await op.update('保存升级前完整数据', 20);
      snapshotId = randomUUID(); const destination = path.join(this.options.rootPath, 'snapshots', snapshotId);
      const inventory = await this.exportData(id, destination, op);
      const snapshot: DshSnapshot = { id: snapshotId, instanceId: id, name: `升级前 · ${previousVersion}`,
        runtimeId: previousRuntimeId, createdAt: new Date().toISOString(), contentSha256: inventory.contentSha256, fileCount: inventory.fileCount, byteLength: inventory.byteLength };
      this.snapshotRecords.unshift(snapshot);
      await this.changed();
      await atomicJson(journal, { format: 'worldlinebox-dsh-upgrade-v1', previousRuntimeId, snapshotId });
      stillAuthorized(); instance.runtimeId = runtimeId; switched = true;
      instance.updatedAt = new Date().toISOString(); await this.changed(); await op.update('验证新版本与原环境', 55);
      stillAuthorized();
      const controller = new AbortController(); this.startControllers.set(id, controller);
      const pending = this.startHost(id, AbortSignal.any([op.signal, controller.signal])); this.starts.set(id, pending);
      try { await pending; } finally { this.starts.delete(id); this.startControllers.delete(id); }
      stillAuthorized();
      if (wasSuspended || !wasRunning && !instance.keepAlive) await this.stop(id, { automatic: true });
      await rm(journal, { force: true });
      // Keep the old runtime pinned until the rollback journal has been cleared.
      if (dshVersionPattern.test(previousVersion)) {
        snapshot.upgradeFromVersion = previousVersion;
        try { await this.changed(); }
        catch { delete snapshot.upgradeFromVersion; }
      }
      await op.log(`DSH 实例升级完成；已保留升级前快照 ${snapshotId}。`).catch(() => undefined);
    } catch (error) {
      if (switched && snapshotId) {
        try {
          await this.stop(id, { automatic: true }); await this.restoreUpgradeData(id, snapshotId); instance.runtimeId = previousRuntimeId;
          instance.status = 'stopped'; delete instance.pid; delete instance.port; delete instance.restartRequired;
          instance.updatedAt = new Date().toISOString(); await this.changed(); await rm(journal, { force: true });
        } catch (rollback) {
          this.recoveryBlocked.add(id); instance.status = 'failed'; instance.lastError = `升级失败且恢复尚未完成：${sanitizeOutput(String(rollback))}`;
          await this.changed(); throw new AggregateError([error, rollback], '升级失败，已保留回退快照，请恢复后再启动。', { cause: rollback });
        }
      } else if (snapshotId) await rm(journal, { force: true });
      throw error;
    } finally { this.busy.delete(id); this.scheduleIdle(id); }
  }
  private async restoreUpgradeData(id: string, snapshotId: string): Promise<void> {
    const backup = path.join(this.options.rootPath, 'snapshots', snapshotId), manifest = manifestSchema.parse(await readJson(path.join(backup, 'manifest.json')));
    if (manifest.instance.id !== id) throw new Error('Upgrade snapshot belongs to another instance.');
    const data = path.join(backup, 'data'), inventory = await inventoryTree(data);
    if (inventory.contentSha256 !== manifest.inventory.contentSha256) throw new Error('Upgrade snapshot inventory changed.');
    const root = this.getRoot(id); await assertOwnedDirectory(this.options.rootPath, root);
    for (const name of ['home', 'agents', 'workspace']) {
      await removeManaged(this.options.rootPath, path.join(root, name));
      await copyTree(path.join(data, name), path.join(root, name));
    }
    await rm(path.join(root, 'bridge.json'), { force: true });
  }
  async plugin(id: string, action: 'list' | 'add' | 'remove', spec: string | undefined, op: OperationContext): Promise<string> {
    const instance = this.require(id);
    if (action === 'remove' && spec === '@worldlinebox/dsh-bridge') throw new Error('The Host bridge is required for partner sessions.');
    const client = this.hosts.get(id)?.client;
    if (client) {
      const value = await client.request<{ application?: string; error?: unknown }>('/plugins', { action, spec }, op.signal, action === 'add' ? 600000 : 120000);
      if (value.application === 'failed' || value.application === 'cancelled') throw new Error(`Native plugin ${value.application}: ${JSON.stringify(value.error ?? value)}`);
      await this.recordPluginChange(id, value);
      return JSON.stringify(value, null, 2);
    }
    return this.command(instance, ['plugin', '--profile', 'web', action, ...(spec ? [spec] : [])], op.signal);
  }
  async recordPluginChange(id: string, result: { application?: string }): Promise<void> {
    const instance = this.require(id); instance.updatedAt = new Date().toISOString();
    if (result.application === 'restart-required') instance.restartRequired = true;
    await this.changed(); if (instance.restartRequired) this.scheduleIdle(id, true);
  }
  /** Restore dependencies through the native manager instead of copying package-manager stores. */
  async installDependencies(id: string, signal?: AbortSignal): Promise<void> {
    await this.initializeProfile(this.require(id), signal ?? new AbortController().signal);
  }
  async exportTo(id: string, destination: string, op?: OperationContext): Promise<void> {
    await this.withStoppedInstance(id, () => this.exportData(id, destination, op), op?.id);
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
  async restoreFrom(source: string, name: string, op?: OperationContext, upgradeRuntime?: DshRuntime): Promise<DshInstance> {
    const manifest = manifestSchema.parse(await readJson(path.join(source, 'manifest.json')));
    const runtime = upgradeRuntime ?? this.options.runtimes.list().find(value => value.contentSha256 === manifest.runtimeContentSha256);
    if (!runtime) throw new Error('Install the backup’s exact DSH version before restoration.');
    const data = path.join(source, 'data'), inventory = await inventoryTree(data, op?.signal);
    if (inventory.contentSha256 !== manifest.inventory.contentSha256 || inventory.fileCount !== manifest.inventory.fileCount || inventory.byteLength !== manifest.inventory.byteLength) throw new Error('Backup inventory differs.');
    if ((await readdir(data)).some(entry => !['home', 'agents', 'workspace'].includes(entry))) throw new Error('Unsupported native backup layout.');
    const instance = await this.create(name, runtime.id, op);
    try { await copyTree(data, this.getRoot(instance.id), { signal: op?.signal });
      await this.installDependencies(instance.id, op?.signal); return instance;
    } catch (error) { await this.remove(instance.id); throw error; }
  }
  private async archive(id: string, op: OperationContext): Promise<void> {
    await this.withStoppedInstance(id, async () => {
      const current = this.require(id);
      const version = this.options.runtimes.get(current.runtimeId).version;
      await assertOwnedDirectory(this.options.rootPath, this.getRoot(id));
      await this.commitRegistry(async () => {
        op.signal.throwIfAborted();
        const entry: DshArchivedInstance = { ...current, isDefault: false, status: 'stopped', archivedAt: new Date().toISOString(), runtimeVersion: version };
        const active = this.instances.filter(instance => instance.id !== id);
        const nextDefault = current.isDefault ? active.find(instance => !instance.companionId) ?? active[0] : undefined;
        const archive = [entry, ...this.archived];
        await this.writeInstanceRegistry(active.map(instance => instance === nextDefault ? { ...instance, isDefault: true } : instance), archive);
        this.touchInstance(id); this.leases.forget(id);
        this.manualStops.delete(id); this.suspendedCompanions.delete(id); this.lastCompanionUse.delete(id);
        if (nextDefault) nextDefault.isDefault = true;
        this.instances = active;
        this.archived = archive;
      });
    }, op.id);
    this.notifyChanged();
  }
  private requireArchived(id: string, op: OperationContext): DshArchivedInstance {
    const instance = this.archived.find(item => item.id === id);
    if (!instance) throw new Error('未找到已归档的 DSH 实例。');
    if (this.closing || this.busy.has(id) || this.options.operations.isInstanceInUse(id, op.id)) throw new Error('此实例还有其他操作正在进行。');
    return instance;
  }
  private async unarchive(id: string, op: OperationContext): Promise<void> {
    const archived = this.requireArchived(id, op);
    if (archived.purgePending) throw new Error('此归档已开始永久清理。');
    const runtimes = this.options.runtimes.list();
    const runtime = runtimes.find(value => value.id === archived.runtimeId) ?? runtimes.find(value => value.version === archived.runtimeVersion);
    if (!runtime) throw new Error(`请先安装 DSH ${archived.runtimeVersion}，然后恢复此实例。`);
    this.busy.add(id);
    try {
      await assertOwnedDirectory(this.options.rootPath, this.getRoot(id));
      await this.commitRegistry(async () => {
        op.signal.throwIfAborted();
        const instance = dshInstanceSchema.parse({ ...archived, runtimeId: runtime.id, isDefault: !this.instances.some(value => value.isDefault), updatedAt: new Date().toISOString() });
        const archive = this.archived.filter(item => item.id !== id);
        await this.writeInstanceRegistry([...this.instances, instance], archive);
        this.instances.push(instance);
        this.archived = archive;
      });
    } finally { this.busy.delete(id); }
    this.notifyChanged();
  }
  private async purgeArchive(id: string, op: OperationContext): Promise<void> {
    this.requireArchived(id, op);
    const root = this.getRoot(id);
    this.busy.add(id);
    try {
      await assertOwnedDirectory(this.options.rootPath, root).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await this.commitRegistry(async () => {
        op.signal.throwIfAborted();
        const archive = this.archived.map(item => item.id === id ? { ...item, purgePending: true as const } : item);
        await this.writeInstanceRegistry(this.instances, archive);
        this.archived = archive;
      });
      this.notifyChanged();
      await this.options.clearBrowserData(id);
      await removeManaged(this.options.rootPath, root);
      await this.commitRegistry(async () => {
        const archive = this.archived.filter(item => item.id !== id);
        await this.writeInstanceRegistry(this.instances, archive);
        this.archived = archive;
      });
    } finally { this.busy.delete(id); }
    this.notifyChanged();
  }
  async remove(id: string, operation?: OperationContext): Promise<void> {
    operation?.signal.throwIfAborted();
    const instance = this.available(id, true, operation?.id); this.busy.add(id);
    try {
      await this.options.closeWorkbench(id); await this.options.clearBrowserData(id);
      this.touchInstance(id); this.leases.forget(id);
      this.manualStops.delete(id); this.suspendedCompanions.delete(id);
      this.lastCompanionUse.delete(id);
      await removeManaged(this.options.rootPath, this.getRoot(id)); this.instances = this.instances.filter(value => value.id !== id);
      if (instance.isDefault) { const next = this.instances.find(value => !value.companionId) ?? this.instances[0]; if (next) next.isDefault = true; }
      await this.changed();
    } finally { this.busy.delete(id); }
  }
  async handle(request: DshLauncherRequest): Promise<DshLauncherResponse> {
    try {
      if (request.type === 'instance.rename') { this.available(request.instanceId).name = request.name; await this.changed(); return { ok: true }; }
      if (request.type === 'instance.default') { await this.selectExecutionInstance(request.instanceId); return { ok: true }; }
      if (request.type === 'instance.logs') return { ok: true, text: sanitizeOutput((await readFile(path.join(this.getRoot(request.instanceId), 'logs', 'host.log'), 'utf8').catch(() => '')).slice(-128000)) };
      if (request.type === 'snapshot.delete') { const snapshot = this.snapshotRecords.find(value => value.id === request.snapshotId); if (!snapshot) throw new Error('Snapshot not found.');
        await removeManaged(this.options.rootPath, path.join(this.options.rootPath, 'snapshots', snapshot.id)); this.snapshotRecords = this.snapshotRecords.filter(value => value.id !== snapshot.id); await this.changed(); return { ok: true }; }
      const id = 'instanceId' in request ? request.instanceId : undefined;
      const kind = request.type === 'instance.delete' ? 'instance.archive' : request.type;
      const operationId = await this.options.operations.run(kind, kind, id, async op => {
        switch (request.type) {
          case 'instance.upgrade': await this.upgradeCompanion(request.instanceId, request.runtimeId, op); break;
          case 'instance.create': await this.create(request.name, request.runtimeId, op); break;
          case 'instance.start': case 'instance.open': {
            const id = request.instanceId, started = performance.now();
            const listeners = this.startupListeners.get(id) ?? new Set();
            const showPhase = (phase: DshHostStartupProgress['phase']) => {
              if (!op.signal.aborted && (phase === 'preparing-profile' || phase === 'starting-host')) void op.update(phase).catch(() => undefined);
            };
            listeners.add(showPhase); this.startupListeners.set(id, listeners);
            try {
              const phase = this.startupPhases.get(id); if (phase) showPhase(phase);
              await this.ensureHost(id, op.signal);
            } finally { listeners.delete(showPhase); if (!listeners.size) this.startupListeners.delete(id); }
            await op.update('opening-workbench'); op.signal.throwIfAborted();
            await op.log(`Native Web Host ready in ${Math.round(performance.now() - started)} ms`);
            await this.options.openWorkbench(this.get(request.instanceId), this.getUrl(request.instanceId)!); break;
          }
          case 'instance.stop': await this.stop(request.instanceId); break;
          case 'instance.delete': case 'instance.archive': await this.archive(request.instanceId, op); break;
          case 'instance.unarchive': await this.unarchive(request.instanceId, op); break;
          case 'instance.purge-archive': await this.purgeArchive(request.instanceId, op); break;
          case 'snapshot.restore': {
            const snapshot = this.snapshotRecords.find(value => value.id === request.snapshotId); if (!snapshot) throw new Error('Snapshot not found.');
            const target = request.runtimeId ? this.options.runtimes.get(request.runtimeId) : undefined;
            if (target && (!snapshot.upgradeFromVersion || !dshVersionPattern.test(target.version) || compareDshVersions(target.version, snapshot.upgradeFromVersion) < 0)) {
              throw new Error('请选择与升级前版本相同或更新的 DSH 运行版本来恢复此快照。');
            }
            await this.restoreFrom(path.join(this.options.rootPath, 'snapshots', snapshot.id), request.name, op, target); break;
          }
          case 'snapshot.create': {
            await this.withStoppedInstance(request.instanceId, async () => {
              const snapshotId = randomUUID(), stage = path.join(this.options.rootPath, 'staging', snapshotId);
              try { const inventory = await this.exportData(request.instanceId, stage, op);
                await rename(stage, path.join(this.options.rootPath, 'snapshots', snapshotId));
                this.snapshotRecords.unshift({ id: snapshotId, instanceId: request.instanceId, name: request.name, runtimeId: this.require(request.instanceId).runtimeId,
                  createdAt: new Date().toISOString(), contentSha256: inventory.contentSha256, fileCount: inventory.fileCount, byteLength: inventory.byteLength }); await this.changed();
              } finally { await removeManaged(this.options.rootPath, stage); }
            }, op.id); break;
          }
          case 'instance.clone': {
            await this.withStoppedInstance(request.instanceId, async () => {
              const cloned = await this.create(request.name, request.runtimeId ?? this.require(request.instanceId).runtimeId, op);
              for (const name of ['home', 'agents']) await copyTree(path.join(this.getRoot(request.instanceId), name), path.join(this.getRoot(cloned.id), name),
                { signal: op.signal, skip: relative => skipData(`${name}/${relative}`) || name === 'home' && /^(sessions|attachments|storages)([/\\]|$)/.test(relative) });
              await this.installDependencies(cloned.id, op.signal);
            }, op.id); break;
          }
          default: throw new Error('Unsupported instance request.');
        }
      }); return { ok: true, operationId };
    } catch (error) { return { ok: false, error: sanitizeOutput(String(error)) }; }
  }
  async shutdown(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer); this.idleTimers.clear();
    this.closing = true; for (const controller of this.startControllers.values()) controller.abort(new Error('Launcher closing.'));
    await Promise.allSettled(this.sharedProvisioning ? [this.sharedProvisioning] : []);
    await Promise.allSettled(this.starts.values()); await Promise.allSettled([...this.hosts.keys()].map(id => this.stop(id, { automatic: true }))); await Promise.allSettled(this.stops.values()); await this.writes;
  }
}
