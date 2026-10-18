import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import sharp from 'sharp';
import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, nativeImage, powerMonitor, screen, session, shell,
  type DesktopCapturerSource, type IpcMainInvokeEvent, type Session } from 'electron';
import { CAPTURE_TOOLS_ARGUMENT, CAPTURE_TOOLS_CHANGED, CAPTURE_TOOLS_REQUEST, CAPTURE_TOOLS_STOP_RECORDING,
  DEFAULT_CAPTURE_TOOLS_SETTINGS, captureToolsRequestSchema, captureToolsSettingsSchema, type CaptureDesktopSource,
  type CaptureImageSource, type CaptureToolsRequest, type CaptureToolsResponse, type CaptureToolsSettings,
  type CaptureToolsState, type CaptureToolTask } from '../../shared/capture-tools';
import type { CompanionModelConfig } from '../companions/model';
import { atomicJson, readJson } from '../dsh/files';
import { safeCaptureFilename } from '../browser/capture-download';
import { answerCaptureImage, getCaptureAiState } from './visual-answer';
import { RecordingStore } from './recording-store';
import { LongCaptureStitcher } from './long-capture';
import { boundedSelectionText, readFocusedSelectedText } from './selected-text';
import { answerSelectedText } from './text-answer';

export interface CaptureToolsServiceOptions {
  getMainWindow(): BrowserWindow | null | undefined;
  preloadPath: string;
  loadWindow(window: BrowserWindow): Promise<void>;
  getModelConfig(): CompanionModelConfig;
  saveToLibrary(bytes: Uint8Array, filename: string): Promise<void>;
  getFfmpeg(): string | undefined | Promise<string | undefined>;
  captureBrowser?(): Promise<CaptureImageSource>;
  readBrowserSelection?(): Promise<string>;
  /** Main checks custom application bindings before a global hotkey is saved. */
  validateShortcuts?(settings: CaptureToolsSettings): void;
  root?: string;
  downloadPath?: string;
}
const TASKS: CaptureToolTask[] = ['screenshot', 'recording', 'ocr', 'translate', 'long-screenshot', 'selection'];
const IMAGE_BYTES = 32 * 1024 * 1024;
const mainActions = new Set(['state', 'settings.save', 'open']);
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
  private scope?: Session;
  private image?: CaptureImageSource;
  private selectedText = '';
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
  private asks = new Map<string, AbortController>();
  private terminalListeners = new Set<() => void>();
  private recordingGrant?: { source: DesktopCapturerSource; id: string; systemAudio: boolean; microphone: boolean; videoUsed: boolean; desktopPreflightUsed: boolean; microphoneUsed: boolean };
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
        if (['saved', 'failed', 'cancelled'].includes(state.status)) { this.recordingGrant = undefined; this.restoreApp(); this.resizeTool(false); for (const listener of this.terminalListeners) listener(); }
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
      shortcuts: structuredClone(this.shortcuts), ai, recording: this.recordings.state(), revision: this.revision };
  }
  configurationChanged(): void { if (!this.closed) this.changed(); }
  private changed(): void {
    this.revision++; const state = this.state();
    for (const window of [this.options.getMainWindow(), this.tool]) if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      try { window.webContents.send(CAPTURE_TOOLS_CHANGED, state); } catch { /* A closing renderer does not invalidate a saved capture. */ }
    }
  }
  private registerShortcuts(): void {
    for (const accelerator of this.registered) globalShortcut.unregister(accelerator); this.registered.clear();
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
    for (const window of BrowserWindow.getAllWindows()) if (window !== this.tool && !window.isDestroyed() && window.isVisible() && window.getMediaSourceId() !== exceptSourceId) { this.hidden.add(window); window.hide(); }
  }
  private restoreApp(): void {
    for (const window of this.hidden) if (!window.isDestroyed()) window.showInactive(); this.hidden.clear();
  }
  private resizeTool(compact: boolean): void {
    const tool = this.tool; if (!tool || tool.isDestroyed()) return;
    tool.setMinimumSize(compact ? 420 : 760, compact ? 210 : 560);
    tool.setSize(compact ? 460 : 1160, compact ? 250 : 780);
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
    const openDownloads = parsed.data.type === 'reveal' && path.resolve(parsed.data.path) === this.downloadPath;
    if (!own && !mainActions.has(parsed.data.type) && !openDownloads) return { ok: false, error: '请在独立截图工具窗口中执行此操作。' };
    try { await this.init(); if (this.closed || this.stopping && !flushActions.has(parsed.data.type)) throw Error('截图工具正在关闭。'); return await this.request(parsed.data); }
    catch (error) { return { ok: false, error: (error instanceof Error ? error.message : '截图操作失败。').slice(0, 2000) }; }
  }
  private async request(request: CaptureToolsRequest): Promise<CaptureToolsResponse> {
    switch (request.type) {
      case 'state': return { ok: true, state: this.state() };
      case 'context': return { ok: true, state: this.state(), ...(this.image ? { source: this.image } : {}), ...(this.task === 'selection' ? { text: this.selectedText } : {}) };
      case 'settings.save': await this.saveSettings(request.settings); break;
      case 'open': {
        if (request.task === 'selection' && request.source === 'browser') {
          if (!this.options.readBrowserSelection) throw Error('浏览器划词暂不可用，请先打开网页。');
          return this.openSelection(await this.options.readBrowserSelection());
        }
        if (request.source === 'browser') {
          if (!this.options.captureBrowser) throw Error('浏览器截图暂不可用，请先打开网页。');
          return this.open(request.task, await this.options.captureBrowser(), this.options.captureBrowser);
        }
        return this.open(request.task);
      }
      case 'close': await this.closeTool(); break;
      case 'sources.list': return { ok: true, sources: await this.sources(), state: this.state() };
      case 'screenshot.capture': {
        this.provider = undefined; this.sourceId = request.sourceId ?? this.sourceId;
        this.image = await this.captureDesktop(this.sourceId); this.changed(); return { ok: true, source: this.image, state: this.state() };
      }
      case 'screenshot.copy': {
        const bytes = await this.png(request.dataUrl); const image = nativeImage.createFromBuffer(bytes); if (image.isEmpty()) throw Error('截图无法解码。'); clipboard.writeImage(image); break;
      }
      case 'screenshot.save': {
        const bytes = await this.png(request.dataUrl); const filename = this.pngName(request.filename);
        if (request.destination === 'library') await this.options.saveToLibrary(bytes, filename);
        else { const saved = await this.savePng(bytes, filename); return { ok: true, path: saved, state: this.state() }; } break;
      }
      case 'screenshot.ask': {
        if (this.asks.size || this.asks.has(request.id)) throw Error('请等待当前图片问答完成，或先取消。');
        const controller = new AbortController(); this.asks.set(request.id, controller);
        try { const text = await answerCaptureImage({ config: this.options.getModelConfig(), dataUrl: request.dataUrl, messages: request.messages, signal: controller.signal }); return { ok: true, text, state: this.state() }; }
        finally { this.asks.delete(request.id); }
      }
      case 'selection.ask': {
        if (this.asks.size) throw Error('请等待当前问答完成，或先取消。');
        const controller = new AbortController(); this.asks.set(request.id, controller);
        try { const text = await answerSelectedText({ config: this.options.getModelConfig(), selection: request.selection, messages: request.messages, signal: controller.signal }); return { ok: true, text, state: this.state() }; }
        finally { this.asks.delete(request.id); }
      }
      case 'selection.clipboard': return { ok: true, text: boundedSelectionText(clipboard.readText()), state: this.state() };
      case 'selection.copy': clipboard.writeText(request.text); break;
      case 'ask.cancel': this.asks.get(request.id)?.abort(); break;
      case 'recording.prepare': {
        const source = await this.desktopSource(request.sourceId, { width: 1, height: 1 });
        const id = await this.recordings.prepare(request.format);
        this.recordingGrant = { source, id, systemAudio: request.systemAudio && request.format !== 'gif', microphone: request.microphone && request.format !== 'gif', videoUsed: false, desktopPreflightUsed: false, microphoneUsed: false };
        this.hideApp(source.id); return { ok: true, id, state: this.state() };
      }
      case 'recording.chunk': await this.recordings.append(request.id, request.sequence, request.chunk); if (request.sequence === 0) this.resizeTool(true); break;
      case 'recording.finish': { const result = await this.recordings.finish(request.id); return { ok: true, path: result.path, state: this.state() }; }
      case 'recording.cancel': await this.recordings.cancel(request.id); break;
      case 'recording.pause': this.recordings.pause(request.id, request.paused); break;
      case 'recording.stop': this.stopRecording(); break;
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
          this.long = undefined; this.longProvider = undefined; this.resizeTool(false); this.changed(); return { ok: true, source: this.image, state: this.state() }; }
        finally { this.busyLong = false; }
      }
      case 'long.cancel': this.longGeneration++; this.long?.cancel(); this.long = undefined; this.longProvider = undefined; this.resizeTool(false); break;
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
    return sources.filter(source => source.id !== this.tool?.getMediaSourceId()).slice(0, 200).map(source => ({ id: source.id, name: source.name.slice(0, 500),
      displayId: source.display_id, thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(), kind: source.id.startsWith('screen:') ? 'screen' : 'window' }));
  }
  private async desktopSource(id: string | undefined, thumbnailSize: { width: number; height: number }): Promise<DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({ types: id?.startsWith('window:') ? ['window'] : ['screen'], thumbnailSize, fetchWindowIcons: false });
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const source = id ? sources.find(source => source.id === id) : sources.find(source => source.display_id === String(display.id)) ?? sources.find(source => source.id.startsWith('screen:'));
    if (!source || source.id === this.tool?.getMediaSourceId()) throw Error('所选屏幕或窗口已关闭，请重新选择。'); return source;
  }
  private async captureDesktop(id?: string): Promise<CaptureImageSource> {
    if (this.captureBusy) throw Error('正在截图，请稍后。'); this.captureBusy = true;
    const tool = this.tool; const visible = !!tool && !tool.isDestroyed() && tool.isVisible();
    try {
      if (visible) tool!.hide(); this.hideApp(id);
      // Let the compositor remove the utility before taking the desktop image.
      await new Promise(resolve => setTimeout(resolve, 120));
      const displays = screen.getAllDisplays(); const windowSource = id?.startsWith('window:');
      const width = Math.min(windowSource ? 2048 : 4096, Math.max(1, ...displays.map(display => Math.ceil(display.size.width * display.scaleFactor))));
      const height = Math.min(windowSource ? 1280 : 4096, Math.max(1, ...displays.map(display => Math.ceil(display.size.height * display.scaleFactor))));
      const source = await this.desktopSource(id, { width, height });
      if (source.thumbnail.isEmpty()) throw Error('无法读取屏幕画面，请检查系统屏幕录制权限。');
      const bytes = source.thumbnail.toPNG(); const size = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      if (!size.width || !size.height || size.width * size.height > 40_000_000 || bytes.length > IMAGE_BYTES) throw Error('屏幕画面过大，请选择较小的窗口。');
      this.sourceId = source.id;
      return { dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), width: size.width, height: size.height, title: source.name.slice(0, 500), url: '' };
    } finally { this.captureBusy = false; if (visible && tool && !tool.isDestroyed()) tool.show(); }
  }
  private configureSession(scope: Session): void {
    const activeGrant = () => this.recordingGrant && ['recording', 'paused'].includes(this.recordings.state()?.status ?? '') ? this.recordingGrant : undefined;
    scope.setPermissionCheckHandler((contents, permission, _origin, details) => contents === this.tool?.webContents && details.isMainFrame
      && permission === 'media' && !!activeGrant()?.microphone && !activeGrant()?.microphoneUsed && details.mediaType === 'audio');
    scope.setPermissionRequestHandler((contents, permission, callback, details) => {
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
  private stopRecording(): void { if (this.tool && !this.tool.isDestroyed()) this.tool.webContents.send(CAPTURE_TOOLS_STOP_RECORDING); }
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
    await this.closeTool(); this.task = task; this.provider = provider; this.image = image; this.sourceId = undefined; this.selectedText = selectedText;
    try {
      if (task !== 'recording' && task !== 'selection' && !image) this.image = await this.captureDesktop();
      // Chromium and the global network policy retain sessions for the app
      // lifetime. One memory-only partition avoids accumulating proxy observers
      // and caches each time the screenshot editor is opened and closed.
      const scope = this.scope ?? session.fromPartition('worldlinebox-capture-tools', { cache: false }); this.scope = scope; this.configureSession(scope);
      const tool = new BrowserWindow({ title: task === 'selection' ? 'WorldlineBox · 划词助手' : 'WorldlineBox · 截图工具',
        width: task === 'selection' ? 720 : 1160, height: task === 'selection' ? 760 : 780, minWidth: task === 'selection' ? 520 : 760, minHeight: task === 'selection' ? 480 : 560, show: false,
        autoHideMenuBar: true, backgroundColor: '#f7f8fc', webPreferences: { preload: this.options.preloadPath, additionalArguments: [CAPTURE_TOOLS_ARGUMENT],
          session: scope, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
      this.tool = tool; tool.setContentProtection(true); tool.setAlwaysOnTop(true, 'floating'); tool.removeMenu();
      tool.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      tool.webContents.on('will-navigate', event => event.preventDefault()); tool.webContents.on('will-attach-webview', event => event.preventDefault());
      tool.on('close', event => {
        if (!this.closed && ['recording', 'paused', 'finalizing'].includes(this.recordings.state()?.status ?? '')) { event.preventDefault(); this.stopRecording(); }
      });
      tool.once('closed', () => { if (this.tool === tool) { this.tool = undefined; this.image = undefined; this.selectedText = ''; this.provider = undefined; this.longGeneration++; this.long?.cancel(); this.long = undefined; this.longProvider = undefined;
        this.recordingGrant = undefined; for (const controller of this.asks.values()) controller.abort(); this.asks.clear(); this.restoreApp(); } });
      tool.webContents.once('render-process-gone', () => {
        const recording = this.recordings.state(); this.recordingGrant = undefined; this.restoreApp();
        if (recording && ['recording', 'paused'].includes(recording.status)) void this.recordings.finish(recording.id).catch(() => undefined);
        if (!tool.isDestroyed()) tool.destroy();
      });
      await this.options.loadWindow(tool); if (this.closed || tool.isDestroyed()) throw Error('截图窗口已关闭。'); tool.show(); tool.focus(); this.changed();
      return { ok: true, state: this.state(), ...(this.image ? { source: this.image } : {}), ...(task === 'selection' ? { text: this.selectedText } : {}) };
    } catch (error) { this.restoreApp(); if (this.tool && !this.tool.isDestroyed()) this.tool.destroy(); throw error; }
  }
  private async closeTool(): Promise<void> {
    if (['recording', 'paused', 'finalizing'].includes(this.recordings.state()?.status ?? '')) throw Error('请先停止或取消当前录屏。');
    for (const controller of this.asks.values()) controller.abort(); this.asks.clear(); this.longGeneration++; this.long?.cancel(); this.long = undefined; this.longProvider = undefined;
    this.recordingGrant = undefined; this.selectedText = '';
    const tool = this.tool; if (tool && !tool.isDestroyed()) tool.destroy(); this.restoreApp();
  }
  shutdown(): Promise<void> { return this.shuttingDown ??= this.shutdownTool(); }
  private async shutdownTool(): Promise<void> {
    this.stopping = true; for (const accelerator of this.registered) globalShortcut.unregister(accelerator); this.registered.clear(); powerMonitor.removeListener('suspend', this.onSuspend);
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
  }
}
