/**
 * Workspace back/forward via mouse side buttons (WorldlineBox-1xmk / REQ-NAV-007).
 *
 * Pure helpers — useWorkspaceMouseNavigation owns the window listener.
 * Search / Inspector / dialog fields still skip; viewer surfaces do not.
 */

export type WorkspaceMouseNavAction = "back" | "forward";

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
  event: Pick<MouseEvent, "button" | "target">,
  options?: { readonly isModalOpen?: boolean },
): WorkspaceMouseNavAction | null {
  const isModalOpen = options?.isModalOpen ?? isModalDialogOpen();
  if (isModalOpen) return null;
  if (isEditableMouseNavTarget(event.target)) return null;
  return resolveWorkspaceMouseNavButton(event.button);
}

/**
 * Iframe documents do not bubble pointer events to the host window.
 * Same-origin viewer frames (HTML preview) re-dispatch side buttons.
 */
export function bindIframeWorkspaceMouseNav(iframe: HTMLIFrameElement): () => void {
  let boundDoc: Document | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if (!resolveWorkspaceMouseNavButton(event.button)) return;
    event.preventDefault();
    window.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: event.button,
        cancelable: true,
      }),
    );
  };
  const unbind = () => {
    boundDoc?.removeEventListener("pointerdown", onPointerDown, true);
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
  };
  iframe.addEventListener("load", bind);
  bind();
  return () => {
    iframe.removeEventListener("load", bind);
    unbind();
  };
}
