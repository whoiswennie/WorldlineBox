/** Host-only synthetic coverage QA: no actor, game choices, or paid model. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { ensureTopicContinuity } from '../../src/main/companions/topic-compaction';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
const checksum = (text: string) => createHash('sha256').update(text).digest('hex');

const resources: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => {
  for (const { root, store } of resources.splice(0)) {
    store.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('topic-publication-page-boundary-'))
      throw new Error('Unexpected publication coverage fixture root.');
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(kind: 'game' | 'discussion' = 'game') {
  const root = mkdtempSync(path.join(tmpdir(), 'topic-publication-page-boundary-'));
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['reader', 'peer'].map(id => ({ id, name: id, persona: '独立角色',
    description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  resources.push({ root, store });
  const room = store.createConversation('真实分页边界', ['reader', 'peer']);
  const topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'reader', title: '公开记录', kind, participantIds: ['user', 'peer'] }).topic!;
  for (const readerId of ['user', 'peer']) store.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId });
  const append = (content: string) => store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'user', content, replyDirective: 'none' });
  const frame = (visible: CompanionMessage[]): CompanionReplyInput => {
    const current = store.request({ type: 'topic.read', conversationId: room.id, topicId: topic.id, readerId: 'reader' });
    return { companion: store.state().companions.find(role => role.id === 'reader')!, conversation: room, topic: current.topic, topicState: current.topicState,
      messages: visible, sourceMessage: visible.at(-1), contextThroughSequence: visible.at(-1)?.sequence, memories: [] };
  };
  const batches: string[][] = [], batchBodies: Array<Array<{ id: string; content: string }>> = [];
  const compress = (input: CompanionReplyInput, options: Partial<Parameters<typeof ensureTopicContinuity>[0]> = {}) => ensureTopicContinuity({ frame: input,
    request: async (command: CompanionStorageCommand) => store.request(command),
    summarize: async context => { const messages: Array<{ id: string; content: string }> = JSON.parse(context.user).messages;
      batches.push(messages.map(message => message.id)); batchBodies.push(messages);
      return { summary: messages.find(message => message.content.startsWith('ACTUAL_LATE_PUBLICATION_'))?.content
        ?? '已核对实际公开记录并保留未决事项，原始出处仍可重读。', stage: '当前公开阶段' }; },
    extractCanon: async () => ({ additions: [], revisions: [] }), review: async () => ({ supported: true, issues: [] }),
    config: { model: 'no-model', apiKey: 'no-model', apiFormat: 'openai_chat' },
    fetchFn: async () => { throw new Error('This coverage fixture must not dispatch model transport.'); },
    policy: { maxMessages: 8, maxChars: 10000, thresholdRatio: .8, retainRatio: .16, minimumTailMessages: 2 }, ...options });
  const draft = (source: CompanionMessage) => {
    const message = store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'reader', replyToId: source.id,
      content: '', loopStep: 0, replyDirective: 'none' });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'reader', conversationId: room.id, sourceMessageId: source.id,
      messageId: message.id, status: 'running', turns: [], supplements: [] };
    store.request({ type: 'loop.save', checkpoint });
    return { message, publish: (text: string) => store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done', turns: [{ text, rawText: text, calls: [] }] } }) };
  };
  return { store, room, topic, append, frame, batches, batchBodies, compress, draft };
}

it.each(['game', 'discussion'] as const)('scans past a full page of abandoned drafts to actual formal %s sources without summarizing a draft', async kind => {
  const f = fixture(kind), original = f.append('原始公开任务，只有正式内容才可作为摘要事实。');
  const drafts = Array.from({ length: 100 }, (_, index) => f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id,
    authorId: 'reader', replyToId: original.id, content: 'UNPUBLISHED_DRAFT_' + index, loopStep: 0, replyDirective: 'none' }));
  const formal = Array.from({ length: 8 }, (_, index) => f.append('实际正式记录_' + index + '：' + '保留原作者、已做步骤与未决条件。'.repeat(10)));
  const result = await f.compress(f.frame(formal.slice(-2)));
  expect(f.batches.length).toBeGreaterThan(0);
  const represented = new Set([...f.batches.flat(), ...result.messages.map(message => message.id)]);
  for (const message of [original, ...formal]) expect(represented.has(message.id), message.id).toBe(true);
  for (const draft of drafts) expect(represented.has(draft.id), draft.id).toBe(false);
  expect(JSON.stringify(result.topicState?.workingState)).not.toContain('UNPUBLISHED_DRAFT_');
  expect(result.topicState?.workingState?.sourceEventId).toBeTruthy();
});

it.each(['game', 'discussion'] as const)('covers late-only formal %s bodies with no new message sequence and never lowers the existing sequence watermark', async kind => {
  const f = fixture(kind), original = f.append('开始当前公开记录。'), firstDraft = f.draft(original);
  const bridge = f.append('原用户继续当前公开记录。'), secondDraft = f.draft(bridge);
  const formal = Array.from({ length: 8 }, (_, index) => f.append('初始正式记录_' + index + '：' + '保留实际事实与未完成条件。'.repeat(12)));
  const initial = await f.compress(f.frame(formal.slice(-2)));
  const through = (initial.topicState!.workingState!.state!.__continuity as { throughSequence: number }).throughSequence;
  expect(through).toBeGreaterThan(firstDraft.message.sequence);
  const text = 'ACTUAL_LATE_PUBLICATION_A：原作者确认门已关闭。';
  expect(firstDraft.publish(text).ok).toBe(true);
  expect(secondDraft.publish('ACTUAL_LATE_PUBLICATION_B：另一条稍后确认的实际公开事实。').ok).toBe(true);
  // Capacity-feedback QA is a bounded host compression request. It never
  // invents a user message or plays a game to make the watermark advance.
  for (let pass = 0; pass < 3; pass++) await f.compress({ ...f.frame(formal.slice(-2)), sourceMessage: undefined }, { capacityFeedback: true });
  const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' }).topicState!.workingState!;
  expect(f.batchBodies.flat()).toEqual(expect.arrayContaining([expect.objectContaining({ id: firstDraft.message.id, content: text })]));
  expect(current.summary).toContain(text);
  expect((current.state!.__continuity as { throughSequence: number }).throughSequence).toBeGreaterThanOrEqual(through);
  expect(f.store.getMessage(firstDraft.message.id).sequence).toBe(firstDraft.message.sequence);
  expect(f.store.messages({ conversationId: f.room.id, after: formal.at(-1)!.sequence }).messages).toEqual([]);
});

it('includes an older draft published after the frozen root publication without inventing a later human request', async () => {
  const f = fixture(), original = f.append('原始公开要求。'), delayed = f.draft(original);
  const earlier = Array.from({ length: 8 }, (_, index) => f.append('正式背景_' + index + '：' + '保留准确原作者与真实条件。'.repeat(12)));
  const source = f.append('当前真实原请求，继续核对这些公开记录。');
  await f.compress(f.frame([...earlier.slice(-1), source]));
  const text = 'ACTUAL_LATE_PUBLICATION_FIXED_ROOT：较早草稿现在才正式确认门已关闭。';
  expect(delayed.publish(text).ok).toBe(true);
  const result = await f.compress(f.frame([source]));
  const represented = [...f.batchBodies.flat(), ...result.messages];
  expect(represented).toEqual(expect.arrayContaining([expect.objectContaining({ id: delayed.message.id, content: text })]));
  expect(f.store.messages({ conversationId: f.room.id, after: source.sequence }).messages).toEqual([]);
});

it('admits a real same-source peer reply within the host context horizon', async () => {
  const f = fixture('discussion'), source = f.append('请各本人回复这次公开事项。');
  const reply = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'peer', replyToId: source.id,
    content: '这是本人真实给同一source的回信。', replyDirective: 'none' });
  const result = await f.compress({ ...f.frame([source]), contextThroughSequence: reply.sequence });
  expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: reply.id, content: reply.content })]));
});

it('does not advance old-task publication coverage past a later human barrier and permanently lose that human source', () => {
  const f = fixture('discussion'), original = f.append('第一个实际任务。'), later = f.append('第二个独立真人任务，不能悄悄吃进旧任务。');
  const barrierRevision = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' }).topic!.formalPublicationRevision!;
  const reply = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'peer', replyToId: original.id,
    content: '旧任务在新请求之后才到的真实回信。', replyDirective: 'none' });
  const query = { type: 'topic.compaction.sources' as const, conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader',
    afterPublicationRevision: 0, legacyAfterSequence: 0, beforeSequence: reply.sequence, sourceMessageId: original.id, sourceChecksum: checksum(original.content), limit: 100 };
  const first = f.store.request(query).topicCompactionPage!;
  expect(first.items.some(item => item.message.id === later.id)).toBe(false);
  expect(first.afterPublicationRevision).toBeLessThan(barrierRevision);
  const next = f.store.request({ ...query, sourceMessageId: later.id, sourceChecksum: checksum(later.content), afterPublicationRevision: first.afterPublicationRevision,
    legacyAfterSequence: first.legacyScannedThroughSequence }).topicCompactionPage!;
  expect(next.items).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ id: later.id, content: later.content }) })]));
});

it.each(['consumed-source', 'original-source'] as const)('does not commit summary or coverage after actual %s withdrawal during summarization', async target => {
  const f = fixture(), formal = Array.from({ length: 8 }, (_, index) => f.append('合法原文_' + index + '：' + '保留事实、归属与条件。'.repeat(15)));
  let calls = 0;
  await expect(f.compress(f.frame(formal.slice(-2)), { summarize: async context => {
    calls++;
    const sources: Array<{ id: string }> = JSON.parse(context.user).messages;
    const id = target === 'original-source' ? formal.at(-1)!.id : sources[0]!.id;
    expect(f.store.request({ type: 'memory.forget', companionId: 'reader', conversationId: f.room.id, sourceMessageIds: [id] }).ok).toBe(true);
    return { summary: '这份提案尚未提交，原文随后实际撤回。', stage: '实际来源变化' };
  } })).rejects.toThrow(/来源|原文|失效|变化/u);
  expect(calls).toBe(1);
  const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' });
  expect(current.topicState?.workingState).toBeUndefined();
  expect(current.topicState?.workingState?.state?.__continuity).toBeUndefined();
});

it.each(['working-state', 'formal-publication'] as const)('rejects an in-flight summary when actual concurrent %s changes its host basis', async mutation => {
  const f = fixture('discussion'), formal = Array.from({ length: 8 }, (_, index) => f.append('原始正式记录_' + index + '：' + '保留事实、归属与条件。'.repeat(15)));
  let calls = 0;
  await expect(f.compress(f.frame(formal.slice(-2)), { summarize: async () => {
    calls++;
    if (mutation === 'working-state') {
      const read = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' });
      expect(f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader', expectedRevision: read.topic!.revision,
        patch: { workingState: { summary: '并发本人状态已真实更新。', state: { concurrentMarker: 'ACTUAL_CONCURRENT_OWNER_STATE' }, sourceMessageIds: [formal[0]!.id] } } }).ok).toBe(true);
    } else f.append('另一条并发正式发布的真人新输入，旧摘要不能冒充已经覆盖。');
    return { summary: 'STALE_SUMMARY_MUST_NOT_COMMIT', stage: '这是旧提案' };
  } })).rejects.toThrow(/原文|来源|状态|覆盖|发布|变化/u);
  expect(calls).toBe(1);
  const state = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' }).topicState?.workingState;
  expect(JSON.stringify(state ?? null)).not.toContain('STALE_SUMMARY_MUST_NOT_COMMIT');
  expect(state?.state?.__continuity).toBeUndefined();
  if (mutation === 'working-state') expect(state?.state?.concurrentMarker).toBe('ACTUAL_CONCURRENT_OWNER_STATE');
});

it('keeps one exact protected root verbatim while consuming its later publication, then really consumes that old root only once under the next source', async () => {
  const f = fixture(), original = f.append('最早的公开记录。'), delayed = f.draft(original);
  const earlier = Array.from({ length: 8 }, (_, index) => f.append('完整背景_' + index + '：' + '保留准确原作者与真实条件。'.repeat(12)));
  const source = f.append('THIS_EXACT_ROOT_MUST_STAY_VERBATIM：本次原请求逐字保留，不得压进自己的工作摘要。');
  await f.compress(f.frame([...earlier.slice(-1), source]));
  const late = 'ACTUAL_LATE_PUBLICATION_PROTECTED_ROOT：真实旧稿确认门已关闭。' + '完整受检正文。'.repeat(90);
  expect(delayed.publish(late).ok).toBe(true);
  const batches: Array<Array<{ id: string; content: string }>> = [];
  const summarize = async (context: { user: string }) => {
    const batch: Array<{ id: string; content: string }> = JSON.parse(context.user).messages; batches.push(batch);
    return { summary: '保留实际公开进度：门已关闭，旧原请求按真实新来源继续核对。', stage: '已核对当前公开事实' };
  };
  let result: CompanionReplyInput | undefined;
  for (let pass = 0; pass < 3 && !batches.flat().some(message => message.id === delayed.message.id); pass++)
    result = await f.compress(f.frame([source]), { capacityFeedback: true, summarize });
  expect(batches.flat()).toEqual(expect.arrayContaining([expect.objectContaining({ id: delayed.message.id, content: late })]));
  expect(batches.flat().some(message => message.id === source.id)).toBe(false);
  expect(result!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: source.id, content: source.content })]));
  expect(result!.topicState?.workingState?.state?.__continuity).toMatchObject({ publicationCoverage: {
    protectedSource: { messageId: source.id, sourceChecksum: checksum(source.content) } } });
  const next = f.append('这是下一个真实原请求，继续核对仍有效的公开事实。');
  await f.compress(f.frame([next]), { capacityFeedback: true, summarize });
  await f.compress(f.frame([next]), { summarize });
  const consumedOldRoot = batches.flat().filter(message => message.id === source.id);
  expect(consumedOldRoot).toHaveLength(1); expect(consumedOldRoot[0]).toMatchObject({ id: source.id, content: source.content });
  const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' });
  expect(current.topicState?.workingState?.state?.__continuity).toMatchObject({ publicationCoverage: {
    protectedSource: { messageId: next.id, sourceChecksum: checksum(next.content) } } });
  f.store.request({ type: 'memory.forget', companionId: 'reader', conversationId: f.room.id, sourceMessageIds: [source.id] });
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' }).topicState?.workingState).toBeUndefined();
});

it('fails explicitly without truncation or coverage advancement when the current protected source alone exceeds the actual compression window', async () => {
  const f = fixture('discussion'), content = '单一完整原请求：' + '保留每个原文字符。'.repeat(1500), source = f.append(content);
  const summarize = vi.fn(async () => ({ summary: '不应调用', stage: '不应调用' }));
  await expect(f.compress(f.frame([source]), { capacityFeedback: true, summarize })).rejects.toMatchObject({ code: 'CONTEXT_CAPACITY' });
  expect(summarize).not.toHaveBeenCalled(); expect(f.store.getMessage(source.id).content).toBe(content);
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' }).topicState?.workingState).toBeUndefined();
});
