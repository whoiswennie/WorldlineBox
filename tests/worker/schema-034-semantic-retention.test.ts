import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LibraryService, openConfiguredDatabase, SUPPORTED_SCHEMA_VERSION } from '../../src/worker/library-service';
import { SemanticIndexStore } from '../../src/worker/semantic-index-store';
import { removeLinkedDirectoryIndexFixture } from './remove-linked-directory-index';
import { importNoConflict } from './import-no-conflict';

const roots: string[] = [];
const services: LibraryService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('migrates a v59 library without changing the builtin 768-dimensional semantic index', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-schema-034-'));
  roots.push(root);
  const service = new LibraryService({ observerFactory: () => ({ close() {} }) });
  services.push(service);
  const library = service.createLibrary({ displayName: 'Semantic migration', selectedParentPath: root });
  const source = path.join(root, 'note.txt');
  writeFileSync(source, 'A retained semantic asset');
  importNoConflict(service, library.libraryId, source);
  const asset = service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!;
  service.setAssetMetadata({ libraryId: library.libraryId, assetId: asset.assetId,
    expectedVersion: 0, description: 'Keep this description', favorite: true });
  service.closeAll();

  const store = new SemanticIndexStore({ libraryId: library.libraryId, libraryPath: library.libraryPath,
    storageKind: 'local' });
  const profileId = store.ensureProfile({ profileKey: 'builtin-model', dimensions: 768,
    modelRevision: 'retained-model-revision', modality: 'mixed' });
  const vector = Array.from({ length: 768 }, (_, index) => index === 5 ? 1 : 0);
  expect(store.upsertBatch(profileId, [{ assetId: asset.assetId,
    sourceRevision: asset.currentRevisionId!, vector }])).toMatchObject({ accepted: [asset.assetId], rejected: [] });
  store.close();
  const semanticPath = path.join(library.libraryPath, '.worldlinebox', 'semantic', 'index.sqlite');
  const originalIndex = readFileSync(semanticPath);

  const database = openConfiguredDatabase(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
  try {
    removeLinkedDirectoryIndexFixture(database);
    database.prepare('DELETE FROM schema_migrations WHERE version = 60').run();
    database.pragma('user_version = 59');
  } finally {
    database.close();
  }
  service.openLibrary(library.libraryPath);
  expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).map((item) => item.assetId))
    .toEqual([asset.assetId]);
  expect(service.getAssetMetadata({ libraryId: library.libraryId, assetId: asset.assetId }))
    .toMatchObject({ description: 'Keep this description', favorite: true });
  expect(readFileSync(semanticPath)).toEqual(originalIndex);
  const migrated = openConfiguredDatabase(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
  try {
    expect(migrated.pragma('user_version', { simple: true })).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'linked_directory_entries'")
      .get()).toEqual({ name: 'linked_directory_entries' });
  } finally {
    migrated.close();
  }
  const reopened = new SemanticIndexStore({ libraryId: library.libraryId, libraryPath: library.libraryPath,
    storageKind: 'local' });
  try {
    expect(Array.from(reopened.vectorFor(profileId, asset.assetId, asset.currentRevisionId!)!)).toEqual(vector);
  } finally {
    reopened.close();
  }
});
