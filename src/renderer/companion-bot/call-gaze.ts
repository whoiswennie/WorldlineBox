import type { CompanionGazeReader } from '../../shared/companion-gaze';
import type { WorldlineBoxShellApi } from '../../shared/external-url';

interface GazeTarget { point(x: number, y: number): void; leave(): void }
export function normalizeCallPointer(point: { x: number; y: number }, bounds: { left: number; top: number; width: number; height: number }) {
  if (bounds.width <= 0 || bounds.height <= 0 || ![point.x, point.y, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)) return;
  return { x: Math.max(-1, Math.min(1, (point.x - bounds.left) / bounds.width * 2 - 1)),
    y: Math.max(-1, Math.min(1, 1 - (point.y - bounds.top) / bounds.height * 2)) };
}
export function companionGazeReader(): CompanionGazeReader | undefined {
  return (window as typeof window & { worldlinebox?: { shell?: WorldlineBoxShellApi } }).worldlinebox?.shell?.getCompanionGazePointer;
}
/** One serialized native sample stream, bounded to 30 Hz. Capturing on the
 * window is a browser/test fallback and also sees pointer events over controls.
 * Crossing a UI boundary or losing window focus never resets the gaze target. */
export function trackCallGaze(host: HTMLElement, target: GazeTarget, read = companionGazeReader()) {
  let enabled = true, disposed = false, pending = false, revision = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let nativeAvailable = !!read;
  const apply = (point: { x: number; y: number }) => {
    if (!enabled || disposed) return;
    const normalized = normalizeCallPointer(point, host.getBoundingClientRect());
    if (normalized) target.point(normalized.x, normalized.y);
  };
  const fallback = (event: PointerEvent) => { if (!nativeAvailable) apply({ x: event.clientX, y: event.clientY }); };
  window.addEventListener('pointermove', fallback, true);
  const sample = async () => {
    if (!enabled || disposed || pending || !read) return;
    pending = true; const generation = revision;
    try {
      const result = await read();
      if (disposed || !enabled || generation !== revision) return;
      nativeAvailable = result.ok;
      if (result.ok) apply(result.point);
    } catch { if (generation === revision) nativeAvailable = false; }
    finally {
      pending = false;
      if (enabled && !disposed) timer = setTimeout(() => void sample(), 33);
    }
  };
  void sample();
  return {
    enabled(value: boolean) {
      if (enabled === value) return;
      enabled = value; revision++; clearTimeout(timer);
      if (!value) target.leave(); else void sample();
    },
    stop() { disposed = true; revision++; clearTimeout(timer); window.removeEventListener('pointermove', fallback, true); target.leave(); },
  };
}
