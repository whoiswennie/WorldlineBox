export const COMPANION_GAZE_POINTER_CHANNEL = 'companion-gaze:pointer';
/** CSS viewport coordinates, including points outside the application window.
 * Main obtains both desktop values in Electron DIP before applying page zoom. */
export interface CompanionGazePoint { x: number; y: number }
export type CompanionGazeResult = { ok: true; point: CompanionGazePoint } | { ok: false };
export type CompanionGazeReader = () => Promise<CompanionGazeResult>;
export function parseCompanionGazeResult(value: unknown): CompanionGazeResult {
  if (!value || typeof value !== 'object') return { ok: false };
  const input = value as { ok?: unknown; point?: { x?: unknown; y?: unknown } };
  return input.ok === true && typeof input.point?.x === 'number' && Number.isFinite(input.point.x)
    && typeof input.point.y === 'number' && Number.isFinite(input.point.y)
    ? { ok: true, point: { x: input.point.x, y: input.point.y } } : { ok: false };
}
