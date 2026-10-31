import { describe, expect, it, vi } from 'vitest';
import type { ActivityDecision, CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { CompanionTopic } from '../../src/shared/companion-topic';
import { reviewCompanionActivityFeasibility } from '../../src/main/companions/activity-feasibility';
import { companionRoleResourceBounds } from '../../src/main/companions/role-resource-context';

const now = '2026-10-24T00:00:00Z';
const topic: CompanionTopic = { id: 'game', conversationId: 'room', title: '筹备', kind: 'game', status: 'active', moderatorId: 'a',
  participantIds: ['a', 'b', 'c'], invitedIds: [], tags: [], revision: 1, createdAt: now, updatedAt: now };
const task: CompanionActivityTask = { id: 'task', companionId: 'a', conversationId: 'private_a', sourceMessageId: 'human', title: '本目标', goal: '找伙伴玩一局完整游戏',
  status: 'running', step: 1, attempts: 1, createdAt: now, updatedAt: now, deadline: now, stage: '筹备', history: [],
  gamePort: { conversationId: 'room', topicId: 'game', deliveryClientId: 'actual_delivery' } };
const resourceBounds = companionRoleResourceBounds({ ownerId: 'a', activeCharacterIds: ['a', 'b', 'c'], game: {
  conversation: { id: 'room', memberIds: ['a', 'b', 'c'], peerOnly: true }, topic } });
const input = (decision: ActivityDecision) => ({ task, topic, resourceBounds, shared: undefined, decision, actualMessages: [] });
const config = { apiFormat: 'openai_chat' as const, model: 'test', apiKey: 'fake', baseUrl: 'https://fixture.invalid' };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
describe('activity resource feasibility proposal review', () => {
  it.each([{ topic: { action: 'read', topicId: 'game' } }, { action: { action: 'query' as const, category: 'contacts' as const } }])('does not add a reviewer to pure needed current reads: %j', operation => {
    const fetchFn = vi.fn<typeof fetch>();
    return expect(reviewCompanionActivityFeasibility(input({ status: 'continue', action: null, wait: null, summary: '实际读取', ...operation }), config, undefined,
      { fetchFn })).resolves.toEqual({ allowed: true }).then(() => expect(fetchFn).not.toHaveBeenCalled());
  });
  it('refuses a retired actor memory proposal before any review request', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await reviewCompanionActivityFeasibility(input({ status: 'continue', action: null, wait: null,
      memory: { operation: 'search', query: '已存在资料' }, summary: '不能恢复主动回忆' }), config, undefined, { fetchFn });
    expect(result).toMatchObject({ allowed: false, reason: expect.stringContaining('已退役') }); expect(fetchFn).not.toHaveBeenCalled();
  });
  it('fails closed on mismatched actual bound port without making a model request', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await reviewCompanionActivityFeasibility({ ...input({ status: 'blocked', action: null, wait: null, summary: '暂时受阻' }),
      topic: { ...topic, id: 'other_episode' } }, config, undefined, { fetchFn });
    expect(result.allowed).toBe(false); expect(result.reason).toContain('真实绑定'); expect(fetchFn).not.toHaveBeenCalled();
  });
  it('reviews an unbound preparation plan against the active directory instead of skipping its capacity conflict', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      const data = JSON.parse(wire.messages[1].content);
      expect(data.actualResourceBounds).toMatchObject({ hasVerifiedGameRoom: false, activeCharacterCount: 6,
        includesOwner: true, otherActiveCharacterCount: 5, boundGameRoomMemberIds: [] });
      expect(data.originalHumanGoal).toBe(task.goal);
      expect(data.exactProposedDecision.planningState.constraints).toEqual(['六位抽牌者，主持本人不抽牌']);
      expect(wire.messages[0].content).toContain('没有已验证房间不等于没有可用伙伴');
      return response({ allowed: false, confidence: .99, reason: '当前目录包含主持本人共六位，作者自拟的六位抽牌者加独立主持超出容量；原目标未固定人数，应自行修订。' });
    });
    const result = await reviewCompanionActivityFeasibility({ ...input({ status: 'continue', action: null,
      wait: { kind: 'reply', targetCompanionId: 'b' }, summary: '继续等待第六位抽牌者',
      planningState: { summary: '筹备', nextSteps: ['等六位抽牌者'], constraints: ['六位抽牌者，主持本人不抽牌'] } }),
      task: { ...task, gamePort: undefined }, topic: undefined,
      resourceBounds: companionRoleResourceBounds({ ownerId: 'a', activeCharacterIds: ['a', 'b', 'c', 'd', 'e', 'f'] }) },
    config, undefined, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(result.allowed).toBe(false); expect(result.reason).toContain('超出容量');
  });
  it('reviews a feasible group creation proposal before a room exists without treating capacity as consent or permission', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      const data = JSON.parse(wire.messages[1].content);
      expect(data.actualResourceBounds).toMatchObject({ hasVerifiedGameRoom: false, activeCharacterIds: ['a', 'b', 'c'],
        activeCharacterCount: 3, boundGameRoomMemberIds: [], joinedTopicParticipantIds: [] });
      expect(data.exactProposedDecision.action).toMatchObject({ action: 'create_group', recipientIds: ['b', 'c'] });
      expect(wire.messages[0].content).toContain('不证明熟人关系、入群或抽牌同意');
      return response({ allowed: true, confidence: .99, reason: '这是在目录容量内向两位伙伴建群征询的提案，不声称他们已同意参加。' });
    });
    const result = await reviewCompanionActivityFeasibility({ ...input({ status: 'continue', wait: null, summary: '建群征询',
      action: { action: 'create_group', recipientIds: ['b', 'c'], title: '一起活动', text: '你们现在方便一起玩吗？',
        topic: { title: '筹备', kind: 'game' } } }), task: { ...task, gamePort: undefined }, topic: undefined,
      resourceBounds: companionRoleResourceBounds({ ownerId: 'a', activeCharacterIds: ['a', 'b', 'c'] }) },
    config, undefined, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(result).toEqual({ allowed: true });
  });
  it('keeps unbound pure current reads and completion free of resource review calls', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const decisions: ActivityDecision[] = [
      { status: 'continue', action: { action: 'query', category: 'people' }, wait: null, summary: '读取实际目录' },
      { status: 'continue', action: null, wait: null, topic: { action: 'read', topicId: 'game' }, summary: '读取资料' },
      { status: 'complete', action: null, wait: null, summary: '交由结果审查' },
    ];
    for (const decision of decisions) expect(await reviewCompanionActivityFeasibility({ ...input(decision),
      task: { ...task, gamePort: undefined }, topic: undefined,
      resourceBounds: companionRoleResourceBounds({ ownerId: 'a', activeCharacterIds: ['a', 'b', 'c'] }) },
    config, undefined, { fetchFn })).toEqual({ allowed: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('uses bounded structural repair and preserves the exact original reviewer evidence', async () => {
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const sent = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      const data = sent.purpose === 'companion_structured_repair' ? JSON.parse(sent.originalRequest.user) : sent;
      expect(data.purpose).toBe('activity_resource_feasibility');
      expect(data.actualResourceBounds).toMatchObject({ boundGameRoomMemberCount: 3, otherActiveCharacterCount: 2,
        moderatorDrawSeat: 'unknown_not_inferred_from_moderator_role', humanPlayer: { includedInRoom: false, joined: false } });
      expect(data.exactProposedDecision.planningState.constraints).toEqual(['模型自己设定6位玩家']);
      if (++calls === 1) return response({ allowed: 'no', reason: 'wrong schema' });
      expect(sent.purpose).toBe('companion_structured_repair');
      expect(sent.validationErrors.some((issue: { path?: string[] }) => issue.path?.includes('confidence'))).toBe(true);
      return response({ allowed: false, confidence: .99, reason: '原目标未规定6人，当前群容量不足以支持作者该自选方案，应由作者自行修订。' });
    });
    const result = await reviewCompanionActivityFeasibility(input({ status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'b' },
      planningState: { summary: '凑6人', nextSteps: ['继续等'], constraints: ['模型自己设定6位玩家'] }, summary: '等人' }), config, undefined, { fetchFn });
    expect(calls).toBe(2); expect(result).toEqual({ allowed: false, reason: '原目标未规定6人，当前群容量不足以支持作者该自选方案，应由作者自行修订。' });
  });
  it.each([true, false])('bounds low-confidence reviews and gives an accurate uncertainty reason unless rechecked=%s', async rechecked => {
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (++calls > 1) expect(data.reviewCorrection.error).toContain('不为通过而只抬高数字');
      return response({ allowed: true, confidence: rechecked && calls === 2 ? .95 : .86, reason: '当前只是公开征询方案，不假定未来同意。' });
    });
    const result = await reviewCompanionActivityFeasibility(input({ status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'b' },
      summary: '等待真实意见' }), config, undefined, { fetchFn });
    expect(calls).toBe(rechecked ? 2 : 3); expect(result.allowed).toBe(rechecked);
    if (!rechecked) expect(result.reason).toContain('置信不足（0.86）');
  });
});
