import { expect, it, vi } from 'vitest';
import { reviewCompanionSocialProgress } from '../../src/main/companions/social-progress-review';
import type { CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { CompanionLoopTurn } from '../../src/shared/companion-loop';
import { COMPANION_ACTIVITY_HANDOFF_NOTICE } from '../../src/shared/companion-activity-task';
import { socialProgressActions, socialProgressReads, socialProgressOutbound } from '../../src/main/companions/social-progress-evidence';

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

it('reviews a terminating peer promise even without tools and keeps proposed acceptance distinct from a saved task', async () => {
  const source = { id: 'actual_book_request', authorId: 'bob', content: '请你主持今天的读书讨论，收集大家意见并跟进到结束。' };
  const peerFinal = { actor: { id: 'alice', name: '林澄' }, source };
  const proposedWorkOffer = { sourceMessageId: source.id, mode: 'activity' as const, accept: true,
    title: '主持读书讨论', instruction: source.content, evidence: [source.content] };
  let calls = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
    expect(data.facts).toEqual([]); expect(data.nativeActions).toBeUndefined();
    expect(data.peerFinal.source).toEqual(source);
    expect(wire.messages[0].content).toContain('正文发布后本job就结束');
    expect(wire.messages[0].content).toContain('同一事务');
    expect(wire.messages[0].content).toContain('一次性内部工作，不支持持续主持');
    if (calls++ === 0) {
      expect(data.peerFinal).not.toHaveProperty('proposedWorkOffer');
      return response({ supported: false, correction: '本条结束后没有本人持续任务；请当场执行、明确接受持续责任，或如实限定。' });
    }
    expect(data.peerFinal.proposedWorkOffer).toEqual(proposedWorkOffer);
    expect(data.facts).not.toContainEqual(expect.objectContaining({ status: 'queued' }));
    return response({ supported: true, correction: '' });
  });
  expect(await reviewCompanionSocialProgress('我这就收集意见，之后持续主持到结束。', [], config, undefined, { peerFinal, fetchFn })).toContain('没有本人持续任务');
  expect(await reviewCompanionSocialProgress('我接下这份主持职责，接下来继续跟进。', [], config, undefined,
    { peerFinal: { ...peerFinal, proposedWorkOffer }, fetchFn })).toBeUndefined();
  expect(fetchFn).toHaveBeenCalledTimes(2);
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

function nativeSocialTurns(): CompanionLoopTurn[] {
  const sent = { message: { id: 'real_sent', sequence: 13, conversationId: 'actual_pair', authorId: 'alice',
    content: 'PRIVATE_OUTGOING_BODY', kind: 'text', status: 'sent', attachments: [], createdAt: now },
    recipientIds: ['deepseek-flash'], virtualCreatedAt: now };
  return [{ text: '先联系妹妹。', rawText: '先联系妹妹。', calls: [{ id: 'sent_flash', name: 'world',
    arguments: JSON.stringify({ action: 'message', recipientIds: ['deepseek-flash'], text: 'PRIVATE_OUTGOING_BODY' }) }],
  results: [{ callId: 'sent_flash', content: JSON.stringify({ ok: true, socialMessage: sent }) }] },
  ...['grok', 'kimi', 'qwen', 'gugugaga'].map(person => ({ text: '', rawText: '',
    calls: [{ id: 'blocked_' + person, name: 'world', arguments: JSON.stringify({ action: 'introduce', targetCompanionId: person, text: 'PRIVATE_INTRO_BODY' }) }],
    results: [{ callId: 'blocked_' + person, content: JSON.stringify({ ok: true, activityHandoff: { task: task(), existingEffect: false,
      executor: 'background_activity', newVirtualActionDispatched: false, notice: COMPANION_ACTIVITY_HANDOFF_NOTICE } }) }] }))];
}

it('distinguishes four successful handoffs from one actual sent invitation without borrowing proposed or unrelated text', async () => {
  const turns = nativeSocialTurns(), original = JSON.stringify(turns);
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.nativeActions.map((action: { delivery: string }) => action.delivery)).toEqual(['sent', ...Array(4).fill('not_dispatched')]);
    expect(data.nativeActions[0]).toMatchObject({ recipientIds: ['deepseek-flash'], messageId: 'real_sent' });
    for (const action of data.nativeActions.slice(1)) { expect(action).not.toHaveProperty('messageId'); expect(action).not.toHaveProperty('recipientIds'); }
    expect(data.nativeActions[0].sentContent).toBe('PRIVATE_OUTGOING_BODY');
    for (const canary of ['PRIVATE_INTRO_BODY', 'PRIVATE_ORIGINAL_HUMAN_REQUEST']) expect(JSON.stringify(data)).not.toContain(canary);
    return response({ supported: false, correction: '只有妹妹的真实发信回执，另外四次仅交接后台，没有实际发信。' });
  });
  expect(await reviewCompanionSocialProgress('我给另外四人都发了邀请。还在等回信。', [], config, undefined, { turns, fetchFn })).toContain('没有实际发信');
  expect(JSON.stringify(turns)).toBe(original);
});

it('treats current social calls as proposals before dispatch and never as completed sends', async () => {
  const calls = [{ id: 'current_proposal', name: 'world', arguments: JSON.stringify({ action: 'introduce', targetCompanionId: 'kimi', text: 'PRIVATE_PROPOSAL_BODY' }) }];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.nativeActions).toEqual([{ callId: 'current_proposal', action: 'introduce', proposedRecipientIds: ['kimi'], delivery: 'proposed' }]);
    expect(JSON.stringify(data)).not.toContain('PRIVATE_PROPOSAL_BODY');
    return response({ supported: false, correction: '当前调用尚未执行，不能说已经发出。' });
  });
  expect(await reviewCompanionSocialProgress('我已经发给Kimi了。', [], config, undefined, { proposedCalls: calls, fetchFn })).toContain('尚未执行');
});

it('does not promote an external tool lookalike or invalid native receipt to delivery evidence', () => {
  const turn = nativeSocialTurns()[0]!;
  expect(socialProgressActions([{ ...turn, calls: turn.calls.map(call => ({ ...call, name: 'dsh' })) }])).toEqual([]);
  expect(socialProgressActions([{ ...turn, results: [{ callId: 'sent_flash', content: JSON.stringify({ ok: true, socialMessage: { messageId: 'fabricated' } }) }] }]))
    .toEqual([expect.objectContaining({ delivery: 'unconfirmed' })]);
  expect(socialProgressActions([{ ...turn, results: [] }])).toEqual([expect.objectContaining({ delivery: 'unconfirmed' })]);
});
it('binds only an actually returned sent native body and never borrows a proposed or failed configuration body', async () => {
  const turns = nativeSocialTurns();
  turns[0] = { ...turns[0]!, calls: [{ ...turns[0]!.calls[0]!, arguments: JSON.stringify({ action: 'message', recipientIds: ['deepseek-flash'], text: 'UNDELIVERED_PROPOSAL_CONFIGURATION' }) }] };
  const sent = turns[0]!, actions = socialProgressActions(turns);
  expect(actions.find(action => action.delivery === 'sent')?.sentContent).toBe('PRIVATE_OUTGOING_BODY');
  expect(actions.filter(action => action.delivery !== 'sent').every(action => action.sentContent === undefined)).toBe(true);
  const reads = socialProgressReads(turns);
  expect([...reads.values()].map(message => message.content)).toEqual(['PRIVATE_OUTGOING_BODY']);
  const proposed = { id: 'not_yet_sent', name: 'world', arguments: JSON.stringify({ action: 'message', recipientIds: ['grok'], text: '6人配置已经告诉你。' }) };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.nativeActions[0].sentContent).toBe('PRIVATE_OUTGOING_BODY');
    expect(JSON.stringify(data)).not.toContain('6人配置已经告诉你');
    expect(JSON.stringify(data)).not.toContain('UNDELIVERED_PROPOSAL_CONFIGURATION');
    return response({ supported: false, correction: '实际已送达正文只有邀请，未告知具体配置。' });
  });
  expect(await reviewCompanionSocialProgress('6人配置已经告诉她们了。', [], config, undefined,
    { turns, proposedCalls: [proposed], fetchFn })).toContain('未告知具体配置');
  expect(socialProgressReads([{ ...sent, calls: sent.calls.map(call => ({ ...call, name: 'dsh' })) }]).size).toBe(0);
});

it('reads exact historical task progress as evidence without treating it as a new native effect', async () => {
  const message = JSON.parse(nativeSocialTurns()[0]!.results![0]!.content).socialMessage.message;
  const evidence = { observationChecksum: 'a'.repeat(64), outbound: [{ message, recipientIds: ['deepseek-flash'] }], complete: true };
  const source = task();
  const turn: CompanionLoopTurn = { text: '', rawText: '', calls: [{ id: 'actual_progress', name: 'world',
    arguments: JSON.stringify({ action: 'activity', parameters: { action: 'progress', id: source.id } }) }],
  results: [{ callId: 'actual_progress', content: JSON.stringify({ ok: true, activityTask: source, activityProgressEvidence: evidence }) }] };
  const outbound = socialProgressOutbound([turn]);
  expect(outbound?.outbound).toEqual(evidence.outbound);
  expect(socialProgressReads([turn]).get(message.id)).toEqual(message);
  expect(socialProgressActions([turn])).toEqual([]);
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(data.verifiedOutbound).toEqual([{ id: message.id, conversationId: message.conversationId, authorId: 'alice',
      content: message.content, createdAt: now, recipientIds: ['deepseek-flash'] }]);
    expect(data.nativeActions).toBeUndefined();
    expect(request.messages[0].content).toContain('不是本轮新增发送');
    return response({ supported: true, correction: '' });
  });
  expect(await reviewCompanionSocialProgress('此前给妹妹的邀请里写了这些内容。', [], config, undefined,
    { requireReview: true, outbound, fetchFn })).toBeUndefined();
  expect(fetchFn).toHaveBeenCalledTimes(1);
  for (const receipt of [
    { ok: false, activityTask: source, activityProgressEvidence: evidence },
    { ok: true, activityTask: { ...source, id: 'foreign_task' }, activityProgressEvidence: evidence },
    { ok: true, activityTask: { ...source, historyAvailable: false }, activityProgressEvidence: evidence },
    { ok: true, activityTask: source, activityProgressEvidence: { ...evidence, outbound: [{ message: { ...message, authorId: 'bob' }, recipientIds: ['deepseek-flash'] }] } },
    { ok: true, activityTask: source, activityProgressEvidence: { ...evidence, outbound: [{ message: { ...message, status: 'failed' }, recipientIds: ['deepseek-flash'] }] } },
    { ok: true, activityTask: source },
  ]) {
    const invalid = [{ ...turn, results: [{ callId: 'actual_progress', content: JSON.stringify(receipt) }] }];
    expect(socialProgressOutbound(invalid)).toBeUndefined(); expect(socialProgressReads(invalid).size).toBe(0);
  }
  expect(socialProgressOutbound([{ ...turn, calls: turn.calls.map(call => ({ ...call, name: 'dsh' })) }])).toBeUndefined();
  expect(socialProgressOutbound([{ ...turn, results: [{ callId: 'wrong_call', content: turn.results![0]!.content }] }])).toBeUndefined();
});
