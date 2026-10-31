import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { recordSourceBackedMemory } from '../fixtures/source-backed-memory';

it('journals exact native projection status acknowledgements, tags, archive, DELETE and scope/reset fences without returning bodies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-projection-ledger-'));
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-projection-ledger-')) throw new Error('Unsafe synthetic projection root.');
  const database = path.join(root, 'ledger.sqlite'), store = new CompanionsStore(database, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: 'Synthetic metadata source authority.', model: '', avatar: 'sister', active: true, proactive: false })));
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const state = () => store.request({ type: 'memory.projection.state', ...scope }).memoryProjectionState!;
  const acknowledge = () => { for (;;) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break;
    store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); } };
  try {
    const note = recordSourceBackedMemory(store, { ...scope, content: 'Synthetic exact canonical body canary.', tags: ['initial'], diaryName: '资料' }), queued = state();
    expect(store.request({ type: 'memory.projection.page', ...scope, expected: queued }).memoryProjectionPage?.notes).toEqual([]);
    acknowledge(); const indexed = state(); expect(indexed.sequence).toBeGreaterThan(queued.sequence);
    const initial = store.request({ type: 'memory.projection.delta', ...scope, expected: indexed, afterSequence: queued.sequence }).memoryProjectionPage!;
    expect(initial.notes.map(note => note.id)).toEqual([note.id]); expect(JSON.stringify(initial)).not.toContain('Synthetic exact canonical body');
    const descriptor = initial.notes[0]!; expect(descriptor.bodyFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(descriptor.notBeforeSequence).toBeGreaterThan(0);
    const current = store.request({ type: 'memory.library.read', companionId: 'alice', id: note.id }).memoryRead!.memory;
    store.request({ type: 'memory.library.organize', companionId: 'alice', id: note.id, expectedVersion: current.version, tags: ['changed'], diaryName: '资料' });
    const retaggedQueued = state(); expect(retaggedQueued.sequence).toBeGreaterThan(indexed.sequence);
    expect(store.request({ type: 'memory.projection.delta', ...scope, expected: retaggedQueued, afterSequence: indexed.sequence }).memoryProjectionPage?.removedIds).toContain(note.id);
    acknowledge(); const retagged = state(), changed = store.request({ type: 'memory.projection.delta', ...scope, expected: retagged, afterSequence: indexed.sequence }).memoryProjectionPage!.notes[0]!;
    expect(changed.tags).toEqual(['changed']); expect(changed.bodyFingerprint).toBe(descriptor.bodyFingerprint); expect(changed.projectionFingerprint).not.toBe(descriptor.projectionFingerprint);
    const Database = createRequire(import.meta.url)('better-sqlite3') as new(file: string) => { prepare(sql: string): { run(...args: unknown[]): void };
      function(name: string, options: { deterministic: boolean }, implementation: (text: string) => string): void; close(): void };
    const direct = new Database(database); direct.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); direct.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try {
      direct.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.archivedAt','2026-10-27T00:00:00Z') WHERE id=?").run(note.id);
      const archived = state(); expect(store.request({ type: 'memory.projection.delta', ...scope, expected: archived, afterSequence: retagged.sequence }).memoryProjectionPage?.removedIds).toContain(note.id);
      direct.prepare('DELETE FROM vcp_memory_notes WHERE id=?').run(note.id); const deleted = state();
      expect(deleted.sequence).toBeGreaterThan(archived.sequence);
      expect(store.request({ type: 'memory.projection.delta', ...scope, expected: deleted, afterSequence: archived.sequence }).memoryProjectionPage?.removedIds).toContain(note.id);
      expect(() => store.request({ type: 'memory.projection.page', ...scope, expected: indexed })).toThrow();
    } finally { direct.close(); }
    expect(() => store.request({ type: 'memory.projection.state', companionId: 'bob', conversationId: scope.conversationId })).toThrow();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

it('pages one immutable metadata frame through ordinary writes, releases cancelled captures, and rejects hard withdrawal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-projection-ledger-'));
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-projection-ledger-')) throw new Error('Unsafe synthetic projection root.');
  const store = new CompanionsStore(path.join(root, 'ledger.sqlite'), [{ id: 'alice', name: 'alice', description: '', persona: 'Synthetic fixed metadata frame.', model: '', avatar: 'sister', active: true, proactive: false }]);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const state = () => store.request({ type: 'memory.projection.state', ...scope }).memoryProjectionState!;
  const acknowledge = () => { for (;;) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break;
    store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); } };
  const organize = (id: string, tag: string) => { const current = store.request({ type: 'memory.library.read', companionId: 'alice', id }).memoryRead!.memory;
    store.request({ type: 'memory.library.organize', companionId: 'alice', id, expectedVersion: current.version, tags: [tag], diaryName: current.diaryName ?? '日记' }); acknowledge(); };
  try {
    const notes = Array.from({ length: 3 }, (_, index) => recordSourceBackedMemory(store, { ...scope, content: 'Immutable synthetic body ' + index, tags: ['initial'] })); acknowledge();
    const first = store.request({ type: 'memory.projection.page', ...scope, expected: state(), limit: 1 }).memoryProjectionPage!;
    expect(first.hasMore).toBe(true);
    const added = recordSourceBackedMemory(store, { ...scope, content: 'Lawful later body outside the captured frame.', tags: ['later'] }); acknowledge();
    const second = store.request({ type: 'memory.projection.page', ...scope, expected: first.state, afterId: first.nextId, limit: 10 }).memoryProjectionPage!;
    expect(second.state).toEqual(first.state); expect(second.hasMore).toBe(false);
    expect([...first.notes, ...second.notes].map(note => note.id).sort()).toEqual(notes.map(note => note.id).sort());
    const base = state(); organize(notes[0]!.id, 'captured-first'); organize(notes[1]!.id, 'captured-second');
    const delta = store.request({ type: 'memory.projection.delta', ...scope, expected: state(), afterSequence: base.sequence, limit: 1 }).memoryProjectionPage!;
    organize(notes[2]!.id, 'after-delta-frame');
    const tail = store.request({ type: 'memory.projection.delta', ...scope, expected: delta.state, afterSequence: delta.nextSequence!, limit: 10 }).memoryProjectionPage!;
    expect(tail.state).toEqual(delta.state); expect(tail.hasMore).toBe(false);
    expect([...delta.notes, ...tail.notes].map(note => note.id).sort()).toEqual([notes[0]!.id, notes[1]!.id].sort());
    const cancelled = store.request({ type: 'memory.projection.page', ...scope, expected: state(), limit: 1 }).memoryProjectionPage!;
    expect(store.request({ type: 'memory.projection.release', companionId: 'alice', expected: cancelled.state }).ok).toBe(true);
    organize(added.id, 'after-cancellation');
    const fresh = store.request({ type: 'memory.projection.page', ...scope, expected: state(), limit: 1 }).memoryProjectionPage!;
    expect(fresh.state.sequence).toBeGreaterThan(cancelled.state.sequence);
    store.request({ type: 'memory.forget', ...scope, id: notes[0]!.id });
    expect(() => store.request({ type: 'memory.projection.page', ...scope, expected: fresh.state, afterId: fresh.nextId, limit: 10 })).toThrow();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
