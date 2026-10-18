import { describe, expect, it } from "vitest";

import {
  folderCoverPickerAssetMatches,
  folderCoverPickerImageFilter,
  folderCoverPickerSearchQuery,
} from "../../src/renderer/folder-cover-picker";

const asset = {
  displayName: "Hero.png",
  relativeFilePath: "packs/y2k/hero.png",
};

describe("folder cover picker search", () => {
  it("matches a name or a path and ignores a blank query", () => {
    expect(folderCoverPickerAssetMatches(asset, "")).toBe(true);
    expect(folderCoverPickerAssetMatches(asset, "   ")).toBe(true);
    expect(folderCoverPickerAssetMatches(asset, "  HERO ")).toBe(true);
    expect(folderCoverPickerAssetMatches(asset, "y2k")).toBe(true);
    expect(folderCoverPickerAssetMatches(asset, "packs/y2k")).toBe(true);
    expect(folderCoverPickerAssetMatches(asset, "missing")).toBe(false);
  });

  it("builds a filename-or-folder-path query and an image format filter", () => {
    expect(folderCoverPickerSearchQuery("  ")).toBeNull();
    expect(folderCoverPickerSearchQuery("y2k")).toEqual({
      clauses: [],
      groups: [
        [{ field: "filename", values: ["y2k"], exclude: false }],
        [{ field: "folder_path", values: ["y2k"], exclude: false }],
      ],
    });
    const filter = folderCoverPickerImageFilter();
    expect(filter.field).toBe("format");
    expect(filter.exclude).toBe(false);
    if (filter.field !== "format") return;
    expect(filter.values).toContain("png");
    expect(filter.values).not.toContain("mp4");
  });
});
