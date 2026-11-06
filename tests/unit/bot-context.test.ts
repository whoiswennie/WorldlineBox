import { expect, it } from 'vitest';
import { botClock, botLocalTimestamp, buildBotContext } from '../../src/main/companion-bot/context';
import { appBrainRequest, fitsAppBrainRequest } from '../../src/main/companion-bot/app-brain-budget';
import { BOT_TOOLS } from '../../src/main/companion-bot/tools';
import type { BotCompanion, BotEvent, BotMessage, BotTask } from '../../src/main/companion-bot/types';

const companion: BotCompanion = { id: 'alice', name: 'Alice', persona: '沉稳，认真。', createdAt: '2026-11-02', updatedAt: '2026-11-02' };
const event: BotEvent = { id: 'e1', eventId: 'e1', companionId: 'alice', conversationId: 'c1', laneId: 'lane1', source: 'user',
  sourceInstanceId: 'desktop', sourceMessageId: 'm1', senderId: 'user', senderType: 'user', senderName: '我', audienceScopeId: 'c1', securityDomainId: 'c1',
  aclRevision: 1, sequence: 1, kind: 'message', content: '当前问题', payload: {}, correlationId: 'root', sourceMessageRecordId: 'trigger', sourceMessageSequence: 5,
  replyMessageId: 'reply', status: 'running', attempts: 1, occurredAt: '2026-11-02', receivedAt: '2026-11-02' };
const message = (id: string, sequence: number, content: string, overrides: Partial<BotMessage> = {}): BotMessage => ({ id, eventId: id,
  conversationId: 'c1', senderId: 'user', senderName: '我', senderType: 'user', content, status: 'sent', sequence, kind: 'message', correlationId: 'root', createdAt: '2026-11-02', ...overrides });
it('gives the Router direct task controls while retaining priority of a human pause', () => {
  const task = { id: 'own-task', conversationId: 'c1', companionId: 'alice', goal: '原授权内的文件任务', status: 'paused' };
  const router = buildBotContext({ companion, event, messages: [], taskFollowup: { taskId: task.id }, tasks: [{ ...task, pauseOrigin: 'router' }] });
  const human = buildBotContext({ companion, event, messages: [], taskFollowup: { taskId: task.id }, tasks: [{ ...task, pauseOrigin: 'user' }] });
  expect(JSON.parse(buildBotContext({ companion, event, messages: [], tasks: [task] }).user).tasks).toEqual([]);
  expect(JSON.parse(router.user).tasks[0].summary).toContain('可在原授权范围内恢复原任务');
  expect(JSON.parse(human.user).tasks[0].summary).toContain('仅在用户明确继续');
  expect(router.system).toContain('Worker只执行和报告');
  expect(router.system).toContain('不为停止或清理反复查询确认');
});
it('provides a host-formatted Shanghai clock across the UTC date boundary instead of asking the model to convert it', () => {
  expect(botClock(new Date('2026-11-05T00:34:37.000Z'))).toEqual({ now: '2026-11-05T00:34:37.000Z', timeZone: 'Asia/Shanghai', utcOffset: '+08:00', localDateTime: '2026-11-05T08:34:37+08:00', timeOfDay: '早上' });
  expect(botClock(new Date('2026-11-04T16:01:02.000Z')).localDateTime).toBe('2026-11-05T00:01:02+08:00');
  const built = buildBotContext({ companion, event, messages: [] }), clock = JSON.parse(built.user).clock;
  expect(clock.localDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  expect(built.system).toContain('clock.now是UTC原值');
});
it('provides local historical and trigger instants so 08:34 cannot be read as 00:34 while preserving source records', () => {
  const source = { ...event, occurredAt: '2026-11-05T02:33:00Z' }, old = message('morning', 1, '旧回复误称凌晨', { createdAt: '2026-11-05T00:34:39.000Z' });
  const body = JSON.parse(buildBotContext({ companion, event: source, messages: [old] }).user);
  expect(body.trigger.occurredAt).toBe('2026-11-05T10:33:00+08:00'); expect(body.history[0].createdAt).toBe('2026-11-05T08:34:39+08:00');
  expect(old.createdAt).toBe('2026-11-05T00:34:39.000Z'); expect(botLocalTimestamp('2026-11-05')).toBe('2026-11-05');
  expect(botLocalTimestamp('invalid')).toBe('invalid'); expect(botClock(new Date('2026-11-05T02:33:00Z')).timeOfDay).toBe('上午');
});
it('gives an empty group its real peer IDs without exposing unrelated contacts or their personas', () => {
  const conversation = { id: 'c1', title: '伙伴群', kind: 'group' as const, memberIds: ['user', 'alice', 'bob'] };
  const input = { companion, event, conversation, messages: [], participants: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }, { id: 'private-other', name: '私域联系人' }] };
  expect(JSON.parse(buildBotContext(input).user).room).toEqual({ title: '伙伴群', kind: 'group', members: [{ id: 'user', name: '用户' }, { id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }] });
  expect(buildBotContext(input).user).not.toContain('私域联系人');
  expect(() => buildBotContext({ ...input, conversation: { ...conversation, id: 'elsewhere' } })).toThrow('聊天与事件不匹配');
});
it('preserves true authors and excludes future, other-channel and unfinished messages', () => {
  const built = buildBotContext({ companion, event, messages: [message('old', 1, '原话'), message('peer', 2, '另一个伙伴说的话', { senderId: 'bob', senderName: 'Bob', senderType: 'companion' }),
    message('mine', 3, '我的旧回答', { senderId: 'alice', senderName: 'Alice', senderType: 'companion' }), message('placeholder', 4, '未完成', { status: 'running' }),
    message('trigger', 5, '当前问题'), message('future', 6, '未来请求'), message('other', 1, '私聊秘密', { conversationId: 'c2' })] });
  const body = JSON.parse(built.user);
  expect(body.history.map((item: { content: string }) => item.content)).toEqual(['原话', '另一个伙伴说的话', '我的旧回答']);
  expect(body.history[1].role).toBe('user'); expect(body.history[1].senderId).toBe('bob'); expect(body.history[2].role).toBe('assistant');
  expect(body.trigger.content).toBe('当前问题'); expect(built.system).toContain('沉稳，认真。');
});
it('bounds the history by whole messages without truncating the current request', () => {
  const built = buildBotContext({ companion, event, messages: [message('a', 1, 'a'.repeat(20)), message('b', 2, 'b'.repeat(20)), message('trigger', 5, '当前问题')], maxHistoryChars: 25 });
  expect(JSON.parse(built.user).history).toHaveLength(1); expect(built.omittedMessages).toBe(1); expect(JSON.parse(built.user).trigger.content).toBe(event.content);
});
it('does not include task cards from another audience or another companion', () => {
  const task = (id: string, conversationId: string, companionId: string): BotTask => ({ id, conversationId, companionId, sourceEventId: 'e1', goal: id,
    status: 'running', attemptId: 'attempt', createdAt: '2026-11-02', updatedAt: '2026-11-02', extra: {} });
  const built = buildBotContext({ companion, event, messages: [], tasks: [task('mine', 'c1', 'alice'), task('secret', 'c2', 'alice'), task('peer', 'c1', 'bob')] });
  expect(JSON.parse(built.user).tasks.map((item: { id: string }) => item.id)).toEqual(['mine']);
  expect(() => buildBotContext({ companion: { ...companion, id: 'bob' }, event, messages: [] })).toThrow('不匹配');
});
it('keeps ended task reports out of ordinary chat but includes the selected result with correct preview metadata', () => {
  const tasks = [
    { id: 'projected', conversationId: 'c1', companionId: 'alice', goal: 'projected report', status: 'succeeded', summary: 'R'.repeat(2000), summaryIsPreview: true },
    { id: 'full', conversationId: 'c1', companionId: 'alice', goal: 'full report', status: 'succeeded', summary: 'R'.repeat(2001), summaryIsPreview: false },
    { id: 'complete', conversationId: 'c1', companionId: 'alice', goal: 'complete report', status: 'succeeded', summary: 'R'.repeat(2000), summaryIsPreview: false },
  ];
  expect(JSON.parse(buildBotContext({ companion, event, messages: [], tasks }).user).tasks).toEqual([]);
  for (const [index, task] of tasks.entries()) {
    const body = JSON.parse(buildBotContext({ companion, event: { ...event, source: 'task', payload: { taskId: task.id } }, messages: [], tasks }).user);
    expect(body.tasks).toHaveLength(1); expect(body.tasks[0].summaryIsPreview).toBe(index < 2);
    expect(body.tasks[0].summary).toHaveLength(2000);
  }
});
it('budgets JSON escaping and whole supplemental records while preserving the request', () => {
  const built = buildBotContext({ companion, event, messages: [message('old', 1, '\\'.repeat(4000))], memories: 'large'.repeat(1000), maxEnvelopeChars: 1600 });
  const body = JSON.parse(built.user);
  expect(built.user.length).toBeLessThanOrEqual(1600);
  expect(body.trigger.content).toBe(event.content); expect(body.history).toEqual([]);
  expect(body.memoryEvidenceOmitted).toBe(true);
  expect(() => buildBotContext({ companion, event: { ...event, content: '\\'.repeat(3000) }, messages: [], maxEnvelopeChars: 1600 })).toThrow('请拆成几条');
});
it('fits the actual app request by omitting optional evidence rather than rejecting a short Chinese trigger', () => {
  const trigger = { ...event, content: '只整理一个小角落，保留这段原文：\\"桌面\n20分钟🐳' };
  const minimal = buildBotContext({ companion, event: trigger, messages: [] });
  const model = { apiFormat: 'openai_chat' as const, model: 'local-protocol-fixture', baseUrl: 'https://model.invalid/v1', apiKey: 'fixture-only', maxTokens: 512, contextWindow: 32768 };
  const request = (system: string, user: string) => appBrainRequest(model, system, [{ role: 'user', content: user }], BOT_TOOLS, true);
  const required = request(minimal.system, minimal.user);
  model.contextWindow = Buffer.byteLength(JSON.stringify(required), 'utf8') + required.max_tokens + 256 + 64;
  const fitsEnvelope = (system: string, user: string) => fitsAppBrainRequest(request(system, user), model);
  const supplemental = { companion, event: trigger,
    messages: [message('older', 1, '过去的整理讨论。'.repeat(100)), message('recent', 2, '稍早的明确约束。'.repeat(100))],
    tasks: [{ id: 'active-task', conversationId: 'c1', companionId: 'alice', goal: '已有独立任务的说明。'.repeat(100), status: 'running', summary: '任务尚未完成。'.repeat(80) }],
    memories: '记忆原文属于补充资料，需要时仍可主动回查。'.repeat(400) };
  const withoutWireBudget = buildBotContext(supplemental);
  expect(withoutWireBudget.user.length).toBeLessThan(60000);
  expect(fitsEnvelope(withoutWireBudget.system, withoutWireBudget.user)).toBe(false);
  const built = buildBotContext({ ...supplemental, fitsEnvelope }), body = JSON.parse(built.user);
  expect(fitsEnvelope(built.system, built.user)).toBe(true);
  expect(body.trigger).toEqual(JSON.parse(minimal.user).trigger);
  expect(body.trigger.content).toBe(trigger.content);
  expect(body.history).toEqual([]); expect(body.historyCoverage).toEqual({ selected: 0, omitted: 2 }); expect(built.omittedMessages).toBe(2);
  expect(body.tasks).toEqual([]); expect(body.memoryEvidence).toBe(''); expect(body.memoryEvidenceOmitted).toBe(true);
  expect(() => buildBotContext({ companion, event: { ...trigger, content: '不可截断的用户当前原文。'.repeat(1000) }, messages: [], fitsEnvelope })).toThrow('请拆成几条');
});
