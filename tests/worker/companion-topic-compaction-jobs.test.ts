import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionSourceAccess } from '../../src/companions/source-access';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
import { holdRestoredCompanionWork } from '../../src/companions/recovery-hold';

const stores = new Set<CompanionsStore>(), roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-28T12:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-topic-jobs-')) throw new Error('Unsafe topic job cleanup');
  rmSync(root, { recursive: true, force: true });
} vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-topic-jobs-')), file = path.join(root, 'messages.sqlite'); roots.push(root);
  const store = new CompanionsStore(file, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '保留真实来源。', model: '', avatar: 'sister' as const, active: true, proactive: false }))); stores.add(store);
  const room = store.openPrivate('alice'), topicId = room.activeTopicId!;
  const source = (content: string, roomId = room.id, topic = topicId) => store.appendMessage({ conversationId: roomId, topicId: topic, authorId: 'user', content, replyDirective: 'none' });
  const enqueue = (sourceMessageId: string, owner = 'alice', roomId = room.id, topic = topicId) => store.request({ type: 'topic.compaction.enqueue', companionId: owner, conversationId: roomId, topicId: topic, sourceMessageId });
  const claim = () => store.request({ type: 'topic.compaction.claim', excludedCompanionIds: [], leaseMs: 1000 }).topicCompactionJob!;
  const inspect = (id: string, owner = 'alice') => store.request({ type: 'jobs.inspect', ownerId: owner, kind: 'topic_compaction', id }).jobDisposition!;
  const sql = () => { const db = new (Database as { new(filename: string): CompanionConnection })(file);
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet); return db; };
  const bind = (job: ReturnType<typeof claim>, ids: string[], checkpointEventIds: string[] = []) => {
    const db = sql(); try { return store.request({ type: 'topic.compaction.bind', id: job.id, leaseToken: job.leaseToken!, checkpointEventIds,
      sources: ids.map(id => ({ id, revision: (db.prepare('SELECT revision FROM messages WHERE id=?').get(id) as { revision: number }).revision,
        checksum: createHash('sha256').update(store.getMessage(id).content).digest('hex') })) }); } finally { db.close(); }
  };
  return { root, file, store, room, topicId, source, enqueue, claim, inspect, sql, bind };
}

it('coalesces actual scope input while preserving an in-flight fixed horizon and rejects its late settlement', () => {
  const f = fixture(), first = f.source('第一条正式原事件。'), pending = f.enqueue(first.id).topicCompactionJob!;
  expect(companionStorageResponseSchema.parse({ ok: true, topicCompactionJob: pending }).topicCompactionJob).toEqual(pending);
  expect(f.enqueue(first.id).topicCompactionJob).toEqual(pending);
  const running = f.claim(); expect(running).toMatchObject({ id: pending.id, sourceMessageId: first.id, requestedThroughSequence: first.sequence, claimedThroughSequence: first.sequence, attempts: 1 });
  const second = f.source('在后台运行期间到来的独立事件。'), updated = f.enqueue(second.id).topicCompactionJob!;
  expect(updated.id).toBe(running.id); expect(updated).toMatchObject({ sourceMessageId: first.id, requestedThroughSequence: second.sequence, claimedThroughSequence: first.sequence });
  expect(f.store.request({ type: 'topic.compaction.check', id: running.id, leaseToken: running.leaseToken! }).topicCompactionJob?.sourceMessageId).toBe(first.id);
  const settled = f.store.request({ type: 'topic.compaction.settle', id: running.id, leaseToken: running.leaseToken!, hasMore: false }).topicCompactionJob!;
  expect(settled).toMatchObject({ status: 'pending', checkedThroughSequence: first.sequence, requestedThroughSequence: second.sequence });
  const next = f.claim(); expect(next).toMatchObject({ sourceMessageId: second.id, claimedThroughSequence: second.sequence, attempts: 2 });
  expect(() => f.store.request({ type: 'topic.compaction.settle', id: running.id, leaseToken: running.leaseToken!, hasMore: false })).toThrow('租约已失效');
  expect(f.store.request({ type: 'topic.compaction.settle', id: next.id, leaseToken: next.leaseToken!, hasMore: false }).topicCompactionJob).toMatchObject({ status: 'completed', checkedThroughSequence: second.sequence });
  const third = f.source('完成后新的真实来源仍继续登记，累计尝试不清零。');
  expect(f.enqueue(third.id).topicCompactionJob).toMatchObject({ id: next.id, status: 'pending', attempts: 2 });
  expect(f.store.getMessage(first.id).content).toBe(first.content);
});

it('renews only an exact live lease and parks unknown outcomes without inventing a processing failure', () => {
  const f = fixture(), first = f.source('真实原事件，不得因未知网络结果自动重发。'); f.enqueue(first.id); const job = f.claim();
  vi.setSystemTime(Date.now() + 500);
  expect(f.store.request({ type: 'topic.compaction.check', id: job.id, leaseToken: job.leaseToken!, extendLeaseMs: 10000 }).topicCompactionJob?.id).toBe(job.id);
  vi.setSystemTime(Date.now() + 1000); expect(f.store.request({ type: 'topic.compaction.check', id: job.id, leaseToken: job.leaseToken! }).topicCompactionJob?.id).toBe(job.id);
  f.store.request({ type: 'topic.compaction.fail', id: job.id, leaseToken: job.leaseToken!, error: '发送结果未知，待核对。', failureKind: 'waiting', unknownOutcome: true });
  const held = f.inspect(job.id); expect(held).toMatchObject({ state: 'parked', failureCount: 0, cycleFailureCount: 0, attemptCount: 1 });
  expect(f.store.request({ type: 'topic.compaction.check', id: job.id, leaseToken: job.leaseToken!, extendLeaseMs: 10000 }).topicCompactionJob).toBeUndefined();
  expect(f.inspect(job.id)).toEqual(held); expect(f.claim()).toBeUndefined();
});

it('records a late formal publication despite its older creation sequence and keeps the claimed publication horizon fixed', () => {
  const f = fixture(), basis = f.source('原始明确请求。');
  const draft = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topicId, authorId: 'alice', replyToId: basis.id, content: '', loopStep: 0 });
  const checkpoint = { companionId: 'alice', conversationId: f.room.id, sourceMessageId: basis.id, messageId: draft.id, status: 'running' as const, turns: [], supplements: [] };
  f.store.request({ type: 'loop.save', checkpoint });
  const newer = f.source('后来创建、先正式发布的真实消息。'); f.enqueue(newer.id); const running = f.claim();
  f.store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done', turns: [{ text: '较旧气泡现在才真正正式发布。', rawText: '较旧气泡现在才真正正式发布。', calls: [] }] } });
  expect(draft.sequence).toBeLessThan(newer.sequence);
  const queued = f.enqueue(draft.id).topicCompactionJob!;
  expect(queued.requestedThroughSequence).toBe(newer.sequence);
  expect(queued.requestedPublicationRevision).toBeGreaterThan(running.claimedPublicationRevision!);
  expect(queued.claimedPublicationRevision).toBe(running.claimedPublicationRevision);
  expect(queued.sourceMessageId).toBe(newer.id);
  const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice' });
  const formal = f.store.getMessage(draft.id);
  expect(() => f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice', expectedRevision: current.topic!.revision,
    maintenance: true, patch: { workingState: { summary: '旧租约不应偷带刚刚发布的新正文。', sourceMessageIds: [formal.id] } },
    compaction: { previousWorkingEventId: null, sharedEventId: null, sourceChecksums: { [formal.id]: createHash('sha256').update(formal.content).digest('hex') },
      jobGuard: { id: running.id, leaseToken: running.leaseToken! } } })).toThrow('发布租约已失效');
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice' }).topicState).toEqual(current.topicState);
  const settled = f.store.request({ type: 'topic.compaction.settle', id: running.id, leaseToken: running.leaseToken!, hasMore: false }).topicCompactionJob!;
  expect(settled.status).toBe('pending'); expect(settled.checkedPublicationRevision).toBe(running.claimedPublicationRevision);
  const next = f.claim(); expect(next.sourceMessageId).toBe(draft.id);
  expect(next.claimedPublicationRevision).toBe(queued.requestedPublicationRevision);
  expect(f.store.request({ type: 'topic.compaction.check', id: next.id, leaseToken: next.leaseToken! }).topicCompactionJob?.id).toBe(next.id);
});

it.each([false, true])('classifies an inactive owner exact lease as waiting or unknown without late dispatch, unknown=%s', unknown => {
  const f = fixture(), original = f.source('停止时仍应保留的真实原事件。'); f.enqueue(original.id); const job = f.claim();
  f.store.setCompanionActive('alice', false);
  expect(f.store.request({ type: 'topic.compaction.check', id: job.id, leaseToken: job.leaseToken!, extendLeaseMs: 10000 }).topicCompactionJob).toBeUndefined();
  f.store.request({ type: 'topic.compaction.fail', id: job.id, leaseToken: job.leaseToken!, failureKind: 'waiting', error: '当前停止，结果按实际派发状态核对。',
    ...(unknown ? { unknownOutcome: true } : {}), retryAfterMs: 0 });
  expect(f.inspect(job.id)).toMatchObject({ state: unknown ? 'parked' : 'pending', failureCount: 0, cycleFailureCount: 0, attemptCount: 1 });
  f.store.setCompanionActive('alice', true);
  if (unknown) expect(f.claim()).toBeUndefined();
  else expect(f.claim()).toMatchObject({ id: job.id, attempts: 2 });
  expect(f.store.getMessage(original.id).content).toBe(original.content);
});

it('commits a guarded lawful old chunk during a new publication while retaining unguarded, future and working-state CAS fences', () => {
  const f = fixture(), original = f.source('原租约内已经核验的原文。'); f.enqueue(original.id); const job = f.claim();
  const digest = createHash('sha256').update(original.content).digest('hex');
  const db = f.sql(); let originalPublication: number;
  try { originalPublication = JSON.parse((db.prepare('SELECT value FROM metadata WHERE key=?').get('message-topic-publication/' + original.id) as { value: string }).value).revision; } finally { db.close(); }
  const newer = f.source('整理过程中并发到来的新原文。'); f.enqueue(newer.id);
  const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice' });
  expect(current.topic!.formalPublicationRevision).toBeGreaterThan(job.claimedPublicationRevision!);
  const command = { type: 'topic.update' as const, conversationId: f.room.id, topicId: f.topicId, readerId: 'alice', expectedRevision: current.topic!.revision,
    maintenance: true, patch: { workingState: { summary: '只总结已经核验的旧消息块。', sourceMessageIds: [original.id], state: { __continuity: {
      topicId: f.topicId, companionId: 'alice', conversationId: f.room.id, throughSequence: original.sequence,
      sourceDigest: digest, compactedMessages: 1, createdAt: new Date().toISOString(), publicationCoverage: { publicationRevision: job.claimedPublicationRevision } } } } },
    compaction: { previousWorkingEventId: null, sharedEventId: null, sourceChecksums: { [original.id]: digest },
      publicationCoverage: { expectedFormalPublicationRevision: job.claimedPublicationRevision!, sourcePublicationRevisions: { [original.id]: originalPublication } } } };
  expect(() => f.store.request(command)).toThrow('正式发布在压缩期间已变化');
  expect(f.bind(job, [original.id]).topicCompactionJob?.id).toBe(job.id);
  const guarded = { ...command, compaction: { ...command.compaction, jobGuard: { id: job.id, leaseToken: job.leaseToken! } } };
  expect(() => f.store.request({ ...guarded, compaction: { ...guarded.compaction, publicationCoverage: { ...guarded.compaction.publicationCoverage,
    expectedFormalPublicationRevision: current.topic!.formalPublicationRevision! + 1 } } })).toThrow('正式发布在压缩期间已变化');
  const committed = f.store.request(guarded); expect(committed.topicState?.workingState?.summary).toBe(command.patch.workingState.summary);
  expect(committed.topicState?.workingState?.sourceMessageIds).toEqual([original.id]);
  expect(() => f.store.request({ ...guarded, expectedRevision: committed.topic!.revision })).toThrow('压缩依赖已经变化');
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice' }).topicState).toEqual(committed.topicState);
  const settled = f.store.request({ type: 'topic.compaction.settle', id: job.id, leaseToken: job.leaseToken!, checkpointEventId: committed.topicState!.workingState!.sourceEventId,
    hasMore: true }).topicCompactionJob!;
  expect(settled.status).toBe('pending'); expect(settled.checkedPublicationRevision).toBe(0);
  expect(f.store.getMessage(original.id).content).toBe(original.content); expect(f.store.getMessage(newer.id).content).toBe(newer.content);
});

it('yields a hot topic after one actual checkpoint so an independent owner can run before its next chunk', () => {
  const f = fixture(), original = f.source('Alice实际已核验的原消息。'); f.enqueue(original.id); const first = f.claim();
  const room = f.store.openPrivate('bob'), peer = f.source('Bob的小输入也必须获得处理机会。', room.id, room.activeTopicId!);
  const peerJob = f.enqueue(peer.id, 'bob', room.id, room.activeTopicId!).topicCompactionJob!;
  const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice' });
  const sourceChecksum = createHash('sha256').update(original.content).digest('hex');
  expect(f.bind(first, [original.id]).topicCompactionJob?.id).toBe(first.id);
  const committed = f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice', expectedRevision: current.topic!.revision,
    maintenance: true, patch: { workingState: { summary: '实际消息的受控检查点。', sourceMessageIds: [original.id], state: { __continuity: {
      topicId: f.topicId, companionId: 'alice', conversationId: f.room.id, throughSequence: original.sequence,
      sourceDigest: sourceChecksum, compactedMessages: 1, createdAt: new Date().toISOString() } } } },
    compaction: { previousWorkingEventId: current.topicState?.workingState?.sourceEventId ?? null, sharedEventId: current.topicState?.shared?.sourceEventId ?? null,
      sourceChecksums: { [original.id]: sourceChecksum }, jobGuard: { id: first.id, leaseToken: first.leaseToken! } } });
  const event = committed.topicState!.workingState!.sourceEventId;
  expect(f.store.request({ type: 'topic.compaction.settle', id: first.id, leaseToken: first.leaseToken!, hasMore: true, checkpointEventId: event }).topicCompactionJob?.status).toBe('pending');
  const next = f.claim(); expect(next.id).toBe(peerJob.id);
  f.store.request({ type: 'topic.compaction.settle', id: next.id, leaseToken: next.leaseToken!, hasMore: false });
  const resumed = f.claim(); expect(resumed.id).toBe(first.id); expect(resumed.attempts).toBe(2);
  expect(() => f.store.request({ type: 'topic.compaction.settle', id: resumed.id, leaseToken: resumed.leaseToken!, hasMore: true, checkpointEventId: event })).toThrow('没有新的正式进度');
});

it('rejects wrong owners, topics, drafts, fake progress and changed source bytes without deleting raw events', () => {
  const f = fixture(), actual = f.source('真实来源 ORIGINAL_TOPIC_JOB_CANARY'); f.enqueue(actual.id);
  const other = f.store.openPrivate('bob'), peer = f.source('仅Bob可读的真实来源。', other.id, other.activeTopicId!);
  expect(() => f.enqueue(peer.id)).toThrow('正式消息来源');
  expect(() => f.enqueue(actual.id, 'bob')).toThrow('不属于');
  const draft = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topicId, authorId: 'alice', content: '尚未正式发布的草稿。', loopStep: 0 });
  expect(() => f.enqueue(draft.id)).toThrow('正式消息来源');
  const job = f.claim();
  expect(() => f.store.request({ type: 'topic.compaction.settle', id: job.id, leaseToken: job.leaseToken!, hasMore: true })).toThrow('没有新的正式进度');
  expect(() => f.store.request({ type: 'topic.compaction.settle', id: job.id, leaseToken: job.leaseToken!, hasMore: true, checkpointEventId: 'invented_checkpoint' })).toThrow('检查点已经变化');
  const db = f.sql(); try { db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('外部已改变的新字节。', actual.id); } finally { db.close(); }
  expect(f.store.request({ type: 'topic.compaction.check', id: job.id, leaseToken: job.leaseToken! }).topicCompactionJob).toBeUndefined();
  expect(f.inspect(job.id)).toMatchObject({ state: 'stale', failureCount: 0 });
  expect(() => f.store.request({ type: 'topic.compaction.settle', id: job.id, leaseToken: job.leaseToken!, hasMore: false })).toThrow('租约已失效');
  expect(f.store.getMessage(actual.id).content).toBe('外部已改变的新字节。');
});

it('unions a reduced prefix within one lease and only replaces its inputs after old diagnostics have been cleared', () => {
  const f = fixture(), a = f.source('拆分前读到的A原文。'), b = f.source('拆分前读到的B原文。'), c = f.source('本次末尾准确请求C。');
  f.enqueue(c.id); const job = f.claim();
  expect(f.bind(job, [a.id, b.id]).topicCompactionJob?.id).toBe(job.id);
  expect(f.bind(job, [a.id]).topicCompactionJob?.id).toBe(job.id);
  const db = f.sql(); try {
    expect(db.prepare("SELECT COUNT(*) AS n FROM companion_job_input_refs WHERE kind='topic_compaction' AND job_id=? AND input_kind='source'").get(job.id)).toEqual({ n: 2 });
  } finally { db.close(); }
  f.store.request({ type: 'topic.compaction.fail', id: job.id, leaseToken: job.leaseToken!, failureKind: 'processing', error: b.content, retryAfterMs: 0 });
  const retry = f.claim(); expect(retry.attempts).toBe(2); expect(f.inspect(job.id)).not.toHaveProperty('lastError');
  expect(f.bind(retry, [a.id]).topicCompactionJob?.id).toBe(retry.id);
  const audit = f.sql(); try {
    expect(audit.prepare("SELECT input_id FROM companion_job_input_refs WHERE kind='topic_compaction' AND job_id=? AND input_kind='source'").all(job.id)).toEqual([{ input_id: a.id }]);
  } finally { audit.close(); }
  expect(f.inspect(job.id)).toMatchObject({ failureCount: 1, cycleFailureCount: 1 });
  expect(f.store.getMessage(b.id).content).toBe(b.content);
});

it('validates only each new checkpoint node once and fences an ACL epoch without flattening history into a job', () => {
  const f = fixture(); let original = f.source('第一块实际原文。'); f.enqueue(original.id); let job = f.claim(), previous: string | undefined;
  for (let step = 0; step < 10; step++) {
    expect(f.bind(job, [original.id], previous ? [previous] : []).topicCompactionJob?.id).toBe(job.id);
    const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice' });
    const digest = createHash('sha256').update(original.content).digest('hex');
    const committed = f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topicId, readerId: 'alice', expectedRevision: current.topic!.revision,
      maintenance: true, patch: { workingState: { summary: '真实有限块 ' + step, sourceMessageIds: [original.id], state: { __continuity: {
        topicId: f.topicId, companionId: 'alice', conversationId: f.room.id, throughSequence: original.sequence,
        sourceDigest: digest, compactedMessages: 1, createdAt: new Date().toISOString() } } } },
      compaction: { previousWorkingEventId: previous ?? null, sharedEventId: null, sourceChecksums: { [original.id]: digest }, jobGuard: { id: job.id, leaseToken: job.leaseToken! } } });
    previous = committed.topicState!.workingState!.sourceEventId;
    f.store.request({ type: 'topic.compaction.settle', id: job.id, leaseToken: job.leaseToken!, hasMore: true, checkpointEventId: previous });
    original = f.source('后续真实有限块 ' + step); f.enqueue(original.id); job = f.claim();
  }
  const validation = vi.spyOn(CompanionSourceAccess.prototype, 'checkpointSourcesValid');
  expect(f.bind(job, [original.id], [previous!]).topicCompactionJob?.id).toBe(job.id);
  expect(validation.mock.calls).toHaveLength(1); expect(validation.mock.calls[0]![1]).toHaveLength(1);
  validation.mockClear();
  for (let check = 0; check < 3; check++) expect(f.store.request({ type: 'topic.compaction.check', id: job.id, leaseToken: job.leaseToken! }).topicCompactionJob?.id).toBe(job.id);
  expect(validation).not.toHaveBeenCalled();
  const db = f.sql(); try {
    expect(db.prepare("SELECT COUNT(*) AS n FROM companion_job_input_refs WHERE kind='topic_compaction' AND job_id=?").get(job.id)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_topic_checkpoint_nodes').get()).toEqual({ n: 10 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_topic_checkpoint_sources').get()).toEqual({ n: 10 });
  } finally { db.close(); }
  // The rule does not match these bytes. Even so, the old ACL receipt cannot
  // silently authorize a frame after a host policy revision.
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, tag: '未出现在这些原文中的禁记主题', persistent: true });
  expect(f.store.request({ type: 'topic.compaction.check', id: job.id, leaseToken: job.leaseToken! }).topicCompactionJob).toBeUndefined();
  expect(f.inspect(job.id)).toMatchObject({ state: 'stale', failureCount: 0 });
  expect(f.enqueue(original.id).topicCompactionJob?.status).toBe('pending');
  const fresh = f.claim(); expect(f.bind(fresh, [original.id], [previous!]).topicCompactionJob?.id).toBe(fresh.id);
});

it('keyset-pages 131 held scopes through indexes and fences recovery and retirement without touching a peer', async () => {
  const f = fixture(), ids: string[] = [];
  for (let index = 0; index < 131; index++) {
    const topic = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'user', title: '受控独立话题 ' + index, kind: 'discussion' }).topic!;
    const message = f.source('本话题的真实原始消息 ' + index, f.room.id, topic.id), created = f.enqueue(message.id, 'alice', f.room.id, topic.id).topicCompactionJob!;
    const before = f.inspect(created.id);
    f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'topic_compaction', id: before.id, inputVersion: before.inputVersion, expectedRevision: before.revision, operationId: randomUUID(), action: 'park' }); ids.push(before.id);
  }
  const seen: string[] = []; let afterId: string | undefined;
  for (;;) { const page = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'topic_compaction', states: ['parked'], afterId, limit: 50 }).jobPage!;
    seen.push(...page.items.map(item => item.id)); if (!page.hasMore) break; afterId = page.nextId; }
  expect(seen).toEqual(ids.sort());
  const room = f.store.openPrivate('bob'), peer = f.source('Bob合法独立原事件。', room.id, room.activeTopicId!);
  const peerJob = f.enqueue(peer.id, 'bob', room.id, room.activeTopicId!).topicCompactionJob!, running = f.claim(); expect(running.id).toBe(peerJob.id);
  f.store.request({ type: 'topic.compaction.settle', id: running.id, leaseToken: running.leaseToken!, hasMore: false });
  const db = f.sql(); try {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM companion_topic_compaction_jobs INDEXED BY companion_topic_compaction_jobs_control_state_page WHERE companion_id=? AND status=? AND id>? ORDER BY id LIMIT 51").all('alice', 'parked', '') as Array<{ detail: string }>;
    expect(plan).toHaveLength(1); expect(plan[0]!.detail).toContain('SEARCH'); expect(plan[0]!.detail).not.toMatch(/SCAN|TEMP/u);
    const before = f.inspect(ids[0]!).revision; holdRestoredCompanionWork(db); expect(f.inspect(ids[0]!).revision).toBeGreaterThan(before);
  } finally { db.close(); }
  const peerBefore = f.inspect(peerJob.id, 'bob');
  const retire = f.store.request({ type: 'companion.retire', id: 'alice', scope: 'all' }).reset!;
  f.store.request({ type: 'companion.retire.cleanup', id: 'alice', jobId: retire.id });
  for (let index = 0; index < 1000 && f.store.request({ type: 'companion.retire.status', id: 'alice' }).reset?.status !== 'completed'; index++) await f.store.advanceReset();
  const audit = f.sql(); try { expect(audit.prepare('SELECT 1 FROM companion_topic_compaction_jobs WHERE companion_id=?').get('alice')).toBeUndefined(); } finally { audit.close(); }
  expect(f.inspect(peerJob.id, 'bob')).toEqual(peerBefore); expect(f.store.getMessage(peer.id).content).toBe(peer.content);
}, 60000);
