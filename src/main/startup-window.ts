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
  private failed = false;
  private retry: (() => void) | undefined;
  constructor(private readonly report: (phase: string, durationMs: number, totalMs: number) => void) {}
  async open(): Promise<void> {
    // Existing headless desktop checks expect firstWindow() to be the real app.
    // The dedicated startup check opts in to this additional native surface.
    if (process.env.WORLDLINEBOX_E2E === '1' && process.env.WORLDLINEBOX_E2E_STARTUP_SCREEN !== '1') return;
    const hidden = process.env.WORLDLINEBOX_E2E === '1' && process.env.WORLDLINEBOX_E2E_HIDE_WINDOW === '1';
    this.window = new BrowserWindow(withAppWindowIcon({ width: 440, height: 300, show: false, resizable: false, maximizable: false, minimizable: true, autoHideMenuBar: true, title: 'WorldlineBox', backgroundColor: nativeTheme.shouldUseDarkColors ? '#171b25' : '#f6f7fb', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }));
    this.window.on('close', () => { if (!this.finished) app.quit(); });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'worldlinebox-startup:retry') {
        const retry = this.retry; this.retry = undefined; retry?.();
      }
    });
    this.window.once('ready-to-show', () => { if (!hidden && !this.window?.isDestroyed()) this.window?.show(); });
    // Bundle the small PNG into Main: source assets do not exist beside app.asar.
    await this.window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh-CN" data-theme="${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>WorldlineBox</title><style>body{margin:0}${styles}</style></head><body data-startup-native>${startupMarkup(logo, '正在打开…', '准备应用界面')}</body></html>`));
    this.timer = setInterval(() => this.publish(), 250); this.publish();
  }
  set(phase: StartupPhase, detail?: string): void {
    const now = performance.now();
    if (phase !== this.phase) { this.report(this.phase, Math.round(now - this.phaseStarted), Math.round(now - this.started)); this.phaseStarted = now; this.phase = phase; }
    this.retry = undefined; this.failed = false;
    this.publish(detail);
  }
  isOpen(): boolean { return this.window !== undefined && !this.window.isDestroyed(); }
  focus(): boolean {
    if (!this.isOpen()) return false;
    if (process.env.WORLDLINEBOX_E2E !== '1' || process.env.WORLDLINEBOX_E2E_HIDE_WINDOW !== '1') {
      if (this.window!.isMinimized()) this.window!.restore();
      this.window!.show(); this.window!.focus();
    }
    return true;
  }
  fail(detail: string, retry?: () => void): void {
    this.detail = detail; this.retry = retry; this.failed = true;
    if (!this.isOpen()) return;
    void this.window!.webContents.executeJavaScript(`(() => {
      document.querySelector('.startup-screen').classList.add('is-error');
      document.querySelector('[data-startup-title]').textContent='界面未能打开';
      document.querySelector('[data-startup-detail]').textContent=${JSON.stringify(detail)};
      document.querySelector('[data-startup-hint]').textContent=${JSON.stringify(retry ? '重试只重新装载界面，不会修改存档' : '已达重试上限，请关闭后重新打开，或查看诊断日志')};
      document.querySelector('.startup-retry')?.remove();
      ${retry ? "const button=document.createElement('a'); button.className='startup-retry'; button.href='worldlinebox-startup:retry'; button.textContent='重新加载界面'; document.querySelector('.startup-card').append(button);" : ''}
    })()`).catch(() => undefined);
  }
  private detail = '读取启动偏好与窗口设置';
  private publish(detail?: string): void {
    if (detail !== undefined) this.detail = detail;
    if (!this.window || this.window.isDestroyed()) return;
    const index = STARTUP_PHASES.findIndex(phase => phase.id === this.phase);
    const payload = { phase: this.phase, failed: this.failed, detail: this.detail, stage: `已完成 ${index} / ${STARTUP_PHASES.length} 个步骤 · ${STARTUP_PHASES[index]!.label}`, progress: index / STARTUP_PHASES.length * 100, elapsed: ((performance.now() - this.started) / 1000).toFixed(1) + ' 秒' };
    void this.window.webContents.executeJavaScript(`(() => { const p=${JSON.stringify(payload)}; const screen=document.querySelector('.startup-screen'); screen.dataset.progress='steps'; if(!p.failed && screen.classList.contains('is-error')) { screen.classList.remove('is-error'); document.querySelector('[data-startup-title]').textContent='正在打开世界线盒子'; document.querySelector('[data-startup-hint]').textContent='进度随实际完成的步骤更新'; document.querySelector('.startup-retry')?.remove(); } document.querySelector('.startup-track > span').style.width=p.progress+'%'; document.querySelector('[data-startup-detail]').textContent=p.detail; document.querySelector('[data-startup-stage]').textContent=p.stage; document.querySelector('[data-startup-elapsed]').textContent=p.elapsed; const steps=[...document.querySelectorAll('[data-phase]')]; const index=steps.findIndex(e=>e.dataset.phase===p.phase); steps.forEach((e,i)=>{e.classList.toggle('is-done',i<index); if(i===index)e.setAttribute('aria-current','step');else e.removeAttribute('aria-current');}); })()`).catch(() => undefined);
  }
  complete(ready = true): void {
    if (this.finished) return;
    this.finished = true; this.retry = undefined; clearInterval(this.timer);
    const now = performance.now(); this.report(this.phase, Math.round(now - this.phaseStarted), Math.round(now - this.started)); this.report(ready ? 'main-ready' : 'cancelled', 0, Math.round(now - this.started));
    if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = undefined;
  }
}
