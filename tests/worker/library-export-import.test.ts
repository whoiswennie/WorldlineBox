import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LibraryService,
  LibraryServiceError,
} from '../../src/worker/library-service';
import { SemanticIndexStore } from '../../src/worker/semantic-index-store';
import { embeddingTextRevision } from '../../src/shared/embedding/profile';
import type { WorkerCommand, WorkerRequest } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';
import { closeSemanticIndexWorkerLibrary, executeSemanticIndexWorkerCommand } from '../../src/worker/handlers/semantic-index';

const temporaryRoots: string[] = [];

// LibraryService holds SQLite connections and recursive fs watchers; on
// Windows those open handles block rm of the temp tree (POSIX unlinks open
// files, which is why the leak is invisible on macOS). Always close first.
const services: LibraryService[] = [];

function newService(
  ...args: ConstructorParameters<typeof LibraryService>
): LibraryService {
  const service = new LibraryService(...args);
  services.push(service);
  return service;
}

const require = createRequire(import.meta.url);

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-export-import-test-'));
  temporaryRoots.push(root);
  return root;
}

function expectServiceError(operation: () => unknown, code: LibraryServiceError['code']): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(LibraryServiceError);
  expect((thrown as LibraryServiceError).code).toBe(code);
}

async function expectServiceErrorAsync(
  operation: () => Promise<unknown>,
  code: LibraryServiceError['code'],
): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ code });
}

afterEach(async () => {
  await closeSemanticIndexWorkerLibrary();
  await Promise.all(services.splice(0).map((service) => service.closeAllAsync()));
  for (const root of temporaryRoots.splice(0)) {
    // Yield between retries so Windows can finish delivering watcher-close callbacks.
    // Defender and thumbnail scanners can retain recently closed library trees.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// Windows-only helper: libraries and export destinations can live on
// different drive letters, where path.relative cannot express a traversal
// and returns an absolute path (WorldlineBox-59f). Probe for a writable drive
// other than the temp drive and return a fresh directory on it.
function createForeignDriveRoot(): string | null {
  const tempDrive = path.parse(path.resolve(tmpdir())).root.toUpperCase();
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const driveRoot = `${letter}:\\`;
    if (driveRoot.toUpperCase() === tempDrive) continue;
    try {
      const candidate = mkdtempSync(path.join(driveRoot, 'worldlinebox-xdrive-'));
      temporaryRoots.push(candidate);
      return candidate;
    } catch {
      // Drive absent, read-only media, or not writable — try the next one.
    }
  }
  return null;
}

describe('LibraryService export', () => {
  it('exports and reimports the semantic index through an SQLite backup snapshot', async () => {
    const root = temporaryRoot();
    let semanticStore: SemanticIndexStore | null = null;
    const service = newService({
      backupSemanticIndex: async ({ libraryId, destinationPath }) => {
        const currentStore = semanticStore;
        if (!currentStore) return false;
        expect(libraryId).toBe(created.libraryId);
        await currentStore.backupTo(destinationPath);
        return true;
      },
    });
    const created = service.createLibrary({ displayName: 'Semantic Export Test', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: created.libraryId, name: 'Assets' });
    const displayName = 'asset.txt';
    const relativePath = `${folder.relativePath}/${displayName}`;
    const assetPath = path.join(created.libraryPath, 'Assets', relativePath);
    mkdirSync(path.dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, 'synthetic export fixture');
    const assetId = 'semantic-export-asset';
    const revisionId = 'semantic-export-revision';
    const now = new Date().toISOString();
    const assetStat = statSync(assetPath);
    const database = new (require('better-sqlite3') as new (filename: string) => {
      close(): void;
      prepare(sql: string): { run(...parameters: unknown[]): unknown };
    })(path.join(created.libraryPath, '.worldlinebox', 'library.db'));
    try {
      database.prepare(`INSERT INTO assets (asset_id, location_kind, managed_folder_id, linked_folder_id,
        relative_file_path, current_revision_id, availability, path_identity, created_at, updated_at)
        VALUES (?, 'managed', ?, NULL, ?, NULL, 'available', ?, ?, ?)`).run(
        assetId, folder.folderId, relativePath, relativePath, now, now,
      );
      database.prepare(`INSERT INTO revisions (revision_id, asset_id, parent_revision_id, byte_size,
        modified_at, original_filename, origin, accepted_at)
        VALUES (?, ?, NULL, ?, ?, ?, 'import', ?)`).run(revisionId, assetId,
        assetStat.size, assetStat.mtime.toISOString(), displayName, now);
      database.prepare('UPDATE assets SET current_revision_id = ? WHERE asset_id = ?').run(revisionId, assetId);
    } finally {
      database.close();
    }
    const [assetSource] = service.getSemanticAssetSources(created.libraryId, [assetId]);
    expect(assetSource).toBeDefined();
    const sourceRevision = `${embeddingTextRevision(revisionId)}\ntitle:${displayName}`;
    const sourceStore = new SemanticIndexStore({ libraryPath: created.libraryPath, libraryId: created.libraryId,
      storageKind: 'local' });
    semanticStore = sourceStore;
    const profileId = sourceStore.ensureProfile({
      profileKey: 'export-profile', dimensions: 3, modelRevision: 'model-v1', modality: 'text',
    });
    sourceStore.upsertBatch(profileId, [{ assetId, sourceRevision, vector: [1, 2, 3] }]);

    const exportPath = path.join(root, 'semantic-export');
    await service.exportLibraryToFolder({ libraryId: created.libraryId,
      destinationPath: exportPath, includeLinkedContent: false });
    const exportedSidecar = path.join(exportPath, '.worldlinebox', 'semantic', 'index.sqlite');
    expect(existsSync(exportedSidecar)).toBe(true);
    const zipPath = path.join(root, 'semantic-export.zip');
    await service.exportLibraryToZip({ libraryId: created.libraryId,
      destinationPath: zipPath, includeLinkedContent: false });

    sourceStore.close();
    semanticStore = null;
    service.closeLibrary(created.libraryId);
    const importParent = path.join(root, 'imported-libraries');
    mkdirSync(importParent);
    const imported = await service.importLibraryFromFolder({ sourceFolderPath: exportPath, copyToParentPath: importParent });
    const importedStore = new SemanticIndexStore({ libraryPath: imported.libraryPath,
      libraryId: imported.libraryId, storageKind: 'local' });
    try {
      expect(imported.libraryId).toBe(created.libraryId);
      const restored = importedStore.vectorFor(profileId, assetId, sourceRevision);
      expect(restored).not.toBeNull();
      expect(Array.from(restored ?? [])).toHaveLength(3);
      expect(restored?.[0]).toBeCloseTo(0.26726124, 6);
      expect(restored?.[1]).toBeCloseTo(0.5345225, 6);
      expect(restored?.[2]).toBeCloseTo(0.8017837, 6);
      importedStore.close();
      const sessionGeneration = '91716386-c85a-4b65-a237-c971bfc553e6';
      const call = async (command: WorkerCommand): Promise<WorkerResult> => {
        const result = await executeSemanticIndexWorkerCommand(service,
          { requestId: 'semantic-export-query', command } as WorkerRequest,
          { runWithoutAdmission: async (work) => work() });
        if (!result) throw new Error(`Worker did not handle ${command.type}`);
        return result;
      };
      await call({ type: 'semantic.index.begin', libraryId: imported.libraryId, sessionGeneration,
        profileKey: 'export-profile', dimensions: 3, modelRevision: 'model-v1', modality: 'text',
        maxInputBytes: 1024 });
      const ranked = await call({ type: 'semantic.index.search', libraryId: imported.libraryId,
        sessionGeneration, queryId: '36be067f-b9aa-46c0-a4fc-d2e80f933589',
        profileKey: 'export-profile', vector: [1, 2, 3], scope: null, filters: [], showIgnored: false });
      expect(ranked).toMatchObject({ ok: true, type: 'semantic.index.ranked', cancelled: false,
        assetIds: [assetId] });
    } finally {
      importedStore.close();
      semanticStore = null;
    }

    const zipParent = path.join(root, 'zip-imports');
    mkdirSync(zipParent);
    const zipService = newService();
    const zipImported = await zipService.importLibraryFromZip({ sourceZipPath: zipPath,
      destinationParentPath: zipParent });
    const zipStore = new SemanticIndexStore({ libraryPath: zipImported.libraryPath,
      libraryId: zipImported.libraryId, storageKind: 'local' });
    try {
      expect(zipImported.libraryId).toBe(created.libraryId);
      expect(zipStore.vectorFor(profileId, assetId, sourceRevision)).not.toBeNull();
    } finally {
      zipStore.close();
    }
  });

  it('exports a library with Assets, revisions, trash, and library.db', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Export Test', selectedParentPath: root });

    // Add some content.
    const assetPath = path.join(root, 'sample.png');
    writeFileSync(assetPath, Buffer.alloc(1024));
    service.prepareOrExecuteImport({
      libraryId: created.libraryId,
      sourceKind: 'files',
      sourcePaths: [assetPath],
    });

    const destPath = path.join(root, 'export-dest');
    const result = await service.exportLibraryToFolder({
      libraryId: created.libraryId,
      destinationPath: destPath,
      includeLinkedContent: false,
    });

    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.excludedPreviewCount).toBeGreaterThanOrEqual(0);
    expect(result.includedLinkedContent).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify dest contains expected directories.
    expect(existsSync(path.join(destPath, 'Assets'))).toBe(true);
    expect(existsSync(path.join(destPath, '.worldlinebox', 'library.db'))).toBe(true);

    // Verify the exported library is valid and can be opened.
    const service2 = newService();
    const reopened = service2.openLibrary(destPath);
    expect(reopened.displayName).toBe('Export Test');

    // Check asset count matches.
    const assets = service2.listAssets({ libraryId: reopened.libraryId, recursive: true });
    expect(assets.length).toBe(1);

    service.closeAll();
    service2.closeAll();
  });

  it('excludes previews and operations directories', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Exclude Test', selectedParentPath: root });

    // Create fake preview/operations content.
    mkdirSync(path.join(created.libraryPath, '.worldlinebox', 'previews'), { recursive: true });
    writeFileSync(path.join(created.libraryPath, '.worldlinebox', 'previews', 'thumb.jpg'), 'data');

    mkdirSync(path.join(created.libraryPath, '.worldlinebox', 'operations'), { recursive: true });
    writeFileSync(path.join(created.libraryPath, '.worldlinebox', 'operations', 'op.json'), '{}');

    const destPath = path.join(root, 'export-dest2');
    await service.exportLibraryToFolder({
      libraryId: created.libraryId,
      destinationPath: destPath,
      includeLinkedContent: false,
    });

    // Verify previews/operations are NOT in the export.
    expect(existsSync(path.join(destPath, '.worldlinebox', 'previews'))).toBe(false);
    expect(existsSync(path.join(destPath, '.worldlinebox', 'operations'))).toBe(false);

    // But library.db IS there.
    expect(existsSync(path.join(destPath, '.worldlinebox', 'library.db'))).toBe(true);

    service.closeAll();
  });

  it('includes .worldlinebox/artifacts so import keeps ready thumbnails (WorldlineBox-pxd)', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({
      displayName: 'Artifacts Export',
      selectedParentPath: root,
    });

    const sourcePath = path.join(root, 'photo.png');
    writeFileSync(
      sourcePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const imported = service.prepareOrExecuteImport({
      libraryId: created.libraryId,
      sourceKind: 'files',
      sourcePaths: [sourcePath],
    });
    expect('importId' in imported).toBe(false);

    const assets = service.listAssets({ libraryId: created.libraryId, recursive: true });
    expect(assets).toHaveLength(1);
    const thumb = (await service.generateThumbnail({
      libraryId: created.libraryId,
      assetId: assets[0]!.assetId,
    }))!;
    const sourceArtifact = path.join(
      created.libraryPath,
      '.worldlinebox',
      'artifacts',
      `${thumb.artifactId}.webp`,
    );
    expect(existsSync(sourceArtifact)).toBe(true);

    const destPath = path.join(root, 'export-with-artifacts');
    await service.exportLibraryToFolder({
      libraryId: created.libraryId,
      destinationPath: destPath,
      includeLinkedContent: false,
    });

    expect(
      existsSync(path.join(destPath, '.worldlinebox', 'artifacts', `${thumb.artifactId}.webp`)),
    ).toBe(true);
    service.closeAll();

    const service2 = newService();
    const reopened = service2.openLibrary(destPath);
    expect(
      existsSync(
        path.join(reopened.libraryPath, '.worldlinebox', 'artifacts', `${thumb.artifactId}.webp`),
      ),
    ).toBe(true);
    const listed = service2.listAssets({ libraryId: reopened.libraryId, recursive: true });
    expect(listed[0]?.thumbnailArtifactId).toBe(thumb.artifactId);
    service2.closeAll();
  });

  it('invalidates ready artifacts missing on disk so thumbnails requeue (WorldlineBox-pxd)', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({
      displayName: 'Missing Artifacts',
      selectedParentPath: root,
    });

    const sourcePath = path.join(root, 'photo.png');
    writeFileSync(
      sourcePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    service.prepareOrExecuteImport({
      libraryId: created.libraryId,
      sourceKind: 'files',
      sourcePaths: [sourcePath],
    });
    const assets = service.listAssets({ libraryId: created.libraryId, recursive: true });
    const thumb = (await service.generateThumbnail({
      libraryId: created.libraryId,
      assetId: assets[0]!.assetId,
    }))!;
    const artifactPath = path.join(
      created.libraryPath,
      '.worldlinebox',
      'artifacts',
      `${thumb.artifactId}.webp`,
    );
    expect(existsSync(artifactPath)).toBe(true);
    rmSync(artifactPath);

    // WorldlineBox-tumv: re-open delivers immediately; the missing-artifact sweep
    // now runs in the background reconciliation step.
    service.closeAll();
    const service2 = newService();
    const reopened = service2.openLibrary(created.libraryPath);
    await service2.runOpenBackgroundReconciliation(reopened.libraryId);
    const listed = service2.listAssets({ libraryId: reopened.libraryId, recursive: true });
    expect(listed[0]?.thumbnailStatus).not.toBe('ready');
    const regenerated = (await service2.generateThumbnail({
      libraryId: reopened.libraryId,
      assetId: listed[0]!.assetId,
    }))!;
    expect(
      existsSync(
        path.join(
          reopened.libraryPath,
          '.worldlinebox',
          'artifacts',
          `${regenerated.artifactId}.webp`,
        ),
      ),
    ).toBe(true);
    service2.closeAll();
  });

  it('rejects export destination inside the library', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Inside Export', selectedParentPath: root });

    const destInsideLibrary = path.join(created.libraryPath, 'export-output');
    await expectServiceErrorAsync(
      () => service.exportLibraryToFolder({
        libraryId: created.libraryId,
        destinationPath: destInsideLibrary,
        includeLinkedContent: false,
      }),
      'INVALID_LIBRARY_PATH',
    );

    service.closeAll();
  });

  it.runIf(process.platform === 'win32')(
    'accepts a folder destination on a different drive letter (WorldlineBox-59f)',
    async (ctx) => {
      const foreignRoot = createForeignDriveRoot();
      if (!foreignRoot) {
        ctx.skip();
        return;
      }
      const root = temporaryRoot();
      const service = newService();
      const created = service.createLibrary({ displayName: 'Folder Cross-Drive Export', selectedParentPath: root });

      const assetPath = path.join(root, 'sample.png');
      writeFileSync(assetPath, Buffer.alloc(256));
      service.prepareOrExecuteImport({
        libraryId: created.libraryId,
        sourceKind: 'files',
        sourcePaths: [assetPath],
      });

      const destPath = path.join(foreignRoot, 'cross-drive-export');
      const result = await service.exportLibraryToFolder({
        libraryId: created.libraryId,
        destinationPath: destPath,
        includeLinkedContent: false,
      });

      expect(result.fileCount).toBeGreaterThan(0);
      expect(existsSync(path.join(destPath, '.worldlinebox', 'library.db'))).toBe(true);
    },
  );

  it('rejects export when library is not open', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Closed Export', selectedParentPath: root });
    service.closeAll();

    await expectServiceErrorAsync(
      () => service.exportLibraryToFolder({
        libraryId: created.libraryId,
        destinationPath: path.join(root, 'dest'),
        includeLinkedContent: false,
      }),
      'LIBRARY_NOT_OPEN',
    );
  });

  it('never merges into or deletes a pre-existing export destination', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Owned Export', selectedParentPath: root });
    const destPath = path.join(root, 'existing-export');
    const sentinelPath = path.join(destPath, 'keep-me.txt');
    mkdirSync(destPath);
    writeFileSync(sentinelPath, 'user data');

    await expectServiceErrorAsync(
      () => service.exportLibraryToFolder({
        libraryId: created.libraryId,
        destinationPath: destPath,
        includeLinkedContent: false,
      }),
      'LIBRARY_ALREADY_EXISTS',
    );

    expect(existsSync(sentinelPath)).toBe(true);
    service.closeAll();
  });

  it('removes only its newly-created export directory after a copy failure', async () => {
    const root = temporaryRoot();
    let sourceToRemove: string | undefined;
    const service = newService({
      onProgress: (event) => {
        if (event.type === 'export.progress' && event.phase === 'copy' && sourceToRemove) {
          rmSync(sourceToRemove, { force: true });
          sourceToRemove = undefined;
        }
      },
    });
    const created = service.createLibrary({ displayName: 'Failed Export', selectedParentPath: root });
    const source = path.join(root, 'source.txt');
    writeFileSync(source, 'asset');
    service.prepareOrExecuteImport({
      libraryId: created.libraryId,
      sourceKind: 'files',
      sourcePaths: [source],
    });
    sourceToRemove = path.join(created.libraryPath, 'Assets', 'source.txt');
    const destinationPath = path.join(root, 'failed-export');

    await expect(service.exportLibraryToFolder({
      libraryId: created.libraryId,
      destinationPath,
      includeLinkedContent: false,
    })).rejects.toThrow();
    expect(existsSync(destinationPath)).toBe(false);
    service.closeAll();
  });

  it('fails instead of reporting success when requested linked content is offline', async () => {
    const root = temporaryRoot();
    const linkedRoot = path.join(root, 'linked-source');
    mkdirSync(linkedRoot);
    writeFileSync(path.join(linkedRoot, 'linked.png'), 'linked');
    const service = newService();
    const created = service.createLibrary({ displayName: 'Complete Export', selectedParentPath: root });
    service.importFolderAsLinked({ libraryId: created.libraryId, sourceRootPath: linkedRoot });
    rmSync(linkedRoot, { force: true, recursive: true });
    service.refreshManagedAssets(created.libraryId);
    const destinationPath = path.join(root, 'must-not-succeed');

    await expectServiceErrorAsync(
      () => service.exportLibraryToFolder({
        libraryId: created.libraryId,
        destinationPath,
        includeLinkedContent: true,
      }),
      'INVALID_IMPORT_SOURCE',
    );
    expect(existsSync(destinationPath)).toBe(false);
    service.closeAll();
  });

  it('includes linked files in folder progress and uses collision-safe backup paths', async () => {
    const root = temporaryRoot();
    const firstRoot = path.join(root, 'linked-a');
    const secondRoot = path.join(root, 'linked-b');
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    writeFileSync(path.join(firstRoot, 'first.png'), 'first');
    writeFileSync(path.join(secondRoot, 'second.png'), 'second');
    const service = newService();
    const created = service.createLibrary({ displayName: 'Linked Backup', selectedParentPath: root });
    const first = service.importFolderAsLinked({ libraryId: created.libraryId, sourceRootPath: firstRoot, displayName: 'References' });
    const second = service.importFolderAsLinked({ libraryId: created.libraryId, sourceRootPath: secondRoot, displayName: 'References' });
    const destinationPath = path.join(root, 'linked-export');

    const result = await service.exportLibraryToFolder({
      libraryId: created.libraryId,
      destinationPath,
      includeLinkedContent: true,
    });

    expect(result.includedLinkedContent).toBe(true);
    expect(existsSync(path.join(destinationPath, '_linked', `References-${first.folderId.slice(0, 8)}`, 'first.png'))).toBe(true);
    expect(existsSync(path.join(destinationPath, '_linked', `References-${second.folderId.slice(0, 8)}`, 'second.png'))).toBe(true);
    expect(result.fileCount).toBeGreaterThanOrEqual(3); // two linked files + database
    service.closeAll();
  });
});

describe('LibraryService import folder', () => {
  it('validates a valid library source', () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Import Validate', selectedParentPath: root });
    service.closeAll();

    const info = service.validateImportSource(created.libraryPath);
    expect(info.libraryId).toBe(created.libraryId);
    expect(info.displayName).toBe('Import Validate');
  });

  it('rejects source without Assets directory', () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'No Assets', selectedParentPath: root });
    service.closeAll();
    rmSync(path.join(created.libraryPath, 'Assets'), { recursive: true });

    expectServiceError(
      () => service.validateImportSource(created.libraryPath),
      'NOT_A_LIBRARY',
    );
  });

  it('rejects source without database', () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'No DB', selectedParentPath: root });
    service.closeAll();
    rmSync(path.join(created.libraryPath, '.worldlinebox', 'library.db'));

    expectServiceError(
      () => service.validateImportSource(created.libraryPath),
      'NOT_A_LIBRARY',
    );
  });

  it('rejects source with symlink at root', () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Symlink', selectedParentPath: root });
    service.closeAll();

    // Symlinks cannot be reliably tested on all platforms; skip if not supported.
    try {
      const { symlinkSync } = require('node:fs');
      const targetPath = path.join(root, 'symlink-target');
      writeFileSync(targetPath, 'hello');
      symlinkSync(targetPath, path.join(created.libraryPath, 'escape-link'));

      expectServiceError(
        () => service.validateImportSource(created.libraryPath),
        'NOT_A_LIBRARY',
      );

      rmSync(path.join(created.libraryPath, 'escape-link'));
    } catch {
      // Symlink operation not available; skip test.
    }
  });

  it('rejects a nested symbolic link instead of silently dropping it', () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Nested Symlink', selectedParentPath: root });
    service.closeAll();
    const nested = path.join(created.libraryPath, 'Assets', 'nested');
    const external = path.join(root, 'external');
    mkdirSync(nested);
    mkdirSync(external);
    writeFileSync(path.join(external, 'outside.txt'), 'outside');
    symlinkSync(external, path.join(nested, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');

    expectServiceError(
      () => service.validateImportSource(created.libraryPath),
      'NOT_A_LIBRARY',
    );
  });

  it('imports a library in place', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'In Place Import', selectedParentPath: root });
    service.closeAll();

    const result = await service.importLibraryFromFolder({
      sourceFolderPath: created.libraryPath,
    });

    expect(result.displayName).toBe('In Place Import');
    expect(result.libraryId).toBe(created.libraryId);
    expect(result.libraryPath).toBe(realpathSync(created.libraryPath));

    // Verify the library is now open.
    expect(service.listLibraries()).toHaveLength(1);
    service.closeAll();
  });

  it('imports a library by copying to a new location', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Copy Import', selectedParentPath: root });
    service.closeAll();

    const copyParent = path.join(root, 'copied-libs');
    mkdirSync(copyParent, { recursive: true });

    const result = await service.importLibraryFromFolder({
      sourceFolderPath: created.libraryPath,
      copyToParentPath: copyParent,
    });

    const expectedPath = path.join(copyParent, path.basename(created.libraryPath));
    expect(result.displayName).toBe('Copy Import');
    expect(result.libraryPath).toBe(realpathSync(expectedPath));

    // Verify copied path has Assets and DB.
    expect(existsSync(path.join(expectedPath, 'Assets'))).toBe(true);
    expect(existsSync(path.join(expectedPath, '.worldlinebox', 'library.db'))).toBe(true);

    service.closeAll();
  });

  it('reports file and byte totals while copying a library', async () => {
    const root = temporaryRoot();
    const events: Array<{
      filesProcessed: number;
      totalFiles: number;
      bytesProcessed: number;
      totalBytes: number;
    }> = [];
    const service = newService({
      onProgress: (event) => {
        if (event.type === 'import.progress' && event.phase === 'copy') {
          events.push(event);
        }
      },
    });
    const created = service.createLibrary({ displayName: 'Counted Copy', selectedParentPath: root });
    writeFileSync(path.join(created.libraryPath, 'Assets', 'copy-progress.txt'), 'copy progress');
    service.closeAll();

    const copyParent = path.join(root, 'counted-copy-parent');
    mkdirSync(copyParent);
    await service.importLibraryFromFolder({
      sourceFolderPath: created.libraryPath,
      copyToParentPath: copyParent,
    });

    expect(events.length).toBeGreaterThan(0);
    const final = events.at(-1)!;
    expect(final.totalFiles).toBeGreaterThan(0);
    expect(final.filesProcessed).toBe(final.totalFiles);
    expect(final.totalBytes).toBeGreaterThan(0);
    expect(final.bytesProcessed).toBe(final.totalBytes);
    service.closeAll();
  });

  it('rejects non-library source', async () => {
    const root = temporaryRoot();
    const service = newService();
    const nonLibrary = path.join(root, 'not-a-library');
    mkdirSync(nonLibrary, { recursive: true });

    await expectServiceErrorAsync(
      () => service.importLibraryFromFolder({ sourceFolderPath: nonLibrary }),
      'NOT_A_LIBRARY',
    );
  });

  it('never merges into or deletes a pre-existing copied-library destination', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({ displayName: 'Copy Ownership', selectedParentPath: root });
    service.closeAll();
    const copyParent = path.join(root, 'copy-parent');
    const existingDestination = path.join(copyParent, path.basename(created.libraryPath));
    const sentinelPath = path.join(existingDestination, 'keep-me.txt');
    mkdirSync(existingDestination, { recursive: true });
    writeFileSync(sentinelPath, 'user data');

    await expectServiceErrorAsync(
      () => service.importLibraryFromFolder({
        sourceFolderPath: created.libraryPath,
        copyToParentPath: copyParent,
      }),
      'LIBRARY_ALREADY_EXISTS',
    );

    expect(existsSync(sentinelPath)).toBe(true);
  });

  it('removes its newly-created copied-library directory after a copy failure', async () => {
    const root = temporaryRoot();
    let databaseToRemove: string | undefined;
    const service = newService({
      onProgress: (event) => {
        if (event.type === 'import.progress' && event.phase === 'copy' && databaseToRemove) {
          rmSync(databaseToRemove, { force: true });
          databaseToRemove = undefined;
        }
      },
    });
    const created = service.createLibrary({ displayName: 'Failed Copy', selectedParentPath: root });
    service.closeAll();
    databaseToRemove = path.join(created.libraryPath, '.worldlinebox', 'library.db');
    const copyParent = path.join(root, 'copy-parent');
    mkdirSync(copyParent);
    const destinationPath = path.join(copyParent, path.basename(created.libraryPath));

    await expect(service.importLibraryFromFolder({
      sourceFolderPath: created.libraryPath,
      copyToParentPath: copyParent,
    })).rejects.toBeInstanceOf(LibraryServiceError);
    expect(existsSync(destinationPath)).toBe(false);
  });
});

describe('Export progress events', () => {
  it('emits progress events through all phases', async () => {
    const root = temporaryRoot();
    const progressEvents: Array<{ phase: string }> = [];
    const service = newService({
      onProgress: (event) => {
        if (event.type === 'export.progress') {
          progressEvents.push({ phase: event.phase });
        }
      },
    });

    const created = service.createLibrary({ displayName: 'Progress Export', selectedParentPath: root });

    // Add some assets.
    const assetPath = path.join(root, 'test.png');
    writeFileSync(assetPath, Buffer.alloc(500));
    service.prepareOrExecuteImport({
      libraryId: created.libraryId,
      sourceKind: 'files',
      sourcePaths: [assetPath],
    });

    const destPath = path.join(root, 'prog-dest');
    await service.exportLibraryToFolder({
      libraryId: created.libraryId,
      destinationPath: destPath,
      includeLinkedContent: false,
    });

    const phases = progressEvents.map((e) => e.phase);
    expect(phases).toContain('snapshot-db');
    expect(phases).toContain('enumerate');
    expect(phases).toContain('copy');
    expect(phases).toContain('complete');

    service.closeAll();
  });

  it('rejects cancellation for an unknown operation id', () => {
    const root = temporaryRoot();
    const service = newService();

    service.createLibrary({ displayName: 'Cancel Export', selectedParentPath: root });

    expectServiceError(
      () => service.cancelExport('nonexistent'),
      'IMPORT_NOT_FOUND',
    );

    service.closeAll();
  });

  it('cancel import rejects unknown importId', () => {
    const service = newService();

    expectServiceError(
      () => service.cancelImport('nonexistent'),
      'IMPORT_NOT_FOUND',
    );
  });

  it('announces an export id before completion and removes only its owned destination on cancellation', async () => {
    const root = temporaryRoot();
    let cancelRequested = false;
    const phases: string[] = [];
    const service = newService({
      onProgress: (event) => {
        if (event.type !== 'export.progress') return;
        phases.push(event.phase);
        if (event.phase === 'copy' && !cancelRequested) {
          cancelRequested = true;
          setImmediate(() => service.cancelExport(event.exportId));
        }
      },
    });
    const created = service.createLibrary({ displayName: 'Live Cancel Export', selectedParentPath: root });
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(path.join(created.libraryPath, 'Assets', `asset-${index}.bin`), Buffer.alloc(4096));
    }
    const destinationPath = path.join(root, 'cancelled-export');
    const siblingSentinel = path.join(root, 'keep-me.txt');
    writeFileSync(siblingSentinel, 'user data');

    await expect(service.exportLibraryToFolder({
      libraryId: created.libraryId,
      destinationPath,
      includeLinkedContent: false,
    })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(cancelRequested).toBe(true);
    expect(phases).toContain('cancelled');
    expect(phases).not.toContain('complete');
    expect(existsSync(destinationPath)).toBe(false);
    expect(existsSync(siblingSentinel)).toBe(true);
    service.closeAll();
  });

  it('announces an import id before completion and removes only its owned copy on cancellation', async () => {
    const root = temporaryRoot();
    const sourceService = newService();
    const created = sourceService.createLibrary({ displayName: 'Live Cancel Import', selectedParentPath: root });
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(path.join(created.libraryPath, 'Assets', `asset-${index}.bin`), Buffer.alloc(4096));
    }
    sourceService.closeAll();

    let cancelRequested = false;
    const phases: string[] = [];
    const service = newService({
      onProgress: (event) => {
        if (event.type !== 'import.progress') return;
        phases.push(event.phase);
        if (event.phase === 'copy' && !cancelRequested) {
          cancelRequested = true;
          setImmediate(() => service.cancelImport(event.importId));
        }
      },
    });
    const destinationParent = path.join(root, 'imports');
    mkdirSync(destinationParent);
    const ownedDestination = path.join(destinationParent, path.basename(created.libraryPath));
    const siblingSentinel = path.join(destinationParent, 'keep-me.txt');
    writeFileSync(siblingSentinel, 'user data');

    await expect(service.importLibraryFromFolder({
      sourceFolderPath: created.libraryPath,
      copyToParentPath: destinationParent,
    })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(cancelRequested).toBe(true);
    expect(phases).toContain('cancelled');
    expect(phases).not.toContain('complete');
    expect(existsSync(ownedDestination)).toBe(false);
    expect(existsSync(siblingSentinel)).toBe(true);
  });
});
