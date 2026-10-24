// This suite isolates the host contract; semantic source binding has its own
// mechanism and opt-in actual-model suites.
vi.mock('../../src/main/companions/topic-narrative-references', () => ({ prepareTopicNarrativeReferences: async () => ({
  status: 'abstained', scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger', selectedSources: [], references: [], conflicts: [],
}) }));
vi.mock('../../src/main/companions/topic-summary-canon-review', () => ({ reviewTopicSummaryCanon: async () => undefined }));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed, type CompanionConnection } from '../../src/companions/store';
import { ensureTopicContinuity } from '../../src/main/companions/topic-compaction';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
import { companionTopicCapabilities } from '../../src/main/companions/topic-capabilities';
import { createHash } from 'node:crypto';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { companionTopicNarrativeBasis } from '../../src/shared/companion-topic-canon';

const roots: string[] = [], stores: CompanionsStore[] = [];
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '保持本人身份。', model: '', avatar: 'sister', proactive: false, active: true }));
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-topic-continuity-')) throw new Error('Unexpected topic continuity cleanup root.');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(kind: 'game' | 'story' | 'discussion' = 'game') {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-topic-continuity-')); roots.push(root);
  const file = path.join(root, 'companions.sqlite'), store = new CompanionsStore(file, seeds); stores.push(store);
  const room = store.request({ type: 'conversation.create-group', title: '研究合成群', memberIds: ['alice', 'bob'] }).conversation!;
  let topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '长活动', kind }).topic!;
  for (const readerId of ['alice', 'bob']) topic = store.request({ type: 'topic.join', conversationId: room.id, readerId, topicId: topic.id }).topic!;
  const messages = (count: number, prefix = 'SYNTHETIC') => Array.from({ length: count }, (_, index) => store.appendMessage({
    conversationId: room.id, topicId: topic.id, authorId: 'user', content: `${prefix}_${index}`, replyDirective: 'none',
  }));
  const read = (readerId = 'alice') => store.request({ type: 'topic.read', conversationId: room.id, topicId: topic.id, readerId });
  const summarize = vi.fn(async (context: { user: string }) => ({ summary: JSON.parse(context.user).messages.map((message: { content: string }) => message.content).join('|'), stage: '合成阶段' }));
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store.request(command);
  const frame = (): CompanionReplyInput => {
    const all = store.messages({ conversationId: room.id, topicId: topic.id, limit: 100 }).messages;
    const view = read();
    return { companion: store.request({ type: 'state' }).state!.companions.find(companion => companion.id === 'alice')!,
      conversation: room, topic: view.topic, topicState: view.topicState, messages: all, sourceMessage: all.at(-1), memories: [] };
  };
  const compress = (options: Partial<Parameters<typeof ensureTopicContinuity>[0]> = {}) => ensureTopicContinuity({ frame: frame(), request, summarize,
    review: async () => ({ supported: true, issues: [] }),
    extractCanon: async () => ({ additions: [], revisions: [] }),
    config: { model: 'unused', apiKey: 'unused', apiFormat: 'openai_chat' },
    policy: { maxMessages: 8, maxChars: 10000, thresholdRatio: .8, retainRatio: .16, minimumTailMessages: 2 }, ...options });
  const update = (readerId: string, patch: Extract<CompanionStorageCommand, { type: 'topic.update' }>['patch']) => store.request({
    type: 'topic.update', conversationId: room.id, topicId: topic.id, readerId, expectedRevision: read(readerId).topic!.revision, patch,
  });
  return { root, file, store, room, topic, messages, read, summarize, request, frame, compress, update };
}

function narrativeFixture() {
  const f = fixture('story'), hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const source = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'user', content: '只叙述09:00至09:30，不打开信。', replyDirective: 'none' });
  const message = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'alice', replyToId: source.id, content: '', loopStep: 0, replyDirective: 'none' });
  const canon = { version: 1 as const, throughSequence: source.sequence, entries: [{ id: hash('rule'), sourceMessageId: source.id,
    sourceChecksum: hash(source.content), quote: source.content, rule: source.content, timeRange: { start: 540, end: 570, includeStart: true, includeEnd: true } }] };
  const rangeDigest = hash(JSON.stringify(canon.entries.map(item => [item.id, item.timeRange])));
  const checkpoint: CompanionLoopCheckpoint = { companionId: 'alice', conversationId: f.room.id, sourceMessageId: source.id, messageId: message.id, status: 'running', turns: [], supplements: [] };
  f.store.request({ type: 'loop.save', checkpoint });
  const approval = (text: string) => ({ topicId: f.topic.id, quote: '09:25', minutes: 565, contentChecksum: hash(text), rangeDigest, userCanon: canon });
  return { ...f, source, message, canon, checkpoint, approval, hash };
}

it('atomically binds the first formal multi-turn reply and user canon, replays idempotently, and withdraws its original-source descendants', () => {
  const f = narrativeFixture(), first = '09:20，她走到窗边。', final = '09:25，她重新看表，信仍未开。';
  const done: CompanionLoopCheckpoint = { ...f.checkpoint, status: 'done', turns: [
    { text: first, rawText: first, calls: [] }, { text: final, rawText: final, calls: [], topicNarrativeApproval: f.approval(final) }] };
  f.store.request({ type: 'loop.save', checkpoint: done });
  const content = first + '\n\n' + final, state = f.read().topicState!.workingState!;
  expect(f.store.getMessage(f.message.id).content).toBe(content);
  expect(state.state!.__topicNarrativeTime).toMatchObject({ sourceMessageId: f.message.id, sourceChecksum: f.hash(content), minutes: 565 });
  expect(state.state!.__topicUserCanon).toEqual(f.canon);
  expect(state.sourceMessageIds).toEqual(expect.arrayContaining([f.source.id, f.message.id]));
  f.store.request({ type: 'loop.save', checkpoint: done });
  expect(f.read().topicState!.workingState!.sourceEventId).toBe(state.sourceEventId);
  const reopened = new CompanionsStore(f.file, seeds); stores.push(reopened);
  expect(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice' }).topicState!.workingState!.state!.__topicNarrativeTime).toEqual(state.state!.__topicNarrativeTime);
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [f.source.id] });
  expect(f.read().topicState?.workingState).toBeUndefined();
  expect(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice' }).topicState?.workingState).toBeUndefined();
});

it('rolls back the entire formal reply publication if a tail approval or exact user source is forged', () => {
  for (const failure of ['bad_turn_hash', 'bad_user_hash']) {
    const f = narrativeFixture(), text = '09:25，她看表。', approval = f.approval(text);
    if (failure === 'bad_turn_hash') approval.contentChecksum = 'f'.repeat(64);
    else approval.userCanon.entries[0]!.sourceChecksum = 'f'.repeat(64);
    expect(() => f.store.request({ type: 'loop.save', checkpoint: { ...f.checkpoint, status: 'done',
      turns: [{ text, rawText: text, calls: [], topicNarrativeApproval: approval }] } })).toThrow(/审批|原文/u);
    expect(f.store.getMessage(f.message.id).content).toBe('');
    expect(f.store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: f.source.id }).loop!.status).toBe('running');
    expect(f.read().topicState?.workingState).toBeUndefined();
  }
});

it('retains a rejected cached final byte for byte while publishing only its independently revised final', () => {
  const f = narrativeFixture(), stale = '09:25，她尚未检查门锁。', fresh = '09:25，她已经检查门锁，继续看门牌。';
  const checkpoint: CompanionLoopCheckpoint = { ...f.checkpoint, turns: [{ text: stale, rawText: stale, calls: [], topicNarrativeApproval: f.approval(stale) }] };
  f.store.request({ type: 'loop.save', checkpoint });
  checkpoint.turns[0]!.topicPublicationRejection = { rawTextChecksum: f.hash(stale), contentChecksum: f.hash(stale),
    reason: '实际新正文已经检查完门锁。', rejectedAt: '2026-10-24T00:00:00Z' };
  f.store.request({ type: 'loop.save', checkpoint });
  expect(f.store.getMessage(f.message.id).content).toBe('');
  expect(JSON.stringify(f.store.getMessage(f.message.id))).not.toContain(stale);
  checkpoint.turns.push({ text: fresh, rawText: fresh, calls: [], topicNarrativeApproval: f.approval(fresh) }); checkpoint.status = 'done';
  f.store.request({ type: 'loop.save', checkpoint });
  expect(f.store.getMessage(f.message.id).content).toBe(fresh);
  expect(f.store.getMessage(f.message.id).segments).toEqual([{ text: fresh, actionIds: [] }]);
  expect(f.store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: f.source.id }).loop?.turns[0]).toMatchObject({
    text: stale, rawText: stale, calls: [], topicPublicationRejection: { contentChecksum: f.hash(stale) } });
  const beforeReplay = f.read().topic;
  f.store.request({ type: 'loop.save', checkpoint });
  expect(f.read().topic?.formalPublicationRevision).toBe(beforeReplay?.formalPublicationRevision);
});

it.each(['raw_hash', 'text_hash', 'tool_turn', 'already_formal', 'remove', 'rewrite_reason', 'non_player'] as const)(
  'does not let final-rejection metadata hide or rewrite committed work (%s)', failure => {
    const f = failure === 'non_player' ? undefined : narrativeFixture();
    // Ordinary human replies can now revalidate an unpublished social final.
    // A peer-only discussion must not gain that host migration authority.
    const base = f ?? fixture('discussion'), source = f?.source ?? base.store.appendMessage({ conversationId: base.room.id,
      topicId: base.topic.id, authorId: 'bob', content: '伙伴本人的普通讨论消息。', replyDirective: 'none' });
    const message = f?.message ?? base.store.appendMessage({ conversationId: base.room.id, topicId: base.topic.id,
      authorId: 'alice', replyToId: source.id, content: '', loopStep: 0, replyDirective: 'none' });
    const hash = (text: string) => createHash('sha256').update(text).digest('hex'), text = '09:25，原最终草稿。';
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'alice', conversationId: base.room.id, sourceMessageId: source.id,
      messageId: message.id, status: failure === 'already_formal' ? 'done' : 'running', supplements: [], turns: [{ text, rawText: text,
        calls: failure === 'tool_turn' ? [{ id: 'confirmed_tool', name: 'world', arguments: '{}' }] : [],
        ...(failure === 'tool_turn' ? { results: [{ callId: 'confirmed_tool', content: '{"ok":true}' }] } : {}) }] };
    base.store.request({ type: 'loop.save', checkpoint });
    checkpoint.turns[0]!.topicPublicationRejection = { rawTextChecksum: hash(text), contentChecksum: hash(text), reason: '未发布提案冲突。', rejectedAt: '2026-10-24T00:00:00Z' };
    if (failure === 'raw_hash') checkpoint.turns[0]!.topicPublicationRejection.rawTextChecksum = hash('other');
    if (failure === 'text_hash') checkpoint.turns[0]!.topicPublicationRejection.contentChecksum = hash('other');
    if (failure === 'remove' || failure === 'rewrite_reason') {
      base.store.request({ type: 'loop.save', checkpoint });
      if (failure === 'remove') delete checkpoint.turns[0]!.topicPublicationRejection;
      else checkpoint.turns[0]!.topicPublicationRejection.reason = '被改写的拒绝理由';
    }
    expect(() => base.store.request({ type: 'loop.save', checkpoint })).toThrow(/最终草稿拒绝|已保存的最终/u);
    expect(base.store.getMessage(message.id).content).toBe(failure === 'remove' || failure === 'rewrite_reason' ? '' : text);
  });

it('rejects a formally truncated approved turn rather than persisting a time the actual message did not publish', () => {
  const f = narrativeFixture(), text = '09:25，她看表，仍未开信。';
  expect(() => f.store.request({ type: 'loop.save', checkpoint: { ...f.checkpoint, status: 'done', turns: [
    { text: '前'.repeat(65530), rawText: '前'.repeat(65530), calls: [] }, { text, rawText: text, calls: [], topicNarrativeApproval: f.approval(text) }] } })).toThrow('完整话题正文');
  expect(f.store.getMessage(f.message.id).content).toBe(''); expect(f.read().topicState?.workingState).toBeUndefined();
});

it.each(['', '她仍握着未打开的信。', ' '])('publishes exact full-reply approval when its last clock belongs to an earlier tool-bearing turn (final=%j)', final => {
  const f = narrativeFixture(), first = '09:25，她停在窗边。', content = [first, final].filter(Boolean).join('\n\n');
  const done: CompanionLoopCheckpoint = { ...f.checkpoint, status: 'done', turns: [
    { text: first, rawText: first, calls: [{ id: 'read-stage', name: 'world', arguments: '{}' }], results: [{ callId: 'read-stage', content: '{}' }] },
    { text: final, rawText: final, calls: [], topicNarrativeApproval: { ...f.approval(content), contentScope: 'full_reply' } }] };
  f.store.request({ type: 'loop.save', checkpoint: done });
  expect(f.store.getMessage(f.message.id).content).toBe(content);
  expect(f.read().topicState?.workingState?.state?.__topicNarrativeTime).toMatchObject({ minutes: 565, sourceChecksum: f.hash(content) });
  f.store.request({ type: 'loop.save', checkpoint: done });
  expect(f.store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: f.source.id }).loop?.status).toBe('done');
});

it.each(['earlier_turn_changed', 'only_last_turn_approved'])('rolls back full-reply publication when %s', failure => {
  const f = narrativeFixture(), first = '09:20，她来到窗边。', final = '09:25，她仍未开信。';
  const content = first + '\n\n' + final;
  const approval = { ...f.approval(failure === 'only_last_turn_approved' ? final : content), contentScope: 'full_reply' as const };
  expect(() => f.store.request({ type: 'loop.save', checkpoint: { ...f.checkpoint, status: 'done', turns: [
    { text: failure === 'earlier_turn_changed' ? '09:29，她来到窗边。' : first, rawText: first, calls: [] },
    { text: final, rawText: final, calls: [], topicNarrativeApproval: approval }] } })).toThrow('完整话题正文');
  expect(f.store.getMessage(f.message.id).content).toBe('');
  expect(f.store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: f.source.id }).loop?.status).toBe('running');
  expect(f.read().topicState?.workingState).toBeUndefined();
});

it('rejects overflowing combined prose even without a narrative approval instead of silently deleting a suffix', () => {
  const f = narrativeFixture(), first = '前'.repeat(32767), final = '后'.repeat(32768);
  const done: CompanionLoopCheckpoint = { ...f.checkpoint, status: 'done', turns: [
    { text: first, rawText: first, calls: [] }, { text: final, rawText: final, calls: [] }] };
  expect(() => f.store.request({ type: 'loop.save', checkpoint: done })).toThrow('不能静默截断');
  expect(f.store.getMessage(f.message.id).content).toBe('');
  expect(f.store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: f.source.id }).loop?.status).toBe('running');
  done.turns[1]!.text = done.turns[1]!.rawText = '后'.repeat(32767);
  f.store.request({ type: 'loop.save', checkpoint: done });
  expect(f.store.getMessage(f.message.id).content).toHaveLength(65536);
});

it('does not let a late older pending reply overwrite an already published user correction', () => {
  const f = narrativeFixture();
  const source = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'user',
    content: '更正前面的窗口，以后只叙述10:00至10:30，不打开信。', replyDirective: 'none' });
  const message = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'alice', replyToId: source.id,
    content: '', loopStep: 0, replyDirective: 'none' });
  const text = '10:05，她仍未打开信。', canon = { version: 1 as const, throughSequence: source.sequence, entries: [{
    id: f.hash('corrected-rule'), sourceMessageId: source.id, sourceChecksum: f.hash(source.content), quote: source.content, rule: source.content,
    timeRange: { start: 600, end: 630, includeStart: true, includeEnd: true } }] };
  f.store.request({ type: 'loop.save', checkpoint: { ...f.checkpoint, sourceMessageId: source.id, messageId: message.id, status: 'done',
    turns: [{ text, rawText: text, calls: [], topicNarrativeApproval: { topicId: f.topic.id, minutes: 605, quote: '10:05',
      contentChecksum: f.hash(text), rangeDigest: f.hash(JSON.stringify(canon.entries.map(item => [item.id, item.timeRange]))), userCanon: canon } }] } });
  const current = f.read().topicState!.workingState!;
  const oldText = '09:25，她仍未打开信。';
  expect(() => f.store.request({ type: 'loop.save', checkpoint: { ...f.checkpoint, status: 'done',
    turns: [{ text: oldText, rawText: oldText, calls: [], topicNarrativeApproval: f.approval(oldText) }] } })).toThrow(/约束|审批|变化/u);
  expect(f.store.getMessage(f.message.id).content).toBe('');
  expect(f.read().topicState!.workingState).toEqual(current);
});

it('rejects a stale full-reply approval if another pending reply publishes a newer formal tail in the same window', () => {
  const f = narrativeFixture(), oldText = '09:20，她仍未开信。';
  const approval = { ...f.approval(oldText), quote: '09:20', minutes: 560, contentScope: 'full_reply' as const,
    expectedStateChecksum: f.hash(companionTopicNarrativeBasis(f.read().topicState?.workingState)) };
  const source = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'user', content: '继续同一窗口。', replyDirective: 'none' });
  const message = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'alice', replyToId: source.id, content: '', loopStep: 0, replyDirective: 'none' });
  const text = '09:25，她仍未打开信。';
  f.store.request({ type: 'loop.save', checkpoint: { ...f.checkpoint, sourceMessageId: source.id, messageId: message.id, status: 'done',
    turns: [{ text, rawText: text, calls: [], topicNarrativeApproval: f.approval(text) }] } });
  const current = f.read().topicState!.workingState!;
  expect(() => f.store.request({ type: 'loop.save', checkpoint: { ...f.checkpoint, status: 'done',
    turns: [{ text: oldText, rawText: oldText, calls: [], topicNarrativeApproval: approval }] } })).toThrow('审批后已经变化');
  expect(f.store.getMessage(f.message.id).content).toBe(''); expect(f.read().topicState!.workingState).toEqual(current);
});

it('allows summary-only progress during review and an exact idempotent replay without treating timestamps as narrative changes', () => {
  const f = narrativeFixture(), text = '09:25，她仍未开信。';
  const approval = { ...f.approval(text), contentScope: 'full_reply' as const,
    expectedStateChecksum: f.hash(companionTopicNarrativeBasis(f.read().topicState?.workingState)) };
  f.update('alice', { workingState: { summary: '只是更新整理进度，没有新的时间或规则。', stage: '摘要前缀已核对', sourceMessageIds: [] } });
  const done: CompanionLoopCheckpoint = { ...f.checkpoint, status: 'done', turns: [{ text, rawText: text, calls: [], topicNarrativeApproval: approval }] };
  f.store.request({ type: 'loop.save', checkpoint: done }); const current = f.read().topicState!.workingState!;
  f.store.request({ type: 'loop.save', checkpoint: done });
  expect(f.read().topicState!.workingState).toEqual(current);
  expect(current.summary).toBe('只是更新整理进度，没有新的时间或规则。');
  expect(f.store.getMessage(f.message.id).content).toBe(text);
});

it('continues an actual fork with only its verified inherited user canon and keeps ancestor withdrawal binding', () => {
  const f = narrativeFixture(), text = '09:25，她停下。';
  f.store.request({ type: 'loop.save', checkpoint: { ...f.checkpoint, status: 'done', turns: [{ text, rawText: text, calls: [], topicNarrativeApproval: f.approval(text) }] } });
  const branch = f.store.request({ type: 'topic.fork', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice', title: '本人续写分支' }).topic!;
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: branch.id, readerId: 'user' });
  const source = f.store.appendMessage({ conversationId: f.room.id, topicId: branch.id, authorId: 'user', content: '继续本分支。', replyDirective: 'none' });
  const message = f.store.appendMessage({ conversationId: f.room.id, topicId: branch.id, authorId: 'alice', replyToId: source.id, content: '', loopStep: 0, replyDirective: 'none' });
  const next = '09:26，她继续看窗外。', checkpoint: CompanionLoopCheckpoint = { ...f.checkpoint, messageId: message.id, sourceMessageId: source.id, status: 'done',
    turns: [{ text: next, rawText: next, calls: [], topicNarrativeApproval: { ...f.approval(next), topicId: branch.id, minutes: 566, quote: '09:26' } }] };
  f.store.request({ type: 'loop.save', checkpoint });
  const state = () => f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: branch.id, readerId: 'alice' }).topicState;
  expect(state()!.workingState!.state!.__topicNarrativeTime).toMatchObject({ sourceMessageId: message.id, minutes: 566 });
  expect(state()!.workingState!.state!.__topicUserCanon).toEqual(f.canon);
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [f.source.id] });
  expect(state()?.workingState).toBeUndefined();
});

it('scans past more than one page of withdrawn sources without sending them to the compactor or repeating a prefix', async () => {
  const f = fixture(), hidden = f.messages(110, 'WITHDRAWN'), legal = f.messages(8, 'VISIBLE');
  for (let offset = 0; offset < hidden.length; offset += 100) f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id,
    sourceMessageIds: hidden.slice(offset, offset + 100).map(message => message.id) });
  const result = await f.compress();
  expect(f.summarize).toHaveBeenCalledOnce();
  expect(f.summarize.mock.calls[0]![0].user).not.toContain('WITHDRAWN');
  expect(result.messages.map(message => message.id)).toEqual(legal.slice(-2).map(message => message.id));
  expect(result.topicState?.workingState?.state?.__continuity).toMatchObject({ throughSequence: legal[5]!.sequence, scannedThroughSequence: legal.at(-1)!.sequence });
});

it('retains cumulative event provenance across compactions and restart, and withdraws descendants from both topic reads and discovery', async () => {
  const f = fixture(), first = f.messages(8, 'EARLY'); await f.compress();
  const earlier = f.read().topicState!.workingState!;
  f.messages(6, 'LATER'); await f.compress();
  const latest = f.read().topicState!.workingState!;
  expect(latest.derivedFromEventIds).toContain(earlier.sourceEventId);
  expect(latest.sourceMessageIds).not.toContain(first[0]!.id);
  const reopened = new CompanionsStore(f.file, seeds); stores.push(reopened);
  expect(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice' }).topicState?.workingState).toBeDefined();
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [first[0]!.id] });
  expect(f.read().topicState?.workingState).toBeUndefined();
  const recalled = f.store.request({ type: 'memory.world_query', companionId: 'alice', conversationId: f.room.id, category: 'topics', topicId: f.topic.id });
  expect(recalled.worldKnowledge?.items[0]).not.toHaveProperty('workingState');
  expect(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice' }).topicState?.workingState).toBeUndefined();
  f.summarize.mockClear(); await f.compress();
  expect(f.summarize.mock.calls.every(([context]) => !context.user.includes('EARLY_0'))).toBe(true);
});

it('preserves host user canon through ordinary state and summary updates without detaching its original source DAG', async () => {
  const f = fixture(), first = f.messages(8, 'USER_CANON');
  await f.compress({ extractCanon: async () => ({ additions: [{ sourceMessageId: first[0]!.id,
    quote: first[0]!.content, rule: '用户精确规则不能被助手正文覆盖。' }], revisions: [] }) });
  const original = f.read().topicState!.workingState!, canon = original.state!.__topicUserCanon;
  expect(canon).toMatchObject({ version: 1, entries: [{ sourceMessageId: first[0]!.id, quote: first[0]!.content }] });
  expect(() => f.update('alice', { workingState: { state: { __topicUserCanon: { entries: [] } }, sourceMessageIds: [] } })).toThrow('不能由模型');
  expect(() => f.update('user', { shared: { state: { __topicUserCanon: canon }, sourceMessageIds: [] } })).toThrow('不能由模型');
  f.update('alice', { workingState: { state: { stage: '新私态' }, sourceMessageIds: [] } });
  expect(f.read().topicState!.workingState!.state!.__topicUserCanon).toEqual(canon);
  const partialEvent = f.read().topicState!.workingState!.sourceEventId;
  f.update('alice', { workingState: { summary: '助手换一份摘要，不能删除用户硬规则。', sourceMessageIds: [] } });
  expect(f.read().topicState!.workingState!.state!.__topicUserCanon).toEqual(canon);
  expect(f.read().topicState!.workingState!.derivedFromEventIds).toContain(partialEvent);
  const reopened = new CompanionsStore(f.file, seeds); stores.push(reopened);
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [first[0]!.id] });
  expect(f.read().topicState?.workingState).toBeUndefined();
  expect(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice' }).topicState?.workingState).toBeUndefined();
  f.update('alice', { workingState: { state: { independent: true }, sourceMessageIds: [] } });
  expect(f.read().topicState!.workingState!.state).toEqual({ independent: true });
});

it('invalidates a retained user canon when its exact original bytes change, even after a summary replacement', async () => {
  const f = fixture(), first = f.messages(8, 'EXACT_CANON');
  await f.compress({ extractCanon: async () => ({ additions: [{ sourceMessageId: first[0]!.id, quote: first[0]!.content, rule: '精确原文' }], revisions: [] }) });
  f.update('alice', { workingState: { summary: '替换叙事不替换来源', sourceMessageIds: [] } });
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(f.file);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  try { db.prepare('UPDATE messages SET content=? WHERE id=?').run('原文被实际更正', first[0]!.id); }
  finally { db.close(); }
  expect(f.read().topicState?.workingState).toBeUndefined();
});

it('rejects withdrawal during summarization without committing a watermark', async () => {
  const f = fixture(), messages = f.messages(8);
  await expect(f.compress({ summarize: async () => {
    f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [messages[0]!.id] });
    return { summary: '不能发布', stage: '失效' };
  } })).rejects.toThrow('来源已失效');
  expect(f.read().topicState?.workingState).toBeUndefined();
});

it('cancels a stale invocation when its current source is withdrawn while an older prefix is summarized', async () => {
  const f = fixture(), messages = f.messages(8);
  await expect(f.compress({ summarize: async () => {
    f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [messages.at(-1)!.id] });
    return { summary: '旧片段仍合法，但本次调用已经撤回', stage: '取消' };
  } })).rejects.toThrow('调用来源已经失效');
  expect(f.read().topicState?.workingState).toBeUndefined();
});

it('revalidates source visibility inside the atomic commit, after the last asynchronous read', async () => {
  const f = fixture(), messages = f.messages(8);
  await expect(f.compress({ request: async command => {
    if (command.type === 'topic.update' && command.compaction) f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [messages[0]!.id] });
    return f.store.request(command);
  } })).rejects.toThrow('来源已经失效');
  expect(f.read().topicState?.workingState).toBeUndefined();
});

it('rejects a shared-rule change during compression rather than attaching the new revision to an old summary', async () => {
  const f = fixture(); f.messages(8);
  await expect(f.compress({ summarize: async () => {
    f.update('user', { shared: { summary: '新规则', sourceMessageIds: [] } });
    return { summary: '按旧规则形成的摘要', stage: '过时' };
  } })).rejects.toThrow('工作状态在压缩期间已变化');
  expect(f.read().topicState?.workingState).toBeUndefined();
});

it('tracks shared checkpoints and retained state through provenance, and does not resurrect invalid state on a partial write', async () => {
  const f = fixture(), messages = f.messages(8);
  f.update('user', { shared: { summary: '有来源的规则', sourceMessageIds: [messages[0]!.id] } });
  const sharedEvent = f.read().topicState!.shared!.sourceEventId;
  await f.compress();
  expect(f.read().topicState!.workingState!.derivedFromEventIds).toContain(sharedEvent);
  f.update('alice', { workingState: { state: { pending: '仍待核实' }, sourceMessageIds: [] } });
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [messages[0]!.id] });
  expect(f.read().topicState?.workingState).toBeUndefined();
  f.update('alice', { workingState: { state: { independent: '全新设置' }, sourceMessageIds: [] } });
  expect(JSON.stringify(f.read().topicState)).not.toContain('有来源的规则');
  expect(f.read().topicState?.workingState?.state).toEqual({ independent: '全新设置' });
});

it('invalidates changed or removed ancestry instead of treating missing events as valid', async () => {
  const f = fixture(), messages = f.messages(8); await f.compress();
  const predecessor = f.read().topicState!.workingState!.sourceEventId;
  f.messages(6); await f.compress();
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(f.file);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  try {
    db.prepare('UPDATE messages SET content=? WHERE id=?').run('EDITED_ORIGINAL', messages[0]!.id);
    expect(f.read().topicState?.workingState).toBeUndefined();
    db.prepare('UPDATE messages SET content=? WHERE id=?').run('SYNTHETIC_0', messages[0]!.id);
    expect(f.read().topicState?.workingState).toBeDefined();
    db.prepare('DELETE FROM companion_topic_events WHERE id=?').run(predecessor);
    expect(f.read().topicState?.workingState).toBeUndefined();
  } finally { db.close(); }
});

it('keeps paused readers and unrelated topics out of the summarizer', async () => {
  const f = fixture(); f.messages(8);
  const view = f.read(); f.store.request({ type: 'topic.pause', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice', expectedRevision: view.topic!.revision });
  await expect(f.compress()).rejects.toThrow('暂停'); expect(f.summarize).not.toHaveBeenCalled();
  const other = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'bob', title: 'BOB_OTHER_TOPIC_SECRET', kind: 'story' }).topic!;
  f.store.appendMessage({ conversationId: f.room.id, topicId: other.id, authorId: 'bob', content: 'OTHER_PRIVATE_STORY', replyDirective: 'none' });
  const paused = f.read(); f.store.request({ type: 'topic.resume', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice', expectedRevision: paused.topic!.revision });
  await f.compress(); expect(f.summarize.mock.calls[0]![0].user).not.toContain('OTHER_PRIVATE_STORY');
});

it('uses a fresh topic as a clean new episode while reopen restores exactly the old episode', async () => {
  const f = fixture(); f.messages(8, 'OLD_EPISODE'); await f.compress();
  f.update('user', { shared: { summary: 'OLD_RULE_17', state: { phase: 'old-final' }, sourceMessageIds: [] } });
  f.update('alice', { workingState: { state: { ownRole: 'OLD_ALICE_ROLE', oldVote: 'player_3' }, sourceMessageIds: [] } });
  const old = f.read().topicState;
  f.store.request({ type: 'topic.close', conversationId: f.room.id, topicId: f.topic.id, readerId: 'user', expectedRevision: f.read('user').topic!.revision });
  const fresh = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'alice', title: '全新第二局', kind: 'game' });
  expect(fresh.topic!.id).not.toBe(f.topic.id); expect(fresh.topic!.forkedFromTopicId).toBeUndefined();
  expect(fresh.topicState!.workingState).toBeUndefined(); expect(fresh.topicState!.shared).toBeUndefined();
  expect(f.store.messages({ conversationId: f.room.id, topicId: fresh.topic!.id }).messages).toEqual([]);
  expect(fresh.topic!.participantIds).toEqual(['alice']); expect(fresh.topic!.invitedIds).toContain('bob');
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: fresh.topic!.id, readerId: 'bob' });
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: fresh.topic!.id, readerId: 'bob' }).topicState!.workingState).toBeUndefined();
  const reopened = f.store.request({ type: 'topic.reopen', conversationId: f.room.id, topicId: f.topic.id, readerId: 'user', expectedRevision: f.read('user').topic!.revision });
  expect(reopened.topic!.id).toBe(f.topic.id); expect(f.read().topicState).toEqual(old);
  const independent = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: fresh.topic!.id, readerId: 'alice' });
  expect(JSON.stringify(independent.topicState)).not.toContain('OLD_');
});
it('allows explicit topic management in an owned target room without changing the caller port or bypassing source and private-state ACLs', async () => {
  const f = fixture(), privateRoom = f.store.openPrivate('alice');
  f.update('bob', { workingState: { summary: 'BOB_PRIVATE_TARGET_ROOM', sourceMessageIds: [] } });
  const capabilities = companionTopicCapabilities(f.request, { companionId: 'alice', conversationId: privateRoom.id });
  const call = (id: string, parameters: Record<string, unknown>) => capabilities.execute({ id, name: 'world', arguments: JSON.stringify({ action: 'topic', parameters }) });
  const read = await call('read_owned_target', { action: 'read', roomId: f.room.id, topicId: f.topic.id }) as CompanionStorageResponse;
  expect(read.topic!.conversationId).toBe(f.room.id); expect(read.topicState!.readerId).toBe('alice');
  expect(JSON.stringify(read)).not.toContain('BOB_PRIVATE_TARGET_ROOM');
  expect(privateRoom.id).not.toBe(f.room.id);
  const privateSource = f.store.appendMessage({ conversationId: privateRoom.id, authorId: 'user', content: 'PRIVATE_SOURCE_MUST_NOT_BE_USED_IN_GROUP_TOPIC', replyDirective: 'none' });
  await expect(call('cross_source_rejected', { action: 'update', roomId: f.room.id, topicId: f.topic.id, expectedRevision: f.read().topic!.revision,
    patch: { workingState: { summary: '不能跨会话引用', sourceMessageIds: [privateSource.id] } } })).rejects.toThrow('真实发言');
  const ownSource = f.messages(1, 'OWN_TARGET_SOURCE')[0]!;
  const updated = await call('update_owned_target', { action: 'update', roomId: f.room.id, topicId: f.topic.id, expectedRevision: f.read().topic!.revision,
    patch: { workingState: { summary: '只记录目标群的实际进展', sourceMessageIds: [ownSource.id] } } }) as CompanionStorageResponse;
  expect(updated.topicState!.workingState!.sourceMessageIds).toEqual([ownSource.id]);
  const foreign = f.store.openPrivate('bob');
  await expect(call('foreign_room_denied', { action: 'create', roomId: foreign.id, title: '越权创建', kind: 'discussion' })).rejects.toThrow('不属于');
  await expect(call('wrong_topic_room_denied', { action: 'read', roomId: privateRoom.id, topicId: f.topic.id })).rejects.toThrow('别的会话');
});

it('forks immutable public and caller-private snapshots without cloning anyone else, then revalidates ancestor evidence', async () => {
  const f = fixture(), first = f.messages(8, 'BRANCH_SOURCE');
  f.update('user', { shared: { summary: 'OLD_SHARED_RULE', sourceMessageIds: [first[0]!.id] } });
  f.update('bob', { workingState: { summary: 'BOB_OLD_SECRET', state: { role: 'BOB_PRIVATE_ROLE' }, sourceMessageIds: [] } });
  await f.compress(); f.update('alice', { workingState: { state: { role: 'ALICE_PRIVATE_ROLE' }, sourceMessageIds: [] } });
  const old = f.read().topicState!, fork = f.store.request({ type: 'topic.fork', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice', title: '同一进度的替代分支' });
  expect(fork.topic!.forkedFromTopicId).toBe(f.topic.id); expect(fork.topic!.participantIds).toEqual(['alice']);
  expect(fork.topicState!.shared).toEqual(old.shared); expect(fork.topicState!.workingState).toEqual(old.workingState);
  expect(f.store.messages({ conversationId: f.room.id, topicId: fork.topic!.id }).messages).toEqual([]);
  expect(JSON.stringify(fork)).not.toContain('BOB_PRIVATE_ROLE');
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: fork.topic!.id, readerId: 'bob' });
  const bobBranch = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: fork.topic!.id, readerId: 'bob' });
  expect(bobBranch.topicState!.workingState).toBeUndefined(); expect(bobBranch.topicState!.shared!.summary).toBe('OLD_SHARED_RULE');
  f.update('user', { shared: { summary: 'PARENT_NEW_RULE', sourceMessageIds: [] } });
  f.update('alice', { workingState: { state: { role: 'PARENT_NEW_ROLE' }, sourceMessageIds: [] } });
  const branch = () => f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: fork.topic!.id, readerId: 'alice' });
  expect(branch().topicState!.shared!.summary).toBe('OLD_SHARED_RULE');
  expect(branch().topicState!.workingState!.state!.role).toBe('ALICE_PRIVATE_ROLE');
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [first[0]!.id] });
  expect(branch().topicState!.workingState).toBeUndefined(); expect(branch().topicState!.shared).toBeUndefined();
  const fresh = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'alice', title: '全新独立局', kind: 'game' });
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: fresh.topic!.id, readerId: 'alice', expectedRevision: fresh.topic!.revision,
    patch: { workingState: { summary: 'INDEPENDENT_NEW_ROLE', sourceMessageIds: [] } } });
  f.store.request({ type: 'topic.delete', conversationId: f.room.id, topicId: f.topic.id, readerId: 'user', expectedRevision: f.read('user').topic!.revision });
  expect(branch().topicState!.workingState).toBeUndefined();
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: fresh.topic!.id, readerId: 'alice' }).topicState!.workingState!.summary).toBe('INDEPENDENT_NEW_ROLE');
});

it('deduplicates host topic effects across retries and restart, rejects payload collisions, and never recreates deleted forks', () => {
  const f = fixture();
  const command = { type: 'topic.create' as const, conversationId: f.room.id, readerId: 'alice', title: '唯一新话题', kind: 'story' as const, operationId: 'invocation_step_slot_1' };
  const created = f.store.request(command).topic!;
  expect(f.store.request(command).topic?.id).toBe(created.id);
  expect(() => f.store.request({ ...command, title: '不同参数' })).toThrow('不同参数');
  const fork = { type: 'topic.fork' as const, conversationId: f.room.id, readerId: 'alice', topicId: created.id, title: '唯一派生', operationId: 'invocation_step_slot_2' };
  const forked = f.store.request(fork).topic!;
  const reopened = new CompanionsStore(f.file, seeds); stores.push(reopened);
  expect(reopened.request(fork).topic?.id).toBe(forked.id);
  f.store.request({ type: 'topic.delete', conversationId: f.room.id, readerId: 'user', topicId: forked.id, expectedRevision: forked.revision, operationId: 'delete_once' });
  expect(() => reopened.request(fork)).toThrow('当前读者');
  expect(f.store.request({ type: 'topic.list', conversationId: f.room.id, readerId: 'user' }).topics?.filter(topic => topic.title === '唯一派生')).toHaveLength(0);
});

it('replays a topic join as its current state without rejoining after the reader has left', () => {
  const f = fixture();
  f.store.request({ type: 'topic.leave', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice' });
  const join = { type: 'topic.join' as const, conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice', operationId: 'join_once' };
  f.store.request(join);
  f.store.request({ type: 'topic.leave', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice' });
  expect(f.store.request(join).topic?.participantIds).not.toContain('alice');
});

it('preserves more than 256 historical source dependencies without flattening them into one checkpoint', async () => {
  const f = fixture(), messages = f.messages(304, 'LONG_HISTORY');
  await f.compress({ policy: { maxMessages: 32, maxChars: 10000, thresholdRatio: .8, retainRatio: .16, minimumTailMessages: 4 } });
  const checkpoint = f.read().topicState!.workingState!;
  expect(f.summarize.mock.calls.length).toBeGreaterThan(8);
  expect(checkpoint.sourceMessageIds.length).toBeLessThanOrEqual(32);
  expect(checkpoint.derivedFromEventIds!.length).toBeLessThanOrEqual(2);
  expect((checkpoint.state!.__continuity as { throughSequence: number }).throughSequence).toBeGreaterThan(messages[255]!.sequence);
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [messages[0]!.id] });
  expect(f.read().topicState?.workingState).toBeUndefined();
});

it('can summarize witnessed historical speech after that speaker leaves the topic', async () => {
  const f = fixture();
  const departed = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'bob', content: 'BOB_ACTUALLY_SAID_THIS', replyDirective: 'none' });
  f.messages(7);
  f.store.request({ type: 'topic.leave', conversationId: f.room.id, topicId: f.topic.id, readerId: 'bob' });
  const result = await f.compress();
  expect(result.topicState?.workingState?.sourceMessageIds).toContain(departed.id);
  expect(result.topicState?.workingState?.summary).toContain('BOB_ACTUALLY_SAID_THIS');
});
