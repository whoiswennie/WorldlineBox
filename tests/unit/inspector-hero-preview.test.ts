import { describe, expect, it } from "vitest";

import { inspectorHeroPreviewKind } from "../../src/renderer/inspector-hero-preview";

describe("inspectorHeroPreviewKind", () => {
  it("uses the multi-select stack when more than one asset is selected", () => {
    expect(
      inspectorHeroPreviewKind({
        selectionCount: 3,
        sequenceFrameCount: 30,
      }),
    ).toBe("multi-stack");
  });

  it("plays a single selected sequence instead of the multi-select stack", () => {
    expect(
      inspectorHeroPreviewKind({
        selectionCount: 1,
        sequenceFrameCount: 151,
      }),
    ).toBe("sequence-playback");
    expect(
      inspectorHeroPreviewKind({
        selectionCount: 1,
        sequenceFrameCount: 2,
      }),
    ).toBe("sequence-playback");
  });

  it("falls back to a still preview for ordinary single assets", () => {
    expect(
      inspectorHeroPreviewKind({
        selectionCount: 1,
        sequenceFrameCount: 1,
      }),
    ).toBe("single");
    expect(
      inspectorHeroPreviewKind({
        selectionCount: 1,
        sequenceFrameCount: null,
      }),
    ).toBe("single");
  });
});
