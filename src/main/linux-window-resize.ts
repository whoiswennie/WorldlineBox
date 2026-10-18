import type { BrowserWindow } from "electron";
import type * as Koffi from "koffi";

import type { WindowResizeEdge } from "../shared/window-edge-resize";

export type { WindowResizeEdge } from "../shared/window-edge-resize";
export { parseWindowResizeEdge } from "../shared/window-edge-resize";

/**
 * Frameless Linux windows lose the WM resize border (frame extents are 0).
 * Prefer a native `_NET_WM_MOVERESIZE` handoff; callers may fall back to
 * renderer-driven `setBounds` when this returns false.
 */

const NET_WM_MOVERESIZE_SIZE: Record<WindowResizeEdge, number> = {
  nw: 0,
  n: 1,
  ne: 2,
  e: 3,
  se: 4,
  s: 5,
  sw: 6,
  w: 7,
};

const X11_CLIENT_MESSAGE = 33;
const X11_SUBSTRUCTURE_NOTIFY = 1 << 19;
const X11_SUBSTRUCTURE_REDIRECT = 1 << 20;

type X11ResizeApi = {
  XOpenDisplay: (name: null) => unknown;
  XDefaultRootWindow: (display: unknown) => number | bigint;
  XInternAtom: (
    display: unknown,
    name: string,
    onlyIfExists: number,
  ) => number | bigint;
  XUngrabPointer: (display: unknown, time: number) => number;
  XSendEvent: (
    display: unknown,
    window: number | bigint,
    propagate: number,
    eventMask: number | bigint,
    event: unknown,
  ) => number;
  XFlush: (display: unknown) => number;
  XCloseDisplay: (display: unknown) => number;
};

type KoffiModule = typeof Koffi & {
  encode?: (type: unknown, value: unknown) => Buffer;
  alloc?: (type: unknown) => unknown;
};

let cachedApi: X11ResizeApi | undefined | null = null;
let cachedEventType: unknown;
let cachedKoffi: KoffiModule | undefined;

function loadX11ResizeApi(): X11ResizeApi | undefined {
  if (cachedApi !== null) return cachedApi ?? undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as KoffiModule;
    cachedKoffi = koffi;
    const lib = koffi.load("libX11.so.6");
    cachedEventType = koffi.struct("WorldlineBoxXClientMessageEvent", {
      type: "int",
      serial: "unsigned long",
      send_event: "int",
      display: "void *",
      window: "unsigned long",
      message_type: "unsigned long",
      format: "int",
      data: koffi.array("long", 5),
    });
    cachedApi = {
      XOpenDisplay: lib.func("void *XOpenDisplay(const char *name)"),
      XDefaultRootWindow: lib.func(
        "unsigned long XDefaultRootWindow(void *display)",
      ),
      XInternAtom: lib.func(
        "unsigned long XInternAtom(void *display, const char *name, int onlyIfExists)",
      ),
      XUngrabPointer: lib.func(
        "int XUngrabPointer(void *display, unsigned long time)",
      ),
      XSendEvent: lib.func(
        "int XSendEvent(void *display, unsigned long window, int propagate, long event_mask, void *event_send)",
      ),
      XFlush: lib.func("int XFlush(void *display)"),
      XCloseDisplay: lib.func("int XCloseDisplay(void *display)"),
    } as X11ResizeApi;
    return cachedApi;
  } catch {
    cachedApi = undefined;
    return undefined;
  }
}


function nativeXidFromHandle(handle: Buffer): number | bigint | null {
  if (!Buffer.isBuffer(handle) || handle.length < 4) return null;
  if (handle.length >= 8) return handle.readBigUInt64LE(0);
  return handle.readUInt32LE(0);
}

function packClientMessageEvent(fields: {
  display: unknown;
  window: number | bigint;
  messageType: number | bigint;
  data: number[];
}): unknown | null {
  const koffi = cachedKoffi;
  const type = cachedEventType;
  if (!koffi || !type) return null;
  const value = {
    type: X11_CLIENT_MESSAGE,
    serial: 0,
    send_event: 1,
    display: fields.display,
    window: fields.window,
    message_type: fields.messageType,
    format: 32,
    data: fields.data,
  };
  if (typeof koffi.encode === "function") {
    return koffi.encode(type, value);
  }
  if (typeof koffi.alloc === "function") {
    const ptr = koffi.alloc(type) as Record<string, unknown>;
    Object.assign(ptr, value);
    return ptr;
  }
  return null;
}

/**
 * Ask the window manager to begin an interactive resize from `edge`.
 * Returns false when unavailable so the renderer can fall back to setBounds.
 */
export function beginLinuxWindowEdgeResize(
  window: BrowserWindow,
  edge: WindowResizeEdge,
  cursorScreen: { readonly x: number; readonly y: number },
  api: X11ResizeApi | undefined = loadX11ResizeApi(),
): boolean {
  if (process.platform !== "linux" || window.isDestroyed()) return false;
  if (window.isMaximized() || window.isFullScreen()) return false;
  if (!api) return false;

  let display: unknown;
  try {
    display = api.XOpenDisplay(null);
    if (!display) return false;

    const xid = nativeXidFromHandle(window.getNativeWindowHandle());
    if (xid === null) return false;

    const root = api.XDefaultRootWindow(display);
    const atom = api.XInternAtom(display, "_NET_WM_MOVERESIZE", 0);
    if (!atom) return false;

    api.XUngrabPointer(display, 0);

    const packed = packClientMessageEvent({
      display,
      window: xid,
      messageType: atom,
      data: [
        Math.round(cursorScreen.x),
        Math.round(cursorScreen.y),
        NET_WM_MOVERESIZE_SIZE[edge],
        1,
        1,
      ],
    });
    if (!packed) return false;

    const mask = X11_SUBSTRUCTURE_NOTIFY | X11_SUBSTRUCTURE_REDIRECT;
    const sent = api.XSendEvent(display, root, 0, mask, packed);
    api.XFlush(display);
    return sent !== 0;
  } catch {
    return false;
  } finally {
    if (display) {
      try {
        api.XCloseDisplay(display);
      } catch {
        // ignore
      }
    }
  }
}

export function applyWindowBoundsFromEdgeDelta(options: {
  window: BrowserWindow;
  edge: WindowResizeEdge;
  startBounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  dx: number;
  dy: number;
}): { ok: true } | { ok: false; code: "no_window" | "maximized" } {
  const { window, edge, startBounds, dx, dy } = options;
  if (window.isDestroyed()) return { ok: false, code: "no_window" };
  if (window.isMaximized() || window.isFullScreen()) {
    return { ok: false, code: "maximized" };
  }
  const minimumSize = window.getMinimumSize();
  const minW = minimumSize[0] ?? 1;
  const minH = minimumSize[1] ?? 1;
  let { x, y, width, height } = startBounds;

  if (edge.includes("e")) width = startBounds.width + dx;
  if (edge.includes("w")) {
    width = startBounds.width - dx;
    x = startBounds.x + dx;
  }
  if (edge.includes("s")) height = startBounds.height + dy;
  if (edge.includes("n")) {
    height = startBounds.height - dy;
    y = startBounds.y + dy;
  }

  if (width < minW) {
    if (edge.includes("w")) x -= minW - width;
    width = minW;
  }
  if (height < minH) {
    if (edge.includes("n")) y -= minH - height;
    height = minH;
  }

  window.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
  return { ok: true };
}
