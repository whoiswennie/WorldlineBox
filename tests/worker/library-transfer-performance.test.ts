import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { expect, it, vi } from 'vitest';

import { LibraryService } from '../../src/worker/library-service';

it('copies a many-file library without imposing one Windows timer floor per entry', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-transfer-slices-'));
  const service = new LibraryService();
  const requestedCount = Number(process.env.WORLDLINEBOX_TRANSFER_BENCH_FILES);
  const fileCount = Number.isSafeInteger(requestedCount) && requestedCount >= 512 && requestedCount <= 20_000
    ? requestedCount : 512;
  const nativeTimeout = globalThis.setTimeout;
  let timerYields = 0;
  const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
    if (timeout === 0) timerYields += 1;
    return nativeTimeout(handler, timeout, ...args);
  });
  try {
    const created = service.createLibrary({ displayName: 'Transfer slices', selectedParentPath: root });
    for (let index = 0; index < fileCount; index += 1) {
      writeFileSync(path.join(created.libraryPath, 'Assets', `file-${index}.txt`), `asset ${index}`);
    }

    const observations: Array<{ operation: string; files: number; timerYields: number; durationMs: number }> = [];
    const measure = async (operation: string, work: () => Promise<unknown>): Promise<void> => {
      timerYields = 0;
      const startedAt = performance.now();
      await work();
      observations.push({ operation, files: fileCount, timerYields, durationMs: performance.now() - startedAt });
      // Windows may wait ~15ms per timer. This bound catches the old linear
      // wait cost without relying on disk speed or a fragile elapsed-time gate.
      expect(timerYields, `${operation} timer waits`).toBeLessThan(fileCount / 4);
    };
    const folder = path.join(root, 'folder-export');
    await measure('folder export', () => service.exportLibraryToFolder({
      libraryId: created.libraryId, destinationPath: folder, includeLinkedContent: false,
    }));
    expect(readdirSync(path.join(folder, 'Assets'))).toHaveLength(fileCount);
    const zip = path.join(root, 'zip-export.zip');
    await measure('ZIP export', () => service.exportLibraryToZip({
      libraryId: created.libraryId, destinationPath: zip, includeLinkedContent: false,
    }));
    await service.closeAllAsync();
    const destination = path.join(root, 'imports');
    mkdirSync(destination);
    await measure('folder import', async () => {
      const imported = await service.importLibraryFromFolder({
        sourceFolderPath: folder, copyToParentPath: destination,
      });
      expect(readdirSync(path.join(imported.libraryPath, 'Assets'))).toHaveLength(fileCount);
    });
    console.info('many-file transfer observations', JSON.stringify(observations));
    const metricsPath = process.env.WORLDLINEBOX_TRANSFER_METRICS_PATH;
    if (metricsPath) writeFileSync(metricsPath, `${JSON.stringify({
      platform: process.platform, runtime: process.versions, observations,
    }, null, 2)}\n`);
  } finally {
    timerSpy.mockRestore();
    await service.closeAllAsync();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
