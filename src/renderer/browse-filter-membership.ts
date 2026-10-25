/**
 * Decide whether an asset that is already in the current browse result still
 * belongs there after one of its filter fields changes.
 *
 * Clauses are ANDed. A field that did not change still matches, because the
 * asset was already in the result. Only the changed field can push it out.
 * When that field also depends on AI data the summary does not carry, the
 * caller reloads instead of guessing.
 */

import type { AssetSummary, FilterClause } from "../shared/asset-types";

export type BrowseMembershipChange =
  | {
      kind: "favorite";
      assetIds: readonly string[];
      favorite: boolean;
    }
  | {
      kind: "rating";
      assetIds: readonly string[];
      rating: number;
    }
  | {
      kind: "source-url";
      assetIds: readonly string[];
      hasSourceUrl: boolean;
    }
  | {
      kind: "tags";
      assetIds: readonly string[];
      addedTagNames: readonly string[];
      removedTagNames: readonly string[];
    }
  | {
      kind: "dimensions";
      assets: readonly BrowseDimensionAsset[];
    }
  | { kind: "reload" };

export interface BrowseDimensionAsset {
  assetId: string;
  width: number | null;
  height: number | null;
  mediaType: AssetSummary["mediaType"];
}

export interface BrowseMembershipDecision {
  reload: boolean;
  dropAssetIds: readonly string[];
}

type ClauseEffect = "unrelated" | "stay" | "drop" | "reload";

export function browseAssetsLeavingFilters(
  filters: readonly FilterClause[],
  change: BrowseMembershipChange,
): BrowseMembershipDecision {
  if (filters.length === 0 && change.kind !== "reload") {
    return { reload: false, dropAssetIds: [] };
  }
  if (change.kind === "reload") return { reload: true, dropAssetIds: [] };
  if (change.kind === "dimensions") {
    const dropAssetIds = change.assets
      .filter((asset) => effectForAsset(filters, change, asset) === "drop")
      .map((asset) => asset.assetId);
    const reload = dropAssetIds.length === 0
      && change.assets.some((asset) => effectForAsset(filters, change, asset) === "reload");
    return { reload, dropAssetIds };
  }
  const effect = effectForAsset(filters, change, null);
  if (effect === "drop") return { reload: false, dropAssetIds: change.assetIds };
  if (effect === "reload") return { reload: true, dropAssetIds: [] };
  return { reload: false, dropAssetIds: [] };
}

function effectForAsset(
  filters: readonly FilterClause[],
  change: BrowseMembershipChange,
  asset: BrowseDimensionAsset | null,
): ClauseEffect {
  let reload = false;
  for (const filter of filters) {
    const effect = "ranges" in filter
      ? numericEffect(filter, change, asset)
      : categoricalEffect(filter, change);
    if (effect === "drop") return "drop";
    if (effect === "reload") reload = true;
  }
  return reload ? "reload" : "stay";
}

function categoricalEffect(
  filter: Exclude<FilterClause, { ranges: unknown }>,
  change: BrowseMembershipChange,
): ClauseEffect {
  switch (filter.field) {
    case "favorite":
      if (change.kind !== "favorite") return "unrelated";
      return change.favorite === !filter.exclude ? "stay" : "drop";
    case "rating":
      return ratingEffect(filter, change);
    case "source_url":
      if (change.kind !== "source-url") return "unrelated";
      return change.hasSourceUrl === !filter.exclude ? "stay" : "drop";
    case "tag":
      return tagEffect(filter, change);
    default:
      return "unrelated";
  }
}

function ratingEffect(
  filter: { values: readonly string[]; exclude: boolean; includeAi?: boolean },
  change: BrowseMembershipChange,
): ClauseEffect {
  if (change.kind !== "rating") return "unrelated";
  const includeAi = filter.includeAi !== false;
  if (includeAi && change.rating === 0) return "reload";
  const selected = new Set(
    filter.values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value)),
  );
  const matches = selected.has(change.rating);
  const stays = filter.exclude ? !matches : matches;
  return stays ? "stay" : "drop";
}

function tagEffect(
  filter: { values: readonly string[]; exclude: boolean; includeAi?: boolean },
  change: BrowseMembershipChange,
): ClauseEffect {
  if (change.kind !== "tags") return "unrelated";
  const names = filter.values.map(normalizeTagName);
  const added = change.addedTagNames.map(normalizeTagName);
  const removed = change.removedTagNames.map(normalizeTagName);
  if (filter.exclude) {
    return added.some((name) => names.includes(name)) ? "drop" : "stay";
  }
  const removedHit = removed.filter((name) => names.includes(name));
  if (removedHit.length === 0) return "stay";
  if (filter.includeAi !== false) return "reload";
  return names.every((name) => removed.includes(name)) ? "drop" : "reload";
}

function numericEffect(
  filter: Extract<FilterClause, { ranges: unknown }>,
  change: BrowseMembershipChange,
  asset: BrowseDimensionAsset | null,
): ClauseEffect {
  if (change.kind !== "dimensions" || asset === null) return "unrelated";
  if (filter.field === "duration_ms") return "unrelated";
  const value = numericFilterValue(filter.field, asset);
  if (filter.field === "long_edge" && !isPixelMedia(asset.mediaType)) {
    return filter.exclude ? "stay" : "drop";
  }
  if (value === null) return filter.exclude ? "stay" : "drop";
  const matches = filter.ranges.some((range) => (
    (range.min === undefined || value >= range.min)
    && (range.max === undefined || value <= range.max)
  ));
  return filter.exclude ? (matches ? "drop" : "stay") : (matches ? "stay" : "drop");
}

function numericFilterValue(
  field: "width" | "height" | "aspect_ratio" | "long_edge",
  asset: BrowseDimensionAsset,
): number | null {
  const width = asset.width;
  const height = asset.height;
  if (field === "width") return width;
  if (field === "height") return height;
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  if (field === "long_edge") return Math.max(width, height);
  return width / height;
}

function isPixelMedia(mediaType: AssetSummary["mediaType"]): boolean {
  return mediaType === "image" || mediaType === "video";
}

/** Apply one membership change to the assets currently on screen. */
export function assetsRemainingAfterMembership<T extends { assetId: string }>(
  assets: readonly T[],
  filters: readonly FilterClause[] | null,
  change: BrowseMembershipChange,
): { assets: readonly T[]; reload: boolean } {
  if (filters === null) return { assets, reload: true };
  const decision = browseAssetsLeavingFilters(filters, change);
  if (decision.dropAssetIds.length === 0) {
    return { assets, reload: decision.reload };
  }
  const removed = new Set(decision.dropAssetIds);
  return {
    assets: assets.filter((asset) => !removed.has(asset.assetId)),
    reload: false,
  };
}

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase();
}
