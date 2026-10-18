import { z } from "zod";

/**
 * Hierarchical elevation (WorldlineBox-zcyg, a87).
 *
 * v4: two continuous axes picked on a 2D pad in Settings —
 *   size      0–100 (X)  → CSS `--elev-size`      = size / 50
 *   intensity 0–100 (Y)  → CSS `--elev-intensity` = intensity / 50
 * Either axis below SHADOW_OFF_THRESHOLD turns elevation off
 * (`data-elevation="0"`, no box-shadow paint).
 *
 * Older records migrate: v3 stepped level (0–3) and v2 amount map through
 * SHADOW_LEVEL_PRESETS; v1 already stored size/intensity.
 */

export type ShadowLevel = 0 | 1 | 2 | 3;

export interface ShadowPreferences {
  readonly version: 4;
  readonly size: number;
  readonly intensity: number;
}

export const SHADOW_VALUE_MIN = 0;
export const SHADOW_VALUE_MAX = 100;
/** Below this on either axis, elevation shadows are off. */
export const SHADOW_OFF_THRESHOLD = 3;

export interface ShadowPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SHADOW_PREF_KEY = "worldlinebox.shadow-prefs.v1";

export const SHADOW_LEVEL_MIN = 0;
export const SHADOW_LEVEL_MAX = 3;

/** Level presets: 0 is off (no elev shadows applied in CSS). */
export const SHADOW_LEVEL_PRESETS: Readonly<
  Record<ShadowLevel, { readonly size: number; readonly intensity: number }>
> = {
  0: { size: 0, intensity: 0 },
  1: { size: 22, intensity: 16 },
  2: { size: 45, intensity: 40 },
  3: { size: 72, intensity: 58 },
};

/** Default matches the soft hierarchy users liked (former “more”). */
export const DEFAULT_SHADOW_PREFERENCES: ShadowPreferences = {
  version: 4,
  size: SHADOW_LEVEL_PRESETS[2].size,
  intensity: SHADOW_LEVEL_PRESETS[2].intensity,
};

const shadowLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const shadowPreferencesV4Schema = z.object({
  version: z.literal(4),
  size: z.number().min(0).max(100),
  intensity: z.number().min(0).max(100),
});

const shadowPreferencesV3Schema = z.object({
  version: z.literal(3),
  level: shadowLevelSchema,
});

const shadowPreferencesV2Schema = z.object({
  version: z.literal(2),
  amount: z.enum(["more", "less"]),
});

const shadowPreferencesV1Schema = z.object({
  version: z.literal(1),
  size: z.number().int().min(0).max(100),
  intensity: z.number().int().min(0).max(100),
});

function resolveStorage(
  storage?: ShadowPreferencesStorage,
): ShadowPreferencesStorage {
  if (storage) return storage;
  const ls = (globalThis as { localStorage?: ShadowPreferencesStorage })
    .localStorage;
  if (!ls) {
    throw new Error(
      "ShadowPreferences: no storage provided and globalThis.localStorage is not available.",
    );
  }
  return ls;
}

export function isShadowElevationEnabled(level: ShadowLevel): boolean {
  return level > 0;
}

export function clampShadowValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(SHADOW_VALUE_MAX, Math.max(SHADOW_VALUE_MIN, Math.round(value)));
}

/** Off when either axis is ~0. */
export function isShadowPreferenceEnabled(preferences: ShadowPreferences): boolean {
  return (
    preferences.size >= SHADOW_OFF_THRESHOLD &&
    preferences.intensity >= SHADOW_OFF_THRESHOLD
  );
}

export function shadowPreferencesFromLevel(level: ShadowLevel): ShadowPreferences {
  const preset = SHADOW_LEVEL_PRESETS[level];
  return { version: 4, size: preset.size, intensity: preset.intensity };
}

export function makeShadowPreferences(
  size: number,
  intensity: number,
): ShadowPreferences {
  return {
    version: 4,
    size: clampShadowValue(size),
    intensity: clampShadowValue(intensity),
  };
}

export function shadowLevelToPreset(level: ShadowLevel): {
  readonly size: number;
  readonly intensity: number;
} {
  return SHADOW_LEVEL_PRESETS[level];
}

function migrateV2ToLevel(amount: "more" | "less"): ShadowLevel {
  return amount === "less" ? 1 : 2;
}

export function loadShadowPreferences(
  storage?: ShadowPreferencesStorage,
): ShadowPreferences {
  const store = resolveStorage(storage);
  const raw = store.getItem(SHADOW_PREF_KEY);
  if (!raw) return DEFAULT_SHADOW_PREFERENCES;
  try {
    const json: unknown = JSON.parse(raw);
    const v4 = shadowPreferencesV4Schema.safeParse(json);
    if (v4.success) return makeShadowPreferences(v4.data.size, v4.data.intensity);
    const v3 = shadowPreferencesV3Schema.safeParse(json);
    if (v3.success) return shadowPreferencesFromLevel(v3.data.level);
    const v2 = shadowPreferencesV2Schema.safeParse(json);
    if (v2.success) {
      return shadowPreferencesFromLevel(migrateV2ToLevel(v2.data.amount));
    }
    const v1 = shadowPreferencesV1Schema.safeParse(json);
    if (v1.success) {
      return makeShadowPreferences(v1.data.size, v1.data.intensity);
    }
    return DEFAULT_SHADOW_PREFERENCES;
  } catch {
    return DEFAULT_SHADOW_PREFERENCES;
  }
}

export function saveShadowPreferences(
  preferences: ShadowPreferences,
  storage?: ShadowPreferencesStorage,
): void {
  const store = resolveStorage(storage);
  const cleaned = makeShadowPreferences(preferences.size, preferences.intensity);
  store.setItem(SHADOW_PREF_KEY, JSON.stringify(cleaned));
}

export function setStoredShadowValues(
  size: number,
  intensity: number,
  storage?: ShadowPreferencesStorage,
): ShadowPreferences {
  const next = makeShadowPreferences(size, intensity);
  saveShadowPreferences(next, storage);
  return next;
}

/** Back-compat: store a stepped level as its preset size/intensity. */
export function setStoredShadowLevel(
  level: ShadowLevel,
  storage?: ShadowPreferencesStorage,
): ShadowPreferences {
  const next = shadowPreferencesFromLevel(level);
  saveShadowPreferences(next, storage);
  return next;
}

export function clampShadowLevel(value: number): ShadowLevel {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  if (rounded === 1) return 1;
  if (rounded === 2) return 2;
  return 3;
}

/**
 * 50 → multiplier 1. CSS tokens use `calc(... * var(--elev-size))`.
 */
export function shadowPreferenceToMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  return clamped / 50;
}

/**
 * Write elevation state onto :root (continuous).
 * Off sets `data-elevation="0"` so CSS omits elev box-shadows entirely;
 * otherwise `data-elevation="on"` and `--elev-*` carry the multipliers.
 */
export function applyShadowPreferences(preferences: ShadowPreferences): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!isShadowPreferenceEnabled(preferences)) {
    root.dataset.elevation = "0";
    root.style.removeProperty("--elev-size");
    root.style.removeProperty("--elev-intensity");
    return;
  }
  root.dataset.elevation = "on";
  root.style.setProperty(
    "--elev-size",
    String(shadowPreferenceToMultiplier(preferences.size)),
  );
  root.style.setProperty(
    "--elev-intensity",
    String(shadowPreferenceToMultiplier(preferences.intensity)),
  );
}
