import { describe, expect, it } from "vitest";

import {
  assetsRemainingAfterMembership,
  browseAssetsLeavingFilters,
  type BrowseDimensionAsset,
  type BrowseMembershipChange,
} from "../../src/renderer/browse-filter-membership";
import type { FilterClause } from "../../src/shared/asset-types";

const favoriteOnly: FilterClause = { field: "favorite", values: [], exclude: false };
const notFavorite: FilterClause = { field: "favorite", values: [], exclude: true };

function rating(values: string[], options?: { exclude?: boolean; includeAi?: boolean }): FilterClause {
  return {
    field: "rating",
    values,
    exclude: options?.exclude ?? false,
    includeAi: options?.includeAi,
  };
}

function tag(values: string[], options?: { exclude?: boolean; includeAi?: boolean }): FilterClause {
  return {
    field: "tag",
    values,
    exclude: options?.exclude ?? false,
    includeAi: options?.includeAi,
  };
}

function image(assetId: string, width: number | null, height: number | null): BrowseDimensionAsset {
  return { assetId, width, height, mediaType: "image" };
}

describe("browseAssetsLeavingFilters", () => {
  it("drops an asset that leaves the favorite filter and keeps one that still matches", () => {
    const removed: BrowseMembershipChange = {
      kind: "favorite",
      assetIds: ["a"],
      favorite: false,
    };
    expect(browseAssetsLeavingFilters([favoriteOnly], removed)).toEqual({
      reload: false,
      dropAssetIds: ["a"],
    });
    expect(browseAssetsLeavingFilters([notFavorite], removed)).toEqual({
      reload: false,
      dropAssetIds: [],
    });
    expect(browseAssetsLeavingFilters([notFavorite], {
      kind: "favorite",
      assetIds: ["a", "b"],
      favorite: true,
    })).toEqual({ reload: false, dropAssetIds: ["a", "b"] });
    expect(browseAssetsLeavingFilters([], removed)).toEqual({
      reload: false,
      dropAssetIds: [],
    });
  });

  it("drops a rating that leaves the selected stars, and reloads when zero falls back to AI", () => {
    expect(browseAssetsLeavingFilters([rating(["5"])], {
      kind: "rating",
      assetIds: ["a"],
      rating: 3,
    })).toEqual({ reload: false, dropAssetIds: ["a"] });
    expect(browseAssetsLeavingFilters([rating(["5"], { exclude: true })], {
      kind: "rating",
      assetIds: ["a"],
      rating: 3,
    })).toEqual({ reload: false, dropAssetIds: [] });
    expect(browseAssetsLeavingFilters([rating(["5"])], {
      kind: "rating",
      assetIds: ["a"],
      rating: 0,
    })).toEqual({ reload: true, dropAssetIds: [] });
    expect(browseAssetsLeavingFilters([rating(["5"], { includeAi: false })], {
      kind: "rating",
      assetIds: ["a"],
      rating: 0,
    })).toEqual({ reload: false, dropAssetIds: ["a"] });
  });

  it("drops a removed tag when that tag is the whole human filter", () => {
    expect(browseAssetsLeavingFilters([tag(["Leaf"], { includeAi: false })], {
      kind: "tags",
      assetIds: ["a"],
      addedTagNames: [],
      removedTagNames: ["leaf"],
    })).toEqual({ reload: false, dropAssetIds: ["a"] });
    expect(browseAssetsLeavingFilters([tag(["Leaf", "Flower"], { includeAi: false })], {
      kind: "tags",
      assetIds: ["a"],
      addedTagNames: [],
      removedTagNames: ["Leaf"],
    })).toEqual({ reload: true, dropAssetIds: [] });
    expect(browseAssetsLeavingFilters([tag(["Leaf"])], {
      kind: "tags",
      assetIds: ["a"],
      addedTagNames: [],
      removedTagNames: ["Leaf"],
    })).toEqual({ reload: true, dropAssetIds: [] });
    expect(browseAssetsLeavingFilters([tag(["Leaf"], { exclude: true })], {
      kind: "tags",
      assetIds: ["a"],
      addedTagNames: ["leaf"],
      removedTagNames: [],
    })).toEqual({ reload: false, dropAssetIds: ["a"] });
  });

  it("drops a cleared source link and a measured size that misses the range", () => {
    expect(browseAssetsLeavingFilters(
      [{ field: "source_url", values: [], exclude: false }],
      { kind: "source-url", assetIds: ["a"], hasSourceUrl: false },
    )).toEqual({ reload: false, dropAssetIds: ["a"] });
    expect(browseAssetsLeavingFilters(
      [{ field: "width", ranges: [{ min: 100, max: 200 }], exclude: false }],
      { kind: "dimensions", assets: [image("small", 40, 40), image("fit", 150, 150)] },
    )).toEqual({ reload: false, dropAssetIds: ["small"] });
    expect(browseAssetsLeavingFilters(
      [{ field: "long_edge", ranges: [{ min: 3000 }], exclude: false }],
      {
        kind: "dimensions",
        assets: [
          image("wide", 3200, 100),
          { assetId: "model", width: 4000, height: 4000, mediaType: "model" },
        ],
      },
    )).toEqual({ reload: false, dropAssetIds: ["model"] });
  });

  it("keeps an unrelated field change inside another filter", () => {
    expect(browseAssetsLeavingFilters([tag(["Leaf"])], {
      kind: "favorite",
      assetIds: ["a"],
      favorite: false,
    })).toEqual({ reload: false, dropAssetIds: [] });
  });
});

describe("assetsRemainingAfterMembership", () => {
  const visible = [
    { assetId: "kept", favorite: true },
    { assetId: "leaving", favorite: true },
  ];

  it("removes the unfavorited asset from a favorites-only list and keeps the rest", () => {
    expect(assetsRemainingAfterMembership(visible, [favoriteOnly], {
      kind: "favorite",
      assetIds: ["leaving"],
      favorite: false,
    })).toEqual({
      assets: [{ assetId: "kept", favorite: true }],
      reload: false,
    });
  });

  it("keeps the asset when the favorite filter is off", () => {
    expect(assetsRemainingAfterMembership(visible, [], {
      kind: "favorite",
      assetIds: ["leaving"],
      favorite: false,
    })).toEqual({ assets: visible, reload: false });
  });

  it("keeps the asset when it is removed from the not-favorite filter", () => {
    expect(assetsRemainingAfterMembership(visible, [notFavorite], {
      kind: "favorite",
      assetIds: ["leaving"],
      favorite: false,
    })).toEqual({ assets: visible, reload: false });
  });

  it("asks for a reload when the saved filter cannot be read", () => {
    expect(assetsRemainingAfterMembership(visible, null, {
      kind: "favorite",
      assetIds: ["leaving"],
      favorite: false,
    })).toEqual({ assets: visible, reload: true });
  });
});
