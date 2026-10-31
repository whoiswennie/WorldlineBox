import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMemoryHistoryPayload } from '../../src/shared/companion-memory-history';

let root: string, filename: string, store: CompanionsStore, scope: { companionId: string; conversationId: string };
const publisherPayloads = new Map<string, CompanionMemoryHistoryPayload>();
const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '保存有据经历', model: '', avatar: 'sister' as const, active: true, proactive: false }));
beforeEach(() => {
  publisherPayloads.clear();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-26T08:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-memory-lifecycle-')); filename = path.join(root, 'messages.sqlite');
  store = new CompanionsStore(filename, seeds); scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
});
afterEach(() => { store.close(); removeOwnedDirectorySync(root); vi.useRealTimers(); });
const advance = (milliseconds: number) => vi.setSystemTime(Date.now() + milliseconds);
const source = (content: string) => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' });
const draft = (message: CompanionMessage, content = message.content) => ({ artifactKind: 'episode_memory' as const, content, tags: ['真实经历'], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }] });
const record = (message: CompanionMessage, content?: string) => store.request({ type: 'memory.record', ...scope, candidate: draft(message, content) }).memories![0]!;
const read = (id: string) => store.request({ type: 'memory.read', ...scope, id }).memoryRead!.memory;
function indexed() {
  for (let i = 0; i < 50; i++) {
    const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (job) store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
  }
}
const state = () => store.request({ type: 'memory.lifecycle.state', companionId: scope.companionId }).memoryLifecycleState!;
const frozen = (note: CompanionMemory) => ({ id: note.id, contentRevision: note.contentRevision, sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) });
/** Storage-only immutable-ledger assertions inspect the host publisher payload.
 * Model-facing history bodies must separately pass the actual file reader. */
function publishedHistory(id: string, contentRevision: number): CompanionMemory {
  for (let count = 0; count < 100; count++) {
    const job = store.request({ type: 'memory.history.outbox.claim', companionId: scope.companionId }).memoryHistoryOutbox;
    if (!job) break;
    if (job.payload) publisherPayloads.set(job.memoryId + ':' + job.contentRevision, job.payload as CompanionMemoryHistoryPayload);
    store.request({ type: 'memory.history.outbox.complete', id: job.id, leaseToken: job.leaseToken, documentHash: job.documentHash });
  }
  store.request({ type: 'memory.revision.describe', ...scope, id, contentRevision });
  const payload = publisherPayloads.get(id + ':' + contentRevision);
  if (!payload) throw Error('Missing actual host publisher payload in isolated fixture');
  return payload.memory;
}

it('preserves an unrelated old revision after source-only withdrawal and still honors later explicit whole-note forget', () => {
  const b = source('B独立来源在旧版中合法。'), original = record(b);
  const a = source('A是新版后来加入的来源。');
  store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version,
    candidate: { artifactKind: 'episode_memory' as const, content: b.content + a.content, sourceMessageIds: [a.id, b.id], evidence: [a, b].map(message => ({ sourceMessageId: message.id, quote: message.content })) } });
  expect(publishedHistory(original.id, 1).content).toBe(b.content);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(publishedHistory(original.id, 1).content).toBe(b.content);
  expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [frozen(original)] }).memoryFrozenValid).toBe(true);
  store.request({ type: 'memory.forget', ...scope, id: original.id });
  expect(() => store.request({ type: 'memory.revision.describe', ...scope, id: original.id, contentRevision: 1 })).toThrow();
  expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [frozen(original)] }).memoryFrozenValid).toBe(false);
});

it('normally re-extracts a surviving original contribution without rejecting its lawful earlier identity', () => {
  const b = source('B是此前独立保存、仍然合法的原始事实。'), original = record(b);
  const a = source('A是后来增加、现已撤回的另一项事实。');
  store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version,
    candidate: { artifactKind: 'episode_memory' as const, content: b.content + a.content, sourceMessageIds: [a.id, b.id], evidence: [a, b].map(message => ({ sourceMessageId: message.id, quote: message.content })) } });
  publishedHistory(original.id, 1);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  expect(job.sourceMessageIds).toEqual([b.id]);
  const saved = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [draft(b)] }).memories!;
  expect(saved).toHaveLength(1); expect(saved[0]!.content).toBe(b.content);
  expect(store.request({ type: 'memory.browse', ...scope }).memoryPage!.items.map(item => item.memory.content)).toEqual([b.content]);
});

it.each(['general-record', 'forged-lease', 'other-owner', 'whole-note-forget'] as const)('does not grant a surviving contribution restoration through %s', attempt => {
  const b = source('B这条独立原始贡献仍需真实宿主租约。'), original = record(b);
  const a = source('A这条后加贡献会被单独撤回。');
  store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version,
    candidate: { artifactKind: 'episode_memory' as const, content: b.content + a.content, sourceMessageIds: [a.id, b.id], evidence: [a, b].map(message => ({ sourceMessageId: message.id, quote: message.content })) } });
  publishedHistory(original.id, 1);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  if (attempt === 'whole-note-forget') {
    store.request({ type: 'memory.forget', ...scope, id: original.id });
    expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob).toBeUndefined();
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: draft(b) })).toThrow();
    expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [frozen(original)] }).memoryFrozenValid).toBe(false);
    return;
  }
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  if (attempt === 'general-record') expect(() => store.request({ type: 'memory.record', ...scope,
    candidate: { ...draft(b), metadata: { restored: true, captureJobId: job.id, leaseToken: job.leaseToken } } })).toThrow('已失效或已遗忘');
  if (attempt === 'forged-lease') expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken + '_forged', notes: [draft(b)] })).toThrow('租约已失效');
  if (attempt === 'other-owner') {
    const conversationId = store.openPrivate('bob').id;
    store.appendMessage({ conversationId, authorId: 'user', content: b.content, replyDirective: 'none' });
    const other = store.request({ type: 'memory.jobs.claim', companionId: 'bob', force: true }).memoryJob!;
    expect(() => store.request({ type: 'memory.jobs.complete', id: other.id, leaseToken: other.leaseToken, notes: [draft(b)] })).toThrow('只能使用本批来源');
    expect(store.request({ type: 'memory.browse', companionId: 'bob', conversationId }).memoryPage!.items).toEqual([]);
  }
  const saved = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [draft(b)] }).memories!;
  expect(saved.map(note => note.id)).toEqual([original.id]);
  expect(saved[0]!.sources.map(source => source.messageId)).toEqual([b.id]);
});

it('audits real membership removal and dissolution with witnessed source targets without changing their evidence bytes', () => {
  const room = store.createConversation('仅合成群聊', ['alice', 'bob']);
  const raw = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '成员各自实际见证这条原始群聊材料。', replyDirective: 'none' });
  const before = state();
  store.updateConversation(room.id, { memberIds: ['bob'] });
  const removed = store.request({ type: 'memory.lifecycle.changes', companionId: 'alice' }).memoryLifecycleChanges!.changes
    .find(change => change.cause.operation === 'membership_revoke' && change.cause.conversationId === room.id)!;
  expect(removed).toMatchObject({ changeKind: 'revocation', causeEventId: expect.stringMatching(/^membership\//u),
    cause: { sourceMessageIds: [raw.id], sourceTargetCount: 1, sourceTargetsComplete: true }, lineageRootIds: [raw.id],
    evidenceDelta: { added: [], removed: [], revised: [], newSourceVersions: [] } });
  expect(state().revocationEpoch).toBeGreaterThan(before.revocationEpoch);
  expect(store.getMessage(raw.id).content).toBe(raw.content);
  store.deleteConversation(room.id, 'dissolve');
  const dissolved = store.request({ type: 'memory.lifecycle.changes', companionId: 'bob' }).memoryLifecycleChanges!.changes
    .find(change => change.cause.operation === 'conversation_dissolve' && change.cause.conversationId === room.id)!;
  expect(dissolved).toMatchObject({ causeEventId: expect.stringMatching(/^conversation\//u), lineageRootIds: [raw.id],
    cause: { sourceMessageIds: [raw.id], sourceTargetCount: 1, sourceTargetsComplete: true } });
  expect(store.request({ type: 'memory.lifecycle.state', companionId: 'bob' }).memoryLifecycleState!.ledgerSequence).toBeGreaterThanOrEqual(dissolved.sequence);
});

it('audits a newly blocked actual source atomically and does not create repeat events for an already blocked source', () => {
  const raw = source('这条真实来源需要准确撤回而不是伪造新事实。');
  const memory = record(raw);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [raw.id] });
  const changes = store.request({ type: 'memory.lifecycle.changes', companionId: 'alice' }).memoryLifecycleChanges!.changes;
  const blocked = changes.filter(change => change.causeEventId.startsWith('source-block/'));
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toMatchObject({ cause: { operation: 'source_revoke', sourceMessageIds: [raw.id] }, lineageRootIds: [raw.id],
    evidenceDelta: { added: [], removed: [], revised: [], newSourceVersions: [] } });
  expect(changes.find(change => change.noteId === memory.id && change.changeKind === 'revocation')).toMatchObject({
    cause: { noteIds: [memory.id], sourceMessageIds: [raw.id] }, evidenceDelta: { removed: [{ messageId: raw.id }], newSourceVersions: [] } });
  expect(() => store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [raw.id] })).toThrow('不可访问');
  expect(store.request({ type: 'memory.lifecycle.changes', companionId: 'alice' }).memoryLifecycleChanges!.changes.filter(change => change.causeEventId.startsWith('source-block/'))).toHaveLength(1);
});

it('binds host record dependencies to actual read bodies, allowing annotations but rejecting missing or replaced bodies', () => {
  const input = source('这个实际依据的正文有独立修订。'), dependency = record(input);
  const output = source('依据上述实际材料形成一条新记录。');
  const candidate = { ...draft(output), relatedMemoryIds: [dependency.id] };
  expect(() => store.request({ type: 'memory.record', ...scope, candidate, readMemories: [] })).toThrow('实际推理');
  const annotated = store.request({ type: 'memory.organize', ...scope, ids: [dependency.id], tags: ['核实过标签'] }).memories![0]!;
  expect(annotated.version).toBeGreaterThan(dependency.version);
  const actual = store.request({ type: 'memory.record', ...scope, candidate,
    readMemories: [{ id: dependency.id, version: dependency.version }] }).memories![0]!;
  expect(actual).toBeDefined();
  const changed = store.request({ type: 'memory.revise', ...scope, id: dependency.id, expectedVersion: annotated.version,
    candidate: draft(input, '这次实际依据的正文已经修订。') }).memories![0]!;
  expect(() => store.request({ type: 'memory.record', ...scope, candidate,
    readMemories: [{ id: dependency.id, version: dependency.version }] })).toThrow('正文已变化');
  expect(() => store.request({ type: 'memory.record', ...scope, candidate,
    readMemories: [{ id: dependency.id, contentRevision: dependency.contentRevision }] })).toThrow('正文已变化');
  expect(store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, content: candidate.content + ' 已重新核对新版实际依据。' },
    readMemories: [{ id: changed.id, version: changed.version, contentRevision: changed.contentRevision }] }).memories).toHaveLength(1);
});

it('attests an explicit tool CAS version against its actual immutable body instead of trusting a supplied body revision', () => {
  const raw = source('旧版实际依据仍可作为原任务的历史输入。'), original = record(raw);
  const nextSource = source('新版形成了另一份正文，不能冒充先前已读版本。');
  const next = store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version, candidate: draft(nextSource) }).memories![0]!;
  const check = (memory: ReturnType<typeof frozen> & { version: number }) => store.request({ type: 'memory.frozen.valid', ...scope, memories: [memory] }).memoryFrozenValid;
  expect(check({ ...frozen(next), version: original.version })).toBe(false);
  expect(check({ ...frozen(next), version: 9999 })).toBe(false);
  expect(check({ ...frozen(original), version: original.version })).toBe(true);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [raw.id] });
  expect(check({ ...frozen(original), version: original.version })).toBe(false);
});

it('changes immutable revision identity when only the actual derivation closure changes and preserves each historical task closure', () => {
  const a = source('A条件在第一次整理时有效。'), first = record(a);
  const b = source('B是后来采用的独立验证依据。'), second = record(b);
  const raw = source('这篇有固定文字但需要追溯其采用的依据。');
  const original = store.request({ type: 'memory.record', ...scope, candidate: { ...draft(raw), relatedMemoryIds: [first.id] } }).memories![0]!;
  const updated = store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version,
    candidate: { ...draft(raw), relatedMemoryIds: [second.id] } }).memories![0]!;
  expect(updated.content).toBe(original.content); expect(updated.contentRevision).toBe(original.contentRevision! + 1);
  expect(publishedHistory(original.id, original.contentRevision!).content).toBe(raw.content);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [b.id] });
  expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [frozen(original)] }).memoryFrozenValid).toBe(true);
  expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [frozen(updated)] }).memoryFrozenValid).toBe(false);
  expect(publishedHistory(original.id, original.contentRevision!).id).toBe(original.id);
  expect(() => store.request({ type: 'memory.revision.describe', ...scope, id: original.id, contentRevision: updated.contentRevision! })).toThrow();
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
  expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [frozen(original)] }).memoryFrozenValid).toBe(false);
});

it('retains native strict raw revisions throughout a frozen historical derivation closure', () => {
  const parentRaw = source('父来源的正文未变，但正式来源修订会独立核验。'), parent = record(parentRaw);
  const ownRaw = source('这个派生条目采用了父来源。');
  const derived = store.request({ type: 'memory.record', ...scope, candidate: { ...draft(ownRaw), relatedMemoryIds: [parent.id] } }).memories![0]!;
  const ordinary = frozen(derived), native = { ...ordinary, sources: derived.sources.map(source => ({ id: source.messageId,
    conversationId: source.conversationId, checksum: source.checksum, revision: source.revision })) };
  const sql = new (Database as { new(file: string): CompanionConnection })(filename);
  try { sql.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(parentRaw.id); } finally { sql.close(); }
  expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [ordinary] }).memoryFrozenValid).toBe(true);
  expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [native] }).memoryFrozenValid).toBe(false);
});

it('rejects a changed source revision before exposing its already-claimed contribution page', () => {
  const raw = source('该来源的当前版本必须与本次领取时一致。'); record(raw, '一段已存的同源概述。');
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  const sql = new (Database as { new(file: string): CompanionConnection })(filename);
  try { sql.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(raw.id); } finally { sql.close(); }
  expect(() => store.request({ type: 'memory.jobs.contributions', companionId: 'alice', id: job.id, leaseToken: job.leaseToken })).toThrow('修订');
});

it('returns exact same-source summaries from the live lease even before indexing without marking the whole source covered', () => {
  const raw = source('第一件事实：材料是米色棉线。第二件事实：剩余材料在第二层抽屉。');
  const first = record(raw, '材料为米色棉线。'), second = record(raw, '第二层抽屉保存了剩余材料。');
  const unrelated = record(source('另一个真实事件，与这次原文无关。'));
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  // A fully copied source must also be settled when it occurs after the first
  // unprocessed source in one episode, rather than slipping into its cohort.
  const ids: string[] = []; let afterId: string | undefined;
  do {
    const page = store.request({ type: 'memory.jobs.contributions', companionId: 'alice', id: job.id, leaseToken: job.leaseToken, afterId, limit: 1 }).memoryCaptureContributions!;
    ids.push(...page.items.map(note => note.id)); afterId = page.nextId;
  } while (afterId);
  expect(new Set(ids)).toEqual(new Set([first.id, second.id])); expect(ids).not.toContain(unrelated.id);
  expect(job.sourceMessageIds).toContain(raw.id);
  expect(() => store.request({ type: 'memory.jobs.contributions', companionId: 'bob', id: job.id, leaseToken: job.leaseToken })).toThrow('租约');
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [raw.id] });
  expect(() => store.request({ type: 'memory.jobs.contributions', companionId: 'alice', id: job.id, leaseToken: job.leaseToken })).toThrow();
});

it.each(['annotation', 'body'] as const)('binds only actually used capture dependencies to their host read revision during a concurrent %s change', change => {
  const priorSource = source('先前核验过的原始条件。'), prior = record(priorSource);
  const fresh = source('当前事件引用了先前条件。');
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  const readMemories = [{ id: prior.id, version: prior.version, contentRevision: prior.contentRevision! }];
  if (change === 'annotation') store.request({ type: 'memory.organize', ...scope, ids: [prior.id], tags: ['新的展示标签'] });
  else store.request({ type: 'memory.revise', ...scope, id: prior.id, expectedVersion: prior.version, candidate: draft(priorSource, '后台已改写的当前条件。') });
  const completion = { type: 'memory.jobs.complete' as const, id: job.id, leaseToken: job.leaseToken, readMemories,
    notes: [{ ...draft(fresh), relatedMemoryIds: [prior.id] }] };
  if (change === 'annotation') expect(store.request(completion).memories).toHaveLength(1);
  else {
    expect(() => store.request(completion)).toThrow('实际读过');
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.running).toBe(1);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [fresh.id] }).memorySources).toHaveLength(1);
    expect(store.request({ type: 'memory.browse', ...scope }).memoryPage?.items).toHaveLength(1);
    const current = read(prior.id);
    expect(store.request({ ...completion, readMemories: [{ id: current.id, version: current.version, contentRevision: current.contentRevision! }] }).memories).toHaveLength(1);
  }
});

it('derives typed causes, source deltas and lineage from host receipts rather than candidate novelty metadata', () => {
  const raw = source('原始材料只正式提供过这一次。');
  const first = store.request({ type: 'memory.record', ...scope, operationId: 'actual_record_receipt', candidate: {
    ...draft(raw, '对这条材料的第一种表述。'), metadata: { causeEventId: 'forged', changeKind: 'reflection', lineageRootIds: ['private_other_owner'],
      evidenceDelta: { newSourceVersions: [{ messageId: 'invented' }] }, sleepReflection: true },
  } }).memories![0]!;
  const another = record(raw, '对相同来源的另一种表述。');
  const correction = source('这是另一次实际提供的更正材料。');
  const revised = store.request({ type: 'memory.revise', ...scope, id: first.id, expectedVersion: first.version,
    candidate: draft(correction, '按新来源修正后的表述。') }).memories![0]!;
  store.request({ type: 'memory.organize', ...scope, ids: [another.id], tags: ['展示标签'] });
  const changes = store.request({ type: 'memory.lifecycle.changes', companionId: 'alice', limit: 64 }).memoryLifecycleChanges!.changes;
  const created = changes.find(change => change.noteId === first.id && change.kind === 'create')!;
  expect(created).toMatchObject({ causeEventId: 'operation/actual_record_receipt', changeKind: 'external_evidence', lineageRootIds: [raw.id],
    evidenceDelta: { added: [{ messageId: raw.id }], newSourceVersions: [{ messageId: raw.id }] } });
  expect(changes.find(change => change.noteId === another.id && change.kind === 'create')).toMatchObject({ changeKind: 'representation',
    lineageRootIds: [raw.id], evidenceDelta: { newSourceVersions: [] } });
  expect(changes.find(change => change.noteId === revised.id && change.kind === 'content')).toMatchObject({ changeKind: 'correction',
    evidenceDelta: { added: [{ messageId: correction.id }], removed: [{ messageId: raw.id }], newSourceVersions: [{ messageId: correction.id }] } });
  expect(changes.at(-1)).toMatchObject({ changeKind: 'annotation', evidenceDelta: { added: [], removed: [], revised: [], newSourceVersions: [] } });
  expect(changes.every(change => change.causeEventId !== 'forged' && !change.lineageRootIds.includes('private_other_owner'))).toBe(true);
});

it('separates annotation changes from body dependencies, semantic coverage and revocation', () => {
  const a = source('A事件只发生过一次。'), original = record(a, 'A事件的完整正文。');
  const b = source('对A形成新的有据认识。');
  const derived = store.request({ type: 'memory.record', ...scope, candidate: { ...draft(b), relatedMemoryIds: [original.id] } }).memories![0]!;
  indexed(); const before = state(); store.takeMemoryInvalidations();
  const snapshot = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
  const changed = store.request({ type: 'memory.organize', ...scope, ids: [original.id], tags: ['新目录锚点'] });
  expect(changed.memoryInvalidatedCompanionIds).toBeUndefined();
  expect(changed.memoryChangedCompanionIds).toContain('alice');
  expect(read(original.id)).toMatchObject({ version: 2, contentRevision: 1, annotationRevision: 2, semanticRevision: 1 });
  expect(read(derived.id).content).toBe(b.content);
  expect(state().revocationEpoch).toBe(before.revocationEpoch);
  indexed(); const currentSnapshot = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
  expect(currentSnapshot.revision).not.toBe(snapshot.revision); expect(currentSnapshot.semanticRevision).toBe(snapshot.semanticRevision);
  expect(currentSnapshot.revocationEpoch).toBe(snapshot.revocationEpoch);
  expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: [frozen(original)] }).memoryFrozenValid).toBe(true);
  const changes = store.request({ type: 'memory.lifecycle.changes', companionId: 'alice', afterSequence: before.ledgerSequence, limit: 64 }).memoryLifecycleChanges!;
  expect(changes.changes.map(change => change.kind)).toEqual(['annotation']);
});

it('retains immutable body revisions while hard source withdrawal revokes their use', () => {
  const message = source('当时的真实原文。'), original = record(message, '第一版记忆。');
  const next = store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version, candidate: draft(message, '第二版记忆。') }).memories![0]!;
  expect(next).toMatchObject({ version: 2, contentRevision: 2, annotationRevision: 1, semanticRevision: 2 });
  expect(publishedHistory(original.id, 1).content).toBe('第一版记忆。');
  expect(() => store.request({ type: 'memory.revision.read', ...scope, id: original.id, contentRevision: 1 })).toThrow('canonical');
  const other = store.openPrivate('bob');
  expect(() => store.request({ type: 'memory.revision.describe', companionId: 'bob', conversationId: other.id, id: original.id, contentRevision: 1 })).toThrow();
  const before = state().revocationEpoch;
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [message.id] });
  expect(state().revocationEpoch).toBeGreaterThan(before);
  expect(() => store.request({ type: 'memory.revision.describe', ...scope, id: original.id, contentRevision: 1 })).toThrow();
});

it('publishes a fixed-body merge after annotation changes without losing or falsely revoking originals', () => {
  const a = source('原文A。'), b = source('原文B。'), one = record(a), two = record(b); indexed();
  const merged = store.request({ type: 'memory.consolidate', ...scope, inputs: [one, two].map(note => ({ id: note.id, version: note.version })),
    candidate: { artifactKind: 'episode_memory' as const, content: '完整保留A与B。', tags: ['整合'], sourceMessageIds: [a.id, b.id], evidence: [{ sourceMessageId: a.id, quote: a.content }, { sourceMessageId: b.id, quote: b.content }] } }).memories![0]!;
  store.request({ type: 'memory.organize', ...scope, ids: [one.id], tags: ['仅换标签'] });
  store.request({ type: 'memory.organize', ...scope, ids: [merged.id], tags: ['整合后的标签'] });
  indexed(); expect(read(one.id).supersededBy).toBe(merged.id); expect(read(two.id).supersededBy).toBe(merged.id);
  expect(read(one.id).contentRevision).toBe(1); expect(read(merged.id).status).toBe('indexed');
  expect(state().revocationEpoch).toBe(0);
});

it('keeps method proposals out of generic consolidation so summary archiving cannot erase their practice ledger', () => {
  const a = source('先检查输入，再生成产物并核验。'), b = source('另一段有据经历。');
  const method = store.request({ type: 'memory.record', ...scope, candidate: { ...draft(a), artifactKind: 'procedure' as const, procedure: { applicability: '明确要求文本交付时。',
    steps: ['检查输入。', '生成并核验产物。'], limitations: [], verification: { kind: 'artifact_delivery', artifactRequirements: [{ path: 'result.txt' }] } } } }).memories![0]!;
  const other = record(b); indexed();
  expect(() => store.request({ type: 'memory.consolidate', ...scope, inputs: [method, other].map(note => ({ id: note.id, version: note.version })),
    candidate: { artifactKind: 'episode_memory' as const, content: '两段经历的摘要。', sourceMessageIds: [a.id, b.id], evidence: [{ sourceMessageId: a.id, quote: a.content }, { sourceMessageId: b.id, quote: b.content }] } })).toThrow('真实经历');
  expect(read(method.id).archivedAt).toBeUndefined(); expect(read(method.id).procedure?.validation.state).toBe('unverified');
});

it('waits for a quiet episode while retaining original sources and a durable next eligibility', () => {
  const first = source('这个故事刚开始。');
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
  expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [first.id] }).memorySources?.[0]?.content).toBe(first.content);
  advance(30_000); const second = source('事情后来继续发展。');
  expect(state().nextCaptureAt).toBe(new Date(Date.now() + 60_000).toISOString());
  advance(30_000); expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
  advance(30_000); const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(job.sourceMessageIds).toEqual([first.id, second.id]); expect(job.episodeId).toMatch(/^episode_/);
});

it('bounds continuously arriving episodes by twelve sources and seals a claimed prefix', () => {
  const sources = Array.from({ length: 12 }, (_, index) => source('这一段事件的第' + index + '项。'));
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(job.sourceMessageIds).toEqual(sources.map(message => message.id));
  store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
  const tail = source('之后又有新的进展。');
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
  advance(60_000); const next = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(next.sourceMessageIds).toEqual([tail.id]); expect(next.episodeId).not.toBe(job.episodeId);
});

it('does not indefinitely postpone the first episode deadline under continuous traffic', () => {
  const inputs: CompanionMessage[] = [];
  for (let index = 0; index < 10; index++) { inputs.push(source('持续输入的新片段' + index)); advance(30_000); }
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(job.sourceMessageIds).toEqual(inputs.map(message => message.id));
});

it('keeps the episode deadline after restart and admits an explicit first identity promptly', () => {
  const pending = source('还未完成的叙述。'); advance(20_000); store.close(); store = new CompanionsStore(filename, seeds);
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
  advance(40_000); const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(job.sourceMessageIds).toEqual([pending.id]); store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
  const identity = source('你好，我叫林青。');
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob?.sourceMessageIds).toEqual([identity.id]);
});

it('settles an exact complete source write but never marks a partially quoted message fully covered', () => {
  const complete = source('这条完整原文已由伙伴直接记录。'), note = record(complete);
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob).toBeUndefined();
  expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.completed).toBe(1);
  const partial = source('第一件事已经说完。第二件事仍有独立信息。'); record(partial, '只记第一件事。'); advance(60_000);
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob?.sourceMessageIds).toEqual([partial.id]);
  expect(read(note.id).content).toBe(complete.content);
});

it('updates the same event through an explicit fixed-version append and keeps all original evidence', () => {
  const first = source('任务尚未完成。'); advance(60_000);
  const initial = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  const original = store.request({ type: 'memory.jobs.complete', id: initial.id, leaseToken: initial.leaseToken, notes: [draft(first, '当时任务还没完成。')] }).memories![0]!;
  const result = source('任务现在已完成，结果已核验。'); advance(60_000);
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  const updated = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken,
    notes: [{ ...draft(result, '任务最初未完成，后来完成并核验了结果。'), encoding: { action: 'append', targetId: original.id, expectedVersion: original.version } }] }).memories![0]!;
  expect(updated.id).toBe(original.id); expect(updated.contentRevision).toBe(2);
  expect(updated.sources.map(reference => reference.messageId)).toEqual([first.id, result.id]);
  expect(publishedHistory(original.id, 1).content).toBe('当时任务还没完成。');
});

it('rebases automatic append across annotations while preserving concurrent human organization and strict explicit revision CAS', () => {
  const first = source('这个事件开始了。'), original = record(first); indexed();
  const next = source('这个事件后来完成了。'); advance(60_000);
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  store.request({ type: 'memory.library.organize', companionId: 'alice', id: original.id, expectedVersion: original.version,
    tags: ['人工新标签'], diaryName: '人工目录', autoTags: false });
  const updated = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [{ ...draft(next, '事件开始后最终完成。'),
    diaryName: original.diaryName, metadata: { autoTags: true }, encoding: { action: 'append', targetId: original.id, expectedVersion: original.version } }] }).memories![0]!;
  expect(updated).toMatchObject({ id: original.id, version: 3, contentRevision: 2, tags: ['人工新标签'], diaryName: '人工目录', metadata: { autoTags: false } });
  expect(() => store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version, candidate: draft(first) })).toThrow('版本');
});

it('commits verified journal text when a newer runtime state makes its optional focus proposal stale', () => {
  const message = source('先核对本轮原文，再保存这次真实事件。'); advance(60_000);
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  const expected = store.request({ type: 'state.inspect', ...scope }).runtimeState!.revision;
  store.request({ type: 'state.update', ...scope, expectedRevision: expected, proposal: { reason: '更新当前关注。', focus: '当前较新的关注',
    sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }] } });
  const saved = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [draft(message)], expectedStateRevision: expected,
    stateProposal: { reason: '旧的可选关注。', focus: '不应覆盖新关注', sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }] } }).memories![0]!;
  expect(saved.content).toBe(message.content);
  expect(store.request({ type: 'state.inspect', ...scope }).runtimeState!.focus).toBe('当前较新的关注');
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
});

it('submits auto-tag preference through the same annotation ledger without creating an experience', () => {
  const message = source('伙伴保存的资料，暂不自动打标签。');
  const manual = store.request({ type: 'memory.record', ...scope, candidate: { ...draft(message), metadata: { autoTags: false } } }).memories![0]!;
  const before = state();
  store.request({ type: 'memory.tags.retry', companionId: 'alice', noteId: manual.id });
  expect(read(manual.id)).toMatchObject({ contentRevision: 1, semanticRevision: 1, annotationRevision: 2, metadata: { autoTags: true } });
  store.request({ type: 'memory.tags.cancel', companionId: 'alice', noteId: manual.id });
  expect(read(manual.id)).toMatchObject({ contentRevision: 1, semanticRevision: 1, annotationRevision: 3, metadata: { autoTags: false } });
  expect(state().revocationEpoch).toBe(before.revocationEpoch);
  expect(store.request({ type: 'memory.lifecycle.changes', companionId: 'alice', afterSequence: before.ledgerSequence, limit: 64 })
    .memoryLifecycleChanges?.changes.map(change => change.kind)).toEqual(['annotation', 'annotation']);
});

it('propagates an actual asset grant revocation to immutable history and its owner only', () => {
  const grant = store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'real_library_authority', libraryName: '授权资产库', libraryPath: root,
    autonomous: false, intervalMinutes: 30 }).learning!.grants[0]!;
  store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const reading = store.request({ type: 'learning.claim', excludedOwners: [] }).learningJob!;
  store.request({ type: 'learning.begin', id: reading.id, leaseToken: reading.leaseToken, assetId: 'real_asset', assetRevisionId: 'asset_revision', offset: 0 });
  const committed = store.request({ type: 'learning.commit', id: reading.id, leaseToken: reading.leaseToken, assetId: 'real_asset', assetRevisionId: 'asset_revision',
    assetName: '材料.md', offset: 0, content: '原文明确说明适用条件。', more: false });
  const receipt = committed.learning!.reads[0]!, evidence = store.getMessage(receipt.sourceMessageId);
  const assetScope = { companionId: 'alice', conversationId: 'world_alice' };
  const note = store.request({ type: 'memory.record', ...assetScope, candidate: { ...draft(evidence, '实际读过的材料有适用条件。'), diaryName: '资料' } }).memories![0]!;
  expect(note.sources[0]?.sourceType).toBe('asset_read');
  const before = state().revocationEpoch;
  const revoked = store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  expect(revoked.memoryInvalidatedCompanionIds).toEqual(['alice']);
  expect(state().revocationEpoch).toBeGreaterThan(before);
  expect(() => store.request({ type: 'memory.revision.read', ...assetScope, id: note.id, contentRevision: 1 })).toThrow();
  expect(store.request({ type: 'memory.lifecycle.state', companionId: 'bob' }).memoryLifecycleState?.revocationEpoch).toBe(0);
});
