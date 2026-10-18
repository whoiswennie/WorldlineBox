/**
 * Global Cmd/Ctrl+= / - / 0 zoom chords (WorldlineBox-46i9).
 *
 * Pure helpers so matching and step math stay unit-testable outside Electron.
 * Viewer surfaces zoom at the viewport center (0 = fit); browse canvas uses the
 * same exponential step as Ctrl+wheel card-size zoom (0 = default card size).
 */

import {
  CARD_SIZE_MAX,
  CARD_SIZE_MIN,
  DEFAULT_CANVAS_PREFERENCES,
} from "./canvas-preferences";
import type { CommandPlatform } from "./commands/command-types";
import { clampViewerScale } from "./viewer-fit";
import { isEditableKeyboardTarget } from "./video-player-controls";
import { matchesRuntimeShortcut } from "./shortcut-runtime";
import type { ShortcutEventLike } from "../shared/shortcut-resolution";
import { hasActiveModalDialog } from "./use-dialog-focus-trap";

export type GlobalZoomAction = "in" | "out" | "reset";

export const GLOBAL_ZOOM_MENU_ACTION_EVENT = "worldlinebox:global-zoom-menu-action";

export function dispatchGlobalZoomMenuAction(action: GlobalZoomAction): void {
  window.dispatchEvent(
    new CustomEvent(GLOBAL_ZOOM_MENU_ACTION_EVENT, { detail: action }),
  );
}

/**
 * One keyboard notch ≈ mouse-wheel deltaY of 100 at the shared 0.002 gain
 * used by viewer wheel zoom and browse Ctrl+wheel card zoom.
 */
export const GLOBAL_KEYBOARD_ZOOM_FACTOR = Math.exp(0.2);

export type GlobalZoomShortcutEvent = ShortcutEventLike;

/**
 * Match Cmd/Ctrl+=|+ / -|_ / 0. `+` may arrive with Shift (Shift+=); that is
 * allowed only for zoom-in. Alt always rejects. Platform modifiers are exact
 * (mac meta, windows ctrl) — same precision as matchesShortcut.
 */
export function matchGlobalZoomShortcut(
  event: GlobalZoomShortcutEvent,
  platform: CommandPlatform,
): GlobalZoomAction | null {
  if (matchesRuntimeShortcut("canvas.zoom-in", event, platform)) return "in";
  if (matchesRuntimeShortcut("canvas.zoom-out", event, platform)) return "out";
  if (matchesRuntimeShortcut("canvas.zoom-reset", event, platform)) return "reset";
  return null;
}

export function nextKeyboardZoomScale(
  scale: number,
  action: "in" | "out",
): number {
  const next =
    action === "in"
      ? scale * GLOBAL_KEYBOARD_ZOOM_FACTOR
      : scale / GLOBAL_KEYBOARD_ZOOM_FACTOR;
  return clampViewerScale(next);
}

export function nextKeyboardCardSize(
  size: number,
  action: "in" | "out",
): number {
  const next =
    action === "in"
      ? size * GLOBAL_KEYBOARD_ZOOM_FACTOR
      : size / GLOBAL_KEYBOARD_ZOOM_FACTOR;
  return Math.min(CARD_SIZE_MAX, Math.max(CARD_SIZE_MIN, Math.round(next)));
}

export function defaultKeyboardCardSize(): number {
  return DEFAULT_CANVAS_PREFERENCES.cardSize;
}

/** True when the event target should keep the chord (inputs / dialogs). */
export function shouldIgnoreGlobalZoomShortcut(
  target: EventTarget | null,
): boolean {
  return hasActiveModalDialog() || isEditableKeyboardTarget(target);
}

/** Keep text controls and modal owners ahead of native View accelerators. */
export function dispatchGlobalZoomMenuCommandIfAllowed(
  action: GlobalZoomAction,
  target: EventTarget | null,
  modalOpen: boolean,
  dispatch: (action: GlobalZoomAction) => void = dispatchGlobalZoomMenuAction,
): boolean {
  if (modalOpen || shouldIgnoreGlobalZoomShortcut(target)) return false;
  dispatch(action);
  return true;
}
