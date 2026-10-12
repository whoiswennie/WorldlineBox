import { describe, expect, it, vi } from "vitest";

import type { AssetSummary } from "../../src/shared/asset-types";
import type { LibraryApiResult } from "../../src/shared/library-api";
import {
  canCreateImageSequenceFromSelection,
  LIST_ASSETS_BY_ID_MAX,
  resolveAssetSummariesForSelection,
} from "../../src/renderer/image-sequence-selection";

function image(assetId: string, extra?: Partial<AssetSummary>): AssetSummary {
  return {
    assetId,
    locationKind: "managed",
    managedFolderId: "folder-1",
    linkedFolderId: null,
    relativeFilePath: `${assetId}.png`,
    displayName: `${assetId}.png`,
    currentRevisionId: `rev-${assetId}`,
    byteSize: 1,
    modifiedAt: "2026-09-19T00:00:00.000Z",
    availability: "available",
    rating: 0,
    favorite: false,
    deletedAt: null,
    trashedFromPath: null,
    remainingDays: null,
    thumbnailStatus: null,
    thumbnailArtifactId: null,
    mediaType: "image",
    width: 64,
    height: 64,
    ...extra,
  } as AssetSummary;
}

describe("canCreateImageSequenceFromSelection", () => {
  it("enables create when 151 ids are selected and only the first 100 summaries are loaded", () => {
    const loaded = Array.from({ length: 100 }, (_, index) =>
      image(`frame-${String(index + 1).padStart(3, "0")}`),
    );
    expect(
      canCreateImageSequenceFromSelection({
        selectedCount: 151,
        loadedSelectedAssets: loaded,
      }),
    ).toBe(true);
  });

  it("disables create when any loaded selected asset is not an eligible frame", () => {
    expect(
      canCreateImageSequenceFromSelection({
        selectedCount: 151,
        loadedSelectedAssets: [
          image("frame-001"),
          image("clip", { mediaType: "video" }),
        ],
      }),
    ).toBe(false);
  });

  it("disables create below three selected ids even if loaded frames look eligible", () => {
    expect(
      canCreateImageSequenceFromSelection({
        selectedCount: 2,
        loadedSelectedAssets: [image("a"), image("b")],
      }),
    ).toBe(false);
  });
});

describe("resolveAssetSummariesForSelection", () => {
  it("fetches paged-out ids and returns summaries in selection order", async () => {
    const selectedIds = Array.from({ length: 151 }, (_, index) =>
      `frame-${String(index + 1).padStart(3, "0")}`,
    );
    const loaded = selectedIds.slice(0, 100).map((assetId) => image(assetId));
    const listAssets = vi.fn(
      async (input: {
        assetIds?: readonly string[];
      }): Promise<LibraryApiResult<AssetSummary[]>> => {
        const fetched = (input.assetIds ?? []).map((assetId) => image(assetId));
        return { ok: true, value: fetched };
      },
    );

    const result = await resolveAssetSummariesForSelection({
      listAssets: listAssets as never,
      libraryId: "lib-1",
      assetIds: selectedIds,
      loadedAssets: loaded,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((asset) => asset.assetId)).toEqual(selectedIds);
    expect(listAssets).toHaveBeenCalledTimes(1);
    expect(listAssets.mock.calls[0]?.[0]).toMatchObject({
      libraryId: "lib-1",
      recursive: true,
      showIgnored: true,
      assetIds: selectedIds.slice(100),
    });
  });

  it("does not call listAssets when every selected id already has a summary", async () => {
    const listAssets = vi.fn();
    const assets = [image("a"), image("b"), image("c")];
    const result = await resolveAssetSummariesForSelection({
      listAssets: listAssets as never,
      libraryId: "lib-1",
      assetIds: ["a", "b", "c"],
      loadedAssets: assets,
    });
    expect(result.ok).toBe(true);
    expect(listAssets).not.toHaveBeenCalled();
  });

  it("chunks id fetches at the protocol max", async () => {
    const missing = Array.from(
      { length: LIST_ASSETS_BY_ID_MAX + 3 },
      (_, index) => `extra-${index}`,
    );
    const listAssets = vi.fn(
      async (input: {
        assetIds?: readonly string[];
      }): Promise<LibraryApiResult<AssetSummary[]>> => ({
        ok: true,
        value: (input.assetIds ?? []).map((assetId) => image(assetId)),
      }),
    );
    const result = await resolveAssetSummariesForSelection({
      listAssets: listAssets as never,
      libraryId: "lib-1",
      assetIds: missing,
      loadedAssets: [],
    });
    expect(result.ok).toBe(true);
    expect(listAssets).toHaveBeenCalledTimes(2);
    expect(listAssets.mock.calls[0]?.[0].assetIds).toHaveLength(LIST_ASSETS_BY_ID_MAX);
    expect(listAssets.mock.calls[1]?.[0].assetIds).toHaveLength(3);
  });
});
