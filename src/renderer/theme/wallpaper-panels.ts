import type { BackgroundPreferences } from './background-preferences';

export const WALLPAPER_PANEL_OPACITY = 0.48;

/** Old v3 preferences defaulted to opaque panels. Migrate a restored visible
 * wallpaper once; subsequent explicit opacity/off choices survive restarts. */
export function restoreWallpaperPanels(preferences: BackgroundPreferences, hasWallpaper: boolean): BackgroundPreferences {
  if (!hasWallpaper || !preferences.enabled || preferences.panelVisibilityVersion === 1) return preferences;
  return { ...preferences, showInMainPanel: true, panelOpacity: Math.min(preferences.panelOpacity, WALLPAPER_PANEL_OPACITY), panelVisibilityVersion: 1 };
}
