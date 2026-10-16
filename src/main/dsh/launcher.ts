import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { path7za } from '7zip-bin';
import { DSH_LAUNCHER_CHANNEL, DSH_LAUNCHER_CHANGED_CHANNEL, DSH_TERMINAL_OUTPUT_CHANNEL, DSH_TASK_EVENT_CHANNEL, dshLauncherRequestSchema, dshPackPublicationRecordSchema, type DshLauncherRequest, type DshLauncherResponse, type DshLauncherState, type DshInstance } from '../../shared/dsh-launcher';
import { atomicJson, copyTree, inventoryTree, readJson, redact, removeManaged } from './files';
import { OperationStore } from './operations';
import { RuntimeService } from './runtime-service';
import { LauncherNetwork } from './launcher-network';
import { OfficialVersionCatalogue } from './official-versions';
import { resolvePortableTools, type PortableToolchain } from '../portable-tools';
import { MarketplaceService } from './marketplace';
import { SkillInstaller } from './skill-installer';
import { PackDistributionService } from './pack-distribution';
import { resolveDshWorkbenchIcon } from './workbench-icon';
import { InstanceService } from './instance-service';
import { SharedInstanceData } from './shared-instance-data';
import { DshCliTerminal } from './cli-terminal';
import { PackService } from './packs';
import { extractSealedArchive, writeSealedArchive } from './archive';
import { isolatedWorkspacePath } from './isolated-routing';
import { PluginControls } from './plugin-controls';
import { DshTaskBroker } from './task-broker';
import { DshTaskAccessStore } from './task-access';
import { snapshotDshTaskExecution, type DshTaskExecutionOptions } from './task-execution';
import { runtimeReferences } from '../../shared/dsh-runtime-references';
import { configureWorkbenchBrowser } from './workbench-browser';
import { assertKnownRuntimeCompatibility } from './runtime-compatibility';

export class DshLauncher {
  private ready = false;
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly openingWindows = new Map<string, Promise<void>>();
  private readonly operations: OperationStore;
  private readonly runtimes: RuntimeService;
  private readonly instances: InstanceService;
  private readonly packs: PackService;
  private readonly sharedData: SharedInstanceData;
  private readonly cliTerminal: DshCliTerminal;
  private readonly network: LauncherNetwork;
  private readonly versions: OfficialVersionCatalogue;
  private readonly marketplace: MarketplaceService;
  private readonly skills: SkillInstaller;
  private readonly plugins: PluginControls;
  private readonly tasks: DshTaskBroker;
  private readonly taskAccess: DshTaskAccessStore;
  private readonly distributions: PackDistributionService;
  private publications: NonNullable<DshLauncherState['packPublications']> = [];
  private tools?: Promise<PortableToolchain>;
  private selectionEpoch = 0;
  private readonly launchSelectionEpochs = new Map<string, number>();
  private readonly rootPath: string;
  private readonly initialization: Promise<void>;
  private closed = false;
  private previousThrottling: boolean | undefined;
  constructor(private readonly getMainWindow: () => BrowserWindow | null | undefined, reportInitializationError?: (error: unknown) => void) {
    this.rootPath = path.join(app.getPath('userData'), 'dsh-launcher');
    this.taskAccess = new DshTaskAccessStore(this.rootPath);
    const onChanged = () => {
      if (!this.ready || this.closed) return;
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
    this.network = new LauncherNetwork(this.rootPath, onChanged);
    this.versions = new OfficialVersionCatalogue({ rootPath: this.rootPath, json: (url, signal) => this.network.json(url, signal), onChanged });
    this.marketplace = new MarketplaceService({ rootPath: this.rootPath, network: this.network, onChanged });
    this.skills = new SkillInstaller({ rootPath: this.rootPath, network: this.network });
    this.plugins = new PluginControls({ rootPath: this.rootPath, runtimeDirectory: id => this.runtimes.directory(id) });
    this.runtimes = new RuntimeService({ rootPath: this.rootPath, sevenZipPath: path7za.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'), onChanged, fetch: this.network.fetch,
      nodeTools: () => this.toolchain(), nodeInstallNetwork: signal => this.network.nodeInstallNetwork(signal) });
    this.sharedData = new SharedInstanceData({ rootPath: this.rootPath, plan: id => this.runtimes.plan(id),
      assertCompatible: id => this.runtimes.assertSharedCompatible(id),
      onIssue: (id, message) => { if (/^[a-z0-9-]{1,80}$/.test(id)) void appendFile(path.join(this.rootPath, 'instances', id, 'logs', 'host.log'), `${message}\n`).catch(() => undefined); },
    });
    this.instances = new InstanceService({ rootPath: this.rootPath, runtimes: this.runtimes, operations: this.operations, onChanged,
      sharedData: this.sharedData,
      networkEnvironment: env => this.network.environment(env),
      onSelectedWebInstance: async selection => {
        if (this.launchSelectionEpochs.get(selection.instance.id) !== this.selectionEpoch) return false;
        await this.cliTerminal.selectContext(selection); return true;
      },
      isCliInUse: id => (this.cliTerminal.state().terminals ?? []).some(terminal => terminal.status === 'running' && (!id || terminal.instanceId === id)),
      openWorkbench: (instance, url) => this.openWorkbench(instance, url),
      closeWorkbench: async id => { const window = this.windows.get(id); if (window && !window.isDestroyed()) window.destroy(); this.windows.delete(id); },
      clearBrowserData: async id => { await session.fromPartition(`persist:dsh-instance-${id}`).clearStorageData(); },
    });
    this.packs = new PackService({ rootPath: this.rootPath, runtimes: this.runtimes, instances: this.instances, operations: this.operations, onChanged,
      ensureRuntime: (lock, file, op) => this.runtimes.installNodeFromLock(lock, file, op) });
    this.distributions = new PackDistributionService({ rootPath: this.rootPath, network: this.network,
      exportArchive: (id, file, signal) => this.packs.exportArchive(id, file, signal),
      importArchive: (file, op) => this.packs.importArchive(file, op), request: (url, input) => this.network.request(url, input) });
    this.cliTerminal = new DshCliTerminal({ rootPath: this.rootPath, onChanged, toolchain: () => this.toolchain(),
      verifyRuntime: async (id, digest) => { if (this.runtimes.get(id).contentSha256 !== digest) throw new Error('CLI runtime identity changed.'); await this.runtimes.verify(id); },
      onOutput: output => { const main = getMainWindow(); if (main && !main.isDestroyed()) main.webContents.send(DSH_TERMINAL_OUTPUT_CHANNEL, output); }, resolveSelection: async () => {
      const records = this.instances.list();
      const current = records.find(value => value.id === this.cliTerminal.state().selectedInstanceId) ?? records.find(value => value.isDefault);
      if (!current) throw new Error('Create and select a DSH instance before opening its CLI terminal.');
      return this.instances.prepareCli(current.id);
    } });
    this.tasks = new DshTaskBroker({ rootPath: this.rootPath, onChanged, pin: selection => this.cliTerminal.pinContext(selection),
      getSelection: async (id, signal, resume, preparation) => {
        const selected = id ?? this.cliTerminal.state().selectedInstanceId ?? this.instances.list().find(value => value.isDefault)?.id;
        if (!selected) throw new Error('Create and select a DSH execution instance first.');
        if (preparation?.requiresCompanionRuntime) assertKnownRuntimeCompatibility(this.runtimes.get(resume?.runtimeId ?? this.instances.get(selected).runtimeId));
        return this.instances.prepareCli(selected, signal, resume?.runtimeId, preparation?.progress);
      }, onEvent: event => { const main = getMainWindow(); if (main && !main.isDestroyed()) main.webContents.send(DSH_TASK_EVENT_CHANNEL, event); } });
    this.initialization = this.init();
    // Surface startup failures through state requests without an unhandled rejection.
    void this.initialization.catch(error => { try { reportInitializationError?.(error); } catch { /* Preserve domain isolation even if diagnostics cannot be written. */ } });
  }
  private toolchain(): Promise<PortableToolchain> { return this.tools ??= resolvePortableTools(); }
  private async init(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    await this.network.init(); await this.versions.init(); await this.marketplace.init();
    await this.operations.init(); await this.runtimes.init(); await this.sharedData.init(); await this.instances.init(); await this.packs.init(); await this.cliTerminal.init();
    await this.tasks.init(); await this.taskAccess.load();
    const publications = await readJson<unknown[]>(path.join(this.rootPath, 'pack-publications.json')) ?? [];
    this.publications = publications.slice(0, 100).map(value => dshPackPublicationRecordSchema.parse(value));
    this.ready = true;
    const selectedId = this.cliTerminal.state().selectedInstanceId ?? this.instances.list().find(instance => instance.isDefault)?.id;
    const selectedRuntime = this.instances.list().find(instance => instance.id === selectedId)?.runtimeId;
    const unchecked = this.runtimes.unchecked().sort((a, b) => Number(b.id === selectedRuntime) - Number(a.id === selectedRuntime));
    // Existing installations acquire real evidence too; no release-name exemption.
    for (const runtime of unchecked) {
      await this.operations.run('runtime.compatibility', `隔离检测 DSH ${runtime.version} 共享存档`, undefined,
        async op => { await this.runtimes.checkCompatibility(runtime.id, op); });
    }
    if (selectedRuntime && !unchecked.some(runtime => runtime.id === selectedRuntime)) {
      await this.operations.run('runtime.verify', '预先校验当前 DSH 的 CLI 运行文件', selectedId,
        async op => { await this.runtimes.verify(selectedRuntime, op.signal); });
    }
  }
  state(): DshLauncherState {
    return { supported: process.platform === 'win32' && process.arch === 'x64', rootPath: this.rootPath,
      runtimes: this.runtimes.list(), instances: this.instances.list(), snapshots: this.instances.snapshots(),
      packs: this.packs.list(), operations: this.operations.list(), sharedData: this.sharedData.state(), cli: this.cliTerminal.state(),
      network: this.network.state(), versions: this.versions.state(), marketplace: this.marketplace.state(), packPublications: structuredClone(this.publications), tasks: this.tasks.state(), taskAccess: this.taskAccess.state() };
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
  private async pick(kind: 'directory' | 'installer' | 'archive'): Promise<string | undefined> {
    const parent = this.getMainWindow(); if (!parent) throw new Error('Main window unavailable.');
    const testing = process.env.WORLDLINEBOX_E2E === '1' ? process.env[`WORLDLINEBOX_E2E_DSH_${kind.toUpperCase()}`] : undefined;
    if (testing) return path.resolve(testing);
    const result = await dialog.showOpenDialog(parent, { title: kind === 'directory' ? '导入 DSH 安装目录' : kind === 'installer' ? '导入 DSH 官方安装包' : '导入 DSH 备份或整合包',
      properties: kind === 'directory' ? ['openDirectory'] : ['openFile'],
      filters: kind === 'installer' ? [{ name: 'DSH installer', extensions: ['exe'] }] : kind === 'archive' ? [{ name: 'DSH package', extensions: ['dshpack', 'dshbackup'] }] : undefined });
    return result.canceled ? undefined : result.filePaths[0];
  }
  private async saveArchive(extension: 'dshpack' | 'dshbackup'): Promise<string | undefined> {
    const parent = this.getMainWindow(); if (!parent) throw new Error('Main window unavailable.');
    const testing = process.env.WORLDLINEBOX_E2E === '1' ? process.env[`WORLDLINEBOX_E2E_DSH_SAVE_${extension.toUpperCase()}`] : undefined;
    if (testing) return path.resolve(testing);
    const result = await dialog.showSaveDialog(parent, { title: '导出 DSH', defaultPath: `DSH.${extension}`, filters: [{ name: 'DSH package', extensions: [extension] }] });
    return result.canceled ? undefined : result.filePath;
  }
  /** The companion service uses the same pinned task route as the validated launcher IPC. */
  async requestTask(request: Extract<DshLauncherRequest, { type: 'task.run' | 'task.cancel' | 'task.terminate' | 'task.result' | 'task.events' | 'task.message' }>, executionValue?: DshTaskExecutionOptions): Promise<DshLauncherResponse> {
    if (executionValue && request.type !== 'task.run') throw new Error('Transient execution options can only be used to run a task.');
    const execution = snapshotDshTaskExecution(executionValue);
    await this.initialization;
    if (this.closed) throw new Error('DSH 启动器正在关闭。');
    if (execution?.toolkit && !execution.access) execution.access = this.taskAccess.state();
    return this.handle(request, execution);
  }
  private async handle(request: DshLauncherRequest, execution?: DshTaskExecutionOptions): Promise<DshLauncherResponse> {
    if (request.type === 'state') return { ok: true, state: this.state() };
    if (this.operations.list().some(operation => operation.status === 'running' && ['runtime.delete', 'runtime.cleanup'].includes(operation.kind)) && !['operation.cancel', 'task.events', 'task.result', 'task.cancel', 'task.terminate'].includes(request.type)) throw new Error('正在清理运行版本，请等待操作完成。');
    if (!this.state().supported) throw new Error('DSH runtime management currently supports Windows x64.');
    switch (request.type) {
      case 'task.access.save': await this.taskAccess.save(request.mode); return { ok: true, state: this.state() };
      case 'operation.cancel': this.operations.cancel(request.operationId); return { ok: true };
      case 'operation.clear-finished': return { ok: true, removedOperations: await this.operations.clearFinished(), state: this.state() };
      case 'task.run': {
        const instanceId = request.instanceId ?? this.cliTerminal.state().selectedInstanceId ?? this.instances.list().find(value => value.isDefault)?.id;
        if (!instanceId) throw new Error('Create and select a DSH execution instance first.');
        return { ok: true, operationId: await this.operations.run(request.type, redact(request.title ?? 'DSH 执行任务'), instanceId, async op => {
          await this.tasks.execute({ prompt: request.prompt, instanceId, sessionId: request.sessionId, title: request.title,
            timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes }, op, execution);
        }) };
      }
      case 'task.cancel': this.tasks.cancel(request.taskId); this.operations.cancel(request.taskId); return { ok: true };
      case 'task.terminate': {
        if (this.operations.list().some(operation => operation.id === request.taskId && ['queued', 'running', 'paused'].includes(operation.status))) this.operations.cancel(request.taskId);
        await this.tasks.terminate(request.taskId); return { ok: true };
      }
      case 'task.result': return { ok: true, taskResult: this.tasks.result(request.taskId) };
      case 'task.events': return { ok: true, taskEvents: this.tasks.events(request.taskId, request.after) };
      case 'task.message': await this.tasks.sendInput(request.taskId, request.content, request.mode, request.messageId); return { ok: true };
      case 'cli.select': case 'instance.default': {
        const epoch = ++this.selectionEpoch; const selection = await this.instances.prepareCli(request.instanceId);
        if (epoch !== this.selectionEpoch) return { ok: true, cancelled: true, state: this.state() };
        await this.cliTerminal.selectContext(selection);
        const result = await this.instances.handle({ type: 'instance.default', instanceId: request.instanceId });
        return result.ok ? { ok: true, state: this.state() } : result;
      }
      case 'instance.start': case 'instance.switch-start': {
        this.launchSelectionEpochs.set(request.instanceId, ++this.selectionEpoch);
        return this.instances.handle(request);
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
      case 'network.save': await this.network.save(request.settings); return { ok: true, state: this.state() };
      case 'network.test': return { ok: true, text: await this.network.test() };
      case 'versions.refresh': return { ok: true, operationId: await this.operations.run(request.type, '同步官方 DSH 发行版', undefined, op => this.versions.refresh(op.signal)) };
      case 'runtime.install': return { ok: true, operationId: await this.operations.run(request.type, `安装 DSH ${request.version} WebUI`, undefined, async op => { await this.runtimes.installNode(await this.versions.release(request.version, op.signal), op); }, request) };
      case 'market.search': return { ok: true, marketPage: await this.marketplace.search(request) };
      case 'market.plugin.install': {
        const spec = await this.marketplace.pluginInstallSpec(request.entryId);
        return this.instances.handle({ type: 'instance.plugin', instanceId: request.instanceId, action: 'add', spec });
      }
      case 'skill.inspect': return { ok: true, skillInspection: await this.skills.inspectSkill(request.repository, request.revision) };
      case 'instance.plugins': return { ok: true, installedPlugins: await this.plugins.listPlugins(this.instances.get(request.instanceId)) };
      case 'instance.plugin-toggle': return { ok: true, operationId: await this.operations.run(request.type, '启用或停用实例插件', request.instanceId, op =>
        this.instances.withStoppedInstance(request.instanceId, () => this.plugins.setPluginEnabled(this.instances.get(request.instanceId), request.name, request.enabled, op.signal))) };
      case 'skill.list': {
        const instance = this.instances.list().find(value => value.id === request.instanceId); if (!instance) throw new Error('Instance unavailable.');
        return { ok: true, installedSkills: await this.skills.listSkills(instance) };
      }
      case 'skill.install': case 'skill.toggle': case 'skill.remove': return { ok: true, operationId: await this.operations.run(request.type, '管理实例技能', request.instanceId, async op => {
        await this.instances.withStoppedInstance(request.instanceId, async () => {
          const instance = this.instances.list().find(value => value.id === request.instanceId)!;
          if (request.type === 'skill.install') await this.skills.installSkill(instance, request.target, op);
          else if (request.type === 'skill.toggle') await this.skills.setSkillEnabled(instance, request.name, request.enabled);
          else await this.skills.removeSkill(instance, request.name);
        });
      }) };
      case 'runtime.download': return { ok: true, operationId: await this.operations.run(request.type, '下载官方 DSH 运行版本', undefined, async op => { await this.runtimes.download(op, request.expectedSha256); }, request) };
      case 'runtime.import': {
        const source = await this.pick(request.sourceKind); if (!source) return { ok: true, cancelled: true };
        return { ok: true, operationId: await this.operations.run(request.type, '导入 DSH 运行版本', undefined, async op => { await this.runtimes.import(source, request.sourceKind, 'local-import', op); }) };
      }
      case 'runtime.verify': return { ok: true, operationId: await this.operations.run(request.type, '校验 DSH 运行版本', undefined, async op => { await op.update('verifying'); await this.runtimes.verify(request.runtimeId, op.signal, true); }) };
      case 'runtime.compatibility': return { ok: true, operationId: await this.operations.run(request.type, '隔离检测共享存档兼容性', undefined, async op => {
        const report = await this.runtimes.checkCompatibility(request.runtimeId, op);
        if (report.status !== 'passed') throw new Error(`兼容性检测未通过：${report.checks.find(check => check.status === 'failed')?.detail ?? '检测被中断，请重试。'}`);
      }) };
      case 'runtime.cleanup': {
        if (this.operations.list().some(operation => operation.status === 'running')) throw new Error('请等待当前下载、检测和任务结束后再清理缓存。');
        return { ok: true, operationId: await this.operations.run(request.type, '清理 DSH 下载缓存和残留文件', undefined, op => this.runtimes.cleanup(op)) };
      }
      case 'runtime.delete': {
        if (this.operations.list().some(operation => operation.status === 'running')) throw new Error('Wait for running launcher operations before deleting a runtime.');
        const used = runtimeReferences(this.state(), request.runtimeId).length > 0;
        if (used) throw new Error('此运行版本仍被实例、快照或整合包引用，请先处理页面列出的引用。');
        return { ok: true, operationId: await this.operations.run(request.type, '删除 DSH 运行版本并清理文件', undefined, () => this.runtimes.delete(request.runtimeId, false)) };
      }
      case 'instance.folder': {
        const root = this.instances.getRoot(request.instanceId);
        const directory = request.scope === 'workspace' ? this.instances.get(request.instanceId).dataScope === 'isolated' ? isolatedWorkspacePath(root) : this.sharedData.paths.workspacePath : request.scope === 'root' ? root : path.join(root, request.scope);
        const error = await shell.openPath(directory); if (error) throw new Error(error);
        return { ok: true };
      }
      case 'shared.folder': {
        const directory = request.scope === 'root' ? this.sharedData.paths.rootPath : request.scope === 'sessions' ? this.sharedData.paths.sessionsPath : this.sharedData.paths.workspacePath;
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
            await writeSealedArchive(staging, temporary, { kind: 'worldlinebox-dshbackup-v1', runtimeContentSha256: runtime.contentSha256, runtimeVersion: runtime.version, platform: runtime.platform }, op.signal);
            op.signal.throwIfAborted(); await rename(temporary, target);
          } finally { await removeManaged(this.rootPath, staging); }
        }) };
      }
      case 'backup.import': {
        const source = await this.pick('archive'); if (!source) return { ok: true, cancelled: true };
        return { ok: true, operationId: await this.operations.run(request.type, '从完整备份创建新实例', undefined, async op => {
          const staging = path.join(this.rootPath, 'staging', randomUUID());
          try {
            const manifest = await extractSealedArchive(source, staging, op.signal);
            if (manifest.kind !== 'worldlinebox-dshbackup-v1') throw new Error('This is not a WorldlineBox DSH instance backup.');
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
    await this.initialization.catch(() => undefined);
    await this.tasks.shutdown();
    await this.cliTerminal.shutdown();
    await this.operations.shutdown();
    await this.instances.shutdown();
    this.runtimes.close();
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
}
