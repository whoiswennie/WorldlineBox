import { describe, expect, it } from "vitest";

import { matchWindowFullscreenShortcut } from "../../src/shared/window-fullscreen-shortcut";
import { findPlatformShortcut } from "../../src/shared/platform-shortcut-table";
import { matchesShortcut } from "../../src/renderer/commands/command-types";

describe("window fullscreen shortcut (WorldlineBox-692279)", () => {
  it("matches unmodified F11 on Windows and Linux", () => {
    expect(
      matchWindowFullscreenShortcut({ key: "F11", code: "F11" }, "win32"),
    ).toBe(true);
    expect(
      matchWindowFullscreenShortcut({ keyCode: 122 }, "win32"),
    ).toBe(true);
    expect(
      matchWindowFullscreenShortcut({ key: "F11" }, "linux"),
    ).toBe(true);
    expect(
      matchWindowFullscreenShortcut({ key: "F11", control: true }, "win32"),
    ).toBe(false);
    expect(
      matchWindowFullscreenShortcut({ key: "F11" }, "darwin"),
    ).toBe(false);
  });

  it("matches Control+Command+F on macOS and not a bare F", () => {
    expect(
      matchWindowFullscreenShortcut(
        { key: "f", control: true, meta: true },
        "darwin",
      ),
    ).toBe(true);
    expect(
      matchWindowFullscreenShortcut({ key: "f", meta: true }, "darwin"),
    ).toBe(false);
    expect(
      matchWindowFullscreenShortcut({ key: "f" }, "darwin"),
    ).toBe(false);
    expect(
      matchWindowFullscreenShortcut(
        { key: "f", control: true, meta: true },
        "win32",
      ),
    ).toBe(false);
  });

  it("keeps the QA table aligned with matcher chords", () => {
    const row = findPlatformShortcut("window.toggle-fullscreen");
    expect(row?.windows.label).toBe("F11");
    expect(row?.mac.label).toBe("⌃⌘F");
    expect(
      matchesShortcut(
        { mac: row!.mac, windows: row!.windows },
        {
          key: "F11",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "windows",
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        { mac: row!.mac, windows: row!.windows },
        {
          key: "f",
          metaKey: true,
          ctrlKey: true,
          altKey: false,
          shiftKey: false,
        },
        "mac",
      ),
    ).toBe(true);
  });
});
