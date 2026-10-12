import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  folderCoverAbsolutePath,
  folderCoverFitsOnDisk,
  folderCoverStoredExtension,
  installFolderCoverFile,
  removeFolderCoverFile,
} from "../../src/worker/folder-custom-cover";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("folder custom cover files", () => {
  it("keeps a copied image inside the library and deletes it on clear", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-cover-"));
    const libraryPath = path.join(root, "library");
    mkdirSync(libraryPath);
    const source = path.join(root, "picked.png");
    writeFileSync(source, PNG);
    expect(folderCoverStoredExtension(source)).toBe(".png");
    expect(folderCoverStoredExtension(path.join(root, "notes.txt"))).toBeNull();
    expect(folderCoverFitsOnDisk(root, source)).toBe(true);

    const relative = installFolderCoverFile({
      libraryPath,
      folderKey: "lfv:root/nested/name",
      sourcePath: source,
    });
    expect(relative.startsWith("folder-covers/")).toBe(true);
    expect(relative.includes("\\")).toBe(false);
    const stored = folderCoverAbsolutePath(libraryPath, relative);
    expect(stored.startsWith(path.resolve(libraryPath, ".worldlinebox"))).toBe(true);
    expect(() => folderCoverAbsolutePath(libraryPath, path.join("..", "outside.png"))).toThrow();

    removeFolderCoverFile(libraryPath, relative);
    expect(existsSync(stored)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
