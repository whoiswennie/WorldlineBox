import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [], connections: CompanionConnection[] = [];
afterEach(async () => { connections.splice(0).forEach(db => db.close()); for (const f of fixtures.splice(0)) await f.close(); });
function fixture() { const f = managedMemoryFiles(); fixtures.push(f); return f; }
function directMemory(f: ReturnType<typeof fixture>) {
  const db = new (Database as { new(file: string): CompanionConnection })(path.join(f.root, 'state.sqlite')); connections.push(db);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  return { db, memory: new CompanionMemoryStore(db, id => f.store.getMessage(id)) };
}

it('reports a real new note source publication enqueue without falsely reporting source revocation', () => {
  const f = fixture(), source = f.source('这份新记录的真实原文。');
  const created = f.store.request({ type: 'memory.record', ...f.scope, candidate: f.candidate('系统整理出的新记录。', [source.id]) });
  expect(created.memories).toHaveLength(1); expect(created.memoryChangedCompanionIds).toEqual(['alice']);
  expect(created.memorySourcePublicationQueuedCompanionIds).toEqual(['alice']);
  expect(created.memorySourceChangedCompanionIds).toBeUndefined(); expect(created.memoryInvalidatedCompanionIds).toBeUndefined();
  const job = f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice' }).memorySourceOutbox!;
  expect(job).toMatchObject({ operation: 'publish', sourceId: source.id, sourceRevision: source.revision ?? 1 });
  expect(f.store.request({ type: 'memory.sources.outbox.check', id: job.id, leaseToken: job.leaseToken }).memorySourceOutboxAccepted).toBe(true);
  const completed = f.store.request({ type: 'memory.sources.outbox.complete', id: job.id, leaseToken: job.leaseToken });
  expect(completed.memorySourceOutboxAccepted).toBe(true); expect(completed.memorySourceChangedCompanionIds).toBeUndefined();
  expect(completed.memorySourcePublicationQueuedCompanionIds).toBeUndefined();
});

it('keeps real source forgetting hard and does not make its pending retract a soft publication', () => {
  const f = fixture(), source = f.source('这份原文随后被明确撤回。');
  f.store.request({ type: 'memory.record', ...f.scope, candidate: f.candidate('依赖这份原文的记录。', [source.id]) });
  const withdrawn = f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] });
  expect(withdrawn.memoryInvalidatedCompanionIds).toContain('alice'); expect(withdrawn.memorySourceChangedCompanionIds).toContain('alice');
  expect(withdrawn.memorySourcePublicationQueuedCompanionIds).toBeUndefined();
  expect(f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice' }).memorySourceOutbox?.operation).toBe('retract');
  expect(f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: [source.id] }).memorySources).toEqual([]);
});

it('keeps hard priority when publish and retract accumulate for the same owner before the next notification drain', () => {
  const f = fixture(), source = f.source('同一批通知中的真实原文。'), { memory } = directMemory(f);
  const note = memory.execute({ type: 'memory.record', ...f.scope, candidate: f.candidate('同一批的记录。', [source.id]) })!.memories![0]!;
  memory.execute({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] });
  expect(memory.takeSourceOutboxChanges()).toEqual({ changedOwners: ['alice'], publicationQueuedOwners: [] });
  expect(memory.takeInvalidatedOwners()).toContain('alice');
  expect(memory.execute({ type: 'memory.records.filter', ...f.scope, ids: [note.id] })!.memories).toEqual([]);
  expect(memory.takeSourceOutboxChanges()).toEqual({ changedOwners: [], publicationQueuedOwners: [] });
});

it('reports even an identical-byte source revision change as hard while preserving the original source-file retention rule', () => {
  const f = fixture(), source = f.source('相同字节的修订仍是来源版本变化。'), { memory, db } = directMemory(f);
  memory.execute({ type: 'memory.record', ...f.scope, candidate: f.candidate('固定记录。', [source.id]) });
  expect(memory.takeSourceOutboxChanges()).toEqual({ changedOwners: [], publicationQueuedOwners: ['alice'] });
  db.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(source.id);
  memory.enqueueMessage(source.id);
  expect(memory.takeSourceOutboxChanges()).toEqual({ changedOwners: ['alice'], publicationQueuedOwners: [] });
  expect(db.prepare("SELECT COUNT(*) AS n FROM companion_memory_source_outbox WHERE source_id=? AND source_revision=1 AND operation='retract'").get(source.id)).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM companion_memory_source_outbox WHERE source_id=? AND source_revision=2 AND operation='publish'").get(source.id)).toEqual({ n: 1 });
});
