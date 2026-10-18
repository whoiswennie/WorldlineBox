import { z } from 'zod';

import {
  CUSTOM_THEME_PREF_KEY,
  customThemeOverridesSchema,
  type CustomTheme,
  type CustomThemeOverrides,
} from './custom-theme';
import { THEME_PROFILE_IDS, type ThemeProfileId } from './theme-profiles';
import type { ThemePreferencesStorage } from './theme-preferences';

/**
 * User-defined themes (v1).
 *
 * A user theme is a named set of colour overrides layered on top of a
 * built-in profile (`base`). Light and dark variants are stored separately;
 * an untouched variant simply falls back to the base profile's palette for
 * that mode, so every user theme is always complete in both modes.
 *
 * `activeId` selects a user theme instead of the built-in profile. It is
 * null while a built-in profile is selected.
 */
export const USER_THEMES_VERSION = 1 as const;
export const USER_THEMES_KEY = 'worldlinebox.user-themes.v1';
export const USER_THEME_NAME_MAX = 40;
export const USER_THEMES_MAX = 48;

export const userThemeSchema = z.strictObject({
  id: z.string().regex(/^user-[a-z0-9-]{1,40}$/u),
  name: z.string().max(USER_THEME_NAME_MAX),
  base: z.enum(THEME_PROFILE_IDS),
  light: customThemeOverridesSchema,
  dark: customThemeOverridesSchema,
});

export const userThemesStateSchema = z.strictObject({
  version: z.literal(USER_THEMES_VERSION),
  themes: z.array(userThemeSchema).max(USER_THEMES_MAX),
  activeId: z.string().nullable(),
});

export type UserTheme = z.infer<typeof userThemeSchema>;
export type UserThemesState = z.infer<typeof userThemesStateSchema>;

export const EMPTY_USER_THEMES: UserThemesState = {
  version: USER_THEMES_VERSION,
  themes: [],
  activeId: null,
};

function resolveStorage(storage?: ThemePreferencesStorage): ThemePreferencesStorage | null {
  if (storage) return storage;
  return (globalThis as { localStorage?: ThemePreferencesStorage }).localStorage ?? null;
}

function hasOverrides(overrides: CustomThemeOverrides | undefined): boolean {
  return Object.values(overrides ?? {}).some((value) => value !== undefined);
}

export function createUserThemeId(now = Date.now(), random = Math.random()): string {
  return `user-${now.toString(36)}-${Math.floor(random * 36 ** 4).toString(36)}`;
}

export function normalizeUserThemeName(name: string): string {
  return name.replace(/\s+/gu, ' ').trim().slice(0, USER_THEME_NAME_MAX);
}

/** Validate a stored record, dropping individual invalid themes. */
export function normalizeUserThemesState(value: unknown): UserThemesState {
  if (typeof value !== 'object' || value === null) return EMPTY_USER_THEMES;
  const record = value as Record<string, unknown>;
  const themes = Array.isArray(record.themes)
    ? record.themes
        .map((theme) => userThemeSchema.safeParse(theme))
        .filter((result) => result.success)
        .map((result) => result.data)
        .slice(0, USER_THEMES_MAX)
    : [];
  const activeId = typeof record.activeId === 'string'
    && themes.some((theme) => theme.id === record.activeId)
    ? record.activeId
    : null;
  return { version: USER_THEMES_VERSION, themes, activeId };
}

export function saveUserThemes(state: UserThemesState, storage?: ThemePreferencesStorage): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(USER_THEMES_KEY, JSON.stringify(userThemesStateSchema.parse(state)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load user themes. When no user-theme record exists yet, any legacy
 * "advanced colours" overrides (worldlinebox.custom-theme.v1) are migrated into a
 * user theme built on the currently selected profile and made active, so the
 * look the user had is preserved exactly. The legacy key is then cleared.
 */
export function loadUserThemes(input: {
  readonly storage?: ThemePreferencesStorage;
  readonly legacyCustomTheme: CustomTheme;
  readonly currentPreset: ThemeProfileId;
  readonly now?: number;
}): { state: UserThemesState; migrated: boolean } {
  const store = resolveStorage(input.storage);
  if (!store) return { state: EMPTY_USER_THEMES, migrated: false };
  let raw: string | null;
  try {
    raw = store.getItem(USER_THEMES_KEY);
  } catch {
    raw = null;
  }
  if (raw !== null) {
    try {
      return { state: normalizeUserThemesState(JSON.parse(raw)), migrated: false };
    } catch {
      return { state: EMPTY_USER_THEMES, migrated: false };
    }
  }
  const legacy = input.legacyCustomTheme;
  if (!hasOverrides(legacy.light) && !hasOverrides(legacy.dark)) {
    return { state: EMPTY_USER_THEMES, migrated: false };
  }
  const theme: UserTheme = {
    id: createUserThemeId(input.now),
    name: '',
    base: input.currentPreset,
    light: { ...legacy.light },
    dark: { ...legacy.dark },
  };
  const state: UserThemesState = {
    version: USER_THEMES_VERSION,
    themes: [theme],
    activeId: theme.id,
  };
  if (saveUserThemes(state, store)) {
    try {
      store.removeItem(CUSTOM_THEME_PREF_KEY);
    } catch {
      // The migrated record is authoritative; a stale legacy key is harmless.
    }
  }
  return { state, migrated: true };
}

export function activeUserTheme(state: UserThemesState): UserTheme | null {
  return state.themes.find((theme) => theme.id === state.activeId) ?? null;
}

export function addUserTheme(
  state: UserThemesState,
  theme: Omit<UserTheme, 'id'> & { id?: string },
): { state: UserThemesState; theme: UserTheme } {
  const created: UserTheme = {
    ...theme,
    id: theme.id ?? createUserThemeId(),
    name: normalizeUserThemeName(theme.name),
  };
  const themes = [...state.themes, created].slice(-USER_THEMES_MAX);
  return { state: { ...state, themes, activeId: created.id }, theme: created };
}

export function updateUserTheme(
  state: UserThemesState,
  id: string,
  patch: Partial<Omit<UserTheme, 'id'>>,
): UserThemesState {
  return {
    ...state,
    themes: state.themes.map((theme) =>
      theme.id === id
        ? {
            ...theme,
            ...patch,
            ...(patch.name === undefined ? {} : { name: normalizeUserThemeName(patch.name) }),
          }
        : theme,
    ),
  };
}

export function removeUserTheme(state: UserThemesState, id: string): UserThemesState {
  return {
    ...state,
    themes: state.themes.filter((theme) => theme.id !== id),
    activeId: state.activeId === id ? null : state.activeId,
  };
}
