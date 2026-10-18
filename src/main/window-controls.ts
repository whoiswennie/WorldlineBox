import { BrowserWindow, ipcMain, screen, type WebContents } from "electron";

import {
  WINDOW_CONTROL_CHANNEL,
  WINDOW_EDGE_RESIZE_CHANNEL,
  WINDOW_MAXIMIZED_CHANNEL,
  WINDOW_SET_BOUNDS_CHANNEL,
  WINDOW_GET_BOUNDS_CHANNEL,
} from "../shared/protocol/channels";
import {
  parseWindowControlRequest,
  shouldHideWindowOnClose,
  shouldUseFramelessTitleBar,
  type WindowControlAction,
  type WindowControlResult,
  type WindowMaximizedStateEvent,
} from "../shared/window-controls";
import {
  parseWindowEdgeResizeRequest,
  parseWindowSetBoundsRequest,
  type WindowEdgeResizeResult,
  type WindowGetBoundsResult,
  type WindowSetBoundsResult,
} from "../shared/window-edge-resize";
import {
  applyWindowBoundsFromEdgeDelta,
  beginLinuxWindowEdgeResize,
} from "./linux-window-resize";
import { ensureRendererKeyboardFocus } from "./renderer-keyboard-focus";
import { sendToLiveWebContents } from "./web-contents-send";

type WindowControlLogger = {
  info: (scope: string, message: string, meta?: Record<string, unknown>) => void;
};

function sendMaximizedState(webContents: WebContents, maximized: boolean): void {
  const event: WindowMaximizedStateEvent = {
    type: "shell.window.maximized",
    maximized,
  };
  sendToLiveWebContents(webContents, WINDOW_MAXIMIZED_CHANNEL, event);
}

function applyWindowControl(
  window: BrowserWindow,
  action: WindowControlAction,
): WindowControlResult {
  if (window.isDestroyed()) {
    return { ok: false, code: "no_window" };
  }
  switch (action) {
    case "minimize":
      window.minimize();
      break;
    case "maximize-toggle":
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      break;
    case "fullscreen-toggle":
      window.setFullScreen(!window.isFullScreen());
      break;
    case "steal-focus":
      // Do not blur/reattach here: the renderer may call this while Main is
      // already cycling activation after a native dialog.
      ensureRendererKeyboardFocus(window, {
        reason: "window-control.steal-focus",
      });
      break;
    case "close":
      // Do not read isMaximized() after close — the window may already be destroyed.
      // On Windows the renderer owns the caption buttons. Closing the visible
      // window hides it and leaves the process alive behind the notification-area
      // tray icon; the tray menu owns the explicit quit action.
      if (shouldHideWindowOnClose(process.platform)) window.hide();
      else window.close();
      return { ok: true, maximized: false };
    case "get-state":
      break;
  }
  if (window.isDestroyed()) {
    return { ok: true, maximized: false };
  }
  return { ok: true, maximized: window.isMaximized() };
}

/**
 * Register frameless Windows caption IPC and wire maximize state events
 * onto the given main window (WorldlineBox-znex).
 */
export function registerWindowControls(options: {
  getMainWindow: () => BrowserWindow | undefined;
  logger?: WindowControlLogger;
}): void {
  const { getMainWindow, logger } = options;

  ipcMain.handle(
    WINDOW_CONTROL_CHANNEL,
    (event, input: unknown): WindowControlResult => {
      const parsed = parseWindowControlRequest(input);
      if (!shouldUseFramelessTitleBar(process.platform) && parsed?.action !== 'fullscreen-toggle') {
        logger?.info("ipc.window-control", "Rejected window-control request.", {
          code: "unsupported_platform",
        });
        return { ok: false, code: "unauthorized_sender" };
      }
      const mainWindow = getMainWindow();
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        logger?.info("ipc.window-control", "Rejected window-control request.", {
          code: "unauthorized_sender",
        });
        return { ok: false, code: "unauthorized_sender" };
      }
      if (!parsed) {
        logger?.info("ipc.window-control", "Rejected window-control request.", {
          code: "malformed_request",
        });
        return { ok: false, code: "malformed_request" };
      }
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) {
        logger?.info("ipc.window-control", "Rejected window-control request.", {
          code: "no_window",
        });
        return { ok: false, code: "no_window" };
      }
      return applyWindowControl(window, parsed.action);
    },
  );

  ipcMain.handle(
    WINDOW_EDGE_RESIZE_CHANNEL,
    (event, input: unknown): WindowEdgeResizeResult => {
      if (process.platform !== "linux") {
        return { ok: false, code: "unsupported_platform" };
      }
      const mainWindow = getMainWindow();
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        return { ok: false, code: "no_window" };
      }
      const parsed = parseWindowEdgeResizeRequest(input);
      if (!parsed) return { ok: false, code: "malformed_request" };
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) {
        return { ok: false, code: "no_window" };
      }
      if (window.isMaximized() || window.isFullScreen()) {
        return { ok: false, code: "maximized" };
      }
      // Prefer renderer setBounds (pointer capture). Native _NET_WM_MOVERESIZE
      // is attempted only when WORLDLINEBOX_LINUX_NATIVE_RESIZE=1 — Electron's
      // button grab frequently prevents the WM from taking over.
      if (process.env.WORLDLINEBOX_LINUX_NATIVE_RESIZE === "1") {
        const point = screen.getCursorScreenPoint();
        const native = beginLinuxWindowEdgeResize(window, parsed.edge, point);
        if (native) return { ok: true, mode: "native" };
      }
      return { ok: true, mode: "fallback" };
    },
  );

  ipcMain.handle(
    WINDOW_GET_BOUNDS_CHANNEL,
    (event): WindowGetBoundsResult => {
      if (process.platform !== "linux") {
        return { ok: false, code: "unsupported_platform" };
      }
      const mainWindow = getMainWindow();
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        return { ok: false, code: "no_window" };
      }
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) {
        return { ok: false, code: "no_window" };
      }
      return { ok: true, bounds: window.getBounds() };
    },
  );

  ipcMain.handle(
    WINDOW_SET_BOUNDS_CHANNEL,
    (event, input: unknown): WindowSetBoundsResult => {
      if (process.platform !== "linux") {
        return { ok: false, code: "unsupported_platform" };
      }
      const mainWindow = getMainWindow();
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        return { ok: false, code: "no_window" };
      }
      const parsed = parseWindowSetBoundsRequest(input);
      if (!parsed) return { ok: false, code: "malformed_request" };
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) {
        return { ok: false, code: "no_window" };
      }
      return applyWindowBoundsFromEdgeDelta({
        window,
        edge: parsed.edge,
        startBounds: parsed.startBounds,
        dx: parsed.dx,
        dy: parsed.dy,
      });
    },
  );
}

/** Attach maximize/unmaximize push events for caption glyph sync. */
export function bindWindowMaximizedEvents(window: BrowserWindow): void {
  const push = (): void => {
    if (window.isDestroyed()) return;
    sendMaximizedState(window.webContents, window.isMaximized());
  };
  window.on("maximize", push);
  window.on("unmaximize", push);
}
