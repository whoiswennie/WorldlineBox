import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { APPEARANCE_ADJUST_SETTLE_MS } from "../../src/renderer/use-appearance-adjusting";
import { CUSTOM_THEME_EDITOR_FIELDS } from "../../src/renderer/theme/ThemeColorSettings";
import { CUSTOM_THEME_ISLAND_TOKENS } from "../../src/renderer/theme/custom-theme";

const css = readFileSync("src/renderer/styles.css", "utf8");
const tokens = readFileSync("src/renderer/ui/tokens.css", "utf8");
const bg = readFileSync("src/renderer/theme/background-preferences.ts", "utf8");

describe("a94 window background wiring", () => {
  it("drops the wallpaper veil when no image is shown", () => {
    expect(tokens).toMatch(/:root:not\(\[data-bg-image="on"\]\)\s*\{\s*--ui-backdrop-image: none;/);
    expect(bg).toContain("'data-bg-image'");
  });

  it("tints the veil with the window backdrop (not the Inputs surface) in islands", () => {
    expect(css).toMatch(/:root\[data-bg-image="on"\] \.app-shell\[data-shell-layout="islands"\] \{[^}]*var\(--island-backdrop\)/);
  });

  it("pins the selection wash and card preview when the card color is overridden", () => {
    expect(CUSTOM_THEME_ISLAND_TOKENS).toContain("--ui-island-select");
    expect(css).toContain("--island-select: var(--ui-island-select);");
    expect(css).toMatch(/\.asset-card \.asset-preview:is\(\*, #a93-island\)/);
  });

  it("keeps twelve editor fields with accent-soft as the selection wash", () => {
    expect(CUSTOM_THEME_EDITOR_FIELDS).toHaveLength(12);
    expect(CUSTOM_THEME_EDITOR_FIELDS.map((f) => f.token)).toContain("--ui-island-select");
  });
});

describe("a94 backdrop timing", () => {
  it("doubles fade-out, hold and fade-in", () => {
    expect(APPEARANCE_ADJUST_SETTLE_MS).toBe(1200);
    expect(css).toMatch(/\.dialog-backdrop\.app-settings-backdrop \{\s*transition:\s*background-color 1200ms/);
  });
});
