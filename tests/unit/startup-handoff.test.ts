import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STARTUP_RENDERER_STATE_CHANNEL } from '../../src/shared/startup-lifecycle';
import type { StartupWindow } from '../../src/main/startup-window';

const ipc = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: ipc }));
import { bindStartupHandoff } from '../../src/main/startup-handoff';

function fixture() {
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { mainFrame: {} }),
    isDestroyed: () => false, reload: vi.fn(),
  });
  const splash = { isOpen: () => true, complete: vi.fn(), fail: vi.fn(), set: vi.fn() };
  const show = vi.fn(), complete = vi.fn(), reportFailure = vi.fn();
  bindStartupHandoff({ window: window as unknown as BrowserWindow, splash: splash as unknown as StartupWindow, show, complete, reportFailure });
  const onState = ipc.on.mock.calls.at(-1)![1] as (event: IpcMainEvent, state: unknown) => void;
  const state = (value: unknown, sender = window.webContents, senderFrame = window.webContents.mainFrame) => onState({ sender, senderFrame } as unknown as IpcMainEvent, value);
  return { window, splash, show, complete, state, reportFailure };
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

it('keeps the small splash through HTML readiness and opens only the painted app', () => {
  const f = fixture();
  f.window.emit('ready-to-show');
  expect(f.show).not.toHaveBeenCalled(); expect(f.splash.complete).not.toHaveBeenCalled();
  f.state('ready'); f.state('ready');
  expect(f.show).toHaveBeenCalledTimes(1); expect(f.splash.complete).toHaveBeenCalledTimes(1);
  expect(f.show.mock.invocationCallOrder[0]).toBeLessThan(f.splash.complete.mock.invocationCallOrder[0]!);
  expect(ipc.removeListener).toHaveBeenCalledWith(STARTUP_RENDERER_STATE_CHANNEL, expect.any(Function));
  vi.advanceTimersByTime(120_000); expect(f.splash.fail).not.toHaveBeenCalled();
});
it('also waits for native readiness when renderer notification arrives first', () => {
  const f = fixture(); f.state('ready'); expect(f.show).not.toHaveBeenCalled();
  f.window.emit('ready-to-show'); expect(f.show).toHaveBeenCalledTimes(1);
});
it('ignores other windows, subframes and malformed state notifications', () => {
  const f = fixture(); f.window.emit('ready-to-show');
  f.state('ready', {} as typeof f.window.webContents); f.state('ready', f.window.webContents, {}); f.state({ ready: true });
  expect(f.show).not.toHaveBeenCalled(); f.state('ready'); expect(f.show).toHaveBeenCalledTimes(1);
});
it('shows load errors and bounded retries inside the same splash', () => {
  const f = fixture(); f.window.emit('ready-to-show'); f.state('failed');
  expect(f.show).not.toHaveBeenCalled(); expect(f.splash.complete).not.toHaveBeenCalled();
  for (let retry = 0; retry < 2; retry++) {
    const callback = f.splash.fail.mock.calls.at(-1)![1] as () => void; callback();
    f.state('failed');
  }
  expect(f.window.reload).toHaveBeenCalledTimes(2);
  expect(f.splash.fail.mock.calls.at(-1)![1]).toBeUndefined();
  f.window.emit('closed'); vi.advanceTimersByTime(120_000); expect(f.complete).toHaveBeenCalledTimes(1);
});
it('offers recovery at the timeout without opening another loading window', () => {
  const f = fixture(); f.window.emit('ready-to-show'); vi.advanceTimersByTime(60_000);
  expect(f.splash.fail).toHaveBeenCalledWith(expect.stringContaining('60 秒'), expect.any(Function));
  expect(f.show).not.toHaveBeenCalled();
  f.state('ready'); expect(f.show).toHaveBeenCalledTimes(1);
});
it('handles an early renderer crash in the existing splash and disposes on close', () => {
  const f = fixture(); f.window.webContents.emit('render-process-gone');
  expect(f.splash.fail).toHaveBeenCalledWith(expect.stringContaining('意外退出'), expect.any(Function));
  f.window.emit('closed'); f.state('ready'); vi.advanceTimersByTime(120_000);
  expect(f.show).not.toHaveBeenCalled(); expect(f.splash.complete).toHaveBeenCalledTimes(1);
});
it('can clean up after BrowserWindow has lost access to its destroyed webContents', () => {
  const f = fixture();
  Object.defineProperty(f.window, 'webContents', { get() { throw new Error('Object has been destroyed'); } });
  expect(() => f.window.emit('closed')).not.toThrow();
  expect(f.splash.complete).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(120_000); expect(f.splash.fail).not.toHaveBeenCalled();
});
