import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readShortcutBindings,
  shortcutBindingsFilePath,
  writeShortcutBindings,
} from "../../src/main/shortcut-bindings-store";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  setShortcutOverride,
} from "../../src/shared/shortcut-bindings";

let tempDirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "worldlinebox-shortcuts-"));
  tempDirs.push(dir);
  return shortcutBindingsFilePath(dir);
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("shortcut bindings store", () => {
  it("round-trips overrides and falls back on corrupt data", () => {
    const file = tempFile();
    const bindings = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "asset.rename",
      { key: "F3", code: "F3" },
    );
    writeShortcutBindings(file, bindings);
    expect(readShortcutBindings(file)).toEqual(bindings);

    writeFileSync(file, "{not-json", "utf8");
    expect(readShortcutBindings(file)).toEqual(DEFAULT_SHORTCUT_BINDINGS);
  });
});
