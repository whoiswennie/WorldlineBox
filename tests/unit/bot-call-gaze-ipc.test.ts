import { expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMain } from 'electron';
import { registerCompanionGazePointer } from '../../src/main/companion-gaze-pointer';
import { COMPANION_GAZE_POINTER_CHANNEL } from '../../src/shared/companion-gaze';

it('samples only for the application main frame and returns outside-window coordinates without starting a background timer', () => {
  const mainFrame = {}, webContents = { mainFrame, getZoomFactor: () => 1.5 };
  const window = { isDestroyed: () => false, webContents, getContentBounds: () => ({ x: -1200, y: 50 }) };
  const handle = vi.fn(), readCursor = vi.fn(() => ({ x: -1600, y: 1200 }));
  registerCompanionGazePointer({ ipcMain: { handle } as unknown as IpcMain, getMainWindow: () => window as unknown as BrowserWindow, readCursor });
  expect(handle).toHaveBeenCalledTimes(1); expect(handle.mock.calls[0]![0]).toBe(COMPANION_GAZE_POINTER_CHANNEL);
  const request = handle.mock.calls[0]![1] as (event: { sender: unknown; senderFrame: unknown }) => unknown;
  expect(request({ sender: {}, senderFrame: mainFrame })).toEqual({ ok: false });
  expect(request({ sender: webContents, senderFrame: {} })).toEqual({ ok: false });
  expect(readCursor).not.toHaveBeenCalled();
  expect(request({ sender: webContents, senderFrame: mainFrame })).toEqual({ ok: true, point: { x: -400 / 1.5, y: 1150 / 1.5 } });
  expect(readCursor).toHaveBeenCalledTimes(1);
});
