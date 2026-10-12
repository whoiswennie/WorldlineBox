import { describe, expect, it } from 'vitest';

import {
  BrowseSessionStore,
  browseQueryFingerprint,
  browseSessionIndexComplete,
  browseSessionPageUsesSnapshot,
} from '../../src/worker/browse-session-store';

describe('BrowseSessionStore', () => {
  it('keeps an ordered id snapshot and fences it by sequence and generation', () => {
    const store = new BrowseSessionStore();
    const session = store.create({
      libraryId: 'library-1',
      libraryGeneration: 3,
      changeSequence: 12,
      queryFingerprint: browseQueryFingerprint({ scope: 'root', sort: 'name' }),
      assetIds: ['asset-b', 'asset-a'],
    });

    expect(store.lookup({
      libraryId: 'library-1',
      sessionId: session.sessionId,
      libraryGeneration: 3,
      changeSequence: 12,
    })).toMatchObject({ status: 'ready' });
    expect(session.declaredTotal).toBe(2);
    expect(store.lookup({
      libraryId: 'library-1',
      sessionId: session.sessionId,
      libraryGeneration: 3,
      changeSequence: 13,
    })).toEqual({ status: 'stale', reason: 'change-sequence' });

    const replacement = store.create({
      libraryId: 'library-1',
      libraryGeneration: 3,
      changeSequence: 14,
      queryFingerprint: 'same-query',
      assetIds: ['asset-a'],
    });
    expect(store.lookup({
      libraryId: 'library-1',
      sessionId: replacement.sessionId,
      libraryGeneration: 4,
      changeSequence: 14,
    })).toEqual({ status: 'stale', reason: 'library-generation' });
  });

  it('evicts oldest snapshots and invalidates one library only', () => {
    const store = new BrowseSessionStore(2);
    const create = (libraryId: string) => store.create({
      libraryId,
      libraryGeneration: 1,
      changeSequence: 1,
      queryFingerprint: libraryId,
      assetIds: [],
    });
    const first = create('library-a');
    const second = create('library-b');
    const third = create('library-c');

    expect(store.lookup({
      libraryId: 'library-a',
      sessionId: first.sessionId,
      libraryGeneration: 1,
      changeSequence: 1,
    })).toEqual({ status: 'missing' });
    store.invalidateLibrary('library-b');
    expect(store.lookup({
      libraryId: 'library-b',
      sessionId: second.sessionId,
      libraryGeneration: 1,
      changeSequence: 1,
    })).toEqual({ status: 'missing' });
    expect(store.lookup({
      libraryId: 'library-c',
      sessionId: third.sessionId,
      libraryGeneration: 1,
      changeSequence: 1,
    })).toMatchObject({ status: 'ready' });
  });

  it('fingerprints equivalent object key order identically', () => {
    expect(browseQueryFingerprint({ b: 2, a: 1 })).toBe(
      browseQueryFingerprint({ a: 1, b: 2 }),
    );
    expect(browseQueryFingerprint({ a: [1, 2] })).not.toBe(
      browseQueryFingerprint({ a: [2, 1] }),
    );
  });

  it('treats a first-page id prefix as an incomplete index', () => {
    const store = new BrowseSessionStore();
    const session = store.create({
      libraryId: 'library-1',
      libraryGeneration: 1,
      changeSequence: 1,
      queryFingerprint: 'folder-a',
      declaredTotal: 250,
      assetIds: ['asset-1', 'asset-2'],
    });
    expect(browseSessionIndexComplete(session)).toBe(false);
    expect(browseSessionPageUsesSnapshot(session, 0, 2)).toBe(true);
    expect(browseSessionPageUsesSnapshot(session, 100, 100)).toBe(false);
    const completed = store.replaceAssetIds(
      'library-1',
      session.sessionId,
      Array.from({ length: 250 }, (_, index) => `asset-${index}`),
    );
    expect(completed).not.toBeNull();
    expect(browseSessionIndexComplete(completed!)).toBe(true);
    expect(completed!.declaredTotal).toBe(250);
  });
});
