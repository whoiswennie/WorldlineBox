import { z } from "zod";

import type {
  CollectionTreeSortMode,
  FolderTreeSortMode,
  FolderTreeSortOrder,
} from "./unified-directory-nav";

// ---------------------------------------------------------------------------
// Sidebar tree sort preference (WorldlineBox-db1835)
// ---------------------------------------------------------------------------

export type FolderSortOrder = FolderTreeSortOrder;

export interface FolderSortPreferences {
  readonly version: 1;
  readonly mode: FolderTreeSortMode;
  readonly order: FolderSortOrder;
}

export interface CollectionSortPreferences {
  readonly version: 1;
  readonly mode: CollectionTreeSortMode;
  readonly order: FolderSortOrder;
}

export interface FolderSortPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const folderSortPreferencesSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["name", "created", "count", "custom"]),
  // Optional for data written before the direction UI existed; load defaults
  // it to asc so a persisted `{ mode }` value keeps sorting instead of resetting.
  order: z.enum(["asc", "desc"]).optional(),
});

export const FOLDER_SORT_PREF_KEY = "worldlinebox.folder-sort-prefs.v1";
export const COLLECTION_SORT_PREF_KEY = "worldlinebox.collection-sort-prefs.v1";

export const DEFAULT_FOLDER_SORT_PREFERENCES: FolderSortPreferences = {
  version: 1,
  mode: "custom",
  order: "asc",
};
export const DEFAULT_COLLECTION_SORT_PREFERENCES: CollectionSortPreferences = {
  version: 1,
  mode: "custom",
  order: "asc",
};

function resolveStorage(
  storage?: FolderSortPreferencesStorage,
): FolderSortPreferencesStorage {
  if (storage) return storage;
  const ls = (globalThis as { localStorage?: FolderSortPreferencesStorage })
    .localStorage;
  if (!ls) {
    throw new Error(
      "FolderSortPreferences: no storage provided and globalThis.localStorage is not available.",
    );
  }
  return ls;
}

function loadSortPreferences(
  key: string,
  defaultPreferences: FolderSortPreferences,
  storage?: FolderSortPreferencesStorage,
): FolderSortPreferences {
  try {
    const raw = resolveStorage(storage).getItem(key);
    if (!raw) return defaultPreferences;
    const parsed = folderSortPreferencesSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return defaultPreferences;
    return { version: 1, mode: parsed.data.mode, order: parsed.data.order ?? "asc" };
  } catch {
    return defaultPreferences;
  }
}

function saveSortPreferences(
  key: string,
  prefs: FolderSortPreferences,
  storage?: FolderSortPreferencesStorage,
): void {
  const parsed = folderSortPreferencesSchema.parse(prefs);
  resolveStorage(storage).setItem(key, JSON.stringify(parsed));
}

export function loadFolderSortPreferences(
  storage?: FolderSortPreferencesStorage,
): FolderSortPreferences {
  return loadSortPreferences(
    FOLDER_SORT_PREF_KEY,
    DEFAULT_FOLDER_SORT_PREFERENCES,
    storage,
  );
}

export function saveFolderSortPreferences(
  prefs: FolderSortPreferences,
  storage?: FolderSortPreferencesStorage,
): void {
  saveSortPreferences(FOLDER_SORT_PREF_KEY, prefs, storage);
}

export function loadCollectionSortPreferences(
  storage?: FolderSortPreferencesStorage,
): CollectionSortPreferences {
  const loaded = loadSortPreferences(
    COLLECTION_SORT_PREF_KEY,
    DEFAULT_COLLECTION_SORT_PREFERENCES,
    storage,
  );
  const mode = loaded.mode === "created" ? "name" : loaded.mode;
  return { version: 1, mode, order: loaded.order };
}

export function saveCollectionSortPreferences(
  prefs: CollectionSortPreferences,
  storage?: FolderSortPreferencesStorage,
): void {
  saveSortPreferences(COLLECTION_SORT_PREF_KEY, prefs, storage);
}

export function withSidebarSort(
  prefs: FolderSortPreferences,
  next: Partial<Pick<FolderSortPreferences, "mode" | "order">>,
): FolderSortPreferences {
  return { ...prefs, ...next };
}

export const withFolderSort = withSidebarSort;
export function withCollectionSort(
  prefs: CollectionSortPreferences,
  next: Partial<Pick<CollectionSortPreferences, "mode" | "order">>,
): CollectionSortPreferences {
  return { ...prefs, ...next };
}
