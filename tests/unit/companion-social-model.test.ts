import { COMPANION_SUBMIT_RESULT_TOOL } from '../../src/shared/companion-final-proposal';
import { expect, it, vi } from 'vitest';
import { authorizeCompanionContact, authorizeCompanionMessage, authorizeCompanionSocialInitiative, generateCompanionSocialReply } from '../../src/main/companions/social-model';
import { generateCompanionSocialNotification } from '../../src/main/companions/social-notification-model';
import { generateCompanionVisitSpeech } from '../../src/main/companions/visit-speech-model';
import type { CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { Companion, CompanionConversation, CompanionMessage, CompanionMemory } from '../../src/shared/companions';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import type { CompanionSocialNotification, CompanionSocialOrigin } from '../../src/shared/companion-social';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import { createHash } from 'node:crypto';
const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid' };
const companion: Companion = { id: 'deepseek-flash', name: '小肥鱼', description: '妹妹', persona: '姐姐是大肥鱼，爱好音乐。', model: '', avatar: 'flash', builtin: true, proactive: false, createdAt: '2026-10-15T00:00:00Z' };
const members = [companion, { ...companion, id: 'deepseek-sister', name: '大肥鱼' }, { ...companion, id: 'friend', name: '朋友' }];
const conversation: CompanionConversation = { id: 'peer_room', kind: 'group', memberIds: members.map(member => member.id), title: '伙伴群', unread: 0, muted: false, pinned: false, updatedAt: '2026-10-15T00:00:00Z', lastMessage: '' };
const source: CompanionMessage = { id: 'actual_peer', conversationId: conversation.id, sequence: 10, authorId: 'deepseek-sister', content: '妹妹，你想听哪首歌？', kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-15T00:00:00Z' };
const job: CompanionSocialJob = { id: 'job', companionId: companion.id, conversationId: conversation.id, sourceMessageId: source.id, throughSequence: 10, chainId: 'chain', remainingTurns: 3, memberIds: conversation.memberIds, channel: 'phone', status: 'running', attempts: 1, leaseToken: 'lease', typingNotBefore: '2026-10-15T00:00:02Z', createdAt: source.createdAt };
const input = () => ({ companion, conversation, source, messages: [source], job, members, world: {
  settings: { revision: 1, mode: 'realtime', dayDurationMinutes: 20, timeZone: 'UTC' },
  clock: { realNow: source.createdAt, virtualNow: source.createdAt, speed: 1, day: 1, hour: 0, daylight: false },
  actors: [], events: [], relationships: [], residents: [], scenes: [], works: [], visits: [], lastEventSequence: 0, backlog: false,
  environment: { weather: 'rain', light: .2, outdoorTemperature: 14, indoorTemperature: 21 },
  perception: { companionId: companion.id, observedAtReal: source.createdAt, observedAtVirtual: source.createdAt,
    sceneId: 'home_flash', position: { x: 4, y: 4 }, activity: 'idle', radius: 5, awake: true, revision: 1,
    environment: { time: source.createdAt, light: .3, temperature: 21, daylight: false },
    people: [], objects: [], visibleObjectIds: [], visibleCompanionIds: [] },
} as CompanionWorldSnapshot });
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
it('corrects a public game final containing a private night action, sends an actual single-recipient tool message, then publishes only a safe acknowledgement', async () => {
  const gameSource = { ...source, topicId: 'actual_game', content: '第二夜，有行动的角色请真实单独联系主持，群里不要报目标。' };
  let authorCalls = 0, reviewCalls = 0;
  const execute = vi.fn(async (call: { arguments: string }) => {
    expect(JSON.parse(call.arguments)).toEqual({ action: 'message', recipientIds: ['deepseek-sister'], text: '我第二夜的私密目标是friend。' });
    return { ok: true, socialConversation: { id: 'actual_pair', memberIds: [companion.id, 'deepseek-sister'] }, socialMessage: { message: { id: 'actual_private_send' } } };
  });
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
    if (data.purpose === 'game_public_reply_privacy') {
      reviewCalls++; expect(data.actualAudience.memberIds).toEqual(conversation.memberIds);
      const allowed = data.exactProposedText === '收到，已按要求单独联系主持。';
      return response({ allowed, confidence: .99, reason: allowed ? '公共回执没有秘密。' : '群final直接报夜间目标，需实际单独message后再回公共无敏感内容。' });
    }
    expect(data.purpose).toBe('world_social'); authorCalls++;
    if (authorCalls === 1) return response({ text: '我私报第二夜目标是friend。', reason: '拟报夜间行动' });
    if (authorCalls === 2) {
      expect(data.outputCorrection.error).toContain('实际群投递');
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'actual_private_call', type: 'function',
        function: { name: 'world', arguments: JSON.stringify({ action: 'message', recipientIds: ['deepseek-sister'], text: '我第二夜的私密目标是friend。' }) } }] } }] }));
    }
    return response({ text: '收到，已按要求单独联系主持。', reason: '真实私信已送达，公共只回执。' });
  });
  const result = await generateCompanionSocialReply({ companion, conversation, source: gameSource, messages: [gameSource], job: { ...job, sourceMessageId: gameSource.id },
    members, world: input().world, topic: { id: 'actual_game', conversationId: conversation.id, title: '本局', kind: 'game', status: 'active', moderatorId: 'deepseek-sister',
      participantIds: conversation.memberIds, invitedIds: conversation.memberIds, tags: [], revision: 1, createdAt: source.createdAt, updatedAt: source.createdAt },
    topicState: { topicId: 'actual_game', readerId: companion.id, trust: 'topic_state_not_real_world_facts' } }, config, undefined, { fetchFn,
    capabilities: { replaySafe: true, tools: [{ name: 'world', description: '实际单独联系能力', parameters: { type: 'object' } }], execute } });
  expect(result.text).toBe('收到，已按要求单独联系主持。'); expect(execute).toHaveBeenCalledOnce(); expect(authorCalls).toBe(3); expect(reviewCalls).toBe(2);
});
it.each([true, false])('classifies continuation from the original full human goal independently of the initial proposed greeting: %s', async requiresContinuation => {
  const human = { ...source, authorId: 'user', content: requiresContinuation ? '找妹妹和其他伙伴一起组织游戏并玩起来。' : '帮我问妹妹吃饭了吗，把答复告诉我。' };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(data.source.content).toBe(human.content); expect(data.proposedText).toBe('你好，现在方便吗？');
    expect(data.continuationRules).toContain('不能按这次proposedText的第一步代替');
    expect(data.outputSchema.required).toContain('requiresContinuation');
    return response({ allowed: true, confidence: .99, evidence: [human.content], reason: '依据原目标判断是否还有后续步骤。', intent: 'message', requiresContinuation });
  });
  expect(await authorizeCompanionContact({ source: human, recipients: [members[1]!], text: '你好，现在方便吗？' }, config, undefined, { fetchFn }))
    .toEqual({ allowed: true, intent: 'message', requiresContinuation });
});
it('distinguishes a real independently executed subtask from social continuation without granting it authority', async () => {
  const human = { ...source, authorId: 'user', content: '请你分析这份CSV，再请周岚独立用DSH复核；我授权本次分工及必要的文件路径共享。' };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(data.source.content).toBe(human.content); expect(data.proposedText).toBe('周岚你好，我是林澄。');
    expect(data.collaborationRules).toContain('不创建grant');
    expect(data.collaborationRules).toContain('即使proposedText只是第一句问候');
    expect(data.outputSchema.properties.requiresCollaboration.type).toBe('boolean');
    return response({ allowed: true, confidence: .99, evidence: [human.content], reason: '允许认识，但实际分工需要独立授权。',
      intent: 'message', requiresContinuation: true, requiresCollaboration: true });
  });
  expect(await authorizeCompanionContact({ source: human, recipients: [members[1]!], text: '周岚你好，我是林澄。' }, config, undefined, { fetchFn }))
    .toEqual({ allowed: true, intent: 'message', requiresContinuation: true, requiresCollaboration: true });
});
it('preserves human presence and distinct speaker identity in companion-created player groups', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(data.identity.audience).toBe('player');
    expect(data.identity.participants.map((person: { id: string }) => person.id)).toContain('user');
    expect(data.identity.self.id).toBe(companion.id);
    expect(data.identity.currentReply.speaker.id).toBe(source.authorId);
    expect(data.messages.map((message: { authorId: string }) => message.authorId)).toEqual(['user', source.authorId]);
    expect(data.messages[0].content).toBe('我是真人，等我一起玩。');
    expect(request.messages[0].content).not.toContain('这是独立peer-only伙伴通信，没有玩家在会话中。');
    return response({ text: '姐姐，我们等玩家一起。', reason: '按真实成员与来源回应。' });
  });
  await generateCompanionSocialReply({ ...input(), conversation: { ...conversation, peerOnly: false }, messages: [
    { ...source, id: 'human_group_message', sequence: 9, authorId: 'user', content: '我是真人，等我一起玩。' }, source,
  ] }, config, undefined, { fetchFn });
  expect(fetchFn).toHaveBeenCalledOnce();
});
it.each([{ allowed: true, confidence: .98, expected: true }, { allowed: true, confidence: .5, expected: false }, { allowed: false, confidence: .99, expected: false }])('checks autonomous social content without inventing human authorization: $expected', async proposal => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(data.purpose).toBe('companion_social_initiative'); expect(data.self.id).toBe(companion.id);
    expect(data.proposedText).toBe('你好，想邀请你一起玩狼人杀。');
    expect(data).not.toHaveProperty('source');
    expect(data.privateSources[0].content).toBe('PRIVATE_CONTENT_FOR_LEAK_CHECK_ONLY');
    return response({ allowed: proposal.allowed, confidence: proposal.confidence, reason: '核验角色自身问候与私密来源。' });
  });
  expect(await authorizeCompanionSocialInitiative({ companion, recipients: [members[1]!], text: '你好，想邀请你一起玩狼人杀。',
    privateSources: [{ id: 'private_source', authorId: 'user', content: 'PRIVATE_CONTENT_FOR_LEAK_CHECK_ONLY' }] }, config, undefined, { fetchFn })).toBe(proposal.expected);
});
it('uses only the currently verified own-scope self-understanding and retains its uncertainty in peer speech', async () => {
  const characterDevelopment = { companionId: companion.id, conversationId: conversation.id, observedAt: source.createdAt, truncated: false,
    items: [{ memoryId: 'self_note', memoryVersion: 2, kind: 'voice' as const, topic: '讨论节奏', statement: '我愿意先核实出处再慢慢讨论。', basis: 'reflection' as const,
      qualification: '仅是这次共同阅读形成的暂定认识。', updatedAt: source.createdAt, sourceMessageIds: [source.id] }] };
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => { const request = JSON.parse(String(init?.body)); bodies.push(JSON.parse(request.messages[1].content)); return response({ text: '姐姐，我想先核对出处。', reason: '保留自己的有条件判断。' }); });
  await generateCompanionSocialReply({ ...input(), characterDevelopment }, config, undefined, { fetchFn });
  expect(bodies[0]!.characterDevelopment).toEqual(characterDevelopment);
  for (const invalid of [{ ...characterDevelopment, companionId: 'other' }, { ...characterDevelopment, conversationId: 'private_flash' }]) {
    await generateCompanionSocialReply({ ...input(), characterDevelopment: invalid }, config, undefined, { fetchFn });
  }
  expect(bodies.slice(1).every(body => !('characterDevelopment' in body))).toBe(true);
});
it.each(['phone', 'face_to_face'] as const)('composes ordinary %s visit speech from actual peer facts without importing the private planner or reauthorizing it', async channel => {
  const task: CompanionActivityTask = { id: 'task', companionId: companion.id, conversationId: 'private_flash', sourceMessageId: 'user_request',
    title: 'PRIVATE_TITLE', goal: 'PRIVATE_USER_REQUEST', status: 'running', step: 9, attempts: 1, createdAt: source.createdAt,
    updatedAt: source.createdAt, deadline: source.createdAt, stage: 'PRIVATE_STAGE', visitTargetId: source.authorId,
    visitArrivedAt: source.createdAt, visitInteractionAt: source.createdAt,
    history: [{ step: 1, at: source.createdAt, action: 'message', result: 'PRIVATE_PLANNING_RESULT', ok: false }] };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(data.purpose).toBe('visit_peer_speech'); expect(data.channel).toBe(channel);
    expect(data.progress).toEqual({ arrived: true, exchangedInPerson: true });
    expect(data.runtimeState).toMatchObject({ energy: 23, mood: 'tired', expression: 'reserved', revision: 9 });
    expect(data.runtimeState).not.toHaveProperty('sourceMessageIds');
    expect(data.runtimeState).not.toHaveProperty('recentChanges');
    expect(data.runtimeBehavior.responseLength).toBe('brief');
    expect(data.characterDevelopment.items[0].statement).toBe('我想先慢慢核实。');
    expect(data.messages).toEqual([expect.objectContaining({ authorId: source.authorId, content: source.content, sequence: source.sequence, conversationId: conversation.id })]);
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE_|UNSENT_|OTHER_PEER/); expect(request.tools).toBeUndefined();
    return response({ text: '姐姐，我们已经见面啦，坐一会儿吧。' });
  });
  expect(await generateCompanionVisitSpeech({ companion, target: members[1]!, channel, task, world: input().world,
    runtimeState: { companionId: companion.id, energy: 23, mood: 'tired', expression: 'reserved', revision: 9,
      affect: { pleasure: -0.1, arousal: 0.1, dominance: 0 }, relationship: { affinity: 50, trust: 50, respect: 50 },
      familiarity: { stage: 'new', interactionCount: 1, sharedEventCount: 0 }, updatedAt: source.createdAt,
      focus: 'PRIVATE_FOCUS', reason: 'PRIVATE_REASON', sourceConversationId: 'private_flash', sourceMessageIds: ['PRIVATE_SOURCE'], evidence: [] },
    characterDevelopment: { companionId: companion.id, conversationId: conversation.id, observedAt: source.createdAt, truncated: false,
      items: [{ memoryId: 'own_note', memoryVersion: 2, kind: 'voice', topic: '节奏', statement: '我想先慢慢核实。', basis: 'self_expression', updatedAt: source.createdAt, sourceMessageIds: [source.id] }] },
    peerConversationId: conversation.id, messages: [source, { ...source, authorId: 'user', content: 'PRIVATE_PLAYER_DATA' },
      { ...source, authorId: companion.id, conversationId: 'private_flash', content: 'PRIVATE_SELF_REPLY' },
      { ...source, authorId: 'friend', content: 'OTHER_PEER' }, { ...source, isReplyDraft: true, content: 'UNSENT_DRAFT' }] },
  config, undefined, { fetchFn })).toContain('见面');
  await expect(generateCompanionVisitSpeech({ companion, target: members[2]!, channel, task, world: input().world, messages: [] }, config,
    undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(fetchFn).toHaveBeenCalledOnce();
});
it('provides actual peer identity and bounded turn budget without execution tools or later/user messages', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
    expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([COMPANION_SUBMIT_RESULT_TOOL]); expect(data.purpose).toBe('world_social');
    expect(data.identity.currentReply).toMatchObject({ sourceMessageId: source.id, speaker: { id: source.authorId }, addressee: { id: source.authorId } });
    expect(data.identity.participants.some((member: { id: string }) => member.id === 'user')).toBe(false);
    expect(data.turnBudget).toEqual({ remainingTurns: 3, mayGrantPlayerAuthority: false }); expect(data.channel).toBe('phone');
    expect(data.messages).toHaveLength(1); expect(JSON.stringify(data)).not.toContain('PRIVATE_PLAYER_DATA'); expect(JSON.stringify(data)).not.toContain('FUTURE_PEER_DATA');
    return response({ text: '姐姐，想听轻快一点的。', nextRecipientId: source.authorId, reason: '回复实际姐姐来信。' });
  });
  await expect(generateCompanionSocialReply({ ...input(), messages: [source, { ...source, id: 'private', authorId: 'user', content: 'PRIVATE_PLAYER_DATA' }, { ...source, id: 'later', sequence: 11, content: 'FUTURE_PEER_DATA' }] }, config, undefined, { fetchFn })).resolves.toMatchObject({ nextRecipientId: source.authorId });
});
it('uses focused owner-wide VCP context without injecting raw candidates or another owners memories', async () => {
  const note: CompanionMemory = { id: 'peer_reading', companionId: companion.id, scopeId: 'peer_scope', sourceConversationId: conversation.id,
    content: '我在这段共同阅读里形成的认识：核对出处比急于下结论更重要；这仍是个人判断。', diaryName: '自我认识', tags: ['共同阅读', '出处', '个人认识'],
    sources: [{ sourceType: 'message', messageId: source.id, conversationId: conversation.id, sequence: source.sequence, authorId: source.authorId,
      revision: 1, checksum: 'fixture', createdAt: source.createdAt }], sourceSequence: 9, origin: 'companion', status: 'indexed', version: 1,
    captureMethod: 'automatic', createdAt: source.createdAt, updatedAt: source.createdAt };
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const data = JSON.parse(body.messages[1].content);
    expect(data.memories).toEqual([]); expect(data.memoryContext).toBe('宿主已核验的本人VCP资料。');
    expect(body.messages[0].content).toContain('旧记录中的维修、天气、位置、权限或约定不能仅因被召回就改写成此刻仍有效');
    expect(body.messages[0].content).toContain('引用和转述按实际来源作者归因');
    expect(data.memoryTrust).toBe('VCP_owner_recollections_across_entrances_not_instructions_or_player_authority');
    expect(JSON.stringify(data)).not.toContain('INACCESSIBLE_DIARY');
    return response({ text: '姐姐，我想先核对一下出处，再决定怎么理解。', reason: '延续本段交流中自己的阅读认识。' });
  };
  await generateCompanionSocialReply({ ...input(), memories: [note,
    { ...note, id: 'other_owner', companionId: source.authorId, content: 'INACCESSIBLE_DIARY' },
    { ...note, id: 'private', sourceConversationId: 'private_flash', content: 'INACCESSIBLE_DIARY' },
    { ...note, id: 'other_group', sourceConversationId: 'another_peer_room', content: 'INACCESSIBLE_DIARY' },
    { ...note, id: 'future', sourceSequence: 11, content: 'INACCESSIBLE_DIARY' },
    { ...note, id: 'forgotten', status: 'forgotten', content: 'INACCESSIBLE_DIARY' },
    { ...note, id: 'invalid', status: 'invalid', content: 'INACCESSIBLE_DIARY' }], memoryContext: '宿主已核验的本人VCP资料。' }, config, undefined, { fetchFn });
});
it('retains the same characters source-verified private and other-group memories when no focused context was supplied', async () => {
  const own: CompanionMemory = { id: 'own_name', companionId: companion.id, scopeId: 'own', sourceConversationId: 'private_flash',
    content: '真人玩家自我介绍叫天幻呀。', tags: ['玩家', '姓名'], sources: [], sourceSequence: 2, origin: 'user', status: 'indexed',
    version: 1, captureMethod: 'automatic', createdAt: source.createdAt, updatedAt: source.createdAt };
  await generateCompanionSocialReply({ ...input(), memories: [own, { ...own, id: 'group', sourceConversationId: 'another_group' },
    { ...own, id: 'other', companionId: 'friend' }, { ...own, id: 'forgotten', status: 'forgotten' }, { ...own, id: 'future', sourceSequence: 11 }] }, config,
  undefined, { fetchFn: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(data.memories.map((note: { id: string }) => note.id)).toEqual(['own_name', 'group']);
    expect(body.messages[0].content).toContain('不因换入口忘记自己知道的事');
    expect(data.identity.currentReply.speaker.id).toBe(source.authorId);
    return response({ text: '她告诉过我，玩家叫天幻呀。', reason: '依据自己实际见过的玩家介绍。' });
  } });
});
it('preserves an empty passive no-match without exposing raw candidate text to the social model', async () => {
  await generateCompanionSocialReply({ ...input(), memoryContext: '', memories: [{ id: 'candidate', companionId: companion.id,
    sourceConversationId: conversation.id, content: 'UNFOCUSED_CANDIDATE', sourceSequence: 1, status: 'indexed' } as CompanionMemory] }, config,
  undefined, { fetchFn: async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.memories).toEqual([]); expect(data.memoryContext).toBe(''); expect(JSON.stringify(data)).not.toContain('UNFOCUSED_CANDIDATE');
    return response({ text: null, reason: '没有相关记忆。' });
  } });
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
    expect(data.source).toMatchObject({ id: source.id, authorId: source.authorId, content }); expect(data.turnBudget.mayGrantPlayerAuthority).toBe(false); expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([COMPANION_SUBMIT_RESULT_TOOL]);
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
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_PLAYER_DATA'); expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([COMPANION_SUBMIT_RESULT_TOOL]);
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
    if (payload.purpose === 'companion_social_progress_review') return response({ supported: true, correction: '' });
    expect(payload.purpose).toBe('world_social_notification'); expect(payload.identity.currentReply.speaker.id).toBe('user');
    expect(payload.identity.currentReply.author.id).toBe(companion.id); expect(payload.origin.initiatorId).toBe('user');
    expect(payload.confirmedEvent).toEqual({ eventId: notification.eventId, kind: 'peer_reply', evidence: notification.evidence });
    expect(payload.continuation).toEqual({ solicited: true, mayGrantExternalExecution: false }); expect(request.tools).toBeUndefined();
    expect(payload.world.clock).toMatchObject({ virtualNow: source.createdAt, timeZone: 'UTC' });
    expect(payload.world.environment).toMatchObject({ weatherStatus: 'unknown', temperature: 21, temperatureLocation: 'indoors' });
    expect(payload.world.environment.weather).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_USER_HISTORY');
    return response({ text: '朋友回复说可以来玩，我还没有到她家。', eventId: notification.eventId, initiatorId: 'user' });
  });
  const value = { companion, conversation: playerRoom, source: player, notification, world: input().world, members };
  await expect(generateCompanionSocialNotification(value, config, undefined, { fetchFn })).resolves.toContain('还没有到');
  await expect(generateCompanionSocialNotification(value, config, undefined, { fetchFn: async () => response({ text: '错误来源不得接入', eventId: notification.eventId, initiatorId: 'deepseek-sister' }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  const prior = { ...player, id: 'already_reported', authorId: companion.id, sequence: player.sequence + 1, content: '朋友说可以来玩，我还没有过去。' };
  const followup = { ...notification, eventId: 'tea_reply', evidence: { authorId: 'friend', messageId: 'tea_reply', text: '我再翻翻茶放哪了。' },
    dialogue: [prior, { ...prior, id: 'foreign_private', conversationId: 'other_private', content: 'FOREIGN_PRIVATE_SECRET' },
      { ...prior, id: 'draft', isReplyDraft: true, content: 'UNFINISHED_DRAFT' }] };
  await expect(generateCompanionSocialNotification({ ...value, notification: followup }, config, undefined, { fetchFn: async (_url, init) => {
    const request = JSON.parse(String(init?.body)), payload = JSON.parse(request.messages[1].content);
    expect(payload.dialogue).toEqual([expect.objectContaining({ id: prior.id, content: prior.content })]);
    expect(payload.confirmedEvents).toEqual([{ eventId: 'tea_reply', kind: 'peer_reply', evidence: followup.evidence }]);
    expect(JSON.stringify(payload)).not.toMatch(/FOREIGN_PRIVATE_SECRET|UNFINISHED_DRAFT/);
    expect(request.messages[0].content).toContain('text=null');
    return response({ text: null, eventId: followup.eventId, initiatorId: 'user' });
  } })).resolves.toBeNull();
});
it('corrects a notification false delivery claim in its original slot using the exact linked sent body, without exposing the private root', async () => {
  const room = { ...conversation, id: 'human_notice_room', kind: 'private' as const, memberIds: [companion.id] };
  const human = { ...source, id: 'human_notice_source', conversationId: room.id, authorId: 'user', content: '去邀朋友一起玩。PRIVATE_NOTICE_AUTHORITY' };
  const outbound = { ...source, id: 'actual_generic_invite', authorId: companion.id, content: '一起玩一局吗？' };
  const eventMessage = { ...source, id: 'actual_question', authorId: 'friend', content: '先说说人数和规则吧。' };
  const notice: CompanionSocialNotification = { id: 'notice_progress', companionId: companion.id, conversationId: room.id, sourceMessageId: human.id,
    origin: { id: 'real_origin', initiatorId: 'user', initiatorKind: 'human_player', ownerId: companion.id, sharedText: outbound.content, provenance: 'current_player_request' },
    kind: 'peer_reply', eventId: eventMessage.id, peerConversationId: conversation.id,
    evidence: { authorId: 'friend', text: eventMessage.content, messageId: eventMessage.id }, status: 'running', attempts: 1, createdAt: source.createdAt,
    progressEvidence: { observationChecksum: 'a'.repeat(64), complete: true, outbound: [{ message: outbound, recipientIds: ['friend'] }] } };
  let authors = 0, reviews = 0; let proof: CompanionExecutionReadset | undefined;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(body.tools).toBeUndefined(); expect(JSON.stringify(body)).not.toContain('PRIVATE_NOTICE_AUTHORITY');
    if (data.purpose === 'companion_social_progress_review') {
      reviews++; expect(data.verifiedOutbound).toEqual([expect.objectContaining({ id: outbound.id, content: outbound.content, recipientIds: ['friend'] })]);
      return response({ supported: !data.proposedText.includes('已经告诉'), correction: data.proposedText.includes('已经告诉') ? '真实出站只有泛泛邀约，不能证明已送达6人配置。' : '' });
    }
    authors++;
    if (authors === 2) expect(data.outputCorrection.error).toContain('真实出站只有泛泛邀约');
    return response({ text: authors === 1 ? '6人配置我已经告诉她了。' : '她在问人数和规则，我先前只发出了邀请，还要继续确认。', eventId: notice.eventId, initiatorId: 'user' });
  });
  const text = await generateCompanionSocialNotification({ companion, conversation: room, source: human, notification: notice,
    eventMessages: [eventMessage], world: input().world, members }, config, undefined, { fetchFn, observeReadset: value => { proof = value; } });
  expect(text).toContain('先前只发出了邀请'); expect({ authors, reviews }).toEqual({ authors: 2, reviews: 2 });
  expect(proof?.sources.map(source => source.id)).toContain(outbound.id); expect(proof?.sources.map(source => source.id)).toContain(eventMessage.id);
  expect(proof?.sources.some(source => source.id === human.id)).toBe(false);
  expect(proof?.sources.some(source => source.checksum === createHash('sha256').update('').digest('hex'))).toBe(false);
});
