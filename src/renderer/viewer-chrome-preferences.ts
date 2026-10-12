import { z } from "zod";

export const VIEWER_CHROME_PREFERENCES_KEY = "worldlinebox.viewer-chrome.v1";

export interface ViewerChromePreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ViewerChromePreferences {
  readonly version: 1;
  /** Left/right viewer arrows appear only when the pointer is near them. */
  readonly navArrowsOnApproach: boolean;
  /** Video transport appears only when the pointer is near the bottom edge. */
  readonly videoTransportOnApproach: boolean;
}

export const DEFAULT_VIEWER_CHROME_PREFERENCES: ViewerChromePreferences = {
  version: 1,
  navArrowsOnApproach: true,
  videoTransportOnApproach: false,
};

const schema = z.object({
  version: z.literal(1),
  navArrowsOnApproach: z.boolean(),
  videoTransportOnApproach: z.boolean(),
});

function resolveStorage(
  storage?: ViewerChromePreferencesStorage,
): ViewerChromePreferencesStorage {
  if (storage) return storage;
  const localStorage = globalThis.localStorage;
  if (!localStorage) {
    throw new Error("ViewerChromePreferences: localStorage is unavailable.");
  }
  return localStorage;
}

export function loadViewerChromePreferences(
  storage?: ViewerChromePreferencesStorage,
): ViewerChromePreferences {
  const raw = resolveStorage(storage).getItem(VIEWER_CHROME_PREFERENCES_KEY);
  if (!raw) return DEFAULT_VIEWER_CHROME_PREFERENCES;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_VIEWER_CHROME_PREFERENCES;
  } catch {
    return DEFAULT_VIEWER_CHROME_PREFERENCES;
  }
}

export function saveViewerChromePreferences(
  preferences: ViewerChromePreferences,
  storage?: ViewerChromePreferencesStorage,
): void {
  const parsed = schema.parse(preferences);
  resolveStorage(storage).setItem(
    VIEWER_CHROME_PREFERENCES_KEY,
    JSON.stringify(parsed),
  );
}
