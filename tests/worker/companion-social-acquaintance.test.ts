import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import type { CompanionWorldArguments } from '../../src/shared/companion-world-tool';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import type { ActivityDecision } from '../../src/shared/companion-activity-task';
import { createdSocialPort, socialProgressReads } from '../../src/main/companions/social-progress-evidence';

let store: CompanionsStore, root: string;
const residents = ['alice', 'bob', 'carol', 'outsider', 'deepseek-flash', 'deepseek-sister'];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-23T12:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'social-acquaintance-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), residents.map(id => ({ id, name: id,
    description: id + '的公开介绍', persona: 'PRIVATE_PERSONA_' + id, model: '', avatar: 'sister' as const, active: true, proactive: true })));
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const id of residents) {
    const routine = store.request({ type: 'routine.get', ...scope(id) }).routine!;
    store.request({ type: 'routine.configure', ...scope(id), expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
});
afterEach(() => { store.close(); if (path.dirname(root) !== tmpdir().replace(/[\\/]$/, '') || !path.basename(root).startsWith('social-acquaintance-')) throw new Error('Unexpected test path'); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function scope(id = 'alice') { return { companionId: id, conversationId: store.openPrivate(id).id }; }
function query(category: 'contacts' | 'people', id = 'alice', name = '') {
  return store.request({ type: 'memory.world_query', ...scope(id), category, query: name, limit: 20 }).worldKnowledge!;
}
function act(arguments_: CompanionWorldArguments, clientId: string, id = 'alice') {
  return store.request({ type: 'world.tool', ...scope(id), clientId, arguments: arguments_ });
}
function advance(ms = 1300) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function know(target: string, owner = 'alice') {
  const room = store.request({ type: 'social.conversation.ensure', companionId: owner, memberIds: [owner, target] }).socialConversation!;
  store.request({ type: 'social.message.append', conversationId: room.id, authorId: owner,
    content: `你好${target}，我是${owner}`, virtualCreatedAt: new Date().toISOString(), clientId: `know_${owner}_${target}` });
  return room;
}
function reopen() {
  store.close();
  store = new CompanionsStore(path.join(root, 'state.sqlite'), residents.map(id => ({ id, name: id,
    description: id + '的公开介绍', persona: 'PRIVATE_PERSONA_' + id, model: '', avatar: 'sister' as const, active: true, proactive: true })));
  store.request({ type: 'activity.recover' });
}
function completeJob(job: CompanionSocialJob, text: string | null) {
  advance();
  return store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text });
}
function finishQueuedReplies(replies: Record<string, string>) {
  const seen = new Set<string>();
  for (let n = 0; n < 12; n++) {
    advance(); const job = store.request({ type: 'social.job.claim' }).socialJob;
    if (!job) break;
    const text = !seen.has(job.companionId) ? replies[job.companionId] ?? null : null;
    seen.add(job.companionId); completeJob(job, text);
  }
}

it('separates public world discovery from acquaintance, does not create graph edges or reveal personal context', () => {
  store.appendMessage({ conversationId: scope('bob').conversationId, authorId: 'user', content: 'BOB_PLAYER_SECRET' });
  expect(query('contacts').items).toEqual([]);
  const people = query('people');
  expect(people.items.map(person => person.id)).toContain('bob');
  expect(people.items.every(person => person.known === false)).toBe(true);
  expect(JSON.stringify(people)).not.toMatch(/PRIVATE_PERSONA|BOB_PLAYER_SECRET/);
  expect(query('contacts').items).toEqual([]);
  expect(store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!.links.filter(edge => edge.kind === 'peer')).toEqual([]);
  expect(() => act({ action: 'message', recipientIds: ['bob'], text: '任意陌生人消息' }, 'unknown_message')).toThrow('还不是你认识');
  expect(() => act({ action: 'introduce', targetCompanionId: 'alice', text: '自己认识自己' }, 'self')).toThrow('本人之外');
});

it('requires a real public observation, sends one introduction with stable id and adds reciprocal edges only after delivery', () => {
  const action = { action: 'introduce', targetCompanionId: 'bob', text: '你好，我是alice。想认识你，有空一起玩狼人杀吗？' } as const;
  expect(() => act(action, 'hello')).toThrow('尚未了解');
  query('people', 'alice', 'bob');
  const first = act(action, 'hello'); expect(first.socialPending).toBe(true);
  expect(query('contacts').items).toEqual([]);
  expect(act(action, 'hello').socialConversation!.id).toBe(first.socialConversation!.id);
  advance(); const delivered = act(action, 'hello');
  expect(delivered.socialMessage!.message).toMatchObject({ authorId: 'alice', content: action.text });
  expect(act(action, 'hello').socialMessage!.message.id).toBe(delivered.socialMessage!.message.id);
  expect(query('contacts').items).toEqual([expect.objectContaining({ id: 'bob', known: true })]);
  expect(query('contacts', 'bob').items).toEqual([expect.objectContaining({ id: 'alice', known: true })]);
  expect(store.request({ type: 'social.messages', conversationId: delivered.socialConversation!.id }).socialMessagePage!.total).toBe(1);
  expect(store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!.links).toContainEqual(expect.objectContaining({ targetId: 'bob', phoneCount: 1 }));
  expect(store.request({ type: 'world.observe', ...scope() }).world!.relationships).toEqual([expect.objectContaining({ companionId: 'alice', targetCompanionId: 'bob', interactions: 1 })]);
  expect(query('contacts', 'outsider').items).toEqual([]);
});

it('shares authored sibling identity and initializes only actual character relations without treating everybody as friends', () => {
  expect(query('contacts', 'deepseek-sister').items).toEqual([expect.objectContaining({ id: 'deepseek-flash' })]);
  expect(query('contacts', 'deepseek-flash').items).toEqual([expect.objectContaining({ id: 'deepseek-sister' })]);
  expect(store.request({ type: 'social.graph', companionId: 'deepseek-sister' }).socialGraph!.links).toContainEqual(expect.objectContaining({ targetId: 'deepseek-flash', phoneCount: 0, faceCount: 0 }));
  expect(query('contacts', 'outsider').items).toEqual([]);
});

it.each([false, true])('creates a real autonomous group includePlayer=%s with fixed author, stable retry and no copied private messages', includePlayer => {
  know('bob'); know('carol');
  store.appendMessage({ conversationId: scope().conversationId, authorId: 'user', content: 'PRIVATE_PLAYER_SECRET_DO_NOT_FORWARD' });
  const action = { action: 'create_group', recipientIds: ['bob', 'carol'], title: '今晚狼人杀', text: '我想组个狼人杀小局，你们愿意一起吗？', includePlayer } satisfies CompanionWorldArguments;
  const first = act(action, 'game_group');
  expect(() => companionStorageResponseSchema.parse(first)).not.toThrow();
  expect(first.socialConversation!.kind).toBe('group');
  expect(first.socialConversation!.memberIds).toEqual(['alice', 'bob', 'carol']);
  expect(act(action, 'game_group').socialConversation!.id).toBe(first.socialConversation!.id);
  const hidden = store.state(true).conversations.find(room => room.id === first.socialConversation!.id)!;
  expect(hidden.peerOnly).toBe(!includePlayer);
  expect(store.state().conversations.some(room => room.id === hidden.id)).toBe(includePlayer);
  advance(); const delivered = act(action, 'game_group');
  expect(delivered.socialMessage!.message.authorId).toBe('alice');
  expect(store.state().conversations.some(room => room.id === hidden.id)).toBe(includePlayer);
  const messages = store.request({ type: 'social.messages', conversationId: hidden.id }).socialMessagePage!;
  expect(messages.total).toBe(1); expect(JSON.stringify(messages)).not.toContain('PRIVATE_PLAYER_SECRET');
  expect(messages.items[0]!.recipientIds).toEqual(['bob', 'carol']);
  if (includePlayer) expect(store.appendMessage({ conversationId: hidden.id, authorId: 'user', content: '我是真人玩家，我也来参加。' }).authorId).toBe('user');
  else expect(() => store.appendMessage({ conversationId: hidden.id, authorId: 'user', content: '不能冒充群成员。' })).toThrow('只能记录实际伙伴');
  expect(store.request({ type: 'social.contact.check', companionId: 'bob', recipientIds: ['carol'] }).ok).toBe(true);
  const job = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(['bob', 'carol']).toContain(job.companionId); expect(job.memberIds).toEqual(['alice', 'bob', 'carol']);
});

it('routes subsequent phone messages to the explicit player group and its topic without creating a parallel room', () => {
  know('bob'); know('carol');
  const created = act({ action: 'create_group', recipientIds: ['bob', 'carol'], title: '共同讨论', text: '在本话题讨论。', includePlayer: true,
    topic: { title: '独立活动', kind: 'discussion' } }, 'explicit_group');
  const roomId = created.socialConversation!.id, topicId = created.topic!.id;
  const creationTurn = { text: '', rawText: '', calls: [{ id: 'created', name: 'world', arguments: JSON.stringify({ action: 'create_group', recipientIds: ['bob', 'carol'], title: '共同讨论', text: '在本话题讨论。' }) }],
    results: [{ callId: 'created', content: JSON.stringify(created) }] };
  expect(createdSocialPort([creationTurn], 'alice', ['carol', 'bob'])).toEqual({ roomId, topicId });
  expect(createdSocialPort([creationTurn], 'alice', ['bob'])).toBeUndefined();
  advance();
  const resolved = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['carol', 'alice', 'bob'], roomId }).socialConversation!;
  expect(resolved.id).toBe(roomId);
  const send = { type: 'social.send', companionId: 'alice', conversationId: resolved.id, topicId, content: '沿用本群和话题的规则。', channel: 'phone', clientId: 'explicit_followup' } as const;
  store.request(send); advance(); const delivery = store.request(send);
  expect(delivery.socialMessage!.message).toMatchObject({ conversationId: roomId, topicId, content: send.content });
  expect(store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items.filter(room => room.kind === 'group')).toHaveLength(1);
  expect(() => store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'], roomId })).toThrow('实际伙伴成员');
  expect(() => store.request({ type: 'social.conversation.ensure', companionId: 'outsider', memberIds: ['outsider', 'bob', 'carol'], roomId })).toThrow('有效社交会话');
});

it('rejects stranger groups, dormant invitations and forged speaker identifiers without creating a room', () => {
  know('bob');
  const action = { action: 'create_group', recipientIds: ['bob', 'carol'], title: '陌生群', text: '来玩吗？' } satisfies CompanionWorldArguments;
  expect(() => act(action, 'stranger_group')).toThrow('还不是你认识');
  expect(store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items.every(room => room.kind === 'private')).toBe(true);
  query('people', 'alice', 'carol'); store.setCompanionActive('carol', false);
  expect(() => act({ action: 'introduce', targetCompanionId: 'carol', text: '你好！' }, 'dormant')).toThrow('休眠');
  expect(() => act({ ...action, recipientIds: ['alice', 'bob'] }, 'forged')).toThrow('本人之外');
  expect(() => store.request(JSON.parse(JSON.stringify({ type: 'world.tool', ...scope(), arguments: { ...action, authorId: 'carol' } })))).toThrow();
});

it('empty ensured rooms are not acquaintance evidence and contact validation is owner-scoped', () => {
  store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] });
  expect(query('contacts').items).toEqual([]);
  know('bob');
  expect(store.request({ type: 'social.contact.check', companionId: 'alice', recipientIds: ['bob'] }).ok).toBe(true);
  expect(() => store.request({ type: 'social.contact.check', companionId: 'outsider', recipientIds: ['bob'] })).toThrow('还不是你认识');
});
it('learns acquaintance from formal speech in a player-created group, while empty membership and drafts do not count', () => {
  const room = store.createConversation('玩家组的聚会', ['alice', 'bob', 'carol']);
  expect(query('contacts').items).toEqual([]);
  const draft = store.appendMessage({ conversationId: room.id, authorId: 'bob', content: '只是还没发布的草稿', loopStep: 0, clientId: 'group_draft' });
  expect(draft.isReplyDraft).toBe(true); expect(query('contacts').items).toEqual([]);
  store.appendMessage({ conversationId: room.id, authorId: 'bob', content: '大家好，我是bob，很高兴认识你们。', clientId: 'real_group_introduction' });
  expect(query('contacts').items.map(person => person.id)).toEqual(['bob', 'carol']);
  expect(store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!.links).toContainEqual(expect.objectContaining({ targetId: 'bob', conversationIds: [room.id] }));
  expect(store.appendMessage({ conversationId: room.id, authorId: 'user', content: '我来介绍你们认识。' }).authorId).toBe('user');
  expect(store.state().conversations.some(value => value.id === room.id)).toBe(true);
  expect(store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.items.some(value => value.message.id === draft.id)).toBe(false);
});
it('creates a separately scoped game topic in the new group, invites each reader and never joins on their behalf', () => {
  know('bob'); know('carol');
  const action = { action: 'create_group', recipientIds: ['bob', 'carol'], title: '狼人杀组局', text: '这是新的狼人杀话题，愿意参加吗？', includePlayer: true,
    topic: { title: '狼人杀第一局', kind: 'game', tags: ['狼人杀', '游戏'] } } satisfies CompanionWorldArguments;
  const first = act(action, 'topic_group'), topic = first.topic!;
  expect(topic.conversationId).toBe(first.socialConversation!.id);
  expect(topic.conversationId).not.toBe(scope().conversationId);
  expect(topic.participantIds).toEqual(['alice']); expect(topic.invitedIds).toEqual(['bob', 'carol', 'user']);
  expect(act(action, 'topic_group').topic!.id).toBe(topic.id);
  expect(store.request({ type: 'topic.list', conversationId: topic.conversationId, readerId: 'alice' }).topics?.filter(topic => !topic.isPrimary)).toHaveLength(1);
  advance(); const delivered = act(action, 'topic_group');
  expect(delivered.socialMessage!.message.topicId).toBe(topic.id);
  const peer = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(['bob', 'carol']).toContain(peer.companionId);
  expect(store.request({ type: 'topic.read', conversationId: topic.conversationId, readerId: peer.companionId, topicId: topic.id }).topic!.participantIds).toEqual(['alice']);
  const joined = store.request({ type: 'topic.join', conversationId: topic.conversationId, readerId: peer.companionId, topicId: topic.id });
  expect(joined.topic!.participantIds).toContain(peer.companionId);
  expect(store.request({ type: 'topic.list', conversationId: scope().conversationId, readerId: 'alice' }).topics?.filter(topic => !topic.isPrimary)).toHaveLength(0);
});
it('delivers an introduction from the current peer brain while its own reply job is running, preserving typing and the original lease', () => {
  const pair = know('bob');
  const user = store.appendMessage({ conversationId: scope().conversationId, authorId: 'user', content: '找bob一起去认识carol玩吧。' });
  const start = { type: 'social.send', companionId: 'alice', conversationId: pair.id, channel: 'phone', content: 'bob，我们认识carol一起玩怎么样？', clientId: 'peer_job_start', authorizationMessageId: user.id } as const;
  store.request(start); advance(); store.request(start);
  const job = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(job.companionId).toBe('bob');
  const currentScope = { companionId: 'bob', conversationId: pair.id, beforeSequence: job.throughSequence };
  store.request({ type: 'world.tool', ...currentScope, arguments: { action: 'query', category: 'people', query: 'carol' } });
  const introduce = { type: 'world.tool', ...currentScope, sourceMessageId: job.sourceMessageId, clientId: 'current_peer_intro',
    arguments: { action: 'introduce', targetCompanionId: 'carol', text: '你好，我是bob，想认识你一起玩游戏。' } } as const;
  expect(store.request(introduce).socialPending).toBe(true);
  advance(); const delivered = store.request(introduce);
  expect(delivered.socialMessage!.message.authorId).toBe('bob');
  expect(delivered.socialMessage!.recipientIds).toEqual(['carol']);
  expect(query('contacts', 'bob').items.map(person => person.id)).toContain('carol');
  expect(store.request({ type: 'social.job.progress', id: job.id, leaseToken: job.leaseToken!, phase: 'thinking', detail: '仍是同一来信的独立主脑' }).ok).toBe(true);
});
it.each([false, true])('runs the actual social brain through native voluntary game-topic join then a formal reply, player present=%s', async includePlayer => {
  know('bob'); know('carol');
  const group = act({ action: 'create_group', recipientIds: ['bob', 'carol'], title: '自主入局', text: '想玩这局狼人杀吗？', includePlayer,
    topic: { title: '狼人杀', kind: 'game' } }, 'native_topic_group');
  advance(); act({ action: 'create_group', recipientIds: ['bob', 'carol'], title: '自主入局', text: '想玩这局狼人杀吗？', includePlayer,
    topic: { title: '狼人杀', kind: 'game' } }, 'native_topic_group');
  const job = store.request({ type: 'social.job.claim' }).socialJob!;
  const errors: unknown[] = [], frames: Array<Record<string, unknown>> = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), frame = JSON.parse(body.messages[1].content);
    if (frame.purpose === 'game_public_reply_privacy') {
      expect(frame.exactProposedText).toBe(`我是${job.companionId}，我愿意参加这局游戏。`);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: true, confidence: .99, reason: '本人真实愿意参加，无私密信息。' }) } }] }), { headers: { 'Content-Type': 'application/json' } });
    }
    frames.push(frame);
    expect(frame.identity.self.id).toBe(job.companionId);
    expect(frame.identity.audience).toBe(includePlayer ? 'player' : 'peers');
    if (!frame.topic.participantIds.includes(job.companionId)) {
      expect(frame.topicInvitation.acceptWithNativeTool.arguments).toEqual({ action: 'topic', parameters: { action: 'join', topicId: group.topic!.id } });
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'voluntary_join', type: 'function',
        function: { name: 'world', arguments: JSON.stringify(frame.topicInvitation.acceptWithNativeTool.arguments) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
    }
    expect(body.messages.some((message: { role: string }) => message.role === 'tool')).toBe(true);
    advance();
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: `我是${job.companionId}，我愿意参加这局游戏。`, reason: '自主接受真实邀请。' }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const service = new CompanionWorldService({ request: async command => store.request(command), configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture', baseUrl: 'https://fixture.invalid' }),
    fetchFn, changed: () => undefined, wakeWaiting: () => undefined, report: error => errors.push(error),
    recall: async () => ({ memories: [], reasons: [], sources: [], pending: false, degraded: false }) });
  try {
    await (service as unknown as { processSocial(job: CompanionSocialJob, signal: AbortSignal): Promise<void> }).processSocial(job, new AbortController().signal);
    expect(errors).toEqual([]); expect(fetchFn).toHaveBeenCalledTimes(3);
    const topic = store.request({ type: 'topic.read', conversationId: group.topic!.conversationId, readerId: job.companionId, topicId: group.topic!.id }).topic!;
    expect(topic.participantIds).toContain(job.companionId);
    const messages = store.request({ type: 'social.messages', conversationId: topic.conversationId }).socialMessagePage!.items;
    expect(messages).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ authorId: job.companionId, topicId: topic.id, content: `我是${job.companionId}，我愿意参加这局游戏。` }) }));
  } finally { await service.close(); }
});
it.each(['introduce', 'create_group'] as const)('commits an activity planner %s as a real social operation with its receipt and independent peer port', action => {
  if (action === 'create_group') { know('bob'); know('carol'); }
  else query('people', 'alice', 'bob');
  const origin = scope(), source = store.appendMessage({ conversationId: origin.conversationId, authorId: 'user', content: '邀请伙伴一起玩狼人杀。' });
  store.request({ type: 'activity.start', ...origin, sourceMessageId: source.id, clientId: 'social_activity', title: '主动组局', goal: source.content });
  const task = store.request({ type: 'activity.claim' }).activityTask!;
  const operation = action === 'introduce' ? { action, targetCompanionId: 'bob', text: '我是alice，想认识你一起玩。' } satisfies CompanionWorldArguments
    : { action, recipientIds: ['bob', 'carol'], title: '任务里的狼人杀群', text: '愿意一起玩这局吗？', includePlayer: true,
      topic: { title: '狼人杀', kind: 'game' } } satisfies CompanionWorldArguments;
  const result = store.request({ type: 'activity.commit', id: task.id, leaseToken: task.leaseToken!, decision: {
    status: 'continue', action: operation, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '等待伙伴真实回复。' } }).activityTask!;
  expect(result.history[0]!.ok).toBe(true);
  const receipt = JSON.parse(result.history[0]!.result);
  expect(receipt.socialConversation.memberIds).toContain('alice');
  expect(receipt.socialPending).toBe(true); expect(receipt.socialMessage).toBeUndefined();
  if (action === 'create_group') expect(receipt.topic).toMatchObject({ kind: 'game', conversationId: receipt.socialConversation.id, participantIds: ['alice'] });
  advance(); store.request({ type: 'social.job.claim' });
  const peerMessages = store.request({ type: 'social.messages', conversationId: receipt.socialConversation.id }).socialMessagePage!.items;
  expect(peerMessages).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ authorId: 'alice', content: operation.text }) }));
  expect(receipt.socialConversation.id).not.toBe(origin.conversationId);
});
function continuingIntroduction() {
  query('people', 'alice', 'bob');
  const origin = scope(), source = store.appendMessage({ conversationId: origin.conversationId, authorId: 'user', content: '邀请bob和其他伙伴一起玩，等回复后继续组织游戏；不要转发我的私人记录。' });
  const send = { type: 'world.tool', ...origin, sourceMessageId: source.id, clientId: 'continuing_first_intro',
    arguments: { action: 'introduce', targetCompanionId: 'bob', text: '你好，我是alice，想邀请你一起玩。' } } as const;
  const initial = store.request(send);
  const ensure = { type: 'activity.social.ensure', ...origin, sourceMessageId: source.id,
    deliveryClientId: send.clientId, operation: 'introduce' } as const;
  return { origin, source, send, initial, ensure, task: store.request(ensure).activityTask! };
}
it('persists one original social goal from a pending real introduction, defers while Main owns the actor and wakes from an actual peer reply', () => {
  const f = continuingIntroduction();
  expect(f.initial.socialPending).toBe(true);
  expect(f.task).toMatchObject({ status: 'waiting', goal: f.source.content, sourceMessageId: f.source.id, peerConversationId: f.initial.socialConversation!.id, peerTopicId: expect.stringMatching(/^main_/u) });
  expect(f.task.history).toHaveLength(1);
  expect(JSON.parse(f.task.history[0]!.result)).toMatchObject({ socialPending: true, socialConversation: { id: f.initial.socialConversation!.id } });
  expect(store.request(f.ensure).activityTask).toEqual(f.task);
  advance(); const delivered = store.request(f.send); expect(delivered.socialMessage).toBeDefined();
  expect(store.request({ type: 'activity.claim', excludedIds: ['alice'] }).activityTask).toBeUndefined();
  expect(store.request({ type: 'activity.claim' }).activityTask).toBeUndefined();
  const job = store.request({ type: 'social.job.claim' }).socialJob!;
  advance(); store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: 'alice你好，我愿意一起玩。' });
  advance(); const resumed = store.request({ type: 'activity.claim' }).activityTask!;
  expect(resumed.id).toBe(f.task.id); expect(resumed.goal).toBe(f.source.content);
  const observed = store.request({ type: 'activity.observe', id: resumed.id, leaseToken: resumed.leaseToken! });
  expect(observed.activityMessages!.some(message => message.authorId === 'bob')).toBe(true);
  expect(store.request({ type: 'social.messages', conversationId: f.initial.socialConversation!.id }).socialMessagePage!.items.filter(item => item.message.authorId === 'alice')).toHaveLength(1);
});
it('lets the original goal read its exact incoming reply chain without importing unrelated peer dialogue and hides it after withdrawal', () => {
  const f = continuingIntroduction(); advance(); store.request(f.send);
  const job = store.request({ type: 'social.job.claim' }).socialJob!;
  const reply = completeJob(job, '我愿意报名参加。').socialMessage!.message;
  store.request({ type: 'social.message.append', conversationId: reply.conversationId, authorId: 'bob', content: 'UNRELATED_PEER_PRIVATE_CONTEXT',
    virtualCreatedAt: new Date().toISOString(), clientId: 'unrelated_to_goal' });
  const command = { type: 'activity.progress', ...f.origin, id: f.task.id } as const;
  const progress = store.request(command);
  const readTurn = { text: '', rawText: '', calls: [{ id: 'read', name: 'world', arguments: JSON.stringify({ action: 'activity', parameters: { action: 'progress', id: f.task.id } }) }], results: [{ callId: 'read', content: JSON.stringify(progress) }] };
  expect([...socialProgressReads([readTurn]).keys()]).toContain(reply.id);
  expect(socialProgressReads([{ ...readTurn, calls: [{ ...readTurn.calls[0]!, name: 'dsh' }] }]).size).toBe(0);
  expect(progress.activityMessages!.map(message => message.id)).toContain(reply.id);
  expect(JSON.stringify(progress.activityMessages)).not.toContain('UNRELATED_PEER_PRIVATE_CONTEXT');
  expect(progress.activityMessageOrigins).toContainEqual(expect.objectContaining({ messageId: reply.id, sourceMessageId: f.initial.socialMessage?.message.id ?? store.request(f.send).socialMessage!.message.id }));
  expect(() => store.request({ ...command, companionId: 'bob' })).toThrow('范围不可访问');
  store.request({ type: 'memory.forget', ...f.origin, sourceMessageIds: [f.source.id] });
  expect(store.request(command).activityMessages).toEqual([]);
  expect(store.request(command).activityTask!.historyAvailable).toBe(false);
});
it('reuses the same goal after group creation, freezes that game topic port, survives restart and never resurrects a cancelled source', () => {
  const f = continuingIntroduction(); advance(); store.request(f.send); know('carol');
  const group = { type: 'world.tool', ...f.origin, sourceMessageId: f.source.id, clientId: 'continuing_group', arguments: {
    action: 'create_group', recipientIds: ['bob', 'carol'], title: '后续组局', text: '我们在这个话题继续组织吧。',
    topic: { title: '新的一局', kind: 'game' } } } satisfies Parameters<CompanionsStore['request']>[0];
  const created = store.request(group);
  const ensure = { ...f.ensure, deliveryClientId: 'continuing_group', operation: 'create_group' } as const;
  const task = store.request(ensure).activityTask!;
  expect(task.id).toBe(f.task.id); expect(task.history).toHaveLength(2);
  expect(task.peerConversationId).toBe(created.socialConversation!.id); expect(task.peerTopicId).toBe(created.topic!.id);
  expect(task.goal).toBe(f.source.content);
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), residents.map(id => ({ id, name: id, description: id + '的公开介绍',
    persona: 'PRIVATE_PERSONA_' + id, model: '', avatar: 'sister' as const, active: true, proactive: true })));
  const restored = store.request(ensure).activityTask!;
  expect(restored.id).toBe(task.id); expect(restored.history).toHaveLength(2);
  store.request({ type: 'activity.cancel', ...f.origin, id: task.id });
  expect(store.request(ensure).activityTask).toMatchObject({ id: task.id, status: 'cancelled' });
  expect(store.request({ type: 'activity.list', ...f.origin }).activityTasks).toHaveLength(1);
});
it('rejects invented, foreign or mismatched initial receipts before creating a continuation', () => {
  const origin = scope(), source = store.appendMessage({ conversationId: origin.conversationId, authorId: 'user', content: '一起组织活动。' });
  expect(() => store.request({ type: 'activity.social.ensure', ...origin, sourceMessageId: source.id, deliveryClientId: 'not_a_real_receipt', operation: 'message' })).toThrow('真实出站消息');
  expect(store.request({ type: 'activity.list', ...origin }).activityTasks).toEqual([]);
  const f = continuingIntroduction();
  expect(() => store.request({ ...f.ensure, operation: 'create_group' })).toThrow('实际社交会话');
  expect(() => store.request({ ...f.ensure, ...scope('carol') })).toThrow();
  expect(store.request(f.ensure).activityTask!.history).toHaveLength(1);
});
it.each([false, true])('moves a continuation from private chat into its real game group, keeps subsequent group messages there, then clears the topic when switching back: player=%s', includePlayer => {
  const f = continuingIntroduction(); advance(); store.request(f.send); know('carol');
  store.request({ type: 'social.message.append', conversationId: f.initial.socialConversation!.id, authorId: 'bob', content: 'UNRELATED_PRIVATE_HISTORY', virtualCreatedAt: new Date().toISOString(), clientId: 'unrelated_private_reply' });
  finishQueuedReplies({ bob: '我愿意参加，继续组局吧。' });
  advance(); const initial = store.request({ type: 'activity.claim' }).activityTask!;
  expect(initial.peerTopicId).toMatch(/^main_/u);
  const grouped = store.request({ type: 'activity.commit', id: initial.id, leaseToken: initial.leaseToken!, decision: { status: 'continue',
    action: { action: 'create_group', recipientIds: ['bob', 'carol'], title: '持续游戏群', text: '在新游戏话题里继续吧。', includePlayer,
      topic: { title: '共同游戏', kind: 'game' } }, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '建立群，等待真实报名。' } }).activityTask!;
  const receipt = JSON.parse(grouped.history.at(-1)!.result), roomId = receipt.socialConversation.id, topicId = receipt.topic.id;
  expect(grouped.peerConversationId).toBe(roomId); expect(grouped.peerTopicId).toBe(topicId);
  advance(); store.request({ type: 'social.job.claim' });
  const invitation = store.request({ type: 'social.messages', conversationId: roomId }).socialMessagePage!.items.find(item => item.message.authorId === 'alice')!.message;
  for (const readerId of ['bob', 'carol']) store.request({ type: 'topic.join', conversationId: roomId, readerId, topicId });
  store.request({ type: 'social.message.append', conversationId: roomId, authorId: 'bob', content: '我在新话题里报名。', replyToId: invitation.id, virtualCreatedAt: new Date().toISOString(), clientId: 'new_topic_reply' });
  advance(); const resumed = store.request({ type: 'activity.claim' }).activityTask!;
  expect(resumed.id).toBe(f.task.id);
  const observation = store.request({ type: 'activity.observe', id: resumed.id, leaseToken: resumed.leaseToken! });
  expect(observation.activityMessages!.some(message => message.content === '我在新话题里报名。')).toBe(true);
  expect(observation.activityMessages!.some(message => message.content === '我愿意参加，继续组局吧。')).toBe(true);
  expect(observation.activityMessages!.some(message => message.content === 'UNRELATED_PRIVATE_HISTORY')).toBe(false);
  expect(observation.activityMessageOrigins).toContainEqual(expect.objectContaining({ conversationId: f.initial.socialConversation!.id, deliveryClientId: f.send.clientId }));
  const continued = store.request({ type: 'activity.commit', id: resumed.id, leaseToken: resumed.leaseToken!, decision: { status: 'continue',
    action: { action: 'message', recipientIds: ['bob', 'carol'], text: '继续在这个话题确认人数。' }, wait: { kind: 'reply', targetCompanionId: 'carol' }, summary: '在已有群话题继续确认。' } }).activityTask!;
  expect(continued.peerConversationId).toBe(roomId); expect(continued.peerTopicId).toBe(topicId);
  expect(store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items.filter(room => room.kind === 'group')).toHaveLength(1);
  advance(); store.request({ type: 'social.job.claim' });
  expect(store.request({ type: 'social.messages', conversationId: roomId }).socialMessagePage!.items).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ content: '继续在这个话题确认人数。', topicId }) }));
  store.request({ type: 'social.message.append', conversationId: roomId, authorId: 'carol', content: '我也在当前话题报名。', replyToId: invitation.id, virtualCreatedAt: new Date().toISOString(), clientId: 'second_topic_reply' });
  advance(); const next = store.request({ type: 'activity.claim' }).activityTask!;
  const privateAgain = store.request({ type: 'activity.commit', id: next.id, leaseToken: next.leaseToken!, decision: { status: 'continue',
    action: { action: 'message', recipientIds: ['carol'], text: 'carol，另一个独立的小问题。' }, wait: { kind: 'reply', targetCompanionId: 'carol' }, summary: '切换到单独联系端口。' } }).activityTask!;
  expect(privateAgain.peerConversationId).not.toBe(roomId); expect(privateAgain.peerTopicId).toMatch(/^main_/u);
});

function deferGroupWhileReplying() {
  const bobRoom = know('bob'); know('carol');
  const origin = scope(), source = store.appendMessage({ conversationId: origin.conversationId, authorId: 'user',
    content: '请把bob和carol组织到独立游戏群，等她们真实回复。', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...origin, sourceMessageId: source.id,
    clientId: 'deferred_group_goal', title: '组织独立游戏群', goal: source.content }).activityTask!;
  const leased = store.request({ type: 'activity.claim' }).activityTask!;
  expect(leased.id).toBe(task.id);
  // A different, genuine peer conversation starts typing after planning leased
  // the actor. It may delay this goal but cannot enter this goal's context.
  store.request({ type: 'social.send', companionId: 'bob', conversationId: bobRoom.id, channel: 'phone',
    clientId: 'parallel_peer_greeting', content: '先跟你打个招呼。' });
  advance(); const replyJob = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(replyJob.companionId).toBe('alice');
  const decision = { status: 'continue', action: { action: 'create_group', recipientIds: ['bob', 'carol'], title: '延期后只创建一次',
    text: '我们在独立游戏话题继续吧。', includePlayer: true, topic: { title: '独立游戏', kind: 'game' } },
    wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '建立真实群聊后等报名。' } satisfies ActivityDecision;
  const deferred = store.request({ type: 'activity.commit', id: task.id, leaseToken: leased.leaseToken!, decision }).activityTask!;
  expect(deferred).toMatchObject({ status: 'queued', step: 0, history: [] });
  expect(deferred.stage).toContain('尚未执行');
  expect(store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items.filter(room => room.kind === 'group')).toEqual([]);
  return { task, origin, source, replyJob, leased, decision };
}
it('retains an authorized busy step across SQLite restart and executes it once without replanning after the real reply lock releases', () => {
  const f = deferGroupWhileReplying();
  reopen(); advance(5100);
  expect(store.request({ type: 'activity.claim' }).activityTask).toBeUndefined();
  expect(store.request({ type: 'activity.get', ...f.origin, id: f.task.id }).activityTask).toMatchObject({ status: 'queued', step: 0 });
  completeJob(f.replyJob, null); advance(5100);
  const unrelated = know('outsider');
  store.request({ type: 'social.message.append', conversationId: unrelated.id, authorId: 'outsider',
    content: 'UNRELATED_NEW_REPLY_DOES_NOT_REPLAN_GOAL', virtualCreatedAt: new Date().toISOString(), clientId: 'unrelated_during_defer' });
  // claim itself replays the validated saved step; it must not lease a fresh
  // model plan, and repeated scheduler polls must not repeat the side effect.
  expect(store.request({ type: 'activity.claim' }).activityTask).toBeUndefined();
  const executed = store.request({ type: 'activity.get', ...f.origin, id: f.task.id }).activityTask!;
  expect(executed).toMatchObject({ status: 'waiting', step: 1 });
  expect(executed.history).toHaveLength(1); expect(executed.history[0]).toMatchObject({ action: 'create_group', ok: true });
  const receipt = JSON.parse(executed.history[0]!.result);
  expect(receipt.topic).toMatchObject({ kind: 'game', title: '独立游戏' });
  expect(store.state().conversations.some(room => room.id === receipt.socialConversation.id)).toBe(true);
  advance(); store.request({ type: 'social.job.claim' });
  for (let n = 0; n < 5; n++) { advance(5100); expect(store.request({ type: 'activity.claim' }).activityTask).toBeUndefined(); }
  const messages = store.request({ type: 'social.messages', conversationId: receipt.socialConversation.id }).socialMessagePage!.items;
  expect(messages.filter(item => item.message.authorId === 'alice' && item.message.content === f.decision.action.text)).toHaveLength(1);
  expect(store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items.filter(room => room.kind === 'group')).toHaveLength(1);
  expect(() => store.request({ type: 'activity.commit', id: f.task.id, leaseToken: f.leased.leaseToken!, decision: f.decision })).toThrow('租约');
});
it.each(['cancel', 'withdraw'] as const)('never executes a saved delayed step after %s, including after restart and repeated polling', reason => {
  const f = deferGroupWhileReplying();
  if (reason === 'cancel') store.request({ type: 'activity.cancel', ...f.origin, id: f.task.id });
  else store.request({ type: 'memory.forget', ...f.origin, sourceMessageIds: [f.source.id] });
  reopen(); completeJob(f.replyJob, null);
  for (let n = 0; n < 3; n++) { advance(5100); expect(store.request({ type: 'activity.claim' }).activityTask).toBeUndefined(); }
  expect(store.request({ type: 'activity.get', ...f.origin, id: f.task.id }).activityTask).toMatchObject({ status: 'cancelled', step: 0, history: [] });
  expect(store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items.filter(room => room.kind === 'group')).toEqual([]);
  expect(() => store.request({ type: 'activity.commit', id: f.task.id, leaseToken: f.leased.leaseToken!, decision: f.decision })).toThrow('租约');
});
it('collects replies from each real goal invitation chain without copying old or unrelated private-room conversations', () => {
  const bobRoom = know('bob'), carolRoom = know('carol');
  for (const [room, authorId] of [[bobRoom, 'bob'], [carolRoom, 'carol']] as const) store.request({ type: 'social.message.append',
    conversationId: room.id, authorId, content: 'OLD_PRIVATE_CANARY_' + authorId, virtualCreatedAt: new Date().toISOString(), clientId: 'old_private_' + authorId });
  const f = continuingIntroduction(); advance(); store.request(f.send);
  expect(store.request({ type: 'activity.get', ...f.origin, id: f.task.id }).activityTask!.stage).toContain('尚无可见的真实回信凭证');
  finishQueuedReplies({ bob: 'bob愿意参加这次组局。' });
  query('people', 'alice', 'carol');
  const second = { type: 'world.tool', ...f.origin, sourceMessageId: f.source.id, clientId: 'continuing_second_intro',
    arguments: { action: 'introduce', targetCompanionId: 'carol', text: 'carol，你也愿意一起玩吗？' } } as const;
  store.request(second); store.request({ ...f.ensure, deliveryClientId: second.clientId }); advance(); store.request(second);
  finishQueuedReplies({ carol: 'carol也愿意参加这次组局。' });
  // An unrelated later outbox has a real chain and a real reply in the same
  // room. A room match alone must still not make it this goal's evidence.
  store.request({ type: 'social.send', companionId: 'bob', conversationId: bobRoom.id, channel: 'phone',
    content: '另一个私人问题，与组局无关。', clientId: 'other_goal_outbox' });
  advance(); finishQueuedReplies({ alice: 'OTHER_GOAL_PRIVATE_CANARY' }); advance(5100);
  const leased = store.request({ type: 'activity.claim' }).activityTask!;
  expect(leased.id).toBe(f.task.id);
  const observed = store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! });
  expect(observed.activityTask!.stage).toContain('已收到2位伙伴的真实回信');
  expect(observed.activityTask!.stage).toContain('回信不等于报名');
  expect(observed.activityTask!.stage.length).toBeLessThanOrEqual(2000);
  expect(observed.activityTask!.stage).not.toMatch(/OLD_PRIVATE_CANARY|OTHER_GOAL_PRIVATE_CANARY/);
  expect(observed.activityMessages!.map(message => message.content)).toEqual(expect.arrayContaining(['bob愿意参加这次组局。', 'carol也愿意参加这次组局。']));
  expect(JSON.stringify(observed.activityMessages)).not.toMatch(/OLD_PRIVATE_CANARY|OTHER_GOAL_PRIVATE_CANARY|另一个私人问题/);
  const origins = observed.activityMessageOrigins!;
  expect(origins).toHaveLength(2);
  expect(origins.map(item => item.deliveryClientId)).toEqual(expect.arrayContaining([f.send.clientId, second.clientId]));
  expect(origins.map(item => item.conversationId)).toEqual(expect.arrayContaining([bobRoom.id, carolRoom.id]));
  for (const origin of origins) {
    expect(origin.sourceMessageId).toBeTruthy(); expect(origin.chainId).toBeTruthy();
    expect(observed.activityMessages).toContainEqual(expect.objectContaining({ id: origin.messageId, conversationId: origin.conversationId }));
  }
});
it.each(['after_defer', 'after_observe_before_commit'] as const)('replans a deferred decision when a new reply in its actual goal chain arrives %s', timing => {
  const f = continuingIntroduction(); know('carol'); advance(); store.request(f.send);
  const firstJob = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(firstJob.companionId).toBe('bob'); completeJob(firstJob, '我原先愿意参加。'); advance();
  const leased = store.request({ type: 'activity.claim' }).activityTask!;
  const read = store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! });
  expect(read.activityMessages!.map(message => message.content)).toContain('我原先愿意参加。');
  const followup = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(followup.companionId).toBe('alice');
  const decision = { status: 'continue', action: { action: 'create_group', recipientIds: ['bob', 'carol'], title: '不能按过时同意建群',
    text: '我们一起开始吧。', topic: { title: '待确认游戏', kind: 'game' } },
    wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '依据已经读到的参加意向组织。' } satisfies ActivityDecision;
  if (timing === 'after_defer') {
    const deferred = store.request({ type: 'activity.commit', id: leased.id, leaseToken: leased.leaseToken!, decision }).activityTask!;
    expect(deferred).toMatchObject({ status: 'queued', step: 1 });
  }
  completeJob(followup, '好，我继续确认一下安排。'); advance();
  const changedMind = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(changedMind.companionId).toBe('bob'); completeJob(changedMind, '我改主意了，这一局不参加。');
  if (timing === 'after_observe_before_commit') {
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'carol'] }).socialConversation!;
    store.request({ type: 'social.send', companionId: 'alice', conversationId: room.id, channel: 'phone',
      clientId: 'unrelated_typing_to_defer', content: '另一个问候。', agentSource: { conversationId: f.origin.conversationId, messageId: f.source.id } });
    const deferred = store.request({ type: 'activity.commit', id: leased.id, leaseToken: leased.leaseToken!, decision }).activityTask!;
    expect(deferred).toMatchObject({ status: 'queued', step: 1 });
    advance(); store.request({ type: 'social.job.claim' });
  }
  advance(5100);
  const replanned = store.request({ type: 'activity.claim' }).activityTask!;
  expect(replanned).toMatchObject({ id: f.task.id, status: 'running', step: 1 });
  expect(replanned.history).toHaveLength(1);
  expect(store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items.filter(room => room.kind === 'group')).toEqual([]);
  const observed = store.request({ type: 'activity.observe', id: replanned.id, leaseToken: replanned.leaseToken! });
  expect(observed.activityMessages!.map(message => message.content)).toContain('我改主意了，这一局不参加。');
});
