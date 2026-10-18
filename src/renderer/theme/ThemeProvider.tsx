import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  applyBackgroundPreferences,
  loadBackgroundPreferences,
  saveBackgroundPreferences,
  type BackgroundPreferences,
} from './background-preferences';
import { loadBackgroundMotion, saveBackgroundMotion } from './animated-background-preferences';
import { isAnimatedTheme } from './dsh-background-media';
import {
  loadCustomTheme,
  type CustomTheme,
} from './custom-theme';
import { CUSTOM_THEME_OVERRIDE_TOKENS, DEFAULT_CUSTOM_THEME } from './custom-theme';
import { normalizeAccentHex } from './accent-preferences';
import { captureThemeColors, loadThemeColorDrafts, saveThemeColorDrafts, themeColorKey, type ThemeColorDraft, type ThemeColorDrafts } from './theme-color-drafts';
import {
  activeUserTheme as findActiveUserTheme,
  addUserTheme,
  loadUserThemes,
  removeUserTheme,
  saveUserThemes,
  updateUserTheme,
  type UserTheme,
  type UserThemesState,
} from './user-themes';
import {
  migrateLegacyAccentIntoCustomTheme,
  resolveEffectiveThemeTokens,
} from './theme-composition';
import {
  loadThemeAccent,
} from './theme-accent-preferences';
import {
  loadThemeProfile,
  saveThemeProfile,
  THEME_PROFILE_VERSION,
  type ThemeProfile,
  type ThemeProfileId,
} from './theme-profiles';
import {
  applyResolvedTheme,
  loadThemePreferences,
  readSystemTheme,
  resolveEffectiveTheme,
  setStoredTheme,
  type ResolvedTheme,
  type ThemePreference,
  type ThemePreferencesStorage,
} from './theme-preferences';

type ThemeContextValue = {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  readonly customTheme: CustomTheme;
  readonly themeAccentHex: string | null;
  readonly themeProfile: ThemeProfile;
  readonly backgroundPreferences: BackgroundPreferences;
  readonly backgroundMotion: boolean;
  readonly setBackgroundMotion: (enabled: boolean) => boolean;
  readonly themeRevision: number;
  readonly setTheme: (theme: ThemePreference) => void;
  readonly setCustomTheme: (theme: CustomTheme) => void;
  readonly resetCustomTheme: () => void;
  readonly setThemeProfile: (profile: ThemeProfileId) => void;
  readonly setThemeAccent: (accentHex: string) => void;
  readonly setBackgroundPreferences: (preferences: BackgroundPreferences) => boolean;
  /** Saved user themes and which one (if any) is active. */
  readonly userThemes: UserThemesState;
  readonly activeUserTheme: UserTheme | null;
  readonly selectUserTheme: (id: string) => void;
  /** Duplicate the current look (profile + overrides) into a new active user theme. */
  readonly createUserTheme: (name: string) => string;
  readonly renameUserTheme: (id: string, name: string) => void;
  readonly deleteUserTheme: (id: string) => void;
  /** Unsaved colour edits belonging to the current theme only. */
  readonly customOverlay: CustomTheme;
  readonly saveOverlayToActiveUserTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export type ThemeProviderProps = {
  readonly children: ReactNode;
  readonly storage?: ThemePreferencesStorage;
  readonly initialPreference?: ThemePreference;
};

export function ThemeProvider({
  children,
  storage,
  initialPreference,
}: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => initialPreference ?? loadThemePreferences(storage).theme,
  );
  const [initial] = useState(() => {
    // The legacy standalone accent preference migrates into a custom-theme
    // override here, once, before anything else reads the theme. Legacy
    // "advanced colour" overrides then migrate into a user theme.
    const savedDrafts = loadThemeColorDrafts(storage);
    const legacy = savedDrafts ? DEFAULT_CUSTOM_THEME
      : migrateLegacyAccentIntoCustomTheme(loadCustomTheme(storage), storage);
    const profile = loadThemeProfile(storage);
    const loaded = loadUserThemes({
      storage,
      legacyCustomTheme: legacy,
      currentPreset: profile.preset,
    });
    return {
      drafts: savedDrafts ?? {
        [themeColorKey(profile.preset, findActiveUserTheme(loaded.state)?.id)]: {
          customTheme: loaded.migrated ? DEFAULT_CUSTOM_THEME : legacy,
          accentHex: loadThemeAccent(storage),
        },
      },
      profile,
      userThemes: loaded.state,
    };
  });
  const [colorDrafts, setColorDrafts] = useState<ThemeColorDrafts>(initial.drafts);
  const [userThemes, setUserThemesState] = useState<UserThemesState>(initial.userThemes);
  const [baseThemeProfile, setThemeProfileState] = useState<ThemeProfile>(initial.profile);
  const [backgroundPreferences, setBackgroundPreferencesState] = useState<BackgroundPreferences>(() => loadBackgroundPreferences(storage));
  const [backgroundMotion, setBackgroundMotionState] = useState(() => loadBackgroundMotion(storage));
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    readSystemTheme(),
  );
  const [themeRevision, setThemeRevision] = useState(0);
  const themeSignatureRef = useRef('');

  const activeUserTheme = useMemo(() => findActiveUserTheme(userThemes), [userThemes]);
  const colorKey = themeColorKey(baseThemeProfile.preset, activeUserTheme?.id);
  const baseCustomTheme = colorDrafts[colorKey]?.customTheme ?? DEFAULT_CUSTOM_THEME;
  const themeAccentHex = colorDrafts[colorKey]?.accentHex ?? null;
  useEffect(() => { saveThemeColorDrafts(colorDrafts, storage); }, [colorDrafts, storage]);
  const commitColorDraft = useCallback((patch: Partial<ThemeColorDraft>) => {
    setColorDrafts((current) => ({
      ...current,
      [colorKey]: {
        customTheme: current[colorKey]?.customTheme ?? DEFAULT_CUSTOM_THEME,
        accentHex: current[colorKey]?.accentHex ?? null,
        ...patch,
      },
    }));
  }, [colorKey]);
  // The theme that is actually rendered: a user theme's base profile and
  // overrides replace the built-in selection while it is active.
  const themeProfile = useMemo<ThemeProfile>(
    () => (activeUserTheme ? { ...baseThemeProfile, preset: activeUserTheme.base } : baseThemeProfile),
    [activeUserTheme, baseThemeProfile],
  );
  // Effective overrides combine the selected named theme with its own draft.
  // Built-in profiles have independent drafts under their preset identities.
  const customTheme = useMemo<CustomTheme>(
    () => (activeUserTheme
      ? {
          ...baseCustomTheme,
          light: { ...activeUserTheme.light, ...baseCustomTheme.light },
          dark: { ...activeUserTheme.dark, ...baseCustomTheme.dark },
        }
      : baseCustomTheme),
    [activeUserTheme, baseCustomTheme],
  );
  const commitUserThemes = useCallback((next: UserThemesState) => {
    saveUserThemes(next, storage);
    setUserThemesState(next);
  }, [storage]);

  const resolved = useMemo(
    () => resolveEffectiveTheme(preference, systemTheme),
    [preference, systemTheme],
  );

  useEffect(() => {
    applyResolvedTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    for (const token of CUSTOM_THEME_OVERRIDE_TOKENS) {
      root.style.removeProperty(token);
    }
    const composition = resolveEffectiveThemeTokens({
      themeProfile,
      customTheme,
      resolved,
      themeAccentHex,
    });
    for (const [token, value] of Object.entries(composition.tokens)) {
      root.style.setProperty(token, value);
    }
    root.style.setProperty('--accent', composition.accentHex);
  }, [customTheme, resolved, themeAccentHex, themeProfile]);

  useEffect(() => {
    applyBackgroundPreferences(backgroundPreferences);
    const root = document.documentElement;
    if (backgroundPreferences.enabled && isAnimatedTheme(themeProfile.preset) && backgroundPreferences.imageDataUrl === null) {
      root.dataset.animatedBackground = themeProfile.preset;
      root.style.setProperty('--ui-background-surface-opacity', '0%');
      root.style.setProperty('--ui-backdrop-image', 'none');
      if (backgroundPreferences.showInMainPanel) root.setAttribute('data-bg-main-panel', 'on');
    } else {
      delete root.dataset.animatedBackground;
      root.style.removeProperty('--ui-backdrop-image');
    }
  }, [backgroundPreferences, themeProfile.preset]);

  useEffect(() => {
    const signature = `${resolved}:${JSON.stringify(customTheme)}:${JSON.stringify(themeAccentHex)}:${JSON.stringify(themeProfile)}:${JSON.stringify(backgroundPreferences)}`;
    if (themeSignatureRef.current === signature) return;
    themeSignatureRef.current = signature;
    setThemeRevision((revision) => revision + 1);
  }, [backgroundPreferences, customTheme, resolved, themeAccentHex, themeProfile]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystemTheme(readSystemTheme());
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setStoredTheme(next, storage);
      setPreferenceState(next);
    },
    [storage],
  );

  /** Replace the anonymous overlay (live, unsaved edits). */
  const setCustomTheme = useCallback((next: CustomTheme) => {
    commitColorDraft({ customTheme: next });
  }, [commitColorDraft]);

  /** Drop the anonymous overlay; the current (named or built-in) theme shows as saved. */
  const resetCustomTheme = useCallback(() => {
    commitColorDraft({ customTheme: DEFAULT_CUSTOM_THEME });
  }, [commitColorDraft]);

  /** Fold the overlay into the active named theme. */
  const saveOverlayToActiveUserTheme = useCallback(() => {
    if (!activeUserTheme) return;
    commitUserThemes(updateUserTheme(userThemes, activeUserTheme.id, {
      ...captureThemeColors(customTheme, themeAccentHex),
    }));
    commitColorDraft({ customTheme: DEFAULT_CUSTOM_THEME });
  }, [activeUserTheme, commitColorDraft, commitUserThemes, customTheme, themeAccentHex, userThemes]);

  const selectUserTheme = useCallback((id: string) => {
    if (!userThemes.themes.some((theme) => theme.id === id)) return;
    commitUserThemes({ ...userThemes, activeId: id });
  }, [commitUserThemes, userThemes]);

  const createUserTheme = useCallback((name: string) => {
    const { state, theme } = addUserTheme(userThemes, {
      name,
      base: themeProfile.preset,
      ...captureThemeColors(customTheme, themeAccentHex),
    });
    commitUserThemes(state);
    // The new theme captures the current appearance; the source keeps its draft.
    setColorDrafts((current) => ({
      ...current,
      [themeColorKey(theme.base, theme.id)]: { customTheme: DEFAULT_CUSTOM_THEME, accentHex: themeAccentHex },
    }));
    return theme.id;
  }, [commitUserThemes, customTheme, themeAccentHex, themeProfile.preset, userThemes]);

  const renameUserTheme = useCallback((id: string, name: string) => {
    commitUserThemes(updateUserTheme(userThemes, id, { name }));
  }, [commitUserThemes, userThemes]);

  const deleteUserTheme = useCallback((id: string) => {
    const deleted = userThemes.themes.find((theme) => theme.id === id);
    setColorDrafts((current) => {
      const next = { ...current };
      delete next[themeColorKey(deleted?.base ?? baseThemeProfile.preset, id)];
      return next;
    });
    commitUserThemes(removeUserTheme(userThemes, id));
    // Deleting the active theme falls back to the profile it was built on.
    if (deleted && userThemes.activeId === id) {
      const profile: ThemeProfile = { version: THEME_PROFILE_VERSION, preset: deleted.base, overrides: {} };
      saveThemeProfile(profile, storage);
      setThemeProfileState(profile);
    }
  }, [baseThemeProfile.preset, commitUserThemes, storage, userThemes]);

  const setThemeProfile = useCallback((preset: ThemeProfileId) => {
    const next: ThemeProfile = { version: THEME_PROFILE_VERSION, preset, overrides: {} };
    saveThemeProfile(next, storage);
    setThemeProfileState(next);
    if (userThemes.activeId !== null) commitUserThemes({ ...userThemes, activeId: null });
    // Light/dark is orthogonal to the theme: picking a profile must not flip
    // the global light/dark preference.
  }, [commitUserThemes, storage, userThemes]);

  const setThemeAccent = useCallback((accentHex: string) => {
    const nextHex = normalizeAccentHex(accentHex);
    if (!nextHex) throw new Error('Invalid theme accent color');
    // A quick color is an intentional shortcut for the accent only. Remove
    // the advanced accent override so clicking a swatch always takes effect;
    // every other advanced color remains untouched.
    const nextOverlay: CustomTheme = {
      ...baseCustomTheme,
      light: { ...baseCustomTheme.light },
      dark: { ...baseCustomTheme.dark },
    };
    delete nextOverlay.light['--ui-action-accent'];
    delete nextOverlay.dark['--ui-action-accent'];
    commitColorDraft({ customTheme: nextOverlay, accentHex: nextHex });
    if (activeUserTheme && (activeUserTheme.light['--ui-action-accent'] || activeUserTheme.dark['--ui-action-accent'])) {
      const light = { ...activeUserTheme.light };
      const dark = { ...activeUserTheme.dark };
      delete light['--ui-action-accent'];
      delete dark['--ui-action-accent'];
      commitUserThemes(updateUserTheme(userThemes, activeUserTheme.id, { light, dark }));
    }
  }, [activeUserTheme, baseCustomTheme, commitColorDraft, commitUserThemes, userThemes]);

  const setBackgroundPreferences = useCallback((next: BackgroundPreferences) => {
    const saved = saveBackgroundPreferences(next, storage);
    if (saved) setBackgroundPreferencesState(next);
    return saved;
  }, [storage]);

  const setBackgroundMotion = useCallback((enabled: boolean) => {
    const saved = saveBackgroundMotion(enabled, storage);
    if (saved) setBackgroundMotionState(enabled);
    return saved;
  }, [storage]);

  const value = useMemo(
    () => ({
      preference,
      resolved,
      customTheme,
      themeAccentHex,
      themeProfile,
      backgroundPreferences,
      backgroundMotion,
      setBackgroundMotion,
      themeRevision,
      setTheme,
      setCustomTheme,
      resetCustomTheme,
      setThemeProfile,
      setThemeAccent,
      setBackgroundPreferences,
      userThemes,
      activeUserTheme,
      selectUserTheme,
      createUserTheme,
      renameUserTheme,
      deleteUserTheme,
      customOverlay: baseCustomTheme,
      saveOverlayToActiveUserTheme,
    }),
    [backgroundMotion, setBackgroundMotion, baseCustomTheme, saveOverlayToActiveUserTheme, activeUserTheme, createUserTheme, deleteUserTheme, renameUserTheme, selectUserTheme, userThemes, backgroundPreferences, customTheme, preference, resetCustomTheme, resolved, setBackgroundPreferences, setCustomTheme, setTheme, setThemeAccent, setThemeProfile, themeAccentHex, themeProfile, themeRevision],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return value;
}
