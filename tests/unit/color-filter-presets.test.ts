import { describe, expect, it } from "vitest";

import {
  COLOR_PRESETS,
  DEFAULT_COLOR_SIMILARITY,
  colorFilterSql,
  parseColorFilterIds,
  parseColorFilterValues,
  sampleMatchesColorFilter,
} from "../../src/shared/color-filter-presets";
import { hexToHsl } from "../../src/shared/color-hsl";

describe("color-filter-presets", () => {
  it("parses known ids including black/white and drops unknown tokens", () => {
    expect(parseColorFilterIds("red, black, white, nope")).toEqual([
      "red",
      "black",
      "white",
    ]);
  });

  it("keeps custom hex tokens alongside preset ids", () => {
    expect(parseColorFilterValues("red, #00ff00, nope")).toEqual([
      "red",
      "#00FF00",
    ]);
  });

  it("does not match greyscale samples when filtering red", () => {
    expect(DEFAULT_COLOR_SIMILARITY).toBe(30);
    expect(sampleMatchesColorFilter(hexToHsl("#808080"), ["red"])).toBe(false);
    expect(sampleMatchesColorFilter(hexToHsl("#FFFFFF"), ["red"])).toBe(false);
    expect(sampleMatchesColorFilter(hexToHsl("#000000"), ["red"])).toBe(false);
    expect(sampleMatchesColorFilter(hexToHsl("#E11D48"), ["red"])).toBe(true);
    expect(
      sampleMatchesColorFilter(hexToHsl("#808080"), ["red"], { similarity: 70 }),
    ).toBe(false);
    expect(
      sampleMatchesColorFilter(hexToHsl("#FFFFFF"), ["red"], { similarity: 70 }),
    ).toBe(false);
    expect(
      sampleMatchesColorFilter(hexToHsl("#000000"), ["red"], { similarity: 70 }),
    ).toBe(false);
    expect(
      sampleMatchesColorFilter(hexToHsl("#E11D48"), ["red"], { similarity: 70 }),
    ).toBe(true);
  });

  it("matches black/white by lightness and low saturation, not hue", () => {
    expect(sampleMatchesColorFilter(hexToHsl("#111111"), ["black"])).toBe(true);
    expect(sampleMatchesColorFilter(hexToHsl("#F4F4F5"), ["white"])).toBe(true);
    expect(sampleMatchesColorFilter(hexToHsl("#E11D48"), ["black"])).toBe(false);
  });

  it("builds SQL that constrains saturation for chromatic chips", () => {
    const match = colorFilterSql({
      hueColumn: "h",
      saturationColumn: "s",
      lightnessColumn: "L",
      values: ["red"],
      exclude: false,
      similarity: 70,
    });
    expect(match?.sql).toContain("s IS NOT NULL");
    expect(match?.sql).toContain("s >=");
    expect(match?.params.length).toBeGreaterThan(0);

    const grey = hexToHsl("#808080");
    expect(grey.saturation).toBeLessThan(match!.params[0]!);
  });

  it("custom hex uses the same HSL box as a swatch overlay", () => {
    const sample = hexToHsl("#22C55E");
    expect(
      sampleMatchesColorFilter(sample, ["#22C55E"], { similarity: 80 }),
    ).toBe(true);
    expect(
      sampleMatchesColorFilter(sample, ["red"], {
        similarity: 80,
        swatches: { red: "#22C55E" },
      }),
    ).toBe(true);
  });

  it("keeps a named chip for every default preset", () => {
    expect(COLOR_PRESETS.map((preset) => preset.id)).toEqual([
      "red",
      "orange",
      "yellow",
      "green",
      "cyan",
      "blue",
      "purple",
      "pink",
      "black",
      "white",
    ]);
  });
});
