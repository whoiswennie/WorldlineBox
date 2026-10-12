type SendableWebContents = {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
};

/**
 * Chromium can dispose the render frame between a window event and
 * `webContents.send` (Vite reload, renderer crash, window close). Electron
 * then throws `Render frame was disposed before WebFrameMain could be accessed`.
 * Callers must not let that exception escape into the main process.
 */
export function sendToLiveWebContents(
  contents: SendableWebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!contents || contents.isDestroyed()) return false;
  try {
    contents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}
