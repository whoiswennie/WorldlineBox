import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CompanionMemory } from '../../src/shared/companions';
import { CompanionMemoryViewCache } from '../../src/main/companions/memory-view-cache';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeOwnedDirectory(directory); });
async function persisted() {
  const directory = await mkdtemp(path.join(tmpdir(), 'worldline-view-boundaries-')); directories.push(directory);
  return { directory, cache: new CompanionMemoryViewCache(directory) };
}

const note: CompanionMemory = { id: 'note_a', companionId: 'alice', scopeId: 'scope_a', content: '真实来源的合成测试日记。', tags: ['测试'], diaryName: '日记',
  sourceConversationId: 'private-alice', sourceMessageId: 'message_a', sourceSequence: 1, createdAt: '2026-10-21', updatedAt: '2026-10-21',
  version: 1, origin: 'user', status: 'indexed', captureMethod: 'automatic', metadata: { source: 'original' },
  sources: [{ messageId: 'message_a', conversationId: 'private-alice', authorId: 'user', sequence: 1, revision: 1, checksum: 'original', createdAt: '2026-10-21', sourceType: 'message' }] };

it('reuses a ready graph for additions while changing notebook classification forces a fresh physical graph', async () => {
  const cache = new CompanionMemoryViewCache();
  const first = await cache.prepare('alice:private-alice', 'global-model', [note]); await first.commit();
  const added = await cache.prepare('alice:private-alice', 'global-model', [note, { ...note, id: 'note_b' }]); await added.commit();
  expect(added.scopeId).toBe(first.scopeId);
  const reclassified = await cache.prepare('alice:private-alice', 'global-model', [{ ...note, diaryName: '资料' }, { ...note, id: 'note_b' }]);
  expect(reclassified.scopeId).not.toBe(first.scopeId); expect(reclassified.replacedScopeId).toBe(first.scopeId);
});

it.each(['metadata', 'source'] as const)('cannot reuse an old graph when authoritative %s changes even if text and note version match', async changed => {
  const cache = new CompanionMemoryViewCache(), first = await cache.prepare('alice:private-alice', 'global-model', [note]); await first.commit();
  const revised = changed === 'metadata' ? { ...note, metadata: { source: 'revised' } } : { ...note, sources: [{ ...note.sources[0]!, checksum: 'revised' }] };
  const next = await cache.prepare('alice:private-alice', 'global-model', [revised]);
  expect(next.scopeId).not.toBe(first.scopeId); expect(next.replacedScopeId).toBe(first.scopeId);
});

it.each(['content', 'tags', 'notebook', 'metadata', 'source', 'removal'] as const)('differentially syncs a clean complete graph after %s changes without creating an empty replacement', async changed => {
  const cache = new CompanionMemoryViewCache(), identity = 'alice:owner-v2', profile = 'global-model', signature = 'alice-zone';
  const options = { incremental: true }, first = await cache.prepare(identity, profile, [note], signature, options); await first.commit();
  const updated: CompanionMemory = changed === 'content' ? { ...note, content: '修订后的真实合成日记。', version: 2 }
    : changed === 'tags' ? { ...note, tags: ['新标签'] } : changed === 'notebook' ? { ...note, diaryName: '资料' }
      : changed === 'metadata' ? { ...note, metadata: { source: 'revised' } }
        : { ...note, sources: [{ ...note.sources[0]!, checksum: 'new-source', revision: 2 }] };
  const notes = changed === 'removal' ? [] : [updated];
  const next = await cache.prepare(identity, profile, notes, signature, options);
  expect(next.scopeId).toBe(first.scopeId); expect(next.replacedScopeId).toBeUndefined(); expect(next.unchanged).toBe(false);
  await next.commit();
  const stable = await cache.prepare(identity, profile, notes, signature, options);
  expect(stable.scopeId).toBe(first.scopeId); expect(stable.unchanged).toBe(true);
});

it('reopens a clean complete graph after restart and applies revisions through the same physical scope', async () => {
  const { cache, directory } = await persisted(), options = { incremental: true };
  const first = await cache.prepare('alice:owner-v2', 'model-a', [note], 'alice-zone', options); await first.commit();
  const reopened = new CompanionMemoryViewCache(directory);
  const same = await reopened.prepare('alice:owner-v2', 'model-a', [note], 'alice-zone', options);
  expect(same.scopeId).toBe(first.scopeId); expect(same.unchanged).toBe(true);
  const revised = await reopened.prepare('alice:owner-v2', 'model-a', [{ ...note, version: 2, content: '新正文。' }], 'alice-zone', options);
  expect(revised.scopeId).toBe(first.scopeId); expect(revised.unchanged).toBe(false);
});

it.each(['interrupted', 'projection', 'profile', 'identity'] as const)('keeps the fresh-scope boundary for %s changes even with differential synchronization enabled', async changed => {
  const cache = new CompanionMemoryViewCache(), options = { incremental: true };
  const first = await cache.prepare('alice:owner-v2', 'model-a', [note], 'alice-zone', options);
  if (changed !== 'interrupted') await first.commit();
  const next = await cache.prepare(changed === 'identity' ? 'bob:owner-v2' : 'alice:owner-v2',
    changed === 'profile' ? 'model-b' : 'model-a', [note], changed === 'projection' ? 'alice-another-zone' : 'alice-zone', options);
  expect(next.scopeId).not.toBe(first.scopeId); expect(next.unchanged).toBe(false);
});

it('preserves clean persisted indexes only as needs-sync receipts and clears their derived timelines', async () => {
  const { cache, directory } = await persisted(), options = { incremental: true };
  const clean = await cache.prepare('alice:owner-v2', 'model-a', [note], 'alice-zone', options); await clean.commit();
  const dirty = await cache.prepare('alice:unfinished', 'model-a', [note], 'alice-zone', options);
  const other = await cache.prepare('bob:owner-v2', 'model-a', [note], 'bob-zone', options); await other.commit();
  const timeline = { schema: 'worldlinebox.vcp-timeline-artifacts' as const, sourceRevision: 'source-v1', agents: [] };
  await cache.saveArtifacts('alice:owner-v2', 'model-a', timeline);
  await cache.saveArtifacts('bob:owner-v2', 'model-a', timeline);
  const reloaded = new CompanionMemoryViewCache(directory);
  expect(await reloaded.invalidateOwner('alice', { preserveIndexes: true })).toEqual([{ scopeId: dirty.scopeId, profileKey: 'model-a' }]);
  expect(await reloaded.loadArtifacts('alice:owner-v2', 'model-a')).toBeUndefined();
  expect(await reloaded.loadArtifacts('bob:owner-v2', 'model-a')).toEqual(timeline);
  const afterRestart = new CompanionMemoryViewCache(directory);
  const sync = await afterRestart.prepare('alice:owner-v2', 'model-a', [note], 'alice-zone', options);
  expect(sync.scopeId).toBe(clean.scopeId); expect(sync.unchanged).toBe(false);
  await sync.commit();
  expect((await afterRestart.prepare('alice:owner-v2', 'model-a', [note], 'alice-zone', options)).unchanged).toBe(true);
  const incomplete = await afterRestart.prepare('alice:unfinished', 'model-a', [note], 'alice-zone', options);
  expect(incomplete.scopeId).not.toBe(dirty.scopeId);
  expect((await afterRestart.prepare('bob:owner-v2', 'model-a', [note], 'bob-zone', options)).unchanged).toBe(true);
  expect(await afterRestart.invalidateOwner('alice')).toEqual(expect.arrayContaining([
    { scopeId: clean.scopeId, profileKey: 'model-a' }, { scopeId: incomplete.scopeId, profileKey: 'model-a' },
  ]));
});

it('does not resurrect a clean disk receipt after this process observed an interrupted write', async () => {
  const { cache, directory } = await persisted(), options = { incremental: true };
  const pending = await cache.prepare('alice:owner-v2', 'model-a', [note], 'alice-zone', options);
  const file = path.join(directory, (await readdir(directory)).find(file => file.endsWith('.json'))!);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...stored, dirty: false }));
  expect(await cache.invalidateOwner('alice', { preserveIndexes: true })).toEqual([{ scopeId: pending.scopeId, profileKey: 'model-a' }]);
  const next = await new CompanionMemoryViewCache(directory).prepare('alice:owner-v2', 'model-a', [note], 'alice-zone', options);
  expect(next.scopeId).not.toBe(pending.scopeId);
});
