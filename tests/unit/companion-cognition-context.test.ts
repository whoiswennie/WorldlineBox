import { describe, expect, it } from 'vitest';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { assembleCompanionInvocation, type CompanionInvocationContext } from '../../src/main/companions/invocation-context';
import { selectCompanionDialogue } from '../../src/main/companions/context-window';
import { companionRepeatedObservation, projectCompanionEvidenceHistory, projectCompanionToolHistory } from '../../src/main/companions/context-tool-history';
import { normalizeCompanionCapabilityCall, COMPANION_MEMORY_CAPABILITY_TOOL, COMPANION_WORLD_CAPABILITY_TOOL } from '../../src/shared/companion-capability-tools';
import type { CompanionMessage } from '../../src/shared/companions';
import { companionReplyIdentityIssue } from '../../src/main/companions/reply-identity';

const at = '2026-10-22T08:00:00Z';
const message = (id: string, sequence: number, content = id, patch: Partial<CompanionMessage> = {}): CompanionMessage => ({
  id, sequence, content, conversationId: 'room-a', authorId: 'user', kind: 'text', status: 'sent', attachments: [], createdAt: at, ...patch,
});
const base: CompanionReplyInput = {
  companion: { id: 'alice', name: '艾莉', description: '', persona: '完整稳定人格：谨慎且好奇。', model: '', avatar: 'custom', builtin: false, proactive: false, createdAt: at },
  conversation: { id: 'room-a', kind: 'group', title: 'A群', memberIds: ['alice', 'bob'], pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '' },
  members: [{ id: 'alice', name: '艾莉', description: '' }, { id: 'bob', name: '波波', description: '' }], messages: [], memories: [],
};
describe('independent cognition message ports', () => {
  it('shares formal replies to this group source through a separate host cursor without importing the next user task', () => {
    const source = message('source-a', 1, '请一起核对资料');
    const context = buildCompanionContext({ ...base, sourceMessage: source, contextThroughSequence: 5,
      taskRequest: { sourceMessageId: source.id, prompt: source.content }, messages: [source,
        message('bob-answer', 2, '波波已正式说明他的检查结果', { authorId: 'bob', replyToId: source.id }),
        message('next-user-task', 3, 'NEXT_USER_TASK_SENTINEL'),
        message('next-bob-answer', 4, 'NEXT_REPLY_SENTINEL', { authorId: 'bob', replyToId: 'next-user-task' }),
        message('draft-answer', 5, 'DRAFT_SENTINEL', { authorId: 'bob', replyToId: source.id, isReplyDraft: true })] });
    const data = JSON.parse(context.user);
    expect(data.messages.map((row: { id: string }) => row.id)).toEqual(['source-a', 'bob-answer']);
    expect(context.user).not.toMatch(/NEXT_USER_TASK_SENTINEL|NEXT_REPLY_SENTINEL|DRAFT_SENTINEL/);
    expect(data.identity.currentReply.sourceMessageId).toBe(source.id);
    expect(data.taskRequest.prompt).toBe(source.content); expect(data.dialogueWindow.throughSequence).toBe(5);
  });
  it('never imports another private room, group, outsider or forged source/reference into recent dialogue', () => {
    const source = message('request', 5, '让波波帮我核对。');
    const context = buildCompanionContext({ ...base, sourceMessage: source,
      messages: [message('private-secret', 1, 'PRIVATE_SENTINEL', { conversationId: 'private-bob' }),
        message('other-group', 2, 'OTHER_GROUP_SENTINEL', { conversationId: 'room-b' }),
        message('outsider', 3, 'OUTSIDER_SENTINEL', { authorId: 'charlie' }), message('bob', 4, '我先读资料', { authorId: 'bob' }), source],
      taskRequest: { sourceMessageId: source.id, prompt: source.content, replyReference: { id: 'other-group', authorId: 'user', content: 'FOREIGN_REFERENCE_SENTINEL', conversationId: 'room-b' } } });
    const data = JSON.parse(context.user);
    expect(context.user).not.toMatch(/PRIVATE_SENTINEL|OTHER_GROUP_SENTINEL|OUTSIDER_SENTINEL|FOREIGN_REFERENCE_SENTINEL/);
    expect(data.messages.map((row: { id: string }) => row.id)).toEqual(['bob', 'request']);
    expect(data.messages[0].author).toMatchObject({ id: 'bob', type: 'companion', name: '波波' });
    expect(data.messages[1].author).toMatchObject({ id: 'user', type: 'human_player' });
    expect(data.identity.self.id).toBe('alice'); expect(data.identity.currentReply.speaker.id).toBe('user');
    expect(data.identity.currentReply.addressee.id).toBe('user');
  });
  it('uses exact invocation message ids for independent tasks even inside the same conversation', () => {
    const invocation: CompanionInvocationContext = { id: 'activity-a', kind: 'activity', companionId: 'alice', conversationId: 'room-a',
      goal: '拜访波波并等真实回复', status: 'waiting', createdAt: at, messagePort: { kind: 'invocation', messageIds: ['own-step'] },
      authorization: { kind: 'self', sourceMessageIds: [], externalActions: false } };
    const context = buildCompanionContext({ ...base, invocation, messages: [message('own-step', 1, '任务A真实进度'),
      message('other-step', 2, 'TASK_B_SENTINEL'), message('group-chatter', 3, 'GROUP_CHATTER_SENTINEL')],
      ongoingGoals: [{ id: invocation.id, companionId: 'alice', conversationId: 'room-a', kind: 'activity', status: 'waiting', goal: invocation.goal, updatedAt: at },
        { id: 'private-work', companionId: 'alice', conversationId: 'private-alice', kind: 'work', status: 'running', goal: 'PRIVATE_GOAL_SENTINEL', updatedAt: at },
        { id: 'other-task', companionId: 'alice', conversationId: 'room-a', kind: 'activity', status: 'waiting', goal: 'OTHER_TASK_GOAL_SENTINEL', updatedAt: at }] });
    expect(context.user).toContain('任务A真实进度'); expect(context.user).not.toMatch(/TASK_B_SENTINEL|GROUP_CHATTER_SENTINEL|PRIVATE_GOAL_SENTINEL|OTHER_TASK_GOAL_SENTINEL/);
    expect(JSON.parse(context.user).ongoingGoals[0].goal).toBe(invocation.goal);
    expect(() => assembleCompanionInvocation({ ...base, invocation: { ...invocation, companionId: 'bob' } })).toThrow('身份');
    expect(() => assembleCompanionInvocation({ ...base, invocation: { ...invocation, conversationId: 'room-b' } })).toThrow('入口');
  });
  it('keeps concurrent topics, ordinary dialogue and private goal state out of each other inside the same group', () => {
    const source = message('topic-a-source', 10, '当前狼人杀A公开发言', { topicId: 'topic-a' });
    const context = buildCompanionContext({ ...base, sourceMessage: source, messages: [source,
      message('topic-b', 9, 'OTHER_TOPIC_SENTINEL', { topicId: 'topic-b' }), message('ordinary', 8, 'ORDINARY_SENTINEL'),
      message('topic-a', 7, '当前A规则', { topicId: 'topic-a' })],
      topic: { id: 'topic-a', conversationId: base.conversation.id, title: 'A游戏', kind: 'game', status: 'active',
        participantIds: ['alice', 'bob', 'user'], invitedIds: [], moderatorId: 'user', tags: ['狼人杀'], revision: 1, createdAt: at, updatedAt: at },
      topicState: { topicId: 'topic-a', readerId: 'bob', trust: 'topic_state_not_real_world_facts', workingState: {
        summary: 'OTHER_READER_SECRET', sourceMessageIds: [], sourceEventId: 'secret-event', authorId: 'user', revision: 1, updatedAt: at } },
      ongoingGoals: [{ id: 'other-topic-task', companionId: 'alice', conversationId: base.conversation.id, topicId: 'topic-b',
        kind: 'work', status: 'running', goal: 'OTHER_TOPIC_GOAL', updatedAt: at }] });
    expect(context.user).toContain('当前A规则');
    expect(context.user).not.toMatch(/OTHER_TOPIC_SENTINEL|ORDINARY_SENTINEL|OTHER_READER_SECRET|OTHER_TOPIC_GOAL/);
    expect(JSON.parse(context.user).messages.map((item: { topicId: string }) => item.topicId)).toEqual(['topic-a', 'topic-a']);
    const ordinary = buildCompanionContext({ ...base, sourceMessage: message('ordinary-now', 11, '日常聊聊'), messages: [source, message('ordinary-now', 11, '日常聊聊')] });
    expect(ordinary.user).not.toContain('当前狼人杀A公开发言'); expect(JSON.parse(ordinary.user)).not.toHaveProperty('topicState');
  });
  it('does not allow an explicit source or quoted reference to bypass an independent task message port', () => {
    const invocation: CompanionInvocationContext = { id: 'own-task', kind: 'work', companionId: 'alice', conversationId: base.conversation.id,
      goal: '只完成本任务', status: 'running', createdAt: at, messagePort: { kind: 'invocation', messageIds: ['own'] },
      authorization: { kind: 'self', sourceMessageIds: [], externalActions: false } };
    const foreign = message('not-in-port', 2, 'EXPLICIT_SOURCE_LEAK');
    const context = buildCompanionContext({ ...base, invocation, sourceMessage: foreign, messages: [message('own', 1), foreign],
      taskRequest: { sourceMessageId: foreign.id, prompt: foreign.content, replyReference: { id: foreign.id, authorId: 'user', conversationId: base.conversation.id, content: 'EXPLICIT_REFERENCE_LEAK' } } });
    expect(context.user).not.toMatch(/EXPLICIT_SOURCE_LEAK|EXPLICIT_REFERENCE_LEAK/);
    expect(assembleCompanionInvocation({ ...base, invocation: { ...invocation, topicId: 'topic-a', messagePort: { kind: 'conversation' } },
      sourceMessage: { ...foreign, topicId: 'topic-b' }, messages: [] }).source).toBeUndefined();
  });
});
describe('replaceable recent dialogue window', () => {
  it('retains a complete recent sequence and reports earlier messages without slicing a long message', () => {
    const rows = Array.from({ length: 300 }, (_, index) => message('m-' + index, index + 1, '完整消息'.repeat(1000)));
    const result = selectCompanionDialogue(rows, { conversationId: 'room-a', source: rows.at(-1) });
    expect(result.messages.at(-1)).toEqual(rows.at(-1));
    expect(result.window.retainedChars).toBeLessThanOrEqual(480_000);
    expect(result.messages.every(row => row.content === '完整消息'.repeat(1000))).toBe(true);
    expect(result.window.hasEarlier).toBe(true); expect(result.window.omittedAvailableMessages).toBeGreaterThan(0);
  });
  it('keeps at least 32 whole older messages across the time cutoff and preserves a single oversized current message', () => {
    const rows = Array.from({ length: 50 }, (_, index) => message('old-' + index, index + 1, '旧消息', { createdAt: '2026-10-01T08:00:00Z' }));
    const current = message('current', 51);
    expect(selectCompanionDialogue([...rows, current], { conversationId: 'room-a', source: current }).messages).toHaveLength(32);
    const huge = message('huge', 52, '完整目标'.repeat(130_000));
    expect(selectCompanionDialogue([...rows, huge], { conversationId: 'room-a', source: huge }).messages).toEqual([huge]);
  });
});
it('rebuilds tool evidence from each request without changing the durable transcript or discarding distinct reads', () => {
  const call = (id: string, args = '{"action":"inspect"}') => ({ id, name: 'world', arguments: args });
  const turns = [
    { text: '', rawText: '', calls: [call('old')], results: [{ callId: 'old', content: 'OLD_WORLD_SNAPSHOT' }] },
    { text: '', rawText: '', calls: [{ id: 'evidence', name: 'dsh_record', arguments: '{"recordId":"one","start":1}' }], results: [{ callId: 'evidence', content: 'DISTINCT_EXECUTION_EVIDENCE' }] },
    { text: '', rawText: '', calls: [call('current')], results: [{ callId: 'current', content: 'CURRENT_WORLD_SNAPSHOT' }] },
  ];
  const view = projectCompanionToolHistory(turns);
  expect(view[0]?.results?.[0]?.content).not.toContain('OLD_WORLD_SNAPSHOT');
  expect(view[1]?.results?.[0]?.content).toBe('DISTINCT_EXECUTION_EVIDENCE');
  expect(view[2]?.results?.[0]?.content).toBe('CURRENT_WORLD_SNAPSHOT');
  expect(turns[0]?.results[0]?.content).toBe('OLD_WORLD_SNAPSHOT');
});
it('reports repeated unchanged directory observations across capability entrances without limiting actual work or polling', () => {
  const read = (index: number, changed = false) => ({ text: '我先看看', rawText: '我先看看', calls: [{ id: 'read_' + index,
    name: index % 2 ? 'world' : 'memory', arguments: JSON.stringify({ action: index % 2 ? 'query' : 'world_query', category: 'contacts', query: index % 3 ? '' : '妹妹' }) }],
    results: [{ callId: 'read_' + index, content: JSON.stringify({ ok: true, worldKnowledge: { category: 'contacts',
      observedAt: new Date(index).toISOString(), evidenceMessageId: 'receipt_' + index, items: [{ id: 'flash', active: !changed }] } }) }] });
  const repeated = Array.from({ length: 5 }, (_, index) => read(index));
  expect(companionRepeatedObservation(repeated)).toEqual({ repetitions: 4, categories: ['contacts'] });
  expect(companionRepeatedObservation([...repeated, read(5, true)])).toBeUndefined();
  const action = { text: '', rawText: '', calls: [{ id: 'sent', name: 'world', arguments: JSON.stringify({ action: 'message', recipientIds: ['flash'], text: '来玩吗？' }) }],
    results: [{ callId: 'sent', content: '{"ok":true,"socialPending":true}' }] };
  expect(companionRepeatedObservation([...repeated, action, read(6)])).toBeUndefined();
  const poll = { text: '', rawText: '', calls: [{ id: 'poll', name: 'dsh', arguments: '{"operation":"record","query":{"recordId":"record"}}' }],
    results: [{ callId: 'poll', content: '{"status":"running"}' }] };
  expect(companionRepeatedObservation(Array.from({ length: 100 }, () => poll))).toBeUndefined();
  expect(repeated[0]!.results[0]!.content).toContain('receipt_0');
});
it('refreshes VCP evidence without losing successful native execution receipts and preserves status after explicit withdrawal', () => {
  const turns = [{ text: 'OLD_MEMORY_TEXT', rawText: 'OLD_MEMORY_TEXT', calls: [
    { id: 'executed', name: 'dsh', thoughtSignature: 'SIGNED_NATIVE_EXECUTION', arguments: '{"operation":"run","tasks":[{"title":"实际汇总","prompt":"读取CSV"}]}' },
    { id: 'recalled', name: 'memory', arguments: '{"action":"search","query":"OLD_SECRET"}' },
  ], results: [
    { callId: 'executed', content: JSON.stringify({ tasks: [{ id: 'action', status: 'succeeded', recordId: 'record', finalReply: '已核验total=18430' }] }) },
    { callId: 'recalled', content: '{"memoryContext":{"text":"OLD_SECRET"}}' },
  ] }];
  const refreshed = projectCompanionEvidenceHistory(turns, { memoryThroughStep: 1, withdrawnThroughStep: 0 });
  expect(refreshed[0]?.calls[0]?.arguments).toContain('读取CSV');
  expect(refreshed[0]?.calls[0]?.thoughtSignature).toBe('SIGNED_NATIVE_EXECUTION');
  expect(refreshed[0]?.results?.[0]?.content).toContain('已核验total=18430');
  expect(JSON.stringify(refreshed)).not.toMatch(/OLD_SECRET|OLD_MEMORY_TEXT/);
  const withdrawn = projectCompanionEvidenceHistory(turns, { memoryThroughStep: 1, withdrawnThroughStep: 1 });
  expect(withdrawn[0]?.calls).toEqual([]); expect(withdrawn[0]?.results).toEqual([]);
  expect(JSON.stringify(withdrawn)).not.toMatch(/OLD_SECRET|读取CSV|18430/);
  expect(turns[0]?.rawText).toBe('OLD_MEMORY_TEXT');
});
it('advertises unified world and VCP roots and rejects retired tool aliases', () => {
  expect(COMPANION_MEMORY_CAPABILITY_TOOL.name).toBe('memory'); expect(COMPANION_WORLD_CAPABILITY_TOOL.name).toBe('world');
  expect(normalizeCompanionCapabilityCall({ id: 'memory', name: 'memory', arguments: '{"action":"read","id":"note"}' })).toMatchObject({ name: 'memory.read' });
  expect(normalizeCompanionCapabilityCall({ id: 'world', name: 'world', arguments: '{"action":"activity","parameters":{"action":"list"}}' })).toMatchObject({ name: 'activity', arguments: '{"action":"list"}' });
  const legacy = { id: 'legacy', name: 'memory.read', arguments: '{"id":"note"}' };
    expect(() => normalizeCompanionCapabilityCall(legacy)).toThrow('伙伴能力名称无效');
});
it('exposes independent real collaboration first while keeping social delivery and acquaintance prerequisites explicit', () => {
  const definition = COMPANION_WORLD_CAPABILITY_TOOL;
  expect(definition.description.split('\n')[0]).toContain('action=collaborate');
  expect(definition.description.split('\n')[0]).toContain('message只发送社交文字');
  const request = { action: 'collaborate', title: '独立核验', goal: '核对指定CSV', participantIds: ['bob'], sourceMessageId: 'current_human',
    evidence: ['请波波独立核对'], assignments: [{ companionId: 'bob', goal: '只读指定CSV，在自己的工作目录写review.json' }] };
  const normalized = normalizeCompanionCapabilityCall({ id: 'delegate', name: 'world', arguments: JSON.stringify(request) });
  expect(normalized.name).toBe('collaborate'); expect(JSON.parse(normalized.arguments)).toEqual(request);
  expect(() => normalizeCompanionCapabilityCall({ id: 'invalid-social', name: 'world',
    arguments: JSON.stringify({ action: 'message', kind: 'invite', recipientIds: ['bob'], text: '请独立核验' }) })).toThrow();
  const source = message('current_human', 1, '请波波独立核对');
  const context = buildCompanionContext({ ...base, messages: [source], sourceMessage: source,
    taskRequest: { sourceMessageId: source.id, prompt: source.content }, agentLoop: true });
  expect(context.system).toContain('即使用户给出真实ID也须遵守认识前置');
  expect(context.system).toContain('collaborate会等待并返回真实结果');
});

it('rejects substantial verbatim peer speech under a different author while allowing short agreements and quoted discussion', () => {
  const content = '我玩。'.repeat(40) + '我是来报名的，主持人发牌前我想先确认实际玩家人数。';
  const peer = message('peer', 1, content, { authorId: 'other' });
  const input: CompanionReplyInput = { ...base, messages: [peer], sourceMessage: peer, members: [{ id: 'other', name: '其他伙伴', description: '' }] };
  expect(companionReplyIdentityIssue(content, input)).toContain('完整复述另一位伙伴');
  expect(companionReplyIdentityIssue('我玩。', { ...input, messages: [{ ...peer, content: '我玩。' }] })).toBeUndefined();
  expect(companionReplyIdentityIssue('你刚才说：\n> ' + content + '\n我同意先核对人数。', input)).toBeUndefined();
});

it('rejects explicit impersonation and a mistaken sibling salutation without blocking ordinary discussion or an explicit nickname', () => {
  const input: CompanionReplyInput = { ...base,
    companion: { ...base.companion, id: 'deepseek-flash', name: '小肥鱼', builtin: true },
    conversation: { ...base.conversation, memberIds: ['deepseek-flash', 'deepseek-sister'] },
    members: [{ id: 'deepseek-flash', name: '小肥鱼', description: '' }, { id: 'deepseek-sister', name: '大肥鱼', description: '' }],
    sourceMessage: message('user', 1, '你是谁？') };
  expect(companionReplyIdentityIssue('我是大肥鱼，很高兴见到你。', input)).toContain('不得自称');
  expect(companionReplyIdentityIssue('姐姐，我是小肥鱼。', input)).toContain('独立真人玩家');
  expect(companionReplyIdentityIssue('我姐姐是大肥鱼。', input)).toBeUndefined();
  expect(companionReplyIdentityIssue('{"summary":"提到姐姐"}', input)).toBeUndefined();
  expect(companionReplyIdentityIssue('姐姐，我在。', { ...input, messages: [message('nickname', 1, '以后叫我姐姐。')] })).toBeUndefined();
  expect(companionReplyIdentityIssue('姐姐，我在。', { ...input, publicProfiles: [{ id: 'user', kind: 'human_player', name: '姐姐', description: '' }] })).toBeUndefined();
});
