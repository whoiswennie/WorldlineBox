import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createCaptureDesktopContext, intersectCaptureRect, nativeCaptureRectToDisplayDip, placeCaptureRecordingControls, positionCaptureWindowInPhysicalPixels, readWindowsCaptureMonitor, readWindowsDesktopRegions, recordingBoundaryPage, recordingBoundaryRectangles, type WindowsCaptureMonitorApi, type WindowsDesktopRegionsApi } from '../../src/main/capture-tools/desktop-regions';

function nativeFixture() {
  const records = [
    { id: 1, name: 'Foreground editor', className: 'EditorWindow', visible: true, iconic: false, cloaked: false, rect: [-2100, -40, -300, 1100] },
    { id: 2, name: 'Hidden editor', className: 'EditorWindow', visible: false, iconic: false, cloaked: false, rect: [0, 0, 600, 400] },
    { id: 3, name: 'Minimized editor', className: 'EditorWindow', visible: true, iconic: true, cloaked: false, rect: [0, 0, 600, 400] },
    { id: 4, name: 'Other desktop', className: 'EditorWindow', visible: true, iconic: false, cloaked: true, rect: [0, 0, 600, 400] },
    { id: 5, name: 'Desktop shell', className: 'WorkerW', visible: true, iconic: false, cloaked: false, rect: [0, 0, 1920, 1080] },
    { id: 6, name: '', className: 'Shell_TrayWnd', visible: true, iconic: false, cloaked: false, rect: [0, 1040, 1920, 1080] },
  ];
  const get = (id: number | bigint) => records.find(record => record.id === Number(id))!;
  const text = (value: string, buffer: Buffer, limit: number) => { const clipped = value.slice(0, limit - 1); buffer.write(clipped, 'utf16le'); return clipped.length; };
  const api: WindowsDesktopRegionsApi = {
    getTopWindow: vi.fn(() => 1), getWindow: vi.fn(id => records[records.findIndex(record => record.id === Number(id)) + 1]?.id ?? 0),
    isWindowVisible: vi.fn(id => Number(get(id).visible)), isIconic: vi.fn(id => Number(get(id).iconic)),
    getWindowRect: vi.fn((id, output) => { get(id).rect.forEach((value, index) => output.writeInt32LE(value, index * 4)); return 1; }),
    getWindowText: vi.fn((id, output, limit) => text(get(id).name, output, limit)),
    getClassName: vi.fn((id, output, limit) => text(get(id).className, output, limit)),
    dwmGetWindowAttribute: vi.fn((id, attribute, output) => {
      if (attribute === 14) output.writeUInt32LE(Number(get(id).cloaked));
      else get(id).rect.forEach((value, index) => output.writeInt32LE(value, index * 4));
      return 0;
    }),
  };
  return { api, records };
}

describe('desktop native regions', () => {
  it('queries the exact physical monitor and places the overlay without fractional-DIP rounding', () => {
    const api: WindowsCaptureMonitorApi = {
      monitorFromRect: vi.fn(() => 1),
      getMonitorInfo: vi.fn((_monitor, info) => {
        [0, 0, 2560, 1600, 0, 0, 2560, 1528].forEach((value, index) => info.writeInt32LE(value, 4 + index * 4)); return 1;
      }),
      setWindowPos: vi.fn(() => 1), setThreadDpiAwarenessContext: vi.fn(context => context === -4 ? -3 : -4),
    };
    const monitor = readWindowsCaptureMonitor({ x: 0, y: 0, width: 2561, height: 1601 }, api);
    expect(monitor).toEqual({ bounds: { x: 0, y: 0, width: 2560, height: 1600 }, workArea: { x: 0, y: 0, width: 2560, height: 1528 } });
    expect(api.setThreadDpiAwarenessContext).toHaveBeenNthCalledWith(1, -4); expect(api.setThreadDpiAwarenessContext).toHaveBeenNthCalledWith(2, -3);
    const handle = Buffer.alloc(8); handle.writeBigUInt64LE(42n);
    expect(positionCaptureWindowInPhysicalPixels(handle, monitor!.bounds, api)).toBe(true);
    expect(api.setWindowPos).toHaveBeenCalledWith(42n, -1, 0, 0, 2560, 1600, 0x0210);
    expect(readWindowsCaptureMonitor({ x: 0, y: 0, width: 100, height: 100 }, null)).toBeUndefined();
    const context = createCaptureDesktopContext({ display: { id: 1, bounds: { x: 0, y: 0, width: 1707, height: 1067 }, workArea: { x: 0, y: 0, width: 1707, height: 1019 }, scaleFactor: 1.5 },
      cursor: { x: 1, y: 1 }, native: { available: true, windows: [] }, nativeMonitor: monitor, screenToDipRect: rect => rect });
    expect(context.pixelBounds?.height).toBe(1600); expect(context.workArea.height / context.bounds.height * 1600).toBeCloseTo(1528, 10);
  });
  it('keeps topmost order, uses visible frame bounds and filters hidden/minimized/cloaked/desktop shell windows', () => {
    const { api } = nativeFixture();
    expect(readWindowsDesktopRegions(api)).toEqual({ available: true, windows: [
      { id: 'window:1', name: 'Foreground editor', bounds: { x: -2100, y: -40, width: 1800, height: 1140 } },
      { id: 'window:6', name: '任务栏', bounds: { x: 0, y: 1040, width: 1920, height: 40 } },
    ] });
    expect(api.getWindowRect).not.toHaveBeenCalled();
    expect(api.getWindow).toHaveBeenCalledWith(1, 2);
  });

  it('falls back to Win32 rectangles without DWM and terminates repeated native handles', () => {
    const { api } = nativeFixture(); delete api.dwmGetWindowAttribute;
    api.getWindow = vi.fn(() => 1);
    const result = readWindowsDesktopRegions(api);
    expect(result.windows).toHaveLength(1); expect(api.getWindowRect).toHaveBeenCalledOnce(); expect(api.getWindow).toHaveBeenCalledOnce();
    expect(readWindowsDesktopRegions(null)).toEqual({ available: false, windows: [] });
  });

  it('transforms physical bounds once at 150% DPI, clips negative-origin monitors and includes both taskbar choices', () => {
    const display = { id: 10, bounds: { x: -1440, y: -100, width: 1440, height: 900 }, workArea: { x: -1400, y: -100, width: 1400, height: 900 }, scaleFactor: 1.5 };
    const convert = vi.fn((rect: { x: number; y: number; width: number; height: number }) => ({ x: rect.x / 1.5, y: rect.y / 1.5, width: rect.width / 1.5, height: rect.height / 1.5 }));
    const context = createCaptureDesktopContext({ display, cursor: { x: -1000, y: 200 }, native: { available: true, windows: [
      { id: 'window:1', name: 'Editor', bounds: { x: -2250, y: -225, width: 1200, height: 1200 } },
      { id: 'window:2', name: 'Other monitor', bounds: { x: 500, y: 0, width: 400, height: 400 } },
    ] }, screenToDipRect: convert });
    expect(context.bounds).toEqual(display.bounds); expect(context.workArea).toEqual(display.workArea); expect(context.scaleFactor).toBe(1.5);
    expect(context.cursor).toEqual({ x: -1000, y: 200 });
    expect(context.candidates).toEqual([
      { id: 'window:1', kind: 'window', name: 'Editor', bounds: { x: -1440, y: -100, width: 740, height: 750 } },
      { id: 'workarea:10', kind: 'workarea', name: '桌面工作区（不含任务栏）', bounds: display.workArea },
      { id: 'screen:10', kind: 'screen', name: '整个屏幕（含任务栏）', bounds: display.bounds },
    ]);
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it('keeps workarea/display fallback regions available when native discovery is unavailable', () => {
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const context = createCaptureDesktopContext({ display: { id: 1, bounds, workArea: { x: 0, y: 40, width: 1920, height: 1040 }, scaleFactor: 1.25 },
      cursor: { x: 0, y: 0 }, native: { available: false, windows: [] }, screenToDipRect: rect => rect });
    expect(context.windowSnapping).toBe(false); expect(context.candidates.map(candidate => candidate.kind)).toEqual(['workarea', 'screen']);
    expect(intersectCaptureRect({ x: NaN, y: 0, width: 100, height: 100 }, bounds)).toBeUndefined();
  });

  it('clips a spanning window in the selected monitor physical coordinate space before mixed-DPI conversion', () => {
    expect(nativeCaptureRectToDisplayDip({ x: -1000, y: -200, width: 1750, height: 950 },
      { x: 0, y: 0, width: 1500, height: 1200 }, { x: 0, y: 0, width: 1000, height: 800 })).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    expect(nativeCaptureRectToDisplayDip({ x: 0, y: 0, width: 100, height: 100 },
      { x: -1920, y: -100, width: 1920, height: 1080 }, { x: -1536, y: -80, width: 1536, height: 864 })).toBeUndefined();
  });
});

describe('recording controller outside output', () => {
  const displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  it('puts regional controls below the output without overlapping its pixels', () => {
    expect(placeCaptureRecordingControls({ displays, displayId: '1', capture: { x: 100, y: 100, width: 900, height: 600 } })).toEqual({ hidden: false,
      bounds: { x: 390, y: 712, width: 320, height: 44 } });
  });
  it('uses another monitor for a full-monitor recording and supports negative origins', () => {
    const second = { id: 2, workArea: { x: -1280, y: 0, width: 1280, height: 1024 } };
    const result = placeCaptureRecordingControls({ displays: [...displays, second], displayId: '1', capture: { x: 0, y: 0, width: 1920, height: 1080 } });
    expect(result.hidden).toBe(false); expect(result.bounds!.x).toBeLessThan(0); expect(result.bounds!.x + result.bounds!.width).toBeLessThanOrEqual(0);
  });
  it('hides the controller only when no outside rectangle can fit, including full sole display', () => {
    expect(placeCaptureRecordingControls({ displays, displayId: '1', capture: { x: 0, y: 0, width: 1920, height: 1080 } })).toEqual({ hidden: true });
    expect(placeCaptureRecordingControls({ displays, displayId: '1', capture: { x: 0, y: 0, width: 1920, height: 1000 } })).toEqual({ hidden: true });
  });
  it('keeps window-source controls in bounds on small displays and hides them when even the minimum cannot fit', () => {
    expect(placeCaptureRecordingControls({ displays: [{ id: 1, workArea: { x: -400, y: 20, width: 310, height: 200 } }], displayId: '1' })).toEqual({ hidden: false,
      bounds: { x: -388, y: 32, width: 286, height: 44 } });
    expect(placeCaptureRecordingControls({ displays: [{ id: 1, workArea: { x: 0, y: 0, width: 300, height: 200 } }], displayId: '1' })).toEqual({ hidden: true });
  });
  it('uses a 48 DIP taskbar strip for a workarea recording without including its controls in the file', () => {
    const bounds = { x: 0, y: 0, width: 1707, height: 1067 }, workArea = { x: 0, y: 0, width: 1707, height: 1019 };
    expect(placeCaptureRecordingControls({ displays: [{ id: 1, bounds, workArea }], displayId: '1', capture: workArea })).toEqual({ hidden: false,
      bounds: { x: 694, y: 1021, width: 320, height: 44 } });
    expect(placeCaptureRecordingControls({ displays: [{ id: 1, bounds, workArea }], displayId: '1', capture: bounds })).toEqual({ hidden: true });
  });
});

describe('native recording range boundary geometry', () => {
  const display = { x: 0, y: 0, width: 2560, height: 1600 };
  it('places four 2-pixel lines strictly outside the actual crop', () => {
    const capture = { x: 300, y: 200, width: 1200, height: 800 };
    const lines = recordingBoundaryRectangles(capture, 2, display);
    expect(lines).toEqual([
      { side: 'top', bounds: { x: 298, y: 198, width: 1204, height: 2 } },
      { side: 'right', bounds: { x: 1500, y: 200, width: 2, height: 800 } },
      { side: 'bottom', bounds: { x: 298, y: 1000, width: 1204, height: 2 } },
      { side: 'left', bounds: { x: 298, y: 200, width: 2, height: 800 } },
    ]);
    for (const { bounds } of lines) expect(bounds.x < capture.x + capture.width && bounds.x + bounds.width > capture.x && bounds.y < capture.y + capture.height && bounds.y + bounds.height > capture.y).toBe(false);
  });
  it('shows only the taskbar-side boundary for a workarea capture and creates no invisible full-monitor windows', () => {
    expect(recordingBoundaryRectangles({ x: 0, y: 0, width: 2560, height: 1528 }, 2, display)).toEqual([
      { side: 'bottom', bounds: { x: 0, y: 1528, width: 2560, height: 2 } },
    ]);
    expect(recordingBoundaryRectangles(display, 2, display)).toEqual([]);
  });
  it('supports negative monitor origins and avoids floating point one-pixel drift', () => {
    const monitor = { x: -2560, y: -120, width: 2560, height: 1600 };
    const lines = recordingBoundaryRectangles({ x: -2399.9999999999, y: 80.00000000001, width: 1000, height: 800 }, 2, monitor);
    expect(lines[0]?.bounds).toEqual({ x: -2402, y: 78, width: 1004, height: 2 });
    expect(recordingBoundaryRectangles({ x: NaN, y: 0, width: 100, height: 100 }, 2, monitor)).toEqual([]);
  });
  it('uses strict CSP hashes and an alpha canvas drawing only the physical outside strips', () => {
    const monitor = { x: -2560, y: -120, width: 2560, height: 1600 };
    const lines = recordingBoundaryRectangles({ x: -2200, y: 80, width: 1200, height: 800 }, 2, monitor);
    const html = recordingBoundaryPage(monitor, lines.map(line => line.bounds));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!, style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    for (const source of [script, style]) expect(html).toContain("'sha256-" + createHash('sha256').update(source).digest('base64') + "'");
    expect(html).toContain("default-src 'none'"); expect(html).toContain("connect-src 'none'"); expect(html).not.toMatch(/unsafe-inline|https?:\/\//);
    expect(style).toContain('background:transparent');
    const context = { clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
    const canvas = { width: 0, height: 0, style: { width: '', height: '' }, getContext: vi.fn(() => context) };
    runInNewContext(script, { document: { querySelector: () => canvas }, devicePixelRatio: 1.5 });
    expect(canvas).toMatchObject({ width: 2560, height: 1600 }); expect(canvas.getContext).toHaveBeenCalledWith('2d', { alpha: true });
    expect(canvas.style).toEqual({ width: 2560 / 1.5 + 'px', height: 1600 / 1.5 + 'px' });
    expect(context.clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 2560, 1600); expect(context.fillStyle).toBe('#527fde');
    expect(context.fillRect.mock.calls).toEqual(lines.map(({ bounds }) => [bounds.x - monitor.x, bounds.y - monitor.y, bounds.width, bounds.height]));
  });
});
