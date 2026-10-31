import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-28T00:00:00Z');
  const root = await mkdtemp(path.join(tmpdir(), 'companion-stale-outbox-')), file = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(file, [{ id: 'alice', name: 'Alice', description: '', persona: '只依据真实来源。', model: '', avatar: 'sister', active: true, proactive: false }]);
  const sql = new (Database as { new(filename: string, options: { readonly: boolean }): CompanionConnection })(file, { readonly: true }), conversationId = store.openPrivate('alice').id;
  cleanups.push(async () => { sql.close(); store.close();
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-stale-outbox-')) throw new Error('Unsafe stale-outbox cleanup');
    await removeOwnedDirectory(root); });
  const source = store.appendMessage({ conversationId, authorId: 'user', content: '独立真实来源 STALE_DELIVERY_CANARY', replyDirective: 'none' });
  const note = store.request({ type: 'memory.record', companionId: 'alice', conversationId, candidate: { artifactKind: 'episode_memory', content: source.content,
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], metadata: { autoTags: false } } }).memories![0]!;
  const claim = () => store.request({ type: 'memory.outbox.claim', companionId: 'alice', leaseMs: 1000 }).memoryOutbox!;
  const read = (id: string) => sql.prepare('SELECT * FROM vcp_memory_outbox WHERE id=?').get(id);
  return { store, source, note, conversationId, claim, read };
}
it('keeps a newer delivery lease byte-identical when the expired worker defers after returning', async () => {
  const f = await fixture(), old = f.claim(); vi.setSystemTime(Date.now() + 1001); const current = f.claim();
  expect(current.id).toBe(old.id); expect(current.leaseToken).not.toBe(old.leaseToken); const before = f.read(current.id);
  expect(() => f.store.request({ type: 'memory.outbox.defer', id: old.id, leaseToken: old.leaseToken, retryAfterMs: 1000 })).not.toThrow();
  expect(f.read(current.id)).toEqual(before);
  f.store.request({ type: 'memory.outbox.complete', id: current.id, leaseToken: current.leaseToken, indexed: true });
});
it('does not reopen an explicitly parked job or alter its counters when the original delivery defers', async () => {
  const f = await fixture(), old = f.claim(), current = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'index', id: old.id }).jobDisposition!;
  f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'index', id: old.id, inputVersion: current.inputVersion,
    expectedRevision: current.revision, operationId: randomUUID(), action: 'park' }); const before = f.read(old.id);
  f.store.request({ type: 'memory.outbox.defer', id: old.id, leaseToken: old.leaseToken, retryAfterMs: 1000 });
  expect(f.read(old.id)).toEqual(before); expect(f.claim()).toBeUndefined();
});
it('keeps withdrawn work terminal and preserves its original chat when a cancelled native delivery defers', async () => {
  const f = await fixture(), old = f.claim();
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.conversationId, sourceMessageIds: [f.source.id] });
  const before = f.read(old.id); expect(() => f.store.request({ type: 'memory.outbox.defer', id: old.id, leaseToken: old.leaseToken, retryAfterMs: 1000 })).not.toThrow();
  expect(f.read(old.id)).toEqual(before); expect(f.store.getMessage(f.source.id).content).toBe(f.source.content);
  expect(f.store.listMemory('alice').some(note => note.id === f.note.id)).toBe(false);
});
