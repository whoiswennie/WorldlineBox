import { z } from "zod";

import {
  DEFAULT_COLOR_SIMILARITY,
  MAX_COLOR_SIMILARITY,
  MIN_COLOR_SIMILARITY,
} from "../shared/color-filter-presets";
import { isColorHex, normalizeColorHex } from "../shared/color-hsl";

export const COLOR_FILTER_PREFS_KEY = "worldlinebox.color-filter-prefs.v1";
export const MAX_CUSTOM_FILTER_COLORS = 12;

const hexSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u);

const colorFilterPreferencesSchema = z.object({
  version: z.literal(1),
  customColors: z.array(hexSchema).max(MAX_CUSTOM_FILTER_COLORS).optional(),
  similarity: z.number().int().min(MIN_COLOR_SIMILARITY).max(MAX_COLOR_SIMILARITY).optional(),
});

export interface ColorFilterPreferences {
  readonly version: 1;
  readonly customColors: readonly string[];
  readonly similarity: number;
}

export interface ColorFilterPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_COLOR_FILTER_PREFERENCES: ColorFilterPreferences = {
  version: 1,
  customColors: [],
  similarity: DEFAULT_COLOR_SIMILARITY,
};

function resolveStorage(
  storage?: ColorFilterPreferencesStorage,
): ColorFilterPreferencesStorage {
  if (storage) return storage;
  const ls = (globalThis as { localStorage?: ColorFilterPreferencesStorage })
    .localStorage;
  if (!ls) {
    throw new Error(
      "ColorFilterPreferences: no storage provided and globalThis.localStorage is not available.",
    );
  }
  return ls;
}

function sanitizeCustomColors(raw: readonly string[] | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const colors: string[] = [];
  for (const value of raw) {
    const hex = normalizeColorHex(value);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    colors.push(hex);
    if (colors.length >= MAX_CUSTOM_FILTER_COLORS) break;
  }
  return colors;
}

export function loadColorFilterPreferences(
  storage?: ColorFilterPreferencesStorage,
): ColorFilterPreferences {
  try {
    const raw = resolveStorage(storage).getItem(COLOR_FILTER_PREFS_KEY);
    if (!raw) return DEFAULT_COLOR_FILTER_PREFERENCES;
    const parsed = colorFilterPreferencesSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return DEFAULT_COLOR_FILTER_PREFERENCES;
    return {
      version: 1,
      customColors: sanitizeCustomColors(parsed.data.customColors),
      similarity: parsed.data.similarity ?? DEFAULT_COLOR_SIMILARITY,
    };
  } catch {
    return DEFAULT_COLOR_FILTER_PREFERENCES;
  }
}

export function saveColorFilterPreferences(
  prefs: ColorFilterPreferences,
  storage?: ColorFilterPreferencesStorage,
): void {
  const next: ColorFilterPreferences = {
    version: 1,
    customColors: sanitizeCustomColors(prefs.customColors),
    similarity: prefs.similarity,
  };
  resolveStorage(storage).setItem(COLOR_FILTER_PREFS_KEY, JSON.stringify(next));
}

export function withCustomColorAdded(
  prefs: ColorFilterPreferences,
  hex: string,
): ColorFilterPreferences {
  const normalized = normalizeColorHex(hex);
  if (!normalized || !isColorHex(normalized)) return prefs;
  if (prefs.customColors.includes(normalized)) return prefs;
  if (prefs.customColors.length >= MAX_CUSTOM_FILTER_COLORS) return prefs;
  return { ...prefs, customColors: [...prefs.customColors, normalized] };
}

export function withCustomColorRemoved(
  prefs: ColorFilterPreferences,
  hex: string,
): ColorFilterPreferences {
  const normalized = normalizeColorHex(hex);
  if (!normalized) return prefs;
  return {
    ...prefs,
    customColors: prefs.customColors.filter((color) => color !== normalized),
  };
}
