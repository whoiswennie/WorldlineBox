// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { AssetSummary } from "../../src/shared/asset-types";
import type { WorldlineBoxLibraryApi } from "../../src/shared/library-api";
import type { VirtualBrowseLayout } from "../../src/renderer/browse/virtual-browse-layout";
import {
  resolveBrowseCanvasLayout,
} from "../../src/renderer/browse-window-slots";
import {
  useBrowsePagination,
  type UseBrowsePaginationResult,
} from "../../src/renderer/use-browse-pagination";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function asset(assetId: string): AssetSummary {
  const rank = Number(assetId.slice("rank-".length));
  return {
    assetId,
    locationKind: "managed",
    managedFolderId: null,
    relativeFilePath: `${assetId}.png`,
    displayName: `${assetId}.png`,
    currentRevisionId: `revision-${assetId}`,
    byteSize: 100,
    // A normal modified-time sort would reverse the semantic ranking.
    modifiedAt: new Date(Date.UTC(2026, 0, 1) + rank * 60_000).toISOString(),
    availability: "available",
    rating: 0,
    favorite: false,
    deletedAt: null,
    trashedFromPath: null,
    trashedFromTombstoneId: null,
    remainingDays: null,
    thumbnailStatus: "ready",
    thumbnailArtifactId: null,
    mediaType: "image",
    width: 160,
    height: 100,
    durationMs: null,
  };
}

type HarnessState = {
  assets: AssetSummary[];
  layout: ReturnType<typeof resolveBrowseCanvasLayout>;
  pagination: UseBrowsePaginationResult;
};

describe("ranked browse pagination canvas integration", () => {
  it.each(["range", "indices"] as const)(
    "keeps the ranked prefix in place when the third batch is fetched by %s",
    async (thirdBatchMode) => {
      const rankedAssetIds = Array.from(
        { length: 150 },
        (_, index) => `rank-${index.toString().padStart(3, "0")}`,
      );
      const missingAssetIds = new Set([rankedAssetIds[17]!, rankedAssetIds[75]!]);
      const listAssets = vi.fn(async ({ assetIds = [] }: { assetIds?: readonly string[] }) => ({
        ok: true as const,
        // The API result order deliberately conflicts with the ranking snapshot.
        value: [...assetIds]
          .filter((assetId) => !missingAssetIds.has(assetId))
          .reverse()
          .map(asset),
      }));
      const api = { listAssets } as unknown as WorldlineBoxLibraryApi;
      let current: HarnessState | null = null;

      function Harness() {
        const [assets, setAssets] = useState<AssetSummary[]>([]);
        const [, setTrashedAssets] = useState<AssetSummary[]>([]);
        const [browseLayout, setBrowseLayout] = useState<NonNullable<HarnessState["layout"]>>([]);
        const [, setVirtualBrowseLayout] = useState<VirtualBrowseLayout | null>(null);
        const [, setSearchTotal] = useState<number | null>(null);
        const [, setSearchOffset] = useState(0);
        const [, setSearchSnippets] = useState(new Map<string, string>());
        const pagination = useBrowsePagination({
          api,
          setAssets,
          setTrashedAssets,
          setBrowseLayout,
          setVirtualBrowseLayout,
          setSearchTotal,
          setSearchOffset,
          setSearchSnippets,
        });
        current = { assets, layout: browseLayout, pagination };
        return null;
      }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });

    try {
      await act(async () => {
        current!.pagination.beginPage(
          {
            kind: "search",
            libraryId: "fixture-library",
            query: null,
            showIgnored: false,
            target: "assets",
            rankedAssetIds,
            rankedPageSize: 50,
          },
          {
            items: rankedAssetIds
              .slice(0, 50)
              .filter((assetId) => !missingAssetIds.has(assetId))
              .map(asset),
            total: rankedAssetIds.length,
            offset: 0,
          },
        );
      });

      const initialCanvasIds = resolveBrowseCanvasLayout(
        current!.layout,
        current!.assets,
      ).map((entry) => entry.assetId);
      expect(initialCanvasIds).toEqual(
        rankedAssetIds.slice(0, 50).filter((assetId) => !missingAssetIds.has(assetId)),
      );
      const anchorIndex = initialCanvasIds.indexOf(rankedAssetIds[25]!);

      // App's scroll observer checks this already-filled range immediately
      // after first paint. The ranked layout must survive that no-fetch pass.
      await act(async () => {
        await current!.pagination.ensureVisibleRange(0, 49);
      });
      await act(async () => {
        await current!.pagination.appendNextPage();
      });

      const afterSecondBatch = resolveBrowseCanvasLayout(
        current!.layout,
        current!.assets,
      ).map((entry) => entry.assetId);
      expect(afterSecondBatch).toEqual(
        rankedAssetIds.slice(0, 100).filter((assetId) => !missingAssetIds.has(assetId)),
      );
      expect(afterSecondBatch.slice(0, initialCanvasIds.length)).toEqual(initialCanvasIds);
      expect(afterSecondBatch.indexOf(rankedAssetIds[25]!)).toBe(anchorIndex);

      // A visible-range fetch hydrates the third batch through the same path
      // used by scrollbar jumps, and must retain both earlier batches.
      await act(async () => {
        if (thirdBatchMode === "range") {
          await current!.pagination.ensureVisibleRange(100, 149);
        } else {
          await current!.pagination.ensureVisibleIndices([100, 125]);
        }
      });
      const afterThirdBatch = resolveBrowseCanvasLayout(
        current!.layout,
        current!.assets,
      ).map((entry) => entry.assetId);
      expect(afterThirdBatch).toEqual(
        rankedAssetIds.filter((assetId) => !missingAssetIds.has(assetId)),
      );
      expect(afterThirdBatch.slice(0, initialCanvasIds.length)).toEqual(initialCanvasIds);
      expect(afterThirdBatch.indexOf(rankedAssetIds[25]!)).toBe(anchorIndex);

      // Both query lanes also have already-filled fast paths; they must not
      // replace the compact ranked layout with the empty session layout.
      await act(async () => {
        await current!.pagination.ensureVisibleRange(0, 49);
        await current!.pagination.ensureVisibleIndices([0, 25, 149]);
      });
      expect(resolveBrowseCanvasLayout(current!.layout, current!.assets)
        .map((entry) => entry.assetId)).toEqual(
        rankedAssetIds.filter((assetId) => !missingAssetIds.has(assetId)),
      );
      expect(listAssets).toHaveBeenCalledTimes(2);
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    },
  );
});
