/**
 * WorldlineBox-485aeb: read font metadata from a file on disk.
 *
 * `font-metadata.ts` is a pure byte parser; this wrapper owns the filesystem
 * side (size guard + read) so both the font thumbnail pipeline and the
 * Inspector's on-demand metadata lookup share one implementation.
 *
 * A font that cannot be read or parsed is not an error: callers fall back to
 * the generic card/Inspector text.
 */

import { readFileSync, statSync } from 'node:fs';

import {
  parseFontMetadata,
  type FontCjkLanguage,
  type FontLanguage,
  type FontMetadata,
} from '../shared/font-metadata';

/**
 * Fonts large enough to blow up memory are skipped: the parser also has to
 * decompress WOFF2 payloads, and a CJK font with tens of thousands of glyphs
 * is still far below this ceiling.
 */
export const MAX_FONT_METADATA_BYTES = 64 * 1024 * 1024;

export function readFontMetadata(
  filePath: string,
  options?: { readonly maxBytes?: number },
): FontMetadata | null {
  const maxBytes = options?.maxBytes ?? MAX_FONT_METADATA_BYTES;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    return parseFontMetadata(readFileSync(filePath));
  } catch {
    return null;
  }
}

/**
 * Query suffix for the `sample=font` cover sheet: family caption + language
 * label. `lang` is omitted when the file's evidence is inconclusive, so the
 * sheet falls back to a language-neutral cover instead of guessing. The cover's
 * sample characters are always Latin letters + digits (`AaBbCc 0123`), so no
 * script parameter is needed here.
 */
export function fontSampleQuerySuffix(metadata: FontMetadata | null): string {
  if (!metadata) return '';
  const params = new URLSearchParams();
  if (metadata.family) params.set('family', metadata.family);
  if (metadata.language.resolved) params.set('lang', metadata.language.resolved);
  return `&${params.toString()}`;
}

/** Inspector fields derived from a parsed font (WorldlineBox-485aeb). */
export interface ExtractedFontMetadataFields {
  readonly fontFamily: string | null;
  readonly fontSubfamily: string | null;
  readonly fontFullName: string | null;
  readonly fontVersion: string | null;
  readonly fontManufacturer: string | null;
  readonly fontCopyright: string | null;
  readonly fontWeightClass: number | null;
  readonly fontWidthClass: number | null;
  readonly fontIsBold: boolean;
  readonly fontIsItalic: boolean;
  readonly fontUnitsPerEm: number | null;
  readonly fontGlyphCount: number | null;
  /** 敢断言的单一语言；null 表示文件证据不足以判定（界面显示声明的集合）。 */
  readonly fontLanguage: FontLanguage | null;
  /** 文件声明的 CJK 语言集合（可能多个）。 */
  readonly fontLanguages: readonly FontCjkLanguage[];
  readonly fontCoversLatin: boolean;
  /** 可变字体的可用字重；静态字体为 null（查看器据此隐藏字重控件）。 */
  readonly fontVariableWeights: readonly number[] | null;
}

export function fontMetadataToExtractedFields(
  metadata: FontMetadata,
): ExtractedFontMetadataFields {
  return {
    fontFamily: metadata.family,
    fontSubfamily: metadata.subfamily,
    fontFullName: metadata.fullName,
    fontVersion: metadata.version,
    fontManufacturer: metadata.manufacturer,
    fontCopyright: metadata.copyright,
    fontWeightClass: metadata.weightClass,
    fontWidthClass: metadata.widthClass,
    fontIsBold: metadata.isBold,
    fontIsItalic: metadata.isItalic,
    fontUnitsPerEm: metadata.unitsPerEm,
    fontGlyphCount: metadata.glyphCount,
    fontLanguage: metadata.language.resolved,
    fontLanguages: metadata.language.declared,
    fontCoversLatin: metadata.language.coversLatin,
    fontVariableWeights: metadata.variableWeights,
  };
}
