import { createHash } from 'node:crypto';
import type * as Koffi from 'koffi';
import type { CaptureDesktopContext, CaptureDesktopRegion, CaptureRecordingControls, CaptureScreenRect } from '../../shared/capture-tools';

type NativeHandle = number | bigint;
export interface WindowsDesktopRegionsApi {
  getTopWindow(parent: NativeHandle): NativeHandle;
  getWindow(window: NativeHandle, command: number): NativeHandle;
  isWindowVisible(window: NativeHandle): number;
  isIconic(window: NativeHandle): number;
  getWindowRect(window: NativeHandle, rect: Buffer): number;
  getWindowText(window: NativeHandle, text: Buffer, length: number): number;
  getClassName(window: NativeHandle, text: Buffer, length: number): number;
  dwmGetWindowAttribute?(window: NativeHandle, attribute: number, output: Buffer, length: number): number;
}
export interface NativeDesktopWindow { id: string; name: string; bounds: CaptureScreenRect }
export interface NativeCaptureMonitor { bounds: CaptureScreenRect; workArea: CaptureScreenRect }
export interface WindowsCaptureMonitorApi {
  monitorFromRect(rect: Buffer, flags: number): NativeHandle;
  getMonitorInfo(monitor: NativeHandle, info: Buffer): number;
  setWindowPos(window: NativeHandle, after: NativeHandle, x: number, y: number, width: number, height: number, flags: number): number;
  setThreadDpiAwarenessContext?(context: NativeHandle): NativeHandle;
}

let cachedMonitorApi: WindowsCaptureMonitorApi | null | undefined;
function loadWindowsCaptureMonitorApi(): WindowsCaptureMonitorApi | null {
  if (cachedMonitorApi !== undefined) return cachedMonitorApi;
  if (process.platform !== 'win32') return cachedMonitorApi = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof Koffi;
    const user32 = koffi.load('user32.dll');
    let setThreadDpiAwarenessContext: WindowsCaptureMonitorApi['setThreadDpiAwarenessContext'];
    try { setThreadDpiAwarenessContext = user32.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)'); }
    catch { /* Older systems inherit Electron's process DPI context. */ }
    return cachedMonitorApi = {
      monitorFromRect: user32.func('uintptr_t __stdcall MonitorFromRect(uint8_t *rect, uint32_t flags)'),
      getMonitorInfo: user32.func('int __stdcall GetMonitorInfoW(uintptr_t monitor, uint8_t *info)'),
      setWindowPos: user32.func('int __stdcall SetWindowPos(uintptr_t window, intptr_t after, int x, int y, int width, int height, uint32_t flags)'),
      ...(setThreadDpiAwarenessContext ? { setThreadDpiAwarenessContext } : {}),
    };
  } catch { return cachedMonitorApi = null; }
}

function withPhysicalDpiContext<T>(api: Pick<WindowsCaptureMonitorApi, 'setThreadDpiAwarenessContext'>, run: () => T): T {
  const previous = api.setThreadDpiAwarenessContext?.(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
  try { return run(); }
  finally { if (previous) api.setThreadDpiAwarenessContext?.(previous); }
}

/** Electron DIP sizes are rounded; querying rcMonitor avoids a 1-pixel resample at 125/150%. */
export function readWindowsCaptureMonitor(approximate: CaptureScreenRect, api: WindowsCaptureMonitorApi | null = loadWindowsCaptureMonitorApi()): NativeCaptureMonitor | undefined {
  if (!api) return undefined;
  try {
    return withPhysicalDpiContext(api, () => {
      const rect = Buffer.alloc(16);
      [approximate.x, approximate.y, approximate.x + approximate.width, approximate.y + approximate.height].forEach((value, index) => rect.writeInt32LE(Math.round(value), index * 4));
      const monitor = api.monitorFromRect(rect, 2); if (!monitor) return undefined; // MONITOR_DEFAULTTONEAREST
      const info = Buffer.alloc(40); info.writeUInt32LE(info.length);
      if (!api.getMonitorInfo(monitor, info)) return undefined;
      const bounds = nativeRect(info.subarray(4, 20)), workArea = nativeRect(info.subarray(20, 36));
      return bounds && workArea ? { bounds, workArea } : undefined;
    });
  } catch { return undefined; }
}

/** Native physical placement removes the fractional-DIP overshoot of BrowserWindow.setBounds. */
export function positionCaptureWindowInPhysicalPixels(handle: Buffer, bounds: CaptureScreenRect, api: WindowsCaptureMonitorApi | null = loadWindowsCaptureMonitorApi()): boolean {
  if (!api || handle.length < 4) return false;
  try {
    const window = handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0);
    return withPhysicalDpiContext(api, () => !!api.setWindowPos(window, -1, Math.round(bounds.x), Math.round(bounds.y), Math.round(bounds.width), Math.round(bounds.height), 0x0010 | 0x0200));
  } catch { return false; }
}

let cachedApi: WindowsDesktopRegionsApi | null | undefined;
function loadWindowsDesktopRegionsApi(): WindowsDesktopRegionsApi | null {
  if (cachedApi !== undefined) return cachedApi;
  if (process.platform !== 'win32') return cachedApi = null;
  try {
    // Native window discovery remains in Main, never in the sandboxed overlay.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof Koffi;
    const user32 = koffi.load('user32.dll');
    let dwmGetWindowAttribute: WindowsDesktopRegionsApi['dwmGetWindowAttribute'];
    try { dwmGetWindowAttribute = koffi.load('dwmapi.dll').func('int32_t __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attribute, uint8_t *output, uint32_t length)'); }
    catch { /* Basic Win32 bounds remain usable on a system without DWM. */ }
    cachedApi = {
      getTopWindow: user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t parent)'),
      getWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t window, uint32_t command)'),
      isWindowVisible: user32.func('int __stdcall IsWindowVisible(uintptr_t window)'),
      isIconic: user32.func('int __stdcall IsIconic(uintptr_t window)'),
      getWindowRect: user32.func('int __stdcall GetWindowRect(uintptr_t window, uint8_t *rect)'),
      getWindowText: user32.func('int __stdcall GetWindowTextW(uintptr_t window, uint8_t *text, int length)'),
      getClassName: user32.func('int __stdcall GetClassNameW(uintptr_t window, uint8_t *text, int length)'),
      ...(dwmGetWindowAttribute ? { dwmGetWindowAttribute } : {}),
    };
    return cachedApi;
  } catch { return cachedApi = null; }
}

function readNativeText(read: (output: Buffer, length: number) => number, limit: number): string {
  const output = Buffer.alloc(limit * 2);
  const length = read(output, limit);
  return length > 0 ? output.toString('utf16le', 0, Math.min(length, limit - 1) * 2) : '';
}
function nativeRect(bytes: Buffer): CaptureScreenRect | undefined {
  const x = bytes.readInt32LE(0), y = bytes.readInt32LE(4);
  const width = bytes.readInt32LE(8) - x, height = bytes.readInt32LE(12) - y;
  return width >= 2 && height >= 2 && width <= 65536 && height <= 65536 ? { x, y, width, height } : undefined;
}

/** Bounded z-order walk: no cross-process UI Automation or blocking window messages. */
export function readWindowsDesktopRegions(api: WindowsDesktopRegionsApi | null = loadWindowsDesktopRegionsApi()): { available: boolean; windows: NativeDesktopWindow[] } {
  if (!api) return { available: false, windows: [] };
  const windows: NativeDesktopWindow[] = [], visited = new Set<string>();
  try {
    let handle = api.getTopWindow(0);
    for (let index = 0; handle && index < 512 && windows.length < 256; index++) {
      const id = String(handle); if (visited.has(id)) break; visited.add(id);
      const next = api.getWindow(handle, 2); // GW_HWNDNEXT preserves native topmost-first order.
      try {
        if (api.isWindowVisible(handle) && !api.isIconic(handle)) {
          const cloaked = Buffer.alloc(4);
          const invisible = api.dwmGetWindowAttribute?.(handle, 14, cloaked, cloaked.length) === 0 && cloaked.readUInt32LE(0) !== 0;
          const className = readNativeText((output, length) => api.getClassName(handle, output, length), 256);
          if (!invisible && !['Progman', 'WorkerW'].includes(className)) {
            const rect = Buffer.alloc(16);
            const framed = api.dwmGetWindowAttribute?.(handle, 9, rect, rect.length) === 0; // DWMWA_EXTENDED_FRAME_BOUNDS omits invisible resize shadows.
            if (framed || api.getWindowRect(handle, rect)) {
              const bounds = nativeRect(rect);
              if (bounds) windows.push({ id: `window:${id}`, name: readNativeText((output, length) => api.getWindowText(handle, output, length), 501) || (className === 'Shell_TrayWnd' || className === 'Shell_SecondaryTrayWnd' ? '任务栏' : '窗口'), bounds });
            }
          }
        }
      } catch { /* A window can be destroyed between enumeration and its bounds query. */ }
      handle = next;
    }
    return { available: true, windows };
  } catch { return { available: false, windows }; }
}

export function intersectCaptureRect(rect: CaptureScreenRect, display: CaptureScreenRect): CaptureScreenRect | undefined {
  if (![rect.x, rect.y, rect.width, rect.height, display.x, display.y, display.width, display.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return undefined;
  const x = Math.max(rect.x, display.x), y = Math.max(rect.y, display.y);
  const width = Math.min(rect.x + rect.width, display.x + display.width) - x;
  const height = Math.min(rect.y + rect.height, display.y + display.height) - y;
  return width >= 2 && height >= 2 ? { x, y, width, height } : undefined;
}

/** Clip in physical space before converting a window spanning mixed-DPI displays. */
export function nativeCaptureRectToDisplayDip(rect: CaptureScreenRect, physicalDisplay: CaptureScreenRect, dipDisplay: CaptureScreenRect): CaptureScreenRect | undefined {
  const clipped = intersectCaptureRect(rect, physicalDisplay); if (!clipped) return undefined;
  return { x: dipDisplay.x + (clipped.x - physicalDisplay.x) / physicalDisplay.width * dipDisplay.width,
    y: dipDisplay.y + (clipped.y - physicalDisplay.y) / physicalDisplay.height * dipDisplay.height,
    width: clipped.width / physicalDisplay.width * dipDisplay.width, height: clipped.height / physicalDisplay.height * dipDisplay.height };
}

export type CaptureRecordingBoundarySide = 'top' | 'right' | 'bottom' | 'left';
/** All rectangles are physical pixels and strictly outside the saved source crop. */
export function recordingBoundaryRectangles(capture: CaptureScreenRect, thickness = 2, display?: CaptureScreenRect): Array<{ side: CaptureRecordingBoundarySide; bounds: CaptureScreenRect }> {
  if (![capture.x, capture.y, capture.width, capture.height].every(Number.isFinite) || capture.width <= 0 || capture.height <= 0) return [];
  const line = Math.max(1, Math.min(8, Math.round(thickness)));
  const snap = (value: number) => Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : value;
  const left = Math.floor(snap(capture.x)), top = Math.floor(snap(capture.y));
  const right = Math.ceil(snap(capture.x + capture.width)), bottom = Math.ceil(snap(capture.y + capture.height));
  const sides: Array<{ side: CaptureRecordingBoundarySide; bounds: CaptureScreenRect }> = [
    { side: 'top', bounds: { x: left - line, y: top - line, width: right - left + line * 2, height: line } },
    { side: 'right', bounds: { x: right, y: top, width: line, height: bottom - top } },
    { side: 'bottom', bounds: { x: left - line, y: bottom, width: right - left + line * 2, height: line } },
    { side: 'left', bounds: { x: left - line, y: top, width: line, height: bottom - top } },
  ];
  if (!display) return sides;
  return sides.flatMap(({ side, bounds }) => {
    const x = Math.max(bounds.x, display.x), y = Math.max(bounds.y, display.y);
    const width = Math.min(bounds.x + bounds.width, display.x + display.width) - x;
    const height = Math.min(bounds.y + bounds.height, display.y + display.height) - y;
    return width > 0 && height > 0 ? [{ side, bounds: { x, y, width, height } }] : [];
  });
}

/** Fixed, fileless canvas page: only the thin outside strips are opaque. */
export function recordingBoundaryPage(display: CaptureScreenRect, rectangles: readonly CaptureScreenRect[]): string {
  const style = 'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%;background:transparent}';
  const local = rectangles.map(rect => ({ x: rect.x - display.x, y: rect.y - display.y, width: rect.width, height: rect.height }));
  const script = `const c=document.querySelector('canvas');c.width=${Math.round(display.width)};c.height=${Math.round(display.height)};const ratio=devicePixelRatio||1;c.style.width=c.width/ratio+'px';c.style.height=c.height/ratio+'px';const ctx=c.getContext('2d',{alpha:true});if(ctx){ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#527fde';for(const r of ${JSON.stringify(local)})ctx.fillRect(r.x,r.y,r.width,r.height);}`;
  const hash = (value: string) => createHash('sha256').update(value).digest('base64');
  const policy = `default-src 'none';script-src 'sha256-${hash(script)}';style-src 'sha256-${hash(style)}';connect-src 'none';base-uri 'none';form-action 'none';object-src 'none';frame-src 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>WorldlineBox · 录制范围</title><style>${style}</style></head><body><canvas aria-hidden="true"></canvas><script>${script}</script></body></html>`;
}

/** Called only while the screen is unobstructed, immediately before showing its frozen overlay. */
export function createCaptureDesktopContext(options: {
  display: { id: number; bounds: CaptureScreenRect; workArea: CaptureScreenRect; scaleFactor: number };
  cursor: { x: number; y: number };
  native: ReturnType<typeof readWindowsDesktopRegions>;
  nativeMonitor?: NativeCaptureMonitor;
  screenToDipRect(rect: CaptureScreenRect): CaptureScreenRect | undefined;
}): CaptureDesktopContext {
  const { display, native, cursor } = options;
  const bounds = { ...display.bounds };
  const workArea = (options.nativeMonitor ? nativeCaptureRectToDisplayDip(options.nativeMonitor.workArea, options.nativeMonitor.bounds, bounds) : undefined)
    ?? intersectCaptureRect(display.workArea, bounds) ?? bounds;
  const candidates: CaptureDesktopRegion[] = [];
  for (const window of native.windows) {
    let clipped: CaptureScreenRect | undefined;
    try { const converted = options.screenToDipRect(window.bounds); clipped = converted ? intersectCaptureRect(converted, bounds) : undefined; } catch { continue; }
    if (clipped) candidates.push({ id: window.id, kind: 'window', name: window.name.slice(0, 500), bounds: clipped });
    if (candidates.length === 256) break;
  }
  candidates.push({ id: `workarea:${display.id}`, kind: 'workarea', name: '桌面工作区（不含任务栏）', bounds: workArea });
  candidates.push({ id: `screen:${display.id}`, kind: 'screen', name: '整个屏幕（含任务栏）', bounds });
  return { displayId: String(display.id), bounds, workArea, scaleFactor: display.scaleFactor, cursor: { ...cursor }, windowSnapping: native.available, candidates,
    ...(options.nativeMonitor ? { pixelBounds: options.nativeMonitor.bounds, pixelWorkArea: options.nativeMonitor.workArea } : {}) };
}

/** A visible controller must be wholly outside the actual output crop. */
export function placeCaptureRecordingControls(options: {
  /** Window sources exclude independent utility windows and need no screen crop avoidance. */
  capture?: CaptureScreenRect;
  displayId: string;
  displays: Array<{ id: number; workArea: CaptureScreenRect; bounds?: CaptureScreenRect }>;
}): CaptureRecordingControls {
  const { capture } = options;
  const source = options.displays.find(display => String(display.id) === options.displayId);
  const displays = source ? [source, ...options.displays.filter(display => display !== source)] : options.displays;
  const areas = displays.flatMap(display => [{ bounds: display.workArea, margin: 12 }, ...(display.bounds ? [{ bounds: display.bounds, margin: 2 }] : [])]);
  for (const { bounds: area, margin } of areas) {
    const width = Math.min(320, area.width - margin * 2), height = 44;
    if (width < 280 || area.height < height + margin * 2) continue;
    const clampX = (x: number) => Math.max(area.x + margin, Math.min(x, area.x + area.width - width - margin));
    const clampY = (y: number) => Math.max(area.y + margin, Math.min(y, area.y + area.height - height - margin));
    const center = capture ? clampX(capture.x + (capture.width - width) / 2) : area.x + margin;
    const candidates = [...(capture ? [
      { x: center, y: capture.y + capture.height + margin },
      { x: center, y: capture.y - height - margin },
      { x: capture.x + capture.width + margin, y: clampY(capture.y + (capture.height - height) / 2) },
      { x: capture.x - width - margin, y: clampY(capture.y + (capture.height - height) / 2) },
    ] : []),
      { x: area.x + margin, y: area.y + margin },
      { x: area.x + area.width - width - margin, y: area.y + area.height - height - margin },
    ];
    for (const point of candidates) {
      const bounds = { x: Math.round(point.x), y: Math.round(point.y), width: Math.floor(width), height };
      const contained = bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + height <= area.y + area.height;
      const overlaps = !!capture && bounds.x < capture.x + capture.width && bounds.x + bounds.width > capture.x && bounds.y < capture.y + capture.height && bounds.y + height > capture.y;
      if (contained && !overlaps) return { hidden: false, bounds };
    }
  }
  // On a sole full display no geometric outside exists. Hiding only this app's
  // controller keeps it out of the file without opting out of remote sharing.
  return { hidden: true };
}
