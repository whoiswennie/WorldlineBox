/**
 * WorldlineBox-485aeb: state for the font viewer's specimen toolbar.
 *
 * The Renderer renders the glyphs itself (`FontFace` + `worldlinebox://source`), so
 * the viewer controls are plain view-only state: language, preview text, size,
 * weight (only for variable fonts), and synthesized bold/italic/underline.
 * Custom preview text is persisted per language (see
 * `font-preview-preferences.ts`). Pure helpers live here so the language list,
 * defaults and clamping rules are unit-testable without a DOM.
 */

/**
 * Languages the preview text can be written in. The *file's* declared language
 * (see `src/shared/font-metadata.ts`) only decides the initial value; the user
 * can pick any of these, so a German/French/Spanish line is available even
 * though a font file cannot declare those (they are all Latin script).
 */
export type FontPreviewLanguage =
  | 'en'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'ja'
  | 'ko'
  | 'de'
  | 'fr'
  | 'es'
  | 'it'
  | 'pt'
  | 'nl'
  | 'pl'
  | 'tr'
  | 'ru'
  | 'el'
  | 'ar'
  | 'he'
  | 'th';

export type FontViewerWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export interface FontViewerSettings {
  readonly language: FontPreviewLanguage;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  /** 仅可变字体（有 `wght` 轴）会改这个值。 */
  readonly weight: number;
}

export const FONT_VIEWER_DEFAULT_SIZE = 64;
export const FONT_VIEWER_MIN_SIZE = 24;
export const FONT_VIEWER_MAX_SIZE = 200;
export const FONT_VIEWER_WHEEL_STEP = 4;
export const FONT_VIEWER_MAX_TEXT_LENGTH = 120;
/** Sizes of the three specimen rows relative to the chosen size. */
export const FONT_VIEWER_SIZE_RATIOS = [1, 0.6, 0.38] as const;

export const FONT_PREVIEW_LANGUAGES: readonly FontPreviewLanguage[] = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'nl',
  'pl',
  'tr',
  'ru',
  'el',
  'ar',
  'he',
  'th',
];

/**
 * Default specimen text per language: a short sentence in that language plus
 * Latin letters, digits and the shared symbol set `!?.;:@&%#` (9 symbols, so
 * 「常用符号 <= 10」 holds). The cover uses `AaBbCc 0123` instead; these are the
 * longer viewer examples.
 */
const DEFAULT_TEXTS: Record<FontPreviewLanguage, string> = {
  en: 'AaBbCc 0123 WorldlineBox !?.;:@&%#',
  'zh-Hans': '字体文字预览 WorldlineBox 0123 !?.;:@&%#',
  'zh-Hant': '字型文字預覽 WorldlineBox 0123 !?.;:@&%#',
  ja: 'フォント文字プレビュー WorldlineBox 0123 !?.;:@&%#',
  ko: '폰트 문자 미리보기 WorldlineBox 0123 !?.;:@&%#',
  de: 'Schrift Vorschau WorldlineBox 0123 !?.;:@&%#',
  fr: 'Aperçu de police WorldlineBox 0123 !?.;:@&%#',
  es: 'Vista previa WorldlineBox 0123 !?.;:@&%#',
  it: 'Anteprima carattere WorldlineBox 0123 !?.;:@&%#',
  pt: 'Prévia da fonte WorldlineBox 0123 !?.;:@&%#',
  nl: 'Lettertype voorbeeld WorldlineBox 0123 !?.;:@&%#',
  pl: 'Podgląd czcionki WorldlineBox 0123 !?.;:@&%#',
  tr: 'Yazı tipi önizleme WorldlineBox 0123 !?.;:@&%#',
  ru: 'Шрифт превью WorldlineBox 0123 !?.;:@&%#',
  el: 'Προεπισκόπηση γραμματοσειράς WorldlineBox 0123 !?.;:@&%#',
  ar: 'معاينة الخط WorldlineBox 0123 !?.;:@&%#',
  he: 'תצוגת גופן WorldlineBox 0123 !?.;:@&%#',
  th: 'ตัวอย่างฟอนต์ WorldlineBox 0123 !?.;:@&%#',
};

export function defaultFontViewerText(language: FontPreviewLanguage): string {
  return DEFAULT_TEXTS[language];
}

/**
 * 字体文件声明的语言（`latin` / CJK）→ 查看器里的预览语言。
 * 判定不出来时用英文（拉丁字母与数字每个字体都有）。
 */
export function previewLanguageForDeclared(
  declared: string | null | undefined,
): FontPreviewLanguage {
  if (!declared || declared === 'latin') return 'en';
  return isFontPreviewLanguage(declared) ? declared : 'en';
}

export function isFontPreviewLanguage(value: string): value is FontPreviewLanguage {
  return (FONT_PREVIEW_LANGUAGES as readonly string[]).includes(value);
}

export function clampFontViewerSize(value: number): number {
  if (!Number.isFinite(value)) return FONT_VIEWER_DEFAULT_SIZE;
  return Math.min(
    FONT_VIEWER_MAX_SIZE,
    Math.max(FONT_VIEWER_MIN_SIZE, Math.round(value)),
  );
}

export function clampFontViewerText(value: string): string {
  return value.slice(0, FONT_VIEWER_MAX_TEXT_LENGTH);
}

/** 可变字体提供的字重里最接近当前值的一个；没有可用字重时返回 null。 */
export function nearestVariableWeight(
  weights: readonly number[] | null | undefined,
  preferred: number,
): number | null {
  if (!weights || weights.length < 2) return null;
  let best = weights[0]!;
  let bestDistance = Math.abs(best - preferred);
  for (const weight of weights) {
    const distance = Math.abs(weight - preferred);
    if (distance < bestDistance) {
      best = weight;
      bestDistance = distance;
    }
  }
  return best;
}

/** 只有真的提供多个字重时才显示字重控件（静态字体不显示）。 */
export function variableWeightOptions(
  weights: readonly number[] | null | undefined,
): readonly number[] {
  if (!weights) return [];
  const unique = [...new Set(weights.filter((weight) => Number.isFinite(weight) && weight > 0))]
    .sort((left, right) => left - right);
  return unique.length >= 2 ? unique : [];
}

/** Mouse wheel over the specimen: scroll up enlarges, scroll down shrinks. */
export function stepFontViewerSize(current: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampFontViewerSize(current);
  const direction = deltaY < 0 ? 1 : -1;
  const steps = Math.max(1, Math.min(5, Math.round(Math.abs(deltaY) / 100)));
  return clampFontViewerSize(current + direction * steps * FONT_VIEWER_WHEEL_STEP);
}

/**
 * The three specimen sizes shown at once (「至少三种字号」). Always at least
 * three *distinct* values, largest first.
 */
export function fontViewerSpecimenSizes(size: number): number[] {
  const base = clampFontViewerSize(size);
  const sizes = FONT_VIEWER_SIZE_RATIOS.map((ratio) =>
    Math.max(1, Math.round(base * ratio)),
  );
  const distinct: number[] = [];
  for (const value of sizes) {
    let next = value;
    while (distinct.includes(next)) next -= 1;
    distinct.push(next > 0 ? next : 1);
  }
  return distinct;
}

export function createFontViewerSettings(
  language: FontPreviewLanguage,
): FontViewerSettings {
  return {
    language,
    size: FONT_VIEWER_DEFAULT_SIZE,
    weight: 400,
    bold: false,
    italic: false,
    underline: false,
  };
}
