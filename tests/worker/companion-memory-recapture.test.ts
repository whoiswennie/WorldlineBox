import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMemoryCandidate, CompanionMemoryJob } from '../../src/shared/companion-memory';
import type { CompanionMessage } from '../../src/shared/companions';

const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '核验真实来源', model: '', avatar: 'sister' as const, active: true, proactive: false }));
let root: string, file: string, store: CompanionsStore, scope: { companionId: string; conversationId: string };
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'companion-recapture-')); file = path.join(root, 'state.sqlite'); store = new CompanionsStore(file, seeds); scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }; });
afterEach(() => { vi.useRealTimers(); store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-recapture-')) throw Error('Unsafe owned recapture fixture'); removeOwnedDirectorySync(root); });
function sql<T>(run: (db: CompanionConnection) => T): T { const db = new (Database as { new(file: string): CompanionConnection })(file); try { return run(db); } finally { db.close(); } }
const intents = () => sql(db => db.prepare("SELECT key,value FROM metadata WHERE key GLOB 'vcp-capture-reconsideration/*'").all()) as Array<{ key: string; value: string }>;
const source = (content: string) => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' });
const draft = (message: CompanionMessage, relatedMemoryIds: string[] = []): CompanionMemoryCandidate => ({ content: message.content, tags: ['原始事实'], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }], relatedMemoryIds });
const claim = () => store.request({ type: 'memory.jobs.claim', companionId: scope.companionId }).memoryJob;
const complete = (job: CompanionMemoryJob, notes: CompanionMemoryCandidate[]) => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: notes.map(note => ({ ...note, sourceChecksums: job.sourceChecksums })) }).memories!;
function indexed() { const receipts = []; for (let n = 0; n < 100; n++) { const outbox = store.request({ type: 'memory.outbox.claim', companionId: scope.companionId }).memoryOutbox; if (!outbox) return receipts; receipts.push(outbox); store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); } throw Error('Unbounded actual outbox'); }
function originals(derivedReply = false) {
  const a = source('A：保留蓝色封皮。'), parent = complete(claim()!, [draft(a)])[0]!; indexed();
  const b = derivedReply ? store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', replyToId: a.id, content: 'B：米色棉线在第二层抽屉。' }) : source('B：米色棉线在第二层抽屉。');
  const oldJob = claim()!, mixed = complete(oldJob, [{ ...draft(b, [parent.id]), content: b.content + ' 此前约定保留蓝色封皮。' }])[0]!; indexed();
  return { a, b, parent, mixed, oldJob };
}
const visible = (id: string) => store.request({ type: 'memory.sources.filter', ...scope, ids: [id] }).memorySources!;

it('durably requeues only the still-authorized original B after A is forgotten and restores clean B through normal capture/outbox', () => {
  const { a, b, mixed, oldJob } = originals();
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(visible(b.id).map(value => value.id)).toEqual([b.id]);
  expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes.some(note => note.id === mixed.id)).toBe(false);
  store.close(); store = new CompanionsStore(file, seeds);
  const recovery = claim(); expect(recovery?.sourceMessageIds).toEqual([b.id]);
  expect(recovery!.attempts).toBe(1); expect(recovery!.leaseToken).not.toBe(oldJob.leaseToken);
  expect(() => complete(oldJob, [])).toThrow('租约');
  expect(visible(a.id)).toEqual([]);
  const rebuilt = complete(recovery!, [draft(b)])[0]!;
  const receipts = indexed(); expect(receipts.some(receipt => receipt.operation === 'remember' && receipt.noteId === rebuilt.id)).toBe(true);
  expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes).toEqual([expect.objectContaining({ id: rebuilt.id, content: b.content, status: 'indexed' })]);
  expect(claim()).toBeUndefined(); expect(() => complete(recovery!, [draft(b)])).toThrow('租约');
});

function directMerge() {
  const a = source('A：保留蓝色封皮。'), b = source('B：米色棉线在第二层抽屉。'), job = claim()!;
  const candidate: CompanionMemoryCandidate = { content: a.content + b.content, tags: ['合写稿'], sourceMessageIds: [a.id, b.id],
    evidence: [a, b].map(message => ({ sourceMessageId: message.id, quote: message.content })), relatedMemoryIds: [] };
  const merged = complete(job, [candidate])[0]!; indexed(); return { a, b, job, candidate, merged };
}

it('automatically re-extracts surviving B from a direct A+B draft while keeping the forgotten draft permanently retired', () => {
  const { a, b, job, candidate, merged } = directMerge();
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(visible(a.id)).toEqual([]); expect(visible(b.id).map(value => value.id)).toEqual([b.id]);
  const intent = JSON.parse(intents()[0]!.value);
  expect(intent.invalidNotes).toEqual([]); expect(intent.retiredNotes).toEqual([{ id: merged.id, version: merged.version + 1 }]);
  store.close(); store = new CompanionsStore(file, seeds);
  expect(() => complete(job, [candidate])).toThrow('租约');
  const fresh = claim()!; expect(fresh.sourceMessageIds).toEqual([b.id]);
  expect(() => complete(fresh, [candidate])).toThrow('本批来源');
  const rebuilt = complete(fresh, [draft(b)])[0]!; expect(rebuilt.id).not.toBe(merged.id);
  const receipts = indexed(); expect(receipts.some(receipt => receipt.operation === 'remember' && receipt.noteId === merged.id)).toBe(false);
  expect(sql(db => JSON.parse(String((db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(merged.id) as { data: string }).data)))).toMatchObject({ status: 'forgotten', version: merged.version + 1, content: '已遗忘的日记' });
  expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot?.notes).toEqual([expect.objectContaining({ id: rebuilt.id, content: b.content, status: 'indexed' })]);
  expect(intents()).toEqual([]); expect(claim()).toBeUndefined();
});

it.each(['note', 'tag'] as const)('does not reopen any original source after explicit whole-%s forget', selector => {
  const { a, b, candidate, merged } = directMerge();
  store.request({ type: 'memory.forget', ...scope, ...(selector === 'note' ? { id: merged.id } : { tag: '合写稿' }) });
  expect(visible(a.id)).toEqual([]); expect(visible(b.id)).toEqual([]); expect(intents()).toEqual([]); expect(claim()).toBeUndefined();
  expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, metadata: { retiredNotes: [{ id: merged.id, version: merged.version + 1 }] } } })).toThrow('来源');
});

it('rejects explicitly forgotten B', () => {
  const { a, b } = originals();
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [b.id] });
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(claim()).toBeUndefined(); expect(visible(b.id)).toEqual([]);
});

it('durably waits for an authorized capture entrance without revoking a witnessed personal group source', () => {
  scope.conversationId = store.createConversation('实际小组', ['alice', 'bob']).id;
  const { a, b } = originals();
  store.updateConversation(scope.conversationId, { memberIds: ['bob'] });
  const privateScope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  store.request({ type: 'memory.forget', ...privateScope, sourceMessageIds: [a.id] });
  expect(claim()).toBeUndefined();
  expect(store.request({ type: 'memory.sources.filter', ...privateScope, ids: [b.id] }).memorySources?.map(source => source.id)).toEqual([b.id]);
  expect(intents()).toHaveLength(1);
  store.close(); store = new CompanionsStore(file, seeds); expect(claim()).toBeUndefined(); expect(intents()).toHaveLength(1);
  store.updateConversation(scope.conversationId, { memberIds: ['alice', 'bob'] });
  expect(claim()?.sourceMessageIds).toEqual([b.id]);
});

it('does not reopen a source whose actual observation receipt was revoked', () => {
  const { a, b } = originals();
  sql(db => db.prepare('DELETE FROM vcp_source_observers WHERE message_id=? AND companion_id=?').run(b.id, 'alice'));
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(visible(b.id)).toEqual([]); expect(claim()).toBeUndefined(); expect(intents()).toEqual([]);
});

it('does not recapture a derived companion reply whose real ancestor was forgotten', () => {
  const { a, b } = originals(true);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(visible(b.id)).toEqual([]); expect(claim()).toBeUndefined(); expect(intents()).toEqual([]);
});

it.each(['pending', 'running'] as const)('clears a %s reconsideration when original B is explicitly forgotten', phase => {
  const { a, b } = originals(); store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  const running = phase === 'running' ? claim() : undefined;
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [b.id] });
  expect(intents()).toEqual([]); expect(claim()).toBeUndefined();
  if (running) expect(() => complete(running, [draft(b)])).toThrow('租约');
});

function revisionIntent() {
  const a = source('A：蓝色封皮。'), parent = complete(claim()!, [draft(a)])[0]!; indexed();
  const c = source('C：纸盒的高度是十五厘米。'), other = complete(claim()!, [draft(c)])[0]!; indexed();
  const b = source('B：米色棉线在第二层抽屉。');
  const mixed = complete(claim()!, [draft(b, [parent.id, other.id])])[0]!; indexed();
  store.request({ type: 'memory.revise', ...scope, id: other.id, expectedVersion: other.version, candidate: { ...draft(c), content: c.content + ' 以实际测量记录为准。' } });
  return { a, b, c, parent, other, mixed };
}

it.each(['complete', 'fail', 'expire'] as const)('supersedes a running extraction on a second parent change via %s, including an empty old completion', settlement => {
  const { a, b } = revisionIntent(), stale = claim()!;
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(JSON.parse(intents()[0]!.value).blockedLeaseToken).toBe(stale.leaseToken);
  if (settlement === 'complete') expect(complete(stale, [])).toEqual([]);
  else if (settlement === 'fail') store.request({ type: 'memory.jobs.fail', id: stale.id, leaseToken: stale.leaseToken, error: '旧请求失败', retryAfterMs: 99999 });
  else { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 120001); }
  const fresh = claim()!; expect(fresh.sourceMessageIds).toEqual([b.id]); expect(fresh.leaseToken).not.toBe(stale.leaseToken); expect(fresh.attempts).toBe(1);
  expect(() => complete(stale, [])).toThrow('租约');
  const rebuilt = complete(fresh, [draft(b)])[0]!; indexed();
  expect(rebuilt.content).toBe(b.content); expect(intents()).toEqual([]);
});

it('authorizes an identical invalid identity only through its fresh normal lease and keeps old outbox versions obsolete', () => {
  const { b, parent, other, mixed } = revisionIntent(), candidate = draft(b, [parent.id, other.id]);
  expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, metadata: { reconsideration: true, invalidNotes: [{ id: mixed.id, version: mixed.version + 1 }] } } })).toThrow('失效或已遗忘');
  const fresh = claim()!, rebuilt = complete(fresh, [candidate])[0]!;
  expect(rebuilt.id).toBe(mixed.id); expect(rebuilt.version).toBe(mixed.version + 2);
  const receipts = indexed(); expect(receipts.filter(receipt => receipt.noteId === mixed.id).every(receipt => receipt.noteVersion === rebuilt.version)).toBe(true);
  expect(store.request({ type: 'memory.read', ...scope, id: rebuilt.id }).memoryRead?.memory.version).toBe(rebuilt.version);
});

it('retains every invalid note version from multiple candidates of one exact original source', () => {
  const a = source('A：保留蓝色封皮。'), parent = complete(claim()!, [draft(a)])[0]!; indexed();
  const b = source('B：米色棉线在第二层抽屉。');
  const candidates = ['物品位置：', '备查记录：'].map(prefix => ({ ...draft(b, [parent.id]), content: prefix + b.content }));
  const notes = complete(claim()!, candidates); indexed();
  store.request({ type: 'memory.revise', ...scope, id: parent.id, expectedVersion: parent.version, candidate: { ...draft(a), content: a.content + ' 按原文核对。' } });
  expect(JSON.parse(intents()[0]!.value).invalidNotes).toHaveLength(2);
  const restored = complete(claim()!, candidates); expect(restored.map(note => note.id)).toEqual(notes.map(note => note.id));
  expect(restored.every(note => note.version === 3)).toBe(true);
});

it('does not reopen a historical source removed from the current version of a dependent note', () => {
  const a = source('A：蓝色封皮。'), parent = complete(claim()!, [draft(a)])[0]!; indexed();
  const c = source('C：旧版记录用的是红色棉线。'), b = source('B：现在只保留米色棉线的原始位置。');
  const both: CompanionMemoryCandidate = { content: b.content, tags: ['原始事实'], sourceMessageIds: [c.id, b.id],
    evidence: [c, b].map(message => ({ sourceMessageId: message.id, quote: message.content })), relatedMemoryIds: [parent.id] };
  const old = complete(claim()!, [both])[0]!; indexed();
  store.request({ type: 'memory.revise', ...scope, id: old.id, expectedVersion: old.version, candidate: draft(b, [parent.id]) }); indexed();
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  const fresh = claim()!; expect(fresh.sourceMessageIds).toEqual([b.id]);
  expect(intents()).toHaveLength(1); complete(fresh, [draft(b)]); expect(claim()).toBeUndefined();
});

it('supersedes every in-flight descendant when a second ancestor is withdrawn', () => {
  const a = source('A：蓝色封皮。'), parent = complete(claim()!, [draft(a)])[0]!; indexed();
  const c = source('C：纸盒十五厘米。'), other = complete(claim()!, [draft(c)])[0]!; indexed();
  const b = source('B：米色棉线在第二层。'), middle = complete(claim()!, [draft(b, [parent.id, other.id])])[0]!; indexed();
  const d = source('D：剪刀在工具盒中。'); complete(claim()!, [draft(d, [middle.id])]); indexed();
  store.request({ type: 'memory.revise', ...scope, id: other.id, expectedVersion: other.version, candidate: { ...draft(c), content: c.content + ' 按原文核对。' } });
  const stale = claim()!; expect(stale.sourceMessageIds).toEqual([b.id, d.id]);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(intents().every(entry => JSON.parse(entry.value).blockedLeaseToken === stale.leaseToken)).toBe(true);
  expect(complete(stale, [])).toEqual([]);
  expect(claim()?.sourceMessageIds).toEqual([b.id, d.id]);
});

it('does not replay historical state or consume new C state processing in the same batch', () => {
  const { a, b } = originals(); store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  const c = source('C：现在我支持你，请关注眼前的新任务。'), historical = claim()!;
  expect(historical.sourceMessageIds).toEqual([b.id]);
  const stateBefore = store.request({ type: 'state.get', ...scope }).runtimeState!;
  store.request({ type: 'memory.jobs.complete', id: historical.id, leaseToken: historical.leaseToken, notes: [draft(b)],
    stateProposal: { reason: '历史来源补抽不应变成现在的新评价。', focus: '不应重放的旧关注', sourceMessageIds: [b.id], evidence: draft(b).evidence, appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] } });
  const afterHistorical = store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(afterHistorical.relationship).toEqual(stateBefore.relationship); expect(afterHistorical.focus).toBe(stateBefore.focus);
  const ordinary = claim()!; expect(ordinary.sourceMessageIds).toEqual([c.id]);
  store.request({ type: 'memory.jobs.complete', id: ordinary.id, leaseToken: ordinary.leaseToken, notes: [draft(c)],
    stateProposal: { reason: c.content, focus: '眼前的新任务', sourceMessageIds: [c.id], evidence: draft(c).evidence, appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] } });
  const afterC = store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(afterC.focus).toBe('眼前的新任务'); expect(afterC.relationship.affinity).toBeGreaterThan(afterHistorical.relationship.affinity);
});

it('preserves the normal backoff and eight-attempt ceiling across repeated parent withdrawal', () => {
  const { a, parent } = originals(); store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now());
  for (let attempt = 1; attempt <= 8; attempt++) {
    const job = claim()!; expect(job.attempts).toBe(attempt);
    store.request({ type: 'memory.jobs.fail', id: job.id, leaseToken: job.leaseToken, error: '逐字引文不匹配', retryAfterMs: 30000 });
    for (let repeat = 0; repeat < 3; repeat++) store.request({ type: 'memory.forget', ...scope, id: parent.id });
    expect(claim()).toBeUndefined(); vi.setSystemTime(Date.now() + 30001);
  }
  expect(claim()).toBeUndefined(); expect(intents()).toHaveLength(1);
});

it('holds an otherwise valid source durably and resumes after the existing policy hold is released', () => {
  const { a, b } = originals(); store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  sql(db => db.prepare('INSERT INTO vcp_source_policy_holds VALUES(?,?,?,?,?,?,NULL)').run('old-policy', 'alice', scope.conversationId, null, '旧禁记限制', new Date().toISOString()));
  expect(claim()).toBeUndefined(); expect(intents()).toHaveLength(1);
  sql(db => db.prepare('UPDATE vcp_source_policy_holds SET released_at=? WHERE id=?').run(new Date().toISOString(), 'old-policy'));
  expect(claim()?.sourceMessageIds).toEqual([b.id]);
});

it('removes reconsideration authority during the normal durable owner reset and rejects the old token', async () => {
  const { a, b } = originals(); store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  const running = claim()!, reset = store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
  expect(() => complete(running, [draft(b)])).toThrow('重置');
  store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: reset.id });
  for (let n = 0; n < 200 && store.request({ type: 'companion.reset.status', id: 'alice' }).reset?.status !== 'completed'; n++) await store.advanceReset();
  expect(store.request({ type: 'companion.reset.status', id: 'alice' }).reset?.status).toBe('completed');
  expect(intents()).toEqual([]); expect(claim()).toBeUndefined();
  expect(() => complete(running, [draft(b)])).toThrow();
});
