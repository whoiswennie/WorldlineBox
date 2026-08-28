import type { AppDetailsOptions } from 'electron'

/** Must stay identical to electron-builder's `build.appId`. */
export const WINDOWS_APP_ID = 'fantasy.worldline.desktop'

/** Explicit per-window shell metadata prevents a generic document taskbar icon on first launch. */
export function windowsAppDetails(iconPath: string, executablePath: string): AppDetailsOptions {
  return {
    appId: WINDOWS_APP_ID,
    appIconPath: iconPath,
    appIconIndex: 0,
    relaunchCommand: executablePath,
  }
}
