import { describe, expect, it } from "vitest";

import {
  folderCoverClearTargets,
  folderCoverImageSrc,
  patchFolderNavigationCoverArtifact,
} from "../../src/renderer/folder-cover";

describe("folderCoverClearTargets", () => {
  it("does not offer restore for folders without a custom cover", () => {
    expect(folderCoverClearTargets(["folder-1"], new Set())).toEqual([]);
  });

  it("limits a mixed selection to folders with a custom cover", () => {
    expect(
      folderCoverClearTargets(
        ["folder-1", "folder-2", "folder-3"],
        new Set(["folder-2"]),
      ),
    ).toEqual(["folder-2"]);
  });
});

describe("folderCoverImageSrc", () => {
  it("prefers a stored cover over the automatic thumbnail", () => {
    expect(folderCoverImageSrc("lib", {
      folderId: "folder-1",
      hasCustomCover: true,
      customCoverToken: "2026-10-09T00:00:00.000Z",
      coverArtifactIds: ["art-1"],
    })).toContain("worldlinebox://folder-cover/");
  });

  it("prefers a library asset cover over the stored file and the automatic thumbnail", () => {
    expect(folderCoverImageSrc("lib", {
      folderId: "folder-1",
      hasCustomCover: true,
      customCoverToken: "2026-10-09T00:00:00.000Z",
      customCoverAssetId: "asset-1",
      customCoverArtifactId: "art-cover",
      coverArtifactIds: ["art-1"],
    })).toBe("worldlinebox://preview/lib/art-cover");
  });

  it("uses the library asset file when its thumbnail is not ready", () => {
    expect(folderCoverImageSrc("lib", {
      folderId: "folder-1",
      hasCustomCover: true,
      customCoverAssetId: "asset-1",
      customCoverSourcePreview: { assetId: "asset-1", revisionId: "rev 2" },
      coverArtifactIds: ["art-1"],
    })).toBe("worldlinebox://source/lib/asset-1?revision=rev%202");
  });

  it("prefers a thumbnail artifact", () => {
    expect(folderCoverImageSrc("lib", {
      folderId: "folder-1",
      coverArtifactIds: ["art-1"],
      coverSourcePreviews: [{ assetId: "asset", revisionId: "rev" }],
    })).toBe("worldlinebox://preview/lib/art-1");
  });

  it("uses the sequence frame file when the folder has no thumbnail", () => {
    expect(folderCoverImageSrc("lib", {
      folderId: "folder-1",
      coverArtifactIds: [],
      coverSourcePreviews: [{ assetId: "frame", revisionId: "rev 1" }],
    })).toBe("worldlinebox://source/lib/frame?revision=rev%201");
  });

  it("returns nothing when the folder has no paintable cover", () => {
    expect(folderCoverImageSrc("lib", { folderId: "folder-1", coverArtifactIds: [] })).toBeNull();
  });

  it("patches only the navigation covers that use the ready asset", () => {
    const covers = [
      { folderId: "folder-1", assetId: "asset-1", revisionId: "rev-1" },
      { folderId: "folder-2", fileToken: "token" },
    ];
    const patched = patchFolderNavigationCoverArtifact(covers, "asset-1", "art-9");
    expect(patched.changed).toBe(true);
    expect(patched.covers[0]).toEqual({
      folderId: "folder-1",
      assetId: "asset-1",
      revisionId: "rev-1",
      artifactId: "art-9",
    });
    expect(patched.covers[1]).toEqual(covers[1]);
    expect(patchFolderNavigationCoverArtifact(patched.covers, "asset-1", "art-9").changed).toBe(false);
  });
});
