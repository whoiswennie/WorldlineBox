import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { RADIUS_LEVEL_SCALE } from "../../src/renderer/radius-preferences";
import {
  CUSTOM_THEME_ISLAND_TOKENS,
  customThemeOverridesSchema,
} from "../../src/renderer/theme/custom-theme";

const css = readFileSync("src/renderer/styles.css", "utf8");

describe("a93 radius scale", () => {
  it("maps tiers to a monotonic scale with 0 = square", () => {
    expect(RADIUS_LEVEL_SCALE[0]).toBe(0);
    expect(RADIUS_LEVEL_SCALE[2]).toBe(1);
    expect(RADIUS_LEVEL_SCALE[3]).toBeGreaterThan(RADIUS_LEVEL_SCALE[2]);
  });

  it("routes hard-coded px radii through --ui-radius-scale", () => {
    const raw = (css.match(/border(-[a-z-]+)?-radius:\s*\d+(\.\d+)?px\s*;/g) ?? []).filter((d) => !/9{3,}px/.test(d));
    expect(raw).toEqual([]);
    expect(css).toContain("var(--ui-radius-scale, 1)");
  });
});

describe("a93 custom theme island tokens", () => {
  it("accepts island surface overrides", () => {
    const value = Object.fromEntries(CUSTOM_THEME_ISLAND_TOKENS.map((t) => [t, "#123456"]));
    expect(customThemeOverridesSchema.safeParse(value).success).toBe(true);
  });
});
