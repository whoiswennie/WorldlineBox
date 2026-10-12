import { describe, expect, it } from "vitest";

import {
  DEFAULT_FOLDER_BROWSE_CARD_PREFERENCES,
  FOLDER_BROWSE_CARD_PREFERENCES_KEY,
  loadFolderBrowseCardPreferences,
  saveFolderBrowseCardPreferences,
  type FolderBrowseCardPreferencesStorage,
} from "../../src/renderer/folder-browse-card-preferences";

function memoryStorage(
  initial?: Record<string, string>,
): FolderBrowseCardPreferencesStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("folder browse card preferences", () => {
  it("defaults to showing folder cards during recursive browse", () => {
    expect(loadFolderBrowseCardPreferences(memoryStorage())).toEqual(
      DEFAULT_FOLDER_BROWSE_CARD_PREFERENCES,
    );
  });

  it("round-trips hiding folder cards during recursive browse", () => {
    const storage = memoryStorage();
    saveFolderBrowseCardPreferences(
      { version: 1, showWhenRecursive: false },
      storage,
    );

    expect(loadFolderBrowseCardPreferences(storage)).toEqual({
      version: 1,
      showWhenRecursive: false,
    });
    expect(storage.data.get(FOLDER_BROWSE_CARD_PREFERENCES_KEY)).toContain(
      '"showWhenRecursive":false',
    );
  });

  it("falls back when the stored value is malformed", () => {
    const storage = memoryStorage({
      [FOLDER_BROWSE_CARD_PREFERENCES_KEY]: "not-json",
    });

    expect(loadFolderBrowseCardPreferences(storage)).toEqual(
      DEFAULT_FOLDER_BROWSE_CARD_PREFERENCES,
    );
  });
});
