import { z } from 'zod';
import { customThemeSchema, type CustomTheme } from './custom-theme';
import type { ThemePreferencesStorage } from './theme-preferences';

export const THEME_COLOR_DRAFTS_KEY = 'worldlinebox.theme-color-drafts.v1';
const draftSchema = z.strictObject({
  customTheme: customThemeSchema,
  accentHex: z.string().regex(/^#[0-9a-f]{6}$/iu).nullable(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  drafts: z.record(z.string().regex(/^(?:preset:[a-z][a-z0-9-]{0,63}|user:user-[a-z0-9-]{1,40})$/u), draftSchema)
    .refine((drafts) => Object.keys(drafts).length <= 128),
});
export type ThemeColorDraft = { customTheme: CustomTheme; accentHex: string | null };
export type ThemeColorDrafts = Record<string, ThemeColorDraft>;

export function themeColorKey(preset: string, userId?: string | null): string {
  return userId ? `user:${userId}` : `preset:${preset}`;
}

function resolveStorage(storage?: ThemePreferencesStorage) {
  return storage ?? (globalThis as { localStorage?: ThemePreferencesStorage }).localStorage;
}

export function loadThemeColorDrafts(storage?: ThemePreferencesStorage): ThemeColorDrafts | null {
  try {
    const raw = resolveStorage(storage)?.getItem(THEME_COLOR_DRAFTS_KEY);
    if (!raw || raw.length > 1_000_000) return null;
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.drafts : null;
  } catch { return null; }
}

export function saveThemeColorDrafts(drafts: ThemeColorDrafts, storage?: ThemePreferencesStorage): void {
  const state = stateSchema.parse({ version: 1, drafts });
  try {
    resolveStorage(storage)?.setItem(THEME_COLOR_DRAFTS_KEY, JSON.stringify(state));
  } catch {
    // Keep live edits usable when persistent storage is unavailable.
  }
}

/** Named themes capture the quick accent as part of their portable colors. */
export function captureThemeColors(customTheme: CustomTheme, accentHex: string | null) {
  const accent = accentHex ? { '--ui-action-accent': accentHex } : {};
  return {
    light: { ...accent, ...customTheme.light },
    dark: { ...accent, ...customTheme.dark },
  };
}
