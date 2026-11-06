import type { BrowserWindow, IpcMain } from 'electron';
import { COMPANION_GAZE_POINTER_CHANNEL, type CompanionGazeResult } from '../shared/companion-gaze';

/** Electron's screen cursor and window content bounds use the same global DIP
 * space, even across monitors with different scale factors and negative origins.
 * Page zoom is the only conversion needed to match DOM client coordinates. */
export function companionGazePointer(input: {
  cursor: { x: number; y: number }; contentBounds: { x: number; y: number }; zoomFactor: number;
}): CompanionGazeResult {
  const { cursor, contentBounds, zoomFactor } = input;
  if (![cursor.x, cursor.y, contentBounds.x, contentBounds.y, zoomFactor].every(Number.isFinite) || zoomFactor <= 0) return { ok: false };
  return { ok: true, point: { x: (cursor.x - contentBounds.x) / zoomFactor, y: (cursor.y - contentBounds.y) / zoomFactor } };
}

export function registerCompanionGazePointer(options: {
  ipcMain: Pick<IpcMain, 'handle'>; getMainWindow(): BrowserWindow | undefined; readCursor(): { x: number; y: number };
}) {
  // A read-only sample on demand. No global mouse hook, timer, persisted cursor
  // history or renderer-supplied screen coordinates are involved.
  options.ipcMain.handle(COMPANION_GAZE_POINTER_CHANNEL, (event): CompanionGazeResult => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return { ok: false };
    return companionGazePointer({ cursor: options.readCursor(), contentBounds: window.getContentBounds(), zoomFactor: window.webContents.getZoomFactor() });
  });
}
