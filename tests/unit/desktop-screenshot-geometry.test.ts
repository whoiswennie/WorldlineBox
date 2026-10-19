import { describe, expect, it } from 'vitest';
import { desktopRectToPixels, moveScreenshotSelection, relativeScreenshotAnnotations, resizeScreenshotSelection, screenshotChatPosition, screenshotToolbarPosition } from '../../src/renderer/capture-tools/desktop-screenshot-geometry';

describe('desktop screenshot geometry', () => {
  it('maps negative-origin monitor DIP to the actual source pixel dimensions once', () => {
    expect(desktopRectToPixels({ x: -1180, y: 60, width: 700, height: 500 }, { x: -1280, y: 0, width: 1280, height: 720 }, { width: 1600, height: 900 }))
      .toEqual({ x: 125, y: 75, width: 875, height: 625 });
  });
  it('keeps physical taskbar pixels available while allowing a workarea crop', () => {
    const display = { x: 0, y: -900, width: 1600, height: 900 }; const image = { width: 2400, height: 1350 };
    expect(desktopRectToPixels(display, display, image)).toEqual({ x: 0, y: 0, ...image });
    expect(desktopRectToPixels({ ...display, height: 860 }, display, image)).toEqual({ x: 0, y: 0, width: 2400, height: 1290 });
  });
  it('supports reverse resize and clamps movement at monitor edges', () => {
    expect(resizeScreenshotSelection({ x: 100, y: 100, width: 200, height: 100 }, 'nw', { x: 350, y: 250 }, { width: 600, height: 400 }))
      .toEqual({ x: 300, y: 200, width: 50, height: 50 });
    expect(moveScreenshotSelection({ x: 100, y: 100, width: 200, height: 100 }, { x: 900, y: -900 }, { width: 600, height: 400 }))
      .toEqual({ x: 400, y: 0, width: 200, height: 100 });
  });
  it('round-trips native physical workarea pixels without including a fractional taskbar row', () => {
    expect(desktopRectToPixels({ x: 0, y: 0, width: 1707, height: 1528 / 1600 * 1067 },
      { x: 0, y: 0, width: 1707, height: 1067 }, { width: 2560, height: 1600 }))
      .toEqual({ x: 0, y: 0, width: 2560, height: 1528 });
  });
  it('keeps annotations anchored on the original screen while crops move or resize', () => {
    expect(relativeScreenshotAnnotations([{ tool: 'redact', from: { x: 120, y: 140 }, to: { x: 180, y: 190 }, size: 4 },
      { tool: 'text', at: { x: 150, y: 170 }, text: 'Private', color: '#fff', size: 26 }], { x: 100, y: 120, width: 200, height: 100 }))
      .toEqual([{ tool: 'redact', from: { x: 20, y: 20 }, to: { x: 80, y: 70 }, size: 4 },
        { tool: 'text', at: { x: 50, y: 50 }, text: 'Private', color: '#fff', size: 26 }]);
  });
  it('keeps floating tools inside full-screen, bottom-edge and narrow selections', () => {
    const viewport = { width: 800, height: 600 }; const toolbar = { width: 740, height: 104 };
    for (const selection of [{ x: 0, y: 0, ...viewport }, { x: 760, y: 570, width: 40, height: 30 }, { x: 10, y: 10, width: 10, height: 10 }]) {
      const point = screenshotToolbarPosition(selection, toolbar, viewport);
      expect(point.x).toBeGreaterThanOrEqual(12); expect(point.y).toBeGreaterThanOrEqual(12);
      expect(point.x + toolbar.width).toBeLessThanOrEqual(viewport.width - 12); expect(point.y + toolbar.height).toBeLessThanOrEqual(viewport.height - 12);
    }
  });
  it('places temporary Q&A beside the selection or safely inside a full-screen crop', () => {
    expect(screenshotChatPosition({ x: 20, y: 30, width: 400, height: 200 }, { width: 352, height: 520 }, { width: 1280, height: 720 }))
      .toEqual({ x: 436, y: 30 });
    expect(screenshotChatPosition({ x: 0, y: 0, width: 800, height: 600 }, { width: 352, height: 520 }, { width: 800, height: 600 }))
      .toEqual({ x: 436, y: 12 });
  });
});
