import { totalmem } from 'node:os';
import { isCurrentDocumentReload } from '../renderer-navigation';
import { COMPANION_WORLD_WINDOW_ARGUMENT, COMPANION_WORLD_WINDOW_CHANNEL, COMPANION_WORLD_WINDOW_CHANGED_CHANNEL,
  COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL, companionWorldContactSchema, companionWorldWindowCommandSchema,
  type CompanionWorldContact, type CompanionWorldWindowContext, type CompanionWorldWindowOpen, type CompanionWorldWindowResult } from '../../shared/companion-world-window';
import type { CompanionsRequest, CompanionsResponse } from '../../shared/companions';

export interface WorldObserverWindow {
  readonly webContents: { readonly mainFrame: unknown; getURL(): string; send(channel: string, value?: unknown): void;
    setWindowOpenHandler(handler: () => { action: 'deny' }): unknown;
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown };
  isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean; isMaximized(): boolean;
  show(): void; minimize(): void; maximize(): void; unmaximize(): void; close(): void; destroy(): void;
  setMenu(menu: null): void;
  on(event: 'closed' | 'show' | 'hide' | 'minimize' | 'restore', listener: () => void): unknown;
}
export interface WorldObserverIpcEvent { sender: unknown; senderFrame: unknown }
export interface WorldObserverIpc {
  handle(channel: string, listener: (event: WorldObserverIpcEvent, input: unknown) => Promise<CompanionWorldWindowResult>): void;
  removeHandler(channel: string): void;
}
export interface WorldObserverWindowOptions {
  width: number; height: number; minWidth: number; minHeight: number; show: boolean; title: string; backgroundColor: string; frame: boolean; autoHideMenuBar: boolean;
  webPreferences: { preload: string; sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean; additionalArguments: string[] };
}
interface Entry { window: WorldObserverWindow; slot: number; input: CompanionWorldWindowOpen }

/** Observers own only native windows. Physics, jobs and SQLite remain in the existing companion service. */
export class CompanionWorldWindowManager {
  private readonly entries = new Set<Entry>();
  private disposed = false;
  private snapshot?: { promise: Promise<CompanionsResponse>; at: number; pending: boolean };
  private contacts?: { promise: Promise<CompanionWorldContact[]>; at: number; pending: boolean };
  constructor(private readonly options: {
    ipc: WorldObserverIpc; getMainWindow: () => Pick<WorldObserverWindow, 'webContents' | 'isDestroyed'> | undefined;
    createWindow: (options: WorldObserverWindowOptions) => WorldObserverWindow;
    load: (window: WorldObserverWindow) => Promise<void>; preload: string;
    request: (request: CompanionsRequest) => Promise<CompanionsResponse>; report: (error: unknown) => void;
  }) {}

  register(): void { this.options.ipc.handle(COMPANION_WORLD_WINDOW_CHANNEL, (event, input) => this.handle(event, input)); }
  private entry(event: WorldObserverIpcEvent): Entry | undefined {
    return [...this.entries].find(entry => !entry.window.isDestroyed() && entry.window.webContents === event.sender && entry.window.webContents.mainFrame === event.senderFrame);
  }
  private mayOpen(event: WorldObserverIpcEvent): boolean {
    const main = this.options.getMainWindow();
    return !!this.entry(event) || !!main && !main.isDestroyed() && main.webContents === event.sender && main.webContents.mainFrame === event.senderFrame;
  }
  private visibleWindowCount(): number { return [...this.entries].filter(entry => !entry.window.isDestroyed() && entry.window.isVisible() && !entry.window.isMinimized()).length; }
  private send(entry: Entry, channel: string, value?: unknown): void {
    try { if (!entry.window.isDestroyed()) entry.window.webContents.send(channel, value); }
    catch { /* The renderer can disappear before its native closed event. */ }
  }
  private visibility(): void {
    const visibleWindowCount = this.visibleWindowCount();
    for (const entry of this.entries) this.send(entry, COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL,
      { visibleWindowCount, visible: entry.window.isVisible() && !entry.window.isMinimized() });
  }
  changed(): void {
    this.snapshot = undefined;
    this.contacts = undefined;
    for (const entry of this.entries) this.send(entry, COMPANION_WORLD_WINDOW_CHANGED_CHANNEL);
  }
  private world(): Promise<CompanionsResponse> {
    if (this.snapshot && (this.snapshot.pending || Date.now() - this.snapshot.at < 200)) return this.snapshot.promise;
    const cached = { promise: Promise.resolve({ ok: false } as CompanionsResponse), at: Date.now(), pending: true };
    cached.promise = this.options.request({ type: 'world.snapshot' }).then(response => { cached.pending = false; cached.at = Date.now(); return response; }, error => {
      if (this.snapshot === cached) this.snapshot = undefined; throw error;
    }); this.snapshot = cached; return cached.promise;
  }
  private async context(entry: Entry): Promise<CompanionWorldWindowContext> {
    if (!this.contacts || !this.contacts.pending && Date.now() - this.contacts.at >= 200) {
      const cached = { promise: Promise.resolve([] as CompanionWorldContact[]), at: Date.now(), pending: true };
      cached.promise = this.options.request({ type: 'state' }).then(response => {
        if (!response.ok || !response.state) throw new Error('World contacts unavailable.');
        const projection = response.state.companions.map(companion => companionWorldContactSchema.parse(companion));
        cached.pending = false; cached.at = Date.now(); return projection;
      }).catch(error => { if (this.contacts === cached) this.contacts = undefined; throw error; });
      this.contacts = cached;
    }
    const contacts = await this.contacts.promise;
    return { observerKey: 'companion-world-observer' + (entry.slot ? '-' + entry.slot : ''), ...entry.input,
      companions: contacts,
      totalMemoryBytes: totalmem(),
      visible: entry.window.isVisible() && !entry.window.isMinimized(), visibleWindowCount: this.visibleWindowCount() };
  }
  private async open(event: WorldObserverIpcEvent, input: CompanionWorldWindowOpen): Promise<CompanionWorldWindowResult> {
    const response = await this.world();
    if (!response.ok || !response.world || input.sceneId && !response.world.scenes.some(scene => scene.id === input.sceneId)
      || input.companionId && !response.world.residents.some(resident => resident.companionId === input.companionId)) return { ok: false, error: '观察地点或伙伴不存在。' };
    if (this.disposed || !this.mayOpen(event)) return { ok: false, error: '世界窗口的打开请求已经结束。' };
    let slot = 0; while ([...this.entries].some(entry => entry.slot === slot)) slot++;
    const window = this.options.createWindow({ width: 1280, height: 850, minWidth: 720, minHeight: 520, show: false,
      frame: true, title: '伙伴世界 · WorldlineBox', backgroundColor: '#111417', autoHideMenuBar: true,
      webPreferences: { preload: this.options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: [COMPANION_WORLD_WINDOW_ARGUMENT] } });
    const entry = { window, slot, input }; this.entries.add(entry);
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (navigation, url) => { if (!isCurrentDocumentReload(window.webContents.getURL(), url)) navigation.preventDefault(); });
    window.on('closed', () => { this.entries.delete(entry); this.visibility(); });
    for (const name of ['show', 'hide', 'minimize', 'restore'] as const) window.on(name, () => this.visibility());
    try { await this.options.load(window); if (!window.isDestroyed() && !this.disposed) window.show(); return { ok: true }; }
    catch (error) { this.entries.delete(entry); if (!window.isDestroyed()) window.destroy(); this.options.report(error); return { ok: false, error: '世界窗口暂时无法打开。' }; }
  }
  private async handle(event: WorldObserverIpcEvent, input: unknown): Promise<CompanionWorldWindowResult> {
    if (this.disposed || !this.mayOpen(event)) return { ok: false, error: '无权访问世界窗口。' };
    const parsed = companionWorldWindowCommandSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '世界窗口请求格式不正确。' };
    try {
      const command = parsed.data;
      if (command.type === 'open') { const { type: _type, ...target } = command; void _type; return await this.open(event, target); }
      const entry = this.entry(event); if (!entry) return { ok: false, error: '此请求只属于独立世界窗口。' };
      if (command.type === 'context') return { ok: true, context: await this.context(entry) };
      if (command.type === 'request') {
        if (command.request.type === 'world.snapshot') return { ok: true, response: await this.world() };
        const response = await this.options.request(command.request); this.changed(); return { ok: true, response };
      }
      const window = entry.window;
      if (command.action === 'close') { window.close(); return { ok: true }; }
      if (command.action === 'minimize') window.minimize();
      else if (command.action === 'maximize-toggle') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      return { ok: true, maximized: !window.isDestroyed() && window.isMaximized() };
    } catch (error) { this.options.report(error); return { ok: false, error: '世界窗口请求暂时无法完成。' }; }
  }
  dispose(): void {
    this.disposed = true; this.options.ipc.removeHandler(COMPANION_WORLD_WINDOW_CHANNEL);
    for (const entry of [...this.entries]) if (!entry.window.isDestroyed()) entry.window.destroy();
    this.entries.clear(); this.snapshot = undefined; this.contacts = undefined;
  }
  closeAll(): void {
    for (const entry of [...this.entries]) if (!entry.window.isDestroyed()) entry.window.destroy();
    this.entries.clear(); this.snapshot = undefined; this.contacts = undefined;
  }
}
