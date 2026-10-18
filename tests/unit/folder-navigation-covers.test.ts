import { describe, expect, it } from "vitest";

import {
  FOLDER_NAVIGATION_COVER_CAP,
  libraryNavigationSummarySchema,
} from "../../src/shared/library-navigation";

describe("folder navigation cover cap", () => {
  it("drops covers past the cap instead of rejecting the summary", () => {
    const folderCovers = Array.from({ length: FOLDER_NAVIGATION_COVER_CAP + 1 }, (_, index) => ({
      folderId: `folder-${index}`,
      fileToken: "token",
    }));
    const parsed = libraryNavigationSummarySchema.parse({
      libraryId: "lib",
      changeSequence: 1,
      allAssetCount: 0,
      rootAssetCount: 0,
      trashedAssetCount: 0,
      folders: [],
      linkedFolders: [],
      tags: [],
      collections: [],
      smartCollections: [],
      trashedFolders: [],
      folderCovers,
    });
    expect(parsed.folderCovers).toHaveLength(FOLDER_NAVIGATION_COVER_CAP);
    expect(parsed.folderCovers?.[0]?.folderId).toBe("folder-0");
  });
});
