import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryService } from '../../src/worker/library-service';
import type { ImportProgressEvent } from '../../src/shared/protocol/responses';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed asset import progress', () => {
  it('emits counted copy progress that can be cancelled between files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-import-progress-'));
    roots.push(root);
    const sources = [0, 1, 2, 3, 4].map((index) => {
      const source = path.join(root, `file-${index}.txt`);
      writeFileSync(source, `payload-${index}`);
      return source;
    });
    const events: ImportProgressEvent[] = [];
    const service = new LibraryService({
      onProgress: (event) => {
        if (event.type === 'import.progress') events.push(event);
      },
    });
    const library = service.createLibrary({
      displayName: 'Import Progress',
      selectedParentPath: root,
    });

    await service.prepareOrExecuteImportCancellable({
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: sources,
    });

    const copyEvents = events.filter((event) => event.phase === 'copy' && event.totalFiles === 5);
    expect(copyEvents.length).toBeGreaterThan(0);
    expect(copyEvents.some((event) => event.filesProcessed > 0)).toBe(true);
    expect(copyEvents.every((event) => event.cancelable === true && event.importId.length > 0)).toBe(true);

    const cancelEvents: ImportProgressEvent[] = [];
    const cancelling = new LibraryService({
      onProgress: (event) => {
        if (event.type !== 'import.progress') return;
        cancelEvents.push(event);
        if (event.phase === 'copy' && event.importId) {
          setImmediate(() => cancelling.cancelImport(event.importId));
        }
      },
    });
    const cancelLibrary = cancelling.createLibrary({
      displayName: 'Import Cancel',
      selectedParentPath: root,
    });
    await expect(
      cancelling.prepareOrExecuteImportCancellable({
        libraryId: cancelLibrary.libraryId,
        sourceKind: 'files',
        sourcePaths: sources,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancelEvents.some((event) => event.phase === 'cancelled')).toBe(true);

    service.closeAll();
    cancelling.closeAll();
  });

  it('stop keeps already staged files and skips the rest', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-import-stop-'));
    roots.push(root);
    const sources = Array.from({ length: 40 }, (_, index) => {
      const source = path.join(root, `file-${index}.txt`);
      writeFileSync(source, `payload-${index}`);
      return source;
    });
    let stopArmed = false;
    const service = new LibraryService({
      onProgress: (event) => {
        if (event.type !== 'import.progress') return;
        if (event.phase !== 'copy' || !event.importId || stopArmed) return;
        stopArmed = true;
        const importId = event.importId;
        let remaining = 8;
        const waitThenStop = (): void => {
          remaining -= 1;
          if (remaining > 0) {
            setImmediate(waitThenStop);
            return;
          }
          service.cancelImport(importId, 'stop');
        };
        setImmediate(waitThenStop);
      },
    });
    const library = service.createLibrary({
      displayName: 'Import Stop',
      selectedParentPath: root,
    });

    const result = await service.prepareOrExecuteImportCancellable({
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: sources,
    });
    expect(result).toMatchObject({
      importedCount: expect.any(Number),
    });
    const imported = 'importedCount' in result ? result.importedCount : 0;
    expect(imported).toBeGreaterThan(0);
    expect(imported).toBeLessThan(40);
    expect(
      service.listAssets({ libraryId: library.libraryId, recursive: true }).length,
    ).toBe(imported);

    service.closeAll();
  });
});

describe('linked folder import progress', () => {
  it('emits non-cancelable validate and copy progress then complete', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linked-import-progress-'));
    roots.push(root);
    const sourceRoot = path.join(root, 'source');
    mkdirSync(sourceRoot);
    writeFileSync(path.join(sourceRoot, 'a.txt'), 'aaa');
    writeFileSync(path.join(sourceRoot, 'b.txt'), 'bbbb');
    mkdirSync(path.join(sourceRoot, 'sub'));
    writeFileSync(path.join(sourceRoot, 'sub', 'c.txt'), 'ccccc');

    const events: ImportProgressEvent[] = [];
    const service = new LibraryService({
      onProgress: (event) => {
        if (event.type === 'import.progress') events.push(event);
      },
    });
    const library = service.createLibrary({
      displayName: 'Linked Import Progress',
      selectedParentPath: root,
    });

    const linked = service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: sourceRoot,
    });

    expect(linked.assetCount).toBe(3);
    expect(events.some((event) => event.phase === 'validate')).toBe(true);
    expect(events.some((event) => event.phase === 'copy' && event.totalFiles === 3)).toBe(true);
    expect(events.at(-1)?.phase).toBe('complete');
    expect(events.at(-1)?.filesProcessed).toBe(3);
    expect(events.every((event) => event.cancelable === false && event.copiesFiles === false && event.importId.length > 0)).toBe(true);
    const sequences = events
      .map((event) => event.sequence)
      .filter((value): value is number => typeof value === 'number');
    expect(sequences).toHaveLength(events.length);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));

    service.closeAll();
  });
});
