import { describe, expect, it } from "vitest";

import type { AssetSummary } from "../../src/shared/asset-types";
import {
  isPostImportSequenceOfferId,
  postImportFrameGroupsForAction,
  postImportSequencePlanFromAssets,
} from "../../src/renderer/post-import-image-sequences";

function asset(partial: {
  assetId: string;
  relativeFilePath: string;
  width?: number | null;
  height?: number | null;
}): AssetSummary {
  return {
    assetId: partial.assetId,
    locationKind: "managed",
    managedFolderId: "folder-1",
    relativeFilePath: partial.relativeFilePath,
    displayName: partial.relativeFilePath,
    currentRevisionId: "rev",
    byteSize: 1,
    modifiedAt: "2026-09-18T00:00:00.000Z",
    availability: "available",
    rating: 0,
    favorite: false,
    deletedAt: null,
    mediaType: "image",
    width: partial.width ?? 64,
    height: partial.height ?? 64,
  } as AssetSummary;
}

describe("post-import image sequence offer", () => {
  it("builds an offer from consecutive imported frames", () => {
    const plan = postImportSequencePlanFromAssets("lib-1", [
      asset({ assetId: "a1", relativeFilePath: "shot_001.png" }),
      asset({ assetId: "a2", relativeFilePath: "shot_002.png" }),
      asset({ assetId: "a3", relativeFilePath: "shot_003.png" }),
      asset({ assetId: "n", relativeFilePath: "notes.png" }),
    ]);
    expect(plan).not.toBeNull();
    expect(isPostImportSequenceOfferId(plan?.offer.offerId)).toBe(true);
    expect(plan?.offer.sequences).toHaveLength(1);
    expect(plan?.sequences[0]?.frameAssetIds).toEqual(["a1", "a2", "a3"]);
  });

  it("returns trimmed frame ids when confirming a sequence", () => {
    const plan = postImportSequencePlanFromAssets("lib-1", [
      asset({ assetId: "a1", relativeFilePath: "shot_001.png" }),
      asset({ assetId: "a2", relativeFilePath: "shot_002.png" }),
      asset({ assetId: "a3", relativeFilePath: "shot_003.png" }),
      asset({ assetId: "a4", relativeFilePath: "shot_004.png" }),
    ]);
    expect(plan).not.toBeNull();
    const decision = postImportFrameGroupsForAction({
      action: "import-sequence",
      applyToRest: false,
      firstFrame: 2,
      lastFrame: 4,
      sequenceIndex: 0,
      plan: plan!,
    });
    expect(decision.groups).toEqual([["a2", "a3", "a4"]]);
    expect(decision.nextSequenceIndex).toBeNull();
  });

  it("skips grouping when keeping separate files", () => {
    const plan = postImportSequencePlanFromAssets("lib-1", [
      asset({ assetId: "a1", relativeFilePath: "shot_001.png" }),
      asset({ assetId: "a2", relativeFilePath: "shot_002.png" }),
      asset({ assetId: "a3", relativeFilePath: "shot_003.png" }),
    ]);
    const decision = postImportFrameGroupsForAction({
      action: "import-selected",
      applyToRest: false,
      firstFrame: 1,
      lastFrame: 3,
      sequenceIndex: 0,
      plan: plan!,
    });
    expect(decision.groups).toEqual([]);
  });
});
