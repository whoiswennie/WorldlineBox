import { describe, expect, it } from "vitest";

import {
  parseRendererRequest,
  parseWorkerRequest,
} from "../../src/shared/protocol/requests";
import { parseThumbnailEvent } from "../../src/shared/protocol/responses";

describe("viewport priority and thumbnail completion protocol", () => {
  it("keeps visual order on visible-window reports and accepts optional bands", () => {
    const renderer = parseRendererRequest({
      type: "asset.thumbnail.visible-window.request",
      libraryId: "lib-1",
      assetIds: ["visible-b", "visible-a"],
      consumerId: "browse",
      viewportGeneration: 4,
      direction: "down",
      focusedAssetIds: ["viewer-1"],
      nearForwardAssetIds: ["ahead-1"],
      nearBackwardAssetIds: ["behind-1"],
      scopeWarmAssetIds: ["loaded-1"],
    });
    expect(renderer).toMatchObject({
      type: "asset.thumbnail.visible-window.request",
      assetIds: ["visible-b", "visible-a"],
      direction: "down",
      nearForwardAssetIds: ["ahead-1"],
    });
    expect(parseWorkerRequest({
      requestId: "visible-window-1",
      command: {
        type: "asset.thumbnail.visible-window",
        libraryId: "lib-1",
        assetIds: ["visible-b", "visible-a"],
        direction: "jump",
      },
    }).command).toMatchObject({
      type: "asset.thumbnail.visible-window",
      direction: "jump",
    });
  });

  it("parses batched off-screen thumbnail completions", () => {
    expect(parseThumbnailEvent({
      type: "asset.thumbnail.batch-ready",
      libraryId: "lib-1",
      completedCount: 2,
      ready: [{ assetId: "off-1", artifactId: "art-1" }],
      failed: [{
        assetId: "off-2",
        errorCode: "THUMBNAIL_GENERATION_FAILED",
        reason: "failed",
      }],
    })).toMatchObject({
      type: "asset.thumbnail.batch-ready",
      completedCount: 2,
    });
  });

  it("still accepts a legacy visible-window payload with only asset ids", () => {
    expect(parseRendererRequest({
      type: "asset.thumbnail.visible-window.request",
      libraryId: "lib-1",
      assetIds: ["a"],
    })).toEqual({
      type: "asset.thumbnail.visible-window.request",
      libraryId: "lib-1",
      assetIds: ["a"],
    });
  });
});
