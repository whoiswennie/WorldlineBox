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
  const root = await mkdtemp(path.join(tmpdir(), 'companion-stale-ack-')), file = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(file, [{ id: 'alice', name: 'Alice', description: '', persona: '只依据真实来源。', model: '', avatar: 'sister', active: true, proactive: false }]);
  const sql = new (Database as { new(filename: string): CompanionConnection })(file), conversationId = store.openPrivate('alice').id;
  cleanups.push(async () => { sql.close(); store.close();
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-stale-ack-')) throw new Error('Unsafe stale-ack cleanup');
    await removeOwnedDirectory(root); });
  const record = (content: string) => {
    const source = store.appendMessage({ conversationId, authorId: 'user', content, replyDirective: 'none' });
    const note = store.request({ type: 'memory.record', companionId: 'alice', conversationId, candidate: { artifactKind: 'episode_memory', content,
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }], metadata: { autoTags: false } } }).memories![0]!;
    return { source, note };
  };
  const claim = () => store.request({ type: 'memory.outbox.claim', companionId: 'alice', leaseMs: 1000 }).memoryOutbox!;
  const read = (id: string) => sql.prepare('SELECT * FROM vcp_memory_outbox WHERE id=?').get(id);
  return { store, sql, conversationId, record, claim, read };
}

it('acknowledges an expired remember negatively without altering the replacement lease, while old success remains rejected', async () => {
  const f = await fixture(); f.record('原始记录 STALE_ACK_CANARY'); const old = f.claim();
  vi.setSystemTime(Date.now() + 1001); const current = f.claim(), before = f.read(current.id);
  expect(current.id).toBe(old.id); expect(current.leaseToken).not.toBe(old.leaseToken);
  expect(f.store.request({ type: 'memory.outbox.complete', id: old.id, leaseToken: old.leaseToken, indexed: false }).memoryOutboxDisposition)
    .toMatchObject({ state: 'stale', reason: 'delivery_lease_changed' });
  expect(f.read(current.id)).toEqual(before);
  expect(() => f.store.request({ type: 'memory.outbox.complete', id: old.id, leaseToken: old.leaseToken, indexed: true })).toThrow('租约已失效');
  expect(f.read(current.id)).toEqual(before);
  expect(f.store.request({ type: 'memory.outbox.complete', id: current.id, leaseToken: current.leaseToken, indexed: true }).memoryOutboxDisposition?.state).toBe('completed');
});

it.each(['park', 'abandon'] as const)('does not reopen %s or count a stale negative acknowledgement, and processes a later independent source', async action => {
  const f = await fixture(), original = f.record('珍贵原事件 HELD_ACK_CANARY'), old = f.claim();
  const current = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'index', id: old.id }).jobDisposition!;
  f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'index', id: old.id, inputVersion: current.inputVersion,
    expectedRevision: current.revision, operationId: randomUUID(), action }); const before = f.read(old.id);
  expect(f.store.request({ type: 'memory.outbox.complete', id: old.id, leaseToken: old.leaseToken, indexed: false }).memoryOutboxDisposition?.state).toBe('stale');
  expect(f.read(old.id)).toEqual(before); expect(f.store.getMessage(original.source.id).content).toBe(original.source.content);
  const good = f.record('后续独立合法记录 GOOD_ACK_CANARY'), next = f.claim();
  expect(next.noteId).toBe(good.note.id); expect(next.id).not.toBe(old.id);
  f.store.request({ type: 'memory.outbox.complete', id: next.id, leaseToken: next.leaseToken, indexed: true });
  expect(f.read(old.id)).toEqual(before); expect(f.claim()).toBeUndefined();
});

it('keeps a withdrawn negative acknowledgement inert and rejects missing identities and real SQL publication errors', async () => {
  const f = await fixture(), original = f.record('将被撤回的依据 WITHDRAWN_ACK_CANARY'), old = f.claim();
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.conversationId, sourceMessageIds: [original.source.id] });
  const before = f.read(old.id);
  expect(f.store.request({ type: 'memory.outbox.complete', id: old.id, leaseToken: old.leaseToken, indexed: false }).memoryOutboxDisposition?.state).toBe('stale');
  expect(f.read(old.id)).toEqual(before); expect(f.store.getMessage(original.source.id).content).toBe(original.source.content);
  expect(() => f.store.request({ type: 'memory.outbox.complete', id: 'missing', leaseToken: old.leaseToken, indexed: false })).toThrow('租约已失效');
  // Settle only the actual deletion receipt before selecting the new input.
  for (;;) { const deletion = f.claim(); if (!deletion) break; expect(deletion.operation).toBe('forget');
    f.store.request({ type: 'memory.outbox.complete', id: deletion.id, leaseToken: deletion.leaseToken, indexed: true }); }
  const good = f.record('真实新事件 SQL_ACK_CANARY'), next = f.claim(); expect(next.noteId).toBe(good.note.id); const goodBefore = f.read(next.id);
  f.sql.exec("CREATE TRIGGER fail_actual_ack BEFORE UPDATE ON vcp_memory_outbox BEGIN SELECT RAISE(ABORT,'actual acknowledgement SQL failure'); END");
  expect(() => f.store.request({ type: 'memory.outbox.complete', id: next.id, leaseToken: next.leaseToken, indexed: true })).toThrow('actual acknowledgement SQL failure');
  expect(f.read(next.id)).toEqual(goodBefore);
});
