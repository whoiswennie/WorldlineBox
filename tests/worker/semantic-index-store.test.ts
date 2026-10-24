import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

import {
  encodeSemanticVector,
  SemanticIndexStore,
} from '../../src/worker/semantic-index-store';

const temporaryRoots: string[] = [];
const stores: SemanticIndexStore[] = [];
const require = createRequire(import.meta.url);

interface TestDatabase {
  close(): void;
  prepare(sql: string): { run(...parameters: unknown[]): { changes: number } };
}

const Database = require('better-sqlite3') as new (filename: string) => TestDatabase;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of temporaryRoots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error('Unexpected semantic-index fixture root');
    removeOwnedDirectorySync(root);
  }
});

function createStore(
  libraryId = 'test-library',
  loadNativeExtension?: ConstructorParameters<typeof SemanticIndexStore>[0]['loadNativeExtension'],
): SemanticIndexStore {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-index-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, '.worldlinebox'));
  const store = new SemanticIndexStore({
    libraryPath: root,
    libraryId,
    storageKind: 'local',
    ...(loadNativeExtension ? { loadNativeExtension } : {}),
  });
  stores.push(store);
  return store;
}

describe('SemanticIndexStore', () => {
  it('encodes finite vectors as explicitly little-endian Float32 BLOBs', () => {
    const unit = encodeSemanticVector([1], 1);
    expect(unit.toString('hex')).toBe('0000803f');
    const bytes = encodeSemanticVector([1, -0.5], 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getFloat32(0, true)).toBeCloseTo(0.8944272, 6);
    expect(view.getFloat32(4, true)).toBeCloseTo(-0.4472136, 6);
    expect(() => encodeSemanticVector([Number.NaN], 1)).toThrow(/finite/u);
    expect(() => encodeSemanticVector([0], 1)).toThrow(/non-zero/u);
    expect(() => encodeSemanticVector([1], 2)).toThrow(/dimensions/u);
  });

  it('stores incremental batches and ranks exact raw cosine scores', async () => {
    const store = createStore();
    expect(store.nativeCosineAvailable).toBe(true);
    const profileId = store.ensureProfile({
      profileKey: 'local-model-profile',
      dimensions: 3,
      modelRevision: 'weights-v1',
      modality: 'mixed',
    });
    store.markPending(profileId, 'near', 'r1');
    store.markPending(profileId, 'far', 'r1');
    expect(store.upsertBatch(profileId, [
      { assetId: 'far', sourceRevision: 'r1', vector: [0, 1, 0] },
      { assetId: 'near', sourceRevision: 'r1', vector: [0.9, 0.1, 0] },
    ])).toEqual({ accepted: ['far', 'near'], rejected: [] });
    expect(store.count(profileId)).toBe(2);

    const ranked = await store.rank({
      profileId,
      query: [1, 0, 0],
      liveRevisions: new Map([['near', 'r1'], ['far', 'r1']]),
      candidateAssetIds: ['far', 'near'],
    });
    expect(ranked?.map(({ assetId }) => assetId)).toEqual(['near', 'far']);
    expect(ranked?.[0]?.score).toBeCloseTo(0.9938837, 6);
  });

  it('persists job claims and failure categories, then requeues interrupted work on reopen', () => {
    const store = createStore();
    const root = temporaryRoots.at(-1)!;
    const profileId = store.ensureProfile({
      profileKey: 'durable-jobs', dimensions: 2, modelRevision: 'model-v1', modality: 'text',
    });
    store.markPending(profileId, 'asset-a', 'revision-a');
    expect(store.markRunning(profileId, 'asset-a', 'revision-a', 'claim-one')).toBe(true);
    expect(store.jobFor(profileId, 'asset-a')).toMatchObject({ status: 'running', attempts: 1 });
    store.close();

    const reopened = new SemanticIndexStore({ libraryPath: root, libraryId: 'test-library', storageKind: 'local' });
    stores.push(reopened);
    expect(reopened.jobFor(profileId, 'asset-a')).toMatchObject({ status: 'pending', attempts: 1 });
    expect(reopened.markRunning(profileId, 'asset-a', 'revision-a', 'claim-two')).toBe(true);
    reopened.markFailed(profileId, 'asset-a', 'revision-a', 'claim-two', 'provider');
    expect(reopened.jobFor(profileId, 'asset-a')).toMatchObject({
      status: 'failed', attempts: 2, errorCategory: 'provider',
    });
    expect(reopened.markRunning(profileId, 'asset-a', 'revision-a', 'claim-three')).toBe(false);
  });

  it('makes a failed job claimable after its retry deadline expires', () => {
    const store = createStore();
    const root = temporaryRoots.at(-1)!;
    const profileId = store.ensureProfile({
      profileKey: 'retry-deadline', dimensions: 2, modelRevision: 'model-v1', modality: 'text',
    });
    store.markPending(profileId, 'asset-a', 'revision-a');
    expect(store.markRunning(profileId, 'asset-a', 'revision-a', 'claim-one')).toBe(true);
    store.markFailed(profileId, 'asset-a', 'revision-a', 'claim-one', 'preparation');
    expect(store.jobFor(profileId, 'asset-a')).toMatchObject({ status: 'failed', errorCategory: 'preparation' });

    const database = new Database(path.join(root, '.worldlinebox', 'semantic', 'index.sqlite'));
    try {
      database.prepare('UPDATE embedding_jobs SET retry_after = ? WHERE profile_id = ? AND asset_id = ?')
        .run('2000-01-01T00:00:00.000Z', profileId, 'asset-a');
    } finally {
      database.close();
    }

    expect(store.jobFor(profileId, 'asset-a')).toMatchObject({ status: 'pending', errorCategory: 'preparation' });
    expect(store.markRunning(profileId, 'asset-a', 'revision-a', 'claim-two')).toBe(true);
    expect(store.jobFor(profileId, 'asset-a')).toMatchObject({ status: 'running', attempts: 2 });
  });

  it('fences duplicate claims, stale revisions, and late failures from the current job', () => {
    const store = createStore();
    const profileId = store.ensureProfile({
      profileKey: 'claim-fencing', dimensions: 2, modelRevision: 'model-v1', modality: 'image',
    });
    store.markPending(profileId, 'asset-a', 'revision-one');
    expect(store.markRunning(profileId, 'asset-a', 'revision-one', 'claim-old')).toBe(true);
    store.markPending(profileId, 'asset-a', 'revision-one');
    expect(store.jobFor(profileId, 'asset-a')).toMatchObject({ status: 'running', sourceRevision: 'revision-one' });
    expect(store.markRunning(profileId, 'asset-a', 'revision-one', 'claim-duplicate')).toBe(false);

    store.markPending(profileId, 'asset-a', 'revision-two');
    expect(store.upsertBatch(profileId, [{
      assetId: 'asset-a', sourceRevision: 'revision-two', vector: [0, 1], claimToken: 'claim-old',
    }])).toEqual({ accepted: [], rejected: ['asset-a'] });
    expect(store.vectorFor(profileId, 'asset-a', 'revision-two')).toBeNull();
    store.markFailed(profileId, 'asset-a', 'revision-one', 'claim-old', 'provider');
    expect(store.jobFor(profileId, 'asset-a')).toMatchObject({ status: 'pending', sourceRevision: 'revision-two' });
    expect(store.markRunning(profileId, 'asset-a', 'revision-two', 'claim-current')).toBe(true);
    expect(store.upsertBatch(profileId, [{
      assetId: 'asset-a', sourceRevision: 'revision-two', vector: [1, 0], claimToken: 'claim-current',
    }]).accepted).toEqual(['asset-a']);
    store.markFailed(profileId, 'asset-a', 'revision-two', 'claim-current', 'provider');
    expect(store.jobFor(profileId, 'asset-a')).toMatchObject({ status: 'ready', sourceRevision: 'revision-two' });
  });

  it('normalizes large/small non-unit vectors and produces equivalent native/fallback rankings', async () => {
    const native = createStore('native-library');
    const fallback = createStore('fallback-library', () => {
      throw new Error('test fallback');
    });
    expect(native.nativeCosineAvailable).toBe(true);
    expect(fallback.nativeCosineAvailable).toBe(false);
    const profile = {
      profileKey: 'non-unit-profile',
      dimensions: 3,
      modelRevision: 'weights-v1',
      modality: 'image' as const,
    };
    const nativeProfile = native.ensureProfile(profile);
    const fallbackProfile = fallback.ensureProfile(profile);
    const inputs = [
      { assetId: 'near', sourceRevision: 'r1', vector: [3e200, 4e200, 0] },
      { assetId: 'diagonal', sourceRevision: 'r1', vector: [1e-250, 1e-250, 0] },
      { assetId: 'opposite', sourceRevision: 'r1', vector: [-1, 0, 0] },
    ];
    native.upsertBatch(nativeProfile, inputs);
    fallback.upsertBatch(fallbackProfile, inputs);
    const live = new Map(inputs.map(({ assetId }) => [assetId, 'r1']));
    const options = { query: [6, 8, 0], liveRevisions: live, candidateAssetIds: inputs.map(({ assetId }) => assetId) };
    const [nativeRanked, fallbackRanked] = await Promise.all([
      native.rank({ profileId: nativeProfile, ...options }),
      fallback.rank({ profileId: fallbackProfile, ...options }),
    ]);
    expect(nativeRanked?.map(({ assetId }) => assetId)).toEqual(fallbackRanked?.map(({ assetId }) => assetId));
    expect(nativeRanked?.map(({ score }) => score)).toEqual(expect.arrayContaining([expect.closeTo(1, 5)]));
    nativeRanked?.forEach((row, index) => expect(row.score).toBeCloseTo(fallbackRanked?.[index]?.score ?? 0, 6));
    expect(() => encodeSemanticVector([Number.MAX_VALUE, Number.MAX_VALUE, 0], 3)).not.toThrow();
    expect(() => encodeSemanticVector([Number.MIN_VALUE, 0, 0], 3)).not.toThrow();
  });

  it('rejects stale revisions, removes obsolete data, and honors cancellation between chunks', async () => {
    const store = createStore();
    const profileId = store.ensureProfile({
      profileKey: 'model-v1',
      dimensions: 2,
      modelRevision: 'weights-v1',
      modality: 'image',
    });
    const records = Array.from({ length: 600 }, (_, index) => ({
      assetId: `asset-${String(index).padStart(4, '0')}`,
      sourceRevision: 'r1',
      vector: [1, 0],
    }));
    for (let start = 0; start < records.length; start += 128) {
      store.upsertBatch(profileId, records.slice(start, start + 128));
    }
    const live = new Map(records.map(({ assetId }) => [assetId, 'r1']));
    const cancelled = await store.rank({
      profileId,
      query: [1, 0],
      liveRevisions: live,
      candidateAssetIds: records.map(({ assetId }) => assetId),
      shouldContinue: () => false,
    });
    expect(cancelled).toBeNull();

    const staleOnly = await store.rank({
      profileId,
      query: [1, 0],
      liveRevisions: new Map([['asset-0000', 'changed']]),
      candidateAssetIds: ['asset-0000'],
    });
    expect(staleOnly).toEqual([]);
    store.removeStale(profileId, new Map([['asset-0000', 'r1']]));
    expect(store.count(profileId)).toBe(1);
  });

  it('invalidates vectors when a profile changes dimensions or model revision', async () => {
    const store = createStore();
    const original = store.ensureProfile({
      profileKey: 'service-profile',
      dimensions: 2,
      modelRevision: 'remote-model-v1',
      modality: 'text',
    });
    store.upsertBatch(original, [{ assetId: 'a', sourceRevision: 'r1', vector: [1, 0] }]);
    const changed = store.ensureProfile({
      profileKey: 'service-profile',
      dimensions: 3,
      modelRevision: 'remote-model-v2',
      modality: 'text',
    });
    expect(changed).toBe(original);
    expect(store.count(changed)).toBe(0);
  });

  it('prevents reusing a copied sidecar with a different library identity', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-index-identity-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, '.worldlinebox'));
    const first = new SemanticIndexStore({ libraryPath: root, libraryId: 'library-one', storageKind: 'local' });
    stores.push(first);
    first.close();
    expect(() => new SemanticIndexStore({
      libraryPath: root,
      libraryId: 'library-two',
      storageKind: 'local',
    })).toThrow(/another library/u);
  });

  it('uses conservative DELETE journaling when library storage is unknown', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-index-unknown-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, '.worldlinebox'));
    const store = new SemanticIndexStore({ libraryPath: root, libraryId: 'unknown-library', storageKind: 'unknown' });
    expect(store.journalMode).toBe('delete');
    store.close();
  });

  it('refuses a symlinked semantic directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-index-link-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-outside-'));
    temporaryRoots.push(root, outside);
    mkdirSync(path.join(root, '.worldlinebox'));
    symlinkSync(outside, path.join(root, '.worldlinebox', 'semantic'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new SemanticIndexStore({
      libraryPath: root,
      libraryId: 'library-link',
      storageKind: 'local',
    })).toThrow(/safe library directory/u);
  });
});
