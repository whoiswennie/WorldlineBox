import { describe, expect, it, beforeEach } from "vitest";

import {
  matchBrowseKeyboardShortcut,
} from "../../src/shared/browse-keyboard-shortcuts";
import { SHORTCUT_BINDINGS_VERSION } from "../../src/shared/shortcut-bindings";
import {
  resetBrowseShortcutForwardForTests,
  shouldForwardBrowseShortcut,
} from "../../src/shared/browse-shortcut-dedupe";

describe("matchBrowseKeyboardShortcut", () => {
  it("matches F2 / Delete / Shift+Delete without modifiers", () => {
    expect(matchBrowseKeyboardShortcut({ key: "F2", code: "F2" })).toBe(
      "rename",
    );
    expect(matchBrowseKeyboardShortcut({ key: "Delete" })).toBe("trash");
    expect(matchBrowseKeyboardShortcut({ key: "Del" })).toBe("trash");
    expect(
      matchBrowseKeyboardShortcut({ key: "Delete", shift: true }),
    ).toBe("disk-delete");
  });

  it("matches the copy-path chords and still ignores other modified keys", () => {
    expect(
      matchBrowseKeyboardShortcut({
        key: "c",
        code: "KeyC",
        control: true,
        shift: true,
      }),
    ).toBe("copy-path");
    expect(
      matchBrowseKeyboardShortcut({
        key: "c",
        code: "KeyC",
        meta: true,
        alt: true,
      }),
    ).toBe("copy-path");
    expect(
      matchBrowseKeyboardShortcut({ key: "Delete", control: true }),
    ).toBeNull();
    expect(matchBrowseKeyboardShortcut({ key: "F2", meta: true })).toBeNull();
    expect(matchBrowseKeyboardShortcut({ key: "c", control: true })).toBeNull();
  });

  it("uses a customized copy-path chord and stops claiming the default", () => {
    const bindings = {
      version: SHORTCUT_BINDINGS_VERSION,
      platforms: {
        mac: {},
        windows: {
          "asset.copy-file-path": {
            key: "p",
            code: "KeyP",
            ctrlKey: true,
            altKey: true,
          },
          "folder.copy-path": {
            key: "p",
            code: "KeyP",
            ctrlKey: true,
            altKey: true,
          },
        },
      },
    };
    const options = { bindings, platform: "windows" as const };
    expect(
      matchBrowseKeyboardShortcut(
        { key: "p", code: "KeyP", control: true, alt: true },
        options,
      ),
    ).toBe("copy-path");
    expect(
      matchBrowseKeyboardShortcut(
        { key: "c", code: "KeyC", control: true, shift: true },
        options,
      ),
    ).toBeNull();
  });
});

describe("shouldForwardBrowseShortcut", () => {
  beforeEach(() => {
    resetBrowseShortcutForwardForTests();
  });

  it("dedupes the same action within 50ms", () => {
    expect(shouldForwardBrowseShortcut("rename", 1000)).toBe(true);
    expect(shouldForwardBrowseShortcut("rename", 1020)).toBe(false);
    expect(shouldForwardBrowseShortcut("trash", 1025)).toBe(true);
    expect(shouldForwardBrowseShortcut("rename", 1130)).toBe(true);
  });
});
