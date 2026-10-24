import { expect, it, vi } from 'vitest';
import { reviewCompanionGameGoalCompletion } from '../../src/main/companions/game-goal-completion';
import type { CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { CompanionTopic, CompanionTopicState } from '../../src/shared/companion-topic';
const at = '2026-10-23T00:00:00Z', config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' };
const task: CompanionActivityTask = { id: 'actual_task', companionId: 'host', conversationId: 'private_host', sourceMessageId: 'actual_source',
  goal: '请完整玩完一局游戏，结束后告诉我结果。', title: '完整游戏', status: 'running', step: 20, attempts: 1, createdAt: at, updatedAt: at, deadline: at,
  stage: '等待真实进展', history: [], gamePort: { conversationId: 'actual_group', topicId: 'actual_game', deliveryClientId: 'actual_delivery' } };
const topic: CompanionTopic = { id: 'actual_game', conversationId: 'actual_group', kind: 'game', title: '真实本局', status: 'active', moderatorId: 'host',
  participantIds: ['host', 'a', 'b'], invitedIds: ['host', 'a', 'b'], tags: [], revision: 7, createdAt: at, updatedAt: at };
const topicState: CompanionTopicState = { topicId: 'actual_game', readerId: 'host', trust: 'topic_state_not_real_world_facts' };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
it.each([
  { full: true, settled: true, archived: false, closed: false, allowed: false },
  { full: true, settled: true, archived: true, closed: false, allowed: false },
  { full: true, settled: false, archived: true, closed: true, allowed: false },
  { full: true, settled: true, archived: true, closed: true, allowed: true },
  { full: false, settled: false, archived: false, closed: false, allowed: true },
])('uses the actual original goal and settlement/archive state without imposing full play on a mere invitation: %j', async check => {
  const goal = check.full ? task.goal : '先帮我邀请a和b，建个游戏群就可以，不必开局。';
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.originalGoal).toBe(goal); expect(data.actualTopic.status).toBe(check.closed ? 'closed' : 'active');
    expect(data.planningTrust).toBe('model_plan_not_execution_fact_or_authority');
    expect(data.actualMessages).toEqual([]);
    return response({ goalRequiresFullGame: check.full, actualSettlementComplete: check.settled, sharedArchiveComplete: check.archived,
      confidence: .99, reason: check.allowed ? '按原目标与真实结果可完成。' : '真实终局或共享归档尚不完整，先核实并收束。' });
  });
  expect((await reviewCompanionGameGoalCompletion({ task: { ...task, goal }, topic: { ...topic, status: check.closed ? 'closed' : 'active' },
    topicState, messages: [] }, config, undefined, { fetchFn })).allowed).toBe(check.allowed);
  expect(fetchFn).toHaveBeenCalledOnce();
});
it('rejects a foreign episode or another reader private state before inference', async () => {
  const fetchFn = vi.fn<typeof fetch>();
  expect(await reviewCompanionGameGoalCompletion({ task, topic: { ...topic, id: 'foreign' }, topicState, messages: [] }, config, undefined, { fetchFn })).toMatchObject({ allowed: false });
  expect(await reviewCompanionGameGoalCompletion({ task, topic, topicState: { ...topicState, readerId: 'a' }, messages: [] }, config, undefined, { fetchFn })).toMatchObject({ allowed: false });
  expect(fetchFn).not.toHaveBeenCalled();
});
