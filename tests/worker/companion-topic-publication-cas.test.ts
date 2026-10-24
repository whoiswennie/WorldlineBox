import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { companionTopicNarrativeBasis, type CompanionTopicPublicationApproval, type CompanionTopicUserCanon } from '../../src/shared/companion-topic-canon';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const owned: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
afterEach(() => { for (const f of owned.splice(0)) { f.db.close(); f.store.close(); removeOwnedDirectorySync(f.root); } });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-topic-publication-')), filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, ['a', 'b'].map(id => ({ id, name: id, persona: '独立伙伴', description: '',
    avatar: 'sister' as const, model: '', active: true, proactive: false })));
  const db = new (Database as { new(file: string): CompanionConnection })(filename); owned.push({ root, store, db });
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const room = store.request({ type: 'conversation.create-group', title: '真实小说端口', memberIds: ['a', 'b'] }).conversation!;
  const topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '未开封的信', kind: 'story' }).topic!;
  for (const readerId of ['a', 'b']) store.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId });
  const read = (readerId = 'a', topicId = topic.id) => store.request({ type: 'topic.read', conversationId: room.id, topicId, readerId });
  const human = (content = '请继续当前场景，信未拆。', topicId = topic.id) => store.appendMessage({ conversationId: room.id, topicId, authorId: 'user', content, replyDirective: 'none' });
  const draft = (source: CompanionMessage, owner = 'a') => {
    const message = store.appendMessage({ conversationId: room.id, topicId: source.topicId, authorId: owner, replyToId: source.id,
      content: '', loopStep: 0, replyDirective: 'none' });
    const checkpoint: CompanionLoopCheckpoint = { companionId: owner, conversationId: room.id, sourceMessageId: source.id,
      messageId: message.id, status: 'running', turns: [], supplements: [] };
    store.request({ type: 'loop.save', checkpoint }); return { source, message, checkpoint, owner };
  };
  const approval = (d: ReturnType<typeof draft>, text: string, canon?: CompanionTopicUserCanon): CompanionTopicPublicationApproval => {
    const current = read(d.owner, d.source.topicId);
    return { companionId: d.owner, conversationId: room.id, topicId: d.source.topicId!, contentScope: 'full_reply', contentChecksum: hash(text),
      expectedStateChecksum: hash(companionTopicNarrativeBasis(current.topicState?.workingState)),
      expectedFormalPublicationRevision: current.topic!.formalPublicationRevision ?? 0, ...(canon ? { userCanon: canon } : {}) };
  };
  const canon = (source: CompanionMessage): CompanionTopicUserCanon => ({ version: 1, throughSequence: source.sequence,
    entries: [{ id: hash('actual-user-rule'), sourceMessageId: source.id, sourceChecksum: hash(source.content), quote: source.content, rule: source.content }] });
  const commit = (d: ReturnType<typeof draft>, text: string, reviewed = approval(d, text), clock?: { minutes: number; quote: string; rangeDigest: string }) => {
    const checkpoint: CompanionLoopCheckpoint = { ...d.checkpoint, status: 'done', turns: [{ text, rawText: text, calls: [],
      topicPublicationApproval: reviewed, ...(clock ? { topicNarrativeApproval: { ...clock, topicId: reviewed.topicId, contentScope: 'full_reply',
        contentChecksum: hash(text), expectedStateChecksum: reviewed.expectedStateChecksum, userCanon: reviewed.userCanon } } : {}) }] };
    const executionReadset = captureCompanionExecutionReadset({ companionId: d.owner, conversationId: room.id }, {
      sources: [{ id: d.source.id, conversationId: d.source.conversationId, checksum: hash(d.source.content) }] });
    store.request({ type: 'loop.save', checkpoint, executionReadset }); return checkpoint;
  };
  return { root, store, db, room, topic, read, human, draft, approval, canon, commit };
}

it('persists clock-free user canon without inventing a clock anchor and increments only actual formal publication', () => {
  const f = fixture(), source = f.human('主角使用她，信不能拆。'), d = f.draft(source), text = '她仍站在门外，信封保持完好。';
  const before = f.read().topic!.formalPublicationRevision!;
  const done = f.commit(d, text, f.approval(d, text, f.canon(source)));
  const current = f.read(); expect(current.topic!.formalPublicationRevision).toBe(before + 1);
  expect(current.topicState!.workingState!.state!.__topicUserCanon).toEqual(f.canon(source));
  expect(current.topicState!.workingState!.state!.__topicNarrativeTime).toBeUndefined();
  f.store.request({ type: 'loop.save', checkpoint: done });
  expect(f.read().topic).toEqual(current.topic); expect(f.read().topicState).toEqual(current.topicState);
});

it('rejects an older pending clock-free reply after a newer pending reply formally completes, regardless of creation order', () => {
  const f = fixture(), s1 = f.human('第一项旧请求。'), s2 = f.human('同一场景另一个请求。');
  const old = f.draft(s1), next = f.draft(s2), oldText = '她尚未检查门锁，仍站在屋内。';
  expect(old.message.sequence).toBeLessThan(next.message.sequence);
  const oldApproval = f.approval(old, oldText), before = f.read().topic!.formalPublicationRevision!;
  f.commit(next, '她已经检查完门锁，走出屋外并关了门。');
  const current = f.read(); expect(current.topic!.formalPublicationRevision).toBe(before + 1);
  expect(() => f.commit(old, oldText, oldApproval)).toThrow('审批后已经变化');
  expect(f.store.getMessage(old.message.id).content).toBe(''); expect(f.read().topic).toEqual(current.topic);
  expect(f.store.request({ type: 'loop.get', companionId: 'a', sourceMessageId: s1.id }).loop!.status).toBe('running');
});

it('expires pending approvals on a new actual user correction and keeps the counter separate from summary-only maintenance', () => {
  const f = fixture(), source = f.human(), d = f.draft(source), text = '她站在门外。';
  const reviewed = f.approval(d, text), before = f.read().topic!.formalPublicationRevision;
  const topic = f.read().topic!;
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId: 'a', expectedRevision: topic.revision,
    patch: { workingState: { summary: '仅摘要整理/扫描水位，无新正文或约束。', sourceMessageIds: [] } } });
  expect(f.read().topic!.formalPublicationRevision).toBe(before);
  f.human('编辑更正：门牌应为B-204，其余不变。');
  expect(() => f.commit(d, text, reviewed)).toThrow('审批后已经变化');
  expect(f.store.getMessage(d.message.id).content).toBe('');
});

it('allows a pure summary change and a streamed draft whose bytes already match the final reply', () => {
  const f = fixture(), source = f.human(), d = f.draft(source), text = '她站在门外，尚未开信。';
  const reviewed = f.approval(d, text), before = f.read().topic!.formalPublicationRevision!;
  d.checkpoint.turns = [{ text, rawText: text, calls: [] }]; f.store.request({ type: 'loop.save', checkpoint: d.checkpoint });
  expect(f.read().topic!.formalPublicationRevision).toBe(before);
  const current = f.read().topic!;
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: current.id, readerId: 'a', expectedRevision: current.revision,
    patch: { workingState: { summary: '只更新摘要时间，不是正式剧情。', sourceMessageIds: [] } } });
  f.commit(d, text, reviewed); expect(f.read().topic!.formalPublicationRevision).toBe(before + 1);
});

it('does not replay old clock or canon over a newer formal tail when the old reply is retried byte-for-byte', () => {
  const f = fixture(), s1 = f.human('只叙述09:00至09:30，不拆信。'), s2 = f.human('接着观察封口。');
  const old = f.draft(s1), next = f.draft(s2), canon = f.canon(s1);
  canon.entries[0]!.timeRange = { start: 540, end: 570, includeStart: true, includeEnd: true };
  const rangeDigest = hash(JSON.stringify(canon.entries.map(item => [item.id, item.timeRange])));
  const done = f.commit(old, '09:20，她仍在屋内。', f.approval(old, '09:20，她仍在屋内。', canon), { minutes: 560, quote: '09:20', rangeDigest });
  f.commit(next, '09:25，她已经走出屋外。', f.approval(next, '09:25，她已经走出屋外。', canon), { minutes: 565, quote: '09:25', rangeDigest });
  const current = f.read(); f.store.request({ type: 'loop.save', checkpoint: done });
  expect(f.read()).toEqual(current); expect(current.topicState!.workingState!.state!.__topicNarrativeTime).toMatchObject({ minutes: 565 });
});

it('durably records a clock-free user correction while preserving the existing exact clock anchor', () => {
  const f = fixture(), source = f.human('只叙述09:00至09:30，门牌B-402。'), correction = f.human('更正门牌应是B-204，其余不变。');
  const first = f.draft(source), next = f.draft(correction), canon = f.canon(source);
  canon.entries[0]!.timeRange = { start: 540, end: 570, includeStart: true, includeEnd: true };
  const rangeDigest = hash(JSON.stringify(canon.entries.map(item => [item.id, item.timeRange])));
  f.commit(first, '09:20，她仍未开信。', f.approval(first, '09:20，她仍未开信。', canon), { minutes: 560, quote: '09:20', rangeDigest });
  const before = f.read().topicState!.workingState!.state!.__topicNarrativeTime;
  const corrected = { ...canon, throughSequence: correction.sequence, entries: [...canon.entries, { ...f.canon(correction).entries[0]!, id: hash('actual-correction') }] };
  f.commit(next, '她核对原件，将门牌纠正为B-204。', f.approval(next, '她核对原件，将门牌纠正为B-204。', corrected));
  const state = f.read().topicState!.workingState!.state!;
  expect(state.__topicUserCanon).toEqual(corrected); expect(state.__topicNarrativeTime).toEqual(before);
});

it('increments same-ID formal body revisions and rejects an old approval without losing the latest bytes', () => {
  const f = fixture(), source = f.human(), other = f.human(), d = f.draft(source), pending = f.draft(other);
  f.commit(d, '她站在屋内。');
  const stale = f.approval(pending, '她也仍在屋内。'), before = f.read().topic!.formalPublicationRevision!;
  f.commit(d, '她已经走出屋外。');
  expect(f.read().topic!.formalPublicationRevision).toBe(before + 1);
  expect(() => f.commit(pending, '她也仍在屋内。', stale)).toThrow('审批后已经变化');
  expect(f.store.getMessage(d.message.id).content).toBe('她已经走出屋外。');
});

it('validates a same-ID revision against its pre-publication state without inheriting an invalidated old clock event', () => {
  const f = fixture(), source = f.human('只叙述09:00至09:30，不拆信。'), d = f.draft(source), canon = f.canon(source);
  canon.entries[0]!.timeRange = { start: 540, end: 570, includeStart: true, includeEnd: true };
  const rangeDigest = hash(JSON.stringify(canon.entries.map(item => [item.id, item.timeRange])));
  f.commit(d, '09:20，她仍站在屋内。', f.approval(d, '09:20，她仍站在屋内。', canon), { minutes: 560, quote: '09:20', rangeDigest });
  const before = f.read().topic!.formalPublicationRevision!;
  f.commit(d, '她已经走出屋外，信封保持完好。', f.approval(d, '她已经走出屋外，信封保持完好。', canon));
  const current = f.read();
  expect(current.topic!.formalPublicationRevision).toBe(before + 1);
  expect(current.topicState!.workingState!.state!.__topicUserCanon).toEqual(canon);
  expect(current.topicState!.workingState!.state!.__topicNarrativeTime).toBeUndefined();
  expect(current.topic!.lastPublicationRef?.contentChecksum).toBe(hash('她已经走出屋外，信封保持完好。'));
});

it.each(['source_revised', 'source_forgotten', 'bad_canon_hash', 'owner', 'room', 'topic', 'body_hash'] as const)('rolls back publication and the counter for %s', failure => {
  const f = fixture(), source = f.human('这是真实原始约束，不得开信。'), d = f.draft(source), text = '她保持信封完好。';
  const reviewed = f.approval(d, text, f.canon(source)), before = f.read().topic!.formalPublicationRevision;
  if (failure === 'source_revised') f.db.prepare("UPDATE messages SET content='same source ID with changed bytes' WHERE id=?").run(source.id);
  else if (failure === 'source_forgotten') f.store.request({ type: 'memory.forget', companionId: 'a', conversationId: f.room.id, sourceMessageIds: [source.id] });
  else if (failure === 'bad_canon_hash') reviewed.userCanon!.entries[0]!.sourceChecksum = 'f'.repeat(64);
  else if (failure === 'owner') reviewed.companionId = 'b';
  else if (failure === 'room') reviewed.conversationId = f.store.openPrivate('a').id;
  else if (failure === 'topic') reviewed.topicId = 'not_this_topic';
  else reviewed.contentChecksum = 'f'.repeat(64);
  expect(() => f.commit(d, text, reviewed)).toThrow();
  expect(f.store.getMessage(d.message.id).content).toBe(''); expect(f.read().topic!.formalPublicationRevision).toBe(before);
});

it('isolates another story port and treats missing legacy counters as zero without scanning topic history', () => {
  const f = fixture(), source = f.human(), d = f.draft(source), text = '她仍在门外。';
  f.db.prepare("UPDATE companion_topics SET data=json_remove(data,'$.formalPublicationRevision') WHERE id=?").run(f.topic.id);
  const reviewed = f.approval(d, text); expect(reviewed.expectedFormalPublicationRevision).toBe(0);
  const another = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'user', title: '独立另一篇', kind: 'story' }).topic!;
  f.human('另一篇的完全不同约束。', another.id);
  expect(f.read().topic!.formalPublicationRevision).toBeUndefined();
  f.commit(d, text, reviewed); expect(f.read().topic!.formalPublicationRevision).toBe(1);
});

it('stores the actual publication order even when the older-created pending message completes last', () => {
  const f = fixture(), s1 = f.human('第一项'), s2 = f.human('第二项'), old = f.draft(s1), next = f.draft(s2);
  f.commit(next, '她已走出屋外。');
  expect(f.read().topic!.lastPublicationRef?.messageId).toBe(next.message.id);
  f.commit(old, '她接着沿屋外小路前行。');
  expect(f.read().topic!.lastPublicationRef).toEqual({ messageId: old.message.id, authorId: 'a', contentChecksum: hash('她接着沿屋外小路前行。') });
  expect(f.read().topic!.lastPublicationAvailability).toBe('available');
  expect(old.message.sequence).toBeLessThan(next.message.sequence);
});

it.each(['forgotten', 'revised'] as const)('returns an opaque last-publication reference when the actual source is %s', invalidation => {
  const f = fixture(), source = f.human(), d = f.draft(source), text = 'PRIVATE_WITHDRAWN_PUBLICATION_REFERENCE';
  f.commit(d, text); const before = f.read().topic!;
  expect(before.lastPublicationRef?.messageId).toBe(d.message.id);
  if (invalidation === 'forgotten') f.store.request({ type: 'memory.forget', companionId: 'a', conversationId: f.room.id, sourceMessageIds: [d.message.id] });
  else f.db.prepare("UPDATE messages SET content='same ID different bytes' WHERE id=?").run(d.message.id);
  const hidden = f.read().topic!;
  expect(hidden.formalPublicationRevision).toBe(before.formalPublicationRevision);
  expect(hidden.lastPublicationAvailability).toBe('unavailable'); expect(hidden.lastPublicationRef).toBeUndefined();
  expect(JSON.stringify(hidden)).not.toContain(d.message.id); expect(JSON.stringify(hidden)).not.toContain(hash(text));
  if (invalidation === 'forgotten') expect(f.read('b').topic!.lastPublicationRef?.messageId).toBe(d.message.id);
  const updated = f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: hidden.id, readerId: 'a', expectedRevision: hidden.revision,
    patch: { workingState: { summary: '本人的整理，不授予原文读取权限。', sourceMessageIds: [] } } }).topic!;
  expect(updated.lastPublicationAvailability).toBe('unavailable'); expect(updated.lastPublicationRef).toBeUndefined();
});

it('does not accept free state JSON as a publication revision or last-publication authority', () => {
  const f = fixture(), source = f.human(), before = f.read().topic!;
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: before.id, readerId: 'a', expectedRevision: before.revision,
    patch: { workingState: { state: { formalPublicationRevision: 999, lastPublicationRef: { messageId: 'fake', contentChecksum: hash('fake'), authorId: 'b' } }, sourceMessageIds: [] } } });
  const current = f.read().topic!;
  expect(current.formalPublicationRevision).toBe(before.formalPublicationRevision);
  expect(current.lastPublicationRef?.messageId).toBe(source.id);
});
