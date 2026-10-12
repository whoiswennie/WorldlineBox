import { describe, expect, it } from "vitest";

import {
  FONT_PREVIEW_TEXT_PREF_KEY,
  clearFontPreviewText,
  loadFontPreviewTexts,
  saveFontPreviewText,
} from "../../src/renderer/font-preview-preferences";

// WorldlineBox-485aeb：预览文字按语言持久化（浏览别的字体也沿用），可撤回。
function memoryStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(FONT_PREVIEW_TEXT_PREF_KEY, initial);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    raw: () => map.get(FONT_PREVIEW_TEXT_PREF_KEY),
  };
}

describe("font preview text preferences", () => {
  it("starts empty and stores text per language", () => {
    const storage = memoryStorage();
    expect(loadFontPreviewTexts(storage)).toEqual({});
    saveFontPreviewText("zh-Hans", "字体文字预览", storage);
    saveFontPreviewText("de", "Schrift", storage);
    // 换到别的字体（重新 load）时两种语言的文字都还在。
    expect(loadFontPreviewTexts(storage)).toEqual({
      "zh-Hans": "字体文字预览",
      de: "Schrift",
    });
  });

  it("clears one language without touching the others", () => {
    const storage = memoryStorage();
    const texts = saveFontPreviewText("ja", "フォント", storage, {});
    saveFontPreviewText("fr", "Aperçu", storage, texts);
    const cleared = clearFontPreviewText("ja", storage);
    expect(cleared).toEqual({ fr: "Aperçu" });
    expect(loadFontPreviewTexts(storage)).toEqual({ fr: "Aperçu" });
  });

  it("drops the stored key entirely when nothing is customised", () => {
    const storage = memoryStorage();
    saveFontPreviewText("en", "Custom", storage, {});
    expect(storage.raw()).toBeTruthy();
    clearFontPreviewText("en", storage);
    expect(storage.raw()).toBeUndefined();
  });

  it("trims, bounds and ignores empty or corrupted values", () => {
    const storage = memoryStorage();
    expect(saveFontPreviewText("en", "   ", storage, {})).toEqual({});
    const long = saveFontPreviewText("en", "x".repeat(500), storage, {});
    expect(long.en).toHaveLength(120);

    const broken = memoryStorage("not json");
    expect(loadFontPreviewTexts(broken)).toEqual({});
    const wrongShape = memoryStorage(JSON.stringify({ en: 42, klingon: "x" }));
    expect(loadFontPreviewTexts(wrongShape)).toEqual({});
  });
});
