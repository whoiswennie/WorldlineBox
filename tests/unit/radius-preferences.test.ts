import { describe, expect, it } from "vitest";

import {
  DEFAULT_RADIUS_PREFERENCES,
  RADIUS_LEVEL_PRESETS,
  RADIUS_PREF_KEY,
  applyRadiusPreferences,
  clampRadiusLevel,
  loadRadiusPreferences,
  radiusLevelToPreset,
  saveRadiusPreferences,
  setStoredRadiusLevel,
  type RadiusPreferencesStorage,
} from "../../src/renderer/radius-preferences";

function memoryStorage(
  initial?: Record<string, string>,
): RadiusPreferencesStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("radius-preferences", () => {
  it("defaults to level 2 (current minimal radii)", () => {
    expect(loadRadiusPreferences(memoryStorage())).toEqual(
      DEFAULT_RADIUS_PREFERENCES,
    );
    expect(DEFAULT_RADIUS_PREFERENCES.level).toBe(2);
    expect(radiusLevelToPreset(2)).toEqual(RADIUS_LEVEL_PRESETS[2]);
    expect(RADIUS_LEVEL_PRESETS[0].control).toBe(0);
    expect(RADIUS_LEVEL_PRESETS[3].surface).toBe(14);
  });

  it("round-trips levels 0–3", () => {
    const storage = memoryStorage();
    saveRadiusPreferences({ version: 1, level: 0 }, storage);
    expect(loadRadiusPreferences(storage).level).toBe(0);
    expect(setStoredRadiusLevel(3, storage).level).toBe(3);
    expect(storage.data.get(RADIUS_PREF_KEY)).toContain('"level":3');
  });

  it("clamps and falls back on corrupt JSON", () => {
    expect(clampRadiusLevel(-1)).toBe(0);
    expect(clampRadiusLevel(1.4)).toBe(1);
    expect(clampRadiusLevel(99)).toBe(3);
    const storage = memoryStorage({ [RADIUS_PREF_KEY]: "{not-json" });
    expect(loadRadiusPreferences(storage)).toEqual(DEFAULT_RADIUS_PREFERENCES);
  });

  it("no-ops applyRadiusPreferences when document is unavailable", () => {
    expect(() =>
      applyRadiusPreferences({ version: 1, level: 0 }),
    ).not.toThrow();
  });
});
