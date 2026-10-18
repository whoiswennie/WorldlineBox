import { describe, expect, it, vi } from 'vitest';

import { EmbeddingHttpIndex, type EmbeddingHttpServiceView } from '../../src/main/embedding-http-index';
import type { WorkerCommand } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';

const service: EmbeddingHttpServiceView = {
  id: 'svc_abcdefgh',
  adapter: 'openai-embeddings-v1',
  destination: 'internet',
  baseUrl: 'https://embedding.invalid',
  modelName: 'test-model',
  textStatus: 'verified',
  dimensions: 3,
  grantedLibraryIds: ['library-one'],
  modalities: ['text'],
};

function createIndex(requestWorker: (command: WorkerCommand) => Promise<WorkerResult>, overrides: {
  currentService?: () => EmbeddingHttpServiceView | null;
  enabled?: boolean;
} = {}): EmbeddingHttpIndex {
  return new EmbeddingHttpIndex({
    requestWorker,
    loadService: () => overrides.currentService?.() ?? service,
    readKey: () => 'test-key',
    isLibraryEnabled: () => overrides.enabled ?? true,
  });
}

describe('EmbeddingHttpIndex', () => {
  it('does not send prepared content after the library was stopped during preparation', async () => {
    let finishPreparation: ((result: WorkerResult) => void) | undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'semantic.index.begin') return {
        ok: true, type: 'semantic.index.started', profileId: 'a'.repeat(64), nativeCosineAvailable: false,
      };
      if (command.type === 'semantic.index.import-legacy') return {
        ok: true, type: 'semantic.index.legacy-imported', attempted: false, acceptedRows: 0, rejectedRows: 0,
      };
      if (command.type === 'semantic.index.targets') return {
        ok: true, type: 'semantic.index.targets', revisionSnapshot: 1, total: 1, nextOffset: null,
        targets: [{ assetId: 'asset-one', sourceRevision: 'rev-one', kind: 'text', modality: 'text', alreadyIndexed: false }],
      };
      if (command.type === 'semantic.index.job') return { ok: true, type: 'semantic.index.job-updated', updated: true };
      if (command.type === 'semantic.index.prepare') return await new Promise((resolve) => { finishPreparation = resolve; });
      return { ok: true, type: 'semantic.index.closed' };
    });
    const index = createIndex(requestWorker);
    try {
      index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: true });
      await vi.waitFor(() => expect(finishPreparation).toBeTypeOf('function'));
      await index.close('library-one');
      finishPreparation?.({ ok: true, type: 'semantic.index.prepared', assetId: 'asset-one',
        sourceRevision: 'rev-one', kind: 'text', text: 'Content prepared after stop' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(requestWorker.mock.calls.some(([command]) => command.type === 'semantic.index.write')).toBe(false);
    } finally {
      await index.close();
      vi.unstubAllGlobals();
    }
  });

  it('aborts active remote encoding only when its library is stopped', async () => {
    let providerSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, input?: RequestInit) => {
      const signal = input?.signal ?? null;
      providerSignal = signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'semantic.index.begin') return {
        ok: true, type: 'semantic.index.started', profileId: 'a'.repeat(64), nativeCosineAvailable: false,
      };
      if (command.type === 'semantic.index.import-legacy') return {
        ok: true, type: 'semantic.index.legacy-imported', attempted: false, acceptedRows: 0, rejectedRows: 0,
      };
      if (command.type === 'semantic.index.targets') return {
        ok: true, type: 'semantic.index.targets', revisionSnapshot: 1, total: 1, nextOffset: null,
        targets: [{ assetId: 'asset-one', sourceRevision: 'rev-one', kind: 'text', modality: 'text', alreadyIndexed: false }],
      };
      if (command.type === 'semantic.index.job') return { ok: true, type: 'semantic.index.job-updated', updated: true };
      if (command.type === 'semantic.index.prepare') return {
        ok: true, type: 'semantic.index.prepared', assetId: 'asset-one', sourceRevision: 'rev-one', kind: 'text', text: 'Content',
      };
      return { ok: true, type: 'semantic.index.closed' };
    });
    const index = createIndex(requestWorker);
    try {
      index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: true });
      await vi.waitFor(() => expect(providerSignal).not.toBeNull());
      await index.close('library-other');
      expect(providerSignal!.aborted).toBe(false);
      await index.close('library-one');
      expect(providerSignal!.aborted).toBe(true);
      expect(requestWorker).toHaveBeenCalledWith(expect.objectContaining({ type: 'semantic.index.close', libraryId: 'library-one' }));
      expect(requestWorker.mock.calls.some(([command]) => command.type === 'semantic.index.write')).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await index.close();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a corrupt or unavailable sidecar failure inside the semantic status', async () => {
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'semantic.index.begin') throw new Error('sidecar is unreadable');
      return { ok: true, type: 'semantic.index.closed' };
    });
    const index = createIndex(requestWorker);
    expect(index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: true }))
      .toMatchObject({ type: 'embedding.index.status', phase: 'starting' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: false }))
      .toMatchObject({ type: 'embedding.index.status', phase: 'failed' });
    expect(requestWorker).toHaveBeenCalledWith(expect.objectContaining({ type: 'semantic.index.begin' }));
    await index.close();
  });

  it('persists source preparation failures as durable failed jobs', async () => {
    const failedJobs: Extract<WorkerCommand, { type: 'semantic.index.job' }>[] = [];
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'semantic.index.begin') {
        return { ok: true, type: 'semantic.index.started', profileId: '0'.repeat(64), nativeCosineAvailable: false };
      }
      if (command.type === 'semantic.index.import-legacy') {
        return { ok: true, type: 'semantic.index.legacy-imported', attempted: false, acceptedRows: 0, rejectedRows: 0 };
      }
      if (command.type === 'semantic.index.targets') {
        return { ok: true, type: 'semantic.index.targets', revisionSnapshot: 1, total: 1, nextOffset: null,
          targets: [{ assetId: 'asset-a', sourceRevision: 'revision-a', kind: 'text', modality: 'text',
            alreadyIndexed: false, jobStatus: 'pending' }] };
      }
      if (command.type === 'semantic.index.job') {
        if (command.action === 'fail') failedJobs.push(command);
        return { ok: true, type: 'semantic.index.job-updated', updated: true };
      }
      if (command.type === 'semantic.index.prepare') throw new Error('Source file is unavailable.');
      return { ok: true, type: 'semantic.index.closed' };
    });
    const index = createIndex(requestWorker);
    try {
      index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: true });
      for (let attempt = 0; attempt < 100 && failedJobs.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      expect(failedJobs).toHaveLength(1);
      expect(failedJobs[0]).toMatchObject({
        action: 'fail', assetId: 'asset-a', sourceRevision: 'revision-a', errorCategory: 'preparation',
      });
      expect(index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: false }))
        .toMatchObject({ type: 'embedding.index.status', phase: 'ready', failedCount: 1 });
    } finally {
      await index.close();
    }
  });

  it('starts the newest library generation after an older begin request unwinds', async () => {
    let releaseOldBegin: ((result: WorkerResult) => void) | undefined;
    const begunLibraries: string[] = [];
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'semantic.index.begin') {
        begunLibraries.push(command.libraryId);
        if (command.libraryId === 'library-one') {
          return await new Promise((resolve) => { releaseOldBegin = resolve; });
        }
        return { ok: true, type: 'semantic.index.started', profileId: '0'.repeat(64), nativeCosineAvailable: false };
      }
      if (command.type === 'semantic.index.import-legacy') {
        return { ok: true, type: 'semantic.index.legacy-imported', attempted: false, acceptedRows: 0, rejectedRows: 0 };
      }
      if (command.type === 'semantic.index.targets') {
        return { ok: true, type: 'semantic.index.targets', revisionSnapshot: 1, total: 0, nextOffset: null, targets: [] };
      }
      return { ok: true, type: 'semantic.index.closed' };
    });
    const index = createIndex(requestWorker);
    index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: true });
    for (let attempt = 0; attempt < 100 && !releaseOldBegin; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(releaseOldBegin).toBeTypeOf('function');
    index.handleStatus({ libraryId: 'library-two', modelId: service.id, run: true });
    releaseOldBegin?.({
      ok: true, type: 'semantic.index.started', profileId: '0'.repeat(64), nativeCosineAvailable: false,
    });
    for (let attempt = 0; attempt < 100 && !begunLibraries.includes('library-two'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(begunLibraries).toEqual(['library-one', 'library-two']);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = index.handleStatus({ libraryId: 'library-two', modelId: service.id, run: false });
      if ('type' in status && status.type === 'embedding.index.status' && status.phase === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(index.handleStatus({ libraryId: 'library-two', modelId: service.id, run: false }))
      .toMatchObject({ type: 'embedding.index.status', phase: 'ready' });
    await index.close();
  });

  it('does not call a remote provider before explicit library grant and binding enablement', async () => {
    const requestWorker = vi.fn(async () => ({ ok: true, type: 'semantic.index.started' } as WorkerResult));
    const index = createIndex(requestWorker, { enabled: false });
    const result = await index.handleSearch({ libraryId: 'library-one', modelId: service.id, query: 'query' });
    expect(result).toMatchObject({ ok: true, type: 'embedding.search', phase: 'unavailable', hold: 'grant' });
    expect(requestWorker).not.toHaveBeenCalled();
    await index.close();
  });

  it('ranks only the newest search when provider responses arrive out of order', async () => {
    const pendingA: { resolve?: (response: Response) => void } = {};
    const rankedVectors: number[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      const query = body.input[0];
      const response = (embedding: number[]) => new Response(JSON.stringify({
        data: [{ embedding, index: 0 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (query === 'A') return await new Promise<Response>((resolve) => { pendingA.resolve = resolve; });
      return response([0, 1, 0]);
    }));
    const requestWorker = vi.fn(async (command: WorkerCommand) => {
      if (command.type === 'semantic.index.begin') {
        return { ok: true, type: 'semantic.index.started', profileId: '0'.repeat(64), nativeCosineAvailable: false } as WorkerResult;
      }
      if (command.type === 'semantic.index.import-legacy') {
        return { ok: true, type: 'semantic.index.legacy-imported', attempted: false,
          acceptedRows: 0, rejectedRows: 0 } as WorkerResult;
      }
      if (command.type === 'semantic.index.targets') {
        return { ok: true, type: 'semantic.index.targets', revisionSnapshot: 1, total: 1, nextOffset: null,
          targets: [{ assetId: 'asset-one', sourceRevision: 'rev-one', kind: 'text', modality: 'text', alreadyIndexed: true }] } as WorkerResult;
      }
      if (command.type === 'semantic.index.search') {
        rankedVectors.push(command.vector);
        return { ok: true, type: 'semantic.index.ranked', candidateCount: 1, assetIds: ['asset-one'],
          scores: [{ assetId: 'asset-one', score: 1 }] } as WorkerResult;
      }
      return { ok: true, type: 'semantic.index.closed' } as WorkerResult;
    });
    const index = createIndex(requestWorker);
    try {
      index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: true });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: false });
        if ('type' in status && status.type === 'embedding.index.status' && status.phase === 'ready') break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      const searchA = index.handleSearch({ libraryId: 'library-one', modelId: service.id, query: 'A' });
      for (let attempt = 0; attempt < 100 && !pendingA.resolve; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const searchB = index.handleSearch({ libraryId: 'library-one', modelId: service.id, query: 'B' });
      const resultB = await searchB;
      pendingA.resolve?.(new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0], index: 0 }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
      const resultA = await searchA;

      expect(resultB).toMatchObject({ type: 'embedding.search', assetIds: ['asset-one'] });
      expect(resultA).toMatchObject({ type: 'embedding.search', assetIds: [] });
      expect(rankedVectors).toEqual([[0, 1, 0]]);
      expect(requestWorker.mock.calls.filter(([command]) => command.type === 'semantic.index.begin')).toHaveLength(1);
    } finally {
      await index.close();
      vi.unstubAllGlobals();
    }
  });

  it('does not report a Worker ranking failure as an empty successful search or unsupported asset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: [1, 0, 0], index: 0 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'semantic.index.begin') {
        return { ok: true, type: 'semantic.index.started', profileId: '0'.repeat(64), nativeCosineAvailable: false };
      }
      if (command.type === 'semantic.index.import-legacy') {
        return { ok: true, type: 'semantic.index.legacy-imported', attempted: false, acceptedRows: 0, rejectedRows: 0 };
      }
      if (command.type === 'semantic.index.targets') {
        return { ok: true, type: 'semantic.index.targets', revisionSnapshot: 1, total: 1, nextOffset: null,
          targets: [{ assetId: 'asset-one', sourceRevision: 'rev-one', kind: 'text', modality: 'text', alreadyIndexed: true }] };
      }
      if (command.type === 'semantic.index.search' || command.type === 'semantic.index.similar') {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Index unavailable.' } };
      }
      return { ok: true, type: 'semantic.index.closed' };
    });
    const index = createIndex(requestWorker);
    try {
      index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: true });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = index.handleStatus({ libraryId: 'library-one', modelId: service.id, run: false });
        if ('type' in status && status.type === 'embedding.index.status' && status.phase === 'ready') break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(await index.handleSearch({ libraryId: 'library-one', modelId: service.id, query: 'query' }))
        .toMatchObject({ ok: false });
      expect(await index.handleSimilar({ libraryId: 'library-one', modelId: service.id, assetId: 'asset-one' }))
        .toMatchObject({ ok: false });
    } finally {
      await index.close();
      vi.unstubAllGlobals();
    }
  });
});
