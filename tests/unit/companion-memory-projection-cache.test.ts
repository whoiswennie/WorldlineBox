import { expect, it, vi } from 'vitest';
import { CompanionMemoryProjectionCache } from '../../src/main/companions/memory-projection-cache';
import type { CompanionMemoryProjectionNote } from '../../src/shared/companion-memory-projection';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const metadata = (id: string, companionId = 'alice'): CompanionMemoryProjectionNote => ({ id, companionId, scopeId: 'scope',
  tags: ['original'], sourceConversationId: 'private', sourceSequence: 20,
  sources: [{ messageId: 'source', conversationId: 'private', authorId: 'user', sequence: 20, revision: 1, checksum: 'a'.repeat(64), createdAt: '2026-10-27T00:00:00Z' }],
  createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', origin: 'user', status: 'indexed', version: 1, captureMethod: 'manual', contentRevision: 1,
  bodyFingerprint: 'b'.repeat(64), projectionFingerprint: 'c'.repeat(64), notBeforeSequence: 20 });
function fixture(limits: ConstructorParameters<typeof CompanionMemoryProjectionCache>[1] = {}) {
  let sequence = 1, revocationEpoch = 0, notes = [metadata('note')];
  const request = vi.fn(async (command: CompanionStorageCommand) => {
    const state = { companionId: 'companionId' in command ? command.companionId : 'alice', sequence, floorSequence: 0, revocationEpoch, resetRevision: 0, externalVersion: 1, generation: 0 };
    if (command.type === 'memory.projection.state') return { ok: true, memoryProjectionState: state };
    if (command.type === 'memory.projection.release') return { ok: true };
    if (command.type === 'memory.projection.page' || command.type === 'memory.projection.delta') return { ok: true,
      memoryProjectionPage: { state, notes: notes.map(note => ({ ...note, companionId: command.companionId })), removedIds: [], hasMore: false, nextSequence: sequence } };
    throw new Error('Unexpected body read ' + command.type);
  });
  const cache = new CompanionMemoryProjectionCache(request as never, limits);
  return { cache, request, change: () => { sequence++; notes = [{ ...notes[0]!, version: 2, tags: ['updated'], projectionFingerprint: 'd'.repeat(64) }]; },
    revoke: () => { revocationEpoch++; }, setNotes: (next: CompanionMemoryProjectionNote[]) => { notes = next; sequence++; } };
}
it('reuses an exact authorized metadata catalogue with one state read, then applies only deltas while retaining an old task snapshot', async () => {
  const f = fixture(), scope = { companionId: 'alice', conversationId: 'private' };
  const old = (await f.cache.acquire(scope))!; expect('content' in old.value.notes[0]!).toBe(false);
  f.request.mockClear(); const same = (await f.cache.acquire(scope))!;
  expect(f.request.mock.calls.map(([command]) => command.type)).toEqual(['memory.projection.state']); expect(same.value.notes).toBe(old.value.notes); same.release();
  f.change(); const updated = (await f.cache.acquire(scope))!;
  expect(f.request.mock.calls.filter(([command]) => command.type !== 'memory.projection.release').at(-1)![0].type).toBe('memory.projection.delta'); expect(updated.value.notes[0]!.tags).toEqual(['updated']);
  expect(old.value.notes[0]!.tags).toEqual(['original']); expect(() => old.assertCurrent()).not.toThrow();
  expect(f.cache.snapshot().retiredCatalogues).toBe(1); old.release(); expect(f.cache.snapshot().retiredCatalogues).toBe(0);
  f.cache.invalidate('alice'); expect(() => updated.assertCurrent()).toThrow('撤回'); updated.release(); expect(f.cache.snapshot().metadataBytes).toBe(0);
});
it('uses the complete original path for a cutoff earlier than the conservative source/publication boundary', async () => {
  const f = fixture(); expect(await f.cache.acquire({ companionId: 'alice', conversationId: 'private', beforeSequence: 19 })).toBeUndefined();
  const latest = await f.cache.acquire({ companionId: 'alice', conversationId: 'another-valid-entrance', beforeSequence: 21 }); expect(latest?.value.notes).toHaveLength(1); latest?.release();
});
it('keeps referenced owner catalogues and rejects the fifth before loading another page; an idle catalogue may retire', async () => {
  const f = fixture(), leases = [];
  for (const owner of ['alice', 'bob', 'carol', 'dave']) leases.push((await f.cache.acquire({ companionId: owner, conversationId: 'private' }))!);
  f.request.mockClear(); await expect(f.cache.acquire({ companionId: 'erin', conversationId: 'private' })).rejects.toMatchObject({ code: 'VCP_MEMORY_NATIVE_CAPACITY' });
  expect(f.request).not.toHaveBeenCalled(); leases[0]!.release(); const fifth = (await f.cache.acquire({ companionId: 'erin', conversationId: 'private' }))!;
  expect(f.cache.snapshot().owners).toBe(4); for (const lease of leases.slice(1)) lease.release(); fifth.release(); f.cache.clear();
});
it('accounts a complete oversized catalogue exclusively and reports explicit capacity without truncating notes or evicting an active task', async () => {
  const one = metadata('large'); one.metadata = { padding: 'x'.repeat(2000) };
  const f = fixture({ maxBytes: 2048, maxSingleBytes: 4096 }); f.setNotes([one]);
  const large = (await f.cache.acquire({ companionId: 'alice', conversationId: 'private' }))!;
  expect(large.value.notes).toHaveLength(1); expect(f.cache.snapshot().metadataBytes).toBeGreaterThan(2048);
  await expect(f.cache.acquire({ companionId: 'bob', conversationId: 'private' })).rejects.toMatchObject({ code: 'VCP_MEMORY_NATIVE_CAPACITY' });
  expect(() => large.assertCurrent()).not.toThrow(); large.release(); f.cache.clear();
});
it('keeps an old task during a same-owner delta at the owner cap and cancels cold loads/queued calls on clear', async () => {
  const f = fixture({ maxOwners: 1 }), scope = { companionId: 'alice', conversationId: 'private' }, old = (await f.cache.acquire(scope))!;
  f.change(); const next = (await f.cache.acquire(scope))!; expect(next.value.notes[0]!.version).toBe(2); expect(() => old.assertCurrent()).not.toThrow();
  old.release(); next.release(); f.cache.clear();
  let finish!: () => void;
  const gated = fixture(), request = gated.request.getMockImplementation()!;
  gated.request.mockImplementation(async command => { if (command.type === 'memory.projection.state') await new Promise<void>(resolve => { finish = resolve; }); return request(command); });
  const first = gated.cache.acquire(scope), second = gated.cache.acquire(scope);
  const rejected = Promise.all([expect(first).rejects.toThrow('撤回'), expect(second).rejects.toThrow('撤回')]);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); gated.cache.clear(); finish(); await rejected;
  expect(gated.cache.snapshot()).toMatchObject({ owners: 0, loading: 0, pending: 0 });
});
