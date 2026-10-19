import type { Annotation, Point, Rect, Size } from '../browser/screenshot/model';
import { clamp, integerCrop, rectangle } from '../browser/screenshot/model';

/** Native desktop metadata uses global DIP; crops and annotations always use source pixels. */
export function desktopRectToPixels(rect: Rect, display: Rect, image: Size): Rect {
  const x = clamp(rect.x - display.x, 0, display.width);
  const y = clamp(rect.y - display.y, 0, display.height);
  const exact = (value: number) => Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : value;
  return integerCrop({ x: exact(x / display.width * image.width), y: exact(y / display.height * image.height),
    width: exact(Math.max(1, Math.min(rect.width, display.width - x)) / display.width * image.width),
    height: exact(Math.max(1, Math.min(rect.height, display.height - y)) / display.height * image.height) }, image);
}

export function pointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

export function pixelRectToViewport(rect: Rect, image: Size, viewport: Size): Rect {
  return { x: rect.x / image.width * viewport.width, y: rect.y / image.height * viewport.height,
    width: rect.width / image.width * viewport.width, height: rect.height / image.height * viewport.height };
}

/** Stitched images and explicit window captures retain their pixel aspect ratio on resize. */
export function containScreenshotViewport(image: Size, viewport: Size): Rect {
  const scale = Math.min(viewport.width / Math.max(1, image.width), viewport.height / Math.max(1, image.height));
  const width = image.width * scale; const height = image.height * scale;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export function resizeScreenshotSelection(rect: Rect, handle: ResizeHandle, point: Point, image: Size): Rect {
  const left = handle.includes('w') ? point.x : rect.x;
  const right = handle.includes('e') ? point.x : rect.x + rect.width;
  const top = handle.includes('n') ? point.y : rect.y;
  const bottom = handle.includes('s') ? point.y : rect.y + rect.height;
  return integerCrop(rectangle({ x: left, y: top }, { x: right, y: bottom }), image);
}

export function moveScreenshotSelection(rect: Rect, offset: Point, image: Size): Rect {
  return { ...rect, x: Math.round(clamp(rect.x + offset.x, 0, image.width - rect.width)),
    y: Math.round(clamp(rect.y + offset.y, 0, image.height - rect.height)) };
}

export function relativeScreenshotAnnotations(annotations: readonly Annotation[], crop: Rect): Annotation[] {
  const point = (value: Point) => ({ x: value.x - crop.x, y: value.y - crop.y });
  return annotations.map(item => 'points' in item ? { ...item, points: item.points.map(point) }
    : 'at' in item ? { ...item, at: point(item.at) } : { ...item, from: point(item.from), to: point(item.to) });
}

/** Prefer below the crop, then above it; full-screen crops place tools inside the screen. */
export function screenshotToolbarPosition(selection: Rect, toolbar: Size, viewport: Size): Point {
  const margin = 12; const gap = 12;
  const maxLeft = Math.max(margin, viewport.width - toolbar.width - margin);
  const x = clamp(selection.x + selection.width - toolbar.width, margin, maxLeft);
  const below = selection.y + selection.height + gap;
  const above = selection.y - toolbar.height - gap;
  const y = below + toolbar.height <= viewport.height - margin ? below : above >= margin ? above
    : clamp(selection.y + selection.height - toolbar.height - gap, margin, Math.max(margin, viewport.height - toolbar.height - margin));
  return { x, y };
}

export function screenshotChatPosition(selection: Rect, panel: Size, viewport: Size): Point {
  const margin = 12; const gap = 16;
  const right = selection.x + selection.width + gap;
  const x = right + panel.width <= viewport.width - margin ? right
    : selection.x - panel.width - gap >= margin ? selection.x - panel.width - gap
      : Math.max(margin, viewport.width - panel.width - margin);
  return { x, y: clamp(selection.y, margin, Math.max(margin, viewport.height - panel.height - margin)) };
}
