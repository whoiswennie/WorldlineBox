import { describe, expect, it } from "vitest";

import {
  buildFontInspectorRows,
  formatFontStyle,
  formatFontWeight,
} from "../../src/renderer/font-inspector-rows";
import { extractedVideoMetadataSchema } from "../../src/shared/asset-types";

// WorldlineBox-485aeb：字体 Inspector 的元信息行。
const scriptLabels = {
  ja: "日文",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁体中文",
  ko: "韩文",
  latin: "拉丁文",
};
const formatNumber = (value: number) => value.toLocaleString("zh-CN");

function fontMetadata(fields: Record<string, unknown>) {
  return extractedVideoMetadataSchema.parse(fields);
}

describe("font inspector rows", () => {
  it("shows the facts read from the font file", () => {
    const rows = buildFontInspectorRows(
      fontMetadata({
        fontFamily: "DejaVu Sans",
        fontSubfamily: "Book",
        fontVersion: "Version 2.37",
        fontWeightClass: 400,
        fontGlyphCount: 6253,
        fontUnitsPerEm: 2048,
        fontLanguage: "latin",
        fontLanguages: [],
        fontCoversLatin: true,
        fontManufacturer: "Bitstream",
      }),
      { scriptLabels, formatNumber },
    );
    expect(rows.map((row) => row.key)).toEqual([
      "family",
      "style",
      "version",
      "weight",
      "glyphs",
      "unitsPerEm",
      "script",
      "manufacturer",
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    expect(byKey.get("family")).toBe("DejaVu Sans");
    expect(byKey.get("style")).toBe("Book");
    expect(byKey.get("weight")).toBe("400 · Regular");
    expect(byKey.get("glyphs")).toBe("6,253");
    expect(byKey.get("script")).toBe("拉丁文");
    expect(byKey.get("manufacturer")).toBe("Bitstream");
    // 每行都要有 i18n 标签键，避免界面出现裸字段名。
    for (const row of rows) expect(row.labelKey.startsWith("inspector.")).toBe(true);
  });

  it("lists every declared CJK language instead of picking one", () => {
    // 中日韩字体常常同时声明多种语言（如 Noto Sans JP 与思源黑体同为 JIS+GB2312），
    // 只写一种就是编造。
    const rows = buildFontInspectorRows(
      fontMetadata({
        fontFamily: "Noto Sans JP",
        fontLanguages: ["ja", "zh-Hans"],
        fontLanguage: "ja",
        fontCoversLatin: true,
      }),
      { scriptLabels, formatNumber },
    );
    expect(rows.find((row) => row.key === "script")?.value).toBe("日文、简体中文、拉丁文");
  });

  it("omits the script row when nothing is known", () => {
    const rows = buildFontInspectorRows(
      fontMetadata({ fontFamily: "Mystery", fontLanguages: [], fontCoversLatin: false }),
      { scriptLabels, formatNumber },
    );
    expect(rows.map((row) => row.key)).toEqual(["family"]);
    expect(buildFontInspectorRows(null, { scriptLabels, formatNumber })).toEqual([]);
  });

  it("falls back to the OS/2 flags when the subfamily is silent", () => {
    expect(formatFontStyle(null, true, true)).toBe("Bold · Italic");
    expect(formatFontStyle("Bold Italic", true, true)).toBe("Bold Italic");
    expect(formatFontStyle(null, false, false)).toBeNull();
    expect(formatFontWeight(700)).toBe("700 · Bold");
    expect(formatFontWeight(550)).toBe("550");
    expect(formatFontWeight(null)).toBeNull();
    expect(formatFontWeight(Number.NaN)).toBeNull();
  });
});
