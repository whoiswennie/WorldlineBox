import { z } from "zod";

// ---------------------------------------------------------------------------
// Browse canvas: show direct child folder cards while recursive browse is on
// ---------------------------------------------------------------------------

export const FOLDER_BROWSE_CARD_PREFERENCES_KEY =
  "worldlinebox.folder-browse-cards.v1";

export const FOLDER_BROWSE_CARD_PREFERENCES_CHANGED =
  "worldlinebox:folder-browse-cards-changed";

export interface FolderBrowseCardPreferences {
  readonly version: 1;
  /** When recursive browse is on, still show child folder cards at the top. */
  readonly showWhenRecursive: boolean;
}

export interface FolderBrowseCardPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_FOLDER_BROWSE_CARD_PREFERENCES: FolderBrowseCardPreferences =
  {
    version: 1,
    showWhenRecursive: true,
  };

const preferencesSchema = z.object({
  version: z.literal(1),
  showWhenRecursive: z.boolean(),
});

function resolveStorage(
  storage?: FolderBrowseCardPreferencesStorage,
): FolderBrowseCardPreferencesStorage | undefined {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function loadFolderBrowseCardPreferences(
  storage?: FolderBrowseCardPreferencesStorage,
): FolderBrowseCardPreferences {
  const target = resolveStorage(storage);
  if (!target) return DEFAULT_FOLDER_BROWSE_CARD_PREFERENCES;

  const raw = target.getItem(FOLDER_BROWSE_CARD_PREFERENCES_KEY);
  if (!raw) return DEFAULT_FOLDER_BROWSE_CARD_PREFERENCES;

  try {
    const parsed = preferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_FOLDER_BROWSE_CARD_PREFERENCES;
  } catch {
    return DEFAULT_FOLDER_BROWSE_CARD_PREFERENCES;
  }
}

export function saveFolderBrowseCardPreferences(
  preferences: FolderBrowseCardPreferences,
  storage?: FolderBrowseCardPreferencesStorage,
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  target.setItem(
    FOLDER_BROWSE_CARD_PREFERENCES_KEY,
    JSON.stringify(preferencesSchema.parse(preferences)),
  );
  if (storage || typeof window === "undefined") return;
  window.dispatchEvent(new Event(FOLDER_BROWSE_CARD_PREFERENCES_CHANGED));
}
