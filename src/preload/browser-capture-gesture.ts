import type { BrowserCaptureContentRequest } from '../shared/browser-capture';

const ACTIVE_DRAG_MS = 15_000;
const SAVE_AFTER_DROP_MS = 5_000;

/** Per-frame authority held only in the isolated preload, never in page DOM. */
export function createBrowserCaptureGestureGate(now: () => number = () => performance.now()) {
  let activeUntil = 0;
  let saveUntil = 0;
  let nativeLocalUntil = 0;

  return {
    observe(event: Pick<Event, 'type' | 'isTrusted'>): void {
      if (!event.isTrusted) return;
      const time = now();
      if (event.type === 'dragstart') {
        activeUntil = time + ACTIVE_DRAG_MS;
        saveUntil = 0;
        nativeLocalUntil = 0;
      } else if (event.type === 'dragover' && activeUntil > time) {
        activeUntil = time + ACTIVE_DRAG_MS;
      } else if (event.type === 'drop') {
        // A script-created drop during a real drag cannot grant save authority.
        if (activeUntil > time) saveUntil = time + SAVE_AFTER_DROP_MS;
        activeUntil = 0;
      } else if (event.type === 'dragend') activeUntil = 0;
    },
    nativeEvent(event: unknown): void {
      if (!event || typeof event !== 'object' || Reflect.get(event, 'type') !== 'runtime.message') return;
      const message: unknown = Reflect.get(event, 'message');
      if (message && typeof message === 'object' && Reflect.get(message, 'type') === 'worldlinebox-local-context-save-request') {
        nativeLocalUntil = now() + SAVE_AFTER_DROP_MS;
      }
    },
    authorize(request: BrowserCaptureContentRequest): boolean {
      if (request.type !== 'runtime.message') return true;
      const type = request.message.type;
      if (type === 'worldlinebox-connection-status') return true;
      const time = now();
      if (type === 'worldlinebox-list-folders') return activeUntil > time;
      if (type === 'worldlinebox-local-save-request' && nativeLocalUntil > time) {
        nativeLocalUntil = 0;
        return true;
      }
      if (saveUntil > time) {
        saveUntil = 0;
        return true;
      }
      return false;
    },
  };
}
