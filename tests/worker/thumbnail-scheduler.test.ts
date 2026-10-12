import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LibraryService } from '../../src/worker/library-service';
import { importNoConflict } from './import-no-conflict';

type FakeParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    try {
      rmSync(root, { force: true, recursive: true });
    } catch {
      // Windows can retain a fixture handle briefly after worker shutdown.
    }
  }
});

describe('thumbnail Worker scheduler reconciliation handoff', () => {
  it('inserts an exact reconciliation wave into a long ordinary queue and resumes it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-thumbnail-scheduler-'));
    temporaryRoots.push(root);
    const fixtureService = new LibraryService();
    const created = fixtureService.createLibrary({
      displayName: 'SchedulerHandoff',
      selectedParentPath: root,
    });
    const ordinaryPath = path.join(root, 'ordinary.png');
    const missingPath = path.join(root, 'missing.png');
    const nextVisiblePath = path.join(root, 'next-visible.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwnwEIAgEBAQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(ordinaryPath, png);
    writeFileSync(missingPath, png);
    writeFileSync(nextVisiblePath, png);
    importNoConflict(fixtureService, created.libraryId, ordinaryPath);
    importNoConflict(fixtureService, created.libraryId, missingPath);
    importNoConflict(fixtureService, created.libraryId, nextVisiblePath);
    const assets = fixtureService.listAssets({ libraryId: created.libraryId, recursive: true });
    const ordinaryAsset = assets.find((asset) => asset.displayName === 'ordinary.png')!;
    const missingAsset = assets.find((asset) => asset.displayName === 'missing.png')!;
    const nextVisibleAsset = assets.find((asset) => asset.displayName === 'next-visible.png')!;
    fixtureService.closeAll();

    const processCalls: Array<{ assetIds: string[] }> = [];
    let ordinaryWaveStarted!: () => void;
    const ordinaryWaveStartedPromise = new Promise<void>((resolve) => {
      ordinaryWaveStarted = resolve;
    });
    let releaseOrdinaryWave!: () => void;
    const ordinaryWaveRelease = new Promise<void>((resolve) => {
      releaseOrdinaryWave = resolve;
    });
    let releaseExactWave!: () => void;
    const exactWaveRelease = new Promise<void>((resolve) => {
      releaseExactWave = resolve;
    });
    let exactWaveStarted!: () => void;
    const exactWaveStartedPromise = new Promise<void>((resolve) => {
      exactWaveStarted = resolve;
    });
    let reconciliationCallback!: (assetIds: string[]) => void;
    let exactWaveCalls = 0;

    const processSpy = vi.spyOn(LibraryService.prototype, 'processThumbnailQueue')
      .mockImplementation(async (_libraryId, options) => {
        const queueOptions = options ?? {};
        const assetIds = [...(queueOptions.assetIds ?? [])];
        processCalls.push({ assetIds });
        if (processCalls.length === 1) {
          ordinaryWaveStarted();
          await ordinaryWaveRelease;
          return queueOptions.maxJobs ?? 1;
        }
        if (assetIds.includes(missingAsset.assetId)) {
          exactWaveCalls += 1;
          if (exactWaveCalls === 1) {
            exactWaveStarted();
            await exactWaveRelease;
          }
          return 1;
        }
        return assetIds.length === 0 ? 0 : 1;
      });
    const reconciliationSpy = vi.spyOn(LibraryService.prototype, 'runOpenBackgroundReconciliation')
      .mockImplementation(async (_libraryId, options) => {
        const onMissingPrimaryArtifacts = options?.onMissingPrimaryArtifacts;
        if (!onMissingPrimaryArtifacts) throw new Error('Missing reconciliation callback in test harness.');
        reconciliationCallback = onMissingPrimaryArtifacts;
        reconciliationCallback([missingAsset.assetId]);
      });

    const posted: unknown[] = [];
    let receive!: (event: { data: unknown }) => void;
    const parentPort: FakeParentPort = {
      on: (_event, listener) => {
        receive = listener;
      },
      postMessage: (message) => {
        posted.push(message);
        if (
          typeof message === 'object'
          && message !== null
          && 'type' in message
          && message.type === 'plugin-media-provider.request'
          && 'requestId' in message
          && 'assetId' in message
          && 'kind' in message
        ) {
          queueMicrotask(() => receive({
            data: {
              type: 'plugin-media-provider.response',
              requestId: message.requestId,
              result: {
                status: 'native-fallback',
                assetId: message.assetId,
                kind: message.kind,
                errorCode: 'PLUGIN_PROVIDER_UNAVAILABLE',
              },
            },
          }));
        }
      },
    };
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: parentPort,
    });

    try {
      await import('../../src/worker/index');
      expect(receive).toBeTypeOf('function');
      const send = async (requestId: string, command: unknown): Promise<unknown> => {
        const before = posted.length;
        receive({ data: { requestId, command } });
        try {
          await vi.waitFor(() => {
            expect(posted.slice(before).some((message) => (
              typeof message === 'object'
              && message !== null
              && 'requestId' in message
              && message.requestId === requestId
            ))).toBe(true);
          }, { timeout: 10_000 });
        } catch (error) {
          throw new Error(
            `Worker command ${requestId} did not reply: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        return posted.slice(before).find((message) => (
          typeof message === 'object'
          && message !== null
          && 'requestId' in message
          && message.requestId === requestId
        ));
      };

      const opened = await send('scheduler-open', {
        type: 'library.open',
        selectedLibraryPath: created.libraryPath,
      }) as { result?: { ok?: boolean } };
      expect(opened.result?.ok).toBe(true);
      await send('scheduler-browse', {
        type: 'browse.session.open',
        libraryId: created.libraryId,
        query: null,
        limit: 1,
      });
      // The deferred startup gate keeps this exact ID pending until a visible
      // wave arrives, exercising the ownership check before the first claim.
      await vi.waitFor(() => {
        expect(reconciliationCallback).toBeTypeOf('function');
      }, { timeout: 10_000 });
      await send('scheduler-visible', {
        type: 'asset.thumbnail.visible-window',
        libraryId: created.libraryId,
        assetIds: [ordinaryAsset.assetId],
      });
      await ordinaryWaveStartedPromise;
      releaseOrdinaryWave();
      await vi.waitFor(() => {
        expect(processCalls.some((call) => call.assetIds.includes(missingAsset.assetId))).toBe(true);
      }, { timeout: 10_000 });

      const exactIndex = processCalls.findIndex((call) => call.assetIds.includes(missingAsset.assetId));
      expect(exactIndex).toBeGreaterThan(0);
      expect(processCalls[0]?.assetIds).toEqual([ordinaryAsset.assetId]);
      expect(reconciliationCallback).toBeTypeOf('function');

      // A visible wave arriving while exact reconciliation is active owns the
      // next boundary; a normal enqueue arriving alongside it is retained for
      // post-exact resumption instead of being dropped with the reschedule flag.
      await exactWaveStartedPromise;
      await send('scheduler-viewer-upgrade', {
        type: 'media.get-preview-artifact',
        libraryId: created.libraryId,
        assetId: ordinaryAsset.assetId,
        intent: 'viewer',
      });
      const exactCallsBeforeViewerWindow = exactWaveCalls;
      await send('scheduler-visible-next', {
        type: 'asset.thumbnail.visible-window',
        libraryId: created.libraryId,
        assetIds: [nextVisibleAsset.assetId],
      });
      await send('scheduler-enqueue-next', {
        type: 'media.enqueue-thumbnail-jobs',
        libraryId: created.libraryId,
      });
      releaseExactWave();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(exactWaveCalls).toBe(exactCallsBeforeViewerWindow);
      await vi.waitFor(() => {
        expect(exactWaveCalls).toBe(2);
        expect(processCalls.some((call, index) => (
          index > exactIndex && call.assetIds.includes(nextVisibleAsset.assetId)
        ))).toBe(true);
        expect(processCalls[processCalls.length - 1]?.assetIds).toEqual([]);
      }, { timeout: 10_000 });
      const visibleIndex = processCalls.findIndex((call, index) => (
        index > exactIndex && call.assetIds.includes(nextVisibleAsset.assetId)
      ));
      const replayExactIndex = processCalls.findIndex((call, index) => (
        index > visibleIndex && call.assetIds.includes(missingAsset.assetId)
      ));
      expect(visibleIndex).toBeGreaterThan(exactIndex);
      expect(replayExactIndex).toBeGreaterThan(visibleIndex);
      expect(processCalls[replayExactIndex + 1]?.assetIds).toEqual([ordinaryAsset.assetId]);
      expect(processCalls[processCalls.length - 1]?.assetIds).toEqual([]);

      await receive({ data: { type: 'worker.shutdown' } });
      await vi.waitFor(() => {
        expect(posted.some((message) => (
          typeof message === 'object'
          && message !== null
          && 'type' in message
          && message.type === 'worker.shutdown.ack'
        ))).toBe(true);
      });
    } finally {
      processSpy.mockRestore();
      reconciliationSpy.mockRestore();
      delete (process as unknown as { parentPort?: unknown }).parentPort;
    }
  }, 30_000);
});
