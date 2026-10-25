/**
 * Browse-canvas F2 / Delete / Shift+Delete (WorldlineBox-g8u9).
 *
 * Windows frameless shell has no application menu, so these keys must be
 * matched from Main `before-input-event` / hidden accelerators as well as
 * Renderer `keydown`. Keep the matcher independent of DOM KeyboardEvent.
 *
 * Copy-path follows the user's shortcut bindings for both the asset and the
 * folder action. Callers that omit bindings keep the default chords.
 */

import {
  matchesActionShortcut,
  type ShortcutKeyboardEventLike,
} from "./shortcut-resolution";
import type { ShortcutPlatform } from "./shortcut-catalog";
import type { ShortcutBindings } from "./shortcut-bindings";

export const BROWSE_KEYBOARD_ACTIONS = [
  "rename",
  "trash",
  "disk-delete",
  "copy-path",
] as const;

export type BrowseKeyboardAction = (typeof BROWSE_KEYBOARD_ACTIONS)[number];

export type BrowseKeyboardInput = {
  readonly type?: string;
  readonly key?: string;
  readonly code?: string;
  readonly keyCode?: number;
  readonly control?: boolean;
  readonly ctrlKey?: boolean;
  readonly meta?: boolean;
  readonly metaKey?: boolean;
  readonly alt?: boolean;
  readonly altKey?: boolean;
  readonly shift?: boolean;
  readonly shiftKey?: boolean;
};

function isKeyDown(input: BrowseKeyboardInput): boolean {
  const type = input.type ?? "keyDown";
  return type === "keyDown" || type === "keydown";
}

function hasCtrl(input: BrowseKeyboardInput): boolean {
  return Boolean(input.control ?? input.ctrlKey);
}

function hasMeta(input: BrowseKeyboardInput): boolean {
  return Boolean(input.meta ?? input.metaKey);
}

function hasAlt(input: BrowseKeyboardInput): boolean {
  return Boolean(input.alt ?? input.altKey);
}

function isF2(input: BrowseKeyboardInput): boolean {
  const key = (input.key ?? "").toLowerCase();
  const code = (input.code ?? "").toLowerCase();
  return key === "f2" || code === "f2" || input.keyCode === 113;
}

function isDelete(input: BrowseKeyboardInput): boolean {
  const key = (input.key ?? "").toLowerCase();
  const code = (input.code ?? "").toLowerCase();
  return (
    key === "delete" ||
    key === "del" ||
    code === "delete" ||
    code === "del" ||
    input.keyCode === 46
  );
}

const COPY_PATH_ACTION_IDS = [
  "asset.copy-file-path",
  "folder.copy-path",
] as const;

function isCopyPathChord(input: BrowseKeyboardInput): boolean {
  const key = (input.key ?? "").toLowerCase();
  const code = (input.code ?? "").toLowerCase();
  if (key !== "c" && code !== "keyc") return false;
  const shift = Boolean(input.shift ?? input.shiftKey);
  const ctrl = hasCtrl(input);
  const meta = hasMeta(input);
  const alt = hasAlt(input);
  if (ctrl && shift && !meta && !alt) return true;
  return meta && alt && !ctrl && !shift;
}

function shortcutEventFromBrowseInput(
  input: BrowseKeyboardInput,
): ShortcutKeyboardEventLike {
  return {
    key: input.key ?? "",
    code: input.code,
    keyCode: input.keyCode,
    ctrlKey: hasCtrl(input),
    metaKey: hasMeta(input),
    altKey: hasAlt(input),
    shiftKey: Boolean(input.shift ?? input.shiftKey),
  };
}

export type BrowseCopyPathMatchOptions = {
  readonly bindings: ShortcutBindings;
  readonly platform: ShortcutPlatform;
};

/**
 * Match unmodified F2 / Delete / Shift+Delete, plus copy-path.
 * With bindings, copy-path uses the current asset and folder chords, so a
 * customized shortcut replaces the default. Without bindings, the default
 * Windows Ctrl+Shift+C and macOS Option+Command+C chords still match.
 */
export function matchBrowseKeyboardShortcut(
  input: BrowseKeyboardInput,
  copyPath?: BrowseCopyPathMatchOptions,
): BrowseKeyboardAction | null {
  if (!isKeyDown(input)) return null;
  const shift = Boolean(input.shift ?? input.shiftKey);
  if (!hasCtrl(input) && !hasMeta(input) && !hasAlt(input)) {
    if (isF2(input) && !shift) return "rename";
    if (isDelete(input) && shift) return "disk-delete";
    if (isDelete(input) && !shift) return "trash";
  }
  if (copyPath) {
    const event = shortcutEventFromBrowseInput(input);
    const matched = COPY_PATH_ACTION_IDS.some((actionId) =>
      matchesActionShortcut(actionId, event, copyPath.platform, copyPath.bindings),
    );
    if (matched) return "copy-path";
  } else if (isCopyPathChord(input)) {
    return "copy-path";
  }
  return null;
}

export function browseKeyboardActionToDomInit(
  action: BrowseKeyboardAction,
): {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
} {
  if (action === "rename") {
    return {
      key: "F2",
      code: "F2",
      keyCode: 113,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    };
  }
  if (action === "disk-delete") {
    return {
      key: "Delete",
      code: "Delete",
      keyCode: 46,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    };
  }
  if (action === "copy-path") {
    return {
      key: "c",
      code: "KeyC",
      keyCode: 67,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
    };
  }
  return {
    key: "Delete",
    code: "Delete",
    keyCode: 46,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  };
}
