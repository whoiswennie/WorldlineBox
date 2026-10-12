import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeLinkedVirtualFolderId } from '../../src/shared/linked-folder-tree';
import { LibraryService, type LibraryServiceError } from '../../src/worker/library-service';

const temporaryRoots: string[] = [];
const services: LibraryService[] = [];

function newService(): LibraryService {
  const service = new LibraryService();
  services.push(service);
  return service;
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-appearance-'));
  temporaryRoots.push(root);
  return root;
}

function expectServiceCode(operation: () => unknown, code: LibraryServiceError['code']): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('entity appearance', () => {
  it('stores catalog appearance on folders and collections without renaming disk', () => {
    const root = temporaryRoot();
    const service = newService();
    const library = service.createLibrary({ displayName: 'Appearance', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Props' });
    const folderPath = path.join(library.libraryPath, 'Assets', 'Props');
    expect(existsSync(folderPath)).toBe(true);

    expect(service.listManagedFolders(library.libraryId)[0]?.appearance).toBeNull();

    const updated = service.setEntityAppearance({
      libraryId: library.libraryId,
      target: { kind: 'managed-folder', id: folder.folderId },
      appearance: { glyphKind: 'emoji', glyphValue: '🎨', colorId: 'blue' },
    });
    expect(updated.appearance).toEqual({
      glyphKind: 'emoji',
      glyphValue: '🎨',
      colorId: 'blue',
    });
    expect(service.listManagedFolders(library.libraryId)[0]?.appearance).toEqual(updated.appearance);
    expect(existsSync(folderPath)).toBe(true);
    const renamed = service.renameManagedFolder({
      libraryId: library.libraryId,
      folderId: folder.folderId,
      newName: 'HeroProps',
    });
    expect(renamed.appearance).toEqual(updated.appearance);
    expect(existsSync(path.join(library.libraryPath, 'Assets', 'HeroProps'))).toBe(true);

    const collection = service.createCollection({ libraryId: library.libraryId, name: 'Ready' });
    service.setEntityAppearance({
      libraryId: library.libraryId,
      target: { kind: 'collection', id: collection.collectionId },
      appearance: { glyphKind: 'icon', glyphValue: 'star', colorId: 'orange' },
    });
    expect(service.listCollections(library.libraryId)[0]?.appearance).toEqual({
      glyphKind: 'icon',
      glyphValue: 'star',
      colorId: 'orange',
    });

    const smart = service.createSmartCollection({
      libraryId: library.libraryId,
      name: 'Favorites',
      queryDefinitionJson: JSON.stringify({ filters: [{ field: 'favorite', values: [], exclude: false }] }),
    });
    service.setEntityAppearance({
      libraryId: library.libraryId,
      target: { kind: 'smart-collection', id: smart.collectionId },
      appearance: { glyphKind: null, glyphValue: null, colorId: 'teal' },
    });
    expect(service.listSmartCollections(library.libraryId)[0]?.appearance).toEqual({
      glyphKind: null,
      glyphValue: null,
      colorId: 'teal',
    });

    service.setEntityAppearance({
      libraryId: library.libraryId,
      target: { kind: 'managed-folder', id: folder.folderId },
      appearance: null,
    });
    expect(service.listManagedFolders(library.libraryId)[0]?.appearance).toBeNull();
    expect(existsSync(path.join(library.libraryPath, 'Assets', 'HeroProps'))).toBe(true);
  });

  it('rejects unknown catalog values and missing targets', () => {
    const root = temporaryRoot();
    const service = newService();
    const library = service.createLibrary({ displayName: 'AppearanceGuard', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Guard' });

    expectServiceCode(
      () => service.setEntityAppearance({
        libraryId: library.libraryId,
        target: { kind: 'managed-folder', id: folder.folderId },
        appearance: { glyphKind: 'icon', glyphValue: 'trash', colorId: null },
      }),
      'INVALID_APPEARANCE',
    );
    expectServiceCode(
      () => service.setEntityAppearance({
        libraryId: library.libraryId,
        target: { kind: 'managed-folder', id: 'missing-folder' },
        appearance: { glyphKind: 'emoji', glyphValue: '🎨', colorId: null },
      }),
      'FOLDER_NOT_FOUND',
    );
    expect(service.listManagedFolders(library.libraryId)[0]?.appearance).toBeNull();
  });

  it('allows linked roots and rejects virtual linked children', () => {
    const root = temporaryRoot();
    const sourceRoot = path.join(root, 'source');
    mkdirSync(path.join(sourceRoot, 'sub'), { recursive: true });
    writeFileSync(path.join(sourceRoot, 'a.png'), 'aaaa');
    writeFileSync(path.join(sourceRoot, 'sub', 'b.png'), 'bbbb');

    const service = newService();
    const library = service.createLibrary({ displayName: 'LinkedAppearance', selectedParentPath: root });
    const linked = service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: sourceRoot,
    });

    service.setEntityAppearance({
      libraryId: library.libraryId,
      target: { kind: 'linked-folder', id: linked.folderId },
      appearance: { glyphKind: 'icon', glyphValue: 'globe', colorId: 'green' },
    });
    const listed = service.listLinkedFolders(library.libraryId);
    const rootSummary = listed.find((folder) => folder.folderId === linked.folderId);
    const child = listed.find((folder) => folder.relativePath === 'sub');
    expect(rootSummary?.appearance).toEqual({
      glyphKind: 'icon',
      glyphValue: 'globe',
      colorId: 'green',
    });
    expect(child?.appearance ?? null).toBeNull();
    expectServiceCode(
      () => service.setEntityAppearance({
        libraryId: library.libraryId,
        target: {
          kind: 'linked-folder',
          id: encodeLinkedVirtualFolderId(linked.folderId, 'sub'),
        },
        appearance: { glyphKind: 'emoji', glyphValue: '🏠', colorId: null },
      }),
      'FOLDER_NOT_FOUND',
    );
  });
});
