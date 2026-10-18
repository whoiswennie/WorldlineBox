import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assetParentFolderCoverTarget } from "../../src/shared/folder-cover-target";
import { LibraryService } from "../../src/worker/library-service";

const require = createRequire(import.meta.url);
const TestDatabase = require("better-sqlite3") as new (filename: string) => {
  exec(source: string): void;
  prepare(source: string): { run(...parameters: unknown[]): unknown };
  close(): void;
};

const roots: string[] = [];
const services: LibraryService[] = [];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-folder-cover-"));
  roots.push(root);
  const service = new LibraryService();
  services.push(service);
  const library = service.createLibrary({
    displayName: "Covers",
    selectedParentPath: root,
  });
  return { library, root, service };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.closeAllAsync()));
  for (const root of roots.splice(0)) {
    // Let Windows deliver watcher/handle-close callbacks between bounded retries.
    await rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("folder custom covers", () => {
  it("upgrades a v57 WorldlineBox cover without changing its stored image", () => {
    const { library, root, service } = fixture();
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: "Existing" });
    const source = path.join(root, "old-cover.png");
    writeFileSync(source, PNG);
    service.setFolderCustomCovers({
      libraryId: library.libraryId,
      folderIds: [folder.folderId],
      sourcePath: source,
    });
    const before = service.resolveFolderCustomCover({ libraryId: library.libraryId, folderId: folder.folderId });
    service.closeAll();
    const database = new TestDatabase(path.join(library.libraryPath, ".worldlinebox", "library.db"));
    try {
      database.exec("ALTER TABLE folder_custom_covers DROP COLUMN cover_asset_id");
      database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(58);
      database.exec("PRAGMA user_version = 57");
    } finally {
      database.close();
    }
    unlinkSync(source);

    service.openLibrary(library.libraryPath);
    const after = service.resolveFolderCustomCover({ libraryId: library.libraryId, folderId: folder.folderId });
    expect(after).toEqual(before);
    expect(existsSync(after!.absolutePath)).toBe(true);
    expect(service.listFolderBrowseEntries({ libraryId: library.libraryId, parentFolderId: null }))
      .toContainEqual(expect.objectContaining({ folderId: folder.folderId, hasCustomCover: true }));
  });

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

  it("keeps a copied cover after the original file is removed and the library is reopened", () => {
    const { library, root, service } = fixture();
    const folder = service.createManagedFolder({
      libraryId: library.libraryId,
      name: "Kept",
    });
    const source = path.join(root, "outside.png");
    writeFileSync(source, PNG);
    service.setFolderCustomCovers({
      libraryId: library.libraryId,
      folderIds: [folder.folderId],
      sourcePath: source,
    });
    const stored = service.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    });
    expect(stored).not.toBeNull();
    unlinkSync(source);
    service.closeAll();

    const reopened = new LibraryService();
    reopened.openLibrary(library.libraryPath);
    const resolved = reopened.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    });
    expect(resolved?.absolutePath).toBe(stored!.absolutePath);
    expect(existsSync(resolved!.absolutePath)).toBe(true);
    const entry = reopened.listFolderBrowseEntries({
      libraryId: library.libraryId,
      parentFolderId: null,
    }).find((item) => item.folderId === folder.folderId);
    expect(entry?.hasCustomCover).toBe(true);
    expect(entry?.customCoverAssetId).toBeUndefined();
    reopened.closeAll();
  });

  it("stores a library image as the cover and drops it when that asset is gone", () => {
    const { library, root, service } = fixture();
    const folder = service.createManagedFolder({
      libraryId: library.libraryId,
      name: "Referenced",
    });
    const source = path.join(root, "library.png");
    writeFileSync(source, PNG);
    const imported = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      targetFolderId: folder.folderId,
      sourceKind: "files",
      sourcePaths: [source],
    });
    if ("importId" in imported) throw new Error("unexpected conflict plan");
    const asset = imported.assets[0]!;
    const notes = path.join(root, "notes.txt");
    writeFileSync(notes, "not an image");
    const textImport = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      targetFolderId: folder.folderId,
      sourceKind: "files",
      sourcePaths: [notes],
    });
    if ("importId" in textImport) throw new Error("unexpected conflict plan");

    expect(() => service.setFolderCustomCoverFromAsset({
      libraryId: library.libraryId,
      folderIds: [folder.folderId],
      assetId: textImport.assets[0]!.assetId,
    })).toThrow(/FOLDER_COVER_UNSUPPORTED/);

    service.setFolderCustomCoverFromAsset({
      libraryId: library.libraryId,
      folderIds: [folder.folderId],
      assetId: asset.assetId,
    });
    const listed = service.listFolderBrowseEntries({
      libraryId: library.libraryId,
      parentFolderId: null,
    }).find((item) => item.folderId === folder.folderId);
    expect(listed?.hasCustomCover).toBe(true);
    expect(listed?.customCoverAssetId).toBe(asset.assetId);
    expect(listed?.customCoverSourcePreview?.revisionId).toBe(asset.currentRevisionId);
    expect(service.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    })).toBeNull();
    const navigation = service.getLibraryNavigationSummary({ libraryId: library.libraryId });
    expect(navigation.folderCovers).toEqual([
      expect.objectContaining({
        folderId: folder.folderId,
        assetId: asset.assetId,
        revisionId: asset.currentRevisionId,
      }),
    ]);

    service.closeAll();
    const reopened = new LibraryService();
    reopened.openLibrary(library.libraryPath);
    const restored = reopened.listFolderBrowseEntries({
      libraryId: library.libraryId,
      parentFolderId: null,
    }).find((item) => item.folderId === folder.folderId);
    expect(restored?.customCoverAssetId).toBe(asset.assetId);

    reopened.closeAll();
    const database = new TestDatabase(path.join(library.libraryPath, ".worldlinebox", "library.db"));
    database.prepare(`UPDATE assets SET deleted_at = ? WHERE asset_id = ?`).run(
      new Date().toISOString(),
      asset.assetId,
    );
    database.close();

    const afterDelete = new LibraryService();
    afterDelete.openLibrary(library.libraryPath);
    const cleared = afterDelete.listFolderBrowseEntries({
      libraryId: library.libraryId,
      parentFolderId: null,
    }).find((item) => item.folderId === folder.folderId);
    expect(cleared?.hasCustomCover).toBeUndefined();
    expect(afterDelete.getLibraryNavigationSummary({
      libraryId: library.libraryId,
    }).folderCovers).toEqual([]);
    afterDelete.closeAll();
  });

  it("replaces a file cover only after the new file is stored, and an asset cover does the same", () => {
    const { library, root, service } = fixture();
    const folder = service.createManagedFolder({
      libraryId: library.libraryId,
      name: "Replace",
    });
    const first = path.join(root, "first.png");
    const second = path.join(root, "second.jpg");
    const secondBytes = Buffer.concat([PNG, Buffer.from("next")]);
    writeFileSync(first, PNG);
    writeFileSync(second, secondBytes);
    service.setFolderCustomCovers({
      libraryId: library.libraryId,
      folderIds: [folder.folderId],
      sourcePath: first,
    });
    const previous = service.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    });
    expect(previous).not.toBeNull();

    service.setFolderCustomCovers({
      libraryId: library.libraryId,
      folderIds: [folder.folderId],
      sourcePath: second,
    });
    const replaced = service.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    });
    expect(replaced).not.toBeNull();
    expect(replaced!.absolutePath).not.toBe(previous!.absolutePath);
    expect(existsSync(previous!.absolutePath)).toBe(false);
    expect(existsSync(replaced!.absolutePath)).toBe(true);

    const imported = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      targetFolderId: folder.folderId,
      sourceKind: "files",
      sourcePaths: [first],
    });
    if ("importId" in imported) throw new Error("unexpected conflict plan");
    const asset = imported.assets[0]!;
    expect(assetParentFolderCoverTarget(asset)).toBe(folder.folderId);
    const fileBeforeAsset = service.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    });
    expect(fileBeforeAsset).not.toBeNull();
    service.setFolderCustomCoverFromAsset({
      libraryId: library.libraryId,
      folderIds: [assetParentFolderCoverTarget(asset)!],
      assetId: asset.assetId,
    });
    expect(existsSync(fileBeforeAsset!.absolutePath)).toBe(false);
    const listed = service.listFolderBrowseEntries({
      libraryId: library.libraryId,
      parentFolderId: null,
    }).find((item) => item.folderId === folder.folderId);
    expect(listed?.customCoverAssetId).toBe(asset.assetId);
    expect(service.resolveFolderCustomCover({
      libraryId: library.libraryId,
      folderId: folder.folderId,
    })).toBeNull();
  });
});
