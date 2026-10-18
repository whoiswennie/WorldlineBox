import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Notification, type WebContents, type WebFrameMain } from 'electron';
import { z } from 'zod';
import {
  BROWSER_CAPTURE_CONTENT_EVENT, BROWSER_CAPTURE_HISTORY_LIMIT, BROWSER_CAPTURE_LOCAL_MAX_BYTES, BROWSER_CAPTURE_TEXT_MAX_BYTES, DEFAULT_BROWSER_CAPTURE_PREFERENCES,
  browserCaptureFolderNameSchema, browserCaptureJobSchema, browserCapturePreferencesSchema, browserCaptureTargetSchema,
  type BrowserCaptureContentEvent, type BrowserCaptureContentRequest, type BrowserCaptureFolder,
  type BrowserCaptureJob, type BrowserCaptureLibrary, type BrowserCapturePreferences, type BrowserCaptureRequest,
  type BrowserCaptureResponse, type BrowserCaptureState, type BrowserCaptureTarget, type BrowserCaptureKind, type BrowserCaptureRemoteKind,
} from '../../shared/browser-capture';
import { buildSaveMenuTree, sortFoldersForSaveMenu, type SaveMenuTreeFolder } from '../../../extension/folder-menu';
import { atomicJson, readJson } from '../dsh/files';
import { stageBrowserCapture, captureHttpUrl, readPickedCaptureImage, safeCaptureFilename, stageCaptureBytes, stagePickedCaptureFile, type StagedBrowserCapture } from './capture-download';
import { browserTextTitle } from './text-selection';

export interface BrowserCaptureTargets {
  libraries: BrowserCaptureLibrary[];
  activeLibraryId: string | null;
  defaultTarget: BrowserCaptureTarget | null;
  folders: BrowserCaptureFolder[];
  recentBrowsedFolderIds: string[];
}
export interface BrowserCaptureHooks {
  listTargets(libraryId?: string): Promise<BrowserCaptureTargets>;
  importStaged(input: StagedBrowserCapture & { target: BrowserCaptureTarget; kind: BrowserCaptureKind;
    sourcePageUrl?: string; mediaUrl?: string; preferences: BrowserCapturePreferences }): Promise<{ assetId: string; deduplicated?: boolean }>;
  createFolder?(input: { target: BrowserCaptureTarget; name: string }): Promise<string>;
  openAssets(): void;
}
export interface BrowserCaptureSource { tabId: string; contents: WebContents; frame: WebFrameMain; sourcePageUrl?: string; isCurrent?(): boolean }
const storedSchema = z.object({ preferences: browserCapturePreferencesSchema.default(DEFAULT_BROWSER_CAPTURE_PREFERENCES),
  target: browserCaptureTargetSchema.nullable().default(null), recent: z.record(z.string(), z.array(z.string().max(4096)).max(20)).default({}),
  history: z.array(browserCaptureJobSchema).max(BROWSER_CAPTURE_HISTORY_LIMIT + 4).catch([]).default([]) });
type Stored = z.infer<typeof storedSchema>;
type CaptureInput = { mediaUrl: string } | { pickedFile: string } | { bytes: Uint8Array; filename: string; contentType: string }
  | { local: Extract<Extract<BrowserCaptureContentRequest, { type: 'runtime.message' }>['message'], { type: 'worldlinebox-local-save-request' }> };
const preferenceKeys = { worldlineboxNotificationsEnabled: 'notificationsEnabled', worldlineboxFocusAppAfterSave: 'focusAppAfterSave',
  worldlineboxRevealInLibraryAfterSave: 'revealInLibrary', worldlineboxDragRadialMenuEnabled: 'dragRadialMenuEnabled' } as const;

export class BrowserCaptureHost {
  private stored: Stored = storedSchema.parse({});
  private targets: BrowserCaptureTargets = { libraries: [], activeLibraryId: null, defaultTarget: null, folders: [], recentBrowsedFolderIds: [] };
  private jobs: BrowserCaptureJob[] = [];
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<void>; committing: boolean }>();
  private readonly frameTargets = new Map<string, { url: string; target: BrowserCaptureTarget }>();
  private readonly libraryGenerations = new Map<string, number>();
  private writes = Promise.resolve();
  private closed = false;
  private initialized?: Promise<void>;
  private lastProgress = 0;
  private refreshSequence = 0;
  private pickingLocalImage = false;
  constructor(private readonly root: string, private readonly hooks: BrowserCaptureHooks,
    private readonly environment: { fetch(url: string, init: RequestInit): Promise<Response>; tempRoot: string;
      changed(): void; chooseLocalImage(): Promise<string | undefined>; chooseLocalFile?(): Promise<string | undefined>;
      sources(): BrowserCaptureSource[]; source(tabId?: string): BrowserCaptureSource | undefined }) {}
  private init(): Promise<void> { return this.initialized ??= (async () => { const saved = await readJson<unknown>(path.join(this.root, 'capture.json'));
    if (saved) this.stored = storedSchema.parse(saved);
    this.jobs = this.stored.history;
    let interrupted = false;
    for (const job of this.jobs) if (job.status === 'saving') { interrupted = true; job.status = 'cancelled'; job.message = '上次采集因应用退出而中断。'; job.finishedAt = new Date().toISOString(); }
    this.trimHistory(); if (interrupted) this.persist(); })(); }
  private trimHistory(): void { const active = this.jobs.filter(item => item.status === 'saving');
    this.jobs = [...active, ...this.jobs.filter(item => item.status !== 'saving').slice(0, BROWSER_CAPTURE_HISTORY_LIMIT)]; }
  private persist(): void { this.stored.history = this.jobs; const snapshot = structuredClone(this.stored); this.writes = this.writes.catch(() => undefined)
    .then(() => atomicJson(path.join(this.root, 'capture.json'), snapshot)).catch(error => { this.error = String(error).slice(0, 1000); }); }
  private error?: string;
  state(): BrowserCaptureState {
    const libraryId = this.stored.target?.libraryId;
    return { connected: this.targets.libraries.length > 0, libraries: this.targets.libraries, activeLibraryId: this.targets.activeLibraryId,
      target: this.stored.target, folders: this.targets.folders, recentFolderIds: libraryId ? this.stored.recent[libraryId] ?? [] : [],
      recentBrowsedFolderIds: this.targets.recentBrowsedFolderIds, preferences: { ...this.stored.preferences }, jobs: structuredClone(this.jobs.slice(0, 50)), error: this.error };
  }
  private async refresh(libraryId?: string): Promise<void> {
    await this.init();
    const sequence = ++this.refreshSequence;
    const targets = await this.hooks.listTargets(libraryId ?? this.stored.target?.libraryId);
    if (sequence !== this.refreshSequence) return;
    this.targets = targets;
    if (!this.stored.target || !this.targets.libraries.some(item => item.libraryId === this.stored.target!.libraryId)) this.stored.target = this.targets.defaultTarget;
    if (this.stored.target?.folderId && !this.targets.folders.some(item => item.folderId === this.stored.target!.folderId)) this.stored.target = { ...this.stored.target, folderId: null };
  }
  private key(source: BrowserCaptureSource): string { return source.frame.processId + ':' + source.frame.routingId; }
  private broadcast(event: BrowserCaptureContentEvent): void {
    for (const source of this.environment.sources()) { try { if (!source.frame.isDestroyed()) source.frame.send(BROWSER_CAPTURE_CONTENT_EVENT, event); } catch { /* A frame can navigate while preferences propagate. */ } }
    this.environment.changed();
  }
  private feedback(source: BrowserCaptureSource, value: Record<string, unknown>): void {
    try { if (!source.frame.isDestroyed()) source.frame.send(BROWSER_CAPTURE_CONTENT_EVENT, { type: 'runtime.message', message: { type: 'worldlinebox-save-feedback', ...value } }); } catch { /* Closed or navigated. */ }
  }
  private publicFailure(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
      .split(this.environment.tempRoot).join('[临时目录]').split(this.root).join('[浏览器配置]').slice(0, 1000);
  }
  private storage(): Record<string, boolean | string[]> { return { worldlineboxNotificationsEnabled: this.stored.preferences.notificationsEnabled,
    worldlineboxFocusAppAfterSave: this.stored.preferences.focusAppAfterSave, worldlineboxRevealInLibraryAfterSave: this.stored.preferences.revealInLibrary,
    worldlineboxDragRadialMenuEnabled: this.stored.preferences.dragRadialMenuEnabled,
    recentFolderIds: this.state().recentFolderIds }; }
  async content(request: BrowserCaptureContentRequest, source: BrowserCaptureSource): Promise<unknown> {
    await this.init();
    if (this.closed) throw Error('浏览器正在关闭。');
    if (request.type === 'storage.get') { const stored = this.storage(); return Object.fromEntries(request.keys.map(key => [key, stored[key]])); }
    if (request.type === 'storage.set') {
      const previous = this.storage();
      for (const [key, value] of Object.entries(request.values)) {
        if (key in preferenceKeys && typeof value === 'boolean') this.stored.preferences[preferenceKeys[key as keyof typeof preferenceKeys]] = value;
        // Saved-folder history is owned by successful imports, never by web content.
      }
      this.persist(); const next = this.storage(); const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const key of Object.keys(next)) if (next[key] !== previous[key]) changes[key] = { oldValue: previous[key], newValue: next[key] };
      this.broadcast({ type: 'storage.changed', area: request.area, changes }); return {};
    }
    const message = request.message;
    if (message.type === 'worldlinebox-connection-status') { await this.refresh(); return { kind: this.state().connected ? 'connected' : 'disconnected' }; }
    if (message.type === 'worldlinebox-list-folders') {
      await this.refresh(); const state = this.state();
      if (!state.target) return { kind: 'rejected' };
      this.frameTargets.set(this.key(source), { url: source.frame.url, target: { ...state.target } });
      if (this.frameTargets.size > 2000) this.frameTargets.delete(this.frameTargets.keys().next().value!);
      return { kind: 'ok', folders: sortFoldersForSaveMenu(state.folders, { savedRecentIds: state.recentFolderIds, browsedRecentIds: state.recentBrowsedFolderIds }),
        recentFolderIds: state.recentFolderIds, recentBrowsedFolderIds: state.recentBrowsedFolderIds,
        libraryDisplayName: state.libraries.find(item => item.libraryId === state.target!.libraryId)?.displayName };
    }
    const snapshot = this.frameTargets.get(this.key(source));
    if (!snapshot || snapshot.url !== source.frame.url) await this.refresh();
    const selected = snapshot?.url === source.frame.url ? snapshot.target : this.stored.target;
    if (!selected) return { notification: { title: '无法保存到 WorldlineBox', message: '请先打开资源库。' } };
    const target = { ...selected, folderId: message.type === 'worldlinebox-save-request'
      ? message.intent.targetFolderId === undefined ? selected.folderId : message.intent.targetFolderId
      : message.targetFolderId === undefined ? selected.folderId : message.targetFolderId };
    try {
      const job = await this.start(source, target, message.type === 'worldlinebox-save-request' ? message.intent.kind : message.kind,
        message.type === 'worldlinebox-save-request' ? { mediaUrl: message.intent.mediaUrl } : { local: message });
      await this.running.get(job.id)?.promise;
      return { notification: { title: job.status === 'saved' ? '已保存到 WorldlineBox' : '无法保存到 WorldlineBox', message: job.message } };
    } catch (error) { return { notification: { title: '无法保存到 WorldlineBox', message: String(error instanceof Error ? error.message : error).slice(0, 1000) } }; }
  }
  async handle(request: BrowserCaptureRequest): Promise<BrowserCaptureResponse> {
    try {
      await this.init(); this.error = undefined;
      if (this.closed) throw Error('浏览器正在关闭。');
      if (request.type === 'target.set') { await this.validateTarget(request.target); this.stored.target = { ...request.target }; this.persist(); }
      if (request.type === 'folder.create') {
        const target = browserCaptureTargetSchema.parse(request.target); const name = browserCaptureFolderNameSchema.parse(request.name);
        const generation = this.libraryGenerations.get(target.libraryId) ?? 0;
        await this.validateTarget(target); if (!this.hooks.createFolder) throw Error('当前资源库不支持创建文件夹。');
        if (generation !== (this.libraryGenerations.get(target.libraryId) ?? 0)) throw Error('目标资源库已关闭。');
        const folderId = await this.hooks.createFolder({ target, name });
        if (generation !== (this.libraryGenerations.get(target.libraryId) ?? 0)) throw Error('创建期间目标资源库已关闭。');
        const next = browserCaptureTargetSchema.parse({ libraryId: target.libraryId, folderId });
        await this.validateTarget(next); this.stored.target = next; this.persist(); await this.refresh(target.libraryId); this.environment.changed();
        return { ok: true, state: this.state(), folderId };
      }
      if (request.type === 'history.list') {
        const query = request.query?.trim().toLocaleLowerCase() ?? '';
        const filtered = this.jobs.filter(job => (!request.status || request.status === job.status) && (!request.kind || request.kind === job.kind)
          && (!query || [job.filename, job.message, job.kind, job.target.libraryId, job.target.folderId].some(value => value?.toLocaleLowerCase().includes(query))));
        const pageSize = Math.max(1, Math.min(100, Math.floor(request.pageSize ?? 20)));
        const page = Math.max(1, Math.min(Math.ceil(filtered.length / pageSize) || 1, Math.floor(request.page ?? 1)));
        await this.refresh(); return { ok: true, state: this.state(), history: { items: structuredClone(filtered.slice((page - 1) * pageSize, page * pageSize)), total: filtered.length, page, pageSize } };
      }
      if (request.type === 'history.clear') { this.jobs = this.jobs.filter(job => job.status === 'saving'); this.persist(); }
      if (request.type === 'preferences.save') {
        const previous = this.storage(); this.stored.preferences = { ...request.preferences }; this.persist(); const next = this.storage();
        this.broadcast({ type: 'storage.changed', area: 'sync', changes: Object.fromEntries(Object.keys(preferenceKeys).map(key => [key, { oldValue: previous[key], newValue: next[key] }])) });
      }
      if (request.type === 'cancel') { const running = this.running.get(request.id); if (running && !running.committing) running.controller.abort(Error('采集已取消。')); }
      if (request.type === 'open-assets') this.hooks.openAssets();
      if (request.type === 'local.open' || request.type === 'file.open') {
        if (this.pickingLocalImage) throw Error('请先完成已打开的图片选择。');
        await this.refresh(); const target = this.stored.target ? { ...this.stored.target } : null;
        if (!target) throw Error('请先打开并选择资源库。');
        const generation = this.libraryGenerations.get(target.libraryId) ?? 0;
        this.pickingLocalImage = true;
        let filename: string | undefined;
        try { if (request.type === 'file.open' && !this.environment.chooseLocalFile) throw Error('文件选择不可用。');
          filename = await (request.type === 'file.open' ? this.environment.chooseLocalFile!() : this.environment.chooseLocalImage()); } finally { this.pickingLocalImage = false; }
        if (!filename) return { ok: true, state: this.state() };
        if ((this.libraryGenerations.get(target.libraryId) ?? 0) !== generation) throw Error('选择图片期间目标资源库已关闭，请重新采集。');
        const job = request.type === 'file.open' ? await this.start(undefined, target, 'file', { pickedFile: filename }, true)
          : await this.start(this.environment.source(), target, 'image', { local: { type: 'worldlinebox-local-save-request', kind: 'image', ...await readPickedCaptureImage(filename) } }, true);
        return { ok: true, state: this.state(), jobId: job.id };
      }
      if (request.type === 'save') {
        await this.refresh(); const source = this.environment.source(request.tabId); if (!source) throw Error('找不到活动网页。');
        const target = request.target ?? this.stored.target; if (!target) throw Error('请先选择资源库。');
        const job = await this.start(source, target, request.kind, { mediaUrl: request.mediaUrl });
        return { ok: true, state: this.state(), jobId: job.id };
      }
      if (request.type === 'page.save' || request.type === 'text.save' || request.type === 'text.prepare') throw Error('请从活动网页采集当前内容。');
      await this.refresh(); this.environment.changed(); return { ok: true, state: this.state() };
    } catch (error) { this.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000); return { ok: false, error: this.error, state: this.state() }; }
  }
  private async validateTarget(target: BrowserCaptureTarget): Promise<BrowserCaptureTargets> {
    const listed = await this.hooks.listTargets(target.libraryId);
    if (!listed.libraries.some(item => item.libraryId === target.libraryId && !item.readOnly)) throw Error('目标资源库未打开或不可写。');
    if (target.folderId && !listed.folders.some(item => item.libraryId === target.libraryId && item.folderId === target.folderId && item.available !== false)) throw Error('目标文件夹不存在或链接已离线，请重新选择。');
    return listed;
  }
  /** Called only after Main has obtained the current document's real selection. */
  async saveText(source: BrowserCaptureSource, target: BrowserCaptureTarget | undefined, input: { text: string; title?: string; format?: 'txt' | 'md' }): Promise<BrowserCaptureResponse> {
    return this.saveDocument(source, target, 'text', input);
  }
  /** A durable readable snapshot. It deliberately contains no executable HTML. */
  async savePage(source: BrowserCaptureSource, target: BrowserCaptureTarget | undefined, input: { title: string; text?: string }): Promise<BrowserCaptureResponse> {
    return this.saveDocument(source, target, 'page', { title: input.title, text: input.text ?? '', format: 'txt' });
  }
  private async saveDocument(source: BrowserCaptureSource, target: BrowserCaptureTarget | undefined, kind: 'text' | 'page', input: { text: string; title?: string; format?: 'txt' | 'md' }): Promise<BrowserCaptureResponse> {
    try {
      await this.refresh(); const selected = target ?? this.stored.target; if (!selected) throw Error('请先选择资源库。');
      const text = input.text.replaceAll('\0', ''); if (kind === 'text' && !text.trim()) throw Error('请先选中需要保存的文字。');
      if (Buffer.byteLength(text, 'utf8') > BROWSER_CAPTURE_TEXT_MAX_BYTES - (kind === 'page' ? 16_384 : 0)) throw Error('网页文字超过 4 MiB 上限。');
      const title = (input.title?.replace(/[\r\n]/g, ' ').trim() || (kind === 'page' ? '网页快照' : browserTextTitle(text))).slice(0, 180);
      const pageUrl = captureHttpUrl(source.sourcePageUrl ?? source.frame.url);
      const body = kind === 'text' ? text : `${title}\n来源：${pageUrl}\n采集时间：${new Date().toISOString()}\n\n${text.trim()}\n`;
      const format = input.format === 'md' ? 'md' : 'txt';
      const job = await this.start(source, selected, kind, { bytes: Buffer.from(body, 'utf8'), filename: safeCaptureFilename(title) + '.' + format,
        contentType: format === 'md' ? 'text/markdown' : 'text/plain' });
      return { ok: true, state: this.state(), jobId: job.id };
    } catch (error) { return { ok: false, state: this.state(), error: this.publicFailure(error) }; }
  }
  /** Owned bytes from the screenshot editor, never an arbitrary filesystem path. */
  async saveBytes(source: BrowserCaptureSource | undefined, target: BrowserCaptureTarget | undefined,
    input: { bytes: Uint8Array; filename: string; contentType: string; kind?: 'screenshot' }): Promise<BrowserCaptureResponse> {
    try {
      await this.refresh(); const selected = target ?? this.stored.target; if (!selected) throw Error('请先选择资源库。');
      if (input.contentType !== 'image/png') throw Error('截图必须是 PNG 图片。');
      const job = await this.start(source, selected, 'screenshot', { bytes: input.bytes, filename: input.filename, contentType: input.contentType }, !source);
      return { ok: true, state: this.state(), jobId: job.id };
    } catch (error) { return { ok: false, state: this.state(), error: this.publicFailure(error) }; }
  }
  /** A utility editor must report success after the Worker commit, not merely
   * after a capture job was queued. The original job remains valid if its
   * completed history entry is cleared while the import is finishing. */
  async waitForJob(id: string, timeoutMs = 60_000): Promise<BrowserCaptureJob> {
    const job = this.jobs.find(item => item.id === id); if (!job) throw Error('找不到此采集任务。');
    const runtime = this.running.get(id); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (runtime) await Promise.race([runtime.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('资源仍在后台导入，请稍后在采集记录中确认结果。')), timeoutMs); timer.unref();
      })]);
      if (job.status !== 'saved') throw Error(job.message || '资源未能保存。');
      return structuredClone(job);
    } finally { clearTimeout(timer); }
  }
  private async start(source: BrowserCaptureSource | undefined, target: BrowserCaptureTarget, kind: BrowserCaptureKind, input: CaptureInput, localPicker = false): Promise<BrowserCaptureJob> {
    if (this.closed) throw Error('浏览器正在关闭。');
    if (this.running.size >= 4) throw Error('最多同时采集 4 个媒体，请稍后再试。');
    const sourcePageUrl = localPicker ? undefined : captureHttpUrl(source!.sourcePageUrl ?? source!.frame.url);
    if ('mediaUrl' in input) captureHttpUrl(input.mediaUrl);
    const generation = this.libraryGenerations.get(target.libraryId) ?? 0;
    await this.validateTarget(target);
    if ((this.libraryGenerations.get(target.libraryId) ?? 0) !== generation) throw Error('目标资源库已关闭。');
    if (this.closed || (!localPicker && (!source || source.contents.isDestroyed() || source.frame.isDestroyed() || source.isCurrent?.() === false))) throw Error('采集页面已关闭或跳转，请重新采集。');
    if (this.running.size >= 4) throw Error('最多同时采集 4 个媒体，请稍后再试。');
    const job: BrowserCaptureJob = { id: randomUUID(), tabId: source?.tabId ?? 'local-content', target: { ...target }, kind, status: 'saving', message: 'mediaUrl' in input ? '正在下载资源…' : '正在准备资源…', startedAt: new Date().toISOString() };
    const controller = new AbortController(); const preferences = { ...this.stored.preferences };
    const runtime = { controller, promise: Promise.resolve(), committing: false };
    this.jobs.unshift(job);
    this.trimHistory(); this.persist();
    if (source) this.feedback(source, { state: 'saving' }); this.environment.changed();
    this.running.set(job.id, runtime);
    runtime.promise = (async () => {
      let staged: StagedBrowserCapture | undefined;
      const timer = setTimeout(() => controller.abort(Error('媒体下载超时。')), 5 * 60_000); timer.unref();
      try {
        if ('mediaUrl' in input) staged = await stageBrowserCapture({ ...this.environment, mediaUrl: input.mediaUrl, sourcePageUrl: sourcePageUrl!, kind: kind as BrowserCaptureRemoteKind, signal: controller.signal,
          onProgress: (receivedBytes, totalBytes) => { job.receivedBytes = receivedBytes; job.totalBytes = totalBytes;
            if (Date.now() - this.lastProgress > 250) { this.lastProgress = Date.now(); this.environment.changed(); } } });
        else if ('pickedFile' in input) staged = await stagePickedCaptureFile({ filename: input.pickedFile, tempRoot: this.environment.tempRoot, signal: controller.signal });
        else if ('bytes' in input) staged = await stageCaptureBytes({ ...input, tempRoot: this.environment.tempRoot,
          kind: kind === 'screenshot' ? 'image' : 'file', signal: controller.signal, ...(kind === 'text' ? { literalText: true } : {}) });
        else {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.local.bodyBase64)) throw Error('图片数据无效。');
          const bytes = Buffer.from(input.local.bodyBase64, 'base64');
          if (!bytes.length || bytes.length > BROWSER_CAPTURE_LOCAL_MAX_BYTES) throw Error('本地图片超过 32 MiB 上限。');
          staged = await stageCaptureBytes({ tempRoot: this.environment.tempRoot, bytes, filename: input.local.filename,
            contentType: input.local.contentType, kind: input.local.kind, signal: controller.signal });
        }
        controller.signal.throwIfAborted(); await this.validateTarget(job.target); controller.signal.throwIfAborted();
        if (source?.isCurrent?.() === false) throw Error('采集页面已切换或跳转，请重新采集。');
        runtime.committing = true; clearTimeout(timer); job.message = '正在导入资源库…'; job.filename = staged.filename; this.environment.changed();
        const result = await this.hooks.importStaged({ ...staged, target: job.target, kind, sourcePageUrl,
          ...('mediaUrl' in input ? { mediaUrl: input.mediaUrl } : {}), preferences });
        job.assetId = result.assetId; job.deduplicated = result.deduplicated; job.status = 'saved'; job.message = '已保存到资源库。';
        this.trimHistory();
        if (job.target.folderId) this.stored.recent[job.target.libraryId] = [job.target.folderId, ...(this.stored.recent[job.target.libraryId] ?? []).filter(id => id !== job.target.folderId)].slice(0, 20);
        this.persist();
      } catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.message = this.publicFailure(error); this.trimHistory(); }
      finally {
        clearTimeout(timer); if (staged) await rm(staged.stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        this.running.delete(job.id); job.finishedAt = new Date().toISOString();
        this.trimHistory(); this.persist();
        if (source) this.feedback(source, { state: 'done', title: job.status === 'saved' ? '已保存到 WorldlineBox' : '采集未完成', message: job.message });
        if (!this.closed && preferences.notificationsEnabled && Notification.isSupported()) { try { new Notification({ title: job.status === 'saved' ? '已保存到 WorldlineBox' : '采集未完成', body: job.message, silent: true }).show(); } catch { /* Saving succeeds even when system notifications are unavailable. */ } }
        this.environment.changed();
      }
    })();
    return job;
  }
  async contextMenu(source: BrowserCaptureSource, kind: BrowserCaptureRemoteKind, mediaUrl: string): Promise<Electron.MenuItemConstructorOptions[]> {
    await this.refresh();
    const save = (target: BrowserCaptureTarget) => { void this.start(source, target, kind, { mediaUrl }).catch(error => this.feedback(source, { state: 'done', title: '无法采集', message: String(error).slice(0, 1000) })); };
    const libraryMenus = await Promise.all(this.targets.libraries.filter(library => !library.readOnly).map(async library => {
      const listed = await this.hooks.listTargets(library.libraryId);
      const folder = (entry: SaveMenuTreeFolder): Electron.MenuItemConstructorOptions => ({ label: entry.name,
        ...(entry.children.length ? { submenu: [ ...(entry.folderId ? [{ label: '保存到此文件夹', click: () => save({ libraryId: library.libraryId, folderId: entry.folderId }) }, { type: 'separator' as const }] : []), ...entry.children.map(folder) ] }
          : { enabled: !!entry.folderId, click: () => save({ libraryId: library.libraryId, folderId: entry.folderId }) }) });
      const tree = buildSaveMenuTree(listed.folders.filter(folder => folder.libraryId === library.libraryId && folder.available !== false), { savedRecentIds: this.stored.recent[library.libraryId] ?? [], browsedRecentIds: listed.recentBrowsedFolderIds });
      return { label: library.displayName, submenu: [{ label: '保存到根目录', click: () => save({ libraryId: library.libraryId, folderId: null }) },
        ...(tree.length ? [{ type: 'separator' as const }] : []), ...tree.map(item => item.kind === 'separator' ? { type: 'separator' as const } : folder(item.folder))] };
    }));
    return [{ label: '保存到 WorldlineBox', enabled: libraryMenus.length > 0, submenu: libraryMenus.length ? libraryMenus : [{ label: '请先打开资源库', enabled: false }] }];
  }
  cancelTab(tabId: string): void { for (const job of this.jobs) { const running = this.running.get(job.id); if (job.tabId === tabId && running && !running.committing) running.controller.abort(Error('页面已关闭。')); } }
  cancelTextTab(tabId?: string): void { for (const job of this.jobs) { const running = this.running.get(job.id); if (job.kind === 'text' && (!tabId || job.tabId === tabId) && running && !running.committing) running.controller.abort(Error('采集页面已切换或跳转，请重新选择文字。')); } }
  closeLibrary(libraryId: string): void {
    this.libraryGenerations.set(libraryId, (this.libraryGenerations.get(libraryId) ?? 0) + 1);
    for (const job of this.jobs) { const running = this.running.get(job.id); if (job.target.libraryId === libraryId && running && !running.committing) running.controller.abort(Error('目标资源库已关闭。')); }
    for (const [key, value] of this.frameTargets) if (value.target.libraryId === libraryId) this.frameTargets.delete(key);
    if (this.stored.target?.libraryId === libraryId) this.stored.target = null;
    this.refreshSequence++;
    this.targets = { ...this.targets, libraries: this.targets.libraries.filter(library => library.libraryId !== libraryId),
      folders: this.targets.folders.filter(folder => folder.libraryId !== libraryId),
      activeLibraryId: this.targets.activeLibraryId === libraryId ? null : this.targets.activeLibraryId,
      defaultTarget: this.targets.defaultTarget?.libraryId === libraryId ? null : this.targets.defaultTarget,
      recentBrowsedFolderIds: this.targets.defaultTarget?.libraryId === libraryId ? [] : this.targets.recentBrowsedFolderIds };
    this.environment.changed();
  }
  async shutdown(): Promise<void> { this.closed = true; for (const runtime of this.running.values()) if (!runtime.committing) runtime.controller.abort(Error('应用正在关闭。'));
    await Promise.allSettled([...this.running.values()].map(item => item.promise)); await this.writes; }
}
