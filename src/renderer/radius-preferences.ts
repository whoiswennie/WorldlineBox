import { z } from "zod";

/**
 * Corner-radius tiers for shell chrome (mirrors elevation levels).
 * Writes --ui-radius-* on :root so existing token consumers respond.
 */

export type RadiusLevel = 0 | 1 | 2 | 3;

export interface RadiusPreferences {
  readonly version: 1;
  readonly level: RadiusLevel;
}

export interface RadiusPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const RADIUS_PREF_KEY = "worldlinebox.radius-prefs.v1";

export const RADIUS_LEVEL_MIN = 0;
export const RADIUS_LEVEL_MAX = 3;

export type RadiusPreset = {
  readonly control: number;
  readonly surface: number;
  readonly dialog: number;
  readonly overlay: number;
};

/** 0 = sharp, 1 = subtle, 2 = default (current minimal), 3 = soft. */
export const RADIUS_LEVEL_PRESETS: Readonly<Record<RadiusLevel, RadiusPreset>> =
  {
    0: { control: 0, surface: 0, dialog: 0, overlay: 0 },
    1: { control: 4, surface: 6, dialog: 8, overlay: 8 },
    2: { control: 6, surface: 8, dialog: 10, overlay: 10 },
    3: { control: 10, surface: 14, dialog: 18, overlay: 18 },
  };

/** Multiplier for hard-coded radii; level 2 (default) is the designed size. */
export const RADIUS_LEVEL_SCALE: Readonly<Record<RadiusLevel, number>> = {
  0: 0,
  1: 0.6,
  2: 1,
  3: 1.5,
};

export const DEFAULT_RADIUS_PREFERENCES: RadiusPreferences = {
  version: 1,
  level: 2,
};

const radiusLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const radiusPreferencesSchema = z.object({
  version: z.literal(1),
  level: radiusLevelSchema,
});

function resolveStorage(
  storage?: RadiusPreferencesStorage,
): RadiusPreferencesStorage {
  if (storage) return storage;
  const ls = (globalThis as { localStorage?: RadiusPreferencesStorage })
    .localStorage;
  if (!ls) {
    throw new Error(
      "RadiusPreferences: no storage provided and globalThis.localStorage is not available.",
    );
  }
  return ls;
}

export function clampRadiusLevel(value: number): RadiusLevel {
  if (!Number.isFinite(value)) return DEFAULT_RADIUS_PREFERENCES.level;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  if (rounded === 1) return 1;
  if (rounded === 2) return 2;
  return 3;
}

export function radiusLevelToPreset(level: RadiusLevel): RadiusPreset {
  return RADIUS_LEVEL_PRESETS[level];
}

export function loadRadiusPreferences(
  storage?: RadiusPreferencesStorage,
): RadiusPreferences {
  const store = resolveStorage(storage);
  const raw = store.getItem(RADIUS_PREF_KEY);
  if (!raw) return DEFAULT_RADIUS_PREFERENCES;
  try {
    const parsed = radiusPreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_RADIUS_PREFERENCES;
  } catch {
    return DEFAULT_RADIUS_PREFERENCES;
  }
}

export function saveRadiusPreferences(
  preferences: RadiusPreferences,
  storage?: RadiusPreferencesStorage,
): void {
  const store = resolveStorage(storage);
  const cleaned: RadiusPreferences = {
    version: 1,
    level: radiusLevelSchema.parse(preferences.level),
  };
  store.setItem(RADIUS_PREF_KEY, JSON.stringify(cleaned));
}

export function setStoredRadiusLevel(
  level: RadiusLevel,
  storage?: RadiusPreferencesStorage,
): RadiusPreferences {
  const next: RadiusPreferences = { version: 1, level };
  saveRadiusPreferences(next, storage);
  return next;
}

/** Apply before first paint and whenever the preference changes. */
export function applyRadiusPreferences(
  preferences: RadiusPreferences,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const { level } = preferences;
  root.dataset.radius = String(level);
  const preset = radiusLevelToPreset(level);
  root.style.setProperty("--ui-radius-control", `${preset.control}px`);
  root.style.setProperty("--ui-radius-surface", `${preset.surface}px`);
  root.style.setProperty("--ui-radius-dialog", `${preset.dialog}px`);
  root.style.setProperty("--ui-radius-overlay", `${preset.overlay}px`);
  // Every hard-coded corner in styles.css is routed through this factor
  // (calc(Npx * var(--ui-radius-scale))), so the tier drives islands,
  // cards, tags, buttons, inputs, menus, tabs and thumbnails alike.
  root.style.setProperty("--ui-radius-scale", String(RADIUS_LEVEL_SCALE[level]));
  // Keep pill as a true pill regardless of tier.
  root.style.setProperty("--ui-radius-pill", "999px");
}
