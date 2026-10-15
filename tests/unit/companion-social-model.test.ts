import { expect, it, vi } from 'vitest';
import { authorizeCompanionMessage, generateCompanionSocialReply } from '../../src/main/companions/social-model';
import { generateCompanionSocialNotification } from '../../src/main/companions/social-notification-model';
import type { Companion, CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import type { CompanionSocialNotification, CompanionSocialOrigin } from '../../src/shared/companion-social';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid' };
const companion: Companion = { id: 'deepseek-flash', name: '小肥鱼', description: '妹妹', persona: '姐姐是大肥鱼，爱好音乐。', model: '', avatar: 'flash', builtin: true, proactive: false, createdAt: '2026-10-15T00:00:00Z' };
const members = [companion, { ...companion, id: 'deepseek-sister', name: '大肥鱼' }, { ...companion, id: 'friend', name: '朋友' }];
const conversation: CompanionConversation = { id: 'peer_room', kind: 'group', memberIds: members.map(member => member.id), title: '伙伴群', unread: 0, muted: false, pinned: false, updatedAt: '2026-10-15T00:00:00Z', lastMessage: '' };
const source: CompanionMessage = { id: 'actual_peer', conversationId: conversation.id, sequence: 10, authorId: 'deepseek-sister', content: '妹妹，你想听哪首歌？', kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-15T00:00:00Z' };
const job: CompanionSocialJob = { id: 'job', companionId: companion.id, conversationId: conversation.id, sourceMessageId: source.id, throughSequence: 10, chainId: 'chain', remainingTurns: 3, memberIds: conversation.memberIds, channel: 'phone', status: 'running', attempts: 1, leaseToken: 'lease', typingNotBefore: '2026-10-15T00:00:02Z', createdAt: source.createdAt };
const input = () => ({ companion, conversation, source, messages: [source], job, members, world: { actors: [], events: [], relationships: [], residents: [], scenes: [], works: [], clock: {}, environment: {} } as unknown as CompanionWorldSnapshot });
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
it('provides actual peer identity and bounded turn budget without execution tools or later/user messages', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(request.tools).toBeUndefined(); expect(data.purpose).toBe('world_social');
    expect(data.identity.currentReply).toMatchObject({ sourceMessageId: source.id, speaker: { id: source.authorId }, addressee: { id: source.authorId } });
    expect(data.identity.participants.some((member: { id: string }) => member.id === 'user')).toBe(false);
    expect(data.turnBudget).toEqual({ remainingTurns: 3, mayGrantPlayerAuthority: false }); expect(data.channel).toBe('phone');
    expect(data.messages).toHaveLength(1); expect(JSON.stringify(data)).not.toContain('PRIVATE_PLAYER_DATA'); expect(JSON.stringify(data)).not.toContain('FUTURE_PEER_DATA');
    return response({ text: '姐姐，想听轻快一点的。', nextRecipientId: source.authorId, reason: '回复实际姐姐来信。' });
  });
  await expect(generateCompanionSocialReply({ ...input(), messages: [source, { ...source, id: 'private', authorId: 'user', content: 'PRIVATE_PLAYER_DATA' }, { ...source, id: 'later', sequence: 11, content: 'FUTURE_PEER_DATA' }] }, config, undefined, { fetchFn })).resolves.toMatchObject({ nextRecipientId: source.authorId });
});
it.each(['user', 'outsider', companion.id])('refuses a forged %s peer source before issuing a model call', async authorId => {
  const fetchFn = vi.fn<typeof fetch>(); await expect(generateCompanionSocialReply({ ...input(), source: { ...source, authorId } }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(fetchFn).not.toHaveBeenCalled();
});
it.each(['user', 'outsider', companion.id])('rejects model continuation to %s without widening the real member set', async nextRecipientId => {
  await expect(generateCompanionSocialReply(input(), config, undefined, { fetchFn: async () => response({ text: '继续聊', nextRecipientId, reason: '测试成员范围。' }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('accepts silence as a natural end instead of inventing another round', async () => {
  await expect(generateCompanionSocialReply(input(), config, undefined, { fetchFn: async () => response({ text: null, reason: '对方已经说晚安，不再打扰。' }) })).resolves.toMatchObject({ text: null });
});
it('binds a peer work offer to the current actual sender and preserves the recipient decision without external authority', async () => {
  const value = input(), content = '请帮我读一下这段文章，给我三点建议。';
  value.source = { ...source, content }; value.messages = [value.source];
  const offer = { sourceMessageId: source.id, title: '阅读文章并建议', instruction: content, evidence: [content], accept: true };
  const result = await generateCompanionSocialReply(value, config, undefined, { fetchFn: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(data.identity.self.id).toBe(companion.id); expect(data.identity.currentReply.speaker.id).toBe(source.authorId);
    expect(data.source).toMatchObject({ id: source.id, authorId: source.authorId, content }); expect(data.turnBudget.mayGrantPlayerAuthority).toBe(false); expect(body.tools).toBeUndefined();
    return response({ text: '好，我会读完后给你三点建议。', reason: '来信者明确请求阅读工作，我决定接受。', workOffer: offer });
  } });
  expect(result.workOffer).toEqual(offer);
});
it.each(['source', 'evidence', 'silence'])('rejects ungrounded peer work %s without editing the generated prose into a false valid answer', async field => {
  const offer = { sourceMessageId: field === 'source' ? 'private_player_source' : source.id, title: '伪造的工作', instruction: '替他人执行', evidence: [field === 'evidence' ? '这句话并不存在' : source.content], accept: true };
  await expect(generateCompanionSocialReply(input(), config, undefined, { fetchFn: async () => response({ text: field === 'silence' ? null : '收到', reason: '测试来源验证', workOffer: offer }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('projects peer world facts without task reasons, other-room speech, private routine titles or source identifiers', async () => {
  const value = input();
  value.world.works = [{ companionId: companion.id, kind: 'action', status: 'waiting', workId: 'private_action', reason: 'PRIVATE_TASK_TEXT' }];
  value.world.events = [
    { id: 'other_event', sequence: 1, kind: 'social_phone', conversationId: 'other_room', sourceMessageId: 'other_source', text: 'OTHER_PEER_ROOM_TEXT', simulation: true, at: source.createdAt, realAt: source.createdAt },
    { id: 'allowed_event', sequence: 2, kind: 'social_phone', actorId: source.authorId, targetId: companion.id, conversationId: conversation.id, sourceMessageId: source.id, text: source.content, simulation: true, at: source.createdAt, realAt: source.createdAt },
  ];
  const routine = { companionId: companion.id, revision: 1, createdAt: source.createdAt, updatedAt: source.createdAt, sourceMessageId: 'PRIVATE_ROUTINE_SOURCE',
    config: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [{ name: 'PRIVATE_MEAL_TITLE', at: '12:00', durationMinutes: 30 }],
      habits: [{ id: 'PRIVATE_HABIT_ID', title: 'PRIVATE_HABIT_TITLE', kind: 'study' as const, at: '14:00', durationMinutes: 30 }] },
    habitProgress: [{ id: 'PRIVATE_HABIT_ID', strength: 12, completedCount: 2, practicedMinutes: 60, streak: 2 }],
    runtime: { phase: 'awake' as const, activity: 'PRIVATE_RUNTIME_ACTIVITY', activeHabitId: 'PRIVATE_HABIT_ID', nextTransitionAt: source.createdAt, canRespond: true, simulation: true as const } };
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content), text = JSON.stringify(data);
    for (const secret of ['PRIVATE_TASK_TEXT', 'OTHER_PEER_ROOM_TEXT', 'PRIVATE_ROUTINE_SOURCE', 'PRIVATE_MEAL_TITLE', 'PRIVATE_HABIT_ID', 'PRIVATE_HABIT_TITLE', 'PRIVATE_RUNTIME_ACTIVITY']) expect(text).not.toContain(secret);
    expect(data.world.works).toBeUndefined(); expect(data.world.events).toHaveLength(1); expect(data.world.events[0].id).toBe('allowed_event');
    expect(data.routine.habitProgress[0]).toMatchObject({ id: 'habit_0', strength: 12, practicedMinutes: 60 });
    return response({ text: null, reason: '没有额外内容。' });
  };
  await generateCompanionSocialReply({ ...value, routine }, config, undefined, { fetchFn });
});
it('requires confident exact current user sharing evidence, and never accepts peer speech as consent', async () => {
  const user = { ...source, authorId: 'user', content: '请把“晚上一起听音乐”发给大肥鱼。' };
  const fetchFn = vi.fn<typeof fetch>(async () => response({ allowed: true, confidence: .98, evidence: [user.content], reason: '明确当前发送内容和收件人。' }));
  const request = { source: user, recipients: [{ id: 'deepseek-sister', name: '大肥鱼' }], text: '晚上一起听音乐' };
  expect(await authorizeCompanionMessage(request, config, undefined, { fetchFn })).toBe(true);
  expect(await authorizeCompanionMessage({ ...request, source }, config, undefined, { fetchFn })).toBe(false); expect(fetchFn).toHaveBeenCalledOnce();
  expect(await authorizeCompanionMessage(request, config, undefined, { fetchFn: async () => response({ allowed: true, confidence: .89, evidence: [user.content], reason: '含混。' }) })).toBe(false);
  await expect(authorizeCompanionMessage(request, config, undefined, { fetchFn: async () => response({ allowed: true, confidence: .99, evidence: ['伪造授权'], reason: '无真实证据。' }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('keeps a host-verified human initiator across peer turns even when a peer incorrectly suggests the sister sent her', async () => {
  const origin: CompanionSocialOrigin = { id: 'delegation', initiatorId: 'user', initiatorKind: 'human_player', ownerId: companion.id,
    sharedText: '菲比，一起玩吗？', provenance: 'current_player_request' };
  const incoming = { ...source, authorId: 'friend', content: '是姐姐让你来找我的吗？' };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), payload = JSON.parse(request.messages[1].content);
    expect(payload.identity.self.id).toBe(companion.id); expect(payload.identity.currentReply.author.id).toBe(companion.id);
    expect(payload.identity.currentReply.speaker.id).toBe('friend'); expect(payload.origin).toEqual(origin);
    expect(payload.identity.origin.initiatorId).toBe('user'); expect(payload.identity.characterRelations[0].targetId).toBe('deepseek-sister');
    expect(payload.identity.participants.some((person: { id: string }) => person.id === 'user')).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_PLAYER_DATA'); expect(request.tools).toBeUndefined();
    return response({ text: payload.origin.initiatorId === 'user' ? '是玩家让我来找你玩的。' : '没有可核对的发起者。', reason: '按宿主原始发起者回应，不沿用来信猜测。' });
  });
  const result = await generateCompanionSocialReply({ ...input(), source: incoming, messages: [incoming, { ...source, authorId: 'user', content: 'PRIVATE_PLAYER_DATA' }], job: { ...job, origin } }, config, undefined, { fetchFn });
  expect(result.text).toBe('是玩家让我来找你玩的。');
  await expect(generateCompanionSocialReply({ ...input(), job: { ...job, origin: { ...origin, initiatorId: 'deepseek-sister' } } }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(fetchFn).toHaveBeenCalledOnce();
});
it('reports one committed peer event to the actual original player without importing private transcripts or granting tools', async () => {
  const playerRoom = { ...conversation, id: 'private_flash', kind: 'private' as const, memberIds: [companion.id] };
  const player = { ...source, id: 'player_request', conversationId: playerRoom.id, authorId: 'user', content: '去找朋友玩。PRIVATE_USER_HISTORY' };
  const notification: CompanionSocialNotification = { id: 'notice', companionId: companion.id, conversationId: playerRoom.id,
    sourceMessageId: player.id, origin: { id: 'delegation', initiatorId: 'user', initiatorKind: 'human_player', ownerId: companion.id, sharedText: '一起玩吗？', provenance: 'current_player_request' },
    kind: 'peer_reply', eventId: 'actual_peer_reply', peerConversationId: conversation.id, evidence: { authorId: 'friend', messageId: 'actual_peer_reply', text: '可以来玩。' },
    status: 'running', attempts: 1, leaseToken: 'lease', createdAt: source.createdAt };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), payload = JSON.parse(request.messages[1].content);
    expect(payload.purpose).toBe('world_social_notification'); expect(payload.identity.currentReply.speaker.id).toBe('user');
    expect(payload.identity.currentReply.author.id).toBe(companion.id); expect(payload.origin.initiatorId).toBe('user');
    expect(payload.confirmedEvent).toEqual({ eventId: notification.eventId, kind: 'peer_reply', evidence: notification.evidence });
    expect(payload.continuation).toEqual({ solicited: true, mayGrantExternalExecution: false }); expect(request.tools).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_USER_HISTORY');
    return response({ text: '朋友回复说可以来玩，我还没有到她家。', eventId: notification.eventId, initiatorId: 'user' });
  });
  const value = { companion, conversation: playerRoom, source: player, notification, world: input().world, members };
  await expect(generateCompanionSocialNotification(value, config, undefined, { fetchFn })).resolves.toContain('还没有到');
  await expect(generateCompanionSocialNotification(value, config, undefined, { fetchFn: async () => response({ text: '错误来源不得接入', eventId: notification.eventId, initiatorId: 'deepseek-sister' }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
