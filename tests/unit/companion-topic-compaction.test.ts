// This suite isolates the host contract; semantic source binding has its own
// mechanism and opt-in actual-model suites.
vi.mock('../../src/main/companions/topic-narrative-references', () => ({ prepareTopicNarrativeReferences: async () => ({
  status: 'abstained', scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger', selectedSources: [], references: [], conflicts: [],
}) }));
vi.mock('../../src/main/companions/topic-summary-canon-review', () => ({ reviewTopicSummaryCanon: async () => undefined }));
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { CompanionTopicCompactionChanged, ensureTopicContinuity, projectTopicContinuity } from '../../src/main/companions/topic-compaction';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionTopicState } from '../../src/shared/companion-topic';
import type { CompanionMessage } from '../../src/shared/companions';
import { CompanionModelError } from '../../src/main/companions/model';

function fixture() {
  const stamp = '2026-10-23T00:00:00Z';
  const messages: CompanionMessage[] = Array.from({ length: 8 }, (_, i) => ({ id: 'm_' + i, sequence: i + 1, conversationId: 'group', topicId: 'game',
    authorId: i % 2 ? 'alice' : 'user', content: i ? '实际发言_' + i : '本局规则与不能忘记的编号 RULE_701',
    kind: 'text' as const, status: 'sent' as const, attachments: [], createdAt: stamp }));
  const topic = { id: 'game', conversationId: 'group', title: '长局游戏', kind: 'game' as const, status: 'active' as const,
    participantIds: ['alice', 'user'], invitedIds: [], moderatorId: 'user', revision: 1, tags: ['狼人杀'], createdAt: stamp, updatedAt: stamp };
  let state: CompanionTopicState = { topicId: 'game', readerId: 'alice', trust: 'topic_state_not_real_world_facts', workingState: {
    sourceEventId: 'initial', authorId: 'user', revision: 1, updatedAt: stamp, sourceMessageIds: [], state: { ownRole: 'PRIVATE_ALICE_WOLF' } } };
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'topic.read') { expect(command.readerId).toBe('alice'); return { ok: true, topic: { ...topic }, topicState: structuredClone(state) }; }
    if (command.type === 'messages') return { ok: true, messages: messages.filter(message => message.topicId === command.topicId
      && message.sequence > (command.after ?? 0) && message.sequence < (command.before ?? Infinity)).slice(0, command.limit) };
    if (command.type === 'topic.compaction.sources') {
      const source = messages.find(message => message.id === command.sourceMessageId);
      const through = command.throughPublicationRevision ?? Math.min(command.beforeSequence, source?.sequence ?? Infinity);
      const selected = messages.filter(message => message.sequence > command.afterPublicationRevision && message.sequence <= through).slice(0, command.limit ?? 100);
      const cursor = selected.at(-1)?.sequence ?? through;
      return { ok: true, topicCompactionPage: { items: selected.map(message => ({ message, publicationRevision: message.sequence,
        sourceChecksum: createHash('sha256').update(message.content).digest('hex') })), afterPublicationRevision: cursor,
        throughPublicationRevision: through, legacyScannedThroughSequence: command.legacyThroughSequence ?? command.beforeSequence,
        legacyThroughSequence: command.legacyThroughSequence ?? command.beforeSequence, legacyComplete: true, hasMore: cursor < through } };
    }
    if (command.type === 'message.get') return { ok: true, message: messages.find(message => message.id === command.id) };
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: messages.filter(message => command.ids.includes(message.id)) };
    if (command.type === 'topic.update') {
      expect(command.maintenance).toBe(true); expect(command.readerId).toBe('alice'); expect(command.expectedRevision).toBe(topic.revision);
      topic.revision++; state = { ...state, workingState: { ...command.patch.workingState!, sourceEventId: 'compressed_' + topic.revision,
        sourceMessageIds: command.patch.workingState?.sourceMessageIds ?? [], updatedAt: stamp, authorId: command.readerId, revision: topic.revision } }; return { ok: true, topic: { ...topic }, topicState: structuredClone(state) };
    }
    throw new Error('Unexpected compaction operation ' + command.type);
  });
  const frame: CompanionReplyInput = { companion: { id: 'alice', name: 'Alice', description: '', persona: '只扮演自己。', model: '', avatar: 'sister',
    builtin: false, proactive: false, createdAt: stamp }, conversation: { id: 'group', kind: 'group', title: '群', memberIds: ['alice'], pinned: false,
    muted: false, unread: 0, lastMessage: '', updatedAt: stamp }, messages, memories: [], sourceMessage: messages.at(-1), topic, topicState: state };
  const config = { apiFormat: 'openai_chat' as const, model: 'synthetic', apiKey: 'fixture-only' };
  const policy = { maxMessages: 8, maxChars: 10000, thresholdRatio: .8, retainRatio: .16, minimumTailMessages: 2 };
  return { frame, request, messages, config, policy, review: async () => ({ supported: true, issues: [] }),
    extractCanon: async () => ({ additions: [], revisions: [] }),
    adjudicate: async (context: { user: string }) => ({ upheldIssueIndexes: JSON.parse(context.user).proposedIssues.map((_issue: unknown, index: number) => index) }) };
}
it('persists one owner-topic summary, retains a verbatim tail, and preserves private work state without changing the source log', async () => {
  const f = fixture(), initial = JSON.stringify(f.messages);
  f.frame.topicState!.workingState!.state!.__topicNarrativeTime = { sourceMessageId: 'retained_future_reply', sourceChecksum: 'a'.repeat(64),
    minutes: 600, quote: 'UNCONSUMED_NARRATIVE_TAIL', rangeDigest: 'b'.repeat(64) };
  const summarize = vi.fn(async context => {
    const data = JSON.parse(context.user); expect(data.topic.id).toBe('game'); expect(data.owner.companionId).toBe('alice');
    expect(data.priorCheckpoint.state.ownRole).toBe('PRIVATE_ALICE_WOLF'); expect(context.user).not.toMatch(/OTHER_ROLE_SECRET|UNCONSUMED_NARRATIVE_TAIL/u);
    return { summary: '规则编号RULE_701仍有效。已完成前六次实际发言，继续当前局。', stage: '第一局白天' };
  });
  const result = await ensureTopicContinuity({ ...f, summarize });
  expect(result.messages.map(message => message.id)).toEqual(['m_6', 'm_7']);
  expect(result.topicState?.workingState?.state?.ownRole).toBe('PRIVATE_ALICE_WOLF');
  expect(result.topicState?.workingState?.state?.__topicNarrativeTime).toEqual(f.frame.topicState!.workingState!.state!.__topicNarrativeTime);
  expect(result.topicState?.workingState?.summary).toContain('RULE_701');
  expect(JSON.stringify(f.messages)).toBe(initial); expect(summarize).toHaveBeenCalledOnce();
  const next = await ensureTopicContinuity({ ...f, frame: result, summarize });
  expect(next.messages).toEqual(result.messages); expect(summarize).toHaveBeenCalledOnce();
});
it('does not advance or discard messages after a failed or stale compaction', async () => {
  const f = fixture();
  await expect(ensureTopicContinuity({ ...f, summarize: async () => { throw new Error('auxiliary model failed'); } })).rejects.toThrow('model failed');
  expect(f.request.mock.calls.some(([command]) => command.type === 'topic.update')).toBe(false);
  await expect(ensureTopicContinuity({ ...f, summarize: async () => { f.messages[0]!.content = '来源已更正'; return { summary: '过时摘要', stage: '旧阶段' }; } })).rejects.toThrow('原文已变化');
  expect(f.request.mock.calls.some(([command]) => command.type === 'topic.update')).toBe(false);
  expect(f.frame.messages).toHaveLength(8);
});
it('registers the exact prefix and captured checkpoints before any extraction or summary model reads them', async () => {
  const f = fixture(), order: string[] = [];
  f.messages[0]!.content += '；实际读集登记顺序回归。';
  const bindInputs = vi.fn(async input => {
    order.push('bound');
    expect(input).toEqual({ sourceVersions: f.messages.slice(0, 6).map(message => ({ id: message.id, revision: 1,
      checksum: createHash('sha256').update(message.content).digest('hex') })), checkpointEventIds: ['initial'] });
  });
  await ensureTopicContinuity({ ...f, bindInputs, extractCanon: async () => {
    expect(order).toEqual(['bound']); order.push('canon'); return { additions: [], revisions: [] };
  }, summarize: async () => {
    expect(order).toEqual(['bound', 'canon']); order.push('summary'); return { summary: 'RULE_701仍有效。', stage: '继续' };
  } });
  expect(order).toEqual(['bound', 'canon', 'summary']); expect(bindInputs).toHaveBeenCalledOnce();
});
it('does not dispatch extraction, review or summary when the actual maintenance read-set cannot be registered', async () => {
  const f = fixture(), extractCanon = vi.fn(), summarize = vi.fn(), review = vi.fn();
  await expect(ensureTopicContinuity({ ...f, extractCanon, summarize, review,
    bindInputs: async () => { throw new Error('source withdrawn before dispatch'); } })).rejects.toThrow('source withdrawn');
  expect(extractCanon).not.toHaveBeenCalled(); expect(summarize).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  expect(f.request.mock.calls.some(([command]) => command.type === 'topic.update')).toBe(false);
});
it('yields an old maintenance claim before reading or summarizing a newer checkpoint as its old source range', async () => {
  const f = fixture();
  const current = await ensureTopicContinuity({ ...f, summarize: async () => ({ summary: 'RULE_701仍有效。', stage: '继续' }) });
  const previousPages = f.request.mock.calls.filter(([command]) => command.type === 'topic.compaction.sources').length;
  const summarize = vi.fn(), extractCanon = vi.fn(), source = f.messages[0]!;
  await expect(ensureTopicContinuity({ ...f, summarize, extractCanon, frame: { ...current, sourceMessage: source, messages: [source],
    contextThroughSequence: source.sequence, contextThroughPublicationRevision: 1 } })).rejects.toBeInstanceOf(CompanionTopicCompactionChanged);
  expect(f.request.mock.calls.filter(([command]) => command.type === 'topic.compaction.sources')).toHaveLength(previousPages);
  expect(summarize).not.toHaveBeenCalled(); expect(extractCanon).not.toHaveBeenCalled();
});

it('never sends legacy canon paraphrases to either the compactor or its critic while keeping stored history exact', async () => {
  const f = fixture(), legacy = { version: 1, throughSequence: 1, entries: [{ id: 'quoted', sourceMessageId: 'm_0', sourceChecksum: 'a'.repeat(64),
    quote: f.messages[0]!.content, rule: 'UNSOURCED_LEGACY_GENDER' }] };
  f.frame.topicState!.workingState!.state!.__topicUserCanon = legacy;
  const result = await ensureTopicContinuity({ ...f, summarize: async context => {
    expect(context.user).not.toContain('UNSOURCED_LEGACY_GENDER');
    expect(JSON.parse(context.user).userCanon.entries[0].rule).toBeUndefined();
    return { summary: 'RULE_701仍有效，前六条已发生。', stage: '继续' };
  }, review: async context => { expect(context.user).not.toContain('UNSOURCED_LEGACY_GENDER'); return { supported: true, issues: [] }; } });
  expect((result.topicState!.workingState!.state!.__topicUserCanon as typeof legacy).entries[0]!.rule).toBe('UNSOURCED_LEGACY_GENDER');
});
it('reduces older complete topic messages only after actual capacity feedback and keeps the exact current source', async () => {
  const f = fixture(), source = structuredClone(f.frame.sourceMessage);
  const summarize = vi.fn(async () => ({ summary: 'RULE_701仍有效；已处理旧片段。', stage: '继续' }));
  const result = await ensureTopicContinuity({ ...f, policy: { ...f.policy, maxMessages: 32 }, capacityFeedback: true, summarize });
  expect(summarize).toHaveBeenCalledOnce(); expect(result.messages.map(message => message.id)).toEqual(['m_4', 'm_5', 'm_6', 'm_7']);
  expect(result.sourceMessage).toEqual(source); expect(result.topicState!.workingState!.state!.__continuity).toMatchObject({ throughSequence: 4 });
});
it('splits a provider-rejected summary batch without skipping any unconsumed topic source', async () => {
  const f = fixture(), sizes: number[] = [], registered: string[][] = [];
  const result = await ensureTopicContinuity({ ...f, capacityFeedback: true,
    bindInputs: async input => { registered.push(input.sourceVersions.map(source => source.id)); }, summarize: async context => {
    const data = JSON.parse(context.user); sizes.push(data.messages.length);
    expect(registered.at(-1)).toEqual(data.messages.map((message: { id: string }) => message.id));
    if (data.messages.length > 1) throw new CompanionModelError('CONTEXT_CAPACITY', 'fixture provider capacity');
    return { summary: 'RULE_701', stage: '继续' };
  } });
  expect(sizes).toEqual([4, 2, 1]); expect(result.topicState!.workingState!.state!.__continuity).toMatchObject({ throughSequence: 1 });
  expect(registered.map(sources => sources.length)).toEqual([4, 2, 1]);
  expect(result.messages.map(message => message.id)).toEqual(f.messages.slice(1).map(message => message.id));
});
it('does not apply another topic or another character compaction watermark', () => {
  const f = fixture(); f.frame.topicState!.workingState!.state = { __continuity: { topicId: 'foreign', companionId: 'bob', conversationId: 'group',
    throughSequence: 1000, sourceDigest: 'fake', compactedMessages: 1000, createdAt: '2026-10-23T00:00:00Z' } };
  expect(projectTopicContinuity(f.frame).messages).toHaveLength(8);
});
it('keeps queue inspection and wake status out of the provider evidence for a frozen source port', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
  try {
    const f = fixture(), coverage = { maintenanceState: 'pending', requestedThroughSequence: 8, checkedThroughSequence: 0,
      checkpointCreationSequence: 0, completeHistory: false as const, rawMessagesRetained: true as const, notice: '更早原文仍可按需读取。' };
    const before = buildCompanionContext({ ...f.frame, topicContinuityCoverage: coverage });
    const after = buildCompanionContext({ ...f.frame, topicContinuityCoverage: { ...coverage, maintenanceState: 'completed',
      requestedThroughSequence: 1000, checkedThroughSequence: 1000 } });
    expect(after).toEqual(before);
    const body = JSON.parse(before.user);
    expect(body.topicContinuityCoverage).toEqual({ checkpointCreationSequence: 0, completeHistory: false, rawMessagesRetained: true,
      notice: coverage.notice });
    expect(buildCompanionContext({ ...f.frame, topicContinuityCoverage: { ...coverage, checkpointCreationSequence: 6 } }).user).not.toBe(before.user);
  } finally { vi.useRealTimers(); }
});
it('does not let a later user request create compaction pressure in the frozen source port', async () => {
  const f = fixture(), source = f.messages.at(-1)!;
  f.messages.push({ ...source, id: 'later_user', sequence: 9, authorId: 'user', content: '另一个新任务，不能进入旧推理' },
    { ...source, id: 'formal_peer', sequence: 10, authorId: 'bob', replyToId: source.id, content: '对本次source的正式合作回复' });
  f.frame.contextThroughSequence = 10;
  const summarize = vi.fn();
  await ensureTopicContinuity({ ...f, policy: { ...f.policy, maxMessages: 12 }, summarize });
  expect(summarize).not.toHaveBeenCalled();
});
it('corrects a malformed summary once against the same sources before publishing', async () => {
  const f = fixture();
  const summarize = vi.fn().mockResolvedValueOnce({ summary: '缺少阶段，不可直接提交' })
    .mockImplementationOnce(async context => {
      expect(JSON.parse(context.user).formatCorrection.issues[0].path).toEqual(['stage']);
      expect(JSON.parse(context.user).messages.map((message: { id: string }) => message.id)).toEqual(f.messages.slice(0, 6).map(message => message.id));
      return { summary: '规则RULE_701与当前进展已保留。', stage: '第一局' };
    });
  const result = await ensureTopicContinuity({ ...f, summarize });
  expect(summarize).toHaveBeenCalledTimes(2); expect(result.topicState?.workingState?.stage).toBe('第一局');
  expect(f.request.mock.calls.filter(([command]) => command.type === 'topic.update')).toHaveLength(1);
});
it('stops after one summary when the host cannot expose the committed watermark', async () => {
  const f = fixture(), summarize = vi.fn(async () => ({ summary: '摘要', stage: '阶段' }));
  await expect(ensureTopicContinuity({ ...f, summarize, request: async command => {
    const response = await f.request(command);
    return command.type === 'topic.update' ? { ...response, topicState: { ...response.topicState!, workingState: undefined } } : response;
  } })).rejects.toThrow('水位未推进');
  expect(summarize).toHaveBeenCalledOnce();
});

it('cancels a queued reader promptly without releasing the still-running predecessor lock', async () => {
  const f = fixture(); let release!: (value: { summary: string; stage: string }) => void;
  const summarizing = vi.fn(() => new Promise<{ summary: string; stage: string }>(resolve => { release = resolve; }));
  const first = ensureTopicContinuity({ ...f, summarize: summarizing });
  await vi.waitFor(() => expect(summarizing).toHaveBeenCalledOnce());
  const controller = new AbortController();
  const cancelled = expect(ensureTopicContinuity({ ...f, signal: controller.signal, summarize: vi.fn() })).rejects.toThrow();
  controller.abort(); await cancelled;
  const thirdSummary = vi.fn();
  const third = ensureTopicContinuity({ ...f, summarize: thirdSummary });
  await Promise.resolve(); expect(thirdSummary).not.toHaveBeenCalled();
  release({ summary: '前一调用完整保存', stage: '原阶段' });
  await first; await third;
  expect(thirdSummary).not.toHaveBeenCalled();
});

it('repairs a contradictory summary against exactly the same prefix before advancing its watermark', async () => {
  const f = fixture();
  const summarize = vi.fn().mockResolvedValueOnce({ summary: '规则变为RULE_999且已结束。', stage: '结束' })
    .mockImplementationOnce(async context => {
      const input = JSON.parse(context.user);
      expect(input.continuityCorrection.rejectedDraft).toBeUndefined();
      expect(input.continuityCorrection.correction).toContain('RULE_701');
      expect(input.messages.map((message: { id: string }) => message.id)).toEqual(f.messages.slice(0, 6).map(message => message.id));
      return { summary: '规则RULE_701仍有效，实际只完成前六次发言。', stage: '继续' };
    });
  const review = vi.fn().mockResolvedValueOnce({ supported: false, issues: [{ claim: '规则变为RULE_999且已结束', claimQuote: '规则变为RULE_999且已结束',
    basis: 'm_0规定RULE_701；无结束凭证', basisQuote: '本局规则与不能忘记的编号 RULE_701', correction: '恢复RULE_701和未结束阶段。' }] })
    .mockResolvedValueOnce({ supported: true, issues: [] });
  const result = await ensureTopicContinuity({ ...f, summarize, review });
  expect(result.topicState?.workingState?.summary).toContain('RULE_701');
  expect(summarize).toHaveBeenCalledTimes(2); expect(review).toHaveBeenCalledTimes(2);
  expect(f.request.mock.calls.filter(([command]) => command.type === 'topic.update')).toHaveLength(1);
});

it('rejects oversized accumulated history in the same slot without feeding rejected drafts back or advancing', async () => {
  const f = fixture(), prompts: string[] = [], original = JSON.stringify(f.frame);
  const summarize = vi.fn(async context => { prompts.push(context.user); return { summary: '累加旧章'.repeat(1000), stage: '阶段' }; });
  await expect(ensureTopicContinuity({ ...f, summarize })).rejects.toThrow();
  expect(summarize).toHaveBeenCalledTimes(3);
  for (const prompt of prompts) {
    const data = JSON.parse(prompt); expect(data.workingSummaryBudget.maxCombinedChars).toBe(3000);
    expect(prompt).not.toContain('累加旧章'); expect(data.continuityCorrection?.rejectedDraft).toBeUndefined();
  }
  expect(prompts[2]!.length).toBe(prompts[1]!.length);
  expect(f.request.mock.calls.some(([command]) => command.type === 'topic.update')).toBe(false);
  expect(JSON.stringify(f.frame)).toBe(original);
});

it('never publishes or advances a factually rejected summary after its bounded retries', async () => {
  const f = fixture(), summarize = vi.fn(async () => ({ summary: '规则被助手改写', stage: '结束' }));
  const review = vi.fn(async () => ({ supported: false, issues: [{ claim: '规则被助手改写', claimQuote: '规则被助手改写', basis: 'm_0 RULE_701', basisQuote: '本局规则与不能忘记的编号 RULE_701', correction: '恢复有效原规则' }] }));
  await expect(ensureTopicContinuity({ ...f, summarize, review })).rejects.toThrow('水位保持不变');
  expect(summarize).toHaveBeenCalledTimes(3); expect(review).toHaveBeenCalledTimes(3);
  expect(f.request.mock.calls.some(([command]) => command.type === 'topic.update')).toBe(false);
  expect(f.messages).toHaveLength(8);
});
