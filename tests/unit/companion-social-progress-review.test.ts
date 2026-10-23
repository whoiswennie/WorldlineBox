import { expect, it, vi } from 'vitest';
import { reviewCompanionSocialProgress } from '../../src/main/companions/social-progress-review';
import type { CompanionActivityTask } from '../../src/shared/companion-activity-task';

const now = '2026-10-23T03:00:00.000Z';
const config = { apiFormat: 'openai_chat' as const, model: 'reviewer', apiKey: 'fixture-only', baseUrl: 'https://fixture.invalid' };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
function task(): CompanionActivityTask {
  return { id: 'social_goal', companionId: 'alice', conversationId: 'private_alice', sourceMessageId: 'private_original', title: 'PRIVATE_TASK_TITLE',
    goal: 'PRIVATE_ORIGINAL_HUMAN_REQUEST', status: 'waiting', step: 1, attempts: 0, createdAt: now, updatedAt: now, deadline: now,
    stage: '本目标已收到3位伙伴的真实回信（bob、carol、dave）。回信不等于报名；未读正文不能断言无人同意。\nOTHER_ROOM_BODY_IN_RICH_STAGE',
    history: [{ step: 1, at: now, action: 'create_group', ok: true, arguments: { action: 'create_group', recipientIds: ['bob', 'carol'],
      title: 'PRIVATE_GROUP_TITLE', text: 'OUTGOING_MESSAGE_BODY' }, result: JSON.stringify({ ok: true, socialPending: false,
      socialConversation: { id: 'actual_group', title: 'PRIVATE_GROUP_TITLE', lastMessage: { content: 'OTHER_ROOM_LAST_MESSAGE' } },
      socialMessage: { message: { id: 'actual_outgoing', authorId: 'alice', content: 'OUTGOING_MESSAGE_BODY' } },
      topic: { id: 'actual_game_topic', shared: { summary: 'OTHER_ROOM_TOPIC_BODY' } }, extra: { content: 'UNTRUSTED_FREE_JSON_BODY' } }) }] };
}

it.each(['succeeded', 'failed', 'cancelled'] as const)('does not invoke a reviewer for terminal social tasks: %s', async status => {
  const fetchFn = vi.fn<typeof fetch>();
  expect(await reviewCompanionSocialProgress('普通聊天。', [{ ...task(), status }], config, undefined, { fetchFn })).toBeUndefined();
  expect(fetchFn).not.toHaveBeenCalled();
});

it('skips non-social tasks, empty task sets and empty reports without a provider call', async () => {
  const fetchFn = vi.fn<typeof fetch>();
  const other = { ...task(), history: [{ step: 1, at: now, action: 'move', ok: true, result: '实际移动回执' }] };
  for (const tasks of [[], [other]]) expect(await reviewCompanionSocialProgress('这条普通聊天没有社交任务。', tasks, config, undefined, { fetchFn })).toBeUndefined();
  expect(await reviewCompanionSocialProgress('  ', [task()], config, undefined, { fetchFn })).toBeUndefined();
  expect(fetchFn).not.toHaveBeenCalled();
});

it('returns only an unsupported report correction and sends host progress plus bounded receipt metadata instead of private bodies', async () => {
  const correction = '已有3位实际回信，未读正文不能断言没有谁明确答应；只说明还在核实参加意愿。';
  const original = task(), originalJson = JSON.stringify(original);
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(data.purpose).toBe('companion_social_progress_review'); expect(data.proposedText).toBe('没有谁明确答应。');
    expect(data.facts).toEqual([{ id: original.id, status: 'waiting', stage: original.stage.split('\n')[0], actions: [{ step: 1, action: 'create_group',
      asOf: now, ok: true, delivery: 'sent', messageId: 'actual_outgoing', conversationId: 'actual_group', topicId: 'actual_game_topic' }] }]);
    for (const privateText of ['PRIVATE_ORIGINAL_HUMAN_REQUEST', 'PRIVATE_TASK_TITLE', 'PRIVATE_GROUP_TITLE', 'OTHER_ROOM_BODY_IN_RICH_STAGE',
      'OUTGOING_MESSAGE_BODY', 'OTHER_ROOM_LAST_MESSAGE', 'OTHER_ROOM_TOPIC_BODY', 'UNTRUSTED_FREE_JSON_BODY', 'private_original']) expect(JSON.stringify(data)).not.toContain(privateText);
    expect(request).not.toHaveProperty('tools');
    expect(data.outputSchema.required).toEqual(['supported', 'correction']);
    return response({ supported: false, correction });
  });
  expect(await reviewCompanionSocialProgress('没有谁明确答应。', [original], config, undefined, { fetchFn })).toBe(correction);
  expect(JSON.stringify(original)).toBe(originalJson); expect(fetchFn).toHaveBeenCalledOnce();
});

it.each(['queued', 'running', 'waiting'] as const)('accepts supported reports and preserves the durable automatic continuation evidence for %s tasks', async status => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(data.facts[0].status).toBe(status);
    expect(request.messages[0].content).toContain('因此它们支持');
    expect(request.messages[0].content).toContain('不能误判queued');
    expect(request.messages[0].content).toContain('普通人设语气、自身情绪');
    expect(request.messages[0].content).toContain('必须醒来才能看信');
    return response({ supported: true, correction: '' });
  });
  expect(await reviewCompanionSocialProgress('已经有回信，我还在确认参加意愿。我会继续组织，好期待呀。', [{ ...task(), status }], config, undefined, { fetchFn })).toBeUndefined();
  expect(fetchFn).toHaveBeenCalledOnce();
});

it('does not treat queued, failed or unverified historical actions as delivered and strips rich JSON stages', async () => {
  const source = task(); source.stage = JSON.stringify({ content: 'PRIVATE_BODY_IN_JSON_STAGE' });
  source.history = [
    { step: 1, at: now, action: 'message', ok: true, result: JSON.stringify({ socialPending: true, content: 'PRIVATE_QUEUED_BODY' }) },
    { step: 2, at: now, action: 'introduce', ok: false, result: JSON.stringify({ socialMessage: { messageId: 'not_delivered' }, error: 'PRIVATE_ERROR_BODY' }) },
    { step: 3, at: now, action: 'message', ok: true, result: 'PLAIN_PRIVATE_STATUS_IS_NOT_A_RECEIPT' },
    { step: 4, at: now, action: 'query', ok: true, result: 'OTHER_DIRECTORY_BODY' },
  ];
  const fetchFn: typeof fetch = async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.facts[0].actions.map((action: { delivery: string }) => action.delivery)).toEqual(['queued', 'failed', 'unconfirmed']);
    expect(data.facts[0].actions[1]).not.toHaveProperty('messageId');
    for (const body of ['PRIVATE_BODY_IN_JSON_STAGE', 'PRIVATE_QUEUED_BODY', 'PRIVATE_ERROR_BODY', 'not_delivered',
      'PLAIN_PRIVATE_STATUS_IS_NOT_A_RECEIPT', 'OTHER_DIRECTORY_BODY']) expect(JSON.stringify(data)).not.toContain(body);
    return response({ supported: true, correction: '' });
  };
  expect(await reviewCompanionSocialProgress('邀请还在安排中，是否参加还需要真实回复。', [source], config, undefined, { fetchFn })).toBeUndefined();
});

it('does not silently accept a malformed review or an oversized correction', async () => {
  for (const invalid of [{ correction: 'missing decision' }, { supported: false, correction: 'a'.repeat(801) }]) {
    await expect(reviewCompanionSocialProgress('目前无人报名。', [task()], config, undefined, { fetchFn: async () => response(invalid) }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  }
});

it('maps only actual related people to natural names and preserves the current topic port even without a create-topic history field', async () => {
  const source = task(); source.targetId = 'bob'; source.peerConversationId = 'actual_group'; source.peerTopicId = 'actual_game_topic';
  source.history[0]!.result = JSON.stringify({ socialConversation: { id: 'actual_group', memberIds: ['alice', 'bob', 'deepseek-flash'] },
    socialMessage: { message: { id: 'actual_outgoing', topicId: 'actual_game_topic' }, recipientIds: ['kimi'] } });
  const names = [{ id: 'alice', name: '大肥鱼' }, { id: 'bob', name: '朋友' }, { id: 'deepseek-flash', name: '小肥鱼' }, { id: 'kimi', name: 'Kimi' },
    { id: 'unrelated_world_resident', name: 'UNRELATED_WORLD_DIRECTORY_CANARY' }];
  let call = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(request.messages[0].content).toContain('id和name是同一人');
    expect(request.messages[0].content).toContain('不要求输出内部ID');
    expect(request.messages[0].content).toContain('未提供群标题');
    expect(request.messages[0].content).toContain('6人与12人');
    expect(JSON.stringify(data)).not.toContain('UNRELATED_WORLD_DIRECTORY_CANARY');
    if (call++ === 0) {
      expect(data.identities).toEqual(names.slice(0, 4));
      expect(data.facts[0].currentPort).toEqual({ conversationId: 'actual_group', topicId: 'actual_game_topic' });
      expect(data.facts[0].actions[0].topicId).toBe('actual_game_topic');
    } else {
      // Without recipient receipt evidence, only the actual task owner has a
      // reason to appear; a supplied world directory must never leak through.
      expect(data.identities).toEqual([names[0]]);
    }
    return response({ supported: true, correction: '' });
  });
  expect(await reviewCompanionSocialProgress('小肥鱼和Kimi已经收到邀请，游戏话题已经建好，我会继续确认意愿。', [source], config, undefined, { fetchFn, names })).toBeUndefined();
  expect(await reviewCompanionSocialProgress('我继续安排。', [{ ...task(), history: [{ step: 1, at: now, action: 'message', ok: false, result: '没有实际出站回执' }] }], config, undefined, { fetchFn, names })).toBeUndefined();
  expect(fetchFn).toHaveBeenCalledTimes(2);
});
