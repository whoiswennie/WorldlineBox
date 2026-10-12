import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LibraryService } from "../../src/worker/library-service";

const roots: string[] = [];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-folder-cover-"));
  roots.push(root);
  const service = new LibraryService();
  const library = service.createLibrary({
    displayName: "Covers",
    selectedParentPath: root,
  });
  return { library, root, service };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("folder custom covers", () => {
  it("stores a chosen image with the folder and restores the automatic cover when cleared", () => {
    const { library, root, service } = fixture();
    const folder = service.createManagedFolder({
      libraryId: library.libraryId,
      name: "Painted",
    });
    const source = path.join(root, "picked.png");
    writeFileSync(source, PNG);

    const set = service.setFolderCustomCovers({
      libraryId: library.libraryId,
      folderIds: [folder.folderId],
      sourcePath: source,
    });
    expect(set.hasCustomCover).toBe(true);

    const listed = service.listFolderBrowseEntries({
      libraryId: library.libraryId,
      parentFolderId: null,
    });
    const entry = listed.find((item) => item.folderId === folder.folderId);
    expect(entry?.hasCustomCover).toBe(true);
    expect(entry?.customCoverToken).toBeTruthy();
    const resolved = service.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.absolutePath.includes(`${path.sep}.worldlinebox${path.sep}folder-covers${path.sep}`)).toBe(true);
    expect(existsSync(resolved!.absolutePath)).toBe(true);

    service.clearFolderCustomCovers({
      libraryId: library.libraryId,
      folderIds: [folder.folderId],
    });
    const cleared = service.listFolderBrowseEntries({
      libraryId: library.libraryId,
      parentFolderId: null,
    }).find((item) => item.folderId === folder.folderId);
    expect(cleared?.hasCustomCover).toBeUndefined();
    expect(service.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    })).toBeNull();
    expect(existsSync(resolved!.absolutePath)).toBe(false);
  });
});
