import { describe, expect, it } from "vitest";

import { hexToHsv, hsvToHex, rgbToHex } from "../../src/shared/color-hsl";

describe("color-hsl", () => {
  it("round-trips hex through HSV for primaries, grey, black and white", () => {
    for (const hex of ["#E11D48", "#22C55E", "#3B82F6", "#808080", "#000000", "#FFFFFF"]) {
      const hsv = hexToHsv(hex);
      expect(hsv).not.toBeNull();
      expect(hsvToHex(hsv!)).toBe(hex);
    }
  });

  it("clamps rgb bytes when formatting hex", () => {
    expect(rgbToHex({ r: -4, g: 300, b: 16.4 })).toBe("#00FF10");
  });
});
