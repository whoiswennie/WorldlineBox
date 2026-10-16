import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { STARTUP_RENDERER_STATE_CHANNEL } from '../shared/startup-lifecycle';
import type { StartupWindow } from './startup-window';

const STARTUP_READY_TIMEOUT_MS = 60_000;
const MAX_STARTUP_RETRIES = 2;

/** HTML ready-to-show is earlier than the lazy React shell. Require both. */
export function bindStartupHandoff(options: {
  window: BrowserWindow;
  splash?: StartupWindow;
  show: () => void;
  complete: () => void;
  reportFailure: (reason: string) => void;
}): void {
  const { window, splash } = options;
  const contents = window.webContents;
  let nativeReady = false;
  let rendererReady = false;
  let finished = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout>;

  const release = () => {
    if (finished || !nativeReady || !rendererReady || window.isDestroyed()) return;
    finished = true;
    dispose();
    // Show the complete app before closing the splash, without a blank interval.
    options.show();
    splash?.complete();
    options.complete();
  };
  const fail = (reason: string) => {
    if (finished || window.isDestroyed()) return;
    clearTimeout(timer);
    options.reportFailure(reason);
    if (!splash?.isOpen()) { options.show(); return; }
    splash.fail(reason, retries < MAX_STARTUP_RETRIES ? () => {
      retries++;
      rendererReady = false;
      splash.set('interface', `重新装载应用界面 · 第 ${retries} / ${MAX_STARTUP_RETRIES} 次重试`);
      armTimeout();
      window.reload();
    } : undefined);
  };
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail('界面装载超过 60 秒，请重试；详细原因可查看诊断日志。'), STARTUP_READY_TIMEOUT_MS);
  };
  const onState = (event: IpcMainEvent, state: unknown) => {
    if (finished || window.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
    if (state === 'ready') { rendererReady = true; release(); }
    else if (state === 'failed') fail('界面未能装载，请重试；详细原因可查看诊断日志。');
  };
  const onNativeReady = () => { nativeReady = true; release(); };
  const onGone = () => fail('界面进程意外退出，请重试；详细原因可查看诊断日志。');
  const dispose = () => {
    clearTimeout(timer);
    ipcMain.removeListener(STARTUP_RENDERER_STATE_CHANNEL, onState);
    window.removeListener('ready-to-show', onNativeReady);
    window.removeListener('closed', onClosed);
    contents.removeListener('render-process-gone', onGone);
  };
  const onClosed = () => { finished = true; dispose(); splash?.complete(); options.complete(); };
  ipcMain.on(STARTUP_RENDERER_STATE_CHANNEL, onState);
  window.on('ready-to-show', onNativeReady);
  window.once('closed', onClosed);
  contents.on('render-process-gone', onGone);
  armTimeout();
}
