import { WebContentsView, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { CAPTURE_TOOLS_ARGUMENT, type CaptureToolTask, type CaptureToolsRequest, type CaptureToolsResponse } from '../../shared/capture-tools';

interface Options { preloadPath: string; load(view: WebContentsView): Promise<void> }
/** Transparent native layer, rendering the same React menu as every other view.
 * The original browser stays attached, visible and live underneath. */
export class CaptureToolsMenu {
  private pending?: { view: WebContentsView; locale: 'zh-CN' | 'en'; show(): Promise<void>; finish(task?: CaptureToolTask, error?: unknown): void };
  constructor(private readonly options: Options) {}
  owns(event: IpcMainInvokeEvent): boolean { const contents = this.pending?.view.webContents; return !!contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame; }
  async handle(event: IpcMainInvokeEvent, request: CaptureToolsRequest): Promise<CaptureToolsResponse> {
    if (!this.owns(event)) return { ok: false, error: '工具列表已关闭。' };
    const pending = this.pending!;
    if (request.type === 'menu.context') return { ok: true, menuContext: { locale: pending.locale } };
    if (request.type === 'menu.ready') { await pending.show(); return { ok: true }; }
    if (request.type === 'menu.choose') { pending.finish(request.task); return { ok: true }; }
    return { ok: false, error: '工具列表不支持此操作。' };
  }
  open(owner: BrowserWindow, request: { locale: 'zh-CN' | 'en' }): Promise<CaptureToolTask | undefined> {
    if (this.pending) throw Error('全局工具列表已打开。');
    if (owner.isDestroyed() || owner.webContents.isDestroyed()) throw Error('主窗口已关闭。');
    return new Promise((resolve, reject) => {
      const view = new WebContentsView({ webPreferences: { preload: this.options.preloadPath, additionalArguments: [CAPTURE_TOOLS_ARGUMENT], session: owner.webContents.session,
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false } });
      view.setVisible(false); view.setBackgroundColor('#00000000');
      let settled = false, showing: Promise<void> | undefined;
      const layout = () => { if (owner.isDestroyed() || view.webContents.isDestroyed()) return; const { width, height } = owner.getContentBounds(); view.setBounds({ x: 0, y: 0, width, height }); view.webContents.setZoomFactor(owner.webContents.getZoomFactor()); };
      const finish = (task?: CaptureToolTask, error?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (this.pending?.view === view) this.pending = undefined;
        owner.removeListener('closed', close); owner.removeListener('resize', layout); owner.webContents.removeListener('did-start-navigation', navigation);
        try { if (!owner.isDestroyed()) owner.contentView.removeChildView(view); } catch { /* The owner may already have detached its views. */ } finally { if (!view.webContents.isDestroyed()) view.webContents.close(); }
        if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.focus();
        if (error) reject(error); else resolve(task);
      };
      const close = () => finish();
      const navigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => { if (details.isMainFrame && !details.isSameDocument) close(); };
      const timer = setTimeout(() => finish(undefined, Error('工具列表未能加载，请重试。')), 20000); timer.unref();
      this.pending = { view, locale: request.locale, finish, show: () => showing ??= (async () => {
        if (settled) return;
        await view.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true, stayAwake: true });
        if (settled || owner.isDestroyed() || view.webContents.isDestroyed()) return;
        clearTimeout(timer); layout(); view.setVisible(true); view.webContents.focus();
      })().catch(error => { finish(undefined, error); throw error; }) };
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', event => event.preventDefault()); view.webContents.on('will-attach-webview', event => event.preventDefault());
      view.webContents.once('render-process-gone', () => finish(undefined, Error('工具列表已退出，请重试。')));
      view.webContents.once('destroyed', close);
      owner.once('closed', close); owner.on('resize', layout); owner.webContents.on('did-start-navigation', navigation);
      try { owner.contentView.addChildView(view); layout(); void this.options.load(view).catch(error => finish(undefined, error)); }
      catch (error) { finish(undefined, error); }
    });
  }
  close(): void { this.pending?.finish(); }
}
