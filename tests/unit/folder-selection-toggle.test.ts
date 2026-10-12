import { describe, expect, it } from "vitest";

import { toggleFolderMultiSelection } from "../../src/renderer/folder-selection-toggle";

// WorldlineBox-d7acfa：Ctrl/⌘ 点击文件夹时的选区（当前打开的文件夹是隐式选中的）。
describe("toggle folder multi selection", () => {
  it("appends the clicked folder when nothing is selected", () => {
    expect(toggleFolderMultiSelection([], "b")).toEqual(["b"]);
    expect(toggleFolderMultiSelection(["b"], "c")).toEqual(["b", "c"]);
  });

  it("removes a folder that is already selected", () => {
    expect(toggleFolderMultiSelection(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleFolderMultiSelection(["a"], "a")).toEqual([]);
  });

  it("includes the folder being browsed on the first ctrl+click", () => {
    // 用户口径：当前文件夹是 A，Ctrl+点 B → A 和 B 同时被选中。
    expect(
      toggleFolderMultiSelection([], "b", { openFolderId: "a" }),
    ).toEqual(["a", "b"]);
    // 第二次点击只追加/切换，不会再把 A 拉回来。
    expect(
      toggleFolderMultiSelection(["a", "b"], "c", { openFolderId: "a" }),
    ).toEqual(["a", "b", "c"]);
    expect(
      toggleFolderMultiSelection(["a", "b"], "b", { openFolderId: "a" }),
    ).toEqual(["a"]);
  });

  it("does not seed when there is no browsed folder", () => {
    expect(toggleFolderMultiSelection([], "b", { openFolderId: null })).toEqual(["b"]);
    expect(toggleFolderMultiSelection([], "b")).toEqual(["b"]);
  });

  it("does not seed the folder that was just clicked", () => {
    expect(toggleFolderMultiSelection([], "a", { openFolderId: "a" })).toEqual(["a"]);
  });

  it("does not seed a folder that is not selectable right now", () => {
    expect(
      toggleFolderMultiSelection([], "b", {
        openFolderId: "deleted",
        isSelectable: () => false,
      }),
    ).toEqual(["b"]);
    expect(
      toggleFolderMultiSelection([], "b", {
        openFolderId: "a",
        isSelectable: (id) => id === "b",
      }),
    ).toEqual(["b"]);
  });
});
