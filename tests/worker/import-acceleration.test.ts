import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isImportConflictPlan } from '../../src/shared/import-outcome';
import {
  LibraryService,
  LibraryServiceError,
  MIGRATIONS,
  openConfiguredDatabase,
} from '../../src/worker/library-service';

const temporaryRoots: string[] = [];
const services: LibraryService[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-import-acceleration-'));
  temporaryRoots.push(root);
  return root;
}

function newService(...args: ConstructorParameters<typeof LibraryService>): LibraryService {
  const service = new LibraryService(...args);
  services.push(service);
  return service;
}

function prepareConflict(
  service: LibraryService,
  input: Parameters<LibraryService['prepareImport']>[0],
) {
  const result = service.prepareImport(input);
  if (!isImportConflictPlan(result)) throw new Error('expected an import conflict plan');
  return result;
}

function expectServiceCode(operation: () => unknown, code: LibraryServiceError['code']): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LibraryServiceError);
  expect((thrown as LibraryServiceError).code).toBe(code);
}

function databaseFor(service: LibraryService, libraryId: string) {
  return (service as unknown as {
    openById: Map<string, { connection: {
      prepare(sql: string): {
        all(...parameters: unknown[]): unknown[];
        get(...parameters: unknown[]): unknown;
        run(...parameters: unknown[]): unknown;
      };
    } }>;
  }).openById.get(libraryId)!.connection;
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('import destination and content lookup acceleration', () => {
  it('applies the v59 index to a v58 library without changing prior migration history', () => {
    const root = temporaryRoot();
    const libraryPath = path.join(root, 'v58-library');
    mkdirSync(path.join(libraryPath, '.worldlinebox'), { recursive: true });
    mkdirSync(path.join(libraryPath, 'Assets'));
    const databasePath = path.join(libraryPath, '.worldlinebox', 'library.db');
    const database = openConfiguredDatabase(databasePath);
    try {
      database.exec(MIGRATIONS.slice(0, 58).map((migration) => migration.sql).join('\n'));
      const appliedAt = new Date().toISOString();
      for (const migration of MIGRATIONS.slice(0, 58)) {
        database.prepare(
          'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
        ).run(migration.version, migration.checksum, appliedAt);
      }
      database.prepare(
        'INSERT INTO library (library_id, display_name, created_at) VALUES (?, ?, ?)',
      ).run('lib_import_v58', 'Import migration fixture', appliedAt);
      database.pragma('user_version = 58');
    } finally {
      database.close();
    }

    const service = newService();
    service.openLibrary(libraryPath);
    const connection = databaseFor(service, 'lib_import_v58');
    const columns = connection.prepare(
      'PRAGMA index_info(revisions_size_fingerprint_idx)',
    ).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'byte_size',
      'content_fingerprint',
    ]);
    const plan = connection.prepare(
      `EXPLAIN QUERY PLAN
       SELECT r.revision_id
         FROM revisions AS r INDEXED BY revisions_size_fingerprint_idx
         JOIN assets a
           ON a.asset_id = r.asset_id
          AND a.current_revision_id = r.revision_id
        WHERE a.deleted_at IS NULL
          AND a.location_kind = 'managed'
          AND r.byte_size = ?
          AND r.content_fingerprint = ?`,
    ).all(12, 'fingerprint') as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('revisions_size_fingerprint_idx'))).toBe(true);
    service.closeAll();

    const history = openConfiguredDatabase(databasePath);
    try {
      const historyRows = history.prepare(
        'SELECT version, checksum FROM schema_migrations WHERE version <= 58 ORDER BY version',
      ).all() as Array<{ version: number; checksum: string }>;
      expect(historyRows.map((row) => row.version)).toEqual(MIGRATIONS.slice(0, 58).map((m) => m.version));
      expect(historyRows.map((row) => row.checksum)).toEqual(MIGRATIONS.slice(0, 58).map((m) => m.checksum));
    } finally {
      history.close();
    }
  });

  it('matches only the active current managed revision and keeps NULL fingerprint fallback after reopen', () => {
    const root = temporaryRoot();
    const firstSource = path.join(root, 'first', 'managed.png');
    const replacementSource = path.join(root, 'replacement', 'managed.png');
    const oldCopySource = path.join(root, 'old-copy.png');
    const currentCopySource = path.join(root, 'current-copy.png');
    const differentCopySource = path.join(root, 'different-copy.png');
    mkdirSync(path.dirname(firstSource));
    mkdirSync(path.dirname(replacementSource));
    writeFileSync(firstSource, 'old-content!');
    writeFileSync(replacementSource, 'new-content!');
    writeFileSync(oldCopySource, 'old-content!');
    writeFileSync(currentCopySource, 'new-content!');
    writeFileSync(differentCopySource, 'bad-content!');

    let service = newService();
    const library = service.createLibrary({ displayName: 'Content lookup', selectedParentPath: root });
    const initial = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [firstSource],
    });
    service.resolveImport({
      importId: initial.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });

    const replacement = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [replacementSource],
    });
    service.resolveImport({
      importId: replacement.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'replace',
    });

    const oldRevisionCopy = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [oldCopySource],
    });
    expect(oldRevisionCopy.libraryDuplicateCount).toBe(0);
    service.resolveImport({
      importId: oldRevisionCopy.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });

    const currentRevisionCopy = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [currentCopySource],
    });
    expect(currentRevisionCopy.libraryDuplicateCount).toBe(1);
    service.resolveImport({
      importId: currentRevisionCopy.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });

    const sameSizeDifferentContent = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [differentCopySource],
    });
    expect(sameSizeDifferentContent.libraryDuplicateCount).toBe(0);
    service.resolveImport({
      importId: sameSizeDifferentContent.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });

    const connection = databaseFor(service, library.libraryId);
    const currentRevision = connection.prepare(
      `SELECT current_revision_id FROM assets
        WHERE location_kind = 'managed' AND relative_file_path = 'managed.png'`,
    ).get() as { current_revision_id: string };
    connection.prepare(
      'UPDATE revisions SET content_fingerprint = NULL WHERE revision_id = ?',
    ).run(currentRevision.current_revision_id);
    const libraryPath = library.libraryPath;
    service.closeAll();

    service = newService();
    service.openLibrary(libraryPath);
    const afterRestart = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [currentCopySource],
    });
    expect(afterRestart.libraryDuplicateCount).toBe(1);
    service.resolveImport({
      importId: afterRestart.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });
  });

  it.each([
    { mode: 'regular', skipContentHash: false },
    { mode: 'bulk', skipContentHash: true },
  ])(
    'does not bind a linked asset when the managed destination has the same portable identity ($mode)',
    ({ skipContentHash }) => {
      const root = temporaryRoot();
      const linkedRoot = path.join(root, 'linked-source');
      const managedSource = path.join(root, 'managed-source', 'same.png');
      mkdirSync(linkedRoot);
      mkdirSync(path.dirname(managedSource));
      writeFileSync(path.join(linkedRoot, 'same.png'), 'linked bytes');
      writeFileSync(managedSource, 'managed bytes');

      const service = newService();
      const library = service.createLibrary({ displayName: 'Location scope', selectedParentPath: root });
      service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: linkedRoot });
      const plan = prepareConflict(service, {
        libraryId: library.libraryId,
        sourceKind: 'files',
        sourcePaths: [managedSource],
        ...(skipContentHash
          ? { skipContentHash: true, skipLibraryDuplicateScan: true }
          : {}),
      });
      expect(plan.nameConflictCount).toBe(0);
      expect(plan.libraryDuplicateCount).toBe(0);
      service.resolveImport({
        importId: plan.importId,
        suspectedDuplicate: 'skip',
        nameConflict: 'keep-both',
      });

      const rows = databaseFor(service, library.libraryId).prepare(
        `SELECT location_kind, relative_file_path FROM assets
          WHERE path_identity = (SELECT path_identity FROM assets WHERE relative_file_path = 'same.png' LIMIT 1)
          ORDER BY location_kind`,
      ).all() as Array<{ location_kind: string; relative_file_path: string }>;
      expect(rows.map((row) => row.location_kind)).toEqual(['linked', 'managed']);
      expect(readFileSync(path.join(library.libraryPath, 'Assets', 'same.png'), 'utf8')).toBe('managed bytes');
      expect(readFileSync(path.join(linkedRoot, 'same.png'), 'utf8')).toBe('linked bytes');
    },
  );

  it('reimports a trashed managed name without binding the trash row', () => {
    const root = temporaryRoot();
    const firstSource = path.join(root, 'first.png');
    const secondSource = path.join(root, 'replacement', 'first.png');
    mkdirSync(path.dirname(secondSource));
    writeFileSync(firstSource, 'first bytes');
    writeFileSync(secondSource, 'second bytes');
    const service = newService();
    const library = service.createLibrary({ displayName: 'Trash identity', selectedParentPath: root });
    const initial = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [firstSource],
    });
    const original = service.resolveImport({
      importId: initial.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });
    service.trashAssets({ libraryId: library.libraryId, assetIds: [original.assets[0]!.assetId] });

    const replacement = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [secondSource],
    });
    expect(replacement.nameConflictCount).toBe(0);
    const completion = service.resolveImport({
      importId: replacement.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });
    expect(completion.assets[0]?.assetId).not.toBe(original.assets[0]?.assetId);
    expect(readFileSync(path.join(library.libraryPath, 'Assets', 'first.png'), 'utf8'))
      .toBe('second bytes');
    expect(service.listTrash(library.libraryId)).toHaveLength(1);
  });

  it('detects a Unicode NFD orphan created during staging and preserves it via keep-both', () => {
    const root = temporaryRoot();
    const source = path.join(root, 'Café.png');
    writeFileSync(source, 'imported bytes');
    let injected = false;
    let libraryPath = '';
    const service = newService({
      afterSourceSnapshotCopy: () => {
        if (injected) return;
        const orphanPath = path.join(libraryPath, 'Assets', 'Cafe\u0301.png');
        writeFileSync(orphanPath, 'external bytes');
        injected = true;
      },
    });
    const serviceLibrary = service.createLibrary({ displayName: 'Unicode orphan', selectedParentPath: root });
    libraryPath = serviceLibrary.libraryPath;
    const plan = prepareConflict(service, {
      libraryId: serviceLibrary.libraryId,
      sourceKind: 'files',
      sourcePaths: [source],
    });
    expect(injected).toBe(true);
    expect(plan.nameConflictCount).toBe(1);
    service.resolveImport({
      importId: plan.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });

    expect(readFileSync(path.join(serviceLibrary.libraryPath, 'Assets', 'Cafe\u0301.png'), 'utf8'))
      .toBe('external bytes');
    expect(readFileSync(path.join(serviceLibrary.libraryPath, 'Assets', 'Café (2).png'), 'utf8'))
      .toBe('imported bytes');
  });

  it('reclassifies a new orphan after the conflict plan and rejects one arriving at apply time', () => {
    const root = temporaryRoot();
    const source = path.join(root, 'race.png');
    writeFileSync(source, 'imported bytes');
    let injectAtApply = false;
    let lateExternalPath = '';
    const service = newService({
      beforeImportDestinationApply: () => {
        if (injectAtApply) writeFileSync(lateExternalPath, 'late external');
      },
    });
    const library = service.createLibrary({ displayName: 'Prompt race', selectedParentPath: root });
    const plan = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [source],
    });
    expect(plan.nameConflictCount).toBe(0);
    const externalPath = path.join(library.libraryPath, 'Assets', 'RACE.PNG');
    writeFileSync(externalPath, 'external bytes');
    service.resolveImport({
      importId: plan.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });
    expect(readFileSync(externalPath, 'utf8')).toBe('external bytes');
    expect(readFileSync(path.join(library.libraryPath, 'Assets', 'race (2).png'), 'utf8'))
      .toBe('imported bytes');

    const lateSource = path.join(root, 'late.png');
    writeFileSync(lateSource, 'late import');
    const latePlan = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [lateSource],
    });
    lateExternalPath = path.join(library.libraryPath, 'Assets', 'late.png');
    injectAtApply = true;
    expectServiceCode(() => service.resolveImport({
      importId: latePlan.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    }), 'IMPORT_APPLY_FAILED');
    expect(readFileSync(lateExternalPath, 'utf8')).toBe('late external');
    expect(existsSync(path.join(library.libraryPath, '.worldlinebox', 'operations', latePlan.importId)))
      .toBe(false);
  });

  it('cleans staging when the apply guard rejects an external file in a new import directory', () => {
    const root = temporaryRoot();
    const sourceRoot = path.join(root, 'new-tree');
    const sourcePath = path.join(sourceRoot, 'nested', 'payload.png');
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'staged bytes');
    let externalPath = '';
    const service = newService({
      observerFactory: () => ({ close() {} }),
      beforeImportDestinationApply: () => writeFileSync(externalPath, 'external bytes'),
    });
    const library = service.createLibrary({ displayName: 'Guard cleanup', selectedParentPath: root });
    const plan = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'folder',
      sourcePaths: [sourceRoot],
    });
    externalPath = path.join(library.libraryPath, 'Assets', 'new-tree', 'nested', 'payload.png');

    expectServiceCode(() => service.resolveImport({
      importId: plan.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    }), 'IMPORT_APPLY_FAILED');

    expect(readFileSync(externalPath, 'utf8')).toBe('external bytes');
    expect(existsSync(path.dirname(externalPath))).toBe(true);
    expect(existsSync(path.join(library.libraryPath, '.worldlinebox', 'operations', plan.importId)))
      .toBe(false);
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true })).toEqual([]);
    expect(databaseFor(service, library.libraryId).prepare(
      'SELECT status, error_code FROM file_operations WHERE operation_id = ?',
    ).get(plan.importId)).toEqual({ status: 'rolled_back', error_code: 'IMPORT_APPLY_FAILED' });
  });

  it('rejects a bulk destination that appears after its planned keep-both name', () => {
    const root = temporaryRoot();
    const source = path.join(root, 'bulk-race.png');
    writeFileSync(source, 'staged bytes');
    let externalPath = '';
    const service = newService({
      beforeImportDestinationApply: () => writeFileSync(externalPath, 'external bytes'),
    });
    const library = service.createLibrary({ displayName: 'Bulk apply race', selectedParentPath: root });
    const plan = service.prepareImport({
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [source],
      skipContentHash: true,
      skipLibraryDuplicateScan: true,
    });
    if (!isImportConflictPlan(plan)) throw new Error('expected an import conflict plan');
    externalPath = path.join(library.libraryPath, 'Assets', 'bulk-race.png');

    expectServiceCode(() => service.resolveImport({
      importId: plan.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    }), 'IMPORT_APPLY_FAILED');
    expect(readFileSync(externalPath, 'utf8')).toBe('external bytes');
    expect(existsSync(path.join(library.libraryPath, '.worldlinebox', 'operations', plan.importId)))
      .toBe(false);
  });

  it.each([
    { sourceName: 'icon.png', orphanName: 'ICON.PNG', copyName: 'icon (2).png' },
    { sourceName: 'Café.png', orphanName: 'Cafe\u0301.png', copyName: 'Café (2).png' },
  ])(
    'keeps a bulk import moving around an unindexed portable-name orphan ($sourceName)',
    ({ sourceName, orphanName, copyName }) => {
      const root = temporaryRoot();
      const source = path.join(root, 'incoming', sourceName);
      mkdirSync(path.dirname(source));
      writeFileSync(source, 'imported bytes');
      const service = newService({ observerFactory: () => ({ close() {} }) });
      const library = service.createLibrary({ displayName: 'Bulk orphan', selectedParentPath: root });
      const orphanPath = path.join(library.libraryPath, 'Assets', orphanName);
      writeFileSync(orphanPath, 'external bytes');

      const plan = service.prepareImport({
        libraryId: library.libraryId,
        sourceKind: 'files',
        sourcePaths: [source],
        skipContentHash: true,
        skipLibraryDuplicateScan: true,
      });
      if (!isImportConflictPlan(plan)) throw new Error('expected an import conflict plan');
      expect(plan.nameConflictCount).toBe(1);
      const completion = service.resolveImport({
        importId: plan.importId,
        suspectedDuplicate: 'skip',
        nameConflict: 'keep-both',
      });

      expect(completion.importedCount).toBe(1);
      expect(service.listAssets({ libraryId: library.libraryId, recursive: true })
        .map((asset) => asset.relativeFilePath)).toEqual([copyName]);
      expect(databaseFor(service, library.libraryId).prepare(
        `SELECT location_kind FROM assets
          WHERE relative_file_path = ? AND deleted_at IS NULL`,
      ).get(copyName)).toEqual({ location_kind: 'managed' });
      expect(readFileSync(orphanPath, 'utf8')).toBe('external bytes');
      expect(readFileSync(path.join(library.libraryPath, 'Assets', copyName), 'utf8'))
        .toBe('imported bytes');
      expect(readFileSync(source, 'utf8')).toBe('imported bytes');
    },
  );

  it('uses a missing on-disk destination as a normal managed import target', () => {
    const root = temporaryRoot();
    const initialSource = path.join(root, 'initial', 'missing.png');
    const replacementSource = path.join(root, 'replacement', 'missing.png');
    mkdirSync(path.dirname(initialSource));
    mkdirSync(path.dirname(replacementSource));
    writeFileSync(initialSource, 'initial bytes');
    writeFileSync(replacementSource, 'new bytes');
    const service = newService();
    const library = service.createLibrary({ displayName: 'Missing managed file', selectedParentPath: root });
    const initial = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [initialSource],
    });
    const first = service.resolveImport({
      importId: initial.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });
    rmSync(path.join(library.libraryPath, 'Assets', 'missing.png'));

    const plan = prepareConflict(service, {
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [replacementSource],
    });
    expect(plan.nameConflictCount).toBe(0);
    const completion = service.resolveImport({
      importId: plan.importId,
      suspectedDuplicate: 'skip',
      nameConflict: 'keep-both',
    });
    expect(completion.assets[0]?.assetId).toBe(first.assets[0]?.assetId);
    expect(readFileSync(path.join(library.libraryPath, 'Assets', 'missing.png'), 'utf8'))
      .toBe('new bytes');
  });

  it.each([
    { scenario: 'occupied destination', removeDestination: false, nameConflict: 'replace' },
    { scenario: 'missing destination', removeDestination: true, nameConflict: 'keep-both' },
  ] as const)(
    'reuses the active managed asset when its current revision is NULL ($scenario)',
    ({ removeDestination, nameConflict }) => {
      const root = temporaryRoot();
      const initialSource = path.join(root, 'initial', 'recover.png');
      const replacementSource = path.join(root, 'replacement', 'recover.png');
      mkdirSync(path.dirname(initialSource));
      mkdirSync(path.dirname(replacementSource));
      writeFileSync(initialSource, 'original bytes');
      writeFileSync(replacementSource, 'replacement bytes');

      const service = newService({ observerFactory: () => ({ close() {} }) });
      const library = service.createLibrary({ displayName: 'NULL current revision', selectedParentPath: root });
      const initial = prepareConflict(service, {
        libraryId: library.libraryId,
        sourceKind: 'files',
        sourcePaths: [initialSource],
      });
      const original = service.resolveImport({
        importId: initial.importId,
        suspectedDuplicate: 'skip',
        nameConflict: 'keep-both',
      });
      const assetId = original.assets[0]!.assetId;
      const managedPath = path.join(library.libraryPath, 'Assets', 'recover.png');
      if (removeDestination) rmSync(managedPath);
      databaseFor(service, library.libraryId).prepare(
        'UPDATE assets SET current_revision_id = NULL WHERE asset_id = ?',
      ).run(assetId);

      const beforeImport = databaseFor(service, library.libraryId).prepare(
        'SELECT current_revision_id FROM assets WHERE asset_id = ?',
      ).get(assetId) as { current_revision_id: string | null };
      expect(beforeImport.current_revision_id).toBeNull();

      const replacement = prepareConflict(service, {
        libraryId: library.libraryId,
        sourceKind: 'files',
        sourcePaths: [replacementSource],
      });
      const completion = service.resolveImport({
        importId: replacement.importId,
        suspectedDuplicate: 'skip',
        nameConflict,
      });

      expect(completion.assets[0]?.assetId).toBe(assetId);
      expect(readFileSync(managedPath, 'utf8')).toBe('replacement bytes');
      const afterImport = databaseFor(service, library.libraryId).prepare(
        'SELECT current_revision_id FROM assets WHERE asset_id = ?',
      ).get(assetId) as { current_revision_id: string | null };
      expect(afterImport.current_revision_id).toBeTruthy();
    },
  );
});
