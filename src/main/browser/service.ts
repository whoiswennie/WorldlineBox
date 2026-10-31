import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { app, clipboard, dialog, ipcMain, Menu, session, shell, WebContentsView, type BrowserWindow, type DownloadItem, type Session } from 'electron';
import type { CaptureImageSource } from '../../shared/capture-tools';
import { BROWSER_CHANGED, BROWSER_FOCUS, BROWSER_REQUEST, BROWSER_HOME, browserRequestSchema, type BrowserDownload, type BrowserRequest, type BrowserResponse, type BrowserState, type BrowserTab } from '../../shared/browser';
import { getApplicationNetwork } from '../application-network';
import { BrowserStore, browserAddress, isBrowserUrl, newBrowserTab } from './store';
import { BROWSER_CAPTURE_CONTENT_REQUEST, BROWSER_CAPTURE_REQUEST, BROWSER_CAPTURE_SELECTION_STATE, browserCaptureContentRequestSchema, browserCaptureRequestSchema, browserCaptureSelectionStateSchema, type BrowserCaptureTarget, type BrowserCaptureRequest, type BrowserCaptureResponse, type BrowserCaptureContentResponse } from '../../shared/browser-capture';
import { BrowserCaptureHost, type BrowserCaptureHooks, type BrowserCaptureSource } from './capture-host';
import { formatBrowserLoadError, shouldIgnoreBrowserLoadError } from '../../shared/browser-load-error';
import { BrowserTextDrafts, browserTextTitle, readBrowserTextSelection } from './text-selection';
import { externalBrowserUrl, isRestrictedBrowserSignIn } from '../../shared/browser-compatibility';
import { browserTabShortcut } from '../../shared/browser-shortcuts';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserAiService } from './ai-service';
import { BrowserPageController } from './page-controller';
import type { CompanionModelConfig } from '../companions/model';
import type { BrowserAgentToolName } from '../../shared/browser-agent-tools';
import { browserAiRequestSchema, type BrowserAiSource } from '../../shared/browser-ai';
import { companionBrowserArgumentsSchema, type CompanionBrowserArguments, type CompanionBrowserScope } from '../../shared/companion-browser';
import { BrowserCompanionActivity } from './companion-activity';
import { companionVideo } from './companion-video';
import { companionScreenshot } from './companion-screenshot';
import { companionViewport } from './companion-viewport';

export interface CompanionBrowserResult { value: unknown; screenshot?: Uint8Array }

const MAX_LIVE_PAGES = 8;
export class BrowserService {
  readonly store: BrowserStore;
  private scope?: Session;
  private initialization?: Promise<void>;
  private ready = false;
  private readonly views = new Map<string, { view: WebContentsView; used: number }>();
  private readonly downloads = new Map<string, DownloadItem>();
  private readonly pendingPermissions = new Map<string, { origin: string; permission: string; callback: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private fullscreen = false;
  private previousFullscreen = false;
  private cacheBytes?: number;
  private error?: string;
  private revision = 0;
  private find?: BrowserState['find'];
  private progressTimer?: ReturnType<typeof setTimeout>;
  private owner?: BrowserWindow;
  private capture?: BrowserCaptureHost;
  private preloadRegistration?: string;
  private readonly navigationVersions = new Map<string, number>();
  private readonly signInSources = new Map<string, string>();
  private readonly textVersions = new Map<string, number>();
  private readonly textDrafts = new BrowserTextDrafts();
  private readonly selectionFrames = new Map<string, { frame: Electron.WebFrameMain; url: string; documentId: string }>();
  private readonly ai: BrowserAiService;
  private readonly pages = new BrowserPageController(id => this.navigationVersions.get(id) ?? 0);
  private readonly searchPages = new Map<string, { query: string; sources: BrowserAiSource[]; producerId: string }>();
  private agentClosingTab?: string;
  private aiSearchTabId?: string;
  private readonly companionActivity = new BrowserCompanionActivity(() => { this.layout(); this.changed(false); });
  private readonly companionPages = new Map<string, BrowserPageController>();
  private readonly companionOpenedTabs = new Map<string, string>();
  constructor(private readonly getWindow: () => BrowserWindow | null | undefined, private readonly root = path.join(app.getPath('userData'), 'browser'), private readonly captureHooks?: BrowserCaptureHooks, private readonly onSelection?: (text: string) => Promise<void>, private readonly fullscreenShortcut?: (input: Electron.Input) => boolean, getModelConfig?: () => CompanionModelConfig) {
    this.store = new BrowserStore(root, error => { this.error = '浏览器配置保存失败：' + String(error).slice(0, 600); this.changed(false); });
    this.ai = new BrowserAiService(root, { getConfig: getModelConfig, changed: () => this.changed(false), hasTab: id => this.store.data.tabs.some(tab => tab.id === id),
      context: () => ({ activeTabId: this.store.data.activeTabId, tabCount: this.store.data.tabs.length,
        tabs: [...this.store.data.tabs].sort((a, b) => Number(b.id === this.store.data.activeTabId) - Number(a.id === this.store.data.activeTabId)).slice(0, 8)
          .map(({ id, title, url, muted, pinned, loading }) => ({ id, title: title.slice(0, 120), url: url.length <= 1500 ? url : '[长地址请通过 browser_tabs 查询]', muted, pinned, loading })) }),
      tool: (name, input, signal, confirm) => this.agentTool(name, input, signal, confirm),
      showResults: async (id, query, sources, producerId) => {
        let tab = this.store.data.tabs.find(item => item.id === id);
        if (!tab || tab.url !== BROWSER_HOME || tab.nativeBlank) tab = this.store.data.tabs.find(item => item.id === this.aiSearchTabId && item.url === BROWSER_HOME && !item.nativeBlank);
        if (!tab) tab = this.addTab(BROWSER_HOME); else if (tab.id !== this.store.data.activeTabId) this.select(tab.id);
        this.aiSearchTabId = tab.id;
        this.searchPages.set(tab.id, { query, sources: structuredClone([...sources]), producerId });
        tab.title = '搜索 · ' + query.slice(0, 100); this.layout(); this.changed();
      } });
  }
  private init(): Promise<void> { return this.initialization ??= this.initialize(); }
  private async initialize(): Promise<void> {
    await this.store.init();
    await this.ai.init();
    this.scope = session.fromPartition('persist:worldlinebox-browser');
    await (await getApplicationNetwork()).attachSession(this.scope);
    if (this.captureHooks) {
      this.preloadRegistration = this.scope.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'browser-capture.js') });
      this.capture = new BrowserCaptureHost(this.root, this.captureHooks, { tempRoot: app.getPath('temp'), fetch: (url, init) => this.scope!.fetch(url, init),
        chooseLocalImage: async () => { const owner = this.getWindow(); if (!owner || owner.isDestroyed()) return undefined;
          const selected = await dialog.showOpenDialog(owner, { title: '采集本地图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
          return selected.canceled ? undefined : selected.filePaths[0]; },
        chooseLocalFile: async () => { const owner = this.getWindow(); if (!owner || owner.isDestroyed()) return undefined;
          const selected = await dialog.showOpenDialog(owner, { title: '采集本地文件', properties: ['openFile'], filters: [{ name: '媒体与文档', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'pdf', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'docx', 'xlsx', 'pptx', 'epub', 'zip', '7z', 'rar'] }] });
          return selected.canceled ? undefined : selected.filePaths[0]; },
        changed: () => this.changed(false), sources: () => this.captureSources(), source: tabId => this.captureSource(tabId) });
    }
    this.scope.setPermissionCheckHandler((contents, permission, origin) => !!contents && this.owns(contents.id) && this.permissionAllowed(origin, permission));
    this.scope.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = this.origin(details.requestingUrl || contents.getURL());
      if (!this.owns(contents.id) || !origin) { callback(false); return; }
      if (this.permissionAllowed(origin, permission)) { callback(true); return; }
      const saved = this.store.data.sitePermissions[origin]?.[permission];
      if (saved === false || this.pendingPermissions.size >= 10 || ['unknown', 'openExternal', 'fileSystem'].includes(permission)) { callback(false); return; }
      const id = randomUUID(); const timer = setTimeout(() => this.resolvePermission(id, false, false), 30_000); timer.unref();
      this.pendingPermissions.set(id, { origin, permission, callback, timer }); this.changed();
    });
    this.scope.on('will-download', (_event, item, contents) => { if (contents && this.owns(contents.id)) this.trackDownload(item); });
    this.ready = true;
  }
  private origin(value: string): string | undefined { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined; } catch { return undefined; } }
  private permissionAllowed(origin: string, permission: string): boolean {
    return ['fullscreen', 'clipboard-sanitized-write'].includes(permission) || this.store.data.sitePermissions[this.origin(origin) ?? '']?.[permission] === true;
  }
  private owns(contentsId: number): boolean { return [...this.views.values()].some(item => !item.view.webContents.isDestroyed() && item.view.webContents.id === contentsId); }
  private captureSources(): BrowserCaptureSource[] {
    return [...this.views].flatMap(([tabId, entry]) => entry.view.webContents.isDestroyed() ? [] : entry.view.webContents.mainFrame.framesInSubtree
      .filter(frame => !frame.isDestroyed()).map(frame => ({ tabId, contents: entry.view.webContents, frame })));
  }
  private captureSource(tabId = this.store.data.activeTabId): BrowserCaptureSource | undefined {
    const entry = tabId ? this.views.get(tabId) : undefined;
    return entry && !entry.view.webContents.isDestroyed() ? { tabId: tabId!, contents: entry.view.webContents, frame: entry.view.webContents.mainFrame } : undefined;
  }
  async captureRequest(request: BrowserCaptureRequest): Promise<BrowserCaptureResponse> {
    await this.init(); if (!this.capture) return { ok: false, error: '资产采集服务不可用。' };
    if (request.type === 'text.prepare' || request.type === 'text.save') {
      try {
        if (request.type === 'text.save' && request.draftId) {
          const active = this.store.data.activeTabId;
          if (request.tabId && request.tabId !== active) throw Error('页面已切换，请重新选择文字。');
          const draft = this.textDrafts.get(request.draftId, active ?? null, this.textVersions.get(active ?? '') ?? 0);
          const result = await this.capture.saveText(draft.source, request.target, { text: request.text ?? draft.value.text, title: request.title ?? draft.value.title });
          if (result.ok) this.textDrafts.consume(request.draftId); return result;
        }
        const source = this.textSource(request.tabId); const version = this.textVersions.get(source.tabId) ?? 0;
        const bound = this.bindTextSource(source, version); const text = await readBrowserTextSelection(bound);
        if (!bound.isCurrent?.()) throw Error('页面已切换或跳转，请重新选择文字。');
        if (request.type === 'text.prepare') {
          await this.capture.handle({ type: 'state' });
          if (!bound.isCurrent?.()) throw Error('页面已切换或跳转，请重新选择文字。');
          const textDraft = this.textDrafts.create(bound, text, source.contents.getTitle(), version);
          return { ok: true, state: this.capture.state(), textDraft };
        }
        return this.capture.saveText(bound, request.target, { text, title: browserTextTitle(text) });
      } catch (error) { return { ok: false, state: this.capture.state(), error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
    }
    if (request.type === 'page.save') {
      const source = this.captureSource(request.tabId);
      if (!source || !/^https?:\/\//.test(source.frame.url)) return { ok: false, error: '请先打开需要采集的网页。' };
      return this.saveDocument(source, 'page', request.target);
    }
    return this.capture.handle(request);
  }
  private async saveDocument(source: BrowserCaptureSource, kind: 'page' | 'text', target?: BrowserCaptureTarget): Promise<BrowserCaptureResponse> {
    if (!this.capture) return { ok: false, error: '资产采集服务不可用。' };
    const url = source.frame.url;
    if (kind === 'text') { const text = await readBrowserTextSelection(source); return this.capture.saveText(source, target, { text, title: browserTextTitle(text) }); }
    const value: unknown = await source.frame.executeJavaScript('({title:document.title.slice(0,500),text:(document.body?.innerText||"").slice(0,4190000)})');
    if (source.contents.isDestroyed() || source.frame.isDestroyed() || source.frame.url !== url) return { ok: false, error: '页面已跳转，请重新采集。' };
    if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') return { ok: false, error: '无法读取网页内容。' };
    const input = { title: 'title' in value && typeof value.title === 'string' ? value.title : source.contents.getTitle(), text: value.text };
    return this.capture.savePage(source, target, input);
  }
  private textSource(tabId = this.store.data.activeTabId): BrowserCaptureSource {
    if (!tabId || tabId !== this.store.data.activeTabId) throw Error('页面已切换，请重新选择文字。');
    const source = this.captureSource(tabId);
    if (!source || !/^https?:\/\//u.test(source.contents.getURL())) throw Error('请先打开需要采集的网页。');
    const frames = source.contents.mainFrame.framesInSubtree;
    const remembered = this.selectionFrames.get(tabId);
    const frame = source.contents.focusedFrame ?? (remembered && !remembered.frame.isDestroyed() && remembered.frame.url === remembered.url && frames.includes(remembered.frame)
      ? remembered.frame : source.frame);
    if (frame.isDestroyed() || !frames.includes(frame)) throw Error('选区所在页面已关闭，请重新选择文字。');
    return { ...source, frame, sourcePageUrl: /^https?:\/\//u.test(frame.url) ? frame.url : source.contents.getURL() };
  }
  private bindTextSource(source: BrowserCaptureSource, version: number): BrowserCaptureSource {
    const frameUrl = source.frame.url; const pageUrl = source.contents.getURL();
    return { ...source, isCurrent: () => source.tabId === this.store.data.activeTabId && (this.textVersions.get(source.tabId) ?? 0) === version
      && this.captureSource(source.tabId)?.contents === source.contents && !source.contents.isDestroyed() && !source.frame.isDestroyed()
      && source.frame.url === frameUrl && source.contents.getURL() === pageUrl && source.contents.mainFrame.framesInSubtree.includes(source.frame) };
  }
  captureSelectionState(event: Electron.IpcMainEvent, value: unknown): void {
    const parsed = browserCaptureSelectionStateSchema.safeParse(value); if (!parsed.success) return;
    const source = this.captureSources().find(source => source.contents === event.sender && source.frame === event.senderFrame); if (!source) return;
    const current = this.selectionFrames.get(source.tabId);
    if (current?.frame === source.frame && current.documentId !== parsed.data.documentId) this.invalidateText(source.tabId);
    if (parsed.data.focused || parsed.data.hasSelection || current?.frame === source.frame) this.selectionFrames.set(source.tabId,
      { frame: source.frame, url: source.frame.url, documentId: parsed.data.documentId });
  }
  private invalidateText(tabId?: string): void {
    this.textDrafts.clear(tabId); this.capture?.cancelTextTab(tabId);
    if (tabId) { this.selectionFrames.delete(tabId); this.textVersions.set(tabId, (this.textVersions.get(tabId) ?? 0) + 1); }
    else { this.selectionFrames.clear(); for (const id of new Set([...this.views.keys(), ...this.textVersions.keys()])) this.textVersions.set(id, (this.textVersions.get(id) ?? 0) + 1); }
  }
  async captureViewport(): Promise<CaptureImageSource> {
    await this.init(); const tab = this.active(); const contents = this.ensureView(tab).webContents;
    const image = await contents.capturePage(); const size = image.getSize();
    if (image.isEmpty() || !size.width || !size.height) throw Error('当前网页无法截图。');
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height, title: tab.title, url: tab.url };
  }
  async selectedText(): Promise<string> {
    await this.init(); if (!this.visible) return '';
    try { const source = this.bindTextSource(this.textSource(), this.textVersions.get(this.store.data.activeTabId ?? '') ?? 0);
      const text = await readBrowserTextSelection(source); if (!source.isCurrent?.()) return '';
      return Buffer.from(text, 'utf8').subarray(0, 32768).toString('utf8').replace(/\uFFFD$/u, '').trim();
    } catch { return ''; }
  }
  async saveScreenshot(bytes: Uint8Array, filename: string): Promise<void> {
    await this.init(); if (!this.capture) throw Error('资产采集服务不可用。');
    const result = await this.capture.saveBytes(undefined, undefined, { bytes, filename, contentType: 'image/png' });
    if (!result.ok) throw Error(result.error);
    if (!result.jobId) throw Error('截图未开始保存，请重试。');
    await this.capture.waitForJob(result.jobId);
  }
  async captureContent(event: Electron.IpcMainInvokeEvent, input: unknown): Promise<BrowserCaptureContentResponse> {
    try {
      if (!this.capture) return { ok: false, code: 'unavailable', error: '资产采集服务不可用。' };
      if (event.sender.isDestroyed() || !event.senderFrame || event.senderFrame.isDestroyed()) return { ok: false, code: 'document-gone', error: '页面已关闭或正在跳转，请在加载完成后重试。' };
      // Only live frames belonging to this browser's sandboxed views can invoke
      // the shim. A denied/transient frame gets a typed refusal, never an IPC
      // exception in Electron's main process.
      const source = this.captureSources().find(item => item.contents === event.sender && item.frame === event.senderFrame);
      if (!source || !/^https?:\/\//.test(source.frame.url)) return { ok: false, code: 'forbidden', error: '当前页面无权访问资产采集。' };
      const parsed = browserCaptureContentRequestSchema.safeParse(input);
      if (!parsed.success) return { ok: false, code: 'invalid-request', error: '无效的采集请求。' };
      const url = source.frame.url;
      const value = await this.capture.content(parsed.data, source);
      if (source.frame.isDestroyed() || source.contents.isDestroyed() || source.frame.url !== url || !this.owns(source.contents.id)) return { ok: false, code: 'document-gone', error: '页面已关闭或正在跳转，请在加载完成后重试。' };
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: 'capture-failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) || '资产采集暂不可用。' };
    }
  }
  closeLibrary(libraryId: string): void { this.capture?.closeLibrary(libraryId); }
  state(): BrowserState {
    return { tabs: structuredClone(this.store.data.tabs), activeTabId: this.store.data.activeTabId, bookmarks: structuredClone(this.store.data.bookmarks),
      companions: this.companionActivity.state(),
      downloads: structuredClone(this.store.data.downloads), historyCount: this.store.data.history.length, preferences: { ...this.store.data.preferences },
      permissions: [...this.pendingPermissions].map(([id, value]) => ({ id, origin: value.origin, permission: value.permission })),
      fullscreen: this.fullscreen, revision: this.revision, find: this.find, cacheBytes: this.cacheBytes, error: this.error, capture: this.capture?.state(),
      ai: { ...this.ai.state(), page: this.searchPages.get(this.store.data.activeTabId ?? '') },
      ...(isRestrictedBrowserSignIn(this.store.data.tabs.find(tab => tab.id === this.store.data.activeTabId)?.url ?? '')
        ? { signIn: { provider: 'google' as const, siteUrl: this.signInSources.get(this.store.data.activeTabId!) } } : {}) };
  }
  private changed(persist = true): void {
    this.revision++;
    if (persist) this.store.changed(); const owner = this.getWindow();
    if (owner && !owner.isDestroyed()) owner.webContents.send(BROWSER_CHANGED, this.state());
  }
  private active(): BrowserTab { const tab = this.store.data.tabs.find(value => value.id === this.store.data.activeTabId); if (!tab) throw Error('没有活动标签页。'); return tab; }
  private attachOwner(): BrowserWindow {
    const owner = this.getWindow(); if (!owner || owner.isDestroyed()) throw Error('主窗口尚未就绪。');
    if (this.owner !== owner) {
      this.owner = owner;
      owner.on('resize', () => this.layout());
      owner.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) { this.visible = false; this.layout(); } });
      owner.webContents.on('render-process-gone', () => { this.visible = false; this.companionActivity.pause(true); this.layout(); });
      owner.once('closed', () => { this.visible = false; this.companionActivity.cancel(); this.companionPages.clear(); this.invalidateText(); for (const [tabId, item] of this.views) { this.capture?.cancelTab(tabId); if (!item.view.webContents.isDestroyed()) item.view.webContents.close(); } this.views.clear(); });
    }
    return owner;
  }
  private pagePreferences(): Electron.WebPreferences {
    // Apply these before Electron creates a popup's native WebContents too;
    // adopting an existing WebContents cannot change its security preferences.
    return { session: this.scope!, nodeIntegration: false, nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: !!this.capture, contextIsolation: true, sandbox: true, webSecurity: true,
      webviewTag: false, allowRunningInsecureContent: false, preload: undefined,
      backgroundThrottling: true, spellcheck: true, safeDialogs: true };
  }
  private evictionCandidate(protectedTab?: string) {
    return [...this.views].filter(([id, entry]) => id !== protectedTab && id !== this.store.data.activeTabId
      && !this.companionActivity.busy(id)
      && !entry.view.webContents.isDestroyed() && !entry.view.webContents.isCurrentlyAudible()).sort((a, b) => a[1].used - b[1].used)[0];
  }
  private pageAction(action: () => void): void {
    try { action(); }
    catch (error) { this.reportPageError(error); }
  }
  private reportPageError(error: unknown): void {
    this.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000); this.changed(false);
  }
  private ensureView(tab: BrowserTab, navigate = true, options?: Electron.WebContentsViewConstructorOptions, protectedTab?: string): WebContentsView {
    const previous = this.views.get(tab.id);
    if (previous && !previous.view.webContents.isDestroyed()) { previous.used = Date.now(); tab.discarded = false; return previous.view; }
    if (previous) this.destroyView(tab.id);
    const owner = this.attachOwner();
    if (this.views.size >= MAX_LIVE_PAGES) {
      const victim = this.evictionCandidate(protectedTab);
      if (!victim) throw Error('活动页面较多，请先关闭或暂停部分播放页面。');
      this.destroyView(victim[0]);
    }
    // Electron otherwise omits registered frame preloads from child frames.
    // The hard sandbox and isolated world remain mandatory: the capture E2E
    // asserts no Node or privileged bridge is visible to any page or iframe.
    const view = new WebContentsView({ ...(options?.webContents ? { webContents: options.webContents } : {}),
      webPreferences: { ...options?.webPreferences, ...this.pagePreferences() } });
    owner.contentView.addChildView(view); view.setVisible(false);
    this.views.set(tab.id, { view, used: Date.now() }); tab.discarded = false;
    const contents = view.webContents; contents.setAudioMuted(tab.muted); contents.setZoomFactor(tab.zoom);
    contents.once('destroyed', () => {
      // window.close() must remove its tab as well. Explicit closes/evictions
      // remove the map entry first and must not recursively open another page.
      if (this.views.get(tab.id)?.view !== view) return;
      this.views.delete(tab.id); this.navigationVersions.delete(tab.id); this.invalidateText(tab.id); this.textVersions.delete(tab.id); this.capture?.cancelTab(tab.id);
      if (owner.isDestroyed()) return;
      owner.contentView.removeChildView(view);
      this.pageAction(() => this.closeTab(tab.id));
    });
    // Retain Chromium/Electron's real identity. Removing Electron from the UA
    // cannot make an embedded user agent a provider-supported OAuth browser.
    const refresh = () => {
      if (contents.isDestroyed() || !this.store.data.tabs.includes(tab)) return;
      tab.loading = contents.isLoading(); tab.canGoBack = contents.navigationHistory.canGoBack(); tab.canGoForward = contents.navigationHistory.canGoForward();
      const entries = contents.navigationHistory.getAllEntries(); const index = contents.navigationHistory.getActiveIndex();
      const start = Math.max(0, Math.min(index - 14, entries.length - 30));
      if (entries.length && entries.every(entry => isBrowserUrl(entry.url))) this.store.data.navigation[tab.id] = { entries: entries.slice(start, start + 30).map(entry => ({ url: entry.url.slice(0, 8192), title: entry.title.slice(0, 500) })), index: index - start };
      tab.audible = contents.isCurrentlyAudible(); this.layout(); this.changed();
    };
    contents.on('did-start-loading', () => { tab.error = undefined; refresh(); });
    contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      this.invalidateText(tab.id);
      if (!mainFrame || inPlace) return;
      this.rememberSignInSource(tab.id, url, contents.getURL());
      this.navigationVersions.set(tab.id, (this.navigationVersions.get(tab.id) ?? 0) + 1);
      if (isBrowserUrl(url)) tab.url = url.slice(0, 8192);
    });
    contents.on('did-redirect-navigation', (_event, url, _inPlace, mainFrame) => { if (mainFrame && isBrowserUrl(url)) { this.rememberSignInSource(tab.id, url, contents.getURL()); tab.url = url.slice(0, 8192); } });
    contents.on('did-stop-loading', () => {
      // An attachment starts a navigation but never replaces the document.
      // Once it stops, display the committed page rather than the download URL.
      const committed = contents.getURL();
      if (isBrowserUrl(committed)) tab.url = committed.slice(0, 8192);
      refresh();
    });
    contents.on('page-title-updated', (_event, title) => { tab.title = (tab.url === BROWSER_HOME && this.searchPages.has(tab.id) ? '搜索 · ' + this.searchPages.get(tab.id)!.query.slice(0, 100) : title.trim() || (tab.url === BROWSER_HOME ? '新标签页' : tab.url)).slice(0, 500); const visited = this.store.data.history.find(item => item.url === tab.url); if (visited) visited.title = tab.title; refresh(); });
    const navigated = (url: string) => { if (!isBrowserUrl(url)) return; tab.url = url.slice(0, 8192); tab.error = undefined; this.store.visit(tab.url, tab.title); refresh(); };
    contents.on('did-navigate', (_event, url) => navigated(url));
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) navigated(url); });
    const refreshMedia = () => {
      if (contents.isDestroyed() || !this.store.data.tabs.includes(tab)) return;
      const audible = contents.isCurrentlyAudible();
      if (audible !== tab.audible) { tab.audible = audible; this.changed(false); }
    };
    contents.on('media-started-playing', refreshMedia); contents.on('media-paused', refreshMedia);
    contents.on('audio-state-changed', refreshMedia);
    contents.on('did-finish-load', () => { if (!contents.isDestroyed()) contents.setZoomFactor(tab.zoom); });
    contents.on('zoom-changed', (_event, direction) => { tab.zoom = Math.max(.25, Math.min(5, Math.round((tab.zoom + (direction === 'in' ? .1 : -.1)) * 100) / 100)); contents.setZoomFactor(tab.zoom); this.changed(); });
    contents.on('found-in-page', (_event, result) => { if (tab.id === this.store.data.activeTabId) { this.find = { matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal }; this.changed(false); } });
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (mainFrame && !shouldIgnoreBrowserLoadError(code, description) && url === tab.url) {
        tab.error = formatBrowserLoadError(code, description); tab.loading = false; this.layout(); this.changed();
      }
    });
    contents.on('render-process-gone', () => { this.invalidateText(tab.id); this.companionActivity.cancel(tab.id); tab.error = '页面进程已退出，请重新加载。'; tab.loading = false; tab.discarded = true; this.layout(); this.changed(); });
    contents.on('will-navigate', (event, url) => { if (!isBrowserUrl(url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!isBrowserUrl(url)) event.preventDefault(); });
    contents.setWindowOpenHandler(details => {
      if (details.url.length > 8192 || !isBrowserUrl(details.url)) return { action: 'deny' };
      try {
        this.attachOwner();
        if (this.store.data.tabs.length >= 50) throw Error('最多保留 50 个标签页，请先关闭部分页面。');
        if (this.views.size >= MAX_LIVE_PAGES && !this.evictionCandidate(tab.id)) throw Error('活动页面较多，请先关闭或暂停部分播放页面。');
      } catch (error) { this.reportPageError(error); return { action: 'deny' }; }
      return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: this.pagePreferences() }, createWindow: options => {
        // Electron supplies the native guest through this runtime option. It
        // must be adopted verbatim to preserve opener, POST and navigation.
        const supplied = options as Electron.WebContentsViewConstructorOptions;
        try {
          const companion = this.companionActivity.state().activities.find(activity => activity.tabId === tab.id && ['click', 'key'].includes(activity.action));
          const child = this.addTab(details.url, details.disposition === 'background-tab' || !!companion, false, supplied, tab.id);
          if (companion) this.companionOpenedTabs.set(child.id, companion.companionId);
          this.rememberSignInSource(child.id, details.url, tab.url);
          const childContents = this.views.get(child.id)!.view.webContents;
          // OpenURLFromTab can omit a native guest. In that path a custom
          // createWindow callback also owns the initial navigation.
          if (!supplied.webContents) {
            const post = details.postBody;
            void this.load(child, details.url, { httpReferrer: details.referrer, ...(post ? {
              postData: post.data, extraHeaders: 'content-type: ' + post.contentType + (post.boundary ? '; boundary=' + post.boundary : '') } : {}) });
          }
          this.layout(); this.changed(); return childContents;
        } catch (error) {
          // Capacity or owner lifetime can change between admission and native
          // creation. Complete Electron's identity contract, then close the
          // rejected guest without an uncaught main-process exception.
          this.reportPageError(error);
          const rejected = supplied.webContents ?? new WebContentsView({ webPreferences: this.pagePreferences() }).webContents;
          queueMicrotask(() => { if (!rejected.isDestroyed()) rejected.close(); });
          return rejected;
        }
      } };
    });
    contents.on('enter-html-full-screen', () => {
      this.previousFullscreen = owner.isFullScreen(); this.fullscreen = true; owner.setFullScreen(true); this.layout(); this.changed(false);
    });
    contents.on('leave-html-full-screen', () => { this.fullscreen = false; owner.setFullScreen(this.previousFullscreen); this.layout(); this.changed(false); });
    contents.on('before-input-event', (event, input) => { if (input.type === 'keyDown') this.pageAction(() => {
      if (this.fullscreenShortcut?.(input)) { event.preventDefault(); if (!input.isAutoRepeat) this.act('fullscreen'); return; }
      if (this.shortcut(input.key, input.control || input.meta, input.shift, input.alt)) event.preventDefault();
    }); });
    contents.on('context-menu', (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      const selectionVersion = this.textVersions.get(tab.id) ?? 0;
      const selectedSnapshot = params.formControlType !== 'input-password' ? params.selectionText : '';
      if (params.linkURL && isBrowserUrl(params.linkURL)) items.push({ label: '在新标签页打开链接', click: () => this.pageAction(() => { this.addTab(params.linkURL, true); this.changed(); }) }, { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
      if (params.srcURL && (isBrowserUrl(params.srcURL) || params.srcURL.startsWith('blob:'))) items.push({ label: '下载此内容', click: () => contents.downloadURL(params.srcURL) });
      if (params.isEditable) items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' });
      else if (params.selectionText) items.push({ label: '复制', click: () => contents.copy() });
      if (params.formControlType !== 'input-password' && params.selectionText.trim() && this.onSelection) items.push({ label: 'AI 划词助手', click: () => { void this.onSelection!(params.selectionText).catch(error => this.reportPageError(error)); } });
      items.push({ type: 'separator' }, { label: '后退', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() }, { label: '前进', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() }, { label: '重新加载', click: () => contents.reload() }, { label: '检查页面', click: () => contents.inspectElement(params.x, params.y) });
      const popup = async () => {
        const frame = params.frame ?? contents.mainFrame;
        if (this.capture && params.srcURL && ['image', 'video', 'audio'].includes(params.mediaType) && /^https?:\/\//.test(params.srcURL)) {
          try { const captureItems = await this.capture.contextMenu({ tabId: tab.id, contents, frame, sourcePageUrl: /^https?:\/\//.test(frame.url) ? frame.url : contents.getURL() }, params.mediaType as 'image' | 'video' | 'audio', params.srcURL);
            items.unshift(...captureItems, { type: 'separator' }); }
          catch { items.unshift({ label: '资产采集暂不可用', enabled: false }); }
        }
        if (this.capture && /^https?:\/\//.test(frame.url)) {
          const source = this.bindTextSource({ tabId: tab.id, contents, frame, sourcePageUrl: frame.url }, selectionVersion);
          const documentSave = (kind: 'page' | 'text') => { void this.saveDocument(source, kind).then(result => { if (!result.ok) this.reportPageError(Error(result.error)); }).catch(error => this.reportPageError(error)); };
          items.unshift({ label: '保存当前网页到资产库', click: () => documentSave('page') });
          if (selectedSnapshot.trim()) items.unshift({ label: '保存选中文字到资产库', click: () => {
            void this.capture!.saveText(source, undefined, { text: selectedSnapshot, title: browserTextTitle(selectedSnapshot) })
              .then(result => { if (!result.ok) this.reportPageError(Error(result.error)); }).catch(error => this.reportPageError(error));
          } });
          if (params.linkURL && /^https?:\/\//.test(params.linkURL)) {
            try { const files = await this.capture.contextMenu(source, 'file', params.linkURL); items.unshift(...files); } catch { /* Ordinary page links may not be downloadable files. */ }
          }
        }
        if (!contents.isDestroyed() && !owner.isDestroyed() && !frame.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: owner });
      };
      void popup();
    });
    if (navigate) this.restoreNavigation(tab, contents); return view;
  }
  private restoreNavigation(tab: BrowserTab, contents: Electron.WebContents): void {
    const saved = this.store.data.navigation[tab.id];
    const load = saved && saved.entries.length && saved.index < saved.entries.length && saved.entries.every(entry => isBrowserUrl(entry.url))
      ? contents.navigationHistory.restore({ entries: saved.entries, index: saved.index }) : this.load(tab, tab.url);
    const version = this.navigationVersions.get(tab.id);
    void load.catch(error => {
      if (!contents.isDestroyed() && this.views.get(tab.id)?.view.webContents === contents
        && this.navigationVersions.get(tab.id) === version && !shouldIgnoreBrowserLoadError(error)) {
        tab.error = formatBrowserLoadError(error); this.layout(); this.changed();
      }
    });
  }
  private async load(tab: BrowserTab, url: string, options?: Electron.LoadURLOptions): Promise<void> {
    if (!isBrowserUrl(url)) throw Error('拒绝打开不受支持的网页地址。');
    tab.url = url; tab.error = undefined; const view = this.ensureView(tab, false); this.layout();
    let version = this.navigationVersions.get(tab.id);
    try { const loading = view.webContents.loadURL(url, options); version = this.navigationVersions.get(tab.id); await loading; }
    catch (error) { if (!view.webContents.isDestroyed() && this.views.get(tab.id)?.view === view
      && this.navigationVersions.get(tab.id) === version && !shouldIgnoreBrowserLoadError(error)) {
      tab.loading = false; tab.error = formatBrowserLoadError(error); this.layout(); this.changed();
    } }
  }
  private destroyView(id: string): void {
    const entry = this.views.get(id); if (!entry) return;
    this.pages.forget(entry.view.webContents.id);
    for (const controller of this.companionPages.values()) controller.forget(entry.view.webContents.id);
    this.companionActivity.cancel(id);
    this.invalidateText(id); this.capture?.cancelTab(id); this.owner?.contentView.removeChildView(entry.view); this.views.delete(id); this.navigationVersions.delete(id); this.textVersions.delete(id);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    const tab = this.store.data.tabs.find(item => item.id === id); if (tab) { tab.discarded = true; tab.loading = false; }
  }
  private rememberSignInSource(id: string, destination: string, source: string): void {
    if (!isRestrictedBrowserSignIn(destination)) { this.signInSources.delete(id); return; }
    const site = externalBrowserUrl(source);
    if (site && !isRestrictedBrowserSignIn(site)) this.signInSources.set(id, site);
  }
  private addTab(url = BROWSER_HOME, background = false, navigate = true, popupOptions?: Electron.WebContentsViewConstructorOptions, protectedTab?: string): BrowserTab {
    if (this.store.data.tabs.length >= 50) throw Error('最多保留 50 个标签页，请先关闭部分页面。');
    if (!isBrowserUrl(url)) throw Error('无效的网页地址。');
    const previous = this.store.data.activeTabId;
    const tab = newBrowserTab(url); if (popupOptions && url === BROWSER_HOME) tab.nativeBlank = true; this.store.data.tabs.push(tab);
    if (!background || popupOptions) {
      if (!background) { this.invalidateText(); this.store.data.activeTabId = tab.id; }
      try { this.ensureView(tab, navigate, popupOptions, protectedTab); } catch (error) { this.destroyView(tab.id); this.store.data.tabs = this.store.data.tabs.filter(item => item.id !== tab.id); this.store.data.activeTabId = previous; this.layout(); throw error; }
      this.layout();
    }
    this.changed(); return tab;
  }
  private select(id: string): void {
    const tab = this.store.data.tabs.find(item => item.id === id); if (!tab) throw Error('标签页不存在。');
    const previous = this.store.data.activeTabId; if (previous !== id) this.invalidateText(); this.store.data.activeTabId = id;
    try { this.ensureView(tab); } catch (error) { this.store.data.activeTabId = previous; this.layout(); throw error; }
    this.layout(); this.changed();
  }
  private closeTab(id: string): void {
    const index = this.store.data.tabs.findIndex(item => item.id === id); if (index < 0) return;
    this.companionActivity.forget(id); this.companionOpenedTabs.delete(id);
    const [closed] = this.store.data.tabs.splice(index, 1); if (closed) { this.store.data.closedTabs.unshift(closed); this.store.data.closedTabs.length = Math.min(20, this.store.data.closedTabs.length); }
    const retained = new Set([...this.store.data.tabs, ...this.store.data.closedTabs].map(tab => tab.id));
    for (const key of Object.keys(this.store.data.navigation)) if (!retained.has(key)) delete this.store.data.navigation[key];
    this.destroyView(id);
    this.signInSources.delete(id);
    this.searchPages.delete(id); if (this.agentClosingTab !== id) this.ai.closedTab(id);
    if (!this.store.data.tabs.length) this.addTab();
    else if (this.store.data.activeTabId === id) this.select(this.store.data.tabs[Math.min(index, this.store.data.tabs.length - 1)]!.id);
    this.layout(); this.changed();
  }
  private layout(): void {
    const host = this.owner; if (!host || host.isDestroyed()) return;
    const size = host.getContentBounds();
    const bounds = this.fullscreen ? { x: 0, y: 0, width: size.width, height: size.height } : { x: Math.min(this.bounds.x, size.width), y: Math.min(this.bounds.y, size.height),
      width: Math.max(0, Math.min(this.bounds.width, size.width - this.bounds.x)), height: Math.max(0, Math.min(this.bounds.height, size.height - this.bounds.y)) };
    for (const [id, entry] of this.views) {
      const tab = this.store.data.tabs.find(tab => tab.id === id);
      const visible = this.visible && id === this.store.data.activeTabId && bounds.width > 0 && bounds.height > 0 && !tab?.error && (tab?.url !== BROWSER_HOME || tab.nativeBlank === true);
      const backgroundCapture = !visible && this.companionActivity.busy(id);
      // Reapplying native bounds/visibility during media and subframe events
      // needlessly invalidates the compositor's video surface.
      if (visible || backgroundCapture) {
        const current = entry.view.getBounds();
        const target = bounds.width > 0 && bounds.height > 0 ? bounds : { x: 0, y: 0, width: 1024, height: 768 };
        if (current.x !== target.x || current.y !== target.y || current.width !== target.width || current.height !== target.height) entry.view.setBounds(target);
      }
      // Child views always cover the host WebContents on Windows, even at
      // index zero. Hidden capture must never expose a page over chat.
      if (entry.view.getVisible() !== visible) entry.view.setVisible(visible);
    }
  }
  private shortcut(key: string, ctrl: boolean, shift: boolean, alt: boolean): boolean {
    const lower = key.toLowerCase();
    const request = browserTabShortcut(key, ctrl, shift, alt, this.store.data.tabs, this.store.data.activeTabId);
    if (request) { void this.handle(request).catch(error => this.reportPageError(error)); return true; }
    if (ctrl && ['l', 'f'].includes(lower)) { this.getWindow()?.webContents.send(BROWSER_FOCUS, lower === 'l' ? 'address' : 'find'); return true; }
    if (ctrl && lower === 't') { if (shift) this.restore(); else this.addTab(); return true; }
    if (ctrl && lower === 'w') { this.closeTab(this.active().id); return true; }
    if ((ctrl && lower === 'r') || key === 'F5') { this.act('reload'); return true; }
    if (alt && ['ArrowLeft', 'ArrowRight'].includes(key)) { this.act(key === 'ArrowLeft' ? 'back' : 'forward'); return true; }
    if (key === 'F11' && !this.fullscreenShortcut) { this.act('fullscreen'); return true; }
    if (key === 'Escape' && this.fullscreen) { void this.views.get(this.active().id)?.view.webContents.executeJavaScript('if(document.fullscreenElement)document.exitFullscreen()'); return true; }
    if (ctrl && ['+', '=', '-', '0'].includes(key)) { const tab = this.active(); tab.zoom = key === '0' ? 1 : Math.max(.25, Math.min(5, tab.zoom + (key === '-' ? -.1 : .1))); this.ensureView(tab).webContents.setZoomFactor(tab.zoom); this.changed(); return true; }
    return false;
  }
  private restore(): void {
    const tab = this.store.data.closedTabs.shift(); if (!tab) return;
    try { const restored = this.addTab(tab.url, false, false); restored.title = tab.title; restored.pinned = tab.pinned; restored.zoom = tab.zoom; restored.muted = tab.muted;
      if (this.store.data.navigation[tab.id]) this.store.data.navigation[restored.id] = structuredClone(this.store.data.navigation[tab.id]!);
      const contents = this.ensureView(restored, false).webContents; contents.setZoomFactor(tab.zoom); contents.setAudioMuted(tab.muted); this.restoreNavigation(restored, contents); this.changed();
    } catch (error) { this.store.data.closedTabs.unshift(tab); throw error; }
  }
  private act(action: Extract<BrowserRequest, { type: 'tab.action' }>['action']): void {
    const tab = this.active();
    if (action === 'mute') { this.setMuted(tab.id, !tab.muted); return; }
    if (action === 'pin') { this.tabCommand(tab.id, 'pin'); return; }
    const contents = this.ensureView(tab).webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === 'reload') { if (tab.discarded) void this.load(tab, tab.url); else contents.reload(); }
    if (action === 'stop') contents.stop();
    if (action === 'home') void this.load(tab, this.store.data.preferences.homepage);
    if (action === 'fullscreen') this.owner?.setFullScreen(!this.owner.isFullScreen());
    if (action === 'devtools') contents.openDevTools({ mode: 'detach' });
    this.changed();
  }
  private requireTab(id: string): BrowserTab {
    const tab = this.store.data.tabs.find(item => item.id === id);
    if (!tab) throw Error('标签页已关闭，请重试。');
    return tab;
  }
  private setMuted(id: string, muted: boolean): void {
    const tab = this.requireTab(id);
    // Updating an unloaded/background tab must not create or select a page.
    const contents = this.views.get(id)?.view.webContents;
    if (contents && !contents.isDestroyed()) contents.setAudioMuted(muted);
    tab.muted = muted; this.changed();
  }
  private tabCommand(id: string, command: Extract<BrowserRequest, { type: 'tab.command' }>['command']): void {
    const tab = this.requireTab(id);
    if (command === 'reload') this.ensureView(tab).webContents.reload();
    if (command === 'pin') { tab.pinned = !tab.pinned; this.store.data.tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned)); }
    if (command === 'duplicate') {
      const navigation = this.store.data.navigation[id];
      const copy = this.addTab(tab.url, false, false);
      copy.title = tab.title; copy.zoom = tab.zoom; copy.muted = tab.muted; copy.pinned = tab.pinned;
      const search = this.searchPages.get(tab.id); if (search) this.searchPages.set(copy.id, structuredClone(search));
      const tabs = this.store.data.tabs; tabs.splice(tabs.indexOf(copy), 1); tabs.splice(tabs.indexOf(tab) + 1, 0, copy);
      if (navigation) this.store.data.navigation[copy.id] = structuredClone(navigation);
      const contents = this.ensureView(copy, false).webContents;
      contents.setZoomFactor(copy.zoom); contents.setAudioMuted(copy.muted); this.restoreNavigation(copy, contents);
    }
    if (command === 'closeOthers' || command === 'closeRight') {
      const tabs = this.store.data.tabs;
      const closing = tabs.filter((item, index) => item.id !== id && !item.pinned && (command === 'closeOthers' || index > tabs.indexOf(tab))).map(item => item.id);
      // Select the survivor once; closing a batch must not load intermediate tabs.
      if (closing.includes(this.store.data.activeTabId!)) this.select(id);
      for (const closingId of closing) this.closeTab(closingId);
    }
    this.layout(); this.changed();
  }
  private tabContextMenu(id: string, locale: 'zh-CN' | 'en'): void {
    const tab = this.requireTab(id); const owner = this.attachOwner();
    const zh = locale === 'zh-CN';
    const command = (value: Extract<BrowserRequest, { type: 'tab.command' }>['command']) => () => this.pageAction(() => this.tabCommand(id, value));
    const tabs = this.store.data.tabs; const index = tabs.indexOf(tab);
    Menu.buildFromTemplate([
      { id: 'browser-tab-reload', label: zh ? '重新加载标签页' : 'Reload tab', click: command('reload') },
      { id: 'browser-tab-duplicate', label: zh ? '复制标签页' : 'Duplicate tab', enabled: tabs.length < 50, click: command('duplicate') },
      { type: 'separator' },
      { id: 'browser-tab-pin', label: zh ? (tab.pinned ? '取消固定标签页' : '固定标签页') : (tab.pinned ? 'Unpin tab' : 'Pin tab'), click: command('pin') },
      { id: 'browser-tab-mute', label: zh ? '静音此标签页' : 'Mute tab', type: 'checkbox', checked: tab.muted,
        click: item => this.pageAction(() => this.setMuted(id, item.checked)) },
      { type: 'separator' },
      { id: 'browser-tab-close', label: zh ? '关闭标签页' : 'Close tab', click: () => this.pageAction(() => this.closeTab(id)) },
      { id: 'browser-tab-close-others', label: zh ? '关闭其他标签页' : 'Close other tabs', enabled: tabs.some(item => item.id !== id && !item.pinned), click: command('closeOthers') },
      { id: 'browser-tab-close-right', label: zh ? '关闭右侧标签页' : 'Close tabs to the right', enabled: tabs.slice(index + 1).some(item => !item.pinned), click: command('closeRight') },
      { type: 'separator' },
      { id: 'browser-tab-restore', label: zh ? '恢复关闭的标签页' : 'Reopen closed tab', enabled: this.store.data.closedTabs.length > 0, click: () => this.pageAction(() => this.restore()) },
    ]).popup({ window: owner });
  }
  private async savePage(): Promise<void> {
    const tab = this.active(); const contents = this.ensureView(tab).webContents;
    const filename = [...tab.title].map(char => char.charCodeAt(0) < 32 ? '_' : char).join('').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'webpage';
    const selected = await dialog.showSaveDialog(this.attachOwner(), { title: '保存网页', defaultPath: filename + '.mhtml', filters: [{ name: '网页存档', extensions: ['mhtml'] }] });
    if (selected.canceled || !selected.filePath) return;
    if (contents.isDestroyed() || !this.store.data.tabs.includes(tab)) throw Error('标签页已关闭，无法保存网页。');
    await contents.savePage(selected.filePath, 'MHTML');
  }
  private async waitForPage(tab: BrowserTab, signal: AbortSignal): Promise<void> {
    const contents = this.ensureView(tab).webContents;
    await delay(80, undefined, { signal });
    while (!contents.isDestroyed() && contents.isLoadingMainFrame()) await delay(80, undefined, { signal });
    signal.throwIfAborted(); if (contents.isDestroyed()) throw Error('页面已关闭。'); if (tab.error) throw Error(tab.error);
  }
  /** Shares ordinary tabs and their Session. Never selects/focuses a user's tab. */
  async companionTool(scope: CompanionBrowserScope, raw: CompanionBrowserArguments, signal?: AbortSignal): Promise<CompanionBrowserResult> {
    signal?.throwIfAborted(); await this.init(); signal?.throwIfAborted();
    const input = companionBrowserArgumentsSchema.parse(raw);
    this.companionActivity.assertAllowed('tabId' in input ? input.tabId : undefined);
    if (input.action === 'tabs') return { value: { tabs: this.store.data.tabs.map(({ id, title, url, loading, muted }) => ({ id, title, url, loading, muted,
      active: id === this.store.data.activeTabId, openedBy: this.companionOpenedTabs.get(id), paused: this.companionActivity.state().pausedTabIds.includes(id) })) } };
    const existing = input.action === 'open' ? this.store.data.tabs.find(tab => tab.url === new URL(input.url).href || tab.url === input.url) : undefined;
    const tab = input.action === 'open' ? existing ?? this.addTab(input.url, true) : this.requireTab(input.tabId);
    if (input.action === 'open' && !existing) this.companionOpenedTabs.set(tab.id, scope.companionId);
    // Closing is explicit. Ending a read never closes or discards the page.
    if (input.action === 'tab' && input.operation === 'close') {
      if (this.companionOpenedTabs.get(tab.id) !== scope.companionId) throw Error('只能自主关闭本人打开的标签页；用户已有标签页请交由用户关闭。');
      this.closeTab(tab.id); return { value: { closed: true, tabId: tab.id } };
    }
    return this.companionActivity.run(scope, tab.id, input.action, signal, async current => {
      const view = this.ensureView(tab), contents = view.webContents; this.layout();
      let releaseViewport: (() => Promise<void>) | undefined;
      const scopeKey = `${scope.companionId}:${scope.conversationId}`;
      let controller = this.companionPages.get(scopeKey);
      if (!controller) { controller = new BrowserPageController(id => this.navigationVersions.get(id) ?? 0, 'companion:' + scopeKey); this.companionPages.set(scopeKey, controller); }
      const confirm = async (description: string) => {
        current.throwIfAborted();
        const result = await dialog.showMessageBox(this.attachOwner(), { type: 'question', title: scope.companionName + ' · 浏览器操作', message: description,
          detail: '请核对此操作是否符合你的当前意愿。', buttons: ['取消', '允许这次操作'], defaultId: 0, cancelId: 0, noLink: true });
        current.throwIfAborted(); return result.response === 1;
      };
      const navigating = input.action === 'open' || input.action === 'navigate' || input.action === 'tab' && ['reload', 'back', 'forward'].includes(input.operation);
      const cancel = () => { if (navigating && !contents.isDestroyed()) contents.stop(); };
      current.addEventListener('abort', cancel, { once: true });
      try {
        if (input.action === 'navigate') await this.load(tab, input.url);
        if (input.action === 'tab') {
          if (input.operation === 'mute' || input.operation === 'unmute') this.setMuted(tab.id, input.operation === 'mute');
          if (input.operation === 'reload') contents.reload();
          if (input.operation === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
          if (input.operation === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        }
        await this.waitForPage(tab, current); current.throwIfAborted();
        releaseViewport = await companionViewport(contents, view.getBounds());
        const version = this.navigationVersions.get(tab.id), pageUrl = contents.getURL();
        let value: unknown;
        if (input.action === 'observe') value = await controller.observe(tab.id, contents, input);
        else if (input.action === 'read') value = await controller.read(tab.id, contents, input.offset, input.length);
        else if (input.action === 'screenshot') {
          if (tab.url === BROWSER_HOME && !tab.nativeBlank) throw Error('原生起始页没有网页图像，请先打开网站。');
          await delay(120, undefined, { signal: current });
          const image = await companionScreenshot(contents, current);
          current.throwIfAborted();
          if (version !== this.navigationVersions.get(tab.id) || image.isEmpty()) throw Error('页面正在跳转或图像为空，请重新查看。');
          return { value: { tabId: tab.id, url: pageUrl, title: tab.title, capturedAt: new Date().toISOString() }, screenshot: image.toPNG() };
        } else if (['click', 'hover', 'fill', 'select'].includes(input.action)) value = await controller.act(tab.id, contents, input.action as 'click' | 'hover' | 'fill' | 'select', input, confirm, current);
        else if (input.action === 'key') value = await controller.key(contents, input.key, confirm, current);
        else if (input.action === 'scroll') value = await controller.scroll(contents, input.direction, input.pixels);
        else if (input.action === 'wait') { await delay(input.ms, undefined, { signal: current }); value = { waited: input.ms }; }
        else if (input.action === 'video') value = await companionVideo(contents, input);
        else value = { url: tab.url, title: tab.title, success: true };
        // Native input is dispatched asynchronously; retain the actual call
        // while its immediate navigation/popup is being delivered.
        if (input.action === 'click' || input.action === 'key') await delay(120, undefined, { signal: current });
        current.throwIfAborted();
        if (!this.store.data.tabs.includes(tab)) throw Error('标签页已关闭。');
        if (['read', 'observe', 'video'].includes(input.action) && version !== this.navigationVersions.get(tab.id)) throw Error('页面已跳转，请重新查看。');
        const snapshot = input.action === 'observe' ? value : await controller.observe(tab.id, contents, { query: '', offset: 0, limit: 40 })
          .catch(error => ({ unavailable: true, reason: error instanceof Error ? error.message : String(error) }));
        return { value: { tabId: tab.id, result: value, page: { url: tab.url, title: tab.title, loading: contents.isLoading(), snapshot },
          tabs: this.store.data.tabs.map(({ id, title, url, loading, audible }) => ({ id, title, url, loading, audible, active: id === this.store.data.activeTabId })),
          observedAt: new Date().toISOString(), reused: input.action === 'open' ? !!existing : undefined } };
      } finally { current.removeEventListener('abort', cancel); await releaseViewport?.(); }
    });
  }
  private async agentTool(name: BrowserAgentToolName, input: Record<string, unknown>, signal: AbortSignal, confirm: (description: string) => Promise<boolean>): Promise<unknown> {
    signal.throwIfAborted();
    if (name === 'browser_tabs') return this.store.data.tabs.map(tab => ({ ...tab, active: tab.id === this.store.data.activeTabId }));
    if (name === 'browser_history') return this.store.history(String(input.query ?? ''), Number(input.offset ?? 0), Number(input.limit ?? 15));
    if (name === 'browser_bookmarks') {
      if (input.action === 'list') return { bookmarks: this.store.data.bookmarks.slice(Number(input.offset), Number(input.offset) + Number(input.limit)), total: this.store.data.bookmarks.length };
      if (input.action === 'remove') { if (!input.id || !this.store.data.bookmarks.some(bookmark => bookmark.id === input.id)) throw Error('请提供实际存在的收藏 ID。'); await this.handle({ type: 'bookmark.remove', id: String(input.id) }); }
      else await this.handle({ type: 'bookmark.save', title: String(input.title || this.active().title), folder: String(input.folder ?? '') });
      return { success: true };
    }
    if (name === 'browser_downloads') return this.store.data.downloads.slice(0, 30).map(({ id, filename, status, received, total }) => ({ id, filename, status, received, total }));
    if (name === 'browser_download_action') { await this.handle({ type: 'download.action', id: String(input.id), action: input.action as 'pause' | 'resume' | 'cancel' }); return { success: true }; }
    if (name === 'browser_wait') { await delay(Number(input.ms), undefined, { signal }); return { waited: Number(input.ms) }; }
    if (name === 'browser_navigate') {
      const url = browserAddress(String(input.url));
      if (input.newTab) { const tab = this.addTab(url); await this.waitForPage(tab, signal); return { tabId: tab.id, url: tab.url, title: tab.title }; }
      const tab = input.tabId ? this.requireTab(String(input.tabId)) : this.active(); this.select(tab.id);
      const loading = this.load(tab, url); const contents = this.ensureView(tab).webContents;
      const cancel = () => { if (!contents.isDestroyed()) contents.stop(); }; signal.addEventListener('abort', cancel, { once: true });
      try { await loading; await this.waitForPage(tab, signal); } finally { signal.removeEventListener('abort', cancel); }
      return { tabId: tab.id, url: tab.url, title: tab.title };
    }
    const tab = input.tabId ? this.requireTab(String(input.tabId)) : this.active();
    if (name === 'browser_tab') {
      const action = String(input.action);
      if (action === 'close') { this.agentClosingTab = tab.id; try { this.closeTab(tab.id); } finally { this.agentClosingTab = undefined; } }
      else if (action === 'select') this.select(tab.id);
      else if (action === 'mute' || action === 'unmute') this.setMuted(tab.id, action === 'mute');
      else if (action === 'duplicate' || action === 'pin' || action === 'reload') this.tabCommand(tab.id, action);
      else { this.select(tab.id); this.act(action as 'back' | 'forward'); }
      return { success: true, activeTabId: this.store.data.activeTabId };
    }
    if (tab.url === BROWSER_HOME && !tab.nativeBlank) {
      if (name === 'browser_observe' || name === 'browser_read') return { title: tab.title, url: tab.url, internal: true, results: this.searchPages.get(tab.id), note: 'Native start/search page. Use browser_navigate on a result URL to view the real website.' };
      throw Error('这是原生新标签页，请先打开网页。');
    }
    this.select(tab.id); const contents = this.ensureView(tab).webContents; await this.waitForPage(tab, signal);
    if (name === 'browser_page') {
      if (input.action === 'zoom') { if (typeof input.factor !== 'number') throw Error('请指定缩放比例。'); await this.handle({ type: 'tab.zoom', factor: input.factor }); }
      if (input.action === 'fullscreen') this.attachOwner().setFullScreen(true);
      if (input.action === 'exitFullscreen') this.attachOwner().setFullScreen(false);
      if (input.action === 'save') await this.handle({ type: 'page.save' });
      if (input.action === 'print') await this.handle({ type: 'page.print' });
      return { requested: true, note: ['save', 'print'].includes(String(input.action)) ? 'Native user dialog; do not claim the user saved/printed until they confirm.' : undefined };
    }
    if (name === 'browser_screenshot') { await this.saveScreenshot((await contents.capturePage()).toPNG(), 'webpage-' + Date.now() + '.png'); return { savedToAssetLibrary: true }; }
    if (name === 'browser_observe') return { tabId: tab.id, ...await this.pages.observe(tab.id, contents, { query: String(input.query), offset: Number(input.offset), limit: Number(input.limit) }) as Record<string, unknown> };
    if (name === 'browser_read') return { tabId: tab.id, ...await this.pages.read(tab.id, contents, Number(input.offset), Number(input.length)) };
    if (name === 'browser_scroll') return this.pages.scroll(contents, String(input.direction), Number(input.pixels));
    if (name === 'browser_key') { contents.focus(); return this.pages.key(contents, String(input.key), confirm, signal); }
    if (name === 'browser_find') { await this.handle({ type: 'find', text: String(input.text) }); return { requested: true, text: input.text }; }
    if (['browser_click', 'browser_fill', 'browser_select', 'browser_hover'].includes(name)) {
      contents.focus(); return this.pages.act(tab.id, contents, name.slice('browser_'.length) as 'click' | 'fill' | 'select' | 'hover', input, confirm, signal);
    }
    throw Error('此浏览器工具暂不可用。');
  }
  private resolvePermission(id: string, allow: boolean, remember: boolean): void {
    const pending = this.pendingPermissions.get(id); if (!pending) return;
    clearTimeout(pending.timer); this.pendingPermissions.delete(id);
    if (remember && Object.keys(this.store.data.sitePermissions).length < 200) { (this.store.data.sitePermissions[pending.origin] ??= {})[pending.permission] = allow; }
    pending.callback(allow); this.changed();
  }
  private trackDownload(item: DownloadItem): void {
    if (this.downloads.size >= 10) { item.cancel(); this.error = '最多同时进行 10 个下载，请稍后再试。'; this.changed(false); return; }
    const id = randomUUID();
    let filename = [...path.basename(item.getFilename())].map(char => char.charCodeAt(0) < 32 ? '_' : char).join('').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 220) || 'download';
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) filename = '_' + filename;
    let reservation: string | undefined;
    const releaseEmptyReservation = () => {
      if (!reservation) return;
      try { if (statSync(reservation).size === 0) unlinkSync(reservation); } catch { /* Chromium may already have removed the cancelled file. */ }
      reservation = undefined;
    };
    const record: BrowserDownload = { id, url: item.getURL().slice(0, 8192), filename, path: '', received: 0, total: Math.max(0, item.getTotalBytes()), status: 'progressing', startedAt: new Date().toISOString() };
    try {
      if (this.store.data.preferences.askDownloadLocation) item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), filename) });
      else {
        const directory = path.join(app.getPath('downloads'), 'WorldlineBox'); mkdirSync(directory, { recursive: true });
        const parsed = path.parse(filename); let destination = '';
        for (let suffix = 0; suffix < 1000; suffix++) {
          const candidate = path.join(directory, suffix ? `${parsed.name} (${suffix})${parsed.ext}` : filename);
          try { const handle = openSync(candidate, 'wx'); closeSync(handle); destination = candidate; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        if (!destination) throw Error('无法创建不重名的下载文件。'); reservation = destination; record.path = destination; item.setSavePath(destination);
      }
    } catch (error) {
      item.cancel(); releaseEmptyReservation(); record.status = 'interrupted'; record.error = String(error).slice(0, 500);
      this.store.data.downloads.unshift(record); this.store.data.downloads.length = Math.min(200, this.store.data.downloads.length); this.changed(); return;
    }
    this.store.data.downloads.unshift(record);
    // Keep live downloads even when completed history reaches its retention limit.
    this.downloads.set(id, item);
    let finished = 0; const available = 200 - this.downloads.size;
    this.store.data.downloads = this.store.data.downloads.filter(row => this.downloads.has(row.id) || finished++ < available);
    this.changed();
    const update = () => {
      record.received = Math.max(0, item.getReceivedBytes()); record.total = Math.max(0, item.getTotalBytes()); record.path = item.getSavePath() || record.path;
      record.status = item.isPaused() ? 'paused' : item.getState() === 'interrupted' ? 'interrupted' : 'progressing';
      if (!this.progressTimer) this.progressTimer = setTimeout(() => { this.progressTimer = undefined; this.changed(false); }, 300);
    };
    item.on('updated', update);
    item.once('done', (_event, status) => { record.status = status; record.received = Math.max(0, item.getReceivedBytes()); record.path = item.getSavePath() || record.path; if (status !== 'completed') releaseEmptyReservation(); this.downloads.delete(id); this.changed(); });
  }
  async handle(request: BrowserRequest): Promise<BrowserResponse> {
    await this.init(); if (request.type !== 'state') this.error = undefined;
    const ai = browserAiRequestSchema.safeParse(request);
    if (ai.success) { await this.ai.handle(ai.data); return { ok: true, state: this.state() }; }
    switch (request.type) {
      case 'companion.pause': if (request.tabId) this.requireTab(request.tabId); this.companionActivity.pause(request.paused, request.tabId); break;
      case 'activate': this.ensureView(this.active()); break;
      case 'state': return { ok: true, state: this.state() };
      case 'layout': this.visible = request.visible; this.bounds = request.bounds; this.layout(); return { ok: true };
      case 'tab.new': this.addTab(request.url ? browserAddress(request.url, this.store.data.preferences.searchEngine) : undefined, request.background); break;
      case 'tab.select': this.select(request.id); break;
      case 'tab.close': this.closeTab(request.id); break;
      case 'tab.restore': this.restore(); break;
      case 'tab.mute': this.setMuted(request.id, request.muted); return { ok: true, state: this.state() };
      case 'tab.command': this.tabCommand(request.id, request.command); return { ok: true, state: this.state() };
      case 'tab.contextMenu': this.tabContextMenu(request.id, request.locale); return { ok: true };
      case 'page.save': await this.savePage(); break;
      case 'page.results.reset': {
        const tab = this.store.data.tabs.find(item => item.id === request.id);
        if (!tab || tab.url !== BROWSER_HOME || tab.nativeBlank) throw Error('当前标签页不是原生搜索结果页。');
        const producerId = this.searchPages.get(tab.id)?.producerId;
        // Wait for the producer to stop before removing its result page, so
        // even a late network response cannot repopulate the reset tab.
        await this.ai.stopForResults(tab.id, producerId, this.aiSearchTabId === tab.id);
        this.searchPages.delete(tab.id); if (this.aiSearchTabId === tab.id) this.aiSearchTabId = undefined;
        tab.title = '新标签页'; delete tab.error; this.layout(); break;
      }
      case 'page.print': {
        const contents = this.ensureView(this.active()).webContents;
        // Always display the native print dialog; never silently select a printer.
        contents.print({ printBackground: true }, (success, reason) => {
          if (!success && reason !== 'cancelled') this.reportPageError(Error('打印失败：' + reason));
        }); break;
      }
      case 'tab.navigate': void this.load(this.active(), browserAddress(request.text, this.store.data.preferences.searchEngine)); break;
      case 'tab.action': this.act(request.action); break;
      case 'tab.openExternal': {
        const tab = this.active();
        const url = externalBrowserUrl(request.source === 'signInSite' && isRestrictedBrowserSignIn(tab.url) ? this.signInSources.get(tab.id) ?? tab.url : tab.url);
        if (!url) throw Error('当前页面不能在系统浏览器中打开。');
        try { await shell.openExternal(url); } catch { throw Error('无法打开系统默认浏览器，请检查系统默认应用设置。'); }
        break;
      }
      case 'tab.zoom': { const tab = this.active(); tab.zoom = request.factor; this.ensureView(tab).webContents.setZoomFactor(request.factor); break; }
      case 'find': {
        const contents = this.ensureView(this.active()).webContents;
        if (!request.text) { contents.stopFindInPage('clearSelection'); this.find = undefined; }
        // Electron's findNext starts a NEW session when true; our next flag
        // means advancing within the current session, so it is the inverse.
        else contents.findInPage(request.text, { forward: request.forward ?? true, findNext: !request.next });
        break;
      }
      case 'bookmark.save': { const tab = this.active(); const previous = request.id ? this.store.data.bookmarks.find(item => item.id === request.id) : this.store.data.bookmarks.find(item => item.url === tab.url);
        if (request.id && !previous) throw Error('收藏不存在。');
        if (!previous && (!isBrowserUrl(tab.url) || tab.url === 'about:blank')) throw Error('当前页面不能收藏。');
        if (previous) { previous.title = request.title; previous.folder = request.folder; } else { if (this.store.data.bookmarks.length >= 1000) throw Error('收藏已达到 1000 项上限。'); this.store.data.bookmarks.unshift({ id: randomUUID(), url: tab.url, title: request.title, folder: request.folder, createdAt: new Date().toISOString() }); } break; }
      case 'bookmark.remove': this.store.data.bookmarks = this.store.data.bookmarks.filter(item => item.id !== request.id); break;
      case 'history': return { ok: true, ...this.store.history(request.query, request.offset, request.limit) };
      case 'preferences.save': { const homepage = browserAddress(request.preferences.homepage); this.store.data.preferences = { ...request.preferences, homepage }; break; }
      case 'permission': this.resolvePermission(request.id, request.allow, request.remember); break;
      case 'download.action': { const record = this.store.data.downloads.find(item => item.id === request.id); if (!record) throw Error('下载记录不存在。'); const item = this.downloads.get(request.id);
        if (request.action === 'pause') { if (!item) throw Error('下载不在进行中。'); item.pause(); record.status = 'paused'; }
        if (request.action === 'resume') { if (!item?.canResume()) throw Error('无法继续此下载，请重新下载。'); item.resume(); }
        if (request.action === 'cancel') item?.cancel();
        if (request.action === 'retry') { if (!isBrowserUrl(record.url)) throw Error('此临时下载地址已失效，请回到原页面下载。'); this.ensureView(this.active()).webContents.downloadURL(record.url); }
        if (request.action === 'reveal' || request.action === 'open') { if (!record.path || !existsSync(record.path)) throw Error('下载文件不存在。'); if (request.action === 'reveal') shell.showItemInFolder(record.path); else { if (record.status !== 'completed') throw Error('文件尚未下载完成。'); const error = await shell.openPath(record.path); if (error) throw Error(error); } } break; }
      case 'download.records.remove': this.store.removeDownloadRecords(request.ids, new Set(this.downloads.keys())); break;
      case 'download.records.clear': this.store.removeDownloadRecords(undefined, new Set(this.downloads.keys())); break;
      case 'data.info': this.cacheBytes = await this.scope!.getCacheSize(); break;
      case 'data.clear': {
        const origin = request.origin ? this.origin(request.origin) : undefined; if (request.origin && !origin) throw Error('站点地址无效。');
        const dataTypes: NonNullable<Electron.ClearDataOptions['dataTypes']> = [];
        if (request.cache) dataTypes.push('cache');
        if (request.siteData) dataTypes.push('cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch');
        if (dataTypes.length) { await this.scope!.clearData({ dataTypes, ...(origin ? { origins: [origin] } : {}) }); await this.scope!.flushStorageData(); }
        if (request.history) this.store.data.history = origin ? this.store.data.history.filter(item => this.origin(item.url) !== origin) : [];
        if (request.downloads) this.store.removeDownloadRecords(undefined, new Set(this.downloads.keys()));
        if (request.siteData) { if (origin) delete this.store.data.sitePermissions[origin]; else this.store.data.sitePermissions = {}; }
        this.cacheBytes = await this.scope!.getCacheSize(); break;
      }
    }
    this.changed(); return { ok: true, state: this.state() };
  }
  async shutdown(): Promise<void> {
    this.companionActivity.pause(true); this.companionPages.clear();
    await this.initialization?.catch(() => undefined);
    await this.ai.shutdown();
    this.searchPages.clear(); this.aiSearchTabId = undefined;
    this.invalidateText();
    await this.capture?.shutdown();
    if (this.preloadRegistration) { this.scope?.unregisterPreloadScript(this.preloadRegistration); this.preloadRegistration = undefined; }
    clearTimeout(this.progressTimer);
    for (const id of this.pendingPermissions.keys()) this.resolvePermission(id, false, false);
    if (this.scope) { await this.scope.cookies.flushStore(); this.scope.flushStorageData(); }
    if (this.ready) await this.store.flush();
  }
}

export function registerBrowserIpc(getWindow: () => BrowserWindow | null | undefined, captureHooks?: BrowserCaptureHooks, onSelection?: (text: string) => Promise<void>, fullscreenShortcut?: (input: Electron.Input) => boolean, getModelConfig?: () => CompanionModelConfig): Pick<BrowserService, 'shutdown' | 'closeLibrary' | 'captureViewport' | 'selectedText' | 'saveScreenshot' | 'companionTool'> {
  let browser: BrowserService | undefined;
  ipcMain.handle(BROWSER_REQUEST, async (event, input: unknown): Promise<BrowserResponse> => {
    const owner = getWindow(); if (!owner || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return { ok: false, error: '无权访问浏览器。' };
    const request = browserRequestSchema.safeParse(input); if (!request.success) return { ok: false, error: '无效的浏览器请求。' };
    try { return await (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut, getModelConfig)).handle(request.data); }
    catch (error) { return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
  });
  ipcMain.handle(BROWSER_CAPTURE_REQUEST, async (event, input: unknown): Promise<BrowserCaptureResponse> => {
    const owner = getWindow(); if (!owner || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return { ok: false, error: '无权访问资产采集。' };
    const parsed = browserCaptureRequestSchema.safeParse(input); if (!parsed.success) return { ok: false, error: '无效的采集请求。' };
    try { return await (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut, getModelConfig)).captureRequest(parsed.data); }
    catch (error) { return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
  });
  ipcMain.handle(BROWSER_CAPTURE_CONTENT_REQUEST, (event, input: unknown): Promise<BrowserCaptureContentResponse> | BrowserCaptureContentResponse => {
    if (!browser) return { ok: false, code: 'unavailable', error: '浏览器尚未启动。' }; return browser.captureContent(event, input);
  });
  ipcMain.on(BROWSER_CAPTURE_SELECTION_STATE, (event, value: unknown) => browser?.captureSelectionState(event, value));
  return { shutdown: async () => { await browser?.shutdown(); }, closeLibrary: libraryId => browser?.closeLibrary(libraryId),
    companionTool: (scope, input, signal) => (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut, getModelConfig)).companionTool(scope, input, signal),
    captureViewport: () => (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut, getModelConfig)).captureViewport(),
    selectedText: () => (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut, getModelConfig)).selectedText(),
    saveScreenshot: (bytes, filename) => (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut, getModelConfig)).saveScreenshot(bytes, filename) };
}
