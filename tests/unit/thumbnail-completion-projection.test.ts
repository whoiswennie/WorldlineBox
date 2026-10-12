import { describe, expect, it } from "vitest";

import {
  expandThumbnailCardEvents,
  projectThumbnailEvent,
  shouldProjectThumbnailCompletion,
  thumbnailEventConcernsAsset,
} from "../../src/renderer/thumbnail-completion-projection";

const subscriptions = {
  loadedAssetIds: new Set(["loaded-1"]),
  visibleAssetIds: new Set(["visible-1"]),
  selectedAssetId: "selected-1",
  viewerAssetId: "viewer-1",
  folderCoverAssetIds: new Set(["cover-1"]),
};

describe("thumbnail completion projection", () => {
  it("expands a batch into per-asset card events", () => {
    expect(
      expandThumbnailCardEvents({
        type: "asset.thumbnail.batch-ready",
        libraryId: "lib-1",
        completedCount: 2,
        ready: [{ assetId: "a", artifactId: "art-a" }],
        failed: [{ assetId: "b", errorCode: "THUMBNAIL_GENERATION_FAILED", reason: "failed" }],
      }).map((event) => event.type),
    ).toEqual(["asset.thumbnail.ready", "asset.thumbnail.failed"]);
  });

  it("projects viewport, loaded, inspector, viewer, and folder covers only", () => {
    expect(shouldProjectThumbnailCompletion("visible-1", subscriptions)).toBe(true);
    expect(shouldProjectThumbnailCompletion("loaded-1", subscriptions)).toBe(true);
    expect(shouldProjectThumbnailCompletion("selected-1", subscriptions)).toBe(true);
    expect(shouldProjectThumbnailCompletion("viewer-1", subscriptions)).toBe(true);
    expect(shouldProjectThumbnailCompletion("cover-1", subscriptions)).toBe(true);
    expect(shouldProjectThumbnailCompletion("other-library-asset", subscriptions)).toBe(false);
  });

  it("keeps off-scope batch items out of card patches and still notes activity", () => {
    const actions = projectThumbnailEvent(
      {
        type: "asset.thumbnail.batch-ready",
        libraryId: "lib-1",
        completedCount: 3,
        ready: [
          { assetId: "visible-1", artifactId: "art-visible" },
          { assetId: "other-library-asset", artifactId: "art-other" },
        ],
        failed: [{ assetId: "loaded-1", errorCode: "THUMBNAIL_GENERATION_FAILED", reason: "failed" }],
      },
      subscriptions,
    );
    expect(actions.noteActivity).toBe(true);
    expect([...actions.patches.keys()].toSorted()).toEqual(["loaded-1", "visible-1"]);
    expect(actions.patches.get("other-library-asset")).toBeUndefined();
    expect(actions.layoutArtifacts.get("visible-1")).toBe("art-visible");
    expect(actions.layoutArtifacts.has("other-library-asset")).toBe(false);
  });

  it("matches viewer assets inside a batch event", () => {
    expect(
      thumbnailEventConcernsAsset(
        {
          type: "asset.thumbnail.batch-ready",
          libraryId: "lib-1",
          completedCount: 1,
          ready: [{ assetId: "viewer-1", artifactId: "art-viewer" }],
          failed: [],
        },
        "viewer-1",
      ),
    ).toBe(true);
    expect(
      thumbnailEventConcernsAsset(
        {
          type: "asset.thumbnail.ready",
          libraryId: "lib-1",
          assetId: "visible-1",
          artifactId: "art-visible",
        },
        "viewer-1",
      ),
    ).toBe(false);
  });
});
