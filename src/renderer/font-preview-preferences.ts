/**
 * WorldlineBox-485aeb: per-language font preview text, persisted app-wide.
 *
 * The user asked for the text they typed to survive browsing to other fonts:
 * it is stored per language (not per asset, not per library) so a custom
 * Chinese preview line is reused for every Chinese font. Stored in
 * localStorage like the other renderer preferences; a corrupted value falls
 * back to the built-in defaults instead of throwing.
 */

import { z } from 'zod';

import {
  FONT_PREVIEW_LANGUAGES,
  clampFontViewerText,
  type FontPreviewLanguage,
} from './font-viewer-settings';

export const FONT_PREVIEW_TEXT_PREF_KEY = 'worldlinebox.font-preview-text.v1';

export type FontPreviewTexts = Readonly<Partial<Record<FontPreviewLanguage, string>>>;

const languageTextSchema = z.record(z.string(), z.string());

export function loadFontPreviewTexts(
  storage: Pick<Storage, 'getItem'> = localStorage,
): FontPreviewTexts {
  try {
    const raw = storage.getItem(FONT_PREVIEW_TEXT_PREF_KEY);
    if (raw === null) return {};
    const parsed = languageTextSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    const entries: Array<[FontPreviewLanguage, string]> = [];
    for (const language of FONT_PREVIEW_LANGUAGES) {
      const text = parsed.data[language]?.trim();
      if (text) entries.push([language, clampFontViewerText(text)]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function persist(
  texts: FontPreviewTexts,
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
): FontPreviewTexts {
  try {
    if (Object.keys(texts).length === 0) {
      storage.removeItem(FONT_PREVIEW_TEXT_PREF_KEY);
    } else {
      storage.setItem(FONT_PREVIEW_TEXT_PREF_KEY, JSON.stringify(texts));
    }
  } catch {
    // Storage may be unavailable (private mode / quota); the viewer still works
    // for this session.
  }
  return texts;
}

type FontPreviewTextStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Store a custom preview text for one language; empty text clears it. */
export function saveFontPreviewText(
  language: FontPreviewLanguage,
  text: string,
  storage: FontPreviewTextStorage = localStorage,
  current: FontPreviewTexts = loadFontPreviewTexts(storage),
): FontPreviewTexts {
  const trimmed = clampFontViewerText(text).trim();
  const next: Record<string, string> = { ...current };
  if (trimmed) next[language] = trimmed;
  else delete next[language];
  return persist(next, storage);
}

/** Drop the custom text for one language (the viewer's undo action). */
export function clearFontPreviewText(
  language: FontPreviewLanguage,
  storage: FontPreviewTextStorage = localStorage,
  current: FontPreviewTexts = loadFontPreviewTexts(storage),
): FontPreviewTexts {
  const next: Record<string, string> = { ...current };
  delete next[language];
  return persist(next, storage);
}
