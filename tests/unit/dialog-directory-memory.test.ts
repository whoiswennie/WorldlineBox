import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  rememberDialogSelection,
  rememberedDialogDirectory,
  resetDialogDirectoryMemory,
  resolveDialogDefaultPath,
} from "../../src/main/dialog-directory-memory";

afterEach(() => {
  resetDialogDirectoryMemory();
});

describe("dialog directory memory", () => {
  it("opens the next panel in the directory chosen last time", () => {
    rememberDialogSelection(path.join("Volumes", "media", "refs"), "directory");
    expect(rememberedDialogDirectory()).toBe(path.join("Volumes", "media", "refs"));
    expect(resolveDialogDefaultPath(undefined)).toBe(
      path.join("Volumes", "media", "refs"),
    );
  });

  it("remembers the parent when the selection is a file", () => {
    rememberDialogSelection(path.join("Volumes", "media", "cover.png"), "file");
    expect(rememberedDialogDirectory()).toBe(path.join("Volumes", "media"));
  });

  it("keeps an absolute default path and joins a bare file name", () => {
    rememberDialogSelection(path.join("Volumes", "media"), "directory");
    expect(resolveDialogDefaultPath(path.resolve("elsewhere"))).toBe(
      path.resolve("elsewhere"),
    );
    expect(resolveDialogDefaultPath("notes.txt")).toBe(
      path.join("Volumes", "media", "notes.txt"),
    );
  });
});
