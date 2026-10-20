import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import sharp from 'sharp';
import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, nativeImage, powerMonitor, screen, session, shell,
  type DesktopCapturerSource, type IpcMainInvokeEvent, type Session } from 'electron';
import { CAPTURE_TOOLS_ARGUMENT, CAPTURE_TOOLS_CHANGED, CAPTURE_TOOLS_REQUEST, CAPTURE_TOOLS_STOP_RECORDING,
  DEFAULT_CAPTURE_TOOLS_SETTINGS, captureToolsRequestSchema, captureToolsSettingsSchema, type CaptureDesktopSource,
  type CaptureImageSource, type CaptureToolsRequest, type CaptureToolsResponse, type CaptureToolsSettings,
  type CaptureRecordingControls, type CaptureScreenRect, type CaptureToolsState, type CaptureToolTask } from '../../shared/capture-tools';
import type { CompanionModelConfig } from '../companions/model';
import { atomicJson, readJson } from '../dsh/files';
import { safeCaptureFilename } from '../browser/capture-download';
import { answerCaptureImage, getCaptureAiState } from './visual-answer';
import { RecordingStore } from './recording-store';
import { CAPTURE_RECORDING_SCHEME, RecordingPreview } from './recording-preview';
import { LongCaptureStitcher } from './long-capture';
import { boundedSelectionText, readFocusedSelectedText } from './selected-text';
import { answerSelectedText } from './text-answer';
import { CAPTURE_TOOLS_ANSWER_PROGRESS, captureAnswerProgressSchema, type CaptureAnswerUpdate } from '../../shared/capture-answer';
import { createCaptureDesktopContext, nativeCaptureRectToDisplayDip, placeCaptureRecordingControls, positionCaptureWindowInPhysicalPixels, readWindowsCaptureMonitor, readWindowsDesktopRegions, recordingBoundaryPage, recordingBoundaryRectangles } from './desktop-regions';

export interface CaptureToolsServiceOptions {
  getMainWindow(): BrowserWindow | null | undefined;
  preloadPath: string;
  loadWindow(window: BrowserWindow): Promise<void>;
  getModelConfig(): CompanionModelConfig;
  saveToLibrary(bytes: Uint8Array, filename: string): Promise<void>;
  getFfmpeg(): string | undefined | Promise<string | undefined>;
  readBrowserSelection?(): Promise<string>;
  /** Main checks custom application bindings before a global hotkey is saved. */
  validateShortcuts?(settings: CaptureToolsSettings): void;
  onStateChanged?(state: CaptureToolsState): void;
  root?: string;
  downloadPath?: string;
}
const TASKS: CaptureToolTask[] = ['screenshot', 'recording', 'ocr', 'translate', 'long-screenshot', 'selection'];
const IMAGE_BYTES = 32 * 1024 * 1024;
const mainActions = new Set(['state', 'settings.save', 'shortcuts.capture', 'open']);
const flushActions = new Set(['state', 'recording.chunk', 'recording.finish', 'recording.cancel', 'recording.stop']);
type CaptureProvider = () => Promise<CaptureImageSource>;
export function canonicalCaptureShortcut(value: string): string {
  if (!value.trim()) return '';
  const tokens = value.split('+').map(token => token.trim().toLowerCase().replace(/\s+/g, ''));
  const modifier = (token: string) => ({ ctrl: 'control', cmd: 'command', cmdorctrl: process.platform === 'darwin' ? 'command' : 'control',
    commandorcontrol: process.platform === 'darwin' ? 'command' : 'control', option: 'alt', super: process.platform === 'darwin' ? 'command' : 'meta' } as Record<string, string>)[token] ?? token;
  const modifiers = tokens.slice(0, -1).map(modifier);
  if (!tokens.at(-1) || !modifiers.length || modifiers.some(token => !['control', 'command', 'alt', 'shift', 'meta'].includes(token))
    || !modifiers.some(token => ['control', 'command', 'alt', 'meta'].includes(token)) || new Set(modifiers).size !== modifiers.length) throw Error('快捷键需包含 Ctrl、Alt 或 Command 等修饰键与一个按键，不能使用单独按键。');
  return [...modifiers.sort(), tokens.at(-1)!].join('+');
}

/** An isolated, ephemeral utility. Web pages never receive desktop or model APIs. */
export class CaptureToolsService {
  private settings: CaptureToolsSettings = structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS);
  private shortcuts: CaptureToolsState['shortcuts'] = [];
  private registered = new Set<string>();
  private settingsWarning?: string;
  private task: CaptureToolTask = 'screenshot';
  private tool?: BrowserWindow;
  private surfaceReady?: { window: BrowserWindow; resolve(): void; reject(error: Error): void };
  private scope?: Session;
  private image?: CaptureImageSource;
  private selectedText = '';
  private selectionPinned = false;
  private shortcutCaptureWindow?: BrowserWindow;
  private readonly endShortcutCapture = () => this.captureShortcuts(false);
  private readonly shortcutCaptureNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (details.isMainFrame && !details.isSameDocument) this.captureShortcuts(false);
  };
  private sourceId?: string;
  private provider?: CaptureProvider;
  private long?: LongCaptureStitcher;
  private longProvider?: CaptureProvider;
  private busyLong = false;
  private longGeneration = 0;
  private opening?: Promise<CaptureToolsResponse>;
  private captureBusy = false;
  private closed = false;
  private stopping = false;
  private shuttingDown?: Promise<void>;
  private initialized?: Promise<void>;
  private ipcRegistered = false;
  private revision = 0;
  private hidden = new Set<BrowserWindow>();
  private knownFiles = new Set<string>();
  private readonly recordingPreview = new RecordingPreview();
  private recordingResultId?: string;
  private asks = new Map<string, AbortController>();
  private terminalListeners = new Set<() => void>();
  private recordingGrant?: { source: DesktopCapturerSource; id: string; systemAudio: boolean; microphone: boolean; videoUsed: boolean; desktopPreflightUsed: boolean; microphoneUsed: boolean };
  private recordingControls?: CaptureRecordingControls;
  private recordingBoundaries = new Set<BrowserWindow>();
  private recordingBoundaryGeneration = 0;
  private readonly onSuspend = () => {
    const recording = this.recordings.state(); if (!recording || !['recording', 'paused'].includes(recording.status)) return;
    this.stopRecording(); const timer = setTimeout(() => {
      if (this.recordings.state()?.id === recording.id && ['recording', 'paused'].includes(this.recordings.state()?.status ?? '')) void this.recordings.finish(recording.id).catch(() => undefined);
    }, 5000); timer.unref();
  };
  private readonly root: string;
  private readonly downloadPath: string;
  private readonly recordings: RecordingStore;
  constructor(private readonly options: CaptureToolsServiceOptions) {
    this.root = options.root ?? path.join(app.getPath('userData'), 'capture-tools');
    this.downloadPath = path.resolve(options.downloadPath ?? app.getPath('downloads'));
    this.recordings = new RecordingStore({ downloadPath: this.downloadPath, getFfmpeg: options.getFfmpeg,
      changed: state => {
        if (state.path) this.rememberFile(state.path);
        if (['saved', 'failed', 'cancelled'].includes(state.status)) { this.recordingGrant = undefined; this.recordingControls = undefined; this.clearRecordingBoundaries(); this.restoreApp(); this.resizeTool(false, true); for (const listener of this.terminalListeners) listener(); }
        this.changed();
      }, onLimit: () => this.stopRecording() });
  }
  init(): Promise<void> {
    return this.initialized ??= (async () => {
      try { const stored = await readJson<unknown>(path.join(this.root, 'settings.json'));
        if (stored !== undefined) {
          this.settings = captureToolsSettingsSchema.parse(stored);
          if (stored && typeof stored === 'object' && 'shortcuts' in stored && stored.shortcuts && typeof stored.shortcuts === 'object' && !('selection' in stored.shortcuts)) {
            await atomicJson(path.join(this.root, 'settings.json'), this.settings);
          }
        }
      }
      catch { this.settingsWarning = '截图设置读取失败，已使用默认值；重新保存设置可修复。'; }
      if (!this.closed && !this.stopping) { this.registerShortcuts(); powerMonitor.on('suspend', this.onSuspend); }
    })();
  }
  state(): CaptureToolsState {
    let ai: CaptureToolsState['ai'];
    try { ai = getCaptureAiState(this.options.getModelConfig()); }
    catch { ai = { configured: false, model: '', visionSupported: null, reason: '无法读取全局模型配置，请在设置中重新保存。' }; }
    return { settings: structuredClone(this.settings), downloadPath: this.downloadPath, task: this.task,
      shortcuts: structuredClone(this.shortcuts), ai, recording: this.recordings.state(), selectionPinned: this.selectionPinned, revision: this.revision };
  }
  configurationChanged(): void { if (!this.closed) this.changed(); }
  private changed(): void {
    this.revision++; const state = this.state();
    try { this.options.onStateChanged?.(state); }
    catch { console.warn('[WorldlineBox capture] Status observer failed.'); }
    for (const window of [this.options.getMainWindow(), this.tool]) if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      try { window.webContents.send(CAPTURE_TOOLS_CHANGED, state); } catch { /* A closing renderer does not invalidate a saved capture. */ }
    }
  }
  private registerShortcuts(): void {
    for (const accelerator of this.registered) globalShortcut.unregister(accelerator); this.registered.clear();
    if (this.shortcutCaptureWindow || this.closed || this.stopping) return;
    this.shortcuts = TASKS.map(task => {
      const accelerator = this.settings.shortcuts[task].trim();
      if (!accelerator) return { task, accelerator, registered: false };
      let registered = false;
      try { canonicalCaptureShortcut(accelerator); registered = globalShortcut.register(accelerator, () => {
        if (task === 'recording' && ['recording', 'paused'].includes(this.recordings.state()?.status ?? '')) this.stopRecording();
        else void this.open(task).catch(() => undefined);
      }); } catch { /* Electron rejects malformed accelerators without crashing Main. */ }
      if (registered) this.registered.add(accelerator);
      return { task, accelerator, registered, ...(!registered ? { error: '快捷键不可用或已被其他程序占用，请修改后重试。' }
        : task === 'screenshot' && this.settingsWarning ? { error: this.settingsWarning } : {}) };
    });
  }
  private captureShortcuts(active: boolean): void {
    if (active) {
      if (['recording', 'paused', 'finalizing'].includes(this.recordings.state()?.status ?? '')) throw Error('请先结束录屏，再修改全局快捷键。');
      const main = this.options.getMainWindow(); if (!main || main.isDestroyed() || main.webContents.isDestroyed()) throw Error('设置窗口已关闭。');
      if (!main.isFocused()) throw Error('请先切回主窗口，再录入快捷键。');
      if (this.shortcutCaptureWindow) return;
      this.shortcutCaptureWindow = main;
      main.once('blur', this.endShortcutCapture); main.once('closed', this.endShortcutCapture);
      main.webContents.once('render-process-gone', this.endShortcutCapture); main.webContents.once('destroyed', this.endShortcutCapture);
      main.webContents.on('did-start-navigation', this.shortcutCaptureNavigation);
      for (const accelerator of this.registered) globalShortcut.unregister(accelerator); this.registered.clear();
    } else {
      const main = this.shortcutCaptureWindow; if (!main) return;
      this.shortcutCaptureWindow = undefined; main.removeListener('blur', this.endShortcutCapture); main.removeListener('closed', this.endShortcutCapture);
      main.webContents.removeListener('render-process-gone', this.endShortcutCapture); main.webContents.removeListener('destroyed', this.endShortcutCapture);
      main.webContents.removeListener('did-start-navigation', this.shortcutCaptureNavigation);
      this.registerShortcuts(); this.changed();
    }
  }
  private async saveSettings(value: CaptureToolsSettings): Promise<void> {
    const settings = captureToolsSettingsSchema.parse(value);
    const keys = TASKS.map(task => canonicalCaptureShortcut(settings.shortcuts[task])).filter(Boolean);
    if (new Set(keys).size !== keys.length) throw Error('不同工具不能使用相同的快捷键。');
    this.options.validateShortcuts?.(settings);
    await atomicJson(path.join(this.root, 'settings.json'), settings);
    this.settings = settings; this.settingsWarning = undefined; this.registerShortcuts(); this.changed();
  }
  private hideApp(exceptSourceId?: string): void {
    if (!this.settings.hideApp) return;
    for (const window of BrowserWindow.getAllWindows()) if (window !== this.tool && !this.recordingBoundaries.has(window) && !window.isDestroyed() && window.isVisible() && window.getMediaSourceId() !== exceptSourceId) { this.hidden.add(window); window.hide(); }
  }
  private restoreApp(): void {
    for (const window of this.hidden) if (!window.isDestroyed()) window.showInactive(); this.hidden.clear();
  }
  private resizeTool(compact: boolean, result = false): void {
    const tool = this.tool; if (!tool || tool.isDestroyed()) return;
    if (compact && this.recordingControls) return;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    tool.setAlwaysOnTop(true, 'floating'); tool.setResizable(!compact); tool.setMovable(true);
    tool.setMinimumSize(Math.min(compact ? 420 : result ? 640 : 760, area.width), Math.min(compact ? 210 : result ? 420 : 560, area.height));
    const width = Math.min(compact ? 460 : result ? 1040 : 1160, area.width), height = Math.min(compact ? 250 : result ? 740 : 780, area.height);
    tool.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height });
    tool.showInactive();
  }
  private fitToolToDesktop(): void {
    const tool = this.tool, desktop = this.image?.desktop;
    if (!tool || tool.isDestroyed() || !desktop) return;
    // setFullScreen/maximize can exclude the taskbar or move to another monitor.
    // A plain frameless window fills the captured display's exact DIP bounds.
    // A non-resizable HWND reports its cached rounded size as WM_GETMINMAXINFO
    // limits and clamps exact physical SetWindowPos calls by one pixel at 150%.
    // thickFrame:false keeps native resize borders absent for this overlay.
    tool.setMinimumSize(1, 1); tool.setResizable(true); tool.setMovable(false); tool.setBounds(desktop.bounds);
    tool.setAlwaysOnTop(true, 'screen-saver');
    if (desktop.pixelBounds) positionCaptureWindowInPhysicalPixels(tool.getNativeWindowHandle(), desktop.pixelBounds);
  }
  private fitToolToImage(): void {
    const tool = this.tool, image = this.image;
    if (!tool || tool.isDestroyed() || !image) return;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const scale = Math.min(Math.max(1, area.width - 48) / image.width, Math.max(1, area.height - 48) / image.height);
    const width = Math.max(Math.min(360, area.width), Math.round(image.width * scale));
    const height = Math.max(Math.min(240, area.height), Math.round(image.height * scale));
    tool.setMinimumSize(1, 1); tool.setResizable(true); tool.setMovable(true); tool.setAlwaysOnTop(true, 'floating');
    tool.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height }); tool.showInactive();
  }
  private clearRecordingBoundaries(): void {
    this.recordingBoundaryGeneration++;
    const windows = [...this.recordingBoundaries]; this.recordingBoundaries.clear();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
  }
  private async showRecordingBoundaries(capturePixels: CaptureScreenRect, display: Electron.Display, physicalDisplay: CaptureScreenRect, id: string): Promise<void> {
    this.clearRecordingBoundaries();
    const rectangles = recordingBoundaryRectangles(capturePixels, 2, physicalDisplay);
    if (!rectangles.length) return;
    const generation = this.recordingBoundaryGeneration;
    let window: BrowserWindow | undefined;
    const current = () => generation === this.recordingBoundaryGeneration && !this.closed && !this.stopping
      && this.recordings.state()?.id === id && ['recording', 'paused'].includes(this.recordings.state()?.status ?? '');
    try {
      // A monitor-sized alpha surface avoids Chromium's native minimum size
      // for tiny HWNDs. Only the outside-crop canvas strokes are opaque.
      window = new BrowserWindow({ title: 'WorldlineBox · 录制范围', ...display.bounds, show: false,
        frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000',
        hasShadow: false, roundedCorners: false, resizable: true, movable: false, minWidth: 1, minHeight: 1,
        skipTaskbar: true, focusable: false, enableLargerThanScreen: true,
        webPreferences: { ...(this.scope ? { session: this.scope } : {}), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false } });
      this.recordingBoundaries.add(window);
      window.setContentProtection(false); window.setIgnoreMouseEvents(true); window.setAlwaysOnTop(true, 'screen-saver'); window.removeMenu();
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault()); window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.webContents.on('render-process-gone', () => { if (current()) this.stopRecording(); });
      const discard = () => { if (window) { this.recordingBoundaries.delete(window); if (!window.isDestroyed()) window.destroy(); } };
      const fit = () => { if (window && process.platform === 'win32' && !positionCaptureWindowInPhysicalPixels(window.getNativeWindowHandle(), physicalDisplay)) throw Error('Unable to position recording boundary.'); };
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(recordingBoundaryPage(physicalDisplay, rectangles.map(rect => rect.bounds))));
      if (!current() || window.isDestroyed()) { discard(); return; }
      fit(); window.showInactive(); fit(); window.moveTop();
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!current() || window.isDestroyed()) { discard(); return; }
      fit();
    } catch (error) {
      const active = current();
      if (window) { this.recordingBoundaries.delete(window); if (!window.isDestroyed()) window.destroy(); }
      // A load rejected because stop/cancel destroyed its window is expected.
      // It must neither resurrect this overlay nor clear a newer recording.
      if (active) throw error;
    }
  }
  private rememberFile(filename: string): void {
    this.knownFiles.add(path.resolve(filename)); if (this.knownFiles.size > 100) this.knownFiles.delete(this.knownFiles.values().next().value!);
  }
  private ownSender(event: IpcMainInvokeEvent, window: BrowserWindow | null | undefined): boolean {
    return !!window && !window.isDestroyed() && !window.webContents.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  }
  registerIpc(): void {
    if (this.ipcRegistered) return; this.ipcRegistered = true;
    ipcMain.handle(CAPTURE_TOOLS_REQUEST, (event, input: unknown) => this.handle(event, input));
  }
  async handle(event: IpcMainInvokeEvent, input: unknown): Promise<CaptureToolsResponse> {
    const own = this.ownSender(event, this.tool); const main = this.ownSender(event, this.options.getMainWindow());
    if (!own && !main) return { ok: false, error: '无权访问截图工具。' };
    const parsed = captureToolsRequestSchema.safeParse(input); if (!parsed.success) return { ok: false, error: '无效的截图工具请求。' };
    if (parsed.data.type === 'shortcuts.capture' && !main) return { ok: false, error: '请在主窗口设置中修改快捷键。' };
    const openDownloads = parsed.data.type === 'reveal' && path.resolve(parsed.data.path) === this.downloadPath;
    if (!own && !mainActions.has(parsed.data.type) && !openDownloads) return { ok: false, error: '请在独立截图工具窗口中执行此操作。' };
    try {
      await this.init();
      if (own && !this.ownSender(event, this.tool)) throw Error('问答窗口已关闭。');
      if (this.closed || this.stopping && !flushActions.has(parsed.data.type)) throw Error('截图工具正在关闭。');
      return await this.request(parsed.data);
    }
    catch (error) { return { ok: false, error: (error instanceof Error ? error.message : '截图操作失败。').slice(0, 2000) }; }
  }
  private async answer(request: Extract<CaptureToolsRequest, { type: 'screenshot.ask' | 'selection.ask' }>): Promise<CaptureToolsResponse> {
    if (this.asks.size) throw Error('请等待当前问答完成，或先取消。');
    const window = this.tool;
    if (!window || window.isDestroyed()) throw Error('问答窗口已关闭。');
    const controller = new AbortController(); this.asks.set(request.id, controller);
    let sequence = 0, latest: CaptureAnswerUpdate = { text: '', reasoning: '' }, sent: CaptureAnswerUpdate | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !controller.signal.aborted && this.asks.get(request.id) === controller && this.tool === window
      && !this.closed && !this.stopping && !window.isDestroyed() && !window.webContents.isDestroyed();
    const flush = () => {
      if (timer) clearTimeout(timer); timer = undefined;
      if (!current() || sent?.text === latest.text && sent?.reasoning === latest.reasoning) return;
      const parsed = captureAnswerProgressSchema.safeParse({ id: request.id, sequence: sequence + 1, ...latest });
      if (!parsed.success) return;
      try { window.webContents.send(CAPTURE_TOOLS_ANSWER_PROGRESS, parsed.data); sequence++; sent = latest; }
      catch { /* The receiving temporary window may have just closed. */ }
    };
    const onUpdate = (update: CaptureAnswerUpdate) => {
      if (!current() || !captureAnswerProgressSchema.safeParse({ id: request.id, sequence: sequence + 1, ...update }).success) return;
      latest = { text: update.text, reasoning: update.reasoning };
      if (!sequence) flush();
      else timer ??= setTimeout(flush, 40);
    };
    try {
      const common = { config: this.options.getModelConfig(), messages: request.messages, signal: controller.signal, onUpdate };
      const text = request.type === 'screenshot.ask' ? await answerCaptureImage({ ...common, dataUrl: request.dataUrl })
        : await answerSelectedText({ ...common, selection: request.selection });
      if (!current()) throw Error('问答已取消。');
      latest = { ...latest, text }; flush();
      return { ok: true, text, state: this.state() };
    } finally {
      if (timer) clearTimeout(timer);
      if (this.asks.get(request.id) === controller) this.asks.delete(request.id);
    }
  }
  private async request(request: CaptureToolsRequest): Promise<CaptureToolsResponse> {
    switch (request.type) {
      case 'state': return { ok: true, state: this.state() };
      case 'context': return { ok: true, state: this.state(), ...(this.image ? { source: this.image } : {}), ...(this.task === 'selection' ? { text: this.selectedText } : {}) };
      case 'surface.ready': this.surfaceReady?.resolve(); return { ok: true };
      case 'recording.controls.ready': {
        const tool = this.tool, recording = this.recordings.state();
        if (!tool || tool.isDestroyed() || recording?.id !== request.id || !['recording', 'paused'].includes(recording.status) || !this.recordingControls) throw Error('录屏控制条已失效。');
        if (!this.recordingControls.hidden) { tool.showInactive(); tool.moveTop(); }
        return { ok: true };
      }
      case 'settings.save': await this.saveSettings(request.settings); break;
      case 'shortcuts.capture': this.captureShortcuts(request.active); break;
      case 'open': {
        if (request.task === 'selection' && request.source === 'browser') {
          if (!this.options.readBrowserSelection) throw Error('浏览器划词暂不可用，请先打开网页。');
          return this.openSelection(await this.options.readBrowserSelection());
        }
        // Every capture entry, including older browser requests, uses the
        // actual desktop surface and its inline selection/editor.
        return this.open(request.task);
      }
      case 'close': await this.closeTool(); break;
      case 'sources.list': return { ok: true, sources: await this.sources(), state: this.state() };
      case 'screenshot.capture': {
        this.recordingResultId = undefined; this.recordingPreview.clear();
        this.provider = undefined; this.sourceId = request.sourceId ?? this.sourceId;
        this.image = await this.captureDesktop(this.sourceId);
        if (this.image.desktop) this.fitToolToDesktop(); else if (this.task !== 'recording') this.fitToolToImage();
        this.changed(); return { ok: true, source: this.image, state: this.state() };
      }
      case 'screenshot.copy': {
        const bytes = await this.png(request.dataUrl); const image = nativeImage.createFromBuffer(bytes); if (image.isEmpty()) throw Error('截图无法解码。'); clipboard.writeImage(image); break;
      }
      case 'screenshot.save': {
        const bytes = await this.png(request.dataUrl); const filename = this.pngName(request.filename);
        if (request.destination === 'library') await this.options.saveToLibrary(bytes, filename);
        else { const saved = await this.savePng(bytes, filename); return { ok: true, path: saved, state: this.state() }; } break;
      }
      case 'screenshot.ask': case 'selection.ask': return this.answer(request);
      case 'link.open': {
        try { await shell.openExternal(request.url); }
        catch { throw Error('无法打开链接，请检查系统默认浏览器。'); }
        break;
      }
      case 'selection.clipboard': return { ok: true, text: boundedSelectionText(clipboard.readText()), state: this.state() };
      case 'selection.copy': clipboard.writeText(request.text); break;
      case 'selection.pin': {
        if (this.task !== 'selection' || !this.tool || this.tool.isDestroyed()) throw Error('划词助手未打开。');
        this.selectionPinned = request.pinned; this.tool.setAlwaysOnTop(request.pinned, 'floating'); this.changed(); break;
      }
      case 'ask.cancel': this.asks.get(request.id)?.abort(); break;
      case 'recording.prepare': {
        const source = await this.desktopSource(request.sourceId, { width: 1, height: 1 });
        const displays = screen.getAllDisplays();
        const display = displays.find(candidate => String(candidate.id) === source.display_id) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        let capture = { ...display.bounds };
        if (source.id.startsWith('screen:') && request.rect) {
          const image = this.image;
          if (!image?.desktop || this.sourceId !== source.id) throw Error('屏幕选择已变更，请重新框选录制区域。');
          const rect = request.rect;
          if (rect.x + rect.width > image.width || rect.y + rect.height > image.height) throw Error('录制区域超出了所选屏幕。');
          capture = { x: display.bounds.x + rect.x / image.width * display.bounds.width, y: display.bounds.y + rect.y / image.height * display.bounds.height,
            width: rect.width / image.width * display.bounds.width, height: rect.height / image.height * display.bounds.height };
        }
        const controls = placeCaptureRecordingControls({ ...(source.id.startsWith('screen:') ? { capture } : {}), displayId: String(display.id), displays });
        const id = await this.recordings.prepare(request.format, request.quality); this.recordingResultId = undefined; this.recordingPreview.clear();
        this.recordingGrant = { source, id, systemAudio: request.systemAudio && request.format !== 'gif', microphone: request.microphone && request.format !== 'gif', videoUsed: false, desktopPreflightUsed: false, microphoneUsed: false };
        this.recordingControls = controls;
        this.hideApp(source.id);
        const tool = this.tool;
        if (tool && !tool.isDestroyed()) {
          tool.hide(); tool.setAlwaysOnTop(true, 'screen-saver'); tool.setResizable(true); tool.setMinimumSize(280, 44); tool.setMovable(false);
          if (controls.bounds) { tool.setBounds(controls.bounds); tool.setResizable(false); }
        }
        if (source.id.startsWith('screen:')) {
          const physicalDisplay = this.image?.desktop?.displayId === String(display.id) && this.image.desktop.pixelBounds
            ? this.image.desktop.pixelBounds : process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : { x: display.bounds.x * display.scaleFactor, y: display.bounds.y * display.scaleFactor, width: display.bounds.width * display.scaleFactor, height: display.bounds.height * display.scaleFactor };
          const capturePixels = { x: physicalDisplay.x + (capture.x - display.bounds.x) / display.bounds.width * physicalDisplay.width,
            y: physicalDisplay.y + (capture.y - display.bounds.y) / display.bounds.height * physicalDisplay.height,
            width: capture.width / display.bounds.width * physicalDisplay.width, height: capture.height / display.bounds.height * physicalDisplay.height };
          try { await this.showRecordingBoundaries(capturePixels, display, physicalDisplay, id); }
          catch { await this.recordings.cancel(id); throw Error('无法显示录制范围边界，请重新开始录制。'); }
        }
        // Remove the selection overlay before granting Chromium the live stream.
        await new Promise(resolve => setTimeout(resolve, 120));
        return { ok: true, id, recordingControls: controls, state: this.state() };
      }
      case 'recording.chunk': await this.recordings.append(request.id, request.sequence, request.chunk); if (request.sequence === 0) this.resizeTool(true); break;
      case 'recording.finish': { this.clearRecordingBoundaries(); const result = await this.recordings.finish(request.id); return { ok: true, path: result.path, state: this.state() }; }
      case 'recording.cancel': this.clearRecordingBoundaries(); await this.recordings.cancel(request.id); break;
      case 'recording.pause': this.recordings.pause(request.id, request.paused); break;
      case 'recording.stop': this.stopRecording(); break;
      case 'recording.preview': {
        const recording = this.recordings.state();
        if (!recording || recording.id !== request.id || !recording.path || !this.knownFiles.has(path.resolve(recording.path))) throw Error('找不到此录屏文件。');
        const preview = await this.recordingPreview.prepare(recording); this.recordingResultId = recording.id;
        return { ok: true, preview, state: this.state() };
      }
      case 'recording.open': {
        const recording = this.recordings.state();
        if (!recording || recording.id !== request.id || !recording.path || !this.knownFiles.has(path.resolve(recording.path))) throw Error('找不到此录屏文件。');
        await this.recordingPreview.prepare(recording);
        if (await shell.openPath(recording.path)) throw Error('无法启动系统播放器，请尝试定位文件后打开。');
        break;
      }
      case 'reveal': {
        const filename = path.resolve(request.path);
        if (filename === this.downloadPath) { await mkdir(this.downloadPath, { recursive: true }); const error = await shell.openPath(filename); if (error) throw Error('无法打开截图保存目录。'); break; }
        if (!this.knownFiles.has(filename)) throw Error('只能定位本次工具保存的文件。'); shell.showItemInFolder(filename); break;
      }
      case 'long.begin': {
        if (this.long || this.busyLong) throw Error('请先完成或取消当前滚动截图。');
        const sourceId = request.sourceId ?? this.sourceId;
        const provider = request.sourceId ? () => this.captureDesktop(sourceId) : this.provider ?? (sourceId ? () => this.captureDesktop(sourceId) : undefined);
        if (!provider || !this.image) throw Error('请先选择屏幕或窗口并截图，再启动滚动截图。');
        const generation = ++this.longGeneration; this.busyLong = true;
        try { const long = await LongCaptureStitcher.create(this.image.dataUrl, request.rect);
          if (generation !== this.longGeneration) { long.cancel(); throw Error('滚动截图已取消。'); }
          this.long = long; this.longProvider = provider; this.resizeTool(true); return { ok: true, long: long.state, state: this.state() };
        } finally { this.busyLong = false; }
      }
      case 'long.append': {
        if (!this.long || !this.longProvider) throw Error('请先开始滚动截图。'); if (this.busyLong) throw Error('正在采集当前画面，请稍后。'); this.busyLong = true;
        const stitcher = this.long; const provider = this.longProvider; const generation = this.longGeneration;
        try { const frame = await provider(); if (generation !== this.longGeneration) throw Error('滚动截图已取消。');
          if (this.image?.url && frame.url !== this.image.url) throw Error('来源页面已切换，请重新开始滚动截图。');
          const long = await stitcher.append(frame.dataUrl); return { ok: true, long, state: this.state() }; }
        finally { this.busyLong = false; }
      }
      case 'long.finish': {
        if (!this.long || this.busyLong) throw Error('请先完成当前画面采集。');
        this.busyLong = true;
        try { const result = await this.long.finish(); this.image = { ...result, title: '滚动截图', url: this.image?.url ?? '' };
          this.long = undefined; this.longProvider = undefined; this.fitToolToImage(); this.changed(); return { ok: true, source: this.image, state: this.state() }; }
        finally { this.busyLong = false; }
      }
      case 'long.cancel': this.longGeneration++; this.long?.cancel(); this.long = undefined; this.longProvider = undefined;
        if (this.image?.desktop) this.fitToolToDesktop(); else this.resizeTool(false); break;
    }
    return { ok: true, state: this.state() };
  }
  private pngName(filename?: string): string {
    const base = safeCaptureFilename(filename?.trim() || 'WorldlineBox-Screenshot').replace(/\.[^.]+$/, ''); return base.slice(0, 180) + '.png';
  }
  private async png(dataUrl: string): Promise<Buffer> {
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match?.[2] || match[2].length % 4 || dataUrl.length > Math.ceil(IMAGE_BYTES / 3) * 4 + 64) throw Error('截图格式无效或超过 32 MiB 上限。');
    const bytes = Buffer.from(match[2], 'base64');
    const image = sharp(bytes, { limitInputPixels: 64_000_000, animated: false, failOn: 'error' }); const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width > 32768 || metadata.height > 32768 || (metadata.pages ?? 1) > 1 || metadata.format !== match[1]) throw Error('截图尺寸或格式无效。');
    const result = await image.rotate().png().toBuffer(); if (result.length > IMAGE_BYTES) throw Error('截图超过 32 MiB 上限。'); return result;
  }
  private async savePng(bytes: Buffer, filename: string): Promise<string> {
    await mkdir(this.downloadPath, { recursive: true });
    const output = path.join(this.downloadPath, filename.slice(0, -4) + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8) + '.png');
    const handle = await open(output, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    this.rememberFile(output); return output;
  }
  private async sources(): Promise<CaptureDesktopSource[]> {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 220 }, fetchWindowIcons: false });
    const excluded = new Set([this.tool?.getMediaSourceId(), ...[...this.recordingBoundaries].filter(window => !window.isDestroyed()).map(window => window.getMediaSourceId())]);
    return sources.filter(source => !excluded.has(source.id)).slice(0, 200).map(source => ({ id: source.id, name: source.name.slice(0, 500),
      displayId: source.display_id, thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(), kind: source.id.startsWith('screen:') ? 'screen' : 'window' }));
  }
  private async desktopSource(id: string | undefined, thumbnailSize: { width: number; height: number }): Promise<DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({ types: id?.startsWith('window:') ? ['window'] : ['screen'], thumbnailSize, fetchWindowIcons: false });
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const source = id ? sources.find(source => source.id === id) : sources.find(source => source.display_id === String(display.id)) ?? sources.find(source => source.id.startsWith('screen:'));
    if (!source || source.id === this.tool?.getMediaSourceId() || [...this.recordingBoundaries].some(window => !window.isDestroyed() && source.id === window.getMediaSourceId())) throw Error('所选屏幕或窗口已关闭，请重新选择。'); return source;
  }
  private async captureDesktop(id?: string): Promise<CaptureImageSource> {
    if (this.captureBusy) throw Error('正在截图，请稍后。'); this.captureBusy = true;
    const tool = this.tool; const visible = !!tool && !tool.isDestroyed() && tool.isVisible();
    try {
      if (visible) tool!.hide(); this.hideApp(id);
      // Let the compositor remove the utility before taking the desktop image.
      await new Promise(resolve => setTimeout(resolve, 120));
      const displays = screen.getAllDisplays();
      const selected = await this.desktopSource(id, { width: 1, height: 1 });
      const windowSource = selected.id.startsWith('window:');
      const cursor = screen.getCursorScreenPoint();
      const display = displays.find(candidate => String(candidate.id) === selected.display_id) ?? screen.getDisplayNearestPoint(cursor);
      const approximatePixels = !windowSource && process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : {
        x: Math.round(display.bounds.x * display.scaleFactor), y: Math.round(display.bounds.y * display.scaleFactor),
        width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor),
      };
      const nativeMonitor = !windowSource ? readWindowsCaptureMonitor(approximatePixels) : undefined;
      const physicalDisplay = nativeMonitor?.bounds ?? approximatePixels;
      const width = windowSource ? 2048 : physicalDisplay.width, height = windowSource ? 1280 : physicalDisplay.height;
      if (width * height > 40_000_000 || width > 32768 || height > 32768) throw Error('屏幕画面过大，请选择较小的窗口。');
      const source = await this.desktopSource(selected.id, { width, height });
      if (source.thumbnail.isEmpty()) throw Error('无法读取屏幕画面，请检查系统屏幕录制权限。');
      const bytes = source.thumbnail.toPNG(); const size = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      if (!size.width || !size.height || size.width * size.height > 40_000_000 || bytes.length > IMAGE_BYTES) throw Error('屏幕画面过大，请选择较小的窗口。');
      this.sourceId = source.id;
      const desktop = !windowSource ? createCaptureDesktopContext({ display, cursor, native: readWindowsDesktopRegions(),
        ...(nativeMonitor ? { nativeMonitor } : {}),
        screenToDipRect: rect => nativeCaptureRectToDisplayDip(rect, physicalDisplay, display.bounds) }) : undefined;
      return { dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), width: size.width, height: size.height, title: source.name.slice(0, 500), url: '', ...(desktop ? { desktop } : {}) };
    } finally { this.captureBusy = false; if (visible && tool && !tool.isDestroyed()) tool.show(); }
  }
  private configureSession(scope: Session): void {
    const activeGrant = () => this.recordingGrant && ['recording', 'paused'].includes(this.recordings.state()?.status ?? '') ? this.recordingGrant : undefined;
    const ownsResult = (contents: Electron.WebContents | null, isMainFrame: boolean) => {
      const tool = this.tool, recording = this.recordings.state();
      return !!tool && !tool.isDestroyed() && !tool.webContents.isDestroyed() && contents === tool.webContents && isMainFrame
        && this.task === 'recording' && !!recording?.path && this.recordingResultId === recording.id
        && (recording.status === 'saved' || recording.status === 'failed' && recording.path.endsWith('.webm.part'))
        && this.knownFiles.has(path.resolve(recording.path));
    };
    scope.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'fullscreen' ? ownsResult(contents, details.isMainFrame)
      : contents === this.tool?.webContents && details.isMainFrame && permission === 'media'
        && !!activeGrant()?.microphone && !activeGrant()?.microphoneUsed && details.mediaType === 'audio');
    scope.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'fullscreen') { callback(ownsResult(contents, details.isMainFrame)); return; }
      const media = details as Electron.MediaAccessPermissionRequest;
      const grant = activeGrant();
      // Electron 43 sends getDisplayMedia's preflight as mediaTypes: [] before
      // the dedicated display handler. This never grants camera ['video'] or
      // microphone ['audio'] access, and consumes only the prepared desktop
      // preflight. The display handler still checks the exact frame and source.
      const desktopPreflight = permission === 'display-capture' || permission === 'media' && Array.isArray(media.mediaTypes) && media.mediaTypes.length === 0;
      const microphone = permission === 'media' && !!grant?.microphone && !grant.microphoneUsed && !!media.mediaTypes?.length && media.mediaTypes.every(type => type === 'audio');
      const allowed = contents === this.tool?.webContents && details.isMainFrame && !!grant
        && (desktopPreflight ? !grant.videoUsed && !grant.desktopPreflightUsed : microphone);
      if (allowed && grant) { if (desktopPreflight) grant.desktopPreflightUsed = true; else grant.microphoneUsed = true; } callback(allowed);
    });
    scope.setDisplayMediaRequestHandler((request, callback) => {
      const tool = this.tool; const grant = activeGrant();
      if (!tool || tool.isDestroyed() || !grant || grant.videoUsed || request.frame !== tool.webContents.mainFrame || !request.videoRequested) { callback({}); return; }
      grant.videoUsed = true;
      callback({ video: grant.source, ...(request.audioRequested && grant.systemAudio && process.platform === 'win32' ? { audio: 'loopback' as const } : {}) });
    });
  }
  stopRecording(): void { this.clearRecordingBoundaries(); if (this.tool && !this.tool.isDestroyed()) this.tool.webContents.send(CAPTURE_TOOLS_STOP_RECORDING); }
  private async focusedSelection(): Promise<string> {
    const main = this.options.getMainWindow();
    if (main && !main.isDestroyed() && main.isFocused() && this.options.readBrowserSelection) {
      try { const selected = boundedSelectionText(await this.options.readBrowserSelection()); if (selected.trim()) return selected; }
      catch { /* Unsupported or navigating browser documents fall back to native selection. */ }
    }
    return readFocusedSelectedText();
  }
  open(task: CaptureToolTask, image?: CaptureImageSource, provider?: CaptureProvider): Promise<CaptureToolsResponse> {
    if (this.opening) return this.opening;
    // A global selection hotkey must read the previously focused control before
    // opening, hiding, or focusing any utility window. A toolbar click may return
    // an empty selection; the assistant deliberately keeps an editable input.
    this.opening = (async () => this.openTool(task, image, provider, task === 'selection' ? await this.focusedSelection() : ''))()
      .finally(() => { this.opening = undefined; }); return this.opening;
  }
  openSelection(text: string): Promise<CaptureToolsResponse> {
    if (this.opening) return this.opening;
    this.opening = this.openTool('selection', undefined, undefined, boundedSelectionText(text)).finally(() => { this.opening = undefined; }); return this.opening;
  }
  private async openTool(task: CaptureToolTask, image?: CaptureImageSource, provider?: CaptureProvider, selectedText = ''): Promise<CaptureToolsResponse> {
    await this.init(); if (this.closed || this.stopping) throw Error('截图工具正在关闭。');
    if (['recording', 'paused', 'finalizing'].includes(this.recordings.state()?.status ?? '')) {
      if (task === 'recording') this.stopRecording(); else throw Error('请先结束当前录屏。'); return { ok: true, state: this.state() };
    }
    await this.closeTool(); this.task = task; this.provider = provider; this.image = image; this.sourceId = undefined; this.selectedText = selectedText; this.selectionPinned = false;
    try {
      if (task !== 'selection' && !image) this.image = await this.captureDesktop();
      // Chromium and the global network policy retain sessions for the app
      // lifetime. One memory-only partition avoids accumulating proxy observers
      // and caches each time the screenshot editor is opened and closed.
      const scope = this.scope ?? session.fromPartition('worldlinebox-capture-tools', { cache: false });
      if (!this.scope) { this.scope = scope; scope.protocol.handle(CAPTURE_RECORDING_SCHEME, request => this.recordingPreview.respond(request)); }
      this.configureSession(scope);
      const desktop = this.image?.desktop;
      const cursor = screen.getCursorScreenPoint(); const area = screen.getDisplayNearestPoint(cursor).workArea;
      const selectionWidth = Math.min(420, area.width), selectionHeight = Math.min(520, area.height);
      const selectionBounds = { width: selectionWidth, height: selectionHeight,
        x: Math.round(Math.max(area.x, Math.min(cursor.x + 18, area.x + area.width - selectionWidth))),
        y: Math.round(Math.max(area.y, Math.min(cursor.y + 18, area.y + area.height - selectionHeight))) };
      const tool = new BrowserWindow({ title: task === 'selection' ? 'WorldlineBox · 划词助手' : task === 'recording' ? 'WorldlineBox · 录屏工具' : 'WorldlineBox · 截图工具',
        frame: false, thickFrame: false,
        ...(desktop ? { ...desktop.bounds, minWidth: 1, minHeight: 1, resizable: true, movable: false, enableLargerThanScreen: true,
          skipTaskbar: true, hasShadow: false, roundedCorners: false } : task === 'selection'
          ? { ...selectionBounds, minWidth: Math.min(340, area.width), minHeight: Math.min(360, area.height), resizable: true, movable: true, skipTaskbar: true, hasShadow: true }
          : { width: 1160, height: 780, minWidth: 760, minHeight: 560 }), show: false,
        autoHideMenuBar: true, backgroundColor: '#f7f8fc', webPreferences: { preload: this.options.preloadPath, additionalArguments: [CAPTURE_TOOLS_ARGUMENT],
          session: scope, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false } });
      // Content protection opts this HWND out of Windows screen sharing (WDA_EXCLUDEFROMCAPTURE).
      // It made screenshot/recording controls invisible in remote clients such as Sunlogin.
      // The utility is hidden before each snapshot, so capture exclusion is unnecessary.
      this.tool = tool; tool.setContentProtection(false); tool.setAlwaysOnTop(task !== 'selection', desktop ? 'screen-saver' : 'floating'); tool.removeMenu();
      tool.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      tool.webContents.on('will-navigate', event => event.preventDefault()); tool.webContents.on('will-attach-webview', event => event.preventDefault());
      tool.on('close', event => {
        if (!this.closed && ['recording', 'paused', 'finalizing'].includes(this.recordings.state()?.status ?? '')) { event.preventDefault(); this.stopRecording(); }
      });
      tool.once('closed', () => { if (this.tool === tool) { this.tool = undefined; this.image = undefined; this.selectedText = ''; this.selectionPinned = false; this.provider = undefined; this.longGeneration++; this.long?.cancel(); this.long = undefined; this.longProvider = undefined;
        this.recordingGrant = undefined; this.recordingControls = undefined; this.recordingResultId = undefined; this.recordingPreview.clear(); this.clearRecordingBoundaries(); for (const controller of this.asks.values()) controller.abort(); this.asks.clear(); this.restoreApp(); } });
      tool.webContents.once('render-process-gone', () => {
        const recording = this.recordings.state(); this.recordingGrant = undefined; this.clearRecordingBoundaries(); this.restoreApp();
        if (recording && ['recording', 'paused'].includes(recording.status)) void this.recordings.finish(recording.id).catch(() => undefined);
        if (!tool.isDestroyed()) tool.destroy();
      });
      // loadURL resolves before React's lazy module and desktop image are ready.
      // Keep the HWND hidden until the actual capture surface has painted.
      this.fitToolToDesktop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        this.surfaceReady = { window: tool, resolve, reject };
        timer = setTimeout(() => reject(Error('屏幕工具未能准备好，请重试。')), 20_000);
      });
      const closed = () => this.surfaceReady?.window === tool && this.surfaceReady.reject(Error('截图窗口已关闭。'));
      tool.once('closed', closed);
      try { await Promise.all([this.options.loadWindow(tool), ready]); }
      finally { clearTimeout(timer); tool.removeListener('closed', closed); if (this.surfaceReady?.window === tool) this.surfaceReady = undefined; }
      if (this.closed || tool.isDestroyed()) throw Error('截图窗口已关闭。');
      tool.setOpacity(0); tool.show(); this.fitToolToDesktop();
      // Windows can apply Electron's cached rounded DIP rectangle during the
      // first show. Correct it after that native event turn, while the tool
      // still belongs to this open operation.
      if (this.image?.desktop) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (this.closed || tool.isDestroyed()) throw Error('截图窗口已关闭。'); this.fitToolToDesktop();
      }
      tool.setOpacity(1); tool.focus();
      this.changed();
      return { ok: true, state: this.state(), ...(this.image ? { source: this.image } : {}), ...(task === 'selection' ? { text: this.selectedText } : {}) };
    } catch (error) { this.restoreApp(); if (this.tool && !this.tool.isDestroyed()) this.tool.destroy(); throw error; }
  }
  private async closeTool(): Promise<void> {
    if (['recording', 'paused', 'finalizing'].includes(this.recordings.state()?.status ?? '')) throw Error('请先停止或取消当前录屏。');
    for (const controller of this.asks.values()) controller.abort(); this.asks.clear(); this.longGeneration++; this.long?.cancel(); this.long = undefined; this.longProvider = undefined;
    this.recordingGrant = undefined; this.recordingControls = undefined; this.recordingResultId = undefined; this.recordingPreview.clear(); this.clearRecordingBoundaries(); this.selectedText = ''; this.selectionPinned = false;
    const tool = this.tool; if (tool && !tool.isDestroyed()) tool.destroy(); this.restoreApp();
  }
  shutdown(): Promise<void> { return this.shuttingDown ??= this.shutdownTool(); }
  private async shutdownTool(): Promise<void> {
    this.stopping = true; this.captureShortcuts(false); this.clearRecordingBoundaries(); for (const accelerator of this.registered) globalShortcut.unregister(accelerator); this.registered.clear(); powerMonitor.removeListener('suspend', this.onSuspend);
    for (const controller of this.asks.values()) controller.abort(); this.asks.clear(); this.longGeneration++; this.long?.cancel(); this.long = undefined;
    const recording = this.recordings.state();
    if (recording && ['recording', 'paused', 'finalizing'].includes(recording.status)) {
      this.stopRecording(); await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.terminalListeners.delete(done); resolve(); };
        const timer = setTimeout(done, 5000); timer.unref(); this.terminalListeners.add(done);
      });
    }
    // Keep the tool IPC alive during the grace period so MediaRecorder's final
    // dataavailable and finish messages reach disk before its renderer closes.
    await this.recordings.shutdown(); this.closed = true;
    if (this.ipcRegistered) { ipcMain.removeHandler(CAPTURE_TOOLS_REQUEST); this.ipcRegistered = false; }
    const tool = this.tool; if (tool && !tool.isDestroyed()) tool.destroy(); this.restoreApp();
    this.scope?.setDisplayMediaRequestHandler(null); this.scope?.setPermissionRequestHandler(null); this.scope?.setPermissionCheckHandler(null);
    this.recordingResultId = undefined; this.recordingPreview.clear(); this.scope?.protocol.unhandle(CAPTURE_RECORDING_SCHEME);
  }
}
