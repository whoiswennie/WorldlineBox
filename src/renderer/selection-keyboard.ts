/**
 * Browse-canvas selection chords (WorldlineBox-5fq + Escape clear).
 *
 * Pure match helpers — App / useSelectionKeyboard own the DOM listeners.
 * Invert uses Ctrl+I (Windows) / ⌘I (mac); Edit-menu label still depends on
 * a custom mac Edit shell (ticket follow-up), keyboard is wired now.
 */

import {
  type CommandPlatform,
  type ShortcutSpec,
} from "./commands/command-types";
import { matchesRuntimeShortcut } from "./shortcut-runtime";
import type { ShortcutEventLike } from "../shared/shortcut-resolution";

/** Select all visible assets: ⌘A / Ctrl+A. */
export const SELECT_ALL_SHORTCUT: ShortcutSpec = {
  mac: { label: "⌘A", key: "a", metaKey: true },
  windows: { label: "Ctrl+A", key: "a", ctrlKey: true },
};

/** Invert selection among visible assets: ⌘I / Ctrl+I (WorldlineBox-5fq). */
export const INVERT_SELECTION_SHORTCUT: ShortcutSpec = {
  mac: { label: "⌘I", key: "i", metaKey: true },
  windows: { label: "Ctrl+I", key: "i", ctrlKey: true },
};

export type SelectionKeyboardAction = "select-all" | "invert" | "clear";

export type SelectionKeyboardDispatch = {
  /** True when the browse scope has no loaded rows (select-all/invert no-op). */
  readonly browseScopeEmpty: boolean;
  /** True when nothing is selected (Escape-clear no-op). */
  readonly selectionEmpty: boolean;
  readonly onSelectAll?: () => void;
  readonly onInvert?: () => void;
  readonly onClear?: () => void;
};

/**
 * Dispatch a matched selection-keyboard action against the current canvas
 * state. Returns true when the keydown was consumed (caller must
 * preventDefault). Guards preserve the synchronous pre-pagination behavior:
 * select-all/invert are no-ops on an empty scope (WorldlineBox-ws4k — the async
 * select-all/invert callbacks must therefore also no-op on null/empty id sets
 * instead of clearing the selection), and Escape-clear is a no-op on an empty
 * selection.
 */
export function dispatchSelectionKeyboardAction(
  action: SelectionKeyboardAction | null,
  dispatch: SelectionKeyboardDispatch,
): boolean {
  if (action === "select-all") {
    if (dispatch.browseScopeEmpty) return false;
    dispatch.onSelectAll?.();
    return true;
  }
  if (action === "invert") {
    if (dispatch.browseScopeEmpty) return false;
    dispatch.onInvert?.();
    return true;
  }
  if (action === "clear") {
    if (dispatch.selectionEmpty) return false;
    dispatch.onClear?.();
    return true;
  }
  return false;
}

export function matchSelectionKeyboardAction(
  event: ShortcutEventLike,
  platform: CommandPlatform,
): SelectionKeyboardAction | null {
  if (matchesRuntimeShortcut("selection.select-all", event, platform) === true) return "select-all";
  if (matchesRuntimeShortcut("selection.invert", event, platform) === true) {
    return "invert";
  }
  if (
    event.kind !== "mouse" && event.key === "Escape" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return "clear";
  }
  return null;
}

export function isEditableSelectionKeyboardTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
