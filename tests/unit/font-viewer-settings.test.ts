import { describe, expect, it } from "vitest";

import {
  FONT_PREVIEW_LANGUAGES,
  FONT_VIEWER_DEFAULT_SIZE,
  FONT_VIEWER_MAX_SIZE,
  FONT_VIEWER_MIN_SIZE,
  clampFontViewerSize,
  clampFontViewerText,
  createFontViewerSettings,
  defaultFontViewerText,
  fontViewerSpecimenSizes,
  isFontPreviewLanguage,
  nearestVariableWeight,
  previewLanguageForDeclared,
  stepFontViewerSize,
  variableWeightOptions,
} from "../../src/renderer/font-viewer-settings";

// WorldlineBox-485aeb：字体查看器的预览设置（语言 / 文字 / 字号 / 字重 / B-I-U）。
describe("font viewer settings", () => {
  it("supports the common languages with a sentence and the shared symbols", () => {
    expect(FONT_PREVIEW_LANGUAGES.length).toBeGreaterThanOrEqual(15);
    for (const language of FONT_PREVIEW_LANGUAGES) {
      const text = defaultFontViewerText(language);
      expect(text.length).toBeGreaterThan(0);
      // 每个语言都要有拉丁字母、数字与同一套符号（9 个，满足「常用符号 <= 10」）。
      expect(text).toContain("WorldlineBox");
      expect(text).toContain("0123");
      expect(text).toContain("!?.;:@&%#");
      expect(text.match(/[!?.;:@&%#]/gu) ?? []).toHaveLength(9);
      // 封面样例（AaBbCc 0123）与查看器文案不同，且不出现装饰性示例。
      expect(text).not.toBe("AaBbCc 0123");
      expect(text).not.toContain("永字八法");
    }
    // 用户点名的中文示例原文。
    expect(defaultFontViewerText("zh-Hans")).toBe("字体文字预览 WorldlineBox 0123 !?.;:@&%#");
    expect(defaultFontViewerText("zh-Hant")).toBe("字型文字預覽 WorldlineBox 0123 !?.;:@&%#");
    expect(defaultFontViewerText("ja")).toContain("フォント文字プレビュー");
    expect(defaultFontViewerText("ko")).toContain("폰트 문자 미리보기");
    expect(defaultFontViewerText("en")).toBe("AaBbCc 0123 WorldlineBox !?.;:@&%#");
    // 常见欧洲语言（用户要求支持德语/法语/西班牙语等）。
    expect(defaultFontViewerText("de")).toContain("Schrift Vorschau");
    expect(defaultFontViewerText("fr")).toContain("Aperçu de police");
    expect(defaultFontViewerText("es")).toContain("Vista previa");
    expect(defaultFontViewerText("ru")).toContain("Шрифт");
  });

  it("maps the font's declared language and falls back to English", () => {
    expect(previewLanguageForDeclared("ja")).toBe("ja");
    expect(previewLanguageForDeclared("zh-Hans")).toBe("zh-Hans");
    expect(previewLanguageForDeclared("zh-Hant")).toBe("zh-Hant");
    expect(previewLanguageForDeclared("ko")).toBe("ko");
    // 拉丁文在查看器里叫「英文」；判不出来时也用英文。
    expect(previewLanguageForDeclared("latin")).toBe("en");
    expect(previewLanguageForDeclared(null)).toBe("en");
    expect(previewLanguageForDeclared("klingon")).toBe("en");
  });

  it("only offers weights a variable font really provides", () => {
    // 静态字体（单一字重）→ 不显示字重控件。
    expect(variableWeightOptions(null)).toEqual([]);
    expect(variableWeightOptions([])).toEqual([]);
    expect(variableWeightOptions([700])).toEqual([]);
    // 可变字体 → 用 fvar 里的命名实例，去重升序。
    expect(variableWeightOptions([700, 100, 400, 700])).toEqual([100, 400, 700]);
    expect(nearestVariableWeight([100, 400, 700], 700)).toBe(700);
    expect(nearestVariableWeight([100, 400, 700], 550)).toBe(400);
    expect(nearestVariableWeight([100, 400, 700], 900)).toBe(700);
    expect(nearestVariableWeight([400], 700)).toBeNull();
    expect(nearestVariableWeight(null, 700)).toBeNull();
  });

  it("accepts only known preview languages", () => {
    expect(isFontPreviewLanguage("de")).toBe(true);
    expect(isFontPreviewLanguage("zh-Hant")).toBe(true);
    expect(isFontPreviewLanguage("latin")).toBe(false);
    expect(isFontPreviewLanguage("klingon")).toBe(false);
  });

  it("clamps size into the supported range", () => {
    expect(clampFontViewerSize(Number.NaN)).toBe(FONT_VIEWER_DEFAULT_SIZE);
    expect(clampFontViewerSize(1)).toBe(FONT_VIEWER_MIN_SIZE);
    expect(clampFontViewerSize(10_000)).toBe(FONT_VIEWER_MAX_SIZE);
    expect(clampFontViewerSize(72.4)).toBe(72);
  });

  it("steps the size from the mouse wheel and stops at the bounds", () => {
    expect(stepFontViewerSize(64, -100)).toBe(68);
    expect(stepFontViewerSize(64, 100)).toBe(60);
    expect(stepFontViewerSize(64, -1000)).toBe(84);
    expect(stepFontViewerSize(FONT_VIEWER_MAX_SIZE, -100)).toBe(FONT_VIEWER_MAX_SIZE);
    expect(stepFontViewerSize(FONT_VIEWER_MIN_SIZE, 100)).toBe(FONT_VIEWER_MIN_SIZE);
    expect(stepFontViewerSize(64, 0)).toBe(64);
  });

  it("shows at least three distinct specimen sizes", () => {
    for (const size of [FONT_VIEWER_MIN_SIZE, 40, 64, 100, FONT_VIEWER_MAX_SIZE]) {
      const sizes = fontViewerSpecimenSizes(size);
      expect(sizes).toHaveLength(3);
      expect(new Set(sizes).size).toBe(3);
      expect(sizes[0]).toBe(size);
      for (let index = 1; index < sizes.length; index += 1) {
        expect(sizes[index]!).toBeLessThan(sizes[index - 1]!);
      }
    }
  });

  it("bounds the preview text and starts from the defaults", () => {
    expect(clampFontViewerText("x".repeat(500))).toHaveLength(120);
    expect(createFontViewerSettings("de")).toEqual({
      language: "de",
      size: FONT_VIEWER_DEFAULT_SIZE,
      weight: 400,
      bold: false,
      italic: false,
      underline: false,
    });
  });
});
