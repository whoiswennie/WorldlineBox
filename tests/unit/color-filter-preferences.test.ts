import { describe, expect, it } from "vitest";

import {
  COLOR_FILTER_PREFS_KEY,
  loadColorFilterPreferences,
  saveColorFilterPreferences,
  withCustomColorAdded,
  type ColorFilterPreferencesStorage,
} from "../../src/renderer/color-filter-preferences";

function memoryStorage(initial: Record<string, string> = {}): ColorFilterPreferencesStorage {
  const data = { ...initial };
  return {
    getItem(key) {
      return data[key] ?? null;
    },
    setItem(key, value) {
      data[key] = value;
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

describe("color-filter-preferences", () => {
  it("stores custom chips and similarity without standard-color overlays", () => {
    const storage = memoryStorage();
    const withCustom = withCustomColorAdded(
      {
        version: 1,
        customColors: [],
        similarity: 30,
      },
      "#aabbcc",
    );
    saveColorFilterPreferences(withCustom, storage);
    const loaded = loadColorFilterPreferences(storage);
    expect(loaded.customColors).toEqual(["#AABBCC"]);
    expect(loaded.similarity).toBe(30);
    expect(JSON.parse(storage.getItem(COLOR_FILTER_PREFS_KEY)!)).not.toHaveProperty(
      "standardSwatches",
    );
  });

  it("ignores previously stored standard swatch overlays", () => {
    const storage = memoryStorage({
      [COLOR_FILTER_PREFS_KEY]: JSON.stringify({
        version: 1,
        standardSwatches: { red: "#FF0000" },
        customColors: ["#AABBCC"],
        similarity: 40,
      }),
    });
    const loaded = loadColorFilterPreferences(storage);
    expect(loaded).toEqual({
      version: 1,
      customColors: ["#AABBCC"],
      similarity: 40,
    });
  });
});
