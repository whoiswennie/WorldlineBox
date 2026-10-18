/**
 * Document-level select-all / invert / Escape-clear for the browse canvas
 * (WorldlineBox-5fq; Escape extract from App for WorldlineBox-uye wave).
 *
 * Asset open/trash/rename chords live in useBrowseCommandKeyboard.
 * This hook only owns selection set mutations so Escape/metadata/restore
 * can keep splitting independently.
 *
 * WorldlineBox-ws4k: select-all / invert cover the *whole* browse scope, not just
 * the loaded page, so they resolve the full id set on demand (idsOnly) through
 * the onSelectAll / onInvert callbacks. The dispatch logic itself lives in
 * `dispatchSelectionKeyboardAction` (pure, unit-tested); this hook only wires
 * the DOM listener.
 */

import { useEffect } from "react";

import type { CommandPlatform } from "./commands/command-types";
import type { ShortcutEventLike } from "../shared/shortcut-resolution";
import { listenForShortcutInputs } from "./shortcut-runtime";
import {
  dispatchSelectionKeyboardAction,
  isEditableSelectionKeyboardTarget,
  matchSelectionKeyboardAction,
} from "./selection-keyboard";

export type UseSelectionKeyboardArgs = {
  readonly enabled: boolean;
  readonly platform: CommandPlatform;
  readonly previewOpen: boolean;
  /** Loaded browse-scope asset ids (WorldlineBox-6w7n); gates select-all/invert on a non-empty scope. */
  readonly browseScopeAssetIds: readonly string[];
  readonly selectedAssetIds: readonly string[];
  readonly clearAssetSelection: () => void;
  /** WorldlineBox-ws4k: async select-all covering the whole browse scope (idsOnly). */
  readonly onSelectAll?: () => void;
  /** WorldlineBox-ws4k: async invert covering the whole browse scope (idsOnly). */
  readonly onInvert?: () => void;
};

export function useSelectionKeyboard(args: UseSelectionKeyboardArgs): void {
  const {
    enabled,
    platform,
    previewOpen,
    browseScopeAssetIds,
    selectedAssetIds,
    clearAssetSelection,
    onSelectAll,
    onInvert,
  } = args;

  useEffect(() => {
    if (!enabled) return;

    const onShortcutInput = (shortcutInput: ShortcutEventLike, event: KeyboardEvent | MouseEvent) => {
      if (isEditableSelectionKeyboardTarget(event.target)) return;
      if (previewOpen) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;

      const action = matchSelectionKeyboardAction(shortcutInput, platform);
      const consumed = dispatchSelectionKeyboardAction(action, {
        browseScopeEmpty: browseScopeAssetIds.length === 0,
        selectionEmpty: selectedAssetIds.length === 0,
        onSelectAll,
        onInvert,
        onClear: clearAssetSelection,
      });
      if (consumed) event.preventDefault();
    };

    return listenForShortcutInputs(document, onShortcutInput);
  }, [
    enabled,
    platform,
    previewOpen,
    browseScopeAssetIds,
    selectedAssetIds,
    clearAssetSelection,
    onSelectAll,
    onInvert,
  ]);
}
