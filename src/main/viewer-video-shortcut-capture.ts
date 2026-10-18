/**
 * Coordinates VIEWER-018 letter-shortcut capture for a webContents:
 * Windows Menu accelerators + IMM32 IME suspend + before-input arm flag.
 */

import { BrowserWindow, type WebContents } from "electron";

import { resetViewerVideoShortcutForwardForTests } from "../shared/viewer-video-shortcut-dedupe";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  shortcutPlatformFromProcess,
  type ShortcutBindings,
} from "../shared/shortcut-bindings";
import {
  viewerVideoShortcutNeedsImeSuspension,
  type ViewerShortcutScope,
} from "../shared/viewer-video-shortcuts";
import { setViewerVideoShortcutMenuActive } from "./viewer-video-shortcut-menu";
import {
  restoreWindowsIme,
  suspendWindowsIme,
  type WindowsImeSuspendToken,
} from "./windows-ime";

const imeTokensByContentsId = new Map<number, WindowsImeSuspendToken>();
const activeScopeByContentsId = new Map<number, ViewerShortcutScope>();

function refreshViewerMenus(): void {
  const activeScopes = new Set(activeScopeByContentsId.values());
  setViewerVideoShortcutMenuActive(activeScopes.has("viewer.video"), "viewer.video");
  setViewerVideoShortcutMenuActive(activeScopes.has("viewer.audio"), "viewer.audio");
}

export function isViewerVideoShortcutContentsActive(
  contentsId: number,
): boolean {
  return activeScopeByContentsId.has(contentsId);
}

export function viewerShortcutScopeForContents(
  contentsId: number,
): ViewerShortcutScope | null {
  return activeScopeByContentsId.get(contentsId) ?? null;
}

export function setViewerVideoShortcutCaptureActive(
  contents: WebContents,
  active: boolean,
  bindings: ShortcutBindings = DEFAULT_SHORTCUT_BINDINGS,
  scope: ViewerShortcutScope = "viewer.video",
): void {
  const contentsId = contents.id;
  if (active) {
    const previousScope = activeScopeByContentsId.get(contentsId);
    activeScopeByContentsId.set(contentsId, scope);
    refreshViewerMenus();
    if (previousScope === scope) return;

    const previousToken = imeTokensByContentsId.get(contentsId) ?? null;
    imeTokensByContentsId.delete(contentsId);
    restoreWindowsIme(previousToken);

    if (viewerVideoShortcutNeedsImeSuspension(
      bindings,
      shortcutPlatformFromProcess(process.platform),
      scope,
    )) {
      const window = BrowserWindow.fromWebContents(contents);
      const token = suspendWindowsIme(window);
      if (token) {
        imeTokensByContentsId.set(contentsId, token);
      }
    }
    return;
  }

  activeScopeByContentsId.delete(contentsId);
  const token = imeTokensByContentsId.get(contentsId) ?? null;
  imeTokensByContentsId.delete(contentsId);
  restoreWindowsIme(token);
  refreshViewerMenus();
}

export function clearViewerVideoShortcutCapture(contentsId: number): void {
  if (
    !activeScopeByContentsId.has(contentsId) &&
    !imeTokensByContentsId.has(contentsId)
  ) {
    return;
  }
  activeScopeByContentsId.delete(contentsId);
  const token = imeTokensByContentsId.get(contentsId) ?? null;
  imeTokensByContentsId.delete(contentsId);
  restoreWindowsIme(token);
  refreshViewerMenus();
}

export function resetViewerVideoShortcutCaptureForTests(): void {
  for (const token of imeTokensByContentsId.values()) {
    restoreWindowsIme(token);
  }
  imeTokensByContentsId.clear();
  activeScopeByContentsId.clear();
  resetViewerVideoShortcutForwardForTests();
  setViewerVideoShortcutMenuActive(false);
}
