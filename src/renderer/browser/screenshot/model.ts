export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Size = { width: number; height: number };
export type ScreenshotTool = 'pen' | 'highlight' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'redact' | 'mosaic';
export type Annotation =
  | { tool: 'pen' | 'highlight'; points: Point[]; color: string; size: number }
  | { tool: 'arrow' | 'rect' | 'ellipse'; from: Point; to: Point; color: string; size: number }
  | { tool: 'text'; at: Point; text: string; color: string; size: number }
  | { tool: 'redact' | 'mosaic'; from: Point; to: Point; size: number };
export type EditHistory = { past: Annotation[][]; present: Annotation[]; future: Annotation[][] };
export const MAX_ANNOTATIONS = 200;
export const MAX_HISTORY = 60;
export const EMPTY_HISTORY: EditHistory = { past: [], present: [], future: [] };

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

export function imagePoint(client: Point, box: Rect, image: Size): Point {
  return {
    x: clamp((client.x - box.x) / Math.max(1, box.width) * image.width, 0, image.width),
    y: clamp((client.y - box.y) / Math.max(1, box.height) * image.height, 0, image.height),
  };
}

export function rectangle(from: Point, to: Point): Rect {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(from.x - to.x), height: Math.abs(from.y - to.y) };
}

export function integerCrop(rect: Rect, image: Size): Rect {
  const x = Math.floor(clamp(rect.x, 0, image.width - 1));
  const y = Math.floor(clamp(rect.y, 0, image.height - 1));
  return {
    x, y,
    width: Math.max(1, Math.min(image.width - x, Math.ceil(rect.x + rect.width) - x)),
    height: Math.max(1, Math.min(image.height - y, Math.ceil(rect.y + rect.height) - y)),
  };
}

export function fitSize(image: Size, limit: Size, upscale = false): Size {
  const scale = Math.min(upscale ? Infinity : 1, Math.max(1, limit.width) / Math.max(1, image.width), Math.max(1, limit.height) / Math.max(1, image.height));
  return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
}

export function commitEdit(history: EditHistory, next: Annotation[]): EditHistory {
  return { past: [...history.past, history.present].slice(-MAX_HISTORY), present: next.slice(0, MAX_ANNOTATIONS), future: [] };
}

export function undoEdit(history: EditHistory): EditHistory {
  const previous = history.past.at(-1);
  return previous ? { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] } : history;
}

export function redoEdit(history: EditHistory): EditHistory {
  const next = history.future[0];
  return next ? { past: [...history.past, history.present].slice(-MAX_HISTORY), present: next, future: history.future.slice(1) } : history;
}

export function screenshotFilename(now = new Date()): string {
  return `Screenshot-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
}
