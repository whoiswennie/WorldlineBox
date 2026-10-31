import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionTopicCompactionJob } from '../../src/shared/companion-topic-compaction-jobs';
import { holdRestoredCompanionWork, assertRestoredCompanionWorkHeld } from '../../src/companions/recovery-hold';

const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T04:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-topic-reconcile-')) throw new Error('Unsafe reconcile fixture cleanup');
  rmSync(root, { recursive: true, force: true });
} vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-topic-reconcile-')), file = path.join(root, 'messages.sqlite'); roots.push(root);
  let store = new CompanionsStore(file, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '保留真实原始事件。', model: '', avatar: 'sister' as const, active: true, proactive: false }))); stores.add(store);
  const room = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: room.id, topicId: room.activeTopicId! };
  const source = (content: string, target = scope) => store.appendMessage({ conversationId: target.conversationId, topicId: target.topicId, authorId: 'user', content, replyDirective: 'none' });
  const enqueue = (id: string, target = scope) => store.request({ type: 'topic.compaction.enqueue', ...target, sourceMessageId: id }).topicCompactionJob!;
  const claim = () => store.request({ type: 'topic.compaction.claim', excludedCompanionIds: [], leaseMs: 120000 }).topicCompactionJob;
  const inspect = (id: string, ownerId = 'alice') => store.request({ type: 'jobs.inspect', ownerId, kind: 'topic_compaction', id }).jobDisposition!;
  const bind = (job: CompanionTopicCompactionJob, ids: string[]) => store.request({ type: 'topic.compaction.bind', id: job.id, leaseToken: job.leaseToken!, checkpointEventIds: [],
    sources: ids.map(id => { const source = store.getMessage(id); return { id, revision: source.revision!, checksum: createHash('sha256').update(source.content).digest('hex') }; }) });
  const forget = (ids: string[]) => store.request({ type: 'memory.forget', companionId: 'alice', conversationId: room.id, sourceMessageIds: ids });
  const sql = () => new (Database as { new(filename: string): CompanionConnection })(file);
  return { get store() { return store; }, scope, source, enqueue, claim, inspect, bind, forget, sql,
    restart: () => { store.close(); stores.delete(store); store = new CompanionsStore(file, []); stores.add(store); } };
}

it('reconciles a withdrawn non-tail input without a new message or enqueue and preserves cumulative failures', () => {
  const f = fixture(), a = f.source('较早读到的原始事件A。'), b = f.source('后续仍然合法的原始事件B。'), c = f.source('准确尾部请求C。');
  const queued = f.enqueue(c.id), first = f.claim()!; f.bind(first, [a.id, b.id]);
  f.store.request({ type: 'topic.compaction.fail', id: first.id, leaseToken: first.leaseToken!, failureKind: 'processing', error: '一次真实处理故障', retryAfterMs: 0 });
  const old = f.claim()!; f.bind(old, [a.id, b.id]); f.forget([a.id]);
  expect(f.inspect(old.id)).toMatchObject({ state: 'stale', failureCount: 1, cycleFailureCount: 1, attemptCount: 2 });
  const next = f.claim()!;
  expect(next).toMatchObject({ id: old.id, status: 'running', sourceMessageId: c.id, requestedThroughSequence: queued.requestedThroughSequence,
    requestedPublicationRevision: queued.requestedPublicationRevision, attempts: 3 });
  expect(next.leaseToken).not.toBe(old.leaseToken); expect(f.bind(next, [b.id]).topicCompactionJob?.id).toBe(next.id);
  f.store.request({ type: 'topic.compaction.fail', id: old.id, leaseToken: old.leaseToken!, failureKind: 'processing', error: '迟到旧失败不能清新租约。', retryAfterMs: 0 });
  expect(f.inspect(next.id)).toMatchObject({ state: 'running', failureCount: 1, cycleFailureCount: 1 });
  expect(() => f.store.request({ type: 'topic.compaction.settle', id: old.id, leaseToken: old.leaseToken!, hasMore: false })).toThrow('租约已失效');
  expect(f.store.request({ type: 'topic.compaction.settle', id: next.id, leaseToken: next.leaseToken!, hasMore: false }).topicCompactionJob?.status).toBe('completed');
  expect(f.store.getMessage(a.id).content).toBe(a.content); expect(f.store.getMessage(b.id).content).toBe(b.content);
});

it('persists a descending bounded cursor across restart and never borrows a newer publication beyond the requested horizon', () => {
  const f = fixture(), messages = Array.from({ length: 71 }, (_, index) => f.source('实际原始事件 ' + index));
  const queued = f.enqueue(messages.at(-1)!.id), old = f.claim()!; f.forget(messages.slice(1).map(source => source.id));
  const future = f.source('尚未请求的未来新消息，不得借它改写旧输入水位。');
  expect(f.claim()).toBeUndefined();
  let cursor: number; const db = f.sql(); try {
    const row = db.prepare('SELECT reconcile_needed,reconcile_cursor_publication,requested_through,requested_publication_revision FROM companion_topic_compaction_jobs WHERE id=?').get(old.id) as
      { reconcile_needed: number; reconcile_cursor_publication: number; requested_through: number; requested_publication_revision: number };
    expect(row.reconcile_needed).toBe(1); expect(row.requested_through).toBe(queued.requestedThroughSequence); expect(row.requested_publication_revision).toBe(queued.requestedPublicationRevision);
    cursor = row.reconcile_cursor_publication; expect(cursor).toBeLessThan(queued.requestedPublicationRevision);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT key,value FROM metadata INDEXED BY companion_topic_publication_page WHERE key GLOB 'message-topic-publication/*' AND json_extract(value,'$.topicId')=? AND CAST(json_extract(value,'$.revision') AS INTEGER)<? ORDER BY CAST(json_extract(value,'$.revision') AS INTEGER) DESC LIMIT 32").all(f.scope.topicId, cursor) as Array<{ detail: string }>;
    expect(plan).toHaveLength(1); expect(plan[0]!.detail).toContain('SEARCH'); expect(plan[0]!.detail).not.toMatch(/SCAN|TEMP/u);
  } finally { db.close(); }
  f.restart(); expect(f.claim()).toBeUndefined(); const next = f.claim()!;
  expect(next).toMatchObject({ id: old.id, sourceMessageId: messages[0]!.id, requestedThroughSequence: queued.requestedThroughSequence,
    requestedPublicationRevision: queued.requestedPublicationRevision });
  expect(next.sourceMessageId).not.toBe(future.id); expect(next.leaseToken).not.toBe(old.leaseToken);
  expect(f.store.request({ type: 'topic.compaction.check', id: old.id, leaseToken: old.leaseToken! }).topicCompactionJob).toBeUndefined();
});

it('cancels an exhausted lawful range without pretending it completed or deleting original events', () => {
  const f = fixture(), a = f.source('原始A仍留在聊天中。'), c = f.source('原始C仍留在聊天中。'); const queued = f.enqueue(c.id), old = f.claim()!;
  f.forget([a.id, c.id]); expect(f.claim()).toBeUndefined();
  expect(f.inspect(old.id)).toMatchObject({ state: 'cancelled', failureCount: 0, cycleFailureCount: 0, attemptCount: 1 });
  const db = f.sql(); try { expect(db.prepare('SELECT checked_through,checked_publication_revision,requested_through,requested_publication_revision,reconcile_needed FROM companion_topic_compaction_jobs WHERE id=?').get(old.id))
    .toEqual({ checked_through: 0, checked_publication_revision: 0, requested_through: queued.requestedThroughSequence, requested_publication_revision: queued.requestedPublicationRevision, reconcile_needed: 0 }); } finally { db.close(); }
  expect(f.store.getMessage(a.id).content).toBe(a.content); expect(f.store.getMessage(c.id).content).toBe(c.content);
});

it('continues a clipped maintenance subwindow while rejecting a formally indexed source outside the claimed creation scope', () => {
  const f = fixture(), a = f.source('当前端口内的旧正式原文A。'), c = f.source('当前准确请求C。'), future = f.source('已发布但创建序号在当前端口之后的并行输入。');
  f.enqueue(c.id); const job = f.claim()!, checksum = createHash('sha256').update(c.content).digest('hex');
  const command = { type: 'topic.compaction.sources' as const, conversationId: f.scope.conversationId, topicId: f.scope.topicId, readerId: 'alice',
    jobGuard: { id: job.id, leaseToken: job.leaseToken! }, beforeSequence: job.claimedThroughSequence!,
    throughPublicationRevision: job.claimedPublicationRevision!, afterPublicationRevision: 0, legacyAfterSequence: 0, sourceMessageId: c.id, sourceChecksum: checksum, limit: 100 };
  const first = f.store.request(command).topicCompactionPage!;
  expect(first.items.map(item => item.message.id)).toEqual([a.id, c.id]); expect(first.throughPublicationRevision).toBeLessThan(job.claimedPublicationRevision!);
  const rest = f.store.request({ ...command, afterPublicationRevision: first.afterPublicationRevision, throughPublicationRevision: first.throughPublicationRevision,
    legacyAfterSequence: first.legacyScannedThroughSequence, legacyThroughSequence: first.legacyThroughSequence }).topicCompactionPage!;
  expect(rest.items).toEqual([]); expect(rest.hasMore).toBe(false);
  expect(f.store.request({ ...command, throughPublicationRevision: 0 }).topicCompactionPage?.items).toEqual([]);
  expect(() => f.store.request({ ...command, throughPublicationRevision: job.claimedPublicationRevision! + 1 })).toThrow('读取租约');
  expect(() => f.store.request({ ...command, beforeSequence: future.sequence })).toThrow('读取租约');
  expect(f.bind(job, [future.id]).topicCompactionJob).toBeUndefined();
  expect(f.bind(job, [a.id]).topicCompactionJob?.id).toBe(job.id); expect(f.store.getMessage(future.id).content).toBe(future.content);
});

it('holds restored dirty debt until explicit resume, then reselects a legal earlier anchor without reviving the old lease', () => {
  const f = fixture(), a = f.source('恢复后仍合法的原事件A。'), c = f.source('恢复前撤回的旧尾C。'); f.enqueue(c.id); const old = f.claim()!; f.forget([c.id]);
  const db = f.sql(); try { expect(() => assertRestoredCompanionWorkHeld(db, 'alice')).toThrow(); holdRestoredCompanionWork(db); expect(() => assertRestoredCompanionWorkHeld(db, 'alice')).not.toThrow(); } finally { db.close(); }
  expect(f.inspect(old.id)).toMatchObject({ state: 'parked', failureCount: 0, attemptCount: 1 });
  expect(() => f.store.setCompanionActive('alice', true)).toThrow('尚未核对');
  f.store.request({ type: 'recovery.review.complete', companionId: 'alice' });
  f.store.setCompanionActive('alice', true); expect(f.claim()).toBeUndefined();
  const held = f.inspect(old.id); f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'topic_compaction', id: held.id,
    inputVersion: held.inputVersion, expectedRevision: held.revision, operationId: randomUUID(), action: 'resume' });
  const next = f.claim()!; expect(next).toMatchObject({ id: old.id, sourceMessageId: a.id, attempts: 2 }); expect(next.leaseToken).not.toBe(old.leaseToken);
  expect(f.store.request({ type: 'topic.compaction.check', id: old.id, leaseToken: old.leaseToken! }).topicCompactionJob).toBeUndefined();
  expect(f.store.getMessage(a.id).content).toBe(a.content); expect(f.store.getMessage(c.id).content).toBe(c.content);
});

it.each(['park', 'abandon', 'unknown'] as const)('keeps %s held while ordinary source invalidation is reconciled elsewhere', action => {
  const f = fixture(), a = f.source('已读原文A。'), c = f.source('尾部请求C。'); f.enqueue(c.id); const old = f.claim()!; f.bind(old, [a.id]);
  if (action === 'unknown') f.store.request({ type: 'topic.compaction.fail', id: old.id, leaseToken: old.leaseToken!, failureKind: 'waiting', unknownOutcome: true, error: '结果未知。', retryAfterMs: 0 });
  else { const current = f.inspect(old.id); f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'topic_compaction', id: old.id, inputVersion: current.inputVersion,
    expectedRevision: current.revision, operationId: randomUUID(), action }); }
  f.forget([a.id]); const fresh = f.source('后来消息也不得自动解封人为搁置或未知结果。'); f.enqueue(fresh.id);
  for (let check = 0; check < 3; check++) { vi.setSystemTime(Date.now() + 6000); expect(f.claim()).toBeUndefined(); }
  expect(f.inspect(old.id)).toMatchObject({ state: action === 'abandon' ? 'abandoned' : 'parked', failureCount: 0, cycleFailureCount: 0 });
  const db = f.sql(); try { expect(db.prepare('SELECT reconcile_needed FROM companion_topic_compaction_jobs WHERE id=?').get(old.id)).toEqual({ reconcile_needed: 0 }); } finally { db.close(); }
});

it('moves eight paused dirty heads aside, serves the ninth and a healthy peer, then continues after an explicit topic resume', () => {
  const f = fixture(), entries = Array.from({ length: 9 }, (_, index) => {
    const topic = f.store.request({ type: 'topic.create', conversationId: f.scope.conversationId, readerId: 'user', title: '独立范围 ' + index, kind: 'discussion' }).topic!;
    const scope = { ...f.scope, topicId: topic.id }, a = f.source('仍合法的范围来源A ' + index, scope), c = f.source('将撤回的范围来源C ' + index, scope), job = f.enqueue(c.id, scope);
    return { topic, scope, a, c, job };
  });
  for (const item of entries.slice(0, 8)) expect(f.store.request({ type: 'topic.pause', conversationId: item.scope.conversationId, topicId: item.topic.id, readerId: 'alice', expectedRevision: item.topic.revision }).topic!.status).toBe('paused');
  f.forget(entries.map(item => item.c.id));
  const room = f.store.openPrivate('bob'), peerScope = { companionId: 'bob', conversationId: room.id, topicId: room.activeTopicId! }, peer = f.source('Bob当前合法独立原始事件。', peerScope), peerJob = f.enqueue(peer.id, peerScope);
  const first = f.claim()!; expect(first.id).toBe(peerJob.id); f.store.request({ type: 'topic.compaction.settle', id: first.id, leaseToken: first.leaseToken!, hasMore: false });
  const ninth = f.claim()!; expect(ninth.id).toBe(entries[8]!.job.id); expect(ninth.sourceMessageId).toBe(entries[8]!.a.id);
  f.store.request({ type: 'topic.compaction.settle', id: ninth.id, leaseToken: ninth.leaseToken!, hasMore: false });
  const paused = entries[0]!, current = f.store.request({ type: 'topic.read', conversationId: paused.scope.conversationId, topicId: paused.topic.id, readerId: 'alice' }).topic!;
  f.store.request({ type: 'topic.resume', conversationId: paused.scope.conversationId, topicId: paused.topic.id, readerId: 'alice', expectedRevision: current.revision });
  vi.setSystemTime(Date.now() + 5001); const resumed = f.claim()!;
  expect(resumed).toMatchObject({ id: paused.job.id, sourceMessageId: paused.a.id });
  expect(f.store.getMessage(peer.id).content).toBe(peer.content); expect(f.store.getMessage(paused.c.id).content).toBe(paused.c.content);
});
