import { expect, it, vi } from 'vitest';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { ensureTopicContinuity, projectTopicContinuity } from '../../src/main/companions/topic-compaction';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionTopicState } from '../../src/shared/companion-topic';
import type { CompanionMessage } from '../../src/shared/companions';

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
    if (command.type === 'message.get') return { ok: true, message: messages.find(message => message.id === command.id) };
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
  return { frame, request, messages, config, policy };
}
it('persists one owner-topic summary, retains a verbatim tail, and preserves private work state without changing the source log', async () => {
  const f = fixture(), initial = JSON.stringify(f.messages);
  const summarize = vi.fn(async context => {
    const data = JSON.parse(context.user); expect(data.topic.id).toBe('game'); expect(data.owner.companionId).toBe('alice');
    expect(data.priorCheckpoint.state.ownRole).toBe('PRIVATE_ALICE_WOLF'); expect(context.user).not.toContain('OTHER_ROLE_SECRET');
    return { summary: '规则编号RULE_701仍有效。已完成前六次实际发言，继续当前局。', stage: '第一局白天' };
  });
  const result = await ensureTopicContinuity({ ...f, summarize });
  expect(result.messages.map(message => message.id)).toEqual(['m_6', 'm_7']);
  expect(result.topicState?.workingState?.state?.ownRole).toBe('PRIVATE_ALICE_WOLF');
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
it('does not apply another topic or another character compaction watermark', () => {
  const f = fixture(); f.frame.topicState!.workingState!.state = { __continuity: { topicId: 'foreign', companionId: 'bob', conversationId: 'group',
    throughSequence: 1000, sourceDigest: 'fake', compactedMessages: 1000, createdAt: '2026-10-23T00:00:00Z' } };
  expect(projectTopicContinuity(f.frame).messages).toHaveLength(8);
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
