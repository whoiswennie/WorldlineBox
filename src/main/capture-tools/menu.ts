import { Menu, type BrowserWindow } from 'electron';
import type { CaptureToolTask } from '../../shared/capture-tools';
import { CAPTURE_TOOL_MENU_LABELS, CAPTURE_TOOL_MENU_TASKS } from '../../shared/capture-tools-menu';

/** A native popup can sit above a WebContentsView while the page keeps drawing.
 * No DOM modal, webview hiding, viewport resize or screenshot replacement. */
export class CaptureToolsMenu {
  private pending?: { menu: Menu; owner: BrowserWindow; finish(): void };
  open(owner: BrowserWindow, request: { locale: 'zh-CN' | 'en'; x: number; y: number }): Promise<CaptureToolTask | undefined> {
    if (this.pending) throw Error('全局工具列表已打开。');
    if (owner.isDestroyed() || owner.webContents.isDestroyed()) throw Error('主窗口已关闭。');
    const bounds = owner.getContentBounds(), zoom = owner.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(bounds.width - 1, Math.round(request.x * zoom))), y = Math.max(0, Math.min(bounds.height - 1, Math.round(request.y * zoom)));
    return new Promise((resolve, reject) => {
      let selected: CaptureToolTask | undefined, settled = false;
      const menu = Menu.buildFromTemplate(CAPTURE_TOOL_MENU_TASKS.map(task => ({ id: 'capture-tool-' + task, label: CAPTURE_TOOL_MENU_LABELS[request.locale][task], click: () => { selected = task; } })));
      const finish = (error?: unknown) => {
        if (settled) return; settled = true;
        if (this.pending?.menu === menu) this.pending = undefined;
        owner.removeListener('closed', close); owner.webContents.removeListener('did-start-navigation', navigation); owner.webContents.removeListener('render-process-gone', close);
        if (error) reject(error); else resolve(selected);
      };
      const close = () => { try { menu.closePopup(owner); } catch { /* The native owner may already be gone. */ } finally { finish(); } };
      const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => { if (main) close(); };
      this.pending = { menu, owner, finish };
      owner.once('closed', close); owner.webContents.on('did-start-navigation', navigation); owner.webContents.once('render-process-gone', close);
      try { menu.popup({ window: owner, x, y, callback: () => finish() }); }
      catch (error) { finish(error); }
    });
  }
  close(): void {
    const pending = this.pending; if (!pending) return;
    try { pending.menu.closePopup(pending.owner); } catch { /* Closing a destroyed owner still settles the caller. */ } finally { pending.finish(); }
  }
}
