import { z } from "zod";

import {
  isEmbeddingSelectionId,
} from "../shared/embedding/http-service";

export interface SemanticSearchPreferences {
  readonly version: 1;
  readonly enabled: boolean;
  readonly modelId: string;
  readonly searchMode: "keyword" | "semantic";
  readonly pageSize: SemanticSearchPageSize;
}

export const SEMANTIC_SEARCH_PAGE_SIZES = [25, 50, 100] as const;
export type SemanticSearchPageSize = (typeof SEMANTIC_SEARCH_PAGE_SIZES)[number];
export const DEFAULT_SEMANTIC_SEARCH_PAGE_SIZE: SemanticSearchPageSize = 50;

export interface SemanticSearchPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SEMANTIC_SEARCH_PREF_KEY = "worldlinebox.semantic-search.v1";

export const DEFAULT_SEMANTIC_SEARCH_PREFERENCES: SemanticSearchPreferences = {
  version: 1,
  enabled: false,
  modelId: "embeddinggemma-2-compact",
  searchMode: "keyword",
  pageSize: DEFAULT_SEMANTIC_SEARCH_PAGE_SIZE,
};

const listeners = new Set<() => void>();

export function subscribeSemanticSearchPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const semanticSearchPreferencesSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  modelId: z.string().refine(isEmbeddingSelectionId),
  searchMode: z.enum(["keyword", "semantic"]).optional(),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100)]).optional(),
});

function resolveStorage(storage?: SemanticSearchPreferencesStorage): SemanticSearchPreferencesStorage {
  if (storage) return storage;
  const localStorage = (globalThis as { localStorage?: SemanticSearchPreferencesStorage }).localStorage;
  if (!localStorage) {
    throw new Error("Semantic search preferences need local storage.");
  }
  return localStorage;
}

export function loadSemanticSearchPreferences(
  storage?: SemanticSearchPreferencesStorage,
): SemanticSearchPreferences {
  const current = resolveStorage(storage);
  const raw = current.getItem(SEMANTIC_SEARCH_PREF_KEY);
  if (raw === null) return DEFAULT_SEMANTIC_SEARCH_PREFERENCES;
  try {
    const parsed = semanticSearchPreferencesSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !isEmbeddingSelectionId(parsed.data.modelId)) {
      return DEFAULT_SEMANTIC_SEARCH_PREFERENCES;
    }
    return {
      version: 1,
      enabled: parsed.data.enabled,
      modelId: parsed.data.modelId,
      searchMode: parsed.data.searchMode ?? "keyword",
      pageSize: parsed.data.pageSize ?? DEFAULT_SEMANTIC_SEARCH_PAGE_SIZE,
    };
  } catch {
    return DEFAULT_SEMANTIC_SEARCH_PREFERENCES;
  }
}

export function saveSemanticSearchPreferences(
  prefs: SemanticSearchPreferences,
  storage?: SemanticSearchPreferencesStorage,
): void {
  resolveStorage(storage).setItem(SEMANTIC_SEARCH_PREF_KEY, JSON.stringify({
    version: 1,
    enabled: prefs.enabled,
    modelId: prefs.modelId,
    searchMode: prefs.searchMode,
    pageSize: prefs.pageSize,
  }));
  for (const listener of listeners) listener();
}
