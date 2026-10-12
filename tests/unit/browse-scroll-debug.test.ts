import { describe, expect, it } from "vitest";

import {
  canvasHasPreviewScrollHold,
  shouldApplyRestoredFocusScroll,
} from "../../src/renderer/browse-scroll-debug";

describe("canvasHasPreviewScrollHold", () => {
  it("treats the explicit hold flag and viewing/restoring classes as a hold", () => {
    expect(
      canvasHasPreviewScrollHold({
        dataset: { previewScrollHold: "1" },
        classList: { contains: () => false },
      }),
    ).toBe(true);
    expect(
      canvasHasPreviewScrollHold({
        dataset: {},
        classList: { contains: (name) => name === "is-restoring" },
      }),
    ).toBe(true);
    expect(
      canvasHasPreviewScrollHold({
        dataset: {},
        classList: { contains: () => false },
      }),
    ).toBe(false);
  });
});

describe("shouldApplyRestoredFocusScroll", () => {
  it("rejects a jump from a deep restore to the top of the canvas", () => {
    expect(shouldApplyRestoredFocusScroll(2400, 0, 800)).toBe(false);
  });

  it("keeps a small correction that stays in the restored viewport", () => {
    expect(shouldApplyRestoredFocusScroll(2400, 2480, 800)).toBe(true);
  });
});
