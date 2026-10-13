import type { ThemePreferencesStorage } from './theme-preferences';

export const BACKGROUND_MOTION_KEY = 'worldlinebox.background-motion.v1';

/** Store a small switch, never video bytes or arbitrary media URLs. */
export function loadBackgroundMotion(storage?: ThemePreferencesStorage): boolean {
  try {
    const store = storage ?? globalThis.localStorage;
    const value: unknown = JSON.parse(store.getItem(BACKGROUND_MOTION_KEY) ?? 'null');
    return typeof value === 'boolean' ? value : true;
  } catch {
    return true;
  }
}

export function saveBackgroundMotion(enabled: boolean, storage?: ThemePreferencesStorage): boolean {
  try {
    (storage ?? globalThis.localStorage).setItem(BACKGROUND_MOTION_KEY, JSON.stringify(enabled));
    return true;
  } catch {
    return false;
  }
}
