import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmbeddingApiFormatControl } from "../../src/renderer/EmbeddingApiFormatControl";
import { LocaleProvider } from "../../src/renderer/i18n";

describe("embedding API format choices", () => {
  it.each(["zh-CN", "en"] as const)("shows all three names and descriptions in %s", (locale) => {
    const html = renderToStaticMarkup(
      <LocaleProvider initialPreference={locale}>
        <EmbeddingApiFormatControl adapter="llamacpp-multimodal-v1" onChange={() => undefined} />
      </LocaleProvider>,
    );
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html.match(/class="ai-config-hint"/g)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain(locale === "zh-CN" ? "OpenAI 兼容" : "OpenAI compatible");
    expect(html).toContain(locale === "zh-CN" ? "llama.cpp 多模态" : "llama.cpp multimodal");
    expect(html).toContain(locale === "zh-CN" ? "DashScope 多模态" : "DashScope multimodal");
    expect(html).not.toContain("settings.semanticSearch.");
    expect(html).toContain("embedding-api-hint-llamacpp-multimodal-v1");
  });
});
