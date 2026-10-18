import { describe, expect, it } from 'vitest';

import { parseRendererRequest, parseWorkerRequest } from '../../src/shared/protocol/requests';
import { parseRendererResult, parseWorkerResponse } from '../../src/shared/protocol/responses';
import { folderBrowseEntrySchema } from '../../src/shared/asset-types';

const sessionGeneration = '2bfad4ec-a457-4f45-bc32-d107a1ed9d1f';

describe('asset manager 0.3.0 boundary compatibility', () => {
  it('keeps legacy folder entries readable and accepts library-asset covers', () => {
    const folder = {
      folderId: 'folder-1', parentFolderId: null, locationKind: 'managed', name: 'Pictures',
      relativePath: 'Pictures', status: 'available', directAssetCount: 0, recursiveAssetCount: 0,
      childFolderCount: 0, coverArtifactIds: [], coverAssetIds: [],
    };
    expect(folderBrowseEntrySchema.safeParse(folder).success).toBe(true);
    expect(folderBrowseEntrySchema.parse({
      ...folder, hasCustomCover: true, customCoverAssetId: 'asset-1',
      customCoverSourcePreview: { assetId: 'asset-1', revisionId: 'revision-1' },
    })).toMatchObject({ customCoverAssetId: 'asset-1' });
    expect(parseRendererRequest({
      type: 'folder.cover.set-asset.request', libraryId: 'library-1', folderIds: ['folder-1'], assetId: 'asset-1',
    }).type).toBe('folder.cover.set-asset.request');
    expect(() => parseRendererRequest({
      type: 'folder.cover.set-asset.request', libraryId: 'library-1', folderIds: [], assetId: 'asset-1',
    })).toThrow();
  });

  it('validates semantic provider selection and bounds across renderer IPC', () => {
    expect(parseRendererRequest({
      type: 'embedding.index.status.request', libraryId: 'library-1', modelId: 'svc_12345678',
      run: false, restart: false, stop: true,
    })).toMatchObject({ run: false, stop: true });
    expect(parseRendererRequest({
      type: 'embedding.binding.save.request', libraryId: 'library-1', selectionId: null,
    })).toMatchObject({ selectionId: null });
    expect(parseRendererRequest({
      type: 'embedding.binding.save.request', libraryId: 'library-1', selectionId: 'svc_12345678', inherit: false,
    })).toMatchObject({ selectionId: 'svc_12345678', inherit: false });
    expect(() => parseRendererRequest({
      type: 'embedding.binding.save.request', libraryId: 'library-1', selectionId: '../../model',
    })).toThrow();
    expect(() => parseRendererRequest({
      type: 'embedding.search.request', libraryId: 'library-1', modelId: 'svc_12345678', query: ' ',
    })).toThrow();
  });

  it('rejects non-finite vectors and prepared payloads with ambiguous content', () => {
    expect(() => parseWorkerRequest({ requestId: 'vector', command: {
      type: 'semantic.index.search', libraryId: 'library-1', sessionGeneration,
      queryId: sessionGeneration, profileKey: 'profile', vector: [Number.NaN],
    } })).toThrow();
    expect(() => parseWorkerResponse({ requestId: 'prepared', result: {
      ok: true, type: 'semantic.index.prepared', assetId: 'asset-1', sourceRevision: 'revision-1',
      kind: 'text', text: 'text content', bytesBase64: 'AAAA',
    } })).toThrow();
  });

  it('rejects duplicate or unrelated semantic rank scores', () => {
    const result = {
      ok: true, type: 'embedding.search', phase: 'ready', done: 1, total: 1,
      failedCount: 0, assetIds: ['asset-1'],
    };
    expect(parseRendererResult({ ...result, scores: [{ assetId: 'asset-1', score: 0.8 }] }))
      .toMatchObject({ assetIds: ['asset-1'] });
    expect(() => parseRendererResult({ ...result, scores: [{ assetId: 'asset-2', score: 0.8 }] })).toThrow();
    expect(() => parseRendererResult({ ...result, scores: [
      { assetId: 'asset-1', score: 0.8 }, { assetId: 'asset-1', score: 0.7 },
    ] })).toThrow();
  });
});
