/**
 * WorldlineBox-485aeb: the generated font specimen sheet served at
 * `worldlinebox://source/<libraryId>/<assetId>?revision=…&sample=font`.
 *
 * Main renders this page in the offscreen capture window to produce the font
 * card thumbnail, so the specimen rules live in one place: the font is loaded
 * with `@font-face` from the *same* worldlinebox://source route (same origin, so no
 * CORS relaxation is needed) and the cover text follows the language the font
 * actually declares (see `src/shared/font-metadata.ts` for why cmap coverage is
 * not a language signal).
 *
 * When the file's evidence is inconclusive the cover is deliberately
 * *language-neutral*: no label word at all, so a card can never claim the wrong
 * language (2026-09-19 acceptance feedback).
 *
 * Pure string builder: unit-testable without Electron, and every interpolated
 * value is escaped so a family name cannot inject markup.
 */

import {
  parseFontLanguage,
  type FontLanguage,
} from '../shared/font-metadata';

export interface FontSamplePageInput {
  /** Absolute `worldlinebox://source/...` URL of the font file itself. */
  readonly fontUrl: string;
  /** Family name read from the font's `name` table; null when unreadable. */
  readonly family?: string | null;
  /** Language the font declares, or null when the file is inconclusive. */
  readonly language?: FontLanguage | null;
}

export interface FontSampleCoverText {
  readonly primary: string;
  readonly secondary: string;
  readonly htmlLang: string;
}

/** 封面第一行的标签：只有能确定语言时才写，避免给字体贴错语言。 */
const COVER_LABELS: Record<FontLanguage, { label: string; htmlLang: string }> = {
  ja: { label: 'フォントプレビュー', htmlLang: 'ja' },
  'zh-Hans': { label: '字体预览', htmlLang: 'zh-CN' },
  'zh-Hant': { label: '字型預覽', htmlLang: 'zh-TW' },
  ko: { label: '폰트 미리보기', htmlLang: 'ko' },
  latin: { label: 'Font Preview', htmlLang: 'en' },
};

/**
 * 封面的样例字符固定为拉丁字母 + 数字：每个字体都有这些字符，一眼就能看出
 * 字形，不需要（也不该）换成对应语言的文字 —— 换语言只是换第一行的标签词。
 * 更长的、对应语言的整句示例留给查看器（见 `font-viewer-settings.ts`）。
 */
const COVER_SAMPLE_CHARS = 'AaBbCc 0123';

/**
 * Cover text of the font card: `「字体预览 AaBbCc 0123」` in the font's own
 * language plus `「{family} · WorldlineBox」`. Falls back to a language-neutral first
 * line when the language is unknown.
 */
export function fontSampleCoverText(input: {
  readonly family?: string | null;
  readonly language?: FontLanguage | null;
}): FontSampleCoverText {
  const language = input.language ?? null;
  const label = language ? COVER_LABELS[language].label : null;
  const family = input.family?.trim();
  return {
    primary: label ? `${label} ${COVER_SAMPLE_CHARS}` : COVER_SAMPLE_CHARS,
    secondary: family ? `${family} · WorldlineBox` : 'WorldlineBox',
    htmlLang: language ? COVER_LABELS[language].htmlLang : 'en',
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Split a `worldlinebox://source/…&sample=font` request into the sheet's inputs.
 *
 * The sample-only query keys (`sample`, `family`, `lang`, `script`) must be
 * stripped from the URL handed to `@font-face`: a leftover key would make the
 * font request differ from a real asset request.
 */
export function resolveFontSampleRequest(sourceUrl: URL): {
  readonly fontUrl: string;
  readonly family: string | null;
  readonly language: FontLanguage | null;
} {
  const fontQuery = new URLSearchParams(sourceUrl.searchParams);
  for (const key of ['sample', 'family', 'lang', 'script']) fontQuery.delete(key);
  return {
    fontUrl: `worldlinebox://source${sourceUrl.pathname}?${fontQuery.toString()}`,
    family: sourceUrl.searchParams.get('family'),
    language: parseFontLanguage(sourceUrl.searchParams.get('lang')),
  };
}

export function createFontSamplePage(input: FontSamplePageInput): string {
  const { fontUrl } = input;
  const cover = fontSampleCoverText(input);
  // The sheet is captured offscreen and cached as one 512 px artifact, so it
  // cannot follow the app theme; it uses the neutral dark card surface.
  const background = '#1b1c1f';
  const foreground = '#f2f2f4';
  const muted = '#a9a9b2';
  // Attribute context: the URL is quoted in the CSS string, so escape quotes.
  const safeFontUrl = escapeHtml(fontUrl).replaceAll('\n', '');
  return `<!doctype html>
<html lang="${cover.htmlLang}">
  <head>
    <meta charset="utf-8" />
    <style>
      @font-face {
        font-family: "WorldlineBoxFontSample";
        src: url("${safeFontUrl}");
        font-display: block;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; height: 100%; }
      body {
        background: ${background};
        color: ${foreground};
        font-family: "WorldlineBoxFontSample", system-ui, sans-serif;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 14px;
        padding: 28px 36px;
      }
      .primary {
        font-size: 76px;
        line-height: 1.15;
        word-break: break-word;
      }
      .secondary {
        font-size: 34px;
        line-height: 1.3;
        color: ${muted};
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <div class="primary">${escapeHtml(cover.primary)}</div>
    <div class="secondary">${escapeHtml(cover.secondary)}</div>
  </body>
</html>
`;
}
