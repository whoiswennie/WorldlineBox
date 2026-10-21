import type * as Koffi from 'koffi';
import sharp from 'sharp';
import type { CaptureScreenRect } from '../../shared/capture-tools';

type Handle = number | bigint;
export interface WindowsSnapshotApi {
  getDC(window: Handle): Handle;
  releaseDC(window: Handle, dc: Handle): number;
  createDC(dc: Handle): Handle;
  deleteDC(dc: Handle): number;
  createBitmap(dc: Handle, width: number, height: number): Handle;
  deleteObject(object: Handle): number;
  selectObject(dc: Handle, object: Handle): Handle;
  bitBlt(dc: Handle, x: number, y: number, width: number, height: number, source: Handle, sourceX: number, sourceY: number, operation: number): number;
  getDIBits(dc: Handle, bitmap: Handle, start: number, lines: number, pixels: Buffer, info: Buffer, usage: number): number;
  setDpi(context: Handle): Handle;
  flush(): number;
}
let cached: WindowsSnapshotApi | null | undefined;
function nativeApi(): WindowsSnapshotApi | null {
  if (cached !== undefined) return cached;
  if (process.platform !== 'win32') return cached = null;
  try {
    // Main-only native calls; no helper process, permission bypass or resident
    // screen stream. Every invocation captures a fresh, physical monitor image.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof Koffi;
    const user = koffi.load('user32.dll'), gdi = koffi.load('gdi32.dll'), dwm = koffi.load('dwmapi.dll');
    return cached = {
      getDC: user.func('uintptr_t __stdcall GetDC(uintptr_t window)'),
      releaseDC: user.func('int __stdcall ReleaseDC(uintptr_t window, uintptr_t dc)'),
      createDC: gdi.func('uintptr_t __stdcall CreateCompatibleDC(uintptr_t dc)'),
      deleteDC: gdi.func('int __stdcall DeleteDC(uintptr_t dc)'),
      createBitmap: gdi.func('uintptr_t __stdcall CreateCompatibleBitmap(uintptr_t dc, int width, int height)'),
      deleteObject: gdi.func('int __stdcall DeleteObject(uintptr_t object)'),
      selectObject: gdi.func('uintptr_t __stdcall SelectObject(uintptr_t dc, uintptr_t object)'),
      bitBlt: gdi.func('int __stdcall BitBlt(uintptr_t dc, int x, int y, int width, int height, uintptr_t source, int sourceX, int sourceY, uint32_t operation)'),
      getDIBits: gdi.func('int __stdcall GetDIBits(uintptr_t dc, uintptr_t bitmap, uint32_t start, uint32_t lines, _Out_ uint8_t *pixels, uint8_t *info, uint32_t usage)'),
      setDpi: user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)'),
      flush: dwm.func('int32_t __stdcall DwmFlush()'),
    };
  } catch { return cached = null; }
}

/** Bounded GDI snapshot; always release native handles, including partial failures. */
export function windowsSnapshotPixels(bounds: CaptureScreenRect, api: WindowsSnapshotApi | null = nativeApi()): Buffer | undefined {
  if (!api || !Object.values(bounds).every(Number.isSafeInteger) || bounds.width < 2 || bounds.height < 2
    || bounds.width > 32768 || bounds.height > 32768 || bounds.width * bounds.height > 40_000_000) return undefined;
  let previous: Handle = 0, screen: Handle = 0, memory: Handle = 0, bitmap: Handle = 0, selected: Handle = 0;
  try {
    previous = api.setDpi(-4); // PER_MONITOR_AWARE_V2: x/y may be negative.
    // Synchronize the compositor after hiding the application/previous overlay.
    if (api.flush() < 0) return undefined;
    screen = api.getDC(0); if (!screen) return undefined;
    memory = api.createDC(screen); if (!memory) return undefined;
    bitmap = api.createBitmap(screen, bounds.width, bounds.height); if (!bitmap) return undefined;
    const previousBitmap = api.selectObject(memory, bitmap);
    if (!previousBitmap || previousBitmap === -1 || previousBitmap === 0xffffffff || previousBitmap === 0xffffffffffffffffn) return undefined;
    selected = previousBitmap;
    if (!api.bitBlt(memory, 0, 0, bounds.width, bounds.height, screen, bounds.x, bounds.y, 0x40cc0020)) return undefined; // SRCCOPY | CAPTUREBLT
    api.selectObject(memory, selected); selected = 0;
    const info = Buffer.alloc(40), pixels = Buffer.alloc(bounds.width * bounds.height * 4);
    info.writeUInt32LE(40); info.writeInt32LE(bounds.width, 4); info.writeInt32LE(-bounds.height, 8);
    info.writeUInt16LE(1, 12); info.writeUInt16LE(32, 14); // Top-down, uncompressed BGRA.
    if (api.getDIBits(screen, bitmap, 0, bounds.height, pixels, info, 0) !== bounds.height) return undefined;
    return pixels;
  } catch { return undefined; }
  finally {
    if (selected && memory) api.selectObject(memory, selected);
    if (bitmap) api.deleteObject(bitmap);
    if (memory) api.deleteDC(memory);
    if (screen) api.releaseDC(0, screen);
    if (previous) api.setDpi(previous);
  }
}

export async function windowsSnapshot(bounds: CaptureScreenRect): Promise<Buffer | undefined> {
  const pixels = windowsSnapshotPixels(bounds); if (!pixels) return undefined;
  // GDI's fourth channel is unused (often zero). Discard it and reorder BGR;
  // low PNG compression avoids the synchronous nativeImage.toPNG bottleneck.
  return sharp(pixels, { raw: { width: bounds.width, height: bounds.height, channels: 4 } }).removeAlpha()
    .recomb([[0, 0, 1], [0, 1, 0], [1, 0, 0]]).png({ compressionLevel: 1, adaptiveFiltering: false }).toBuffer();
}
