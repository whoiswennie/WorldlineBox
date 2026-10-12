import { describe, expect, it } from "vitest";

import type { CollectionSummary } from "../../src/shared/asset-types";
import {
  filterCollectionTreeByName,
  filterDirectoryEntriesByName,
  type UnifiedDirectoryNavEntry,
} from "../../src/renderer/unified-directory-nav";

function folder(
  folderId: string,
  name: string,
  parentFolderId: string | null,
  depth: number,
): UnifiedDirectoryNavEntry {
  return {
    kind: "managed",
    folderId,
    name,
    depth,
    parentFolderId,
    directAssetCount: 0,
  };
}

function collection(collectionId: string, name: string, parentId: string | null): CollectionSummary {
  return {
    collectionId,
    parentId,
    name,
    description: null,
    coverAssetId: null,
    position: 0,
    assetCount: 0,
    childCollectionCount: 0,
  };
}

describe("filterDirectoryEntriesByName", () => {
  const entries = [
    folder("root", "Parent", null, 0),
    folder("child", "Child", "root", 1),
    folder("other", "Sibling", null, 0),
  ];

  it("keeps the match and its ancestors", () => {
    expect(filterDirectoryEntriesByName(entries, "chi").map((entry) => entry.folderId)).toEqual([
      "root",
      "child",
    ]);
  });

  it("returns every row for a blank query", () => {
    expect(filterDirectoryEntriesByName(entries, "  ")).toEqual(entries);
  });
});

describe("filterCollectionTreeByName", () => {
  const tree = new Map<string | null, CollectionSummary[]>([
    [null, [collection("parent", "Parent", null), collection("other", "Other", null)]],
    ["parent", [collection("child", "Child", "parent")]],
  ]);

  it("keeps a nested match and drops unrelated siblings", () => {
    const filtered = filterCollectionTreeByName(tree, "child");
    expect(filtered.get(null)?.map((item) => item.collectionId)).toEqual(["parent"]);
    expect(filtered.get("parent")?.map((item) => item.collectionId)).toEqual(["child"]);
    expect(filtered.has("other")).toBe(false);
  });
});
