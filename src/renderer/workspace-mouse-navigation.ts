/**
 * Workspace back/forward via mouse side buttons (WorldlineBox-1xmk / REQ-NAV-007).
 *
 * Pure helpers — useWorkspaceMouseNavigation owns the window listener.
 * Search / Inspector / dialog fields still skip; viewer surfaces do not.
 */

import { isTypingKeyboardTarget } from "./video-player-controls";

export type WorkspaceMouseNavAction = "back" | "forward";
type WorkspaceMouseNavInput = Pick<MouseEvent, "button" | "target">
  & Partial<Pick<MouseEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">>;

const WORKSPACE_VIEWER_SELECTOR = ".workspace-viewer";

const NON_TYPING_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isInsideWorkspaceViewer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(WORKSPACE_VIEWER_SELECTOR) !== null;
}

export function isEditableMouseNavTarget(target: EventTarget | null): boolean {
  if (isInsideWorkspaceViewer(target)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !NON_TYPING_INPUT_TYPES.has((target.type || "text").toLowerCase());
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

export function isModalDialogOpen(doc: Document = document): boolean {
  return Boolean(doc.querySelector('[role="dialog"][aria-modal="true"]'));
}

/** Chromium/Electron: button 3 = back (XButton1), 4 = forward (XButton2). */
export function resolveWorkspaceMouseNavButton(
  button: number,
): WorkspaceMouseNavAction | null {
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return null;
}

export function resolveWorkspaceMouseNavAction(
  event: WorkspaceMouseNavInput,
  options?: { readonly isModalOpen?: boolean },
): WorkspaceMouseNavAction | null {
  // Modified side buttons belong to user-configured shortcuts. The app-wide
  // shortcut listeners receive their subsequent mousedown event.
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const isModalOpen = options?.isModalOpen ?? isModalDialogOpen();
  if (isModalOpen) return null;
  if (isEditableMouseNavTarget(event.target)) return null;
  return resolveWorkspaceMouseNavButton(event.button);
}

/** Keep Chromium's history action from racing the app's side-button routes. */
export function isWorkspaceMouseSideButton(button: number): boolean {
  return button === 3 || button === 4;
}

/**
 * Iframe documents do not bubble pointer events to the host window.
 * Same-origin viewer frames (HTML preview) re-dispatch side buttons.
 */
export function bindIframeWorkspaceMouseNav(iframe: HTMLIFrameElement): () => void {
  let boundDoc: Document | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if (!resolveWorkspaceMouseNavButton(event.button)) return;
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    window.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: event.button,
        cancelable: true,
      }),
    );
  };
  const onMouseDown = (event: MouseEvent) => {
    if (!resolveWorkspaceMouseNavButton(event.button)) return;
    if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) return;
    event.preventDefault();
    const activeElement = boundDoc?.activeElement ?? null;
    if (isTypingKeyboardTarget(activeElement)) return;
    iframe.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: event.button,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      }),
    );
  };
  const unbind = () => {
    boundDoc?.removeEventListener("pointerdown", onPointerDown, true);
    boundDoc?.removeEventListener("mousedown", onMouseDown, true);
    boundDoc = null;
  };
  const bind = () => {
    let doc: Document | null;
    try {
      doc = iframe.contentDocument;
    } catch {
      doc = null;
    }
    if (doc === boundDoc) return;
    unbind();
    boundDoc = doc;
    boundDoc?.addEventListener("pointerdown", onPointerDown, true);
    boundDoc?.addEventListener("mousedown", onMouseDown, true);
  };
  iframe.addEventListener("load", bind);
  bind();
  return () => {
    iframe.removeEventListener("load", bind);
    unbind();
  };
}
