import { describe, expect, it } from "vitest";

import {
  buildShortcutRows,
  countShortcutRows,
  filterShortcutRows,
  groupShortcutRows,
  matchesShortcutQuery,
} from "../../src/renderer/shortcut-settings-model";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  setShortcutOverride,
} from "../../src/shared/shortcut-bindings";

describe("shortcut settings model", () => {
  it("builds rows, counts modified and unassigned actions", () => {
    let bindings = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "asset.rename",
      { key: "F3", code: "F3" },
    );
    bindings = setShortcutOverride(bindings, "windows", "folder.rename", null);

    const rows = buildShortcutRows("windows", bindings);
    expect(rows.length).toBeGreaterThan(10);
    expect(countShortcutRows(rows).modified).toBe(2);
    expect(rows.find((row) => row.action.id === "folder.rename")?.unassigned).toBe(true);
    expect(filterShortcutRows(rows, "modified")).toHaveLength(2);
  });

  it("filters and groups by label and scope", () => {
    const rows = buildShortcutRows("windows", DEFAULT_SHORTCUT_BINDINGS);
    const rename = rows.find((row) => row.action.id === "asset.rename")!;
    expect(matchesShortcutQuery(rename, "F2", "重命名资产", "浏览")).toBe(true);
    expect(matchesShortcutQuery(rename, "不存在", "重命名资产", "浏览")).toBe(false);
    expect(groupShortcutRows(rows).map((group) => group.category)).toEqual([
      "asset",
      "folder",
      "collection",
      "app",
      "viewer",
    ]);
  });

  it("marks conflicts in the row model", () => {
    const bindings = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "asset.rename",
      { key: "F5", code: "F5" },
    );
    const rows = buildShortcutRows("windows", bindings);
    expect(rows.find((row) => row.action.id === "asset.rename")?.conflicts.length)
      .toBeGreaterThan(0);
    expect(countShortcutRows(rows).conflicts).toBeGreaterThan(0);
  });
});
