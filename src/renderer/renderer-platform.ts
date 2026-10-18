export type RendererPlatform = "macos" | "windows" | "other";

export function resolveRendererPlatform(userAgent: string): RendererPlatform {
  if (/\b(?:Windows|Win32|Win64)\b/iu.test(userAgent)) return "windows";
  if (/\b(?:Macintosh|Mac OS X)\b/iu.test(userAgent)) return "macos";
  return "other";
}

/** Linux user agents (X11 / Wayland Chromium builds report "Linux"). */
export function isLinuxUserAgent(userAgent: string): boolean {
  return /\bLinux\b/u.test(userAgent) && !/\bAndroid\b/u.test(userAgent);
}

/**
 * Windows-style shell chrome (custom title bar, in-app main menu, caption
 * buttons, renderer-owned shortcuts). Linux has no global menu bar, so it
 * shares the Windows shell instead of the macOS one.
 */
export function usesWindowsStyleShell(userAgent: string): boolean {
  const platform = resolveRendererPlatform(userAgent);
  return platform === "windows" || (platform === "other" && isLinuxUserAgent(userAgent));
}

export function applyRendererPlatform(
  root: Pick<HTMLElement, "dataset">,
  userAgent: string,
): RendererPlatform {
  const platform = resolveRendererPlatform(userAgent);
  // Linux reuses the Windows shell styling (layout tokens for the custom
  // title bar); fonts fall back past the Windows-only faces.
  root.dataset.platform = usesWindowsStyleShell(userAgent) ? "windows" : platform;
  return platform;
}
