import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../../src/worker/library-service';
import { importNoConflict as sharedImportNoConflict } from './import-no-conflict';

const temporaryRoots: string[] = [];
const require = createRequire(import.meta.url);
interface TestDatabaseConnection {
  close(): void;
  prepare(source: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
}
const TestDatabase = require('better-sqlite3') as new (filename: string) => TestDatabaseConnection;
const THUMBNAIL_REQUIRED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAACAEAAAABCAIAAAAqtLKbAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAOklEQVRYhe3YQQ0AAAgDMeRMImInBh+kySno8yZbESBAgAABAgQIECBAgAABAgQIECBAgAABAnk3zA9mXOIiDxU7WQAAAABJRU5ErkJggg==',
  'base64',
);
function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-thumbnail-'));
  temporaryRoots.push(root);
  return root;
}

function createTestImage(destPath: string): void {
  mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileSync(destPath, THUMBNAIL_REQUIRED_PNG);
}

async function createPngBytes(width: number, height: number): Promise<Buffer> {
  const sharp = require('sharp') as (input: unknown) => {
    png(): { toBuffer(): Promise<Buffer> };
  };
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 120, b: 220 },
    },
  }).png().toBuffer();
}

async function createJpegBytes(width: number, height: number): Promise<Buffer> {
  const sharp = require('sharp') as (input: unknown) => {
    jpeg(): { toBuffer(): Promise<Buffer> };
  };
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 220, g: 120, b: 40 },
    },
  }).jpeg().toBuffer();
}

function importNoConflict(service: LibraryService, libraryId: string, sourcePath: string): void {
  sharedImportNoConflict(service, libraryId, sourcePath);
}


afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('Scoped repair and source direct preview', () => {
  it('limits visible retryable artifact repair to the requested assets', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const created = service.createLibrary({ displayName: 'ScopedFailedRetry', selectedParentPath: root });
    for (const name of ['first.png', 'second.png']) {
      const source = path.join(root, name);
      createTestImage(source);
      importNoConflict(service, created.libraryId, source);
    }
    const assets = service.listAssets({ libraryId: created.libraryId, recursive: true });
    expect(assets).toHaveLength(2);
    const oldFailure = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const databasePath = path.join(created.libraryPath, '.worldlinebox', 'library.db');
    const db = new TestDatabase(databasePath);
    const insertFailed = db.prepare(
      `INSERT INTO revision_artifacts
         (artifact_id, revision_id, kind, mime_type, byte_size, file_path,
          generator_version, status, error_code, generated_at)
       VALUES (?, ?, 'thumbnail', 'image/jpeg', 0, ?, 'test', 'failed',
               'MEDIA_PROCESSING_FAILED', ?)`,
    );
    for (const [index, asset] of assets.entries()) {
      insertFailed.run(`scoped-failed-${index}`, asset.currentRevisionId, `scoped-failed-${index}.jpg`, oldFailure);
    }
    db.close();

    service.enqueueThumbnailJobs(created.libraryId, {
      assetIds: [assets[0]!.assetId],
      retryFailed: true,
      skipStaleRepair: true,
    });
    const afterVisible = new TestDatabase(databasePath);
    expect(afterVisible.prepare(
      'SELECT artifact_id, invalidated_at FROM revision_artifacts WHERE artifact_id LIKE ? ORDER BY artifact_id',
    ).all('scoped-failed-%')).toEqual([
      { artifact_id: 'scoped-failed-0', invalidated_at: expect.any(String) },
      { artifact_id: 'scoped-failed-1', invalidated_at: null },
    ]);
    afterVisible.close();

    service.enqueueThumbnailJobs(created.libraryId, { retryFailed: true, skipStaleRepair: true, limit: 2 });
    const afterBackground = new TestDatabase(databasePath);
    expect(afterBackground.prepare(
      "SELECT invalidated_at FROM revision_artifacts WHERE artifact_id = 'scoped-failed-1'",
    ).get()).toEqual({ invalidated_at: expect.any(String) });
    afterBackground.close();
    service.closeAll();
  });  it.each(['png', 'jpg'])(
    'probes a queued %s with unknown dimensions and serves the source without encoding',
    async (extension) => {
      const root = temporaryRoot();
      const service = new LibraryService();
      let db: TestDatabaseConnection | undefined;
      let verify: TestDatabaseConnection | undefined;
      try {
        const created = service.createLibrary({ displayName: 'QueuedSourceDirectProbe', selectedParentPath: root });
        const sourcePath = path.join(root, `small.${extension}`);
        writeFileSync(sourcePath, extension === 'png'
          ? await createPngBytes(480, 480)
          : await createJpegBytes(480, 480));
        importNoConflict(service, created.libraryId, sourcePath);
        const asset = service.listAssets({ libraryId: created.libraryId, recursive: true })[0]!;
        const dbPath = path.join(created.libraryPath, '.worldlinebox', 'library.db');
        db = new TestDatabase(dbPath);
        db.prepare('DELETE FROM jobs').run();
        db.prepare(
          "DELETE FROM revision_artifacts WHERE revision_id = ? AND kind = 'extracted_metadata'",
        ).run(asset.currentRevisionId);
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO jobs
             (job_id, library_id, asset_id, revision_id, kind, status, priority, progress,
              attempt_count, created_at, updated_at)
           VALUES ('unknown-dimensions', ?, ?, ?, 'generate_thumbnail', 'queued', 100, 0.0, 0, ?, ?)`,
        ).run(created.libraryId, asset.assetId, asset.currentRevisionId, now, now);
        db.close();
        db = undefined;

        const results: Array<{ errorCode?: string; width?: number; height?: number; previewKind?: 'source' | null }> = [];
        expect(await service.processThumbnailQueue(created.libraryId, {
          maxJobs: 1,
          jobKinds: ['generate_thumbnail'],
          assetIds: [asset.assetId],
          onResult: (result) => results.push(result),
        })).toBe(1);
        expect(results).toContainEqual(expect.objectContaining({
          errorCode: 'SOURCE_DIRECT', width: 480, height: 480, previewKind: 'source',
        }));

        verify = new TestDatabase(dbPath);
        expect(verify.prepare(
          "SELECT status, error_code FROM jobs WHERE job_id = 'unknown-dimensions'",
        ).get()).toEqual({ status: 'cancelled', error_code: 'SOURCE_DIRECT' });
        expect(verify.prepare(
          "SELECT width, height FROM revision_artifacts WHERE revision_id = ? AND kind = 'extracted_metadata' AND status = 'ready' AND invalidated_at IS NULL",
        ).get(asset.currentRevisionId)).toEqual({ width: 480, height: 480 });
        expect(verify.prepare(
          "SELECT COUNT(*) AS count FROM revision_artifacts WHERE revision_id = ? AND kind = 'thumbnail'",
        ).get(asset.currentRevisionId)).toEqual({ count: 0 });
      } finally {
        verify?.close();
        db?.close();
        service.closeAll();
      }
    },
  );


});
