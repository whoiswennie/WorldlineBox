import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

let root: string, filename: string, store: CompanionsStore, scope: { companionId: string; conversationId: string };
const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '保存有据经历', model: '', avatar: 'sister' as const, active: true, proactive: false }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-26T08:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-memory-lifecycle-')); filename = path.join(root, 'messages.sqlite');
  store = new CompanionsStore(filename, seeds); scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
});
afterEach(() => { store.close(); removeOwnedDirectorySync(root); vi.useRealTimers(); });
const advance = (milliseconds: number) => vi.setSystemTime(Date.now() + milliseconds);
const source = (content: string) => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' });
const draft = (message: CompanionMessage, content = message.content) => ({ content, tags: ['真实经历'], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }] });
const record = (message: CompanionMessage, content?: string) => store.request({ type: 'memory.record', ...scope, candidate: draft(message, content) }).memories![0]!;
const read = (id: string) => store.request({ type: 'memory.read', ...scope, id }).memoryRead!.memory;
function indexed() {
  for (let i = 0; i < 50; i++) {
    const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (job) store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
  }
}
const state = () => store.request({ type: 'memory.lifecycle.state', companionId: scope.companionId }).memoryLifecycleState!;
const frozen = (note: CompanionMemory) => ({ id: note.id, sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) });

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
  expect(store.request({ type: 'memory.revision.read', ...scope, id: original.id, contentRevision: 1 }).memories?.[0]?.content).toBe('第一版记忆。');
  const other = store.openPrivate('bob');
  expect(() => store.request({ type: 'memory.revision.read', companionId: 'bob', conversationId: other.id, id: original.id, contentRevision: 1 })).toThrow();
  const before = state().revocationEpoch;
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [message.id] });
  expect(state().revocationEpoch).toBeGreaterThan(before);
  expect(() => store.request({ type: 'memory.revision.read', ...scope, id: original.id, contentRevision: 1 })).toThrow();
});

it('publishes a fixed-body merge after annotation changes without losing or falsely revoking originals', () => {
  const a = source('原文A。'), b = source('原文B。'), one = record(a), two = record(b); indexed();
  const merged = store.request({ type: 'memory.consolidate', ...scope, inputs: [one, two].map(note => ({ id: note.id, version: note.version })),
    candidate: { content: '完整保留A与B。', tags: ['整合'], sourceMessageIds: [a.id, b.id], evidence: [{ sourceMessageId: a.id, quote: a.content }, { sourceMessageId: b.id, quote: b.content }] } }).memories![0]!;
  store.request({ type: 'memory.organize', ...scope, ids: [one.id], tags: ['仅换标签'] });
  store.request({ type: 'memory.organize', ...scope, ids: [merged.id], tags: ['整合后的标签'] });
  indexed(); expect(read(one.id).supersededBy).toBe(merged.id); expect(read(two.id).supersededBy).toBe(merged.id);
  expect(read(one.id).contentRevision).toBe(1); expect(read(merged.id).status).toBe('indexed');
  expect(state().revocationEpoch).toBe(0);
});

it('keeps method proposals out of generic consolidation so summary archiving cannot erase their practice ledger', () => {
  const a = source('先检查输入，再生成产物并核验。'), b = source('另一段有据经历。');
  const method = store.request({ type: 'memory.record', ...scope, candidate: { ...draft(a), procedure: { applicability: '明确要求文本交付时。',
    steps: ['检查输入。', '生成并核验产物。'], limitations: [], verification: { kind: 'artifact_delivery', artifactRequirements: [{ path: 'result.txt' }] } } } }).memories![0]!;
  const other = record(b); indexed();
  expect(() => store.request({ type: 'memory.consolidate', ...scope, inputs: [method, other].map(note => ({ id: note.id, version: note.version })),
    candidate: { content: '两段经历的摘要。', sourceMessageIds: [a.id, b.id], evidence: [{ sourceMessageId: a.id, quote: a.content }, { sourceMessageId: b.id, quote: b.content }] } })).toThrow('方法记忆');
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
  expect(store.request({ type: 'memory.revision.read', ...scope, id: original.id, contentRevision: 1 }).memories?.[0]?.content).toBe('当时任务还没完成。');
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
  const manual = store.saveMemory({ ...scope, content: '手工资料，暂不自动打标签。', autoTags: false });
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
