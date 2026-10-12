import { describe, expect, it } from "vitest";

import {
  ViewportPriorityOverlay,
  VIEWPORT_NEAR_BACKWARD_LIMIT,
  VIEWPORT_NEAR_FORWARD_LIMIT,
  buildViewportPriorityBands,
  detectViewportScrollDirection,
  orderedIdsAroundVisible,
  rankedViewportClaimIds,
  resolveViewportClaimIds,
  claimIdsForThumbnailWave,
  shouldAbortRunningOutsideViewport,
  shouldFallbackViewportClaimToPersistentQueue,
  viewportClaimRankOrderSql,
  viewportPriorityReportKey,
} from "../../src/shared/viewport-priority";

const orderedIds = Array.from({ length: 40 }, (_, index) => `asset-${index}`);

describe("buildViewportPriorityBands", () => {
  it("keeps visible order and fills forward/back neighbors from session order", () => {
    const bands = buildViewportPriorityBands({
      orderedIds,
      visibleIds: ["asset-10", "asset-11", "asset-12"],
      direction: "down",
      focusedIds: ["asset-10", "viewer-1"],
      loadedIds: ["asset-11", "asset-30", "asset-31"],
    });
    expect(bands.visible).toEqual(["asset-10", "asset-11", "asset-12"]);
    expect(bands.focused).toEqual(["viewer-1"]);
    expect(bands.nearForward[0]).toBe("asset-13");
    expect(bands.nearForward).toHaveLength(5);
    expect(bands.nearBackward[0]).toBe("asset-9");
    expect(bands.nearBackward).toHaveLength(2);
    expect(bands.scopeWarm).toEqual(["asset-30", "asset-31"]);
    expect(rankedViewportClaimIds(bands).slice(0, 5)).toEqual([
      "viewer-1",
      "asset-10",
      "asset-11",
      "asset-12",
      "asset-13",
    ]);
  });

  it("uses the opposite side as forward when scrolling up", () => {
    const bands = buildViewportPriorityBands({
      orderedIds,
      visibleIds: ["asset-10", "asset-11"],
      direction: "up",
    });
    expect(bands.nearForward[0]).toBe("asset-9");
    expect(bands.nearBackward[0]).toBe("asset-12");
  });

  it("drops near bands on jump", () => {
    const bands = buildViewportPriorityBands({
      orderedIds,
      visibleIds: ["asset-30"],
      direction: "jump",
      loadedIds: ["asset-1", "asset-30"],
    });
    expect(bands.nearForward).toEqual([]);
    expect(bands.nearBackward).toEqual([]);
    expect(bands.scopeWarm).toEqual(["asset-1"]);
  });

  it("caps fast-scroll forward below the hard limit", () => {
    const visible = orderedIds.slice(0, 20);
    const bands = buildViewportPriorityBands({
      orderedIds,
      visibleIds: visible,
      direction: "down",
      fastScroll: true,
    });
    expect(bands.nearForward.length).toBeLessThanOrEqual(VIEWPORT_NEAR_FORWARD_LIMIT);
    expect(bands.nearBackward.length).toBeLessThanOrEqual(VIEWPORT_NEAR_BACKWARD_LIMIT);
    expect(bands.nearForward.length).toBe(20);
  });

  it("walks only a bounded window around visible indices", () => {
    const indexByAssetId = new Map(orderedIds.map((id, index) => [id, index]));
    const windowIds = orderedIdsAroundVisible({
      visibleIds: ["asset-10"],
      indexOf: (id) => indexByAssetId.get(id),
      idAt: (index) => orderedIds[index],
      total: 10_000,
      radius: 3,
    });
    expect(windowIds).toEqual([
      "asset-7",
      "asset-8",
      "asset-9",
      "asset-10",
      "asset-11",
      "asset-12",
      "asset-13",
    ]);
  });
});

describe("detectViewportScrollDirection", () => {
  it("classifies jump, down, up, and stationary", () => {
    expect(detectViewportScrollDirection({ previousTop: undefined, nextTop: 40, viewportHeight: 800 }))
      .toBe("stationary");
    expect(detectViewportScrollDirection({ previousTop: 0, nextTop: 20, viewportHeight: 800 }))
      .toBe("down");
    expect(detectViewportScrollDirection({ previousTop: 80, nextTop: 10, viewportHeight: 800 }))
      .toBe("up");
    expect(detectViewportScrollDirection({ previousTop: 0, nextTop: 2000, viewportHeight: 800 }))
      .toBe("jump");
  });
});

describe("ViewportPriorityOverlay", () => {
  it("discards stale viewport generations and old library generations", () => {
    const overlay = new ViewportPriorityOverlay();
    const base = buildViewportPriorityBands({
      orderedIds,
      visibleIds: ["asset-4"],
      direction: "jump",
    });
    expect(overlay.apply({
      ...base,
      libraryId: "lib-1",
      consumerId: "browse-a",
      libraryGeneration: 2,
      interactionGeneration: 1,
      viewportGeneration: 4,
    }).accepted).toBe(true);
    expect(overlay.apply({
      ...base,
      libraryId: "lib-1",
      consumerId: "browse-a",
      libraryGeneration: 2,
      interactionGeneration: 1,
      viewportGeneration: 3,
    })).toEqual({ accepted: false, reason: "stale-generation" });
    expect(overlay.apply({
      ...base,
      visible: ["asset-1"],
      libraryId: "lib-1",
      consumerId: "browse-a",
      libraryGeneration: 1,
      interactionGeneration: 1,
      viewportGeneration: 9,
    })).toEqual({ accepted: false, reason: "stale-library" });
    expect(overlay.rankedClaimIds("lib-1")).toEqual(["asset-4"]);
  });

  it("round-robins P1 ids across consumers instead of replacing one window with another", () => {
    const overlay = new ViewportPriorityOverlay();
    overlay.apply({
      ...buildViewportPriorityBands({
        orderedIds: ["a1", "a2", "a3"],
        visibleIds: ["a1", "a2"],
        direction: "down",
      }),
      libraryId: "lib-1",
      consumerId: "window-a",
      libraryGeneration: 1,
      interactionGeneration: 1,
      viewportGeneration: 1,
    });
    overlay.apply({
      ...buildViewportPriorityBands({
        orderedIds: ["b1", "b2", "b3"],
        visibleIds: ["b1", "b2"],
        direction: "down",
      }),
      libraryId: "lib-1",
      consumerId: "window-b",
      libraryGeneration: 1,
      interactionGeneration: 1,
      viewportGeneration: 1,
    });
    expect(overlay.rankedClaimIds("lib-1").slice(0, 4)).toEqual(["a1", "b1", "a2", "b2"]);
    overlay.clearLibrary("lib-1");
    expect(overlay.rankedClaimIds("lib-1")).toEqual([]);
  });
});

describe("shouldAbortRunningOutsideViewport", () => {
  it("does not abort for lookahead, idle reserved slots, or an unsettled viewport", () => {
    const base = {
      overlapShouldPreempt: true,
      hasIdleForegroundSlot: false,
      viewportStableMs: 150,
      nowMs: 1_000,
      p0OrP1Waiting: true,
      lookaheadOnly: false,
    };
    expect(shouldAbortRunningOutsideViewport({ ...base, lookaheadOnly: true })).toBe(false);
    expect(shouldAbortRunningOutsideViewport({ ...base, hasIdleForegroundSlot: true })).toBe(false);
    expect(shouldAbortRunningOutsideViewport({ ...base, viewportStableMs: 40 })).toBe(false);
    expect(shouldAbortRunningOutsideViewport({ ...base, lastPreemptAtMs: 800 })).toBe(false);
    expect(shouldAbortRunningOutsideViewport({ ...base, p0OrP1Waiting: false })).toBe(false);
    expect(shouldAbortRunningOutsideViewport(base)).toBe(true);
  });
});

describe("resolveViewportClaimIds", () => {
  it("keeps overlay rank and does not fall back to a later visible-only list", () => {
    expect(resolveViewportClaimIds(["near-1", "visible-1"], ["visible-1"])).toEqual([
      "near-1",
      "visible-1",
    ]);
    expect(resolveViewportClaimIds([], ["visible-1", "visible-1", "visible-2"]))
      .toEqual(["visible-1", "visible-2"]);
    expect(resolveViewportClaimIds([])).toBeUndefined();
  });
});

describe("claimIdsForThumbnailWave", () => {
  it("uses overlay rank as the first-phase claim list for every wave", () => {
    expect(claimIdsForThumbnailWave({
      viewportOnlyWave: false,
      rankedOverlayIds: ["visible-1", "near-1"],
    })).toEqual(["visible-1", "near-1"]);
    expect(claimIdsForThumbnailWave({
      viewportOnlyWave: false,
      rankedOverlayIds: [],
    })).toBeUndefined();
    expect(claimIdsForThumbnailWave({
      viewportOnlyWave: true,
      rankedOverlayIds: ["visible-1", "near-1"],
      fallbackIds: ["visible-1"],
    })).toEqual(["visible-1", "near-1"]);
  });
});

describe("shouldFallbackViewportClaimToPersistentQueue", () => {
  it("falls back only for unrestricted background pumps after a scoped IN misses", () => {
    expect(shouldFallbackViewportClaimToPersistentQueue({
      interactive: false,
      restrictedByAssetIds: false,
      scopedClaimIds: ["visible-1"],
    })).toBe(true);
    expect(shouldFallbackViewportClaimToPersistentQueue({
      interactive: false,
      restrictedByAssetIds: false,
      scopedClaimIds: [],
    })).toBe(true);
    expect(shouldFallbackViewportClaimToPersistentQueue({
      interactive: true,
      restrictedByAssetIds: false,
      scopedClaimIds: ["visible-1"],
    })).toBe(false);
    expect(shouldFallbackViewportClaimToPersistentQueue({
      interactive: false,
      restrictedByAssetIds: true,
      scopedClaimIds: ["visible-1"],
    })).toBe(false);
    expect(shouldFallbackViewportClaimToPersistentQueue({
      interactive: false,
      restrictedByAssetIds: false,
      scopedClaimIds: undefined,
    })).toBe(false);
  });
});

describe("viewportClaimRankOrderSql", () => {
  it("binds overlay order as CASE placeholders and stays empty without a claim scope", () => {
    expect(viewportClaimRankOrderSql(undefined)).toEqual({ sql: "", params: [] });
    expect(viewportClaimRankOrderSql([])).toEqual({ sql: "", params: [] });
    const ranked = viewportClaimRankOrderSql(["c", "a", "b"]);
    expect(ranked.params).toEqual(["c", "a", "b"]);
    expect(ranked.sql).toBe("CASE asset_id WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END, ");
  });
});

describe("viewportPriorityReportKey", () => {
  it("changes when neighbor bands or direction change even if visible ids match", () => {
    const visible = buildViewportPriorityBands({
      orderedIds,
      visibleIds: ["asset-10"],
      direction: "down",
    });
    const jumped = buildViewportPriorityBands({
      orderedIds,
      visibleIds: ["asset-10"],
      direction: "jump",
    });
    expect(viewportPriorityReportKey("lib-1", visible, 1))
      .not.toBe(viewportPriorityReportKey("lib-1", jumped, 1));
  });
});
