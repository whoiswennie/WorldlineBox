import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionMemoryViewCache, type CompanionMemoryViewCacheLimits } from '../../src/main/companions/memory-view-cache';
import type { CompanionMemory } from '../../src/shared/companions';
import type { VcpMemoryTimelineArtifacts } from '../../src/main/vcp-memory/contracts';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

const directories: string[] = [];
afterEach(async () => { for (const root of directories.splice(0)) await removeOwnedDirectory(root); });
async function fixture(limits: CompanionMemoryViewCacheLimits = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'worldline-view-residency-')); directories.push(directory);
  return { directory, cache: new CompanionMemoryViewCache(directory, limits) };
}
const note = (id = 'note', version = 1): CompanionMemory => ({ id, companionId: 'owner', scopeId: 'original', content: `CURRENT_BODY_${version}`,
  tags: ['topic'], diaryName: '日记', sourceConversationId: 'private', sourceSequence: 1, sources: [], createdAt: '2026-10-26', updatedAt: '2026-10-26',
  version, origin: 'user', status: 'indexed', captureMethod: 'manual' });
const artifacts = (label: string, size = 16): VcpMemoryTimelineArtifacts => ({ schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: label,
  agents: [{ agentName: 'Owner', months: [{ month: '2026-10', sourceDigest: 'a'.repeat(64), summary: `${label}:${'x'.repeat(size)}` }] }] });

it('bounds clean multi-owner/profile manifests while restoring evicted scopes from disk without changing identity', async () => {
  const { cache, directory } = await fixture(), expected = new Map<string, string>();
  const corpus = Array.from({ length: 100 }, (_, index) => note(`note_${index}`));
  for (let index = 0; index < 128; index++) {
    const identity = `owner${index % 12}:owner-v2`, profile = `model_${index}`;
    const view = await cache.prepare(identity, profile, corpus); await view.commit(); expected.set(identity + '\n' + profile, view.scopeId);
    expect(cache.snapshot()).toMatchObject({ views: Math.min(index + 1, 16), dirtyViews: 0 });
  }
  expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(128);
  for (const [key, scopeId] of expected) {
    const [identity, profile] = key.split('\n');
    const restored = await cache.prepare(identity!, profile!, corpus);
    expect(restored.scopeId).toBe(scopeId); expect(restored.unchanged).toBe(true); expect(restored.replacedScopeId).toBeUndefined();
    expect(cache.snapshot().views).toBeLessThanOrEqual(16);
  }
  expect(JSON.stringify(cache.snapshot())).not.toMatch(/CURRENT_BODY|owner0|model_/u);
});

it('bounds abandoned dirty preparations and restores them as unsafe scopes instead of permanently pinning failed callers', async () => {
  const { cache } = await fixture({ maxViews: 1 });
  const pending = [];
  for (let index = 0; index < 100; index++) {
    pending.push(await cache.prepare(`owner${index}:owner-v2`, 'profile', [note()]));
    expect(cache.snapshot()).toMatchObject({ views: 1, dirtyViews: 1, activeSaves: 0 });
  }
  for (let index = 0; index < 100; index++) {
    const restored = await cache.prepare(`owner${index}:owner-v2`, 'profile', [note()]);
    expect(restored.scopeId).not.toBe(pending[index]!.scopeId);
    expect(restored.replacedScopeId).toBe(pending[index]!.scopeId); expect(restored.unchanged).toBe(false);
    await restored.commit(); expect(cache.snapshot()).toMatchObject({ views: 1, dirtyViews: 0, activeSaves: 0 });
  }
});

it('keeps residency stable during repeated ordinary edits without rebuilding complete graph identities', async () => {
  const { cache } = await fixture({ maxViews: 3 }), scopes = new Map<string, string>();
  for (let revision = 1; revision <= 30; revision++) for (let index = 0; index < 10; index++) {
    const identity = `owner${index}:owner-v2`, view = await cache.prepare(identity, 'profile', [note('retained', revision)], 'same-projection', { incremental: true });
    if (scopes.has(identity)) expect(view.scopeId).toBe(scopes.get(identity));
    scopes.set(identity, view.scopeId); await view.commit();
    expect(cache.snapshot()).toMatchObject({ views: revision === 1 ? Math.min(index + 1, 3) : 3, dirtyViews: 0 });
  }
});

it('preserves all clean on-disk views during invalidation even as the invalidation itself evicts resident receipts', async () => {
  const { cache } = await fixture({ maxViews: 2, maxArtifacts: 1 }), expected = new Map<string, string>();
  for (let index = 0; index < 36; index++) {
    const profile = `profile_${index}`, view = await cache.prepare('alice:owner-v2', profile, [note()]); await view.commit();
    expected.set(profile, view.scopeId); await cache.saveArtifacts('alice:owner-v2', profile, artifacts(profile));
  }
  const bob = await cache.prepare('bob:owner-v2', 'other-profile', [note()]); await bob.commit();
  expect(await cache.invalidateOwner('alice', { preserveIndexes: true })).toEqual([]);
  expect(cache.snapshot().views).toBeLessThanOrEqual(2); expect(cache.snapshot().artifacts).toBe(0);
  for (const [profile, scopeId] of expected) {
    const restored = await cache.prepare('alice:owner-v2', profile, [note()], undefined, { incremental: true });
    expect(restored.scopeId).toBe(scopeId); expect(restored.unchanged).toBe(false); await restored.commit();
    expect(await cache.loadArtifacts('alice:owner-v2', profile)).toBeUndefined();
  }
  const purged = await cache.invalidateOwner('alice');
  expect(new Set(purged.map(view => view.scopeId))).toEqual(new Set(expected.values()));
  expect((await cache.prepare('bob:owner-v2', 'other-profile', [note()])).scopeId).toBe(bob.scopeId);
});

it.each([{ maxArtifacts: 2, maxArtifactBytes: 1_000_000 }, { maxArtifacts: 8, maxArtifactBytes: 25_000 }])('bounds timeline residency by %j, restores evicted artifacts and leaves oversized files off heap', async limits => {
  const { cache, directory } = await fixture(limits);
  for (let index = 0; index < 8; index++) {
    await cache.saveArtifacts(`owner${index}:owner-v2`, 'profile', artifacts(`artifact_${index}`, 9_000));
    expect(cache.snapshot().artifacts).toBeLessThanOrEqual(2); expect(cache.snapshot().artifactBytes).toBeLessThanOrEqual(limits.maxArtifactBytes);
  }
  const restored = await cache.loadArtifacts('owner0:owner-v2', 'profile'); expect(restored?.sourceRevision).toBe('artifact_0');
  restored!.agents[0]!.months[0]!.summary = 'caller mutation';
  expect((await cache.loadArtifacts('owner0:owner-v2', 'profile'))?.agents[0]!.months[0]!.summary).not.toBe('caller mutation');
  const before = cache.snapshot();
  await cache.saveArtifacts('oversized:owner-v2', 'profile', artifacts('large', limits.maxArtifactBytes + 1_000));
  expect(cache.snapshot()).toEqual(before);
  expect((await cache.loadArtifacts('oversized:owner-v2', 'profile'))?.sourceRevision).toBe('large');
  expect(cache.snapshot()).toEqual(before);
  expect((await readdir(directory)).filter(name => name.endsWith('.timeline'))).toHaveLength(9);
  await cache.invalidateOwner('owner0');
  expect(await cache.loadArtifacts('owner0:owner-v2', 'profile')).toBeUndefined();
  expect(cache.snapshot().artifactBytes).toBeGreaterThanOrEqual(0);
});

it('keeps a single oversized fingerprint manifest on disk rather than exceeding the view byte budget', async () => {
  const { cache } = await fixture({ maxViews: 16, maxViewBytes: 8_000 });
  const large = Array.from({ length: 2_000 }, (_, index) => note(`large_note_${index}`));
  const view = await cache.prepare('owner:owner-v2', 'large-model', large);
  expect(cache.snapshot()).toMatchObject({ views: 0, viewBytes: 0, activeSaves: 0 });
  await view.commit(); expect(cache.snapshot()).toMatchObject({ views: 0, viewBytes: 0 });
  const restored = await cache.prepare('owner:owner-v2', 'large-model', large);
  expect(restored.scopeId).toBe(view.scopeId); expect(restored.unchanged).toBe(true);
  expect(cache.snapshot()).toMatchObject({ views: 0, viewBytes: 0 });
  const dirty = await cache.prepare('other:owner-v2', 'large-model', large);
  const retry = await cache.prepare('other:owner-v2', 'large-model', large);
  expect(retry.scopeId).not.toBe(dirty.scopeId); expect(retry.replacedScopeId).toBe(dirty.scopeId);
});

it('does not discard non-persistent fixture views or artifacts when no disk authority exists', async () => {
  const cache = new CompanionMemoryViewCache(undefined, { maxViews: 1, maxArtifacts: 1, maxArtifactBytes: 1 }), scopes: string[] = [];
  for (let index = 0; index < 12; index++) {
    const view = await cache.prepare(`owner${index}:owner-v2`, 'profile', [note()]); await view.commit(); scopes.push(view.scopeId);
    await cache.saveArtifacts(`owner${index}:owner-v2`, 'profile', artifacts(`artifact_${index}`));
  }
  expect(cache.snapshot()).toMatchObject({ persistent: false, views: 12, artifacts: 12 });
  for (let index = 0; index < 12; index++) {
    expect((await cache.prepare(`owner${index}:owner-v2`, 'profile', [note()])).scopeId).toBe(scopes[index]);
    expect((await cache.loadArtifacts(`owner${index}:owner-v2`, 'profile'))?.sourceRevision).toBe(`artifact_${index}`);
  }
});
