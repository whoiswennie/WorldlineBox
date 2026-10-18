import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHADOW_PREFERENCES,
  SHADOW_LEVEL_PRESETS,
  SHADOW_PREF_KEY,
  applyShadowPreferences,
  SHADOW_OFF_THRESHOLD,
  clampShadowLevel,
  clampShadowValue,
  isShadowPreferenceEnabled,
  makeShadowPreferences,
  setStoredShadowValues,
  shadowPreferencesFromLevel,
  isShadowElevationEnabled,
  loadShadowPreferences,
  saveShadowPreferences,
  setStoredShadowLevel,
  shadowLevelToPreset,
  shadowPreferenceToMultiplier,
  type ShadowPreferencesStorage,
} from "../../src/renderer/shadow-preferences";

function memoryStorage(
  initial?: Record<string, string>,
): ShadowPreferencesStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("shadow-preferences (WorldlineBox-zcyg, a87 v4 2D)", () => {
  it("defaults to the former level-2 preset as continuous values", () => {
    expect(loadShadowPreferences(memoryStorage())).toEqual(
      DEFAULT_SHADOW_PREFERENCES,
    );
    expect(DEFAULT_SHADOW_PREFERENCES).toEqual({
      version: 4,
      size: SHADOW_LEVEL_PRESETS[2].size,
      intensity: SHADOW_LEVEL_PRESETS[2].intensity,
    });
    expect(isShadowElevationEnabled(0)).toBe(false);
    expect(isShadowElevationEnabled(2)).toBe(true);
    expect(shadowLevelToPreset(2)).toEqual(SHADOW_LEVEL_PRESETS[2]);
  });

  it("round-trips continuous size/intensity (v4)", () => {
    const storage = memoryStorage();
    saveShadowPreferences({ version: 4, size: 63, intensity: 17 }, storage);
    expect(loadShadowPreferences(storage)).toEqual({ version: 4, size: 63, intensity: 17 });
    expect(setStoredShadowValues(120, -4, storage)).toEqual({ version: 4, size: 100, intensity: 0 });
    expect(storage.data.get(SHADOW_PREF_KEY)).toContain('"version":4');
    expect(setStoredShadowLevel(3, storage)).toEqual(shadowPreferencesFromLevel(3));
  });

  it("migrates v3 levels, v2 more/less and v1 sliders", () => {
    const storage = memoryStorage({
      [SHADOW_PREF_KEY]: JSON.stringify({ version: 3, level: 3 }),
    });
    expect(loadShadowPreferences(storage)).toEqual(shadowPreferencesFromLevel(3));
    storage.setItem(SHADOW_PREF_KEY, JSON.stringify({ version: 3, level: 0 }));
    expect(isShadowPreferenceEnabled(loadShadowPreferences(storage))).toBe(false);

    storage.setItem(SHADOW_PREF_KEY, JSON.stringify({ version: 2, amount: "less" }));
    expect(loadShadowPreferences(storage)).toEqual(shadowPreferencesFromLevel(1));
    storage.setItem(SHADOW_PREF_KEY, JSON.stringify({ version: 2, amount: "more" }));
    expect(loadShadowPreferences(storage)).toEqual(shadowPreferencesFromLevel(2));

    storage.setItem(SHADOW_PREF_KEY, JSON.stringify({ version: 1, size: 5, intensity: 0 }));
    const v1 = loadShadowPreferences(storage);
    expect(v1).toEqual({ version: 4, size: 5, intensity: 0 });
    expect(isShadowPreferenceEnabled(v1)).toBe(false);
  });

  it("treats either axis near 0 as off", () => {
    expect(isShadowPreferenceEnabled(makeShadowPreferences(50, SHADOW_OFF_THRESHOLD - 1))).toBe(false);
    expect(isShadowPreferenceEnabled(makeShadowPreferences(SHADOW_OFF_THRESHOLD - 1, 50))).toBe(false);
    expect(isShadowPreferenceEnabled(makeShadowPreferences(SHADOW_OFF_THRESHOLD, SHADOW_OFF_THRESHOLD))).toBe(true);
  });

  it("clamps and falls back on corrupt JSON", () => {
    expect(clampShadowLevel(-1)).toBe(0);
    expect(clampShadowLevel(1.6)).toBe(2);
    expect(clampShadowLevel(99)).toBe(3);
    expect(clampShadowValue(Number.NaN)).toBe(0);
    expect(clampShadowValue(42.6)).toBe(43);
    const storage = memoryStorage({ [SHADOW_PREF_KEY]: "{not-json" });
    expect(loadShadowPreferences(storage)).toEqual(DEFAULT_SHADOW_PREFERENCES);
    storage.setItem(SHADOW_PREF_KEY, JSON.stringify({ version: 4, size: 400, intensity: 1 }));
    expect(loadShadowPreferences(storage)).toEqual(DEFAULT_SHADOW_PREFERENCES);
  });

  it("maps preference midpoints to multiplier 1", () => {
    expect(shadowPreferenceToMultiplier(50)).toBe(1);
    expect(shadowPreferenceToMultiplier(0)).toBe(0);
    expect(shadowPreferenceToMultiplier(100)).toBe(2);
  });

  it("no-ops applyShadowPreferences when document is unavailable", () => {
    expect(() =>
      applyShadowPreferences({ version: 4, size: 0, intensity: 0 }),
    ).not.toThrow();
  });
});
