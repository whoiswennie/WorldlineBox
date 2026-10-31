import { BrowserWindow, screen } from 'electron';

export interface CompanionObservationNoticeSurface {
  show(names: readonly string[], description?: string): Promise<void> | void;
  hide(): void;
  close(): void;
}
const html = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;background:transparent;font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#eaf5f1}body{padding:8px 14px}.notice{box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:13px 20px;border:1px solid #ffffff26;border-radius:16px;background:#202b29f2;box-shadow:0 6px 20px #0003}.eye{width:9px;height:9px;flex:0 0 9px;border-radius:50%;background:#9dd6bd}.text{min-width:0;overflow-wrap:anywhere}small{display:block;font-size:11px;color:#b4c7bd}</style></head><body><div class="notice"><span class="eye"></span><div class="text"><span id="names"></span><small id="description"></small></div></div></body></html>';

function nativeSurface(): CompanionObservationNoticeSurface {
  let window: BrowserWindow | undefined, ready: Promise<void> | undefined, sequence = 0;
  const hide = () => { sequence++; if (window && !window.isDestroyed()) window.hide(); };
  return {
    async show(names, description = '正在看看你这边的情况') {
      const current = ++sequence;
      if (!window || window.isDestroyed()) {
        window = new BrowserWindow({ width: 460, height: 96, show: false, frame: false, transparent: true, focusable: false,
          skipTaskbar: true, alwaysOnTop: true, resizable: false, movable: false, hasShadow: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
        window.setIgnoreMouseEvents(true); window.setContentProtection(true); window.removeMenu();
        window.setAlwaysOnTop(true, 'screen-saver'); window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        ready = window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      }
      const target = window; await ready;
      if (current !== sequence || target.isDestroyed()) return;
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = Math.min(520, area.width - 24), text = names.join('、');
      const height = Math.min(160, 84 + Math.max(0, Math.ceil(text.length / 24) - 1) * 20);
      target.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: area.y + 10, width, height });
      await target.webContents.executeJavaScript('document.getElementById("names").textContent=' + JSON.stringify(text));
      await target.webContents.executeJavaScript('document.getElementById("description").textContent=' + JSON.stringify(description));
      if (current === sequence && !target.isDestroyed()) target.showInactive();
    }, hide,
    close() { hide(); if (window && !window.isDestroyed()) window.destroy(); window = undefined; ready = undefined; },
  };
}

/** A short, click-through start notice. Capture permission remains with the
 * observation driver. Finishing/renewing a capture never pins this surface. */
export class CompanionObservationNotice {
  private readonly sessions = new Map<string, { owner: string; name: string; token: symbol }>();
  private readonly surface: CompanionObservationNoticeSurface;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private showing = false;
  private presentation?: string;
  private readonly lastShown = new Map<string, number>();
  constructor(private readonly options: { surface?: CompanionObservationNoticeSurface; durationMs?: number; report?(error: unknown): void } = {}) {
    this.surface = options.surface ?? nativeSurface();
  }
  enter(input: { key: string; companionId: string; name: string }): (completed?: boolean) => void {
    if (this.closed) return () => undefined;
    const existingOwner = [...this.sessions.values()].some(item => item.owner === input.companionId), token = Symbol();
    this.sessions.set(input.key, { owner: input.companionId, name: input.name, token });
    if (!existingOwner && Date.now() - (this.lastShown.get(input.companionId) ?? -Infinity) >= 10000) {
      this.lastShown.set(input.companionId, Date.now());
      const alreadyShowing = this.showing; this.showing = true; this.present();
      if (!alreadyShowing) { clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.showing = false; this.presentation = undefined; this.surface.hide(); }, this.options.durationMs ?? 3500); this.timer.unref?.(); }
    }
    return completed => {
      if (this.sessions.get(input.key)?.token !== token) return;
      this.sessions.delete(input.key);
      if (this.showing && this.sessions.size) this.present();
      if (!this.sessions.size && this.showing) this.show([input.name], completed ? '刚刚看了看你这边的情况' : '这次留意已经停止');
    };
  }
  private present() {
    const names = [...new Map([...this.sessions.values()].map(item => [item.owner, item.name])).values()];
    this.show(names);
  }
  private show(names: readonly string[], description?: string) {
    const presentation = JSON.stringify([names, description]); if (this.presentation === presentation) return;
    this.presentation = presentation;
    try { void Promise.resolve(this.surface.show(names, description)).catch(error => this.options.report?.(error)); }
    catch (error) { this.options.report?.(error); }
  }
  close(): void { this.closed = true; this.showing = false; this.presentation = undefined; clearTimeout(this.timer); this.sessions.clear(); this.lastShown.clear(); this.surface.close(); }
}
