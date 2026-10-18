import { describe, expect, it } from 'vitest';

import { CUSTOM_THEME_PREF_KEY, DEFAULT_CUSTOM_THEME } from '../../src/renderer/theme/custom-theme';
import {
  activeUserTheme,
  addUserTheme,
  EMPTY_USER_THEMES,
  loadUserThemes,
  normalizeUserThemesState,
  removeUserTheme,
  saveUserThemes,
  updateUserTheme,
  USER_THEMES_KEY,
} from '../../src/renderer/theme/user-themes';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('user themes', () => {
  it('starts empty without legacy overrides', () => {
    const storage = memoryStorage();
    const { state, migrated } = loadUserThemes({
      storage,
      legacyCustomTheme: DEFAULT_CUSTOM_THEME,
      currentPreset: 'worldlinebox',
    });
    expect(migrated).toBe(false);
    expect(state).toEqual(EMPTY_USER_THEMES);
  });

  it('migrates legacy advanced colours into an active user theme and clears the old key', () => {
    const storage = memoryStorage({ [CUSTOM_THEME_PREF_KEY]: '{}' });
    const { state, migrated } = loadUserThemes({
      storage,
      legacyCustomTheme: {
        version: 1,
        light: { '--ui-surface-canvas': '#eeeeee' },
        dark: { '--ui-action-accent': '#ff8800' },
      },
      currentPreset: 'forest',
      now: 1_700_000_000_000,
    });
    expect(migrated).toBe(true);
    expect(state.themes).toHaveLength(1);
    const theme = activeUserTheme(state)!;
    expect(theme.base).toBe('forest');
    expect(theme.light['--ui-surface-canvas']).toBe('#eeeeee');
    expect(theme.dark['--ui-action-accent']).toBe('#ff8800');
    expect(storage.data.has(CUSTOM_THEME_PREF_KEY)).toBe(false);
    expect(JSON.parse(storage.data.get(USER_THEMES_KEY)!).activeId).toBe(theme.id);
  });

  it('does not migrate again once a record exists', () => {
    const storage = memoryStorage({
      [USER_THEMES_KEY]: JSON.stringify(EMPTY_USER_THEMES),
    });
    const { state, migrated } = loadUserThemes({
      storage,
      legacyCustomTheme: { version: 1, light: { '--ui-surface-canvas': '#eeeeee' }, dark: {} },
      currentPreset: 'worldlinebox',
    });
    expect(migrated).toBe(false);
    expect(state.themes).toHaveLength(0);
  });

  it('adds, renames, edits, deletes and persists', () => {
    const storage = memoryStorage();
    const added = addUserTheme(EMPTY_USER_THEMES, {
      id: 'user-a',
      name: '  Warm   paper ',
      base: 'paper',
      light: {},
      dark: {},
    });
    const { theme } = added;
    let { state } = added;
    expect(theme.name).toBe('Warm paper');
    expect(state.activeId).toBe('user-a');
    state = updateUserTheme(state, 'user-a', { name: 'Renamed', dark: { '--ui-surface-pane': '#101010' } });
    expect(state.themes[0]).toMatchObject({ name: 'Renamed', dark: { '--ui-surface-pane': '#101010' } });
    expect(saveUserThemes(state, storage)).toBe(true);
    const reloaded = loadUserThemes({ storage, legacyCustomTheme: DEFAULT_CUSTOM_THEME, currentPreset: 'worldlinebox' });
    expect(reloaded.state).toEqual(state);
    state = removeUserTheme(state, 'user-a');
    expect(state.themes).toHaveLength(0);
    expect(state.activeId).toBeNull();
  });

  it('drops invalid themes and dangling active ids', () => {
    const state = normalizeUserThemesState({
      version: 1,
      themes: [
        { id: 'user-ok', name: 'ok', base: 'worldlinebox', light: {}, dark: {} },
        { id: 'bad id', name: 'x', base: 'worldlinebox', light: {}, dark: {} },
        { id: 'user-x', name: 'x', base: 'nope', light: {}, dark: {} },
        { id: 'user-y', name: 'y', base: 'worldlinebox', light: { '--ui-surface-canvas': 'url(x)' }, dark: {} },
      ],
      activeId: 'user-gone',
    });
    expect(state.themes.map((theme) => theme.id)).toEqual(['user-ok']);
    expect(state.activeId).toBeNull();
  });
});
