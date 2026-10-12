/**
 * REQ-VIEW-008 / VIEWER-001: restore browse scroll after the viewer closes.
 *
 * Two animation frames are not enough when the canvas extent is still
 * collapsed (host leaving the viewing overlay, virtual columns not yet
 * contributing minHeight). Clamping in that window finishes at scrollTop 0.
 * Retry until the live extent can hold the captured offset, matching the
 * workspace-navigation restore policy.
 */
import {
  browseRestoreExtentIsReady,
  resolveBrowseRestoreScroll,
  type BrowseViewSnapshot,
} from "./view-restore";

const STABLE_FRAMES_AFTER_READY = 2;
const MAX_ATTEMPTS = 120;

export function scheduleBrowseViewRestore(options: {
  canvas: HTMLElement;
  snapshot: BrowseViewSnapshot;
  isCurrent: () => boolean;
  onComplete?: () => void;
}): () => void {
  const { canvas, snapshot, isCurrent, onComplete } = options;
  let frame: number | undefined;
  let attempts = 0;
  let stableFrames = 0;
  let previousExtent = -1;
  let cancelled = false;

  const stop = (notify: boolean) => {
    if (cancelled) return;
    cancelled = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    canvas.removeEventListener("wheel", onUserInterrupt);
    canvas.removeEventListener("pointerdown", onUserInterrupt);
    canvas.removeEventListener("touchstart", onUserInterrupt);
    if (notify) onComplete?.();
  };
  const onUserInterrupt = () => stop(true);

  canvas.addEventListener("wheel", onUserInterrupt, { passive: true });
  canvas.addEventListener("pointerdown", onUserInterrupt);
  canvas.addEventListener("touchstart", onUserInterrupt, { passive: true });

  const apply = () => {
    frame = undefined;
    if (cancelled) return;
    if (!isCurrent()) {
      stop(false);
      return;
    }

    const extent = {
      scrollWidth: canvas.scrollWidth,
      scrollHeight: canvas.scrollHeight,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
    };
    const ready = browseRestoreExtentIsReady(snapshot, extent);
    canvas.scrollTo({ left: snapshot.scrollLeft, top: snapshot.scrollTop });
    const restoredCard = snapshot.anchor
      ? Array.from(canvas.querySelectorAll<HTMLElement>("[data-asset-id]")).find(
          (el) => el.dataset.assetId === snapshot.anchor!.assetId,
        )
      : null;
    const target = resolveBrowseRestoreScroll(
      snapshot,
      restoredCard?.getBoundingClientRect() ?? null,
      extent,
    );
    canvas.scrollTo({ left: target.left, top: target.top });

    const liveExtent = Math.max(0, extent.scrollHeight - extent.clientHeight);
    attempts += 1;
    if (ready) {
      stableFrames = Math.abs(liveExtent - previousExtent) <= 1 ? stableFrames + 1 : 0;
      previousExtent = liveExtent;
    } else {
      stableFrames = 0;
      previousExtent = liveExtent;
    }

    if ((ready && stableFrames >= STABLE_FRAMES_AFTER_READY) || attempts >= MAX_ATTEMPTS) {
      stop(true);
      return;
    }
    frame = window.requestAnimationFrame(apply);
  };

  frame = window.requestAnimationFrame(apply);
  return () => stop(false);
}
