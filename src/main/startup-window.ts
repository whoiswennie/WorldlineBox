import { app, BrowserWindow, nativeTheme } from 'electron';
import logo from '../../assets/icons/startup-logo.png?inline';
import { STARTUP_PHASES, startupMarkup, type StartupPhase } from '../shared/startup-presentation';
import styles from '../renderer/startup.css?raw';
import { withAppWindowIcon } from './app-icon';

/** A sandboxed local surface shown before tool verification or data workers. */
export class StartupWindow {
  private window: BrowserWindow | undefined;
  private readonly started = performance.now();
  private phaseStarted = this.started;
  private phase: StartupPhase = 'environment';
  private timer: ReturnType<typeof setInterval> | undefined;
  private finished = false;
  constructor(private readonly report: (phase: string, durationMs: number, totalMs: number) => void) {}
  async open(): Promise<void> {
    // Existing headless desktop checks expect firstWindow() to be the real app.
    // The dedicated startup check opts in to this additional native surface.
    if (process.env.WORLDLINEBOX_E2E === '1' && process.env.WORLDLINEBOX_E2E_STARTUP_SCREEN !== '1') return;
    const hidden = process.env.WORLDLINEBOX_E2E === '1' && process.env.WORLDLINEBOX_E2E_HIDE_WINDOW === '1';
    this.window = new BrowserWindow(withAppWindowIcon({ width: 540, height: 490, show: false, resizable: false, maximizable: false, minimizable: true, autoHideMenuBar: true, title: 'WorldlineBox', backgroundColor: nativeTheme.shouldUseDarkColors ? '#171b25' : '#f6f7fb', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }));
    this.window.on('close', () => { if (!this.finished) app.quit(); });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.once('ready-to-show', () => { if (!hidden && !this.window?.isDestroyed()) this.window?.show(); });
    // Bundle the small PNG into Main: source assets do not exist beside app.asar.
    await this.window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh-CN" data-theme="${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>WorldlineBox</title><style>body{margin:0}${styles}</style></head><body>${startupMarkup(logo)}</body></html>`));
    this.timer = setInterval(() => this.publish(), 250); this.publish();
  }
  set(phase: StartupPhase, detail?: string): void {
    const now = performance.now();
    if (phase !== this.phase) { this.report(this.phase, Math.round(now - this.phaseStarted), Math.round(now - this.started)); this.phaseStarted = now; this.phase = phase; }
    this.publish(detail);
  }
  private detail = '核对 Node.js、Git 与媒体工具的完整性';
  private publish(detail?: string): void {
    if (detail !== undefined) this.detail = detail;
    if (!this.window || this.window.isDestroyed()) return;
    const index = STARTUP_PHASES.findIndex(phase => phase.id === this.phase);
    const payload = { phase: this.phase, detail: this.detail, stage: `已完成 ${index} / ${STARTUP_PHASES.length} 个步骤 · ${STARTUP_PHASES[index]!.label}`, elapsed: ((performance.now() - this.started) / 1000).toFixed(1) + ' 秒' };
    void this.window.webContents.executeJavaScript(`(() => { const p=${JSON.stringify(payload)}; document.querySelector('[data-startup-detail]').textContent=p.detail; document.querySelector('[data-startup-stage]').textContent=p.stage; document.querySelector('[data-startup-elapsed]').textContent=p.elapsed; const steps=[...document.querySelectorAll('[data-phase]')]; const index=steps.findIndex(e=>e.dataset.phase===p.phase); steps.forEach((e,i)=>{e.classList.toggle('is-done',i<index); if(i===index)e.setAttribute('aria-current','step');else e.removeAttribute('aria-current');}); })()`).catch(() => undefined);
  }
  complete(): void {
    if (this.finished) return;
    this.finished = true; clearInterval(this.timer);
    const now = performance.now(); this.report(this.phase, Math.round(now - this.phaseStarted), Math.round(now - this.started)); this.report('main-ready', 0, Math.round(now - this.started));
    if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = undefined;
  }
}
