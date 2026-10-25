/**
 * Windows Main → Renderer bridge for F2 / Delete (WorldlineBox-g8u9).
 *
 * Hidden menu accelerators and before-input both arrive here. Re-dispatch as
 * a document keydown so folder, collection, and browse handlers share one
 * path. Skip when an editable field or modal already owns the keys.
 */

import { useEffect } from "react";
import { hasActiveModalDialog } from "./use-dialog-focus-trap";

import {
  BROWSE_KEYBOARD_ACTIONS,
  browseKeyboardActionToDomInit,
  type BrowseKeyboardAction,
} from "../shared/browse-keyboard-shortcuts";

export type BrowseShortcutShell = {
  readonly onBrowseShortcut?: (
    listener: (
      action: BrowseKeyboardAction,
      chord?: {
        readonly key: string;
        readonly code?: string;
        readonly ctrlKey?: boolean;
        readonly metaKey?: boolean;
        readonly altKey?: boolean;
        readonly shiftKey?: boolean;
      },
    ) => void,
  ) => () => void;
  readonly setBrowseShortcutAcceleratorsEnabled?: (enabled: boolean) => void;
  readonly setApplicationShortcutAcceleratorsEnabled?: (enabled: boolean) => void;
};

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isBrowseKeyboardAction(value: string): value is BrowseKeyboardAction {
  return (BROWSE_KEYBOARD_ACTIONS as readonly string[]).includes(value);
}

export function useWindowsBrowseShortcutBridge(args: {
  readonly shell: BrowseShortcutShell | null | undefined;
  readonly enabled: boolean;
  /** Browse keys stay fixed while a viewer, input, or modal owns the keys. */
  readonly browseAcceleratorsBlocked: boolean;
  /** App commands remain available in viewers, but yield to inputs and modals. */
  readonly applicationAcceleratorsBlocked: boolean;
  /** WorldlineBox application fullscreen also works before opening a library. */
  readonly applicationEnabled?: boolean;
}): void {
  const {
    shell,
    enabled,
    browseAcceleratorsBlocked,
    applicationAcceleratorsBlocked,
    applicationEnabled = enabled,
  } = args;

  useEffect(() => {
    let listening = true;
    const sync = (target: EventTarget | null = document.activeElement) => {
      const editable = isEditableKeyboardTarget(target);
      const modalOpen = hasActiveModalDialog();
      shell?.setBrowseShortcutAcceleratorsEnabled?.(
        enabled && !browseAcceleratorsBlocked && !editable && !modalOpen,
      );
      // A retained, inactive Assets view must leave application ownership to
      // the outer launcher/browser shell instead of racing its focus updates.
      if (applicationEnabled) shell?.setApplicationShortcutAcceleratorsEnabled?.(
        !applicationAcceleratorsBlocked && !editable && !modalOpen,
      );
    };
    const onFocusIn = (event: FocusEvent) => sync(event.target);
    const onFocusOut = () => queueMicrotask(() => {
      // A queued focusout can outlive this effect when modal state changes.
      // Do not let its stale closure re-disable the freshly synchronized menu.
      if (listening) sync();
    });

    sync();
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      listening = false;
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, [
    shell,
    enabled,
    browseAcceleratorsBlocked,
    applicationAcceleratorsBlocked,
    applicationEnabled,
  ]);

  useEffect(() => {
    if (!enabled || !shell?.onBrowseShortcut) return;

    return shell.onBrowseShortcut((action, chord) => {
      if (!isBrowseKeyboardAction(action)) return;
      if (browseAcceleratorsBlocked && action !== "copy-path") return;
      if (isEditableKeyboardTarget(document.activeElement)) return;
      if (hasActiveModalDialog()) return;

      const init = chord
        ? {
            key: chord.key,
            code: chord.code ?? "",
            ctrlKey: chord.ctrlKey === true,
            metaKey: chord.metaKey === true,
            altKey: chord.altKey === true,
            shiftKey: chord.shiftKey === true,
          }
        : browseKeyboardActionToDomInit(action);
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: init.key,
          code: init.code,
          bubbles: true,
          cancelable: true,
          ctrlKey: init.ctrlKey,
          metaKey: init.metaKey,
          altKey: init.altKey,
          shiftKey: init.shiftKey,
        }),
      );
    });
  }, [shell, enabled, browseAcceleratorsBlocked]);
}
