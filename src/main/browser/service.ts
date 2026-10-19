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
  private readonly textVersions = new Map<string, number>();
  private readonly textDrafts = new BrowserTextDrafts();
  private readonly selectionFrames = new Map<string, { frame: Electron.WebFrameMain; url: string; documentId: string }>();
  constructor(private readonly getWindow: () => BrowserWindow | null | undefined, private readonly root = path.join(app.getPath('userData'), 'browser'), private readonly captureHooks?: BrowserCaptureHooks, private readonly onSelection?: (text: string) => Promise<void>, private readonly fullscreenShortcut?: (input: Electron.Input) => boolean) {
    this.store = new BrowserStore(root, error => { this.error = '浏览器配置保存失败：' + String(error).slice(0, 600); this.changed(false); });
  }
  private init(): Promise<void> { return this.initialization ??= this.initialize(); }
  private async initialize(): Promise<void> {
    await this.store.init();
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
      downloads: structuredClone(this.store.data.downloads), historyCount: this.store.data.history.length, preferences: { ...this.store.data.preferences },
      permissions: [...this.pendingPermissions].map(([id, value]) => ({ id, origin: value.origin, permission: value.permission })),
      fullscreen: this.fullscreen, revision: this.revision, find: this.find, cacheBytes: this.cacheBytes, error: this.error, capture: this.capture?.state() };
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
      owner.webContents.on('render-process-gone', () => { this.visible = false; this.layout(); });
      owner.once('closed', () => { this.visible = false; this.invalidateText(); for (const [tabId, item] of this.views) { this.capture?.cancelTab(tabId); if (!item.view.webContents.isDestroyed()) item.view.webContents.close(); } this.views.clear(); });
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
    // A normal browser user agent avoids desktop-wrapper notices; TLS and web security stay enabled.
    contents.setUserAgent(contents.getUserAgent().replace(/\s(?:WorldlineBox|Electron)\/[\w.-]+/g, ''));
    const refresh = () => {
      if (contents.isDestroyed() || !this.store.data.tabs.includes(tab)) return;
      tab.loading = contents.isLoading(); tab.canGoBack = contents.navigationHistory.canGoBack(); tab.canGoForward = contents.navigationHistory.canGoForward();
      const entries = contents.navigationHistory.getAllEntries(); const index = contents.navigationHistory.getActiveIndex();
      const start = Math.max(0, Math.min(index - 14, entries.length - 30));
      if (entries.length && entries.every(entry => isBrowserUrl(entry.url))) this.store.data.navigation[tab.id] = { entries: entries.slice(start, start + 30).map(entry => ({ url: entry.url.slice(0, 8192), title: entry.title.slice(0, 500) })), index: index - start };
      tab.audible = contents.isCurrentlyAudible(); tab.zoom = contents.getZoomFactor(); this.layout(); this.changed();
    };
    contents.on('did-start-loading', () => { tab.error = undefined; refresh(); });
    contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      this.invalidateText(tab.id);
      if (!mainFrame || inPlace) return;
      this.navigationVersions.set(tab.id, (this.navigationVersions.get(tab.id) ?? 0) + 1);
      if (isBrowserUrl(url)) tab.url = url.slice(0, 8192);
    });
    contents.on('did-redirect-navigation', (_event, url, _inPlace, mainFrame) => { if (mainFrame && isBrowserUrl(url)) tab.url = url.slice(0, 8192); });
    contents.on('did-stop-loading', () => {
      // An attachment starts a navigation but never replaces the document.
      // Once it stops, display the committed page rather than the download URL.
      const committed = contents.getURL();
      if (isBrowserUrl(committed)) tab.url = committed.slice(0, 8192);
      refresh();
    });
    contents.on('page-title-updated', (_event, title) => { tab.title = (title.trim() || (tab.url === BROWSER_HOME ? '新标签页' : tab.url)).slice(0, 500); const visited = this.store.data.history.find(item => item.url === tab.url); if (visited) visited.title = tab.title; refresh(); });
    const navigated = (url: string) => { if (!isBrowserUrl(url)) return; tab.url = url.slice(0, 8192); tab.error = undefined; this.store.visit(tab.url, tab.title); refresh(); };
    contents.on('did-navigate', (_event, url) => navigated(url));
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) navigated(url); });
    contents.on('media-started-playing', refresh); contents.on('media-paused', refresh);
    contents.on('found-in-page', (_event, result) => { if (tab.id === this.store.data.activeTabId) { this.find = { matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal }; this.changed(false); } });
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (mainFrame && !shouldIgnoreBrowserLoadError(code, description) && url === tab.url) {
        tab.error = formatBrowserLoadError(code, description); tab.loading = false; this.layout(); this.changed();
      }
    });
    contents.on('render-process-gone', () => { this.invalidateText(tab.id); tab.error = '页面进程已退出，请重新加载。'; tab.loading = false; tab.discarded = true; this.layout(); this.changed(); });
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
          const child = this.addTab(details.url, details.disposition === 'background-tab', false, supplied, tab.id);
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
    this.invalidateText(id); this.capture?.cancelTab(id); this.owner?.contentView.removeChildView(entry.view); this.views.delete(id); this.navigationVersions.delete(id); this.textVersions.delete(id);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    const tab = this.store.data.tabs.find(item => item.id === id); if (tab) { tab.discarded = true; tab.loading = false; }
  }
  private addTab(url = BROWSER_HOME, background = false, navigate = true, popupOptions?: Electron.WebContentsViewConstructorOptions, protectedTab?: string): BrowserTab {
    if (this.store.data.tabs.length >= 50) throw Error('最多保留 50 个标签页，请先关闭部分页面。');
    if (!isBrowserUrl(url)) throw Error('无效的网页地址。');
    const previous = this.store.data.activeTabId;
    const tab = newBrowserTab(url); this.store.data.tabs.push(tab);
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
    const [closed] = this.store.data.tabs.splice(index, 1); if (closed) { this.store.data.closedTabs.unshift(closed); this.store.data.closedTabs.length = Math.min(20, this.store.data.closedTabs.length); }
    const retained = new Set([...this.store.data.tabs, ...this.store.data.closedTabs].map(tab => tab.id));
    for (const key of Object.keys(this.store.data.navigation)) if (!retained.has(key)) delete this.store.data.navigation[key];
    this.destroyView(id);
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
      const visible = this.visible && id === this.store.data.activeTabId && bounds.width > 0 && bounds.height > 0 && !this.store.data.tabs.find(tab => tab.id === id)?.error;
      if (visible) entry.view.setBounds(bounds); entry.view.setVisible(visible);
    }
  }
  private shortcut(key: string, ctrl: boolean, shift: boolean, alt: boolean): boolean {
    const lower = key.toLowerCase();
    if (ctrl && ['l', 'f'].includes(lower)) { this.getWindow()?.webContents.send(BROWSER_FOCUS, lower === 'l' ? 'address' : 'find'); return true; }
    if (ctrl && lower === 't') { if (shift) this.restore(); else this.addTab(); return true; }
    if (ctrl && lower === 'w') { this.closeTab(this.active().id); return true; }
    if (ctrl && lower === 'tab') { const tabs = this.store.data.tabs; const index = tabs.findIndex(item => item.id === this.store.data.activeTabId); this.select(tabs[(index + (shift ? tabs.length - 1 : 1)) % tabs.length]!.id); return true; }
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
    const tab = this.active(); const contents = this.ensureView(tab).webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === 'reload') { if (tab.discarded) void this.load(tab, tab.url); else contents.reload(); }
    if (action === 'stop') contents.stop();
    if (action === 'home') void this.load(tab, this.store.data.preferences.homepage);
    if (action === 'mute') { tab.muted = !tab.muted; contents.setAudioMuted(tab.muted); }
    if (action === 'pin') { tab.pinned = !tab.pinned; this.store.data.tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned)); }
    if (action === 'fullscreen') this.owner?.setFullScreen(!this.owner.isFullScreen());
    if (action === 'devtools') contents.openDevTools({ mode: 'detach' });
    this.changed();
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
    await this.init(); this.error = undefined;
    switch (request.type) {
      case 'activate': this.ensureView(this.active()); break;
      case 'state': break;
      case 'layout': this.visible = request.visible; this.bounds = request.bounds; this.layout(); return { ok: true };
      case 'tab.new': this.addTab(request.url ? browserAddress(request.url, this.store.data.preferences.searchEngine) : undefined, request.background); break;
      case 'tab.select': this.select(request.id); break;
      case 'tab.close': this.closeTab(request.id); break;
      case 'tab.restore': this.restore(); break;
      case 'tab.navigate': void this.load(this.active(), browserAddress(request.text, this.store.data.preferences.searchEngine)); break;
      case 'tab.action': this.act(request.action); break;
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
    await this.initialization?.catch(() => undefined);
    this.invalidateText();
    await this.capture?.shutdown();
    if (this.preloadRegistration) { this.scope?.unregisterPreloadScript(this.preloadRegistration); this.preloadRegistration = undefined; }
    clearTimeout(this.progressTimer);
    for (const id of this.pendingPermissions.keys()) this.resolvePermission(id, false, false);
    if (this.scope) { await this.scope.cookies.flushStore(); this.scope.flushStorageData(); }
    if (this.ready) await this.store.flush();
  }
}

export function registerBrowserIpc(getWindow: () => BrowserWindow | null | undefined, captureHooks?: BrowserCaptureHooks, onSelection?: (text: string) => Promise<void>, fullscreenShortcut?: (input: Electron.Input) => boolean): { shutdown(): Promise<void>; closeLibrary(libraryId: string): void; captureViewport(): Promise<CaptureImageSource>; selectedText(): Promise<string>; saveScreenshot(bytes: Uint8Array, filename: string): Promise<void> } {
  let browser: BrowserService | undefined;
  ipcMain.handle(BROWSER_REQUEST, async (event, input: unknown): Promise<BrowserResponse> => {
    const owner = getWindow(); if (!owner || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return { ok: false, error: '无权访问浏览器。' };
    const request = browserRequestSchema.safeParse(input); if (!request.success) return { ok: false, error: '无效的浏览器请求。' };
    try { return await (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut)).handle(request.data); }
    catch (error) { return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
  });
  ipcMain.handle(BROWSER_CAPTURE_REQUEST, async (event, input: unknown): Promise<BrowserCaptureResponse> => {
    const owner = getWindow(); if (!owner || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return { ok: false, error: '无权访问资产采集。' };
    const parsed = browserCaptureRequestSchema.safeParse(input); if (!parsed.success) return { ok: false, error: '无效的采集请求。' };
    try { return await (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut)).captureRequest(parsed.data); }
    catch (error) { return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
  });
  ipcMain.handle(BROWSER_CAPTURE_CONTENT_REQUEST, (event, input: unknown): Promise<BrowserCaptureContentResponse> | BrowserCaptureContentResponse => {
    if (!browser) return { ok: false, code: 'unavailable', error: '浏览器尚未启动。' }; return browser.captureContent(event, input);
  });
  ipcMain.on(BROWSER_CAPTURE_SELECTION_STATE, (event, value: unknown) => browser?.captureSelectionState(event, value));
  return { shutdown: async () => { await browser?.shutdown(); }, closeLibrary: libraryId => browser?.closeLibrary(libraryId),
    captureViewport: () => (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut)).captureViewport(),
    selectedText: () => (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut)).selectedText(),
    saveScreenshot: (bytes, filename) => (browser ??= new BrowserService(getWindow, undefined, captureHooks, onSelection, fullscreenShortcut)).saveScreenshot(bytes, filename) };
}
