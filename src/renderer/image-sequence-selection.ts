import type { AssetSummary } from "../shared/asset-types";
import type { LibraryApiResult, WorldlineBoxLibraryApi } from "../shared/library-api";

/** Matches `asset.list` / `asset.list.request` `assetIds` max. */
export const LIST_ASSETS_BY_ID_MAX = 10_000;

export type ImageSequenceSelectionAsset = Pick<
  AssetSummary,
  "assetId" | "mediaType" | "availability" | "deletedAt"
> & {
  readonly sequence?: AssetSummary["sequence"];
};

export function isEligibleImageSequenceFrame(
  asset: ImageSequenceSelectionAsset,
): boolean {
  return (
    !asset.deletedAt &&
    asset.mediaType === "image" &&
    asset.availability === "available" &&
    !asset.sequence
  );
}

/**
 * Create-sequence eligibility for a multi-select whose summaries may still
 * be paged out of the browse window. Unloaded IDs do not disable the action;
 * any loaded ineligible item does.
 */
export function canCreateImageSequenceFromSelection(input: {
  selectedCount: number;
  loadedSelectedAssets: readonly ImageSequenceSelectionAsset[];
}): boolean {
  if (input.selectedCount < 3) return false;
  return input.loadedSelectedAssets.every(isEligibleImageSequenceFrame);
}

export function orderAssetSummariesByIds(
  assetIds: readonly string[],
  assets: readonly AssetSummary[],
): AssetSummary[] {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const ordered: AssetSummary[] = [];
  const seen = new Set<string>();
  for (const assetId of assetIds) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    const asset = byId.get(assetId);
    if (asset) ordered.push(asset);
  }
  return ordered;
}

/**
 * Fill paged-out selected summaries by id so create-sequence can inspect
 * paths and dimensions without waiting for scroll-load.
 */
export async function resolveAssetSummariesForSelection(input: {
  listAssets: WorldlineBoxLibraryApi["listAssets"];
  libraryId: string;
  assetIds: readonly string[];
  loadedAssets: readonly AssetSummary[];
}): Promise<LibraryApiResult<AssetSummary[]>> {
  const byId = new Map(
    input.loadedAssets.map((asset) => [asset.assetId, asset]),
  );
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const assetId of input.assetIds) {
    if (assetId.length === 0 || seen.has(assetId)) continue;
    seen.add(assetId);
    if (!byId.has(assetId)) missing.push(assetId);
  }
  for (let offset = 0; offset < missing.length; offset += LIST_ASSETS_BY_ID_MAX) {
    const chunk = missing.slice(offset, offset + LIST_ASSETS_BY_ID_MAX);
    const result = await input.listAssets({
      libraryId: input.libraryId,
      recursive: true,
      showIgnored: true,
      assetIds: chunk,
    });
    if (!result.ok) return result;
    for (const asset of result.value) {
      byId.set(asset.assetId, asset);
    }
  }
  return {
    ok: true,
    value: orderAssetSummariesByIds(input.assetIds, [...byId.values()]),
  };
}
