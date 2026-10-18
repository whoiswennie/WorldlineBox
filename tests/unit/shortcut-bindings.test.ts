import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHORTCUT_BINDINGS,
  parseShortcutBindings,
  setShortcutOverride,
} from "../../src/shared/shortcut-bindings";
import {
  chordFromKeyboardEvent,
  findAllShortcutConflicts,
  findShortcutConflictsForChord,
  formatShortcutChord,
  matchesActionShortcut,
  matchesShortcutChord,
  reservedShortcutReason,
  resolveActionChords,
  validateShortcutChord,
  validateShortcutBindings,
} from "../../src/shared/shortcut-resolution";
import type { ShortcutChord } from "../../src/shared/shortcut-catalog";

const key = (
  value: string,
  modifiers: Partial<ShortcutChord> = {},
): ShortcutChord => ({
  key: value,
  code: /^[a-z]$/iu.test(value) ? `Key${value.toUpperCase()}` : value,
  ...modifiers,
});

const event = (
  value: string,
  code: string,
  modifiers: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key: value,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("shortcut bindings and resolution", () => {
  it("parses valid overrides and drops malformed entries", () => {
    const parsed = parseShortcutBindings({
      version: 1,
      platforms: {
        mac: {
          "asset.rename": { key: "F3", code: "F3" },
          "asset.move-to-trash": null,
          broken: { key: 42 },
        },
        windows: {},
      },
    });
    expect(parsed.platforms.mac["asset.rename"]).toEqual({ key: "F3", code: "F3" });
    expect(parsed.platforms.mac["asset.move-to-trash"]).toBeNull();
    expect(parsed.platforms.mac.broken).toBeUndefined();
  });

  it("drops overrides for fixed catalog actions", () => {
    const parsed = parseShortcutBindings({
      version: 1,
      platforms: {
        mac: {},
        windows: {
          "asset.view": { key: "F4", code: "F4" },
        },
      },
    });
    expect(parsed.platforms.windows["asset.view"]).toBeUndefined();
  });

  it("resolves defaults, overrides and explicit unassignment", () => {
    const defaultChords = resolveActionChords(
      "asset.rename",
      "windows",
      DEFAULT_SHORTCUT_BINDINGS,
    );
    expect(formatShortcutChord(defaultChords[0]!, "windows")).toBe("F2");

    const overridden = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "asset.rename",
      key("F3"),
    );
    expect(
      formatShortcutChord(
        resolveActionChords("asset.rename", "windows", overridden)[0]!,
        "windows",
      ),
    ).toBe("F3");

    const unassigned = setShortcutOverride(
      overridden,
      "windows",
      "asset.rename",
      null,
    );
    expect(resolveActionChords("asset.rename", "windows", unassigned)).toEqual([]);
  });

  it("matches platform chords exactly", () => {
    expect(
      matchesShortcutChord(key("F2"), event("F2", "F2")),
    ).toBe(true);
    expect(
      matchesShortcutChord(
        key("c", { metaKey: true, altKey: true }),
        event("c", "KeyC", { metaKey: true, altKey: true }),
      ),
    ).toBe(true);
    expect(
      matchesShortcutChord(
        key("c", { metaKey: true, altKey: true }),
        event("c", "KeyC", { metaKey: true }),
      ),
    ).toBe(false);
    expect(
      matchesActionShortcut(
        "folder.create-subfolder",
        event("n", "KeyN", { ctrlKey: true, shiftKey: true }),
        "windows",
        DEFAULT_SHORTCUT_BINDINGS,
      ),
    ).toBe(true);
  });

  it("has no conflicts in the default catalog on either platform", () => {
    expect(findAllShortcutConflicts("windows", DEFAULT_SHORTCUT_BINDINGS)).toEqual([]);
    expect(findAllShortcutConflicts("mac", DEFAULT_SHORTCUT_BINDINGS)).toEqual([]);
  });

  it("detects same-scope conflicts and allows disjoint scopes", () => {
    const folderRenameF5 = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "folder.rename",
      key("F5"),
    );
    // browse refresh and sidebar rename are disjoint by focus.
    expect(
      findShortcutConflictsForChord(
        "folder.rename",
        key("F5"),
        "windows",
        folderRenameF5,
      ),
    ).toEqual([]);

    const folderRenameSearch = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "folder.rename",
      key("f", { ctrlKey: true }),
    );
    expect(
      findShortcutConflictsForChord(
        "folder.rename",
        key("f", { ctrlKey: true }),
        "windows",
        folderRenameSearch,
      ).map((conflict) => conflict.actionId),
    ).toContain("workspace.focus-search");

    const assetRenameF5 = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "asset.rename",
      key("F5"),
    );
    expect(
      findAllShortcutConflicts("windows", assetRenameF5).map(
        (conflict) => conflict.actionId,
      ),
    ).toEqual(expect.arrayContaining(["asset.rename", "canvas.refresh"]));
  });

  it("rejects reserved, modifier-only and bare-letter chords", () => {
    expect(reservedShortcutReason(key("q", { metaKey: true }), "mac")).toBe("system");
    expect(reservedShortcutReason(key("F4", { altKey: true }), "windows")).toBe("system");
    expect(
      validateShortcutChord(key("s", { ctrlKey: true }), "windows", ["browse"]),
    ).toBeNull();
    expect(
      validateShortcutChord(key("s"), "windows", ["browse"]),
    ).toBe("bare-key");
    expect(
      validateShortcutChord(key("F2"), "windows", ["browse"]),
    ).toBeNull();
    expect(
      validateShortcutChord(key("Delete"), "windows", ["browse"]),
    ).toBeNull();
    expect(
      validateShortcutChord(key("Shift"), "windows", ["browse"]),
    ).toBe("modifier-only");
  });

  it("requires a Main IME route for bare-letter viewer bindings", () => {
    const bindings = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "viewer.fit",
      key("g"),
    );
    expect(validateShortcutBindings(bindings, "windows")).toBe("invalid-shortcut-chord");
  });

  it("reserves native Cut and Paste-and-Match-Style accelerators", () => {
    expect(
      validateShortcutChord(key("x", { metaKey: true }), "mac", ["app"]),
    ).toBe("system");
    expect(
      validateShortcutChord(
        key("v", { metaKey: true, altKey: true, shiftKey: true }),
        "mac",
        ["app"],
      ),
    ).toBe("system");
    expect(
      validateShortcutChord(key("x", { ctrlKey: true }), "windows", ["app"]),
    ).toBe("system");
    expect(
      validateShortcutChord(
        key("v", { ctrlKey: true, shiftKey: true }),
        "windows",
        ["app"],
      ),
    ).toBe("system");
    const editCut = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "mac",
      "edit.undo",
      key("x", { metaKey: true }),
    );
    const pasteMatchStyle = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "mac",
      "edit.redo",
      key("v", { metaKey: true, altKey: true, shiftKey: true }),
    );
    expect(validateShortcutBindings(editCut, "mac")).toBe("invalid-shortcut-chord");
    expect(validateShortcutBindings(pasteMatchStyle, "mac")).toBe("invalid-shortcut-chord");
  });

  it("recovers a letter chord from an IME Process event", () => {
    expect(
      chordFromKeyboardEvent({
        key: "Process",
        code: "KeyD",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ key: "d", code: "KeyD" });
  });
});
