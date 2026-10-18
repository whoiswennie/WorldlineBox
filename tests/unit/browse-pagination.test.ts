import { describe, expect, it, vi } from "vitest";

import type { AssetSummary } from "../../src/shared/asset-types";
import type { WorldlineBoxLibraryApi } from "../../src/shared/library-api";
import { nextUnfilledBrowsePageOffset } from "../../src/renderer/browse-window-slots";
import {
  fetchBrowseScopeAssetIdsGuarded,
  fetchBrowseScopeIds,
  fetchBrowseLayout,
  fetchFirstRankedBrowsePage,
  fetchRankedBrowsePage,
  browsePageFilledOffsets,
  browsePageSize,
  isDiscardedBrowseWindowPage,
  isIgnorableBrowseWindowFailure,
  isBrowseRootNearTail,
  isBrowseSessionPageUnusable,
  browseWindowQueryMode,
  registerBrowseSearchPage,
  registerBrowseSmartCollectionPage,
  shouldRunBrowseSentinel,
  type BrowsePageDefinition,
} from "../../src/renderer/use-browse-pagination";

function asset(assetId: string): AssetSummary {
  return {
    assetId,
    locationKind: "managed",
    managedFolderId: null,
    relativeFilePath: `${assetId}.png`,
    displayName: `${assetId}.png`,
    currentRevisionId: `${assetId}-rev`,
    byteSize: 1,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    availability: "available",
    rating: 0,
    favorite: false,
    deletedAt: null,
    trashedFromPath: null,
    trashedFromTombstoneId: null,
    remainingDays: null,
    thumbnailStatus: null,
    thumbnailArtifactId: null,
    mediaType: "image",
    width: 1,
    height: 1,
    durationMs: null,
  };
}

const searchDefinition: BrowsePageDefinition = {
  kind: "search",
  libraryId: "lib-1",
  query: null,
  filters: null,
  scope: null,
  sort: null,
  showIgnored: false,
  target: "assets",
};

const smartDefinition: BrowsePageDefinition = {
  kind: "smart-collection",
  libraryId: "lib-1",
  collectionId: "sc-1",
  target: "assets",
};

const rankedDefinition: BrowsePageDefinition = {
  ...searchDefinition,
  rankedAssetIds: ["rank-1", "rank-2", "rank-3", "rank-4"],
};

describe("fetchBrowseScopeIds (WorldlineBox-ws4k select-all id set)", () => {
  it("uses the complete semantic ranking snapshot for scope selection", async () => {
    const searchAssets = vi.fn();
    const api = { searchAssets } as unknown as WorldlineBoxLibraryApi;
    expect(await fetchBrowseScopeIds({ api, definition: rankedDefinition })).toEqual([
      "rank-1",
      "rank-2",
      "rank-3",
      "rank-4",
    ]);
    expect(searchAssets).not.toHaveBeenCalled();
  });

  it("fetches idsOnly via searchAssets for search definitions", async () => {
    const searchAssets = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], total: 2, offset: 0, assetIds: ["a", "b"] },
    }));
    const api = {
      searchAssets,
      executeSmartCollection: vi.fn(),
    } as unknown as WorldlineBoxLibraryApi;

    expect(await fetchBrowseScopeIds({ api, definition: searchDefinition })).toEqual([
      "a",
      "b",
    ]);
    expect(searchAssets).toHaveBeenCalledWith(
      expect.objectContaining({ libraryId: "lib-1", idsOnly: true }),
    );
  });

  it("fetches idsOnly via executeSmartCollection for smart definitions", async () => {
    const executeSmartCollection = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], total: 1, offset: 0, assetIds: ["s1"] },
    }));
    const api = {
      searchAssets: vi.fn(),
      executeSmartCollection,
    } as unknown as WorldlineBoxLibraryApi;

    expect(await fetchBrowseScopeIds({ api, definition: smartDefinition })).toEqual([
      "s1",
    ]);
    expect(executeSmartCollection).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: "sc-1", idsOnly: true }),
    );
  });

  it("returns null when the ids fetch fails", async () => {
    const api = {
      searchAssets: vi.fn(async () => ({
        ok: false as const,
        error: { code: "FOLDER_NOT_FOUND", message: "gone" },
      })),
      executeSmartCollection: vi.fn(),
    } as unknown as WorldlineBoxLibraryApi;

    expect(await fetchBrowseScopeIds({ api, definition: searchDefinition })).toBeNull();
  });
});

describe("fetchBrowseLayout (WorldlineBox-sa65 compact geometry index)", () => {
  it("does not replace semantic order with an ordinary search layout", async () => {
    const searchAssets = vi.fn();
    const api = { searchAssets } as unknown as WorldlineBoxLibraryApi;
    expect(await fetchBrowseLayout({ api, definition: rankedDefinition })).toBeNull();
    expect(searchAssets).not.toHaveBeenCalled();
  });

  it("requests layoutOnly without materializing AssetSummary rows", async () => {
    const layout = [{ assetId: "a", width: 1600, height: 900 }];
    const searchAssets = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], total: 1, offset: 0, layout },
    }));
    const api = {
      searchAssets,
      executeSmartCollection: vi.fn(),
    } as unknown as WorldlineBoxLibraryApi;

    expect(await fetchBrowseLayout({ api, definition: searchDefinition })).toEqual(layout);
    expect(searchAssets).toHaveBeenCalledWith(
      expect.objectContaining({ libraryId: "lib-1", layoutOnly: true }),
    );
  });

  it("keeps the current layout when a response omits the layout field", async () => {
    const searchAssets = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], total: 1, offset: 0 },
    }));
    const api = {
      searchAssets,
      executeSmartCollection: vi.fn(),
    } as unknown as WorldlineBoxLibraryApi;

    expect(await fetchBrowseLayout({ api, definition: searchDefinition })).toBeNull();
  });
});

describe("fetchRankedBrowsePage (semantic result stream)", () => {
  it("uses smaller batches only for ranked semantic sources", () => {
    expect(browsePageSize(rankedDefinition)).toBe(50);
    expect(browsePageSize({ ...rankedDefinition, rankedPageSize: 25 })).toBe(25);
    expect(browsePageSize({ ...rankedDefinition, rankedPageSize: 100 })).toBe(100);
    expect(browsePageSize(searchDefinition)).toBe(100);
  });

  it("loads only the requested summary batch and restores model rank order", async () => {
    const listAssets = vi.fn(async () => ({
      ok: true as const,
      value: [asset("rank-3"), asset("rank-2")],
    }));
    const api = { listAssets } as unknown as WorldlineBoxLibraryApi;
    const result = await fetchRankedBrowsePage({
      api,
      definition: rankedDefinition,
      offset: 1,
      limit: 2,
    });
    expect(listAssets).toHaveBeenCalledWith({
      libraryId: "lib-1",
      recursive: true,
      assetIds: ["rank-2", "rank-3"],
    });
    expect(result).toEqual({
      ok: true,
      value: { items: [asset("rank-2"), asset("rank-3")], total: 4, offset: 1 },
    });
  });

  it("consumes an empty or partial ranked ID slice so scrolling can advance", () => {
    const definition = {
      ...rankedDefinition,
      rankedAssetIds: Array.from({ length: 75 }, (_, index) => `rank-${index}`),
    };
    expect(browsePageFilledOffsets({
      definition,
      offset: 50,
      limit: 25,
      itemCount: 0,
      pageSize: 50,
    })).toEqual([50]);
    const filledAfterEmptyPage = new Set([0, ...browsePageFilledOffsets({
      definition,
      offset: 50,
      limit: 50,
      itemCount: 0,
      pageSize: 50,
    })]);
    expect(nextUnfilledBrowsePageOffset(filledAfterEmptyPage, 125, 50)).toBe(100);
    expect(browsePageFilledOffsets({
      definition,
      offset: 50,
      limit: 25,
      itemCount: 4,
      pageSize: 50,
    })).toEqual([50]);
    expect(browsePageFilledOffsets({
      definition,
      offset: 75,
      limit: 25,
      itemCount: 0,
      pageSize: 50,
    })).toEqual([]);
    expect(browsePageFilledOffsets({
      definition: searchDefinition,
      offset: 50,
      limit: 50,
      itemCount: 0,
      pageSize: 100,
    })).toEqual([]);
  });

  it("skips an entirely stale first batch but keeps the next batch rank order", async () => {
    const listAssets = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: [] })
      .mockResolvedValueOnce({ ok: true as const, value: [asset("rank-51"), asset("rank-50")] });
    const api = { listAssets } as unknown as WorldlineBoxLibraryApi;
    const rankedAssetIds = Array.from({ length: 75 }, (_, index) => `rank-${index}`);
    const result = await fetchFirstRankedBrowsePage({
      api,
      libraryId: "lib-1",
      rankedAssetIds,
      pageSize: 50,
    });

    expect(listAssets.mock.calls.map(([input]) => input.assetIds)).toEqual([
      rankedAssetIds.slice(0, 50),
      rankedAssetIds.slice(50),
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        items: [asset("rank-50"), asset("rank-51")],
        rankedAssetIds: rankedAssetIds.slice(50),
      },
    });
  });

  it("returns an exhausted empty snapshot when all ranked summaries are stale", async () => {
    const listAssets = vi.fn(async () => ({ ok: true as const, value: [] }));
    const rankedAssetIds = Array.from({ length: 27 }, (_, index) => `rank-${index}`);
    const result = await fetchFirstRankedBrowsePage({
      api: { listAssets } as unknown as WorldlineBoxLibraryApi,
      libraryId: "lib-1",
      rankedAssetIds,
      pageSize: 25,
    });
    expect(result).toEqual({ ok: true, value: { items: [], rankedAssetIds: [] } });
    expect(listAssets).toHaveBeenCalledTimes(2);
  });

  it("returns null for ordinary browse definitions", async () => {
    const listAssets = vi.fn();
    expect(await fetchRankedBrowsePage({
      api: { listAssets } as unknown as WorldlineBoxLibraryApi,
      definition: searchDefinition,
      offset: 0,
      limit: 30,
    })).toBeNull();
    expect(listAssets).not.toHaveBeenCalled();
  });
});

describe("browse tail sentinel (WorldlineBox-performance)", () => {
  it("waits for compact layout hydration before starting a tail query", () => {
    expect(
      shouldRunBrowseSentinel({ layoutHydrationComplete: false, total: 20_000 }),
    ).toBe(false);
    expect(
      shouldRunBrowseSentinel({ layoutHydrationComplete: true, total: 20_000 }),
    ).toBe(true);
  });

  it("does not observe an empty scope even after hydration", () => {
    expect(
      shouldRunBrowseSentinel({ layoutHydrationComplete: true, total: 0 }),
    ).toBe(false);
  });

  it("requires the scrollport to be near its actual tail", () => {
    expect(
      isBrowseRootNearTail({ scrollTop: 0, clientHeight: 1_000, scrollHeight: 20_000 }),
    ).toBe(false);
    expect(
      isBrowseRootNearTail({ scrollTop: 18_200, clientHeight: 1_000, scrollHeight: 20_000 }),
    ).toBe(true);
  });
});

describe("fetchBrowseScopeAssetIdsGuarded (WorldlineBox-ws4k select-all race)", () => {
  it("discards the id set when the generation changes during await", async () => {
    let generation = 1;
    const fetch = vi.fn(async () => ["stale-a", "stale-b"]);
    const pending = fetchBrowseScopeAssetIdsGuarded({
      api: {} as WorldlineBoxLibraryApi,
      definition: searchDefinition,
      currentGeneration: () => generation,
      fetch,
    });
    // The user switched folder/scope while the ids query was in flight.
    generation = 2;
    expect(await pending).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the id set when the generation is unchanged", async () => {
    const fetch = vi.fn(async () => ["a", "b"]);
    expect(
      await fetchBrowseScopeAssetIdsGuarded({
        api: {} as WorldlineBoxLibraryApi,
        definition: searchDefinition,
        currentGeneration: () => 1,
        fetch,
      }),
    ).toEqual(["a", "b"]);
  });

  it("returns null without a definition or api and never fetches", async () => {
    const fetch = vi.fn(async () => ["a"]);
    expect(
      await fetchBrowseScopeAssetIdsGuarded({
        api: null,
        definition: searchDefinition,
        currentGeneration: () => 1,
        fetch,
      }),
    ).toBeNull();
    expect(
      await fetchBrowseScopeAssetIdsGuarded({
        api: {} as WorldlineBoxLibraryApi,
        definition: null,
        currentGeneration: () => 1,
        fetch,
      }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("registerBrowseSearchPage / registerBrowseSmartCollectionPage (WorldlineBox-ws4k)", () => {
  it("registers the semantic ID snapshot as the page source", () => {
    const beginPage = vi.fn();
    registerBrowseSearchPage(beginPage, {
      libraryId: "lib-1",
      query: null,
      showIgnored: false,
      rankedAssetIds: ["rank-1", "rank-2"],
      rankedPageSize: 25,
      items: [asset("rank-1")],
      total: 2,
      offset: 0,
    });
    expect(beginPage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "search",
        rankedAssetIds: ["rank-1", "rank-2"],
        rankedPageSize: 25,
      }),
      expect.objectContaining({ items: [asset("rank-1")], total: 2, offset: 0 }),
    );
  });

  it("registers a search page definition + first page through beginPage", () => {
    const beginPage = vi.fn();
    registerBrowseSearchPage(beginPage, {
      libraryId: "lib-1",
      query: null,
      filters: null,
      scope: null,
      sort: null,
      showIgnored: true,
      target: "trash",
      items: [asset("a")],
      total: 1,
      offset: 0,
    });
    expect(beginPage).toHaveBeenCalledWith(
      {
        kind: "search",
        libraryId: "lib-1",
        query: null,
        filters: null,
        scope: null,
        sort: null,
        showIgnored: true,
        target: "trash",
      },
      { items: [asset("a")], total: 1, offset: 0 },
    );
  });

  it("defaults search registration to the assets target and normalizes undefined fields", () => {
    const beginPage = vi.fn();
    registerBrowseSearchPage(beginPage, {
      libraryId: "lib-1",
      query: null,
      filters: undefined,
      scope: undefined,
      sort: undefined,
      showIgnored: false,
      items: [],
      total: 0,
      offset: 0,
    });
    expect(beginPage).toHaveBeenCalledWith(
      {
        kind: "search",
        libraryId: "lib-1",
        query: null,
        filters: null,
        scope: null,
        sort: null,
        showIgnored: false,
        target: "assets",
      },
      { items: [], total: 0, offset: 0 },
    );
  });

  it("registers a smart-collection page definition + first page through beginPage", () => {
    const beginPage = vi.fn();
    registerBrowseSmartCollectionPage(beginPage, {
      libraryId: "lib-1",
      collectionId: "sc-1",
      items: [asset("s1")],
      total: 1,
      offset: 0,
    });
    expect(beginPage).toHaveBeenCalledWith(
      {
        kind: "smart-collection",
        libraryId: "lib-1",
        collectionId: "sc-1",
        target: "assets",
      },
      { items: [asset("s1")], total: 1, offset: 0 },
    );
  });
});

describe("discarded browse-window pages (WorldlineBox-87pd)", () => {
  it("ignores an empty total-0 response that would otherwise shrink a known scope", () => {
    expect(
      isDiscardedBrowseWindowPage({ items: [], total: 0 }, 500, 7000),
    ).toBe(true);
    expect(
      isDiscardedBrowseWindowPage({ items: [], total: 0 }, 0, 7000),
    ).toBe(true);
    expect(
      isDiscardedBrowseWindowPage({ items: [], total: 0 }, 0, 0),
    ).toBe(false);
    expect(
      isDiscardedBrowseWindowPage({ items: [asset("a")], total: 0 }, 100, 7000),
    ).toBe(false);
  });

  it("does not treat a cancelled window as a load-more failure", () => {
    expect(isIgnorableBrowseWindowFailure("CANCELLED")).toBe(true);
    expect(isIgnorableBrowseWindowFailure("FOLDER_NOT_FOUND")).toBe(false);
  });
});

describe("stale BrowseSession windows (All Assets 100-item freeze)", () => {
  it("keeps later pages on the live query after the snapshot is unusable", () => {
    expect(browseWindowQueryMode({ sessionId: "session-1" })).toBe("session");
    expect(browseWindowQueryMode({ sessionId: "session-1", sessionUnusable: true })).toBe("live");
    expect(browseWindowQueryMode({})).toBe("live");
  });

  it("treats a browse.session.stale payload as unusable rather than end-of-list", () => {
    expect(isBrowseSessionPageUnusable({
      ok: true,
      value: { stale: true },
    })).toBe(true);
    expect(isBrowseSessionPageUnusable({
      ok: true,
      value: { items: [], total: 250, offset: 100 },
    })).toBe(false);
    expect(isBrowseSessionPageUnusable({ ok: false })).toBe(false);
  });
});
