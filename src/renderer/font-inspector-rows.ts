/**
 * WorldlineBox-485aeb: Inspector rows for a font asset.
 *
 * The Worker reads the metadata straight from the font file (see
 * `src/worker/font-file-metadata.ts`); this module only decides which facts are
 * worth showing and how to label them, so the rules are unit-testable without
 * rendering the panel. Unknown facts are omitted — never invented.
 *
 * `import type` keeps the font parser (and its `node:zlib` dependency) out of
 * the Renderer bundle.
 */

import type { ExtractedVideoMetadata } from "../shared/asset-types";

export type FontInspectorRowKey =
  | "family"
  | "style"
  | "version"
  | "weight"
  | "glyphs"
  | "unitsPerEm"
  | "script"
  | "manufacturer";

export interface FontInspectorRow {
  readonly key: FontInspectorRowKey;
  /** i18n key of the row label. */
  readonly labelKey: string;
  readonly value: string;
}

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

/** `700 · Bold`, `550`, or null when the OS/2 table had no usable weight. */
export function formatFontWeight(weightClass: number | null | undefined): string | null {
  if (weightClass === null || weightClass === undefined || !Number.isFinite(weightClass)) {
    return null;
  }
  const name = WEIGHT_NAMES[Math.round(weightClass)];
  return name ? `${weightClass} · ${name}` : String(weightClass);
}

/** `Book · Italic` from the subfamily plus the OS/2 style flags. */
export function formatFontStyle(
  subfamily: string | null | undefined,
  isBold: boolean | undefined,
  isItalic: boolean | undefined,
): string | null {
  const parts: string[] = [];
  const trimmed = subfamily?.trim();
  if (trimmed) parts.push(trimmed);
  if (isBold && !trimmed?.toLowerCase().includes("bold")) parts.push("Bold");
  if (isItalic && !trimmed?.toLowerCase().includes("italic")) parts.push("Italic");
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function buildFontInspectorRows(
  metadata: ExtractedVideoMetadata | null,
  options: {
    /** Label per script, e.g. `{ ja: "日文", "zh-Hans": "简体中文", … }`. */
    readonly scriptLabels: Readonly<Record<string, string>>;
    readonly formatNumber: (value: number) => string;
  },
): FontInspectorRow[] {
  if (!metadata) return [];
  const rows: FontInspectorRow[] = [];
  const family = metadata.fontFamily?.trim();
  if (family) rows.push({ key: "family", labelKey: "inspector.fontFamily", value: family });
  const style = formatFontStyle(
    metadata.fontSubfamily,
    metadata.fontIsBold,
    metadata.fontIsItalic,
  );
  if (style) rows.push({ key: "style", labelKey: "inspector.fontStyle", value: style });
  const version = metadata.fontVersion?.trim();
  if (version) rows.push({ key: "version", labelKey: "inspector.fontVersion", value: version });
  const weight = formatFontWeight(metadata.fontWeightClass);
  if (weight) rows.push({ key: "weight", labelKey: "inspector.fontWeight", value: weight });
  if (metadata.fontGlyphCount != null && metadata.fontGlyphCount > 0) {
    rows.push({
      key: "glyphs",
      labelKey: "inspector.fontGlyphs",
      value: options.formatNumber(metadata.fontGlyphCount),
    });
  }
  if (metadata.fontUnitsPerEm != null && metadata.fontUnitsPerEm > 0) {
    rows.push({
      key: "unitsPerEm",
      labelKey: "inspector.fontUnitsPerEm",
      value: options.formatNumber(metadata.fontUnitsPerEm),
    });
  }
  // 字符集显示**文件声明的集合**（中日韩字体常常同时声明多种语言，写成单一
  // 语言会是编造），拉丁文只有真的覆盖基本拉丁字母时才追加。
  const scripts = (metadata.fontLanguages ?? [])
    .map((language) => options.scriptLabels[language])
    .filter((label): label is string => Boolean(label));
  if (metadata.fontCoversLatin && !scripts.includes(options.scriptLabels.latin ?? "")) {
    const latin = options.scriptLabels.latin;
    if (latin) scripts.push(latin);
  }
  if (scripts.length > 0) {
    rows.push({
      key: "script",
      labelKey: "inspector.fontScript",
      value: scripts.join("、"),
    });
  }
  const manufacturer = metadata.fontManufacturer?.trim();
  if (manufacturer) {
    rows.push({
      key: "manufacturer",
      labelKey: "inspector.fontManufacturer",
      value: manufacturer,
    });
  }
  return rows;
}
