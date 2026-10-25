import { describe, expect, it } from "vitest";

import { placeOverlayInViewport, type OverlayAnchor } from "../../src/renderer/place-overlay";

const viewport = { width: 800, height: 600 };

function anchor(box: Partial<OverlayAnchor> & Pick<OverlayAnchor, "left" | "top" | "width" | "height">): OverlayAnchor {
  return {
    right: box.left + box.width,
    bottom: box.top + box.height,
    ...box,
  };
}

describe("placeOverlayInViewport", () => {
  it("opens below the anchor when the overlay fits", () => {
    const placed = placeOverlayInViewport({
      anchor: anchor({ left: 100, top: 40, width: 40, height: 24 }),
      size: { width: 120, height: 32 },
      viewport,
    });
    expect(placed.side).toBe("below");
    expect(placed.top).toBe(70);
    expect(placed.left).toBe(100);
  });

  it("opens above a control that sits on the bottom edge", () => {
    const placed = placeOverlayInViewport({
      anchor: anchor({ left: 640, top: 560, width: 28, height: 28 }),
      size: { width: 96, height: 28 },
      viewport,
      align: "center",
    });
    expect(placed.side).toBe("above");
    expect(placed.top).toBe(526);
    expect(placed.top + 28).toBeLessThanOrEqual(600 - 8);
    expect(placed.left + 96).toBeLessThanOrEqual(800 - 8);
  });

  it("shifts a centered overlay inward when the anchor is at the right edge", () => {
    const placed = placeOverlayInViewport({
      anchor: anchor({ left: 760, top: 40, width: 28, height: 24 }),
      size: { width: 160, height: 24 },
      viewport,
      align: "center",
    });
    expect(placed.left).toBe(800 - 8 - 160);
    expect(placed.side).toBe("below");
  });

  it("keeps a tall menu inside the window by using the side with more room", () => {
    const placed = placeOverlayInViewport({
      anchor: anchor({ left: 20, top: 520, width: 80, height: 28 }),
      size: { width: 180, height: 480 },
      viewport,
    });
    expect(placed.side).toBe("above");
    expect(placed.top).toBe(34);
    expect(placed.top + 480).toBeLessThanOrEqual(600 - 8);
  });
});
