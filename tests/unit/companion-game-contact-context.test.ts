import { expect, it, vi } from 'vitest';
import { createdInvocationTopicPort, isVerifiedCompanionGameContactContext, resolveCompanionGameContactContext,
  resolveCompanionGameInitiativeContext, isVerifiedCompanionGameInitiativeContext, loadCompanionGameCommunication } from '../../src/main/companions/game-contact-context';
import { authorizeCompanionContact, authorizeCompanionSocialInitiative } from '../../src/main/companions/social-model';
import { companionCapabilityArgumentFeedback, normalizeCompanionCapabilityCall } from '../../src/shared/companion-capability-tools';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../src/shared/companion-loop';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import { createHash } from 'node:crypto';
const at = '2026-10-23T09:00:00.000Z';
const source: CompanionMessage = { id: 'human_game', conversationId: 'private_owner', sequence: 1, authorId: 'user', kind: 'text',
  content: '去找妹妹和朋友玩一局狼人杀，结束告诉我结果。', status: 'sent', attachments: [], createdAt: at };
const scope = { companionId: 'owner', conversationId: source.conversationId };
const topic = { id: 'game_topic', conversationId: 'actual_group', title: '本局游戏', kind: 'game' as const, status: 'active' as const,
  participantIds: ['owner', 'kimi', 'qwen'], invitedIds: [], tags: [], moderatorId: 'owner', revision: 4, createdAt: at, updatedAt: at };
const turns: CompanionLoopTurn[] = [{ text: '', rawText: '', calls: [{ id: 'created', name: 'world', arguments: JSON.stringify({ action: 'create_group',
  recipientIds: ['kimi', 'qwen'], title: '本局', text: '愿意参加吗？', topic: { title: '本局游戏', kind: 'game' } }) }], results: [{ callId: 'created',
  content: JSON.stringify({ ok: true, socialConversation: { id: topic.conversationId, kind: 'group', title: '本局', memberIds: topic.participantIds, updatedAt: at, messageCount: 0 }, topic }) }] }];

it('uses only the leased host query to brand a private message same-game reference and preserves its actual source port', async () => {
  const peer = { ...source, id: 'private_actual', authorId: 'owner', conversationId: 'actual_private_pair', content: '请与队友核对本人行动。' };
  const job: CompanionSocialJob = { id: 'leased_job', companionId: 'kimi', conversationId: peer.conversationId, sourceMessageId: peer.id,
    throughSequence: peer.sequence, chainId: 'actual_chain', remainingTurns: 2, memberIds: ['owner', 'kimi'], channel: 'phone', status: 'running', attempts: 1,
    leaseToken: 'actual_lease', typingNotBefore: at, createdAt: at };
  const digest = createHash('sha256').update(peer.content).digest('hex');
  const query = { gamePort: { conversationId: topic.conversationId, topicId: topic.id }, topic,
    topicState: { topicId: topic.id, readerId: 'kimi', trust: 'topic_state_not_real_world_facts' as const },
    binding: { jobId: job.id, companionId: 'kimi', sourceMessageId: peer.id, sourceConversationId: peer.conversationId, sourceChecksum: digest },
    trust: 'actual_job_same_game_reference_not_source_or_human_authority' as const };
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async command => {
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: [peer] };
    if (command.type === 'social.job.game_context') return { ok: true, socialGameContext: query };
    throw new Error('Must not infer a game from global topic listings or rewrite the private port');
  });
  const game = await resolveCompanionGameInitiativeContext(request, { scope: { companionId: 'kimi', conversationId: peer.conversationId }, source: peer, recipientIds: ['qwen'], job });
  expect(isVerifiedCompanionGameInitiativeContext(game)).toBe(true);
  expect(game?.sourceMessageId).toBe(peer.id); expect(peer.topicId).toBeUndefined();
  expect(request).toHaveBeenCalledWith({ type: 'social.job.game_context', id: job.id, leaseToken: job.leaseToken, companionId: 'kimi', conversationId: peer.conversationId,
    sourceMessageId: peer.id, sourceChecksum: digest, recipientIds: ['qwen'] });
  expect(await loadCompanionGameCommunication(async () => ({ ok: true, socialGameContext: { ...query, binding: { ...query.binding, sourceChecksum: 'a'.repeat(64) } } }), { job, source: peer })).toBeUndefined();
  expect(await loadCompanionGameCommunication(request, { job: { ...job, leaseToken: undefined }, source: peer })).toBeUndefined();
});
function fixture(options: { current?: CompanionMessage; kind?: 'game' | 'discussion'; participants?: string[]; activity?: boolean } = {}) {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async command => {
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: [options.current ?? source] };
    if (command.type === 'activity.list') return { ok: true, activityTasks: options.activity ? [{ id: 'actual_activity', ...scope, sourceMessageId: source.id,
      title: '继续本局', goal: source.content, status: 'waiting', step: 1, attempts: 0, createdAt: at, updatedAt: at, deadline: at,
      stage: '等待', historyAvailable: true, history: [], peerConversationId: topic.conversationId, peerTopicId: topic.id }] : [] };
    if (command.type === 'topic.read') return { ok: true, topic: { ...topic, kind: options.kind ?? 'game', participantIds: options.participants ?? topic.participantIds },
      topicState: { topicId: topic.id, readerId: 'owner', trust: 'topic_state_not_real_world_facts' } };
    throw new Error('Unexpected context read');
  }); return request;
}
it('admits only a real current joined source port for a participant own game message, with no human execution authority', async () => {
  const peer = { ...source, id: 'actual_peer_game', conversationId: topic.conversationId, topicId: topic.id, authorId: 'owner', content: '夜间有行动的各自实际单独联系主持，群里不报目标。' };
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async command => command.type === 'memory.sources.filter'
    ? { ok: true, memorySources: [peer] } : { ok: true, topic, topicState: { topicId: topic.id, readerId: 'kimi', trust: 'topic_state_not_real_world_facts' } });
  const game = await resolveCompanionGameInitiativeContext(request, { scope: { companionId: 'kimi', conversationId: topic.conversationId }, source: peer, recipientIds: ['owner'] });
  expect(game).toMatchObject({ actorId: 'kimi', sourceMessageId: peer.id, delivery: { recipientIds: ['owner'], audience: 'individual' },
    trust: 'actual_joined_game_own_virtual_communication_not_human_execution_authority' });
  expect(isVerifiedCompanionGameInitiativeContext(game)).toBe(true); expect(isVerifiedCompanionGameInitiativeContext({ ...game! })).toBe(false);
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(data.verifiedGameInitiative).toMatchObject({ actorId: 'kimi', sourceMessageId: peer.id });
    expect(body.messages[0].content).toContain('不限于首次问候'); expect(body.messages[0].content).toContain('不是人类执行授权');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: true, confidence: .99, reason: '仅本局本人动作，真实单独向主持报告。' }) } }] }));
  });
  const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' };
  expect(await authorizeCompanionSocialInitiative({ companion: { id: 'kimi', name: 'Kimi' }, recipients: [{ id: 'owner', name: '主持' }],
    text: '第二夜我的行动目标是qwen。', privateSources: [peer], game }, config, undefined, { fetchFn })).toBe(true);
  const forgedFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(data.verifiedGameInitiative).toBeUndefined(); expect(body.messages[0].content).toContain('自然问候');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: false, confidence: .99, reason: '无真实game上下文，不允许借伪造上下文转发。' }) } }] }));
  });
  expect(await authorizeCompanionSocialInitiative({ companion: { id: 'kimi', name: 'Kimi' }, recipients: [{ id: 'owner', name: '主持' }],
    text: '第二夜我的行动目标是qwen。', privateSources: [peer], game: { ...game! } }, config, undefined, { fetchFn: forgedFetch })).toBe(false);
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(['memory.sources.filter', 'topic.read', 'memory.sources.filter']);
});
it.each(['withdrawn', 'updated', 'foreign_recipient', 'unjoined', 'non_game'] as const)('refuses an invalid initiative game source without minting authority: %s', async mode => {
  const peer = { ...source, id: 'actual_peer_game', conversationId: topic.conversationId, topicId: topic.id, authorId: 'owner' };
  let sourceReads = 0;
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async command => {
    if (command.type === 'memory.sources.filter') { sourceReads++; return { ok: true, memorySources: sourceReads > 1 && mode === 'withdrawn' ? []
      : [{ ...peer, content: sourceReads > 1 && mode === 'updated' ? '原来源已改变' : peer.content }] }; }
    return { ok: true, topic: { ...topic, kind: mode === 'non_game' ? 'discussion' : 'game', participantIds: mode === 'unjoined' ? ['owner', 'qwen'] : topic.participantIds },
      topicState: { topicId: topic.id, readerId: 'kimi', trust: 'topic_state_not_real_world_facts' } };
  });
  expect(await resolveCompanionGameInitiativeContext(request, { scope: { companionId: 'kimi', conversationId: topic.conversationId }, source: peer,
    recipientIds: mode === 'foreign_recipient' ? ['foreign'] : ['owner'] })).toBeUndefined();
  expect(request.mock.calls.every(([command]) => ['memory.sources.filter', 'topic.read'].includes(command.type))).toBe(true);
});
it('binds game communication to an actual creation receipt or same-source typed activity without global group guessing', async () => {
  const request = fixture();
  expect(createdInvocationTopicPort(turns, 'owner', topic.id)).toEqual({ roomId: topic.conversationId, topicId: topic.id });
  const context = await resolveCompanionGameContactContext(request, { scope, source, recipientIds: ['kimi'], turns });
  expect(context).toMatchObject({ kind: 'game', ownerRole: 'moderator', sourceMessageId: source.id, conversationId: topic.conversationId,
    provenance: 'current_invocation_created_group', permissions: { realExecution: false, privateConversationForwarding: false } });
  expect(isVerifiedCompanionGameContactContext(context, source, ['kimi'])).toBe(true);
  expect(isVerifiedCompanionGameContactContext({ ...context }, source, ['kimi'])).toBe(false);
  expect(isVerifiedCompanionGameContactContext(context, { ...source, content: '修改后的请求' }, ['kimi'])).toBe(false);
  expect(await resolveCompanionGameContactContext(fixture({ activity: true }), { scope, source, recipientIds: ['kimi'], turns: [] }))
    .toMatchObject({ provenance: 'current_source_activity_port' });
  const noPort = fixture(); expect(await resolveCompanionGameContactContext(noPort, { scope, source, recipientIds: ['kimi'], turns: [] })).toBeUndefined();
  expect(noPort.mock.calls.some(([command]) => command.type === 'topic.read')).toBe(false);
});
it('refuses foreign recipients, unjoined actors, non-game topics and changed source before granting context', async () => {
  for (const [request, recipients] of [[fixture(), ['outsider']], [fixture({ participants: ['owner', 'qwen'] }), ['kimi']],
    [fixture({ kind: 'discussion' }), ['kimi']], [fixture({ current: { ...source, content: '撤回旧游戏' } }), ['kimi']]] as const) {
    expect(await resolveCompanionGameContactContext(request, { scope, source, recipientIds: recipients, turns })).toBeUndefined();
  }
  expect(await resolveCompanionGameContactContext(fixture(), { scope, source: { ...source, authorId: 'kimi' }, recipientIds: ['kimi'], turns })).toBeUndefined();
});
it('provides verified game role boundaries to the existing source authorizer while forged context and private forwarding stay unsupported', async () => {
  const game = await resolveCompanionGameContactContext(fixture(), { scope, source, recipientIds: ['kimi'], turns });
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(body.messages[0].content).toContain('验人结果'); expect(data.verifiedGame).toMatchObject({ topicId: topic.id, ownerRole: 'moderator' });
    expect(body.messages[0].content).toContain('不要重新要求玩家逐字授权');
    expect(data.source.content).toBe(source.content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: true, confidence: .99, evidence: [source.content],
      reason: '仅允许本局主持给真实玩家的游戏结果。', intent: 'message', requiresContinuation: true, requiresCollaboration: false }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid' };
  expect(await authorizeCompanionContact({ source, recipients: [{ id: 'kimi', name: 'Kimi' }], text: '本局验人结果只私回你。', game }, config, undefined, { fetchFn }))
    .toMatchObject({ allowed: true, requiresCollaboration: false });
  const rejected = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(data).not.toHaveProperty('verifiedGame');
    expect(body.messages[0].content).toContain('是否明确要求把拟发内容');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: false, confidence: .99, evidence: [source.content],
      reason: '私人背景与本局目标无关。', intent: 'message', requiresContinuation: false }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  expect(await authorizeCompanionContact({ source, recipients: [{ id: 'kimi', name: 'Kimi' }], text: 'PRIVATE_BACKGROUND', game: { ...game! } }, config, undefined, { fetchFn: rejected }))
    .toMatchObject({ allowed: false });
});
it('returns exact operation paths and a minimal valid shape when a model places room/topic in the patch', () => {
  const call: CompanionLoopCall = { id: 'bad', name: 'world', arguments: JSON.stringify({ action: 'topic', parameters: { action: 'update', expectedRevision: 4,
    patch: { roomId: 'actual_group', topicId: 'game_topic', privateRecipientId: 'kimi', workingState: { summary: '私牌' } } } }) };
  let error: unknown; try { normalizeCompanionCapabilityCall(call); } catch (reason) { error = reason; }
  const feedback = companionCapabilityArgumentFeedback(call, error);
  expect(feedback.argumentIssues).toContainEqual(expect.objectContaining({ path: 'parameters.patch.roomId', message: expect.stringContaining('与patch同级') }));
  expect(feedback.argumentIssues).toContainEqual(expect.objectContaining({ path: 'parameters.topicId' }));
  expect(feedback.minimumExample).toMatchObject({ action: 'topic', parameters: { action: 'update', topicId: expect.any(String), expectedRevision: expect.any(Number) } });
});
it('passes the actual multi-recipient delivery to the game privacy review and returns its specific repair reason', async () => {
  const game = await resolveCompanionGameContactContext(fixture(), { scope, source, recipientIds: ['kimi', 'qwen'], turns,
    delivery: { channel: 'phone', roomId: topic.conversationId, topicId: topic.id } });
  const reason = '群消息会公开他人身份；用 topic.update.patch.privateRecipientId 和 workingState 分发本人私态。';
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(body.messages[0].content).toContain('multiple_participants');
    expect(data.verifiedGame.delivery).toMatchObject({ audience: 'multiple_participants', actualRecipientIds: ['kimi', 'qwen'],
      requestedRoomId: topic.conversationId, requestedTopicId: topic.id });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: false, confidence: .99,
      evidence: [source.content], reason, intent: 'message', requiresContinuation: true, requiresCollaboration: false }) } }] }),
    { headers: { 'Content-Type': 'application/json' } });
  });
  expect(await authorizeCompanionContact({ source, recipients: [{ id: 'kimi', name: 'Kimi' }, { id: 'qwen', name: 'Qwen' }],
    text: '私发给Kimi：你的身份是狼人；Qwen也请接收。', game },
  { apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid' }, undefined, { fetchFn }))
    .toMatchObject({ allowed: false, reason });
});
it('repairs schema and exact-quote errors for the actual failed public rules proposal without changing its goal or audience', async () => {
  const recipientIds = ['grok', 'deepseek-flash', 'kimi'];
  const game = await resolveCompanionGameContactContext(fixture({ participants: ['owner', ...recipientIds] }), { scope, source, recipientIds, turns,
    delivery: { channel: 'phone', roomId: topic.conversationId, topicId: topic.id } });
  const text = '先把人数和流程一次讲清，免得再来回猜。\n【两条路，大家挑一条】\nA. 4人快局（不再补人）：Kimi 进话题报名，四位玩家＝我、小肥鱼、Grok、Kimi，我下场抽牌不主持；牌表2狼＋1预言家＋1村民＝4，屠边。\nB. 6人标准局：我主持、不抽牌，玩家＝小肥鱼、Grok、Kimi＋再找两位，牌表2狼＋1预言家＋1女巫＋2村民＝6。\n身份牌由我一一私发本人、绝不公开；夜里一对一收行动再公布结果；白天按座位顺序发言然后全体投票。名单和牌表数量对不上就不发牌。';
  let calls = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content); calls++;
    expect(data.source.content).toBe(source.content); expect(data.proposedText).toBe(text);
    expect(data.recipients.map((item: { id: string }) => item.id)).toEqual(recipientIds);
    if (calls === 2) expect(data.outputCorrection.error).toContain('extraAuthority');
    if (calls === 3) expect(data.outputCorrection.error).toContain('evidence[0]');
    const reply = { allowed: true, confidence: .99, intent: 'message', requiresContinuation: true, reason: '仅本局必要的公开规则确认。',
      evidence: calls === 2 ? ['先把人数和流程一次讲清'] : [source.content], ...(calls === 1 ? { extraAuthority: true } : {}) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  expect(await authorizeCompanionContact({ source, recipients: recipientIds.map(id => ({ id, name: id })), text, game },
    { apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid' }, undefined, { fetchFn }))
    .toMatchObject({ allowed: true, intent: 'message', requiresContinuation: true });
  expect(fetchFn).toHaveBeenCalledTimes(3);
});
it('does not turn a repaired privacy rejection into permission and reports persistent malformed evidence precisely', async () => {
  const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid' };
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: false,
    confidence: .99, evidence: [source.content], reason: '不可公开他人私牌或转发私人背景。', intent: 'message', requiresContinuation: true }) } }] }),
    { headers: { 'Content-Type': 'application/json' } }));
  expect(await authorizeCompanionContact({ source, recipients: [{ id: 'kimi', name: 'Kimi' }], text: 'PRIVATE_BACKGROUND' }, config, undefined, { fetchFn }))
    .toMatchObject({ allowed: false, reason: '不可公开他人私牌或转发私人背景。' });
  expect(fetchFn).toHaveBeenCalledOnce();
  const malformed = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: true,
    confidence: .99, evidence: ['不在原文中的伪造授权'], reason: '虚假的证据', intent: 'message', requiresContinuation: true }) } }] }),
    { headers: { 'Content-Type': 'application/json' } }));
  await expect(authorizeCompanionContact({ source, recipients: [{ id: 'kimi', name: 'Kimi' }], text: 'PRIVATE_BACKGROUND' }, config, undefined, { fetchFn: malformed }))
    .rejects.toThrow('evidence[0]');
  expect(malformed).toHaveBeenCalledTimes(3);
});
