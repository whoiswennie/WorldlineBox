import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  commitReplacingFolderCoverFiles,
  folderCoverAbsolutePath,
  folderCoverFitsOnDisk,
  folderCoverStoredExtension,
  installFolderCoverFile,
  listStaleFolderCoverFiles,
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

  it("rejects paths outside .worldlinebox/folder-covers and never deletes them", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-cover-jail-"));
    const libraryPath = path.join(root, "library");
    mkdirSync(path.join(libraryPath, ".worldlinebox"), { recursive: true });
    const database = path.join(libraryPath, ".worldlinebox", "library.db");
    writeFileSync(database, "KEEP");
    const outside = path.join(libraryPath, "outside.png");
    writeFileSync(outside, PNG);
    const allowed = folderCoverAbsolutePath(libraryPath, "folder-covers/abc.png");
    expect(allowed.startsWith(path.resolve(libraryPath, ".worldlinebox", "folder-covers") + path.sep)).toBe(true);

    const rejected = [
      "",
      ".",
      "..",
      "library.db",
      "folder-covers",
      "folder-covers/",
      "folder-covers/../library.db",
      path.join("..", "outside.png"),
      database,
      "folder-covers/library.db",
    ];
    for (const relativeName of rejected) {
      expect(() => folderCoverAbsolutePath(libraryPath, relativeName)).toThrow(/escaped/);
      removeFolderCoverFile(libraryPath, relativeName);
    }
    expect(readFileSync(database, "utf8")).toBe("KEEP");
    expect(existsSync(outside)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the replacement before deleting the previous cover, and keeps the previous file if commit fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-cover-replace-"));
    const libraryPath = path.join(root, "library");
    mkdirSync(libraryPath);
    const firstSource = path.join(root, "first.png");
    const secondSource = path.join(root, "second.png");
    const secondBytes = Buffer.concat([PNG, Buffer.from("next")]);
    writeFileSync(firstSource, PNG);
    writeFileSync(secondSource, secondBytes);

    const previous = installFolderCoverFile({
      libraryPath,
      folderKey: "folder-a",
      sourcePath: firstSource,
    });
    const previousPath = folderCoverAbsolutePath(libraryPath, previous);
    const staged = installFolderCoverFile({
      libraryPath,
      folderKey: "folder-a",
      sourcePath: secondSource,
      previousRelativeName: previous,
    });
    const stagedPath = folderCoverAbsolutePath(libraryPath, staged);
    expect(staged).not.toBe(previous);
    expect(readFileSync(previousPath)).toEqual(PNG);
    expect(readFileSync(stagedPath)).toEqual(secondBytes);

    expect(() => commitReplacingFolderCoverFiles({
      libraryPath,
      stagedRelativeNames: [staged],
      previousRelativeNames: [previous],
      commit: () => {
        throw new Error("commit failed");
      },
    })).toThrow(/commit failed/);
    expect(existsSync(previousPath)).toBe(true);
    expect(readFileSync(previousPath)).toEqual(PNG);
    expect(existsSync(stagedPath)).toBe(false);

    const replacement = installFolderCoverFile({
      libraryPath,
      folderKey: "folder-a",
      sourcePath: secondSource,
      previousRelativeName: previous,
    });
    commitReplacingFolderCoverFiles({
      libraryPath,
      stagedRelativeNames: [replacement],
      previousRelativeNames: [previous],
      commit: () => undefined,
    });
    expect(existsSync(previousPath)).toBe(false);
    expect(readFileSync(folderCoverAbsolutePath(libraryPath, replacement))).toEqual(secondBytes);
    rmSync(root, { recursive: true, force: true });
  });

  it("lists unreferenced cover files and leaves the catalog database alone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-cover-stale-"));
    const libraryPath = path.join(root, "library");
    mkdirSync(path.join(libraryPath, ".worldlinebox"), { recursive: true });
    writeFileSync(path.join(libraryPath, ".worldlinebox", "library.db"), "KEEP");
    const source = path.join(root, "kept.png");
    writeFileSync(source, PNG);
    const referenced = installFolderCoverFile({
      libraryPath,
      folderKey: "folder-a",
      sourcePath: source,
    });
    const orphan = folderCoverAbsolutePath(libraryPath, "folder-covers/orphan.png");
    writeFileSync(orphan, PNG);
    expect(listStaleFolderCoverFiles(libraryPath, new Set([referenced]), 60_000)).toEqual([]);
    const past = new Date(Date.now() - 5_000);
    utimesSync(orphan, past, past);
    expect(listStaleFolderCoverFiles(libraryPath, new Set([referenced]), 0)).toEqual([
      "folder-covers/orphan.png",
    ]);
    expect(readFileSync(path.join(libraryPath, ".worldlinebox", "library.db"), "utf8")).toBe("KEEP");
    rmSync(root, { recursive: true, force: true });
  });
});
