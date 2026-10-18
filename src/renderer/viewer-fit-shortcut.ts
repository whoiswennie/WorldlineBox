/** Viewer-wide keyboard gesture for returning media to contain-fit. */
import { matchesRuntimeShortcut } from "./shortcut-runtime";
import type { ShortcutEventLike } from "../shared/shortcut-resolution";
import {
  isTypingKeyboardTarget,
  type KeyboardTargetLike,
} from "./video-player-controls";

export function isViewerFitShortcut(event: ShortcutEventLike): boolean {
  return matchesRuntimeShortcut("viewer.fit", event) === true;
}

/** Shared ownership check for image, video, and GIF viewer fit handlers. */
export function shouldHandleViewerFitKeyboardEvent(
  event: ShortcutEventLike & {
    target: KeyboardTargetLike | EventTarget;
  },
  options: { modalOpen: boolean },
): boolean {
  if (options.modalOpen || event.repeat || isTypingKeyboardTarget(event.target)) {
    return false;
  }
  return isViewerFitShortcut(event);
}
