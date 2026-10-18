/**
 * Discovery toolbar chords (WorldlineBox-x78x / REQ-COMMAND-004).
 *
 * Pure match helpers — useBrowseCommandKeyboard owns the DOM listener.
 */

import {
  matchesShortcut,
  type CommandPlatform,
  type ShortcutEvent,
  type ShortcutSpec,
} from "./commands/command-types";
import {
  asLegacyKeyboardShortcutEvent,
  matchesRuntimeShortcut,
} from "./shortcut-runtime";
import type { ShortcutEventLike } from "../shared/shortcut-resolution";

/** Focus the library search field: ⌘F / Ctrl+F. */
export const FOCUS_SEARCH_SHORTCUT: ShortcutSpec = {
  mac: { label: "⌘F", key: "f", metaKey: true },
  windows: { label: "Ctrl+F", key: "f", ctrlKey: true },
};

export function matchFocusSearchShortcut(
  event: ShortcutEvent | ShortcutEventLike,
  platform: CommandPlatform,
): boolean {
  const resolved = matchesRuntimeShortcut("workspace.focus-search", event, platform);
  if (resolved !== null) return resolved;
  const keyboardEvent = "key" in event ? asLegacyKeyboardShortcutEvent(event) : null;
  return keyboardEvent !== null && matchesShortcut(FOCUS_SEARCH_SHORTCUT, keyboardEvent, platform);
}

export function isLibrarySearchInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement &&
    target.classList.contains("search-control")
  );
}
