/**
 * Application-window fullscreen chords (WorldlineBox-692279).
 *
 * This is BrowserWindow fullscreen, not the viewer's element fullscreen.
 * Windows uses F11 (browser / VS Code). macOS uses Control+Command+F
 * (Safari / Chrome / VS Code / Electron `togglefullscreen`). F11 is not
 * bound on macOS — the system uses it for Show Desktop.
 */

export type WindowFullscreenShortcutPlatform = "darwin" | "win32" | "linux";

export type WindowFullscreenShortcutInput = {
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

function isKeyDown(input: WindowFullscreenShortcutInput): boolean {
  const type = input.type ?? "keyDown";
  return type === "keyDown" || type === "keydown";
}

function hasCtrl(input: WindowFullscreenShortcutInput): boolean {
  return Boolean(input.control ?? input.ctrlKey);
}

function hasMeta(input: WindowFullscreenShortcutInput): boolean {
  return Boolean(input.meta ?? input.metaKey);
}

function hasAlt(input: WindowFullscreenShortcutInput): boolean {
  return Boolean(input.alt ?? input.altKey);
}

function hasShift(input: WindowFullscreenShortcutInput): boolean {
  return Boolean(input.shift ?? input.shiftKey);
}

function isF11(input: WindowFullscreenShortcutInput): boolean {
  const key = (input.key ?? "").toLowerCase();
  const code = (input.code ?? "").toLowerCase();
  return key === "f11" || code === "f11" || input.keyCode === 122;
}

function isLetterF(input: WindowFullscreenShortcutInput): boolean {
  const key = (input.key ?? "").toLowerCase();
  const code = (input.code ?? "").toLowerCase();
  return key === "f" || code === "keyf" || input.keyCode === 70;
}

/**
 * Windows-only: the frameless shell has no native View menu, so F11 must be
 * matched by the hidden accelerator menu / tests. macOS and Linux keep the
 * Electron `togglefullscreen` role (⌃⌘F / F11).
 */
export function matchWindowFullscreenShortcut(
  input: WindowFullscreenShortcutInput,
  platform: WindowFullscreenShortcutPlatform,
): boolean {
  if (!isKeyDown(input)) return false;
  if (hasAlt(input) || hasShift(input)) return false;

  if (platform === "darwin") {
    // Documented macOS chord for tests and the shortcut table.
    // Main does not also dispatch it: the native View menu already owns it.
    return isLetterF(input) && hasCtrl(input) && hasMeta(input);
  }

  return isF11(input) && !hasCtrl(input) && !hasMeta(input);
}
