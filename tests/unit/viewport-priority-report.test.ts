import { describe, expect, it } from "vitest";

import {
  collectIntersectingCanvasAssetIds,
  composeBrowseViewportPriorityBands,
  orderedIdsForViewportPriorityReport,
  type ViewportPriorityCanvas,
} from "../../src/renderer/viewport-priority-report";

function fakeSlot(input: {
  assetId?: string;
  layoutId?: string;
  top: number;
  bottom: number;
}): HTMLElement {
  return {
    dataset: {
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
      ...(input.layoutId === undefined ? {} : { layoutAssetId: input.layoutId }),
    },
    getBoundingClientRect: () => ({
      top: input.top,
      bottom: input.bottom,
      left: 0,
      right: 10,
      width: 10,
      height: input.bottom - input.top,
      x: 0,
      y: input.top,
      toJSON: () => ({}),
    }),
  } as HTMLElement;
}

describe("collectIntersectingCanvasAssetIds", () => {
  it("keeps intersecting cards in encounter order and skips overscan and placeholders", () => {
    const canvas = {
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 100,
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      querySelectorAll: () => [
        fakeSlot({ assetId: "visible-1", top: 10, bottom: 40 }),
        fakeSlot({ layoutId: "visible-2", top: 40, bottom: 80 }),
        fakeSlot({ assetId: "below-fold", top: 120, bottom: 160 }),
        fakeSlot({ assetId: "__geometry__:3", top: 20, bottom: 50 }),
        fakeSlot({ assetId: "visible-1", top: 10, bottom: 40 }),
      ],
    } as unknown as ViewportPriorityCanvas;
    expect(collectIntersectingCanvasAssetIds(canvas, (assetId) => assetId.startsWith("__geometry__:"))).toEqual([
      "visible-1",
      "visible-2",
    ]);
  });
});

describe("orderedIdsForViewportPriorityReport", () => {
  it("walks the virtual layout around the visible window", () => {
    const ordered = ["a", "b", "c", "d", "e"];
    expect(orderedIdsForViewportPriorityReport({
      visibleIds: ["c"],
      virtualLayout: {
        indexOf: (assetId) => ordered.indexOf(assetId),
        idAt: (index) => ordered[index],
        total: ordered.length,
      },
      fallbackOrderedIds: ["fallback"],
    })).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("composeBrowseViewportPriorityBands", () => {
  it("builds visible and neighbor bands from intersecting cards and scroll direction", () => {
    const bands = composeBrowseViewportPriorityBands({
      intersectingIds: ["c", "d"],
      focusedIds: ["viewer-1", undefined],
      orderedIds: ["a", "b", "c", "d", "e", "f"],
      loadedIds: ["c", "e"],
      scrollTop: 220,
      previousScrollTop: 200,
      viewportHeight: 100,
    });
    expect(bands?.visible).toEqual(["c", "d"]);
    expect(bands?.focused).toEqual(["viewer-1"]);
    expect(bands?.direction).toBe("down");
    expect(bands?.nearForward[0]).toBe("e");
  });
});
