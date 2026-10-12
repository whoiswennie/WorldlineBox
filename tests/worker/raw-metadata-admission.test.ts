// WorldlineBox-288cd9: the secondary pump decides "the RAW catalogue is drained" from
// the admission outcome, so that signal has to be exact. A drained probe must
// report `budgetCapped: false`; a probe that was stopped by the global admission
// cap must NOT, otherwise the gate would stop rescanning while RAW assets still
// need metadata.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryService } from '../../src/worker/library-service';
import { importNoConflict } from './import-no-conflict';

interface TestDatabase {
  prepare(source: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (filename: string) => TestDatabase;

const temporaryRoots: string[] = [];
const services: LibraryService[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-raw-admission-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('RAW metadata backfill admission (WorldlineBox-288cd9)', () => {
  it('reports a drained catalogue instead of a capped probe', () => {
    const service = new LibraryService();
    services.push(service);
    const created = service.createLibrary({
      displayName: 'RAW admission',
      selectedParentPath: temporaryRoot(),
    });

    const first = service.enqueueRawImageMetadataBackfill(created.libraryId, 64);
    expect(first).toEqual({ admitted: 0, probed: 0, budgetCapped: false });

    // A drained catalogue stays drained: repeated probes admit nothing and keep
    // reporting the drained signal the gate relies on.
    const second = service.enqueueRawImageMetadataBackfill(created.libraryId, 64);
    expect(second).toEqual({ admitted: 0, probed: 0, budgetCapped: false });
    expect(service.listMediaJobs(created.libraryId, { summaryOnly: true }).queued).toBe(0);
  });

  it('persists exhaustion across reopen and re-arms when the catalog token changes', () => {
    const service = new LibraryService();
    services.push(service);
    const created = service.createLibrary({
      displayName: 'RAW admission persistence',
      selectedParentPath: temporaryRoot(),
    });

    const first = service.enqueueRawImageMetadataBackfill(created.libraryId, 64);
    expect(first).toEqual({ admitted: 0, probed: 0, budgetCapped: false });
    expect(service.getRawMetadataBackfillAdmissionState(created.libraryId)).toMatchObject({
      exhausted: true,
    });

    service.closeLibrary(created.libraryId);
    const reopened = new LibraryService();
    services.push(reopened);
    reopened.openLibrary(created.libraryPath);
    const persisted = reopened.getRawMetadataBackfillAdmissionState(created.libraryId);
    expect(persisted).toMatchObject({ exhausted: true });
    const persistedBeforeRepeatedCalls = persisted?.updatedAt;
    for (let turn = 0; turn < 100; turn += 1) {
      expect(reopened.enqueueRawImageMetadataBackfill(created.libraryId, 64)).toEqual({
        admitted: 0,
        probed: 0,
        budgetCapped: false,
      });
    }
    expect(reopened.getRawMetadataBackfillAdmissionState(created.libraryId)?.updatedAt)
      .toBe(persistedBeforeRepeatedCalls);

    const database = new Database(path.join(created.libraryPath, '.worldlinebox', 'library.db'));
    try {
      const now = new Date().toISOString();
      const volatileJobId = randomUUID();
      database.prepare(
        `INSERT INTO jobs
           (job_id, library_id, asset_id, revision_id, kind, status, priority,
            progress, attempt_count, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'extract_palette', 'queued', 0, 0.0, 0, ?, ?)`,
      ).run(volatileJobId, created.libraryId, now, now);
      database.prepare(
        "UPDATE jobs SET status = 'running', updated_at = ? WHERE job_id = ?",
      ).run(now, volatileJobId);
      expect(reopened.enqueueRawImageMetadataBackfill(created.libraryId, 64)).toEqual({
        admitted: 0,
        probed: 0,
        budgetCapped: false,
      });
      database.prepare(
        'UPDATE browse_change_sequence SET sequence = sequence + 1 WHERE library_id = ?',
      ).run(created.libraryId);
      const rearmed = reopened.enqueueRawImageMetadataBackfill(created.libraryId, 64);
      expect(rearmed).toEqual({ admitted: 0, probed: 0, budgetCapped: false });
      const rearmedState = reopened.getRawMetadataBackfillAdmissionState(created.libraryId);
      expect(rearmedState?.token).not.toBe(persisted?.token);
      expect(rearmedState?.exhausted).toBe(true);
      expect(reopened.enqueueRawImageMetadataBackfill(created.libraryId, 64)).toEqual({
        admitted: 0,
        probed: 0,
        budgetCapped: false,
      });
      expect(reopened.getRawMetadataBackfillAdmissionState(created.libraryId)?.exhausted).toBe(true);

      const plan = database.prepare(
        `EXPLAIN QUERY PLAN
           SELECT a.asset_id, a.current_revision_id
             FROM assets a
            WHERE a.deleted_at IS NULL
              AND a.current_revision_id IS NOT NULL
              AND a.availability = 'available'
              AND a.asset_id > ?
              AND a.normalized_extension IN (?)
              AND NOT EXISTS (
                SELECT 1 FROM jobs active
                 WHERE active.library_id = ?
                   AND active.asset_id = a.asset_id
                   AND active.revision_id = a.current_revision_id
                   AND active.kind = 'extract_metadata'
                   AND active.status IN ('queued', 'running', 'paused')
              )
            ORDER BY a.asset_id
            LIMIT ?`,
      ).all('cursor', '.arw', created.libraryId, 64) as Array<{ detail?: string }>;
      const planText = plan.map((row) => row.detail ?? '').join(' ');
      expect(planText.toLowerCase()).toContain('assets_normalized_extension_asset');
    } finally {
      database.close();
    }
  });

  it('keeps the cursor when its own retry requeue leaves the catalog token unchanged', () => {
    const service = new LibraryService();
    services.push(service);
    const root = temporaryRoot();
    const created = service.createLibrary({
      displayName: 'RAW admission retry cursor',
      selectedParentPath: root,
    });
    const firstSource = path.join(root, 'first.ARW');
    const secondSource = path.join(root, 'second.ARW');
    writeFileSync(firstSource, Buffer.from('first-raw-fixture'));
    writeFileSync(secondSource, Buffer.from('second-raw-fixture'));
    importNoConflict(service, created.libraryId, firstSource);
    importNoConflict(service, created.libraryId, secondSource);
    const assets = service.listAssets({ libraryId: created.libraryId, recursive: true })
      .sort((left, right) => left.assetId.localeCompare(right.assetId));
    expect(assets).toHaveLength(2);

    const firstAdmission = service.enqueueRawImageMetadataBackfill(created.libraryId, 1);
    expect(firstAdmission.admitted).toBe(1);
    const firstJob = service.listMediaJobs(created.libraryId).jobs.find(
      (job) => job.kind === 'extract_metadata' && job.assetId === assets[0]!.assetId,
    )!;
    const cursorBeforeRetry = service.getRawMetadataBackfillAdmissionState(created.libraryId);
    expect(cursorBeforeRetry).toMatchObject({
      exhausted: false,
      cursorAssetId: assets[0]!.assetId,
    });

    const database = new Database(path.join(created.libraryPath, '.worldlinebox', 'library.db'));
    try {
      const now = new Date().toISOString();
      database.prepare(
        "UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE job_id = ?",
      ).run(now, firstJob.jobId);
      database.prepare(
        `INSERT INTO jobs
           (job_id, library_id, asset_id, revision_id, kind, status, priority,
            progress, attempt_count, error_code, error_detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'extract_metadata', 'failed', -25, 0.0, 1,
                 'RAW_METADATA_EXTRACTION_FAILED', 'retryable fixture failure', ?, ?)`,
      ).run(
        randomUUID(),
        created.libraryId,
        assets[1]!.assetId,
        assets[1]!.currentRevisionId,
        new Date(Date.now() - 31_000).toISOString(),
        new Date(Date.now() - 31_000).toISOString(),
      );
      const currentToken = String(service.getBrowseChangeSequence(created.libraryId));
      database.prepare(
        `UPDATE raw_metadata_backfill_state
            SET token = ?, cursor_asset_id = ?, exhausted = 0, updated_at = ?
          WHERE library_id = ?`,
      ).run(currentToken, assets[0]!.assetId, now, created.libraryId);
    } finally {
      database.close();
    }

    service.closeLibrary(created.libraryId);
    const reopened = new LibraryService();
    services.push(reopened);
    reopened.openLibrary(created.libraryPath);
    expect(reopened.getRawMetadataBackfillAdmissionState(created.libraryId)).toMatchObject({
      cursorAssetId: assets[0]!.assetId,
      exhausted: false,
    });
    const retryOnlyAdmitted = reopened.requeueRawImageMetadataBackfillRetries(
      created.libraryId,
      2,
    );
    expect(retryOnlyAdmitted).toBe(1);
    const retryAdmission = reopened.enqueueRawImageMetadataBackfill(created.libraryId, 2);
    expect(retryAdmission).toEqual({ admitted: 0, probed: 0, budgetCapped: false });
    // Job status/retry writes are intentionally outside the browse token. They
    // must not force a persisted non-empty cursor back to the first asset; the
    // normal candidate probe sees the requeued job as active and stays bounded.
    expect(String(reopened.getBrowseChangeSequence(created.libraryId))).toBe(
      String(cursorBeforeRetry?.token),
    );
    expect(reopened.getRawMetadataBackfillAdmissionState(created.libraryId)).toMatchObject({
      cursorAssetId: assets[0]!.assetId,
      exhausted: true,
    });
  });

  it('does not report drained while the global admission budget is full', () => {
    const service = new LibraryService();
    services.push(service);
    const created = service.createLibrary({
      displayName: 'RAW admission cap',
      selectedParentPath: temporaryRoot(),
    });
    const database = new Database(path.join(created.libraryPath, '.worldlinebox', 'library.db'));
    try {
      const now = new Date().toISOString();
      const insert = database.prepare(
        `INSERT INTO jobs (job_id, library_id, asset_id, revision_id, kind, status, priority,
                           progress, attempt_count, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'extract_metadata', 'queued', -25, 0.0, 0, ?, ?)`,
      );
      // Fill the whole batch budget with pending metadata work.
      for (let index = 0; index < 64; index += 1) {
        insert.run(crypto.randomUUID(), created.libraryId, now, now);
      }
    } finally {
      database.close();
    }

    const outcome = service.enqueueRawImageMetadataBackfill(created.libraryId, 64);
    expect(outcome.admitted).toBe(0);
    expect(outcome.budgetCapped).toBe(true);
  });

  it('persists a normalized extension that RAW admission can index', () => {
    const service = new LibraryService();
    services.push(service);
    const created = service.createLibrary({
      displayName: 'RAW normalized extension',
      selectedParentPath: temporaryRoot(),
    });
    const database = new Database(path.join(created.libraryPath, '.worldlinebox', 'library.db'));
    try {
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO assets (
           asset_id, location_kind, managed_folder_id, linked_folder_id,
           relative_file_path, current_revision_id, availability, path_identity,
           created_at, updated_at
         ) VALUES (?, 'managed', NULL, NULL, ?, NULL, 'available', ?, ?, ?)`,
      ).run(
        'asset-raw-ext-1',
        'folder.with.dot/shot.CR2',
        'folder.with.dot/shot.CR2',
        now,
        now,
      );
      const row = database.prepare(
        'SELECT normalized_extension FROM assets WHERE asset_id = ?',
      ).get('asset-raw-ext-1') as { normalized_extension: string | null };
      expect(row.normalized_extension).toBe('.cr2');
    } finally {
      database.close();
    }
  });
});
