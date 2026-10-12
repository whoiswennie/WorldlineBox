// WorldlineBox-e97c00: the task panel reads media job counts on every tick and on
// every completion event. That count query walks the whole media job history
// (about 110 ms on a 43k-asset library), so the service serves it from a summary
// cache validated by the durable change sequences. These tests pin the wiring:
// repeated reads agree with the SQL path, and a write converges within the
// documented stale window instead of serving a stale counter forever.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryService } from '../../src/worker/library-service';

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

function newService(): LibraryService {
  const service = new LibraryService();
  services.push(service);
  return service;
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-media-summary-'));
  temporaryRoots.push(root);
  return root;
}

function counts(service: LibraryService, libraryId: string, summaryOnly: boolean) {
  const result = service.listMediaJobs(libraryId, summaryOnly ? { summaryOnly: true } : {});
  return {
    queued: result.queued,
    running: result.running,
    succeeded: result.succeeded,
    failed: result.failed,
    paused: result.paused,
    cancelled: result.cancelled,
  };
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('media job status summary cache (WorldlineBox-e97c00)', () => {
  it('serves repeated reads from the summary and agrees with the SQL path', () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({
      displayName: 'Media summary cache',
      selectedParentPath: root,
    });

    const first = counts(service, created.libraryId, true);
    const second = counts(service, created.libraryId, true);
    const fromSql = counts(service, created.libraryId, false);

    expect(first).toEqual(second);
    expect(second).toEqual(fromSql);
  });

  it('converges to new counts after a job write instead of serving the stale summary', async () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({
      displayName: 'Media summary convergence',
      selectedParentPath: root,
    });
    // Read once so a summary entry exists and the stale window is armed.
    expect(counts(service, created.libraryId, true).queued).toBe(0);

    const database = new Database(path.join(created.libraryPath, '.worldlinebox', 'library.db'));
    try {
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO jobs (job_id, library_id, asset_id, revision_id, kind, status, priority,
                           progress, attempt_count, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'generate_thumbnail', 'queued', 0, 0.0, 0, ?, ?)`,
      ).run(crypto.randomUUID(), created.libraryId, now, now);
    } finally {
      database.close();
    }

    // The write bumped the durable sequences, so the summary must catch up
    // without any hook being called by the writer.
    const deadline = Date.now() + 8_000;
    let observed = counts(service, created.libraryId, true).queued;
    while (observed === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      observed = counts(service, created.libraryId, true).queued;
    }

    expect(observed).toBe(1);
    // And the cached value must still match what SQL reports.
    expect(counts(service, created.libraryId, true)).toEqual(counts(service, created.libraryId, false));
  }, 20_000);

  it('reads status counts from the maintained table instead of grouping job history', () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({
      displayName: 'Media summary table lookup',
      selectedParentPath: root,
    });
    const database = new Database(path.join(created.libraryPath, '.worldlinebox', 'library.db'));
    try {
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO jobs (job_id, library_id, asset_id, revision_id, kind, status, priority,
                           progress, attempt_count, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'generate_thumbnail', 'queued', 0, 0.0, 0, ?, ?)`,
      ).run('job-table-1', created.libraryId, now, now);
      const plan = database.prepare(
        `EXPLAIN QUERY PLAN
         SELECT status, count FROM media_job_status_counts WHERE library_id = ?`,
      ).all(created.libraryId) as Array<{ detail: string }>;
      const details = plan.map((step) => step.detail).join('\n');
      expect(details.toLowerCase()).toContain('media_job_status_counts');
      expect(details).not.toContain('SCAN jobs');
    } finally {
      database.close();
    }

    expect(counts(service, created.libraryId, true).queued).toBe(1);
  });

  it('pages the recent media job list with a created_at/job_id cursor', () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({
      displayName: 'Media job cursor pages',
      selectedParentPath: root,
    });
    const database = new Database(path.join(created.libraryPath, '.worldlinebox', 'library.db'));
    try {
      for (const [index, stamp] of [
        ['job-c', '2026-09-16T12:00:03.000Z'],
        ['job-b', '2026-09-16T12:00:02.000Z'],
        ['job-a', '2026-09-16T12:00:01.000Z'],
      ] as const) {
        database.prepare(
          `INSERT INTO jobs (job_id, library_id, asset_id, revision_id, kind, status, priority,
                             progress, attempt_count, created_at, updated_at)
           VALUES (?, ?, NULL, NULL, 'generate_thumbnail', 'queued', 0, 0.0, 0, ?, ?)`,
        ).run(index, created.libraryId, stamp, stamp);
      }
      const plan = database.prepare(
        `EXPLAIN QUERY PLAN
         SELECT j.job_id
           FROM jobs j
          WHERE j.library_id = ?
          ORDER BY j.created_at DESC, j.job_id DESC
          LIMIT 3`,
      ).all(created.libraryId) as Array<{ detail: string }>;
      const details = plan.map((step) => step.detail).join('\n');
      expect(details.toLowerCase()).toContain('jobs_library_created_desc');
    } finally {
      database.close();
    }

    const first = service.listMediaJobs(created.libraryId, { limit: 2 });
    expect(first.jobs.map((job) => job.jobId)).toEqual(['job-c', 'job-b']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({
      createdAt: '2026-09-16T12:00:02.000Z',
      jobId: 'job-b',
    });

    const second = service.listMediaJobs(created.libraryId, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.jobs.map((job) => job.jobId)).toEqual(['job-a']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(first.queued).toBe(3);
    expect(second.queued).toBe(3);
  });
});
