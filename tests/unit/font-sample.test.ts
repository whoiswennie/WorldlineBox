import { describe, expect, it } from "vitest";

import {
  createFontSamplePage,
  fontSampleCoverText,
  resolveFontSampleRequest,
} from "../../src/main/font-sample-page";
import type { FontLanguage } from "../../src/shared/font-metadata";

// WorldlineBox-485aeb：字体卡片封面样张页。
describe("font sample page", () => {
  const fontUrl = "worldlinebox://source/lib-1/asset-1?revision=rev-1";

  it("embeds the font with the same-origin source URL", () => {
    const html = createFontSamplePage({ fontUrl, family: "DejaVu Sans", language: "latin" });
    expect(html).toContain('src: url("worldlinebox://source/lib-1/asset-1?revision=rev-1")');
    expect(html).toContain('font-family: "WorldlineBoxFontSample"');
    // 封面主文字字号调大过（用户反馈第 6 条：主文字再大一点点）。
    expect(html).toContain("font-size: 76px");
    expect(html).toContain("font-size: 34px");
  });

  it("uses the label of the language the font declares and always the Latin sample", () => {
    // 封面第一行 = 语言标签 + AaBbCc 0123：换语言只换标签词，样例字符固定为
    // 拉丁字母与数字（每个字体都有）。
    const expected: Array<[string, string]> = [
      ["ja", "フォントプレビュー AaBbCc 0123"],
      ["zh-Hans", "字体预览 AaBbCc 0123"],
      ["zh-Hant", "字型預覽 AaBbCc 0123"],
      ["ko", "폰트 미리보기 AaBbCc 0123"],
      ["latin", "Font Preview AaBbCc 0123"],
    ];
    for (const [language, primary] of expected) {
      const cover = fontSampleCoverText({
        family: "Fixture",
        language: language as FontLanguage,
      });
      expect(cover.primary).toBe(primary);
      expect(cover.secondary).toBe("Fixture · WorldlineBox");
      // 样例字符固定是拉丁字母与数字；封面不出现「永字八法」那类装饰性样例。
      expect(cover.primary.endsWith("AaBbCc 0123")).toBe(true);
      for (const decorative of ["永字八法", "あいうえお", "한국어"]) {
        expect(cover.primary).not.toContain(decorative);
      }
    }
    expect(fontSampleCoverText({ family: "Arial", language: "latin" }).htmlLang).toBe("en");
    expect(fontSampleCoverText({ family: "思源黑体", language: "zh-Hans" }).htmlLang).toBe("zh-CN");
    expect(fontSampleCoverText({ family: "Noto Sans JP", language: "ja" }).htmlLang).toBe("ja");
  });

  it("uses a language-neutral cover when the language is undecided", () => {
    // 关键回归：判定不出来时**不写语言标签**，绝不贴可能错的语言。
    const cover = fontSampleCoverText({ family: "H-Unknown", language: null });
    expect(cover.primary).toBe("AaBbCc 0123");
    expect(cover.primary).not.toContain("プレビュー");
    expect(cover.primary).not.toContain("预览");
    expect(cover.primary).not.toContain("Preview");
    expect(fontSampleCoverText({ family: null, language: null })).toEqual({
      primary: "AaBbCc 0123",
      secondary: "WorldlineBox",
      htmlLang: "en",
    });
  });

  it("strips the sample-only keys from the font URL and reads the label inputs", () => {
    const request = resolveFontSampleRequest(
      new URL(
        "worldlinebox://source/lib-1/asset-1?revision=rev-1&sample=font&family=Noto%20Sans%20JP&lang=ja&script=ja",
      ),
    );
    expect(request.fontUrl).toBe("worldlinebox://source/lib-1/asset-1?revision=rev-1");
    expect(request.family).toBe("Noto Sans JP");
    expect(request.language).toBe("ja");

    // 非法/缺失 token 收敛为「中性封面」，不猜语言。
    const unknown = resolveFontSampleRequest(
      new URL(`${fontUrl}&sample=font&lang=klingon`),
    );
    expect(unknown.language).toBeNull();

    const html = createFontSamplePage({ ...request });
    expect(html).toContain('src: url("worldlinebox://source/lib-1/asset-1?revision=rev-1")');
    expect(html).toContain("フォントプレビュー AaBbCc 0123");
  });

  it("escapes the family name and the URL so the sheet cannot be injected into", () => {
    const html = createFontSamplePage({
      fontUrl: 'worldlinebox://source/lib-1/asset-1?revision="><script>',
      family: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
