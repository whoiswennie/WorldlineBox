import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import BetterSqlite3 from 'better-sqlite3';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryConsolidationStore } from '../../src/companions/memory-consolidation-store';

let root: string, store: CompanionsStore, scope: { companionId: string; conversationId: string };
const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真', model: '', avatar: 'sister' as const, proactive: false, active: true }));
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-consolidation-')); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
});
afterEach(() => {
  store.close(); const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-consolidation-')) throw new Error('Invalid cleanup');
  rmSync(resolved, { recursive: true, force: true });
});
const candidate = (source: CompanionMessage, content = source.content): CompanionMemoryCandidate => ({ content, tags: ['有条件认识'],
  sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] });
function note(content: string, room = scope.conversationId) {
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content, replyDirective: 'none' });
  const memory = store.request({ type: 'memory.record', companionId: scope.companionId, conversationId: room, candidate: candidate(source) }).memories![0]!;
  return { source, memory };
}
function index() {
  for (let count = 0; count < 100; count++) {
    const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (job) store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
  }
}
const read = (id: string) => store.request({ type: 'memory.read', ...scope, id }).memoryRead!.memory;
const active = () => store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes;
const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
function fullMerge(items: Array<ReturnType<typeof note>>, operationId: string, content = items.map(item => item.source.content).join('\n')) {
  return store.request({ type: 'memory.consolidate', ...scope, operationId,
    inputs: items.map(item => ({ id: item.memory.id, version: read(item.memory.id).version })),
    candidate: { content, tags: ['合成整合'], sourceMessageIds: [...new Set(items.map(item => item.source.id))],
      evidence: items.map(item => ({ sourceMessageId: item.source.id, quote: item.source.content })) } }).memories?.[0];
}
function consolidate(inputs: CompanionMemory[], source: CompanionMessage, operationId = 'merge_one') {
  return store.request({ type: 'memory.consolidate', ...scope, operationId, inputs: inputs.map(note => ({ id: note.id, version: note.version })),
    candidate: candidate(source, '昨日不适合运动；今天只是天气允许时可以散步，并非保证总能出门。') }).memories![0]!;
}
it('publishes the new index before archiving originals, preserves evidence versions and survives restart', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步，并非保证总能出门。'); index();
  const merged = consolidate([read(a.memory.id), read(b.memory.id)], a.source);
  expect(active().map(note => note.id).sort()).toEqual([a.memory.id, b.memory.id].sort());
  expect(read(a.memory.id).archivedAt).toBeUndefined(); index();
  expect(active().map(note => note.id)).toEqual([merged.id]);
  expect(read(a.memory.id)).toMatchObject({ version: 1, supersededBy: merged.id, status: 'indexed', content: a.source.content });
  expect(consolidate([a.memory, b.memory], a.source).id).toBe(merged.id);
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  expect(active().map(note => note.id)).toEqual([merged.id]); expect(read(b.memory.id).sources[0]?.messageId).toBe(b.source.id);
});
it('resumes a complete new pending plan after restart using its original body receipts while allowing annotation changes', () => {
  const a = note('A 尚未合并发布的实际来源。'), b = note('B 仍需保留的条件。'); index();
  const merged = fullMerge([a, b], 'new_pending_restart')!;
  store.request({ type: 'memory.organize', ...scope, ids: [a.memory.id], tags: ['仅调整标签'] });
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  expect(read(a.memory.id).archivedAt).toBeUndefined(); expect(read(b.memory.id).archivedAt).toBeUndefined();
  index();
  expect(active().map(note => note.id)).toEqual([merged.id]);
  expect(read(a.memory.id)).toMatchObject({ content: a.source.content, contentRevision: a.memory.contentRevision, supersededBy: merged.id, tags: ['仅调整标签'] });
  expect(read(b.memory.id).supersededBy).toBe(merged.id);
  const changes = store.request({ type: 'memory.lifecycle.changes', companionId: 'alice' }).memoryLifecycleChanges!.changes;
  for (const original of [a, b]) expect(changes.find(change => change.noteId === original.memory.id && change.kind === 'archive'))
    .toMatchObject({ causeEventId: 'consolidation-publish/' + merged.id, cause: { operation: 'archive', planId: merged.id, noteIds: [original.memory.id] },
      changeKind: 'archive', evidenceDelta: { newSourceVersions: [] } });
});
it('withdraws the derivative when a source reached only through the dependency graph is forgotten', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步。'); index();
  const merged = consolidate([read(a.memory.id), read(b.memory.id)], a.source); index();
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [b.source.id] });
  expect(() => read(merged.id)).toThrow();
  expect(active().map(note => note.id)).toEqual([a.memory.id]);
});
it.each(['A', 'B'] as const)('preserves the other original after source-only forget %s invalidates a merge carrying both sources and an expired archive outbox', forgottenSide => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步，并非保证总能出门。'); index();
  const forgotten = forgottenSide === 'A' ? a : b, survivor = forgottenSide === 'A' ? b : a;
  const merged = store.request({ type: 'memory.consolidate', ...scope, operationId: 'merge_complete_sources',
    inputs: [read(a.memory.id), read(b.memory.id)].map(memory => ({ id: memory.id, version: memory.version })),
    candidate: { content: `${a.source.content}${b.source.content}`, tags: ['有条件认识'], sourceMessageIds: [a.source.id, b.source.id],
      evidence: [a.source, b.source].map(source => ({ sourceMessageId: source.id, quote: source.content })) } }).memories![0]!;
  expect(merged.sources.map(source => source.messageId).sort()).toEqual([a.source.id, b.source.id].sort());
  const publish = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  expect(publish).toMatchObject({ operation: 'remember', noteId: merged.id });
  store.request({ type: 'memory.outbox.complete', id: publish.id, leaseToken: publish.leaseToken, indexed: true });
  expect(active().map(memory => memory.id)).toEqual([merged.id]);
  expect(read(survivor.memory.id).archivedAt).toBeDefined();
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    let staleArchive: NonNullable<ReturnType<CompanionsStore['request']>['memoryOutbox']> | undefined;
    for (let count = 0; count < 2; count++) {
      const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
      expect(job?.operation).toBe('forget');
      if (job?.noteId === survivor.memory.id) { staleArchive = job; break; }
      store.request({ type: 'memory.outbox.complete', id: job!.id, leaseToken: job!.leaseToken, indexed: true });
    }
    expect(staleArchive).toMatchObject({ operation: 'forget', noteId: survivor.memory.id, noteVersion: 1 });
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [forgotten.source.id] });
    expect(() => read(forgotten.memory.id)).toThrow(); expect(() => read(merged.id)).toThrow();
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [forgotten.source.id] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [survivor.source.id] }).memorySources).toEqual([survivor.source]);
    expect(read(survivor.memory.id)).toMatchObject({ content: survivor.source.content, sources: [expect.objectContaining({ messageId: survivor.source.id })] });
    expect(read(survivor.memory.id).archivedAt).toBeUndefined();
    clock.mockReturnValue(now + 120001);
    const dispatched: Array<{ id: string; noteId: string; operation: string }> = [];
    for (let count = 0; count < 100; count++) {
      const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
      if (!job) continue;
      dispatched.push({ id: job.id, noteId: job.noteId, operation: job.operation });
      store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
    }
    expect(dispatched.some(job => job.noteId === survivor.memory.id && job.operation === 'remember')).toBe(true);
    expect(dispatched.some(job => job.id === staleArchive!.id || job.noteId === survivor.memory.id && job.operation === 'forget')).toBe(false);
    expect(active().map(memory => memory.id)).toEqual([survivor.memory.id]);
    expect(read(survivor.memory.id)).toMatchObject({ content: survivor.source.content, status: 'indexed' });
    store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds); index();
    expect(active().map(memory => memory.id)).toEqual([survivor.memory.id]);
    expect(read(survivor.memory.id)).toMatchObject({ content: survivor.source.content, status: 'indexed' });
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [survivor.source.id] }).memorySources).toEqual([survivor.source]);
    expect(() => read(forgotten.memory.id)).toThrow(); expect(() => read(merged.id)).toThrow();
  } finally { clock.mockRestore(); }
});
it('does not resurrect omitted parent evidence when the merged entry itself is forgotten', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步。'); index();
  const merged = consolidate([read(a.memory.id), read(b.memory.id)], a.source); index();
  store.request({ type: 'memory.forget', ...scope, id: merged.id }); index();
  expect(active()).toEqual([]);
  expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [a.source.id, b.source.id] }).memorySources).toEqual([]);
});
it('restores still-valid originals after a correction invalidates the merge, with no stale archive-removal delivery', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步。'); index();
  const merged = consolidate([read(a.memory.id), read(b.memory.id)], a.source); index();
  const corrected = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '更正：昨日只是不适合高强度运动。', replyDirective: 'none' });
  store.request({ type: 'memory.revise', ...scope, id: a.memory.id, expectedVersion: 1, candidate: candidate(corrected) });
  expect(() => read(merged.id)).toThrow(); index();
  expect(active().map(note => note.id).sort()).toEqual([a.memory.id, b.memory.id].sort());
  expect(read(b.memory.id).archivedAt).toBeUndefined(); expect(read(a.memory.id).version).toBe(2);
});
it('rejects stale versions and merging different visibility domains before creating a derivative', () => {
  const a = note('私人认识。'); const group = store.createConversation('公开讨论', ['alice', 'bob']); const b = note('群内认识。', group.id); index();
  expect(() => consolidate([{ ...a.memory, version: 99 }, b.memory], a.source)).toThrow('准确记忆版本');
  expect(() => consolidate([read(a.memory.id), read(b.memory.id)], a.source)).toThrow('不同来源可见域');
  expect(active()).toHaveLength(2);
});
it('classifies a real requested merge without allowing free metadata to claim it was an automatic sleep job', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步。'); index();
  const existing = store.request({ type: 'memory.record', ...scope, candidate: { ...candidate(a.source, '昨日不适合运动，今天只在天气允许时散步。'),
    relatedMemoryIds: [a.memory.id, b.memory.id], metadata: { customLabel: '保留来源条件' } } }).memories![0]!;
  expect(existing.metadata?.consolidation).toBeUndefined();
  const merged = store.request({ type: 'memory.consolidate', ...scope, operationId: 'honest_merge', inputs: [a.memory, b.memory].map(note => ({ id: note.id, version: note.version })),
    candidate: { ...candidate(a.source, '昨日不适合运动，今天只在天气允许时散步。'),
      metadata: { consolidation: false, automaticConsolidation: true, sleepReflection: true, sleepWorldJobId: 'fake_job', worldJobId: 'fake_job', sleepEpisodeId: 'fake_episode', customLabel: '保留来源条件' } } }).memories![0]!;
  expect(merged.id).toBe(existing.id);
  expect(merged.metadata).toMatchObject({ consolidation: 'source_version_graph', customLabel: '保留来源条件' });
  for (const key of ['automaticConsolidation', 'sleepReflection', 'sleepWorldJobId', 'worldJobId', 'sleepEpisodeId']) expect(merged.metadata?.[key]).toBeUndefined();
  index(); expect(active().map(note => note.id)).toEqual([merged.id]); expect(read(a.memory.id).archivedAt).toBeDefined();
});

it('defers overlapping pending plans, keeps operation receipts idempotent, and makes progress despite unrelated continuous writers', () => {
  const a = note('A 原文。'), b = note('B 原文。'), c = note('C 原文。'), d = note('D 原文。'); index();
  const first = fullMerge([a, b], 'first_pending')!;
  expect(fullMerge([a, b], 'first_pending')?.id).toBe(first.id);
  expect(fullMerge([a, b], 'different_semantics', '另一份尚未获准的新语义整合。')).toBeUndefined();
  expect(fullMerge([a, c], 'partial_overlap')).toBeUndefined();
  const independent = fullMerge([c, d], 'independent_pending')!;
  const added = Array.from({ length: 20 }, (_, index) => note(`持续写入的无关日志 ${index}。`));
  index();
  expect(read(a.memory.id).supersededBy).toBe(first.id); expect(read(b.memory.id).supersededBy).toBe(first.id);
  expect(read(c.memory.id).supersededBy).toBe(independent.id); expect(read(d.memory.id).supersededBy).toBe(independent.id);
  expect(active().map(note => note.id).sort()).toEqual([first.id, independent.id, ...added.map(item => item.memory.id)].sort());
  expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.failed).toBe(0);
});

it('reserves original sources across distinct note ids and releases the pending conflict after publication', () => {
  const a = note('共享的真实来源。'), b = note('另一条来源。'), c = note('新增的独立来源。');
  const alias = store.request({ type: 'memory.record', ...scope, candidate: candidate(a.source, '根据同一真实来源形成的另一份有据记录。') }).memories![0]!;
  index();
  const first = fullMerge([a, b], 'source_reservation')!;
  const aliasItem = { source: a.source, memory: alias };
  expect(fullMerge([aliasItem, c], 'source_overlap')).toBeUndefined();
  index();
  const next = fullMerge([aliasItem, c], 'source_overlap_after_publish')!;
  expect(next).toBeDefined(); index();
  expect(active().map(note => note.id).sort()).toEqual([first.id, next.id].sort());
});

it('does not reconstruct or publish a persisted plan missing its original body-version receipts after restart', () => {
  const a = note('A 原始事实。'), b = note('B 原始事实。'); index();
  const merged = fullMerge([a, b], 'incomplete_persisted_plan')!;
  const db = new Database(path.join(root, 'state.sqlite'));
  let unsupported: string;
  try {
    db.prepare("UPDATE metadata SET value=json_remove(value,'$.mergedVersion','$.mergedContentRevision','$.inputs[0].contentRevision') WHERE key=?").run('memory-consolidation/' + merged.id);
    unsupported = (db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-consolidation/' + merged.id) as { value: string }).value;
  } finally { db.close(); }
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  const dispatch = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  expect(() => store.request({ type: 'memory.outbox.complete', id: dispatch.id, leaseToken: dispatch.leaseToken, indexed: true })).toThrow('完整正文版本');
  expect(read(a.memory.id).archivedAt).toBeUndefined(); expect(read(b.memory.id).archivedAt).toBeUndefined();
  const check = new Database(path.join(root, 'state.sqlite'));
  try { expect((check.prepare('SELECT value FROM metadata WHERE key=?').get('memory-consolidation/' + merged.id) as { value: string }).value).toBe(unsupported); }
  finally { check.close(); }
});

it('retires an invalid current read set and accepts a newly generated plan from the current corrected sources', () => {
  const a = note('A 待更正原文。'), b = note('B 当前仍有效的原文。'); index();
  const obsolete = fullMerge([a, b], 'before_correction')!;
  const corrected = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'A 明确更正后的当前原文。', replyDirective: 'none' });
  store.request({ type: 'memory.revise', ...scope, id: a.memory.id, expectedVersion: 1, candidate: candidate(corrected) }); index();
  expect(() => read(obsolete.id)).toThrow(); expect(read(b.memory.id).archivedAt).toBeUndefined();
  const replacement = fullMerge([{ source: corrected, memory: read(a.memory.id) }, b], 'after_correction')!; index();
  expect(active().map(note => note.id)).toEqual([replacement.id]);
  expect(read(replacement.id).sources.map(source => source.messageId).sort()).toEqual([corrected.id, b.source.id].sort());
  expect(store.request({ type: 'memory.processing.status', companionId: 'alice', limit: 30 }).memoryProcessing!.summary.failed).toBe(0);
});

it('safely finalizes a running delivery whose real source was withdrawn, without archiving surviving originals', () => {
  const a = note('A 可撤回来源。'), b = note('B 不受影响的来源。'); index();
  const merged = fullMerge([a, b], 'withdraw_during_delivery')!;
  const dispatch = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  expect(dispatch.noteId).toBe(merged.id);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.source.id] });
  expect(store.request({ type: 'memory.outbox.complete', id: dispatch.id, leaseToken: dispatch.leaseToken, indexed: true }).memoryOutboxDisposition?.state).toBe('stale');
  index(); expect(active().map(note => note.id)).toEqual([b.memory.id]); expect(read(b.memory.id).archivedAt).toBeUndefined();
});

it('keeps real native failures retryable while source-snapshot deferrals do not consume the failure budget', () => {
  const a = note('A 有效来源。'), b = note('B 有效来源。'); index();
  const merged = fullMerge([a, b], 'transient_delivery')!;
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const first = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
    store.request({ type: 'memory.outbox.defer', id: first.id, leaseToken: first.leaseToken, retryAfterMs: 1000 });
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.failed).toBe(0);
    expect(store.request({ type: 'memory.outbox.claim' }).memoryOutbox).toBeUndefined();
    now += 1001; const second = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
    expect(second).toMatchObject({ id: first.id, attempts: 1 });
    store.request({ type: 'memory.outbox.fail', id: second.id, leaseToken: second.leaseToken, error: '真实编码服务故障', retryAfterMs: 0 });
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.failed).toBe(1);
    const third = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
    expect(third).toMatchObject({ id: first.id, attempts: 2 });
    store.request({ type: 'memory.outbox.complete', id: third.id, leaseToken: third.leaseToken, indexed: true }); index();
    expect(active().map(note => note.id)).toEqual([merged.id]);
  } finally { clock.mockRestore(); }
});

it('preserves a separately revised candidate and its new delivery while retiring the earlier archive plan', () => {
  const a = note('A 保留的原始事实。'), b = note('B 保留的原始事实。'); index();
  const merged = fullMerge([a, b], 'candidate_before_revision')!;
  const delivery = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  expect(delivery.noteId).toBe(merged.id);
  const correction = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '独立校订后的候选正文与新出处。', replyDirective: 'none' });
  const revised = store.request({ type: 'memory.revise', ...scope, id: merged.id, expectedVersion: 1, candidate: candidate(correction) }).memories![0]!;
  expect(revised.version).toBe(2);
  expect(store.request({ type: 'memory.outbox.complete', id: delivery.id, leaseToken: delivery.leaseToken, indexed: true }).memoryOutboxDisposition?.state).toBe('stale');
  index();
  expect(read(merged.id)).toMatchObject({ content: correction.content, version: 2, status: 'indexed' });
  expect(read(merged.id).archivedAt).toBeUndefined();
  expect(read(a.memory.id).archivedAt).toBeUndefined(); expect(read(b.memory.id).archivedAt).toBeUndefined();
  expect(active().map(note => note.id).sort()).toEqual([a.memory.id, b.memory.id, merged.id].sort());
  const jobs = store.request({ type: 'memory.processing.status', companionId: 'alice', limit: 30 }).memoryProcessing!.jobs;
  expect(jobs.find(job => job.noteId === merged.id && job.sourceRevision === '2' && job.title === '建立记忆索引')?.status).toBe('completed');
});

it('replays a deferred operation receipt with the same explicit fresh-read requirement and rejects semantic identity reuse', () => {
  const a = note('A 固定来源。'), b = note('B 固定来源。'), c = note('C 固定来源。'); index();
  fullMerge([a, b], 'occupying_plan');
  const command = { type: 'memory.consolidate' as const, ...scope, operationId: 'deferred_identity',
    inputs: [a.memory, c.memory].map(note => ({ id: note.id, version: note.version })),
    candidate: { content: `${a.source.content}\n${c.source.content}`, tags: [], sourceMessageIds: [a.source.id, c.source.id],
      evidence: [a.source, c.source].map(source => ({ sourceMessageId: source.id, quote: source.content })) } };
  const first = store.request(command), replayed = store.request(command);
  expect(first.memoryConsolidationDeferred).toMatchObject({ requiresFreshReadSet: true });
  expect(replayed.memoryConsolidationDeferred).toEqual(first.memoryConsolidationDeferred);
  expect(first.memories).toEqual([]); expect(replayed.memories).toEqual([]);
  expect(() => store.request({ ...command, candidate: { ...command.candidate, content: '使用同一操作号提交另一种语义正文。' } })).toThrow('不同请求');
});

it('retires a missing current candidate without retrying its outbox or archiving its original sources', () => {
  const a = note('A 仍在的原文。'), b = note('B 仍在的原文。'); index();
  const merged = fullMerge([a, b], 'missing_current_candidate')!;
  const db = new Database(path.join(root, 'state.sqlite'));
  try { db.prepare('DELETE FROM vcp_memory_notes WHERE id=?').run(merged.id); } finally { db.close(); }
  expect(() => index()).not.toThrow();
  expect(active().map(note => note.id).sort()).toEqual([a.memory.id, b.memory.id].sort());
  expect(read(a.memory.id).archivedAt).toBeUndefined(); expect(read(b.memory.id).archivedAt).toBeUndefined();
  const jobs = store.request({ type: 'memory.processing.status', companionId: 'alice', limit: 30 }).memoryProcessing!.jobs;
  expect(jobs.find(job => job.noteId === merged.id && job.status === 'stale')?.error).toContain('候选已经不存在');
});

it('bounds each indexed recovery pass and eventually reaches old pending plans behind more than one batch', () => {
  const db = new Database(':memory:'), template = note('受控来源模板。').memory;
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE vcp_memory_outbox(note_id TEXT,operation TEXT,status TEXT,error TEXT,lease_token TEXT,lease_until INTEGER,note_version INTEGER);`);
  const notes = new Map<string, CompanionMemory>(), loads: string[] = [];
  const recovery = new CompanionMemoryConsolidationStore(db, {
    load: id => { loads.push(id); const value = notes.get(id); if (!value) throw Error('missing'); return { ...value }; },
    valid: () => true, persist: note => { notes.set(note.id, note); }, enqueue: vi.fn(), invalidate: vi.fn(), withdraw: vi.fn(), record: () => undefined,
  });
  try {
    // Ordinary metadata does not have to be JSON and is excluded by the index.
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('ordinary-setting', 'plain text'); recovery.initialize();
    for (let index = 0; index < 40; index++) {
      const mergedId = 'pending_' + String(index).padStart(2, '0'), sourceId = 'source_' + index, secondId = 'second_source_' + index;
      notes.set(mergedId, { ...template, id: mergedId });
      notes.set(sourceId, { ...template, id: sourceId, ...(index === 39 ? { archivedAt: '2026-10-26T00:00:00Z', supersededBy: 'published_winner' } : {}) });
      notes.set(secondId, { ...template, id: secondId });
      db.prepare('INSERT INTO metadata VALUES(?,?)').run('memory-consolidation/' + mergedId, JSON.stringify({ companionId: 'alice', mergedId,
        mergedVersion: 1, mergedContentRevision: template.contentRevision, state: 'pending',
        inputs: [{ id: sourceId, version: 1, contentRevision: template.contentRevision }, { id: secondId, version: 1, contentRevision: template.contentRevision }] }));
    }
    for (let batch = 0; batch < 9; batch++) { const before = loads.length; expect(recovery.reconcilePending(4)).toBe(0); expect(loads.length - before).toBe(12); }
    const before = loads.length; expect(recovery.reconcilePending(4)).toBe(1); expect(loads.length - before).toBe(12);
    const retired = db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-consolidation/pending_39') as { value: string };
    expect(JSON.parse(retired.value)).toMatchObject({ state: 'stale', staleReason: expect.stringContaining('另一项有效整合') });
    expect(notes.get('source_39')?.supersededBy).toBe('published_winner');
  } finally { db.close(); }
});
