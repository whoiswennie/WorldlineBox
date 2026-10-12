import { z } from "zod";

export const IMAGE_SEQUENCE_PREFERENCES_KEY = "worldlinebox.image-sequence.v1";

export interface ImageSequencePreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ImageSequencePreferences {
  readonly version: 3;
  readonly detectionEnabled: boolean;
  readonly autoDetectOnImport: boolean;
}

export const DEFAULT_IMAGE_SEQUENCE_PREFERENCES: ImageSequencePreferences = {
  version: 3,
  detectionEnabled: true,
  autoDetectOnImport: false,
};

const v1Schema = z.object({
  version: z.literal(1),
  autoDetectOnImport: z.boolean(),
});

const v2Schema = z.object({
  version: z.literal(2),
  detectionEnabled: z.boolean(),
  autoDetectOnImport: z.boolean(),
});

const v3Schema = z.object({
  version: z.literal(3),
  detectionEnabled: z.boolean(),
  autoDetectOnImport: z.boolean(),
});

function resolveStorage(
  storage?: ImageSequencePreferencesStorage,
): ImageSequencePreferencesStorage {
  if (storage) return storage;
  const localStorage = globalThis.localStorage;
  if (!localStorage) {
    throw new Error("ImageSequencePreferences: localStorage is unavailable.");
  }
  return localStorage;
}

function migrate(
  parsed: z.infer<typeof v1Schema> | z.infer<typeof v2Schema> | z.infer<typeof v3Schema>,
): ImageSequencePreferences {
  if (parsed.version === 3) return parsed;
  // v1 shipped with auto-create on, and the first launch wrote that value.
  // v2 kept it. Ask before grouping until the user turns auto-create on again.
  return {
    version: 3,
    detectionEnabled: parsed.version === 1 ? true : parsed.detectionEnabled,
    autoDetectOnImport: false,
  };
}

export function loadImageSequencePreferences(
  storage?: ImageSequencePreferencesStorage,
): ImageSequencePreferences {
  const raw = resolveStorage(storage).getItem(IMAGE_SEQUENCE_PREFERENCES_KEY);
  if (!raw) return DEFAULT_IMAGE_SEQUENCE_PREFERENCES;
  try {
    const parsed = z.union([v1Schema, v2Schema, v3Schema]).safeParse(JSON.parse(raw));
    return parsed.success ? migrate(parsed.data) : DEFAULT_IMAGE_SEQUENCE_PREFERENCES;
  } catch {
    return DEFAULT_IMAGE_SEQUENCE_PREFERENCES;
  }
}

export function saveImageSequencePreferences(
  preferences: ImageSequencePreferences,
  storage?: ImageSequencePreferencesStorage,
): void {
  const parsed = v3Schema.parse(preferences);
  resolveStorage(storage).setItem(
    IMAGE_SEQUENCE_PREFERENCES_KEY,
    JSON.stringify(parsed),
  );
}

export function imageSequenceImportFlags(
  preferences: ImageSequencePreferences,
): {
  readonly detectImageSequences: boolean;
  readonly autoDetectImageSequences: boolean;
} {
  return {
    detectImageSequences: preferences.detectionEnabled,
    autoDetectImageSequences:
      preferences.detectionEnabled && preferences.autoDetectOnImport,
  };
}
