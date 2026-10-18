import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { afterAll, describe, expect, it } from 'vitest';
import type { SearchScope } from '../../src/shared/asset-types';
import { embeddingTextRevision } from '../../src/shared/embedding/profile';
import type { WorkerCommand, WorkerRequest } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';
import { LibraryService } from '../../src/worker/library-service';
import { closeSemanticIndexWorkerLibrary, executeSemanticIndexWorkerCommand } from '../../src/worker/handlers/semantic-index';
import { SemanticIndexStore } from '../../src/worker/semantic-index-store';

const enabled = process.env.WORLDLINEBOX_RUN_SEMANTIC_PERF === '1';
const temporaryRoots: string[] = [];
const services: LibraryService[] = [];
const perfDescribe = enabled ? describe : describe.skip;
const require = createRequire(import.meta.url);

interface TestDatabase {
  close(): void;
  prepare(sql: string): {
    run(...parameters: unknown[]): { changes: number };
  };
  transaction(work: (entries: Array<{ index: number; folderIndex: number }>) => void):
    (entries: Array<{ index: number; folderIndex: number }>) => void;
}

const Database = require('better-sqlite3') as new (filename: string) => TestDatabase;

afterAll(async () => {
  await closeSemanticIndexWorkerLibrary();
  for (const service of services.splice(0)) service.closeAll();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

perfDescribe('semantic SQLite retrieval performance (explicit opt-in)', () => {
  it('measures exact Worker filtering and ranking over 10,000 text assets with precomputed 768D vectors', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-perf-'));
    temporaryRoots.push(root);
    const service = new LibraryService();
    services.push(service);
    const library = service.createLibrary({ displayName: 'Temporary semantic perf library', selectedParentPath: root });
    const folders = [
      service.createManagedFolder({ libraryId: library.libraryId, name: 'SubsetA' }),
      service.createManagedFolder({ libraryId: library.libraryId, name: 'SubsetB' }),
    ];
    const folderPaths = folders.map((folder) => {
      const directory = path.join(library.libraryPath, 'Assets', folder.relativePath);
      mkdirSync(directory, { recursive: true });
      return directory;
    });
    const connection = new Database(path.join(library.libraryPath, '.worldlinebox', 'library.db'));
    const insertAsset = connection.prepare(`INSERT INTO assets
      (asset_id, location_kind, managed_folder_id, linked_folder_id, relative_file_path,
       current_revision_id, availability, path_identity, created_at, updated_at)
      VALUES (?, 'managed', ?, NULL, ?, NULL, 'available', ?, ?, ?)`);
    const insertRevision = connection.prepare(`INSERT INTO revisions
      (revision_id, asset_id, parent_revision_id, byte_size, modified_at, original_filename, origin, accepted_at)
      VALUES (?, ?, NULL, ?, ?, ?, 'import', ?)`);
    const updateRevision = connection.prepare('UPDATE assets SET current_revision_id = ?, updated_at = ? WHERE asset_id = ?');
    const rows: Array<{ assetId: string; revisionId: string; displayName: string }> = [];
    const now = new Date().toISOString();
    const transaction = connection.transaction((entries: Array<{ index: number; folderIndex: number }>) => {
      for (const { index, folderIndex } of entries) {
        const assetId = randomUUID();
        const revisionId = randomUUID();
        const displayName = `semantic-${String(index).padStart(5, '0')}.txt`;
        const relativePath = `${folders[folderIndex]!.relativePath}/${displayName}`;
        const assetPath = path.join(folderPaths[folderIndex]!, displayName);
        writeFileSync(assetPath, `Temporary text asset ${index}.`);
        const actual = statSync(assetPath);
        const modifiedAt = actual.mtime.toISOString();
        insertAsset.run(assetId, folders[folderIndex]!.folderId, relativePath, relativePath, modifiedAt, modifiedAt);
        insertRevision.run(revisionId, assetId, actual.size, modifiedAt, displayName, now);
        updateRevision.run(revisionId, modifiedAt, assetId);
        rows.push({ assetId, revisionId, displayName });
      }
    });
    transaction(Array.from({ length: 10_000 }, (_, index) => ({ index, folderIndex: index < 5_000 ? 0 : 1 })));
    connection.close();

    let sessionGeneration = randomUUID();
    let profileKey = 'semantic-perf-v1';
    const timingRows: Array<{ queryId: string; phase: string; durationMs: number }> = [];
    const request = async (command: WorkerCommand): Promise<WorkerResult> => {
      const workerRequest = { requestId: randomUUID(), command } as WorkerRequest;
      const result = await executeSemanticIndexWorkerCommand(service, workerRequest, {
        runWithoutAdmission: async (work) => work(),
        onTiming: (phase, durationMs) => {
          if (command.type === 'semantic.index.search') timingRows.push({ queryId: command.queryId, phase, durationMs });
        },
      });
      if (!result) throw new Error(`Semantic command was not handled: ${command.type}`);
      return result;
    };
    const seedVectors = (dimensions: number, key: string): void => {
      const store = new SemanticIndexStore({ libraryPath: library.libraryPath,
        libraryId: library.libraryId, storageKind: 'local' });
      const profileId = store.ensureProfile({ profileKey: key, dimensions,
        modelRevision: 'controlled-vector-v1', modality: 'text' });
      for (let offset = 0; offset < rows.length; offset += 128) {
        const vectors = rows.slice(offset, offset + 128).map((row, index) => {
          const vector = new Array<number>(dimensions).fill(0);
          const angle = ((offset + index) / rows.length) * (Math.PI / 3);
          vector[0] = Math.cos(angle);
          vector[1] = Math.sin(angle);
          return { assetId: row.assetId,
            sourceRevision: `${embeddingTextRevision(row.revisionId)}\ntitle:${row.displayName}`,
            vector };
        });
        store.upsertBatch(profileId, vectors);
      }
      store.close();
    };
    seedVectors(768, profileKey);
    const started = await request({ type: 'semantic.index.begin', libraryId: library.libraryId,
      sessionGeneration, profileKey, dimensions: 768, modelRevision: 'controlled-vector-v1',
      modality: 'text', maxInputBytes: 256 * 1024 });
    expect(started.ok && started.type).toBe('semantic.index.started');
    if (!started.ok || started.type !== 'semantic.index.started') throw new Error('Semantic store did not start.');

    const runQuery = async (queryId: string, scope: SearchScope | null, dimensions = 768) => {
      const before = performance.now();
      const result = await request({ type: 'semantic.index.search', libraryId: library.libraryId,
        sessionGeneration, profileKey, queryId, vector: [1, ...new Array(dimensions - 1).fill(0)],
        scope, showIgnored: false });
      return { elapsedMs: performance.now() - before, result };
    };

    const firstQueryId = randomUUID();
    const cold = await runQuery(firstQueryId, null);
    expect(cold.result.ok && cold.result.type).toBe('semantic.index.ranked');
    if (!cold.result.ok || cold.result.type !== 'semantic.index.ranked') throw new Error('Search did not rank.');
    expect(cold.result.candidateCount).toBe(10_000);
    const assertCorrectScores = (rankedIds: string[], scores: Array<{ assetId: string; score: number }>, subset: typeof rows) => {
      expect(rankedIds).toHaveLength(subset.length);
      expect(new Set(rankedIds).size).toBe(subset.length);
      expect(new Set(rankedIds)).toEqual(new Set(subset.map(({ assetId }) => assetId)));
      const indices = new Map(rows.map(({ assetId }, index) => [assetId, index]));
      const observed = new Map(scores.map(({ assetId, score }) => [assetId, score]));
      for (const assetId of rankedIds) {
        const index = indices.get(assetId);
        expect(index).toBeDefined();
        const angle = ((index ?? 0) / rows.length) * (Math.PI / 3);
        expect(observed.get(assetId)).toBeCloseTo(Math.cos(angle), 5);
      }
      for (let index = 1; index < rankedIds.length; index += 1) {
        const previous = observed.get(rankedIds[index - 1]!) ?? 0;
        const current = observed.get(rankedIds[index]!) ?? 0;
        expect(previous + 1e-6).toBeGreaterThanOrEqual(current);
      }
    };
    assertCorrectScores(cold.result.assetIds, cold.result.scores, rows);
    const warm: number[] = [];
    for (let sample = 0; sample < 8; sample += 1) {
      const measured = await runQuery(randomUUID(), null);
      expect(measured.result.ok && measured.result.type).toBe('semantic.index.ranked');
      warm.push(measured.elapsedMs);
    }
    const filtered = await runQuery(randomUUID(), { kind: 'folder', folderId: folders[0]!.folderId, recursive: true });
    expect(filtered.result.ok && filtered.result.type).toBe('semantic.index.ranked');
    if (!filtered.result.ok || filtered.result.type !== 'semantic.index.ranked') throw new Error('Filtered search did not rank.');
    expect(filtered.result.candidateCount).toBe(5_000);
    assertCorrectScores(filtered.result.assetIds, filtered.result.scores, rows.slice(0, 5_000));

    await request({ type: 'semantic.index.close', libraryId: library.libraryId, sessionGeneration });
    sessionGeneration = randomUUID();
    const reopened = await request({ type: 'semantic.index.begin', libraryId: library.libraryId,
      sessionGeneration, profileKey, dimensions: 768, modelRevision: 'controlled-vector-v1',
      modality: 'text', maxInputBytes: 256 * 1024 });
    expect(reopened.ok && reopened.type).toBe('semantic.index.started');
    const reopenedFirst = await runQuery(randomUUID(), null);
    expect(reopenedFirst.result.ok && reopenedFirst.result.type).toBe('semantic.index.ranked');

    await request({ type: 'semantic.index.close', libraryId: library.libraryId, sessionGeneration });
    sessionGeneration = randomUUID();
    profileKey = 'semantic-perf-4096-v1';
    seedVectors(4096, profileKey);
    const highDimensionStart = await request({ type: 'semantic.index.begin', libraryId: library.libraryId,
      sessionGeneration, profileKey, dimensions: 4096, modelRevision: 'controlled-vector-v1',
      modality: 'text', maxInputBytes: 256 * 1024 });
    expect(highDimensionStart.ok && highDimensionStart.type).toBe('semantic.index.started');
    const highDimension = await runQuery(randomUUID(), null, 4096);
    expect(highDimension.result.ok && highDimension.result.type).toBe('semantic.index.ranked');
    if (!highDimension.result.ok || highDimension.result.type !== 'semantic.index.ranked') {
      throw new Error('High-dimension search did not rank.');
    }
    expect(highDimension.result.candidateCount).toBe(10_000);
    assertCorrectScores(highDimension.result.assetIds, highDimension.result.scores, rows);
    const highDimensionWarm: number[] = [];
    for (let sample = 0; sample < 8; sample += 1) {
      const measured = await runQuery(randomUUID(), null, 4096);
      expect(measured.result.ok && measured.result.type).toBe('semantic.index.ranked');
      highDimensionWarm.push(measured.elapsedMs);
    }
    const highDimensionFiltered = await runQuery(randomUUID(), {
      kind: 'folder', folderId: folders[0]!.folderId, recursive: true,
    }, 4096);
    expect(highDimensionFiltered.result.ok && highDimensionFiltered.result.type).toBe('semantic.index.ranked');
    if (!highDimensionFiltered.result.ok || highDimensionFiltered.result.type !== 'semantic.index.ranked') {
      throw new Error('Filtered high-dimension search did not rank.');
    }
    expect(highDimensionFiltered.result.candidateCount).toBe(5_000);
    assertCorrectScores(highDimensionFiltered.result.assetIds, highDimensionFiltered.result.scores, rows.slice(0, 5_000));

    const sorted = [...warm].sort((left, right) => left - right);
    const highSorted = [...highDimensionWarm].sort((left, right) => left - right);
    const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
    const highPercentile = (fraction: number) => highSorted[Math.ceil(highSorted.length * fraction) - 1] ?? 0;
    console.info(JSON.stringify({
      benchmark: 'semantic-worker-retrieval-only',
      assets: 10_000,
      dimensions: 768,
      embedding: 'precomputed controlled vectors; provider latency excluded',
      uiAndIPC: 'excluded; direct Worker handler timing',
      firstQueryMs: Number(cold.elapsedMs.toFixed(2)),
      nativeCosineAvailable: started.nativeCosineAvailable,
      firstQueryPhasesMs: Object.fromEntries(timingRows.filter((entry) => entry.queryId === firstQueryId)
        .map(({ phase, durationMs }) => [phase, Number(durationMs.toFixed(2))])),
      sessionReopenedFirstQueryMs: Number(reopenedFirst.elapsedMs.toFixed(2)),
      warmMs: { samples: warm.length, p50: Number(percentile(0.5).toFixed(2)),
        p95: Number(percentile(0.95).toFixed(2)), max: Number(Math.max(...warm).toFixed(2)) },
      filtered5kMs: Number(filtered.elapsedMs.toFixed(2)),
      dimensions4096: { firstQueryMs: Number(highDimension.elapsedMs.toFixed(2)),
        warmMs: { samples: highDimensionWarm.length, p50: Number(highPercentile(0.5).toFixed(2)),
          p95: Number(highPercentile(0.95).toFixed(2)), max: Number(Math.max(...highDimensionWarm).toFixed(2)) },
        filtered5kMs: Number(highDimensionFiltered.elapsedMs.toFixed(2)),
        nativeCosineAvailable: highDimensionStart.ok && highDimensionStart.type === 'semantic.index.started'
          ? highDimensionStart.nativeCosineAvailable : false },
    }));
    await request({ type: 'semantic.index.close', libraryId: library.libraryId, sessionGeneration });
  }, 180_000);
});
