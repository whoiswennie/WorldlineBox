import { describe, expect, it } from "vitest";

import type { AssetSummary } from "../../src/shared/asset-types";
import { createCaptionBandResolver } from "../../src/renderer/asset-caption-band";
import { countFittingColumns } from "../../src/renderer/asset-grid-layout";
import { resolveJustifiedCaptionBandPx } from "../../src/renderer/justified-caption-band";
import { estimateMasonryPreviewHeightPx } from "../../src/renderer/masonry-preview-frame";
import {
  estimateMasonryCardBodyPx,
  hitTestCanvasAssetLayout,
  justifyRowCaptionBandPx,
  layoutJustifiedAssetRects,
  layoutMasonryAssetRects,
  masonryColumnWidthPx,
  MASONRY_CAPTION_BAND_PX,
  MASONRY_DIMENSIONS_CAPTION_BAND_PX,
  overlayLiveAssetGeometry,
  stackItemHeights,
} from "../../src/renderer/canvas-asset-layout";

function asset(
  id: string,
  width: number,
  height: number,
): AssetSummary {
  return {
    assetId: id,
    locationKind: "linked",
    managedFolderId: null,
    relativeFilePath: `${id}.jpg`,
    displayName: `${id}.jpg`,
    currentRevisionId: `rev-${id}`,
    byteSize: 1,
    modifiedAt: "2026-01-01T00:00:00.000Z",
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
    width,
    height,
    durationMs: null,
  };
}

describe("canvas asset layout", () => {
  it("lays out every masonry card, not only a viewport slice", () => {
    const assets = Array.from({ length: 12 }, (_, index) =>
      asset(`a${index}`, 100, 100),
    );
    const rects = layoutMasonryAssetRects(assets, 400, 120, false);
    expect(rects).toHaveLength(12);
    expect(new Set(rects.map((item) => item.id)).size).toBe(12);
  });

  it("hit-tests masonry cards that would be unmounted by windowing", () => {
    const assets = Array.from({ length: 8 }, (_, index) =>
      asset(`a${index}`, 100, 200),
    );
    const rects = layoutMasonryAssetRects(assets, 260, 120, false);
    const last = rects.at(-1);
    expect(last).toBeDefined();
    const hits = hitTestCanvasAssetLayout(rects, {
      left: last!.x + 1,
      top: last!.y + 1,
      right: last!.x + last!.width - 1,
      bottom: last!.y + last!.height - 1,
    });
    expect(hits).toContain(last!.id);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("reserves the third caption row when resolution is enabled", () => {
    const base = estimateMasonryCardBodyPx(asset("caption", 100, 100), 160, true);
    const withDimensions = estimateMasonryCardBodyPx(
      asset("caption", 100, 100),
      160,
      true,
      MASONRY_DIMENSIONS_CAPTION_BAND_PX,
    );
    expect(base).toBeGreaterThan(0);
    expect(withDimensions - base).toBe(
      MASONRY_DIMENSIONS_CAPTION_BAND_PX - MASONRY_CAPTION_BAND_PX,
    );
  });

  it("lays out justified rows with stable ids", () => {
    const assets = [
      asset("wide", 400, 100),
      asset("tall", 100, 400),
      asset("square", 200, 200),
    ];
    const rects = layoutJustifiedAssetRects(assets, 640, 160);
    expect(rects.map((item) => item.id)).toEqual(["wide", "tall", "square"]);
    expect(rects.every((item) => item.width > 0 && item.height > 0)).toBe(true);
    expect(
      rects.every(
        (item) => Number.isInteger(item.width) && Number.isInteger(item.height) && Number.isInteger(item.x) && Number.isInteger(item.y),
      ),
    ).toBe(true);
  });

  it("keeps trailing gap out of the last stacked item", () => {
    expect(stackItemHeights([100, 100, 100])).toEqual([114, 114, 100]);
  });

  it("shrinks only the waterfall cards that have no resolution (WorldlineBox-b1b0f2)", () => {
    const resolver = createCaptionBandResolver({
      mode: "masonry",
      fields: { name: true, size: true, date: true, dimensions: true },
    });
    const sized = asset("sized", 100, 100);
    const unsized = { ...asset("unsized", 100, 100), width: null, height: null };
    const rects = layoutMasonryAssetRects([sized, unsized], 400, 120, true, resolver);
    const byId = new Map(rects.map((item) => [item.id, item]));
    const columnWidth = masonryColumnWidthPx(400, countFittingColumns(400, 120));
    // Each card reserves only its own caption band; the previews differ because
    // an undecoded asset falls back to the placeholder aspect ratio.
    expect(byId.get("sized")!.height).toBe(
      estimateMasonryPreviewHeightPx(sized.width, sized.height, columnWidth) +
        MASONRY_DIMENSIONS_CAPTION_BAND_PX,
    );
    expect(byId.get("unsized")!.height).toBe(
      estimateMasonryPreviewHeightPx(null, null, columnWidth) + MASONRY_CAPTION_BAND_PX,
    );
  });

  it("sizes a tiled row by the tallest caption in that row (WorldlineBox-b1b0f2)", () => {
    const resolver = createCaptionBandResolver({
      mode: "justified",
      fields: { name: true, size: true, date: true, dimensions: true },
    });
    const rows = [
      {
        height: 160,
        items: [
          { id: "plain", width: 160, height: 160 },
          { id: "sized", width: 160, height: 160 },
        ],
      },
    ];
    const entryById = new Map([
      ["plain", { assetId: "plain", width: null, height: null, mediaType: "image" as const }],
      ["sized", { assetId: "sized", width: 800, height: 600, mediaType: "image" as const }],
    ]);
    expect(justifyRowCaptionBandPx(rows[0]!, entryById, resolver)).toBe(
      resolveJustifiedCaptionBandPx({
        dimensions: true,
        name: true,
        secondary: true,
      }),
    );
  });

  it("shrinks a tiled row whose assets all lack resolution (WorldlineBox-b1b0f2)", () => {
    const resolver = createCaptionBandResolver({
      mode: "justified",
      fields: { name: true, size: true, date: true, dimensions: true },
    });
    const unsized = (id: string) => ({
      ...asset(id, 100, 100),
      width: null,
      height: null,
    });
    const withSize = layoutJustifiedAssetRects(
      [asset("a", 100, 100), asset("b", 100, 100)],
      400,
      160,
      resolver,
    );
    const withoutSize = layoutJustifiedAssetRects(
      [unsized("a"), unsized("b")],
      400,
      160,
      resolver,
    );
    expect(withoutSize[0]!.height).toBe(withoutSize[1]!.height);
    expect(withoutSize[0]!.height).toBeLessThan(withSize[0]!.height);
  });

  it("overlays live asset dimensions onto a stale browse-layout snapshot (WorldlineBox-9c9f97)", () => {
    const layout = [
      { assetId: "video", width: null, height: null },
      { assetId: "still", width: 800, height: 600 },
    ];
    const assets = new Map([
      ["video", { width: 1920, height: 1080 }],
      ["still", { width: 800, height: 600 }],
    ]);
    const next = overlayLiveAssetGeometry(layout, assets);
    expect(next).not.toBe(layout);
    expect(next[0]).toMatchObject({ assetId: "video", width: 1920, height: 1080 });
    expect(next[1]).toBe(layout[1]);
    expect(overlayLiveAssetGeometry(layout, new Map([["still", { width: 800, height: 600 }]])))
      .toBe(layout);
  });
});
