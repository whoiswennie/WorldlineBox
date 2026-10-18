import type { BrowserWindow } from "electron";
import type * as Koffi from "koffi";

/**
 * Linux frameless windows get Windows 11-style rounded corners: the
 * BrowserWindow is transparent and the renderer root is clipped to a rounded
 * rect via injected CSS. Transparency only works with a compositing manager;
 * without one the transparent pixels show up black, so we probe for a
 * compositor and fall back to an opaque, square-cornered window.
 *
 * Override with WORLDLINEBOX_LINUX_ROUNDED_CORNERS=1 (force on) / 0 (force off).
 */

export const LINUX_WINDOW_CORNER_RADIUS_PX = 8;

type X11Api = {
  XOpenDisplay: (name: null) => unknown;
  XDefaultScreen: (display: unknown) => number;
  XInternAtom: (display: unknown, name: string, onlyIfExists: number) => number | bigint;
  XGetSelectionOwner: (display: unknown, atom: number | bigint) => number | bigint;
  XCloseDisplay: (display: unknown) => number;
};

function loadX11(): X11Api | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof Koffi;
    const lib = koffi.load("libX11.so.6");
    return {
      XOpenDisplay: lib.func("void *XOpenDisplay(const char *name)"),
      XDefaultScreen: lib.func("int XDefaultScreen(void *display)"),
      XInternAtom: lib.func("unsigned long XInternAtom(void *display, const char *name, int onlyIfExists)"),
      XGetSelectionOwner: lib.func("unsigned long XGetSelectionOwner(void *display, unsigned long atom)"),
      XCloseDisplay: lib.func("int XCloseDisplay(void *display)"),
    } as X11Api;
  } catch {
    return undefined;
  }
}

/** True when an X11 compositing manager owns `_NET_WM_CM_S<screen>`. */
export function isX11CompositorRunning(api: X11Api | undefined = loadX11()): boolean {
  if (!api) return false;
  let display: unknown;
  try {
    display = api.XOpenDisplay(null);
    if (!display) return false;
    const screen = api.XDefaultScreen(display);
    const atom = api.XInternAtom(display, `_NET_WM_CM_S${screen}`, 0);
    if (!atom) return false;
    return Number(api.XGetSelectionOwner(display, atom)) !== 0;
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

export function shouldUseLinuxRoundedCorners(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  probeCompositor: () => boolean = isX11CompositorRunning,
): boolean {
  if (platform !== "linux") return false;
  const override = env.WORLDLINEBOX_LINUX_ROUNDED_CORNERS;
  if (override === "0") return false;
  if (override === "1") return true;
  // Wayland compositors always composite (and Electron under XWayland still
  // sees a compositor selection owner, so the probe also covers that path).
  if (env.XDG_SESSION_TYPE === "wayland" && env.WAYLAND_DISPLAY && !env.DISPLAY) {
    return true;
  }
  return probeCompositor();
}

export function linuxRoundedCornersCss(radius = LINUX_WINDOW_CORNER_RADIUS_PX): string {
  // body background propagates to the canvas, so both html and body go
  // transparent and #root carries the theme surface clipped to a rounded rect.
  return `
html, body { background: transparent !important; }
#root {
  background: var(--ui-surface-canvas, #ebeceb);
  border-radius: ${radius}px;
  clip-path: inset(0 round ${radius}px);
  overflow: hidden;
}
html.worldlinebox-window-square #root { border-radius: 0; clip-path: none; }
/* Caption buttons portal to body (outside #root clip). Round the close
   hover so it follows the window corner instead of painting a square nub. */
.windows-caption-button-close { border-top-right-radius: ${radius}px; }
html.worldlinebox-window-square .windows-caption-button-close { border-top-right-radius: 0; }
`;
}

/** Window options to merge into the main BrowserWindow constructor. */
export function linuxRoundedWindowOptions(): {
  transparent: true;
  backgroundColor: string;
} {
  return { transparent: true, backgroundColor: "#00000000" };
}

/**
 * Inject the rounded-corner CSS and square the corners while maximized /
 * fullscreen (edges touch the screen, like Windows 11).
 */
export function attachLinuxRoundedCorners(window: BrowserWindow): void {
  const css = linuxRoundedCornersCss();
  const syncSquare = () => {
    if (window.isDestroyed()) return;
    const square = window.isMaximized() || window.isFullScreen();
    void window.webContents
      .executeJavaScript(
        `document.documentElement.classList.toggle("worldlinebox-window-square", ${square ? "true" : "false"})`,
        true,
      )
      .catch(() => undefined);
  };
  window.webContents.on("dom-ready", () => {
    void window.webContents.insertCSS(css).catch(() => undefined);
    syncSquare();
  });
  for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
    window.on(event as "maximize", syncSquare);
  }
}
