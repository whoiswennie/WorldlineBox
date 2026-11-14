import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { DSH_LAUNCHER_CHANNEL, DSH_LAUNCHER_CHANGED_CHANNEL, DSH_TERMINAL_OUTPUT_CHANNEL, dshLauncherRequestSchema, dshPackPublicationRecordSchema, type DshLauncherRequest, type DshLauncherResponse, type DshLauncherState, type DshInstance, type DshCompanionCapabilityState } from '../../shared/dsh-launcher';
import { atomicJson, copyTree, inventoryTree, readJson, redact, removeManaged } from './files';
import { OperationStore } from './operations';
import { RuntimeService } from './runtime-service';
import { LauncherNetwork } from './launcher-network';
import { OfficialVersionCatalogue } from './official-versions';
import { resolvePortableTools, type PortableToolchain } from '../portable-tools';
import { PackDistributionService } from './pack-distribution';
import { resolveDshWorkbenchIcon } from './workbench-icon';
import { InstanceService, type DshHostStartupProgress } from './instance-service';
import { DshCliTerminal } from './cli-terminal';
import { PackService } from './packs';
import { extractSealedArchive, writeSealedArchive } from './archive';
import { runtimeReferences } from '../../shared/dsh-runtime-references';
import { compareDshVersions, dshVersionPattern } from '../../shared/dsh-version-order';
import { configureWorkbenchBrowser } from './workbench-browser';
import type { CompanionInstanceLeaseKind } from './companion-instance-leases';
import { restoreCompanionKeepAlive, type CompanionEnvironmentOwner } from './companion-keep-alive';
import { DshHostUnavailableError } from './host-errors';
import { CabinWorld, cabinBridgeOnline } from '../cabin-world';
import { connectCabinPlugin } from './cabin-plugin';

export class DshLauncher {
  private readonly cabin: CabinWorld;
  private cabinPreparation?: Promise<void>;
  private readonly cabinPluginPath: string;
  async scheduledCabinOnline(): Promise<boolean> {
    const instance = this.instances.list().find(item => item.isDefault);
    if (!instance) return false;
    const file = path.join(instance.homePath, 'plugin-data', 'worldlinebox-cabin-world', 'config.json');
    const config = await readJson<{ bridgeJson?: string }>(file);
    if (!config?.bridgeJson || !path.isAbsolute(config.bridgeJson)) return false;
    return path.relative(config.bridgeJson, this.cabin.bridgeJson) === '' ? this.cabin.online() : cabinBridgeOnline(config.bridgeJson);
  }

  async openCabin(signal?: AbortSignal): Promise<void> {
    await this.initialization;
    signal?.throwIfAborted();
    await this.cabin.open();
    signal?.throwIfAborted();
    if (this.instances.list().some(instance => instance.isDefault)) {
      await (this.cabinPreparation ??= this.connectCabin().finally(() => { this.cabinPreparation = undefined; }));
    }
    signal?.throwIfAborted();
  }

  private async connectCabin(): Promise<void> {
    const instance = await this.resolveBotInstance();
    await connectCabinPlugin({ instance, cabin: this.cabin, packagePath: this.cabinPluginPath,
      ensureHost: () => this.instances.ensureHost(instance.id), recordChange: result => this.instances.recordPluginChange(instance.id, result) });
  }
  private botInstanceId?: string;
  private readonly botPreparationByInstance = new Map<string, DshHostStartupProgress>();
  private readonly botPreparations = new Map<string, Promise<void>>();
  private companionProvisioning = 0;
  botPreparationState(instanceId = this.botInstanceId): DshHostStartupProgress | undefined {
    const value = instanceId && this.botPreparationByInstance.get(instanceId); return value ? structuredClone(value) : undefined;
  }
  /** Resolve a supplied native binding. Ordinary launcher operations may use
   * their explicit default; neither route allocates an environment implicitly. */
  private async botInstance(instanceId?: string): Promise<string> {
    try { await this.initialization; }
    catch (error) { throw new DshHostUnavailableError('startup', 'DSH 启动器初始化失败，请检查启动器运行信息。', instanceId, error); }
    if (this.closed) throw new DshHostUnavailableError('closing', 'DSH 启动器正在关闭。', instanceId);
    if (instanceId) {
      let instance: DshInstance;
      try { instance = this.instances.get(instanceId); this.runtimes.get(instance.runtimeId); }
      catch (error) { throw new DshHostUnavailableError('configuration', '任务绑定的 DSH 实例或运行版本不可用，请在启动器检查原执行环境。', instanceId, error); }
      if (this.runtimes.get(instance.runtimeId).adapter !== 'node-cli-web-v1') throw new DshHostUnavailableError('configuration', '伙伴需要原生 Node Web 运行环境；请在 DSH 启动器安装或导入该环境。', instanceId);
      return instanceId;
    }
    // Only the persisted shared selection is eligible for new work. Historical
    // profiles remain available through their explicit durable lane binding.
    const compatible = this.instances.list().filter(instance => this.runtimes.list().some(runtime => runtime.id === instance.runtimeId && runtime.adapter === 'node-cli-web-v1'));
    const selected = compatible.find(instance => instance.isDefault);
    if (!selected) {
      throw new DshHostUnavailableError('configuration', '请先下载 DSH 版本，并创建或选择一个共享执行实例。');
    }
    this.botInstanceId = selected.id; return selected.id;
  }
  async botHost(instanceId?: string, signal?: AbortSignal, options: { explicit?: boolean } = {}) {
    signal?.throwIfAborted();
    const selection = this.botInstance(instanceId);
    const id = signal ? await new Promise<string>((resolve, reject) => {
      const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      selection.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    }) : await selection;
    signal?.throwIfAborted();
    const instance = this.instances.get(id), runtime = this.runtimes.get(instance.runtimeId);
    const client = await this.instances.ensureHost(id, signal, { automatic: !options.explicit });
    return { client, instance, runtime };
  }
  /** Resolve the trusted execution instance before a native admission, so the
   * caller can persist a lane binding before any model/tool work is submitted. */
  async resolveBotInstance(instanceId?: string): Promise<DshInstance> { return this.instances.get(await this.botInstance(instanceId)); }
  async resolveCompanionInstance(companionId: string, name: string): Promise<DshInstance> {
    await this.initialization;
    if (this.closed) throw new DshHostUnavailableError('closing', 'DSH 启动器正在关闭。');
    this.validateCompanion?.(companionId); void name;
    return this.resolveBotInstance();
  }
  acquireCompanionLease(instanceId: string, kind: CompanionInstanceLeaseKind): () => void { return this.instances.acquireCompanionLease(instanceId, kind); }
  companionCapabilityState(companionId: string): DshCompanionCapabilityState {
    void companionId; const instance = this.instances.list().find(value => value.isDefault);
    const runtime = instance && this.runtimes.list().find(value => value.id === instance.runtimeId);
    const mutations = this.operations.list().filter(value => value.instanceId === instance?.id && value.status === 'succeeded'
      && /(?:plugin|skill|upgrade)/.test(value.kind)).map(value => value.id).sort();
    const revision = createHash('sha256').update(JSON.stringify([instance?.id, runtime?.contentSha256, instance?.updatedAt,
      this.companionCapabilityEpoch.get(instance?.id ?? '') ?? 0, mutations])).digest('hex');
    return { mode: 'shared', instanceId: instance?.id, runtimeVersion: runtime?.version, revision,
      status: instance?.status ?? 'unconfigured', configured: !!instance && !!runtime, keepAlive: instance?.keepAlive };
  }
  async startCompanionEnvironment(companionId: string, name: string, signal?: AbortSignal): Promise<DshInstance> {
    signal?.throwIfAborted();
    const instance = await this.resolveCompanionInstance(companionId, name);
    signal?.throwIfAborted(); await this.instances.ensureHost(instance.id, signal); return this.instances.get(instance.id);
  }
  async stopCompanionEnvironment(companionId: string): Promise<void> {
    // BotService stops this actor's turns/tasks first. A role-level action must
    // never stop the shared process used by other actors or the native Web UI.
    void companionId;
  }
  async restoreCompanionEnvironments(companions: readonly CompanionEnvironmentOwner[], signal?: AbortSignal, isEnabled?: (id: string) => boolean): Promise<void> {
    await this.initialization; signal?.throwIfAborted();
    if (this.closed) throw new Error('DSH 启动器正在关闭。');
    await restoreCompanionKeepAlive(companions, this.instances.list(), async (_owner, instance) => {
      if (this.closed || this.instances.list().find(value => value.isDefault)?.id !== instance.id) return;
      signal?.throwIfAborted(); await this.instances.ensureHost(instance.id, signal, { automatic: true });
    }, signal, isEnabled);
  }
  async stopRetiredBotHost(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (instance.name !== 'WorldlineBox 伙伴主脑') throw new Error('只能退休旧伙伴专用实例。');
    await this.instances.stop(instanceId);
  }
  /** Native memory addons use the managed Node ABI, never Electron's binary. */
  async botNodePath(instanceId?: string): Promise<string> {
    const id = await this.botInstance(instanceId);
    // Memory can initialize while the independently shared Host verifies its
    // runtime/profile. Resolving Node must not wait for package installation.
    void this.prepareBotInstance(id).catch(() => undefined);
    return this.instances.launchPlan(id).executable;
  }
  /** Warm the real native Host, without creating a Session or calling a model. */
  async prepareBot(instanceId?: string): Promise<void> { return this.prepareBotInstance(await this.botInstance(instanceId)); }
  private prepareBotInstance(id: string): Promise<void> {
    const existing = this.botPreparations.get(id); if (existing) return existing;
    const pending = this.instances.ensureHost(id, undefined, { automatic: true }).then(() => undefined);
    this.botPreparations.set(id, pending);
    void pending.finally(() => { if (this.botPreparations.get(id) === pending) this.botPreparations.delete(id); }).catch(() => undefined);
    return pending;
  }
  private ready = false;
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly openingWindows = new Map<string, Promise<void>>();
  private readonly operations: OperationStore;
  private readonly runtimes: RuntimeService;
  private readonly instances: InstanceService;
  private readonly packs: PackService;
  private readonly cliTerminal: DshCliTerminal;
  private readonly network: LauncherNetwork;
  private readonly versions: OfficialVersionCatalogue;
  private startingVersionRefresh?: Promise<string>;
  private lastVersionRefresh?: { at: number; networkRevision: number };
  private readonly distributions: PackDistributionService;
  private publications: NonNullable<DshLauncherState['packPublications']> = [];
  private tools?: Promise<PortableToolchain>;
  private selectionEpoch = 0;
  private readonly rootPath: string;
  private readonly initialization: Promise<void>;
  private closed = false;
  private previousThrottling: boolean | undefined;
  private capabilityIdentity?: string;
  private watchedCapabilityIdentity?: string;
  private readonly capabilityWatchers: FSWatcher[] = [];
  private readonly companionCapabilityEpoch = new Map<string, number>();
  private readonly companionCapabilityWatchers = new Map<string, FSWatcher[]>();
  private companionCapabilityTimer?: ReturnType<typeof setTimeout>;
  private readonly capabilityMutations = new Set<string>();
  private capabilityChangeTimer?: ReturnType<typeof setTimeout>;
  private prewarmTimer?: ReturnType<typeof setTimeout>;
  private prewarmRevision = 0;
  private defaultPrewarmIdentity?: string;
  private prewarming?: { instanceId: string; promise: Promise<void> };
  private executionReadiness?: DshLauncherState['executionReadiness'];
  constructor(private readonly getMainWindow: () => BrowserWindow | null | undefined, reportInitializationError?: (error: unknown) => void,
    private readonly applicationNetwork?: LauncherNetwork, private readonly onExecutionCapabilitiesChanged?: () => void,
    private readonly onBotPreparationChanged?: (progress: DshHostStartupProgress) => void,
    private readonly onInstanceStopped?: (instanceId: string) => void,
    private readonly validateCompanion?: (companionId: string) => void) {
    this.rootPath = path.join(app.getPath('userData'), 'dsh');
    const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
    this.cabin = new CabinWorld(path.join(resources, 'cabin-world'), path.join(app.getPath('userData'), 'cabin-world'), process.execPath);
    this.cabinPluginPath = path.join(resources, 'dsh-cabin-world');
    const onChanged = () => {
      if (!this.ready || this.closed) return;
      this.observeExecutionCapabilities();
      this.watchCompanionCapabilities(onChanged);
      const main = getMainWindow();
      if (main && !main.isDestroyed()) {
        const state = this.state();
        const cliId = state.cli?.selectedInstanceId;
        if (cliId && !state.instances.some(instance => instance.id === cliId)) void this.cliTerminal.invalidate(cliId).catch(() => undefined);
        const operating = state.operations.some(operation => operation.status === 'running');
        if (operating && this.previousThrottling === undefined) {
          this.previousThrottling = main.webContents.getBackgroundThrottling();
          main.webContents.setBackgroundThrottling(false);
        } else if (!operating && this.previousThrottling !== undefined) {
          main.webContents.setBackgroundThrottling(this.previousThrottling);
          this.previousThrottling = undefined;
        }
        main.webContents.send(DSH_LAUNCHER_CHANGED_CHANNEL, state);
        for (const [id, workbench] of this.windows) {
          const instance = state.instances.find(value => value.id === id);
          const runtime = instance && state.runtimes.find(value => value.id === instance.runtimeId);
          if (instance && runtime && !workbench.isDestroyed()) workbench.setTitle(`${instance.name} · DSH ${runtime.version}`);
        }
      }
    };
    this.operations = new OperationStore(path.join(this.rootPath, 'operations'), onChanged);
    this.network = applicationNetwork ?? new LauncherNetwork(path.join(app.getPath('userData'), 'network'), onChanged);
    if (applicationNetwork) applicationNetwork.subscribe(onChanged);
    this.versions = new OfficialVersionCatalogue({ rootPath: this.rootPath, json: (url, signal, revalidate) => this.network.json(url, signal, revalidate), onChanged });
    this.runtimes = new RuntimeService({ rootPath: this.rootPath, onChanged, fetch: this.network.fetch,
      nodeTools: () => this.toolchain(), nodeInstallNetwork: signal => this.network.nodeInstallNetwork(signal) });
    this.instances = new InstanceService({ rootPath: this.rootPath, runtimes: this.runtimes, operations: this.operations, onChanged,
      onManualStop: id => this.onInstanceStopped?.(id),
      onStartup: progress => {
        this.botPreparationByInstance.set(progress.instanceId, progress);
        if (progress.phase === 'ready' && this.executionReadiness?.instanceId === progress.instanceId) {
          this.executionReadiness = { instanceId: progress.instanceId, status: 'ready', updatedAt: progress.updatedAt };
          onChanged();
        }
        try { this.onBotPreparationChanged?.(structuredClone(progress)); } catch { /* Startup observers cannot break the shared Host. */ }
      },
      bridgePackagePath: app.isPackaged ? path.join(process.resourcesPath, 'dsh-bridge') : path.join(app.getAppPath(), 'resources', 'dsh-bridge'),
      networkEnvironment: env => this.network.environment(env),
      isCliInUse: id => (this.cliTerminal.state().terminals ?? []).some(terminal => terminal.status === 'running' && (!id || terminal.instanceId === id)),
      isExternallyInUse: (id, exceptOperationId) => !!this.windows.get(id) && !this.windows.get(id)!.isDestroyed()
        || this.operations.isInstanceInUse(id, exceptOperationId),
      openWorkbench: (instance, url) => this.openWorkbench(instance, url),
      closeWorkbench: async id => { const window = this.windows.get(id); if (window && !window.isDestroyed()) window.destroy(); this.windows.delete(id); },
      clearBrowserData: async id => { await session.fromPartition(`persist:dsh-instance-${id}`).clearStorageData(); },
    });
    this.packs = new PackService({ rootPath: this.rootPath, runtimes: this.runtimes, instances: this.instances, operations: this.operations, onChanged,
      ensureRuntime: (lock, file, op) => this.runtimes.installNodeFromLock(lock, file, op) });
    this.distributions = new PackDistributionService({ rootPath: this.rootPath, network: this.network,
      exportArchive: (id, file, signal) => this.packs.exportArchive(id, file, signal),
      importArchive: (file, op) => this.packs.importArchive(file, op), request: (url, input) => this.network.request(url, input) });
    this.cliTerminal = new DshCliTerminal({ rootPath: this.rootPath, onChanged,
      onOutput: output => { const main = getMainWindow(); if (main && !main.isDestroyed()) main.webContents.send(DSH_TERMINAL_OUTPUT_CHANNEL, output); }, resolveSelection: async () => {
      const records = this.instances.list();
      const current = records.find(value => value.id === this.cliTerminal.state().selectedInstanceId) ?? records.find(value => value.isDefault);
      if (!current) throw new Error('Create and select a DSH instance before opening its CLI terminal.');
      return this.instances.prepareCli(current.id);
    } });
    this.initialization = this.init();
    // Surface startup failures through state requests without an unhandled rejection.
    void this.initialization.catch(error => { try { reportInitializationError?.(error); } catch { /* Preserve domain isolation even if diagnostics cannot be written. */ } });
  }
  private toolchain(): Promise<PortableToolchain> { return this.tools ??= resolvePortableTools(); }
  private async refreshVersions(ifStale = false): Promise<DshLauncherResponse> {
    if (this.startingVersionRefresh) return { ok: true, operationId: await this.startingVersionRefresh };
    const running = this.operations.runningId('versions.refresh');
    if (running) return { ok: true, operationId: running };

    const networkRevision = this.network.state().revision;
    const last = this.lastVersionRefresh;
    const cooldown = last?.networkRevision === networkRevision && Date.now() - last.at < 60_000;
    const recent = (!last || last.networkRevision === networkRevision) && this.versions.isFresh();
    if (ifStale && (cooldown || recent)) return { ok: true };

    const starting = this.operations.run('versions.refresh', '同步官方 DSH 发行版', undefined, async op => {
      let revision = networkRevision;
      try {
        try { await this.versions.refresh(op.signal, op.update); }
        catch (error) {
          const currentRevision = this.network.state().revision;
          if (op.signal.aborted || currentRevision === revision) throw error;
          revision = currentRevision;
          await this.versions.refresh(op.signal, op.update);
        }
      } finally { this.lastVersionRefresh = { at: Date.now(), networkRevision: revision }; }
    });
    this.startingVersionRefresh = starting;
    try { return { ok: true, operationId: await starting }; }
    finally { this.startingVersionRefresh = undefined; }
  }
  private async init(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    if (!this.applicationNetwork) await this.network.init(); await this.versions.init();
    await this.operations.init(); await this.runtimes.init(); await this.instances.init(); await this.packs.init(); await this.cliTerminal.init();
    const publications = await readJson<unknown[]>(path.join(this.rootPath, 'pack-publications.json')) ?? [];
    this.publications = publications.slice(0, 100).map(value => dshPackPublicationRecordSchema.parse(value));
    this.ready = true;
    this.observeExecutionCapabilities();
    this.watchCompanionCapabilities(() => {
      this.onExecutionCapabilitiesChanged?.();
      const main = this.getMainWindow(); if (main && !main.isDestroyed()) main.webContents.send(DSH_LAUNCHER_CHANGED_CHANNEL, this.state());
    });
    // Installation and actual execution own compatibility/integrity checks.
    // Listing the home page must never boot every installed runtime or CLI.
  }
  private watchCompanionCapabilities(changed: () => void): void {
    for (const instance of this.instances.list()) {
      if (this.companionCapabilityWatchers.has(instance.id)) continue;
      const watchers: FSWatcher[] = []; this.companionCapabilityWatchers.set(instance.id, watchers);
      const invalidate = () => {
        if (this.closed) return;
        this.companionCapabilityEpoch.set(instance.id, (this.companionCapabilityEpoch.get(instance.id) ?? 0) + 1);
        if (this.companionCapabilityTimer) clearTimeout(this.companionCapabilityTimer);
        this.companionCapabilityTimer = setTimeout(() => { this.companionCapabilityTimer = undefined; if (!this.closed) { this.onExecutionCapabilitiesChanged?.(); changed(); } }, 150);
        this.companionCapabilityTimer.unref();
      };
      for (const [directory, profileOnly] of [[instance.homePath, true], [instance.agentsPath, false]] as const) {
        try {
          const watcher = watch(directory, { recursive: true }, (event, filename) => {
            const relative = String(filename ?? '').replaceAll('\\', '/');
            if (profileOnly && relative && !relative.startsWith('profiles/') && !/(?:^|\/)(?:\.env|credentials\.(?:yaml|yml|json)|cordis\.(?:yaml|yml)|package\.json)$/.test(relative)) return;
            if (/(?:^|\/)(?:node_modules|\.plugin-manager|storages|sessions|logs|cache|llm-deepseek|skills-disabled)(?:\/|$)/.test(relative)) return;
            // Windows also reports parent-directory metadata changes for writes
            // inside ignored task/session trees. Only rename/create events on
            // directories can change the capability tree itself.
            if (event === 'change' && relative) {
              void stat(path.join(directory, relative)).then(info => { if (!info.isDirectory()) invalidate(); }, invalidate);
              return;
            }
            invalidate();
          });
          watcher.on('error', invalidate); watcher.unref();
          watchers.push(watcher);
        } catch { /* A newly created profile may not exist until its first native start. */ }
      }
    }
    for (const [id, watchers] of this.companionCapabilityWatchers) {
      if (this.instances.list().some(instance => instance.id === id)) continue;
      for (const watcher of watchers) watcher.close(); this.companionCapabilityWatchers.delete(id); this.companionCapabilityEpoch.delete(id);
    }
  }
  /** Capability facts depend on selection/configuration; task stream updates do not invalidate them. */
  private observeExecutionCapabilities(): void {
    const selected = this.instances.list().find(instance => instance.isDefault)?.id;
    const instance = this.instances.list().find(value => value.id === selected);
    const runtime = this.runtimes.list().find(value => value.id === instance?.runtimeId);
    const changes = this.operations.list().filter(operation => operation.status === 'succeeded' &&
      ['instance.restore', 'backup.import', 'pack.import', 'pack.import-url'].includes(operation.kind)).map(operation => operation.id);
    const mutation = changes.some(id => !this.capabilityMutations.has(id));
    for (const id of changes) this.capabilityMutations.add(id);
    const identity = JSON.stringify([selected, instance?.runtimeId, runtime?.contentSha256]);
    if (identity !== this.capabilityIdentity) {
      const previous = this.capabilityIdentity; this.capabilityIdentity = identity;
      if (previous !== undefined) this.onExecutionCapabilitiesChanged?.();
    } else if (mutation) { this.onExecutionCapabilitiesChanged?.(); }
    // Browsing/selecting a profile is not permission to start its processes.
    // Only the default profile is warmed automatically; explicit execution and
    // durable native-context bindings select other instances separately.
    const defaultInstance = this.instances.list().find(value => value.isDefault);
    const defaultRuntime = this.runtimes.list().find(value => value.id === defaultInstance?.runtimeId);
    const prewarmIdentity = JSON.stringify([defaultInstance?.id, defaultInstance?.runtimeId, defaultRuntime?.contentSha256]);
    if (prewarmIdentity !== this.defaultPrewarmIdentity || mutation) {
      this.defaultPrewarmIdentity = prewarmIdentity; this.scheduleExecutionPrewarm(defaultInstance?.id);
    }
    const watchIdentity = JSON.stringify([selected, instance?.homePath, instance?.agentsPath]);
    if (watchIdentity === this.watchedCapabilityIdentity) return;
    this.watchedCapabilityIdentity = watchIdentity;
    for (const watcher of this.capabilityWatchers.splice(0)) watcher.close();
    const changed = () => {
      clearTimeout(this.capabilityChangeTimer);
      this.capabilityChangeTimer = setTimeout(() => { if (!this.closed) this.onExecutionCapabilitiesChanged?.(); }, 150);
    };
    const add = (directory: string, recursive: boolean, relevant: (file: string) => boolean) => {
      try {
        const watcher = watch(directory, { recursive }, (_event, file) => { if (file && relevant(String(file))) changed(); });
        watcher.on('error', changed); watcher.unref(); this.capabilityWatchers.push(watcher);
      } catch { /* Missing optional config directories are checked on the next selection or mutation. */ }
    };
    if (instance) {
      // A newly created instance has no profiles directory until native init.
      // Watch its existing home so later profile creation and atomic replacement
      // remain observable without relying on an already present child directory.
      add(instance.homePath, true, file => {
        const segments = file.split(/[\\/]/);
        if (segments.some(part => ['node_modules', 'storages', 'sessions', 'logs', 'cache', 'llm-deepseek', 'skills-disabled'].includes(part))) return false;
        return segments[0] === 'profiles' || /(?:\.env|credentials\.(?:yaml|yml|json)|cordis\.(?:yaml|yml)|package\.json)$/.test(file);
      });
      add(instance.agentsPath, true, () => true);
    }
  }
  private scheduleExecutionPrewarm(instanceId?: string): void {
    if (instanceId && !this.instances.list().some(value => value.id === instanceId && value.isDefault)) return;
    clearTimeout(this.prewarmTimer); const revision = ++this.prewarmRevision;
    this.executionReadiness = instanceId ? { instanceId, status: 'warming', updatedAt: new Date().toISOString() } : undefined;
    if (!instanceId || this.closed) return;
    this.prewarmTimer = setTimeout(() => {
      if (this.closed || revision !== this.prewarmRevision) return;
      // Warm the native Host without submitting a model turn.
      const promise = (async () => {
        await this.instances.ensureHost(instanceId, undefined, { automatic: true });
      })().then(() => {
        if (revision === this.prewarmRevision) this.executionReadiness = { instanceId, status: 'ready', updatedAt: new Date().toISOString() };
      }, () => {
        // Capability discovery may fail independently of a healthy native
        // Host. Keep startup state truthful after an explicit/on-demand start.
        if (revision !== this.prewarmRevision) return;
        const status = this.instances.list().find(instance => instance.id === instanceId)?.status;
        this.executionReadiness = status ? { instanceId,
          status: status === 'running' ? 'ready' : status === 'stopped' || status === 'stopping' ? 'cold' : 'failed', updatedAt: new Date().toISOString() } : undefined;
      }).finally(() => {
        if (this.prewarming?.promise === promise) this.prewarming = undefined;
        if (!this.closed && revision === this.prewarmRevision) {
          const main = this.getMainWindow(); if (main && !main.isDestroyed()) main.webContents.send(DSH_LAUNCHER_CHANGED_CHANNEL, this.state());
        }
      });
      this.prewarming = { instanceId, promise };
    }, 300);
    this.prewarmTimer.unref();
  }
  state(): DshLauncherState {
    return { supported: process.platform === 'win32' && process.arch === 'x64', rootPath: this.rootPath,
      runtimes: this.runtimes.list(), instances: this.instances.list(), archivedInstances: this.instances.archivedInstances(), snapshots: this.instances.snapshots(),
      packs: this.packs.list(), operations: this.operations.list(), cli: this.cliTerminal.state(),
      pendingRuntimeDeletions: this.runtimes.pendingDeletionVersions(),
      companionCapabilityRevisions: Object.fromEntries(this.instances.list().map(instance => [instance.id, this.companionCapabilityEpoch.get(instance.id) ?? 0])),
      network: this.network.state(), versions: this.versions.state(), packPublications: structuredClone(this.publications), executionReadiness: this.executionReadiness };
  }
  private async openWorkbench(instance: DshInstance, value: string): Promise<void> {
    const pending = this.openingWindows.get(instance.id); if (pending) return pending;
    const task = this.openWorkbenchNow(instance, value); this.openingWindows.set(instance.id, task);
    try { await task; } finally { if (this.openingWindows.get(instance.id) === task) this.openingWindows.delete(instance.id); }
  }
  private async openWorkbenchNow(instance: DshInstance, value: string): Promise<void> {
    const silentTesting = process.env.WORLDLINEBOX_E2E === '1' && process.env.WORLDLINEBOX_E2E_DSH_SILENT === '1';
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Rejected non-local DSH workbench URL.');
    const existing = this.windows.get(instance.id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const icon = await resolveDshWorkbenchIcon(this.runtimes.directory(instance.runtimeId));
    await this.network.attachSession(session.fromPartition(instance.browserPartition));
    const window = new BrowserWindow({ width: 1280, height: 850, minWidth: 900, minHeight: 620, title: `${instance.name} · DSH ${this.runtimes.get(instance.runtimeId).version}`, icon, show: false,
      autoHideMenuBar: true, webPreferences: { partition: instance.browserPartition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, ...(silentTesting ? { backgroundThrottling: false } : {}) } });
    window.setMenu(null);
    window.on('page-title-updated', event => event.preventDefault());
    configureWorkbenchBrowser(window, url.href, { icon, onIssue: message => {
      void appendFile(path.join(this.rootPath, 'instances', instance.id, 'logs', 'host.log'), `${message}\n`).catch(() => undefined);
    } });
    window.once('ready-to-show', () => { if (!window.isDestroyed() && !silentTesting) window.show(); });
    window.on('closed', () => { if (this.windows.get(instance.id) === window) this.windows.delete(instance.id); });
    this.windows.set(instance.id, window);
    await window.loadURL(url.href);
  }
  registerIpc(): void {
    ipcMain.handle(DSH_LAUNCHER_CHANNEL, async (event, input: unknown): Promise<DshLauncherResponse> => {
      const main = this.getMainWindow();
      if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) return { ok: false, error: 'Unauthorized DSH launcher sender.' };
      const request = dshLauncherRequestSchema.safeParse(input);
      if (!request.success) return { ok: false, error: 'Invalid DSH launcher request.' };
      try {
        await this.initialization;
        if (this.closed) throw new Error('DSH launcher is closing.');
        return await this.handle(request.data);
      } catch (error) { return { ok: false, error: redact(error instanceof Error ? error.message : String(error)) }; }
    });
  }
  private async pick(kind: 'directory' | 'archive'): Promise<string | undefined> {
    const parent = this.getMainWindow(); if (!parent) throw new Error('Main window unavailable.');
    const testing = process.env.WORLDLINEBOX_E2E === '1' ? process.env[`WORLDLINEBOX_E2E_DSH_${kind.toUpperCase()}`] : undefined;
    if (testing) return path.resolve(testing);
    const result = await dialog.showOpenDialog(parent, { title: kind === 'directory' ? '导入 DSH Web UI 运行目录' : '导入 DSH 备份或整合包',
      properties: kind === 'directory' ? ['openDirectory'] : ['openFile'],
      filters: kind === 'archive' ? [{ name: 'DSH package', extensions: ['dshpack', 'dshbackup'] }] : undefined });
    return result.canceled ? undefined : result.filePaths[0];
  }
  private async saveArchive(extension: 'dshpack' | 'dshbackup'): Promise<string | undefined> {
    const parent = this.getMainWindow(); if (!parent) throw new Error('Main window unavailable.');
    const testing = process.env.WORLDLINEBOX_E2E === '1' ? process.env[`WORLDLINEBOX_E2E_DSH_SAVE_${extension.toUpperCase()}`] : undefined;
    if (testing) return path.resolve(testing);
    const result = await dialog.showSaveDialog(parent, { title: '导出 DSH', defaultPath: `DSH.${extension}`, filters: [{ name: 'DSH package', extensions: [extension] }] });
    return result.canceled ? undefined : result.filePath;
  }
  private async handle(request: DshLauncherRequest): Promise<DshLauncherResponse> {
    if (request.type === 'state') return { ok: true, state: this.state() };
    if (request.type === 'cabin.state') return { ok: true, cabin: await this.cabin.state() };
    if (request.type === 'cabin.stop') { await this.cabin.stop(); return { ok: true, cabin: await this.cabin.state() }; }
    if (request.type === 'cabin.open') { await this.openCabin(); return { ok: true, cabin: await this.cabin.state() }; }
    if (request.type === 'versions.refresh') return this.refreshVersions(request.ifStale);
    if (this.operations.list().some(operation => operation.status === 'running' && ['runtime.delete', 'runtime.cleanup'].includes(operation.kind)) && !['operation.cancel'].includes(request.type)) throw new Error('正在清理运行版本，请等待操作完成。');
    if (!this.state().supported) throw new Error('DSH runtime management currently supports Windows x64.');
    switch (request.type) {
      case 'companion.environment.create': case 'companion.environment.bind': {
        this.validateCompanion?.(request.companionId);
        this.companionProvisioning++;
        try {
          const instance = request.type === 'companion.environment.create'
            ? await this.instances.createCompanion(request.companionId, request.name, request.runtimeId)
            : await this.instances.bindCompanion(request.companionId, request.name, request.instanceId);
          return { ok: true, companionEnvironment: { mode: 'shared', instance }, state: this.state() };
        } finally { this.companionProvisioning--; }
      }
      case 'companion.environment.state': {
        const instance = this.instances.list().find(value => value.isDefault);
        return { ok: true, ...(instance ? { companionEnvironment: { mode: 'shared' as const, instance } } : {}), state: this.state() };
      }
      case 'companion.environment.ensure': case 'companion.environment.open': {
        const instance = await this.resolveCompanionInstance(request.companionId, request.name);
        const companionEnvironment = { mode: 'shared' as const, instance };
        if (request.type === 'companion.environment.open') {
          const opened = await this.instances.handle({ type: 'instance.open', instanceId: instance.id });
          return opened.ok ? { ...opened, companionEnvironment } : opened;
        }
        return { ok: true, companionEnvironment };
      }
      case 'companion.environment.configure': {
        const own = await this.resolveCompanionInstance(request.companionId, request.name);
        return { ok: true, companionEnvironment: { mode: 'shared', instance: await this.instances.configureCompanion(own.id, request.keepAlive) } };
      }
      case 'companion.environment.refresh': {
        const own = await this.resolveCompanionInstance(request.companionId, request.name);
        await this.instances.recordPluginChange(own.id, { application: 'restart-required' });
        return { ok: true, companionEnvironment: { mode: 'shared', instance: this.instances.get(own.id) } };
      }
      case 'companion.environment.upgrade': {
        const own = await this.resolveCompanionInstance(request.companionId, request.name);
        return { ok: true, operationId: await this.operations.run(request.type, '升级伙伴共享执行环境', own.id,
          op => this.instances.upgradeCompanion(own.id, request.runtimeId, op)) };
      }
      case 'operation.cancel': this.operations.cancel(request.operationId); return { ok: true };
      case 'operation.clear-finished': return { ok: true, removedOperations: await this.operations.clearFinished(), state: this.state() };







      case 'cli.select': case 'instance.default': {
        // Terminal selection is separate from the shared execution default.
        this.instances.get(request.instanceId);
        const epoch = ++this.selectionEpoch; const selection = await this.instances.prepareCli(request.instanceId);
        if (epoch !== this.selectionEpoch) return { ok: true, cancelled: true, state: this.state() };
        await this.cliTerminal.selectContext(selection);
        if (request.type === 'cli.select') return { ok: true, state: this.state() };
        const result = await this.instances.handle({ type: 'instance.default', instanceId: request.instanceId });
        return result.ok ? { ok: true, state: this.state() } : result;
      }
      case 'cli.install-command': await this.cliTerminal.installCommand(); return { ok: true, state: this.state() };
      case 'terminal.open': await this.cliTerminal.open(request.instanceId ? await this.instances.prepareCli(request.instanceId) : undefined); return { ok: true, state: this.state() };
      case 'terminal.input': this.cliTerminal.write(request.text, request.terminalId); return { ok: true };
      case 'terminal.resize': this.cliTerminal.resize(request.terminalId, request.cols, request.rows); return { ok: true };
      case 'terminal.select': this.cliTerminal.select(request.terminalId); return { ok: true, state: this.state() };
      case 'operation.pause': await this.operations.pause(request.operationId); return { ok: true, state: this.state() };
      case 'operation.resume': await this.operations.resume(request.operationId); return { ok: true, state: this.state() };
      case 'operation.retry': return this.handle(this.operations.retryRequest(request.operationId));
      case 'terminal.close': await this.cliTerminal.close(request.terminalId ?? this.cliTerminal.state().activeTerminalId); return { ok: true, state: this.state() };
      case 'terminal.clear': this.cliTerminal.clear(request.terminalId); return { ok: true, state: this.state() };
      case 'terminal.remove': await this.cliTerminal.remove(request.terminalId); return { ok: true, state: this.state() };
      case 'terminal.export': {
        const parent = this.getMainWindow(); if (!parent) throw new Error('Main window unavailable.');
        const target = await dialog.showSaveDialog(parent, { title: '导出终端日志', defaultPath: 'dsh-terminal.log', filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
        if (target.canceled || !target.filePath) return { ok: true, cancelled: true };
        await writeFile(target.filePath, this.cliTerminal.export(request.terminalId), { mode: 0o600 }); return { ok: true };
      }
      case 'network.save': await this.network.save(request.settings); await this.network.inspect(); return { ok: true, state: this.state() };
      case 'network.patch': await this.network.patch(request.patch); await this.network.inspect(); return { ok: true, state: this.state() };
      case 'network.proxy.toggle': await this.network.setProxyEnabled(request.enabled); await this.network.inspect(); return { ok: true, state: this.state() };
      case 'network.inspect': await this.network.inspect(); return { ok: true, state: this.state() };
      case 'network.test': { const text = await this.network.test(); return { ok: true, text, state: this.state() }; }
      case 'runtime.install': return { ok: true, operationId: await this.operations.run(request.type, `安装 DSH ${request.version} WebUI`, undefined, async op => {
        await op.update('verifying');
        const release = await this.versions.release(request.version, op.signal);
        await this.runtimes.installNode(release, op);
      }, request) };
      case 'instance.upgrade-official': {
        const { instanceId, expectedRuntimeId, version } = request;
        const checkSource = () => {
          if (this.instances.get(instanceId).runtimeId !== expectedRuntimeId) throw new Error('实例的运行版本已变更，请重新选择升级目标。');
        };
        checkSource();
        const previous = this.runtimes.get(expectedRuntimeId).version;
        if (!dshVersionPattern.test(previous) || compareDshVersions(version, previous) <= 0) throw new Error('请选择比实例当前版本更新的官方版本。');
        if (this.operations.isInstanceInUse(instanceId)) throw new Error('该实例还有其他操作正在进行，请稍后再升级。');
        return { ok: true, operationId: await this.operations.run(request.type, `升级实例至 DSH ${version}`, instanceId, async op => {
          let target = this.runtimes.list().find(runtime => runtime.version === version);
          if (!target) {
            await op.update('verifying');
            const release = await this.versions.release(version, op.signal);
            target = await this.runtimes.installNode(release, { ...op, update: (phase, percent) => op.update(phase, percent === undefined ? undefined : percent * .75) });
          }
          checkSource();
          await this.instances.upgradeCompanion(instanceId, target.id, { ...op, update: (phase, percent) => op.update(phase, percent === undefined ? undefined : 75 + percent * .25) });
        }, request) };
      }
      case 'runtime.import': {
        const source = await this.pick(request.sourceKind); if (!source) return { ok: true, cancelled: true };
        return { ok: true, operationId: await this.operations.run(request.type, '导入 DSH 运行版本', undefined, async op => { await this.runtimes.import(source, request.sourceKind, 'local-import', op); }) };
      }
      case 'runtime.verify': return { ok: true, operationId: await this.operations.run(request.type, '校验 DSH 运行版本', undefined, async op => { await op.update('verifying'); await this.runtimes.verify(request.runtimeId, op.signal, true); }) };
      case 'runtime.cleanup': {
        if (this.companionProvisioning) throw new Error('正在保存角色实例绑定，请稍后再清理运行版本。');
        if (this.operations.list().some(operation => operation.status === 'running')) throw new Error('请等待当前下载、检测和任务结束后再清理缓存。');
        return { ok: true, operationId: await this.operations.run(request.type, '清理 DSH 下载缓存和残留文件', undefined, op => this.runtimes.cleanup(op)) };
      }
      case 'runtime.delete': {
        if (this.companionProvisioning) throw new Error('正在保存角色实例绑定，请稍后再删除运行版本。');
        if (this.operations.list().some(operation => operation.status === 'running' && operation.kind !== 'versions.refresh')) throw new Error('请等待当前运行环境操作结束后再删除该版本。');
        const used = runtimeReferences(this.state(), request.runtimeId).length > 0;
        if (used) throw new Error('此运行版本仍被实例、快照或整合包引用，请先处理页面列出的引用。');
        return { ok: true, operationId: await this.operations.run(request.type, '移除 DSH 运行版本', undefined, op =>
          this.runtimes.delete(request.runtimeId, runtimeReferences(this.state(), request.runtimeId).length > 0, op)) };
      }
      case 'instance.folder': {
        const root = this.instances.getRoot(request.instanceId);
        const directory = request.scope === 'workspace' ? this.instances.get(request.instanceId).workspacePath : request.scope === 'root' ? root : path.join(root, request.scope);
        const error = await shell.openPath(directory); if (error) throw new Error(error);
        return { ok: true };
      }
      case 'pack.import': case 'pack.export': {
        const archive = request.type === 'pack.import' ? await this.pick('archive') : await this.saveArchive('dshpack');
        if (!archive) return { ok: true, cancelled: true };
        return this.packs.handle(request, archive);
      }
      case 'pack.inspect-url': return { ok: true, packDistribution: await this.distributions.inspectManifest(request.manifestUrl) };
      case 'pack.import-url': return { ok: true, operationId: await this.operations.run(request.type, '下载并导入版本锁定整合包', undefined,
        op => this.distributions.importDistribution(request.manifestUrl, op).then(() => undefined), request) };
      case 'pack.distribute': {
        const target = await this.saveArchive('dshpack'); if (!target) return { ok: true, cancelled: true };
        return { ok: true, operationId: await this.operations.run(request.type, '导出整合包与分发清单', undefined, async op => {
          const result = await this.distributions.createDistribution(request.packId, target, request.downloadUrl, op.signal);
          await op.log(`Exported ${target}; public manifest ${result.manifestPath}; checksum ${result.checksumPath}.`);
        }) };
      }
      case 'pack.publish': return { ok: true, operationId: await this.operations.run(request.type, `发布整合包至 ${request.repository}`, undefined, async op => {
        const directory = path.join(this.rootPath, 'staging', randomUUID()); await mkdir(directory, { recursive: true });
        try {
          const result = await this.distributions.publishGithub({ ...request, archivePath: path.join(directory, `DSH-${request.packId}.dshpack`) }, op);
          this.publications = [{ ...result, packId: request.packId, createdAt: new Date().toISOString() }, ...this.publications.filter(value => value.repository !== result.repository || value.tag !== result.tag)].slice(0, 100);
          await atomicJson(path.join(this.rootPath, 'pack-publications.json'), this.publications);
          await op.log(`Release: ${result.releaseUrl}\nManifest: ${result.manifestUrl}`);
        } finally { await removeManaged(this.rootPath, directory); }
      }) };
      case 'pack.create': case 'pack.install': case 'pack.delete': return this.packs.handle(request);
      case 'backup.export': {
        const target = await this.saveArchive('dshbackup'); if (!target) return { ok: true, cancelled: true };
        return { ok: true, operationId: await this.operations.run(request.type, '导出实例完整备份（含凭据）', request.instanceId, async op => {
          const staging = path.join(this.rootPath, 'staging', randomUUID());
          const temporary = `${target}.${op.id}.tmp`;
          try {
            await this.instances.exportTo(request.instanceId, staging, op);
            const instance = this.instances.list().find(value => value.id === request.instanceId)!;
            const runtime = this.runtimes.get(instance.runtimeId);
            await op.update('copying-runtime', 45);
            await this.runtimes.verify(runtime.id, op.signal);
            await copyTree(this.runtimes.directory(runtime.id), path.join(staging, 'runtime', 'program'), { signal: op.signal });
            await atomicJson(path.join(staging, 'runtime', 'artifact.json'), runtime);
            await op.update('archiving', 75);
            await writeSealedArchive(staging, temporary, { kind: 'worldlinebox-native-dshbackup-v1', runtimeContentSha256: runtime.contentSha256, runtimeVersion: runtime.version, platform: runtime.platform }, op.signal);
            op.signal.throwIfAborted(); await rename(temporary, target);
          } finally { await rm(temporary, { force: true }); await removeManaged(this.rootPath, staging); }
        }) };
      }
      case 'backup.import': {
        const source = await this.pick('archive'); if (!source) return { ok: true, cancelled: true };
        return { ok: true, operationId: await this.operations.run(request.type, '从完整备份创建新实例', undefined, async op => {
          const staging = path.join(this.rootPath, 'staging', randomUUID());
          try {
            const manifest = await extractSealedArchive(source, staging, op.signal);
            if (manifest.kind !== 'worldlinebox-native-dshbackup-v1') throw new Error('This is not a native WorldlineBox DSH instance backup.');
            const inner = await readJson<{ runtimeContentSha256?: string }>(path.join(staging, 'manifest.json'));
            if (inner?.runtimeContentSha256 !== manifest.runtimeContentSha256) throw new Error('Backup runtime manifests disagree.');
            let runtime = this.runtimes.list().find(value => value.contentSha256 === manifest.runtimeContentSha256);
            if (!runtime) {
              const program = path.join(staging, 'runtime', 'program');
              const seal = await inventoryTree(program, op.signal);
              if (seal.contentSha256 !== manifest.runtimeContentSha256) throw new Error('Backup runtime differs from its pinned digest.');
              runtime = await this.runtimes.import(program, 'directory', 'instance-backup', op);
            }
            if (runtime.version !== manifest.runtimeVersion || runtime.platform !== manifest.platform) throw new Error('Backup runtime metadata does not match its content.');
            await this.runtimes.verify(runtime.id, op.signal);
            await this.instances.restoreFrom(staging, request.name, op);
          } finally { await removeManaged(this.rootPath, staging); }
        }) };
      }
      default: return this.instances.handle(request);
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.cabin.close();
    clearTimeout(this.companionCapabilityTimer);
    for (const watchers of this.companionCapabilityWatchers.values()) for (const watcher of watchers) watcher.close();
    this.companionCapabilityWatchers.clear();
    clearTimeout(this.prewarmTimer); this.prewarmRevision++;
    clearTimeout(this.capabilityChangeTimer); for (const watcher of this.capabilityWatchers.splice(0)) watcher.close();
    await this.initialization.catch(() => undefined);
    await this.cliTerminal.shutdown();
    await this.operations.shutdown();
    await this.instances.shutdown();
    await this.runtimes.close();
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
}
