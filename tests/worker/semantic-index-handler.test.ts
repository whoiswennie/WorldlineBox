import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerCommand, WorkerRequest } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';
import { embeddingTextRevision } from '../../src/shared/embedding/profile';
import { performanceLaneForCommand } from '../../src/shared/performance-contract';
import { LibraryService } from '../../src/worker/library-service';
import { closeSemanticIndexWorkerLibrary, executeSemanticIndexWorkerCommand, reconcileSemanticPermanentDeletes, reserveSemanticDeleteCleanup, semanticPermanentDeleteCandidates, withSemanticDeleteCleanupStatus } from '../../src/worker/handlers/semantic-index';
import { SemanticIndexStore } from '../../src/worker/semantic-index-store';
import { InteractiveScheduler } from '../../src/worker/interactive-scheduler';

const require = createRequire(import.meta.url);
interface TestDatabase {
  close(): void;
  pragma(source: string): unknown;
  prepare(sql: string): { run(...parameters: unknown[]): { changes: number } };
}
const Database = require('better-sqlite3') as new (filename: string) => TestDatabase;
const roots: string[] = [];
const services: LibraryService[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeSemanticIndexWorkerLibrary();
  for (const service of services.splice(0)) service.closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('semantic SQLite Worker handler', () => {
  it('uses a ready MP4 poster as an image source when the encoder only accepts images', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-video-preview-'));
    roots.push(root);
    const service = new LibraryService();
    services.push(service);
    const library = service.createLibrary({ displayName: 'Video preview fixture', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Assets' });
    const assetId = randomUUID();
    const revisionId = randomUUID();
    const artifactId = randomUUID();
    const relativePath = `${folder.relativePath}/clip.mp4`;
    const videoBytes = Buffer.from('synthetic mp4 payload');
    const previewBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const previewRelativePath = 'clip-poster.jpg';
    const previewPath = path.join(library.libraryPath, '.worldlinebox', 'artifacts', previewRelativePath);
    mkdirSync(path.dirname(previewPath), { recursive: true });
    writeFileSync(previewPath, previewBytes);
    const now = new Date().toISOString();
    const db = new Database(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
    try {
      db.prepare(`INSERT INTO assets (asset_id, location_kind, managed_folder_id, linked_folder_id,
        relative_file_path, current_revision_id, availability, path_identity, created_at, updated_at)
        VALUES (?, 'managed', ?, NULL, ?, NULL, 'available', ?, ?, ?)`).run(
        assetId, folder.folderId, relativePath, relativePath, now, now,
      );
      db.prepare(`INSERT INTO revisions (revision_id, asset_id, parent_revision_id, byte_size,
        modified_at, original_filename, origin, accepted_at)
        VALUES (?, ?, NULL, 1, ?, 'clip.mp4', 'import', ?)`).run(revisionId, assetId, now, now);
      db.prepare('UPDATE assets SET current_revision_id = ? WHERE asset_id = ?').run(revisionId, assetId);
      db.prepare(`INSERT INTO revision_artifacts (artifact_id, revision_id, kind, mime_type, byte_size,
        file_path, width, height, generator_version, status, generated_at, invalidated_at)
        VALUES (?, ?, 'video_poster', 'image/jpeg', ?, ?, 1, 1, 'fixture', 'ready', ?, NULL)`)
        .run(artifactId, revisionId, previewBytes.byteLength, previewRelativePath, now);
    } finally {
      db.close();
    }
    const sourcePath = service.resolveAssetPath(library.libraryId, assetId);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, videoBytes);

    const sessionGeneration = randomUUID();
    const profileKey = 'video-preview-image-only';
    const call = async (command: WorkerCommand): Promise<WorkerResult> => {
      const result = await executeSemanticIndexWorkerCommand(service,
        { requestId: randomUUID(), command } as WorkerRequest,
        { runWithoutAdmission: async (work) => work() });
      if (!result) throw new Error(`Worker did not handle ${command.type}`);
      return result;
    };
    await call({ type: 'semantic.index.begin', libraryId: library.libraryId, sessionGeneration,
      profileKey, dimensions: 3, modelRevision: 'fixture-model-v1', modality: 'mixed',
      modalities: ['image'], maxInputBytes: 1024 });

    const targets = await call({ type: 'semantic.index.targets', libraryId: library.libraryId,
      sessionGeneration, modalities: ['image'], offset: 0, limit: 20 });
    expect(targets).toMatchObject({
      ok: true,
      type: 'semantic.index.targets',
      targets: [{ assetId, kind: 'image', modality: 'image', alreadyIndexed: false }],
    });

    const similar = await call({ type: 'semantic.index.similar', libraryId: library.libraryId,
      sessionGeneration, queryId: randomUUID(), profileKey, sourceAssetId: assetId });
    expect(similar).toMatchObject({
      ok: true,
      type: 'semantic.index.ranked',
      sourceStatus: 'preparing',
      sourceTarget: { assetId, kind: 'image', modality: 'image' },
    });

    const sourceRevision = (targets as { targets: Array<{ sourceRevision: string }> }).targets[0]!.sourceRevision;
    const prepared = await call({ type: 'semantic.index.prepare', libraryId: library.libraryId, sessionGeneration,
      assetId, sourceRevision, kind: 'image', maxInputBytes: 1024 });
    expect(prepared).toMatchObject({ ok: true, type: 'semantic.index.prepared', assetId,
      sourceRevision, kind: 'image', mimeType: 'image/jpeg', bytesBase64: previewBytes.toString('base64') });
    const claimToken = randomUUID();
    expect(await call({ type: 'semantic.index.job', action: 'claim', libraryId: library.libraryId,
      sessionGeneration, assetId, sourceRevision, claimToken }))
      .toMatchObject({ ok: true, type: 'semantic.index.job-updated', updated: true });
    expect(await call({ type: 'semantic.index.write', libraryId: library.libraryId, sessionGeneration,
      profileKey, vectors: [{ assetId, sourceRevision, claimToken, vector: [1, 0, 0] }] }))
      .toMatchObject({ ok: true, type: 'semantic.index.written', accepted: [assetId], rejected: [] });

    expect(await call({ type: 'semantic.index.similar', libraryId: library.libraryId,
      sessionGeneration, queryId: randomUUID(), profileKey, sourceAssetId: assetId }))
      .toMatchObject({ ok: true, type: 'semantic.index.ranked', sourceStatus: 'ready' });

    rmSync(previewPath);
    await expect(call({ type: 'semantic.index.prepare', libraryId: library.libraryId, sessionGeneration,
      assetId, sourceRevision, kind: 'image', maxInputBytes: 1024 })).rejects.toThrow();

    await call({ type: 'semantic.index.close', libraryId: library.libraryId, sessionGeneration });
    const cleanupDb = new Database(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
    cleanupDb.prepare('DELETE FROM revision_artifacts WHERE artifact_id = ?').run(artifactId);
    cleanupDb.close();
    const videoSessionGeneration = randomUUID();
    const videoProfileKey = 'video-native-image-fallback';
    await call({ type: 'semantic.index.begin', libraryId: library.libraryId,
      sessionGeneration: videoSessionGeneration, profileKey: videoProfileKey, dimensions: 3,
      modelRevision: 'fixture-model-v1', modality: 'mixed', modalities: ['video', 'image', 'audio', 'text'],
      maxInputBytes: 1024 });
    const videoTargets = await call({ type: 'semantic.index.targets', libraryId: library.libraryId,
      sessionGeneration: videoSessionGeneration, modalities: ['video', 'image', 'audio', 'text'],
      offset: 0, limit: 20 });
    expect(videoTargets).toMatchObject({ ok: true, type: 'semantic.index.targets',
      targets: [{ assetId, sourceRevision: revisionId, kind: 'video', modality: 'video' }] });
    const preparedVideo = await call({ type: 'semantic.index.prepare', libraryId: library.libraryId,
      sessionGeneration: videoSessionGeneration, assetId, sourceRevision: revisionId,
      kind: 'video', maxInputBytes: 1024 });
    expect(preparedVideo).toMatchObject({ ok: true, type: 'semantic.index.prepared', assetId,
      sourceRevision: revisionId, kind: 'video', mimeType: 'video/mp4',
      bytesBase64: videoBytes.toString('base64') });
    await expect(call({ type: 'semantic.index.prepare', libraryId: library.libraryId,
      sessionGeneration: videoSessionGeneration, assetId, sourceRevision: revisionId,
      kind: 'video', maxInputBytes: 2 })).rejects.toThrow(/video.*size|size.*video/i);
    const videoClaimToken = randomUUID();
    expect(await call({ type: 'semantic.index.job', action: 'claim', libraryId: library.libraryId,
      sessionGeneration: videoSessionGeneration, assetId, sourceRevision: revisionId,
      claimToken: videoClaimToken })).toMatchObject({ ok: true, type: 'semantic.index.job-updated', updated: true });
    expect(await call({ type: 'semantic.index.write', libraryId: library.libraryId,
      sessionGeneration: videoSessionGeneration, profileKey: videoProfileKey,
      vectors: [{ assetId, sourceRevision: revisionId, claimToken: videoClaimToken, vector: [1, 0, 0] }] }))
      .toMatchObject({ ok: true, type: 'semantic.index.written', accepted: [assetId], rejected: [] });
    expect(await call({ type: 'semantic.index.similar', libraryId: library.libraryId,
      sessionGeneration: videoSessionGeneration, queryId: randomUUID(), profileKey: videoProfileKey,
      sourceAssetId: assetId })).toMatchObject({ ok: true, type: 'semantic.index.ranked', sourceStatus: 'ready' });
  });

  it('enumerates and reserves purge cleanup in bounded batches beyond 100,000 assets', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-purge-large-'));
    roots.push(root);
    const service = new LibraryService();
    services.push(service);
    const library = service.createLibrary({ displayName: 'Large purge fixture', selectedParentPath: root });
    const assetIds = Array.from({ length: 100_001 }, (_, index) => `fixture-${index}`);
    const catalog = {
      getBrowseChangeSequence: () => 1,
      searchAssets: ({ offset, limit }: { offset: number; limit: number }) => ({
        total: assetIds.length,
        assetIds: assetIds.slice(offset, offset + limit),
      }),
    } as unknown as LibraryService;
    const candidates = semanticPermanentDeleteCandidates(catalog,
      { type: 'asset.purge-trash', libraryId: library.libraryId } as WorkerCommand);
    expect(candidates).toHaveLength(assetIds.length);

    reserveSemanticDeleteCleanup(service, library.libraryId, candidates);
    const queueDirectory = path.join(library.libraryPath, '.worldlinebox', 'semantic');
    const queueFiles = readdirSync(queueDirectory)
      .filter((name) => /^permanent-delete-pending(?:-[a-f0-9-]{36})?\.json$/u.test(name));
    expect(queueFiles).toHaveLength(2);
    const queued = queueFiles.flatMap((name) => {
      const record = JSON.parse(readFileSync(path.join(queueDirectory, name), 'utf8')) as {
        assetIds: string[];
      };
      return record.assetIds;
    });
    expect(new Set(queued).size).toBe(assetIds.length);
    expect(queued).toHaveLength(assetIds.length);
  });

  it('snapshots purge candidates after the bounded writer callback begins', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-purge-snapshot-'));
    roots.push(root);
    const service = new LibraryService();
    services.push(service);
    const library = service.createLibrary({ displayName: 'Purge snapshot fixture', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Assets' });
    const relativePath = `${folder.relativePath}/queued.txt`;
    const filePath = path.join(library.libraryPath, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'synthetic purge snapshot content');
    const assetId = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const db = new Database(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
    try {
      db.prepare(`INSERT INTO assets (asset_id, location_kind, managed_folder_id, linked_folder_id,
        relative_file_path, current_revision_id, availability, path_identity, created_at, updated_at)
        VALUES (?, 'managed', ?, NULL, ?, NULL, 'available', ?, ?, ?)`).run(
        assetId, folder.folderId, relativePath, relativePath, now, now,
      );
      db.prepare(`INSERT INTO revisions (revision_id, asset_id, parent_revision_id, byte_size,
        modified_at, original_filename, origin, accepted_at)
        VALUES (?, ?, NULL, ?, ?, ?, 'import', ?)`).run(
        revisionId, assetId, Buffer.byteLength('synthetic purge snapshot content'), now, 'queued.txt', now,
      );
      db.prepare('UPDATE assets SET current_revision_id = ? WHERE asset_id = ?').run(revisionId, assetId);
    } finally {
      db.close();
    }
    const command = { type: 'asset.purge-trash', libraryId: library.libraryId } as WorkerCommand;
    expect(semanticPermanentDeleteCandidates(service, command)).toEqual([]);
    service.trashAssets({ libraryId: library.libraryId, assetIds: [assetId] });
    const candidates = await service.runBoundedWrite(library.libraryId,
      () => semanticPermanentDeleteCandidates(service, command));
    expect(candidates).toEqual([assetId]);
  });

  it('rebuilds only the derived semantic sidecar through an explicit Worker command', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-rebuild-'));
    roots.push(root);
    const service = new LibraryService();
    services.push(service);
    const library = service.createLibrary({ displayName: 'Rebuild fixture', selectedParentPath: root });
    const sidecar = path.join(library.libraryPath, '.worldlinebox', 'semantic', 'index.sqlite');
    const core = path.join(library.libraryPath, '.worldlinebox', 'library.db');
    const prior = new SemanticIndexStore({ libraryPath: library.libraryPath, libraryId: library.libraryId,
      storageKind: 'local' });
    prior.ensureProfile({ profileKey: 'rebuild-profile', dimensions: 2, modelRevision: 'v1', modality: 'image' });
    prior.close();
    const cleanupQueue = path.join(library.libraryPath, '.worldlinebox', 'semantic', 'permanent-delete-pending.json');
    writeFileSync(cleanupQueue, '{ malformed queue');
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(path.join(library.libraryPath, '.worldlinebox', 'semantic',
        `permanent-delete-pending-${randomUUID()}.json`), '{}');
    }

    await expect(executeSemanticIndexWorkerCommand(service, {
      requestId: randomUUID(),
      command: { type: 'semantic.index.begin', libraryId: library.libraryId,
        sessionGeneration: randomUUID(), profileKey: 'bounded-queue-profile', dimensions: 2,
        modelRevision: 'v1', modality: 'image', maxInputBytes: 1024 },
    } as WorkerRequest, { runWithoutAdmission: async (work) => work() }))
      .rejects.toThrow('Semantic cleanup queue has too many files.');

    const result = await executeSemanticIndexWorkerCommand(service, {
      requestId: randomUUID(),
      command: { type: 'semantic.index.rebuild', libraryId: library.libraryId,
        sessionGeneration: randomUUID(), confirmed: true },
    } as WorkerRequest, { runWithoutAdmission: async (work) => work() });
    expect(result).toMatchObject({ ok: true, type: 'semantic.index.rebuilt' });
    expect(existsSync(cleanupQueue)).toBe(false);
    expect(readdirSync(path.dirname(cleanupQueue)).some((name) => name.startsWith('permanent-delete-pending-')))
      .toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    expect(existsSync(core)).toBe(true);
    const begin = await executeSemanticIndexWorkerCommand(service, {
      requestId: randomUUID(),
      command: { type: 'semantic.index.begin', libraryId: library.libraryId,
        sessionGeneration: randomUUID(), profileKey: 'rebuild-after-corruption', dimensions: 2,
        modelRevision: 'v1', modality: 'image', maxInputBytes: 1024 },
    } as WorkerRequest, { runWithoutAdmission: async (work) => work() });
    expect(begin).toMatchObject({ ok: true, type: 'semantic.index.started' });
    await closeSemanticIndexWorkerLibrary(library.libraryId);
    const reopened = new SemanticIndexStore({ libraryPath: library.libraryPath, libraryId: library.libraryId,
      storageKind: 'local' });
    try {
      expect(reopened.ensureProfile({ profileKey: 'rebuild-profile', dimensions: 2,
        modelRevision: 'v1', modality: 'image' })).toBeTruthy();
    } finally {
      reopened.close();
    }
    expect(existsSync(core)).toBe(true);
    const future = new Database(sidecar);
    future.pragma('user_version = 999');
    future.close();
    writeFileSync(cleanupQueue, JSON.stringify({ version: 1, libraryId: library.libraryId, assetIds: [randomUUID()] }));
    await expect(executeSemanticIndexWorkerCommand(service, {
      requestId: randomUUID(),
      command: { type: 'semantic.index.rebuild', libraryId: library.libraryId,
        sessionGeneration: randomUUID(), confirmed: true },
    } as WorkerRequest, { runWithoutAdmission: async (work) => work() }))
      .rejects.toThrow('Semantic index schema is newer than this application.');
    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(cleanupQueue)).toBe(true);
    expect(existsSync(core)).toBe(true);
  });

  it('imports a current-revision legacy vector once and keeps it across Worker-session restart', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-legacy-'));
    roots.push(root);
    const service = new LibraryService();
    services.push(service);
    const library = service.createLibrary({ displayName: 'Legacy migration fixture', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Assets' });
    const relativePath = `${folder.relativePath}/legacy.png`;
    const absolutePath = path.join(library.libraryPath, 'Assets', relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, 'synthetic legacy image bytes');
    const assetId = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const db = new Database(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
    try {
      db.prepare(`INSERT INTO assets (asset_id, location_kind, managed_folder_id, linked_folder_id,
        relative_file_path, current_revision_id, availability, path_identity, created_at, updated_at)
        VALUES (?, 'managed', ?, NULL, ?, ?, 'available', ?, ?, ?)`).run(
        assetId, folder.folderId, relativePath, revisionId, relativePath, now, now,
      );
      db.prepare(`INSERT INTO revisions (revision_id, asset_id, parent_revision_id, byte_size,
        modified_at, original_filename, origin, accepted_at)
        VALUES (?, ?, NULL, ?, ?, ?, 'import', ?)`).run(
        revisionId, assetId, 29, now, 'legacy.png', now,
      );
    } finally {
      db.close();
    }

    vi.stubEnv('WORLDLINEBOX_SEMANTIC_LEGACY_CACHE_ROOT', root);
    const cacheDirectory = path.join(root, 'embedding-http-index', library.libraryId);
    mkdirSync(cacheDirectory, { recursive: true });
    const cachePath = path.join(cacheDirectory, 'fixture-service.json');
    const profileKey = 'legacy-http-profile';
    writeFileSync(cachePath, JSON.stringify({ version: 1, profileKey, entries: [
      { assetId, revisionId, vector: [8, 0] },
    ] }));

    const sessionGeneration = randomUUID();
    const call = async (command: WorkerCommand): Promise<WorkerResult> => {
      const result = await executeSemanticIndexWorkerCommand(service,
        { requestId: randomUUID(), command } as WorkerRequest,
        { runWithoutAdmission: async (work) => work() });
      if (!result) throw new Error(`Worker did not handle ${command.type}`);
      return result;
    };
    const begin = (generation: string) => call({ type: 'semantic.index.begin', libraryId: library.libraryId,
      sessionGeneration: generation, profileKey, dimensions: 2, modelRevision: 'legacy-http-v1',
      modality: 'image', maxInputBytes: 1024 });
    expect(await begin(sessionGeneration)).toMatchObject({ ok: true, type: 'semantic.index.started' });
    expect(await call({ type: 'semantic.index.import-legacy', libraryId: library.libraryId,
      sessionGeneration, cacheKind: 'http', cacheId: 'fixture-service' }))
      .toMatchObject({ ok: true, type: 'semantic.index.legacy-imported', attempted: true,
        acceptedRows: 1, rejectedRows: 0 });
    const malformedCachePath = path.join(cacheDirectory, 'fixture-malformed.json');
    writeFileSync(malformedCachePath, `${JSON.stringify({ version: 1, profileKey, entries:
      Array.from({ length: 128 }, () => ({ assetId, revisionId, vector: [0, 8] })) })} trailing garbage`);
    expect(await call({ type: 'semantic.index.import-legacy', libraryId: library.libraryId,
      sessionGeneration, cacheKind: 'http', cacheId: 'fixture-malformed' }))
      .toMatchObject({ ok: true, type: 'semantic.index.legacy-imported', attempted: false,
        acceptedRows: 0, rejectedRows: 0 });
    expect(() => lstatSync(malformedCachePath)).not.toThrow();
    expect(await call({ type: 'semantic.index.search', libraryId: library.libraryId, sessionGeneration,
      queryId: randomUUID(), profileKey, vector: [1, 0], filters: [], scope: null, showIgnored: false }))
      .toMatchObject({ ok: true, type: 'semantic.index.ranked', assetIds: [assetId] });

    const store = new SemanticIndexStore({ libraryPath: library.libraryPath,
      libraryId: library.libraryId, storageKind: 'local' });
    try {
      const profileId = store.ensureProfile({ profileKey, dimensions: 2,
        modelRevision: 'legacy-http-v1', modality: 'image' });
      expect(Array.from(store.vectorFor(profileId, assetId, revisionId) ?? [])).toEqual([1, 0]);
    } finally {
      store.close();
    }
    await call({ type: 'semantic.index.close', libraryId: library.libraryId, sessionGeneration });
    const restartedGeneration = randomUUID();
    await begin(restartedGeneration);
    expect(await call({ type: 'semantic.index.import-legacy', libraryId: library.libraryId,
      sessionGeneration: restartedGeneration, cacheKind: 'http', cacheId: 'fixture-service' }))
      .toMatchObject({ ok: true, type: 'semantic.index.legacy-imported', attempted: true,
        acceptedRows: 0, rejectedRows: 0 });
    expect(() => lstatSync(cachePath)).not.toThrow();
    expect(await call({ type: 'semantic.index.search', libraryId: library.libraryId,
      sessionGeneration: restartedGeneration, queryId: randomUUID(), profileKey, vector: [1, 0],
      filters: [], scope: null, showIgnored: false }))
      .toMatchObject({ ok: true, type: 'semantic.index.ranked', assetIds: [assetId] });
  });

  it('reports a stale claim only as rejected and does not persist its vector', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-handler-'));
    roots.push(root);
    const service = new LibraryService();
    services.push(service);
    const library = service.createLibrary({ displayName: 'Temporary handler fixture', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Assets' });
    const displayName = 'sample.txt';
    const relativePath = `${folder.relativePath}/${displayName}`;
    const contentPath = path.join(library.libraryPath, 'Assets', relativePath);
    mkdirSync(path.dirname(contentPath), { recursive: true });
    writeFileSync(contentPath, 'Temporary text content for a semantic index test.');
    const assetId = randomUUID();
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    const db = new Database(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
    try {
      db.prepare(`INSERT INTO assets (asset_id, location_kind, managed_folder_id, linked_folder_id,
        relative_file_path, current_revision_id, availability, path_identity, created_at, updated_at)
        VALUES (?, 'managed', ?, NULL, ?, NULL, 'available', ?, ?, ?)`).run(
        assetId, folder.folderId, relativePath, relativePath, now, now,
      );
      db.prepare(`INSERT INTO revisions (revision_id, asset_id, parent_revision_id, byte_size,
        modified_at, original_filename, origin, accepted_at)
        VALUES (?, ?, NULL, ?, ?, ?, 'import', ?)`).run(revisionId, assetId, 64, now, displayName, now);
      db.prepare('UPDATE assets SET current_revision_id = ? WHERE asset_id = ?').run(revisionId, assetId);
      const insertManyAsset = db.prepare(`INSERT INTO assets (asset_id, location_kind, managed_folder_id, linked_folder_id,
        relative_file_path, current_revision_id, availability, path_identity, created_at, updated_at)
        VALUES (?, 'managed', ?, NULL, ?, ?, 'available', ?, ?, ?)`);
      const insertManyRevision = db.prepare(`INSERT INTO revisions (revision_id, asset_id, parent_revision_id, byte_size,
        modified_at, original_filename, origin, accepted_at)
        VALUES (?, ?, NULL, 40, ?, ?, 'import', ?)`);
      const updateManyCurrentRevision = db.prepare('UPDATE assets SET current_revision_id = ? WHERE asset_id = ?');
      for (let index = 0; index < 600; index += 1) {
        const id = randomUUID();
        const revision = randomUUID();
        const name = `cancel-${String(index).padStart(4, '0')}.txt`;
        const relative = `${folder.relativePath}/${name}`;
        insertManyAsset.run(id, folder.folderId, relative, revision, relative, now, now);
        insertManyRevision.run(revision, id, now, name, now);
        updateManyCurrentRevision.run(revision, id);
      }
    } finally {
      db.close();
    }

    let sessionGeneration = randomUUID();
    const profileKey = 'semantic-handler-test';
    vi.stubEnv('WORLDLINEBOX_SEMANTIC_LEGACY_CACHE_ROOT', root);
    const legacyDirectory = path.join(root, 'embedding-test-index', library.libraryId);
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyCachePath = path.join(legacyDirectory, 'model-test.json');
    writeFileSync(legacyCachePath, JSON.stringify({ version: 1, profileKey, entries: [
      { assetId, revisionId: embeddingTextRevision(revisionId), vector: [1, 0, 0] },
    ] }));
    const call = async (command: WorkerCommand): Promise<WorkerResult> => {
      const result = await executeSemanticIndexWorkerCommand(service,
        { requestId: randomUUID(), command } as WorkerRequest,
        { runWithoutAdmission: async (work) => work() });
      if (!result) throw new Error(`Worker did not handle ${command.type}`);
      return result;
    };
    await call({ type: 'semantic.index.begin', libraryId: library.libraryId, sessionGeneration,
      profileKey, dimensions: 3, modelRevision: 'fixture-model-v1', modality: 'text', maxInputBytes: 1024 });
    expect(await call({ type: 'semantic.index.import-legacy', libraryId: library.libraryId,
      sessionGeneration, cacheKind: 'local', cacheId: 'model-test' }))
      .toMatchObject({ ok: true, type: 'semantic.index.legacy-imported', attempted: true,
        acceptedRows: 0, rejectedRows: 1 });
    expect(() => lstatSync(legacyCachePath)).not.toThrow();
    const [asset] = service.getSemanticAssetSources(library.libraryId, [assetId]);
    expect(asset).toBeDefined();
    const sourceRevision = `${embeddingTextRevision(asset!.currentRevisionId)}\ntitle:${asset!.displayName}`;
    const oldClaim = randomUUID();
    const nextClaim = randomUUID();
    const claim = (claimToken: string) => call({ type: 'semantic.index.job', action: 'claim',
      libraryId: library.libraryId, sessionGeneration, assetId, sourceRevision, claimToken });
    expect(await claim(oldClaim)).toMatchObject({ ok: true, type: 'semantic.index.job-updated', updated: true });
    await call({ type: 'semantic.index.close', libraryId: library.libraryId, sessionGeneration });
    sessionGeneration = randomUUID();
    await call({ type: 'semantic.index.begin', libraryId: library.libraryId, sessionGeneration,
      profileKey, dimensions: 3, modelRevision: 'fixture-model-v1', modality: 'text', maxInputBytes: 1024 });
    expect(await claim(nextClaim)).toMatchObject({ ok: true, type: 'semantic.index.job-updated', updated: true });

    const write = await call({ type: 'semantic.index.write', libraryId: library.libraryId,
      sessionGeneration, profileKey, vectors: [{ assetId, sourceRevision, claimToken: oldClaim, vector: [1, 0, 0] }] });
    expect(write).toMatchObject({ ok: true, type: 'semantic.index.written', accepted: [], rejected: [assetId] });

    const store = new SemanticIndexStore({ libraryPath: library.libraryPath,
      libraryId: library.libraryId, storageKind: 'local' });
    try {
      const profileId = store.ensureProfile({ profileKey, dimensions: 3,
        modelRevision: 'fixture-model-v1', modality: 'text' });
      expect(store.vectorFor(profileId, assetId, sourceRevision)).toBeNull();
    } finally {
      store.close();
    }

    const validClaim = randomUUID();
    expect(await claim(validClaim)).toMatchObject({ ok: true, type: 'semantic.index.job-updated', updated: true });
    expect(await call({ type: 'semantic.index.write', libraryId: library.libraryId, sessionGeneration,
      profileKey, vectors: [{ assetId, sourceRevision, claimToken: validClaim, vector: [1, 0, 0] }] }))
      .toMatchObject({ ok: true, type: 'semantic.index.written', accepted: [assetId] });
    let broadEpochRead = 0;
    const sequenceSpy = vi.spyOn(service, 'getChangeSequence').mockImplementation(() => {
      broadEpochRead += 1;
      return broadEpochRead === 1 ? 1 : 2;
    });
    const ranked = await call({ type: 'semantic.index.search', libraryId: library.libraryId,
      sessionGeneration, queryId: randomUUID(), profileKey, vector: [1, 0, 0], filters: [],
      scope: null, showIgnored: false });
    sequenceSpy.mockRestore();
    expect(ranked).toMatchObject({ ok: true, type: 'semantic.index.ranked', cancelled: false });
    if (ranked.ok && ranked.type === 'semantic.index.ranked') expect(ranked.assetIds).toContain(assetId);

    const trashStore = new SemanticIndexStore({ libraryPath: library.libraryPath,
      libraryId: library.libraryId, storageKind: 'local' });
    try {
      const profileId = trashStore.ensureProfile({ profileKey, dimensions: 3,
        modelRevision: 'fixture-model-v1', modality: 'text' });
      trashStore.upsertBatch(profileId, [{ assetId, sourceRevision, vector: [1, 0, 0] }]);
      const updateTrash = new Database(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
      updateTrash.prepare("UPDATE assets SET deleted_at = ? WHERE asset_id = ?").run(now, assetId);
      updateTrash.close();
      reconcileSemanticPermanentDeletes(service, library.libraryId, [assetId]);
      expect(trashStore.vectorFor(profileId, assetId, sourceRevision)).not.toBeNull();
    } finally {
      trashStore.close();
    }
    const deleteCatalogAsset = new Database(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
    deleteCatalogAsset.prepare('DELETE FROM assets WHERE asset_id = ?').run(assetId);
    deleteCatalogAsset.close();
    const cleanupQueueDirectory = path.join(library.libraryPath, '.worldlinebox', 'semantic');
    const failedRemoval = vi.spyOn(SemanticIndexStore.prototype, 'removeAsset').mockImplementation(() => {
      throw new Error('synthetic sidecar write failure');
    });
    const purgeResult = withSemanticDeleteCleanupStatus(service, library.libraryId, [assetId], {
      ok: true, type: 'asset.purge-trash', purgedCount: 1, skippedCount: 0, failures: [],
    });
    expect(purgeResult).toMatchObject({ ok: true, type: 'asset.purge-trash', semanticCleanupPending: true });
    const secondDeletedAssetId = randomUUID();
    expect(() => reserveSemanticDeleteCleanup(service, library.libraryId, [secondDeletedAssetId]))
      .toThrow('synthetic sidecar write failure');
    expect(readdirSync(cleanupQueueDirectory).filter((name) => name.startsWith('permanent-delete-pending')))
      .toHaveLength(1);
    failedRemoval.mockRestore();
    await call({ type: 'semantic.index.close', libraryId: library.libraryId, sessionGeneration });
    sessionGeneration = randomUUID();
    await call({ type: 'semantic.index.begin', libraryId: library.libraryId, sessionGeneration,
      profileKey, dimensions: 3, modelRevision: 'fixture-model-v1', modality: 'text', maxInputBytes: 1024 });
    expect(readdirSync(cleanupQueueDirectory).some((name) => name.startsWith('permanent-delete-pending'))).toBe(false);
    reserveSemanticDeleteCleanup(service, library.libraryId, [secondDeletedAssetId]);
    const retryResult = withSemanticDeleteCleanupStatus(service, library.libraryId, [secondDeletedAssetId], {
      ok: true, type: 'asset.purge-trash', purgedCount: 1, skippedCount: 0, failures: [],
    });
    expect(retryResult).toMatchObject({ ok: true, type: 'asset.purge-trash' });
    expect(retryResult).not.toHaveProperty('semanticCleanupPending');
    const reconciledStore = new SemanticIndexStore({ libraryPath: library.libraryPath,
      libraryId: library.libraryId, storageKind: 'local' });
    try {
      const profileId = reconciledStore.ensureProfile({ profileKey, dimensions: 3,
        modelRevision: 'fixture-model-v1', modality: 'text' });
      expect(reconciledStore.vectorFor(profileId, assetId, sourceRevision)).toBeNull();
      expect(reconciledStore.jobFor(profileId, assetId)).toBeNull();
    } finally {
      reconciledStore.close();
    }

    const scheduler = new InteractiveScheduler();
    const queryId = randomUUID();
    const searchRequestId = randomUUID();
    let browseRan = false;
    let browsePromise: Promise<void> | undefined;
    let cancelPromise: Promise<WorkerResult | undefined> | undefined;
    let injectedBrowse = false;
    const searchCommand: WorkerCommand = { type: 'semantic.index.search', libraryId: library.libraryId,
      sessionGeneration, queryId, profileKey, vector: [1, 0, 0], scope: null, filters: [], showIgnored: false };
    const search = scheduler.schedule({ requestId: searchRequestId,
      lane: performanceLaneForCommand(searchCommand), libraryId: library.libraryId },
    () => executeSemanticIndexWorkerCommand(service,
      { requestId: searchRequestId, command: searchCommand } as WorkerRequest,
      { runWithoutAdmission: (work) => {
        if (!injectedBrowse) {
          injectedBrowse = true;
          browsePromise = scheduler.schedule({ requestId: randomUUID(), lane: 'interactive-control',
            libraryId: library.libraryId }, () => { browseRan = true; });
        }
        return scheduler.runWithoutAdmission(searchRequestId, work);
      }, onTiming: (phase) => {
        if (phase === 'candidateIds') {
          cancelPromise = executeSemanticIndexWorkerCommand(service,
            { requestId: randomUUID(), command: { type: 'semantic.index.cancel-search',
              libraryId: library.libraryId, sessionGeneration, queryId } } as WorkerRequest,
            { runWithoutAdmission: async (work) => work() });
        }
      } }));
    const searchResult = await search;
    await browsePromise;
    await cancelPromise;
    expect(browseRan).toBe(true);
    expect(searchResult).toMatchObject({ ok: true, type: 'semantic.index.ranked', cancelled: true, assetIds: [] });

    const projectionCalls = vi.spyOn(service, 'getSemanticAssetSources');
    let yields = 0;
    const projectionQueryId = randomUUID();
    const projectionSearch = executeSemanticIndexWorkerCommand(service,
      { requestId: randomUUID(), command: { ...searchCommand, queryId: projectionQueryId } } as WorkerRequest,
      { runWithoutAdmission: async (work) => {
        yields += 1;
        if (yields === 2) {
          await call({ type: 'semantic.index.cancel-search', libraryId: library.libraryId,
            sessionGeneration, queryId: projectionQueryId });
        }
        return work();
      } });
    const projectionCancelled = await projectionSearch;
    expect(projectionCancelled).toMatchObject({
      ok: true, type: 'semantic.index.ranked', cancelled: true, candidateCount: 600, assetIds: [],
    });
    expect(projectionCalls).toHaveBeenCalledTimes(1);
    projectionCalls.mockRestore();
  });
});
