import { describe, expect, it } from "vitest";

import { assetParentFolderCoverTarget } from "../../src/shared/folder-cover-target";

describe("assetParentFolderCoverTarget", () => {
  it("uses the managed parent folder and hides library root, non-images, and deleted assets", () => {
    expect(assetParentFolderCoverTarget({
      locationKind: "managed",
      managedFolderId: "folder-1",
      relativeFilePath: "folder-1/shot.png",
      mediaType: "image",
      deletedAt: null,
    })).toBe("folder-1");
    expect(assetParentFolderCoverTarget({
      locationKind: "managed",
      managedFolderId: null,
      relativeFilePath: "root.png",
      mediaType: "image",
      deletedAt: null,
    })).toBeNull();
    expect(assetParentFolderCoverTarget({
      locationKind: "managed",
      managedFolderId: "folder-1",
      relativeFilePath: "folder-1/clip.mp4",
      mediaType: "video",
      deletedAt: null,
    })).toBeNull();
    expect(assetParentFolderCoverTarget({
      locationKind: "managed",
      managedFolderId: "folder-1",
      relativeFilePath: "folder-1/shot.png",
      mediaType: "image",
      deletedAt: "2026-10-13T00:00:00.000Z",
    })).toBeNull();
  });

  it("uses the linked directory that contains the image", () => {
    expect(assetParentFolderCoverTarget({
      locationKind: "linked",
      managedFolderId: null,
      linkedFolderId: "link-1",
      relativeFilePath: "shots/a.png",
      mediaType: "image",
      deletedAt: null,
    })).toBe("lfv:link-1/shots");
    expect(assetParentFolderCoverTarget({
      locationKind: "linked",
      managedFolderId: null,
      linkedFolderId: "link-1",
      relativeFilePath: "a.png",
      mediaType: "image",
      deletedAt: null,
    })).toBe("link-1");
  });
});
