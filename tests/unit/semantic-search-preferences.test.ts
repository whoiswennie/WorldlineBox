import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEMANTIC_SEARCH_PREFERENCES,
  SEMANTIC_SEARCH_PREF_KEY,
  loadSemanticSearchPreferences,
  saveSemanticSearchPreferences,
} from "../../src/renderer/semantic-search-preferences";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(SEMANTIC_SEARCH_PREF_KEY, initial);
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("semantic search preferences", () => {
  it("starts off and preselects the compact model", () => {
    expect(loadSemanticSearchPreferences(storage())).toEqual({
      version: 1,
      enabled: false,
      modelId: "embeddinggemma-2-compact",
      searchMode: "keyword",
      pageSize: 50,
    });
    expect(DEFAULT_SEMANTIC_SEARCH_PREFERENCES.modelId).toBe("embeddinggemma-2-compact");
  });

  it("remembers the switch and the chosen model", () => {
    const store = storage();
    saveSemanticSearchPreferences({
      version: 1,
      enabled: true,
      modelId: "embeddinggemma-2-compact",
      searchMode: "semantic",
      pageSize: 100,
    }, store);
    expect(loadSemanticSearchPreferences(store)).toEqual({
      version: 1,
      enabled: true,
      modelId: "embeddinggemma-2-compact",
      searchMode: "semantic",
      pageSize: 100,
    });
  });

  it("defaults older preference data to a 50-picture batch", () => {
    expect(loadSemanticSearchPreferences(storage(JSON.stringify({
      version: 1,
      enabled: true,
      modelId: "embeddinggemma-2-compact",
      searchMode: "semantic",
    })))).toEqual({
      version: 1,
      enabled: true,
      modelId: "embeddinggemma-2-compact",
      searchMode: "semantic",
      pageSize: 50,
    });
  });

  it("accepts only supported batch sizes", () => {
    expect(loadSemanticSearchPreferences(storage(JSON.stringify({
      version: 1,
      enabled: true,
      modelId: "embeddinggemma-2-compact",
      pageSize: 37,
    }))).pageSize).toBe(50);
    for (const pageSize of [25, 50, 100] as const) {
      expect(loadSemanticSearchPreferences(storage(JSON.stringify({
        version: 1,
        enabled: true,
        modelId: "embeddinggemma-2-compact",
        pageSize,
      }))).pageSize).toBe(pageSize);
    }
  });

  it("ignores an unknown model id", () => {
    expect(loadSemanticSearchPreferences(storage(JSON.stringify({
      version: 1,
      enabled: true,
      modelId: "some-other-model",
    })))).toEqual(DEFAULT_SEMANTIC_SEARCH_PREFERENCES);
  });
});
