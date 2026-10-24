import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMessage } from '../../src/shared/companions';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
import { executionMessageReadsetKey } from '../../src/companions/execution-source-access';

const owned: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
afterEach(() => { for (const f of owned.splice(0)) { f.db.close(); f.store.close(); removeOwnedDirectorySync(f.root); } vi.useRealTimers(); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(stagedCreation = false) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-23T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-social-game-context-')), filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, ['a', 'b', 'c'].map(id => ({ id, name: id, persona: '独立参与者', description: '', avatar: 'sister' as const, model: '', active: true, proactive: false })));
  const db = new (Database as { new(file: string): CompanionConnection })(filename); owned.push({ root, store, db });
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['a', 'b', 'c']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
  }
  const advance = (ms = 2000) => { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); };
  advance(10000);
  const scope = { companionId: 'a', conversationId: store.openPrivate('a').id };
  const human = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请和b、c玩完此局；PRIVATE_HUMAN_DETAIL_NEVER_SHARED。', replyDirective: 'none' });
  store.request({ type: 'world.tool', ...scope, arguments: { action: 'query', category: 'people' } });
  for (const targetCompanionId of ['b', 'c']) {
    const input = { type: 'world.tool' as const, ...scope, sourceMessageId: human.id, clientId: 'intro_' + targetCompanionId,
      arguments: { action: 'introduce' as const, targetCompanionId, text: '我是a，想认识你。' } };
    store.request(input); advance(); store.request(input); advance();
  }
  const groupInput = { type: 'world.tool' as const, ...scope, sourceMessageId: human.id, clientId: 'actual_game',
    arguments: { action: 'create_group' as const, recipientIds: ['b', 'c'], title: '这局', text: '邀请实际加入本局。',
      ...(!stagedCreation ? { topic: { title: '本局', kind: 'game' as const } } : {}) } };
  const created = store.request(groupInput), room = created.socialConversation!.id;
  let task = store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: human.id, deliveryClientId: groupInput.clientId, operation: 'create_group' }).activityTask!;
  advance(); store.request(groupInput);
  const topicId = created.topic?.id ?? store.request({ type: 'topic.create', conversationId: room, readerId: 'a', title: '分阶段创建本局', kind: 'game', participantIds: ['b', 'c'] }).topic!.id;
  for (const readerId of ['b', 'c']) store.request({ type: 'topic.join', conversationId: room, topicId, readerId });
  let current = store.request({ type: 'topic.read', conversationId: room, topicId, readerId: 'a' });
  current = store.request({ type: 'topic.update', conversationId: room, topicId, readerId: 'a', expectedRevision: current.topic!.revision,
    patch: { shared: { summary: '本局已实际确认参与者', state: { phase: 'night' }, sourceMessageIds: [] } } });
  const sharedId = current.topicState!.shared!.sourceEventId;
  const topicReads = [{ conversationId: room, topicId, checkpointEventIds: [sharedId], sourceMessageIds: [] }];
  const readset = (owner: string, targetRoom: string, sources: CompanionMessage[]) => captureCompanionExecutionReadset({ companionId: owner, conversationId: targetRoom },
    { sources: sources.map(source => ({ id: source.id, conversationId: source.conversationId, checksum: sha(source.content) })), topics: topicReads });
  const drain = () => {
    for (let i = 0; i < 20; i++) {
      advance(); const job = store.request({ type: 'social.job.claim' }).socialJob;
      if (!job) return;
      advance(); store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null });
    }
    throw new Error('Unexpected unbounded peer jobs');
  };
  drain();
  if (stagedCreation) {
    const notice = { type: 'social.send' as const, companionId: 'a', conversationId: room, topicId, channel: 'phone' as const,
      content: '本局规则已公开确认，请按话题实际加入。', authorizationMessageId: human.id, agentSource: { conversationId: human.conversationId, messageId: human.id },
      clientId: 'staged_actual_public_binding', executionReadset: readset('a', room, [human]) };
    store.request(notice); advance(); store.request(notice);
    task = store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: human.id, deliveryClientId: notice.clientId, operation: 'message' }).activityTask!;
    expect(task.gamePort).toMatchObject({ conversationId: room, topicId, deliveryClientId: notice.clientId });
    expect(db.prepare('SELECT 1 FROM metadata WHERE key=?').get(`world-goal-game-port/a/${human.id}`)).toBeUndefined();
    drain();
  }
  const peer = store.request({ type: 'social.conversation.ensure', companionId: 'a', memberIds: ['a', 'b'] }).socialConversation!;
  const send = { type: 'social.send' as const, companionId: 'a', conversationId: peer.id, channel: 'phone' as const, content: 'PRIVATE_CARD_FOR_B_ONLY：你是预言家。',
    authorizationMessageId: human.id, agentSource: { conversationId: human.conversationId, messageId: human.id }, clientId: 'actual_night_private',
    executionReadset: readset('a', peer.id, [human]) };
  store.request(send); advance();
  const claim = store.request({ type: 'social.job.claim' });
  const job = claim.socialJob!, source = claim.socialMessage?.message ?? store.request(send).socialMessage!.message;
  expect(job).toMatchObject({ companionId: 'b', sourceMessageId: source.id, status: 'running' });
  expect(source.topicId).toBeUndefined();
  const command = { type: 'social.job.game_context' as const, id: job.id, leaseToken: job.leaseToken!, companionId: 'b', conversationId: peer.id,
    sourceMessageId: source.id, sourceChecksum: sha(source.content), recipientIds: ['c'] };
  return { root, store, db, scope, human, room, topicId, task, source, job, command, advance, readset, drain, groupInput };
}

it('resolves only the exact leased private source to its game and this reader private state, without exporting the human request', () => {
  const f = fixture();
  const current = f.store.request({ type: 'topic.read', conversationId: f.room, topicId: f.topicId, readerId: 'a' });
  f.store.request({ type: 'topic.update', conversationId: f.room, topicId: f.topicId, readerId: 'a', expectedRevision: current.topic!.revision,
    patch: { privateRecipientId: 'b', workingState: { summary: '给b的真实私态', state: { role: 'seer', bOnly: 'B_SECRET' }, sourceMessageIds: [] } } });
  const response = f.store.request(f.command);
  expect(companionStorageResponseSchema.safeParse(response).success).toBe(true);
  expect(response.socialGameContext).toMatchObject({ gamePort: { conversationId: f.room, topicId: f.topicId }, topicState: { readerId: 'b', workingState: { state: { bOnly: 'B_SECRET' } } } });
  for (const secret of ['PRIVATE_HUMAN_DETAIL_NEVER_SHARED', f.human.id, f.human.conversationId]) expect(JSON.stringify(response.socialGameContext)).not.toContain(secret);
  expect(f.store.request({ ...f.command, recipientIds: [] }).socialGameContext?.gamePort.topicId).toBe(f.topicId);
});

it.each(['token', 'owner', 'source', 'room', 'checksum', 'expired', 'cancelled', 'topic_closed', 'recipient_left', 'owner_left', 'source_revised', 'goal_forgotten', 'missing_episode'] as const)('rejects %s without guessing another game or broadening authority', invalidation => {
  const f = fixture();
  expect(f.store.request(f.command).socialGameContext).toBeDefined();
  const command = { ...f.command };
  if (invalidation === 'token') command.leaseToken = 'not_the_lease';
  else if (invalidation === 'owner') command.companionId = 'c';
  else if (invalidation === 'source') command.sourceMessageId = f.human.id;
  else if (invalidation === 'room') command.conversationId = f.room;
  else if (invalidation === 'checksum') command.sourceChecksum = sha('forged');
  else if (invalidation === 'expired') vi.setSystemTime(Date.now() + 180001);
  else if (invalidation === 'cancelled') f.store.request({ type: 'activity.cancel', ...f.scope, id: f.task.id });
  else if (invalidation === 'topic_closed') {
    const topic = f.store.request({ type: 'topic.read', conversationId: f.room, topicId: f.topicId, readerId: 'a' }).topic!;
    f.store.request({ type: 'topic.close', conversationId: f.room, topicId: f.topicId, readerId: 'a', expectedRevision: topic.revision });
  } else if (invalidation === 'recipient_left') f.store.request({ type: 'topic.leave', conversationId: f.room, topicId: f.topicId, readerId: 'c' });
  else if (invalidation === 'owner_left') f.store.request({ type: 'topic.leave', conversationId: f.room, topicId: f.topicId, readerId: 'b' });
  else if (invalidation === 'source_revised') f.db.prepare('UPDATE messages SET content=? WHERE id=?').run('actual revised source', f.source.id);
  else if (invalidation === 'missing_episode') f.db.prepare('DELETE FROM metadata WHERE key=?').run(executionMessageReadsetKey(f.source.id));
  else f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.human.id] });
  expect(f.store.request(command).socialGameContext).toBeUndefined();
});

it.each(['original_goal', 'actual_private_card'] as const)('keeps the actual game through host→b→c without leaking b private card, then revokes derivatives after %s withdrawal', withdrawal => {
  const f = fixture();
  const peer = f.store.request({ type: 'social.conversation.ensure', companionId: 'b', memberIds: ['b', 'c'] }).socialConversation!;
  f.advance(); f.store.request({ type: 'social.job.complete', id: f.job.id, leaseToken: f.job.leaseToken!, text: null });
  const send = { type: 'social.send' as const, companionId: 'b', conversationId: peer.id, channel: 'phone' as const, content: '请确认本局夜间行动。',
    agentSource: { conversationId: f.source.conversationId, messageId: f.source.id }, clientId: 'b_actual_message_to_c', executionReadset: f.readset('b', peer.id, [f.source]) };
  f.store.request(send); f.advance();
  const next = f.store.request({ type: 'social.job.claim' }), job = next.socialJob!, source = next.socialMessage!.message;
  expect(job).toMatchObject({ companionId: 'c', origin: { initiatorKind: 'human_player', sharedText: send.content } });
  for (const secret of ['PRIVATE_CARD_FOR_B_ONLY', 'PRIVATE_HUMAN_DETAIL_NEVER_SHARED', f.human.id, f.human.conversationId]) expect(JSON.stringify(job)).not.toContain(secret);
  const context = f.store.request({ ...f.command, id: job.id, leaseToken: job.leaseToken!, companionId: 'c', conversationId: peer.id, sourceMessageId: source.id, sourceChecksum: sha(source.content), recipientIds: ['b'] });
  expect(context.socialGameContext?.gamePort.topicId).toBe(f.topicId);
  f.advance();
  const reply = f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '本局已实际确认收到。',
    executionReadset: f.readset('c', peer.id, [source]) }).socialMessage!.message;
  const scope = { companionId: 'c', conversationId: peer.id };
  expect(() => f.store.request({ type: 'memory.record', ...scope, candidate: { content: reply.content, sourceMessageIds: [reply.id], evidence: [{ sourceMessageId: reply.id, quote: reply.content }] } })).toThrow('游戏与故事');
  expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [source.id, reply.id] }).memorySources).toHaveLength(2);
  f.store.request(withdrawal === 'original_goal' ? { type: 'memory.forget', ...f.scope, sourceMessageIds: [f.human.id] }
    : { type: 'memory.forget', companionId: 'b', conversationId: f.source.conversationId, sourceMessageIds: [f.source.id] });
  expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [source.id, reply.id] }).memorySources).toHaveLength(0);
  expect(f.db.prepare('SELECT 1 FROM vcp_memory_notes WHERE json_extract(data,\'$.content\')=?').get(reply.content)).toBeUndefined();
});

it('keeps topic-less game private messages out of automatic journals while ordinary peer messages still enqueue', () => {
  const f = fixture();
  expect(f.db.prepare('SELECT 1 FROM vcp_capture_jobs WHERE message_id=?').get(f.source.id)).toBeUndefined();
  f.advance();
  const reply = f.store.request({ type: 'social.job.complete', id: f.job.id, leaseToken: f.job.leaseToken!, text: '本局私密行动已收到。',
    executionReadset: f.readset('b', f.source.conversationId, [f.source]) }).socialMessage!.message;
  expect(reply.topicId).toBeUndefined();
  expect(f.db.prepare('SELECT 1 FROM vcp_capture_jobs WHERE message_id=?').get(reply.id)).toBeUndefined();
  const human = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请告诉c明天有空一起聊天。', replyDirective: 'none' });
  const peer = f.store.request({ type: 'social.conversation.ensure', companionId: 'a', memberIds: ['a', 'c'] }).socialConversation!;
  const send = { type: 'social.send' as const, companionId: 'a', conversationId: peer.id, content: '明天有空一起聊聊吗？', channel: 'phone' as const,
    authorizationMessageId: human.id, clientId: 'ordinary_actual_peer_message' };
  f.store.request(send); f.advance();
  const ordinary = f.store.request(send).socialMessage!.message;
  expect(f.db.prepare('SELECT 1 FROM vcp_capture_jobs WHERE message_id=?').get(ordinary.id)).toBeDefined();
});

it('does not route a late old-game private job to a new game under the same human source', () => {
  const f = fixture();
  const oldTopic = f.store.request({ type: 'topic.read', conversationId: f.room, topicId: f.topicId, readerId: 'a' }).topic!;
  f.store.request({ type: 'topic.close', conversationId: f.room, topicId: f.topicId, readerId: 'a', expectedRevision: oldTopic.revision });
  const nextInput = { ...f.groupInput, clientId: 'second_episode_same_human' }, next = f.store.request(nextInput);
  expect(next.topic!.id).not.toBe(f.topicId);
  f.store.request({ type: 'activity.social.ensure', ...f.scope, sourceMessageId: f.human.id, deliveryClientId: nextInput.clientId, operation: 'create_group' });
  for (const readerId of ['b', 'c']) f.store.request({ type: 'topic.join', conversationId: next.topic!.conversationId, topicId: next.topic!.id, readerId });
  expect(f.store.request(f.command).socialGameContext).toBeUndefined();
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'b', conversationId: f.source.conversationId, ids: [f.source.id] }).memorySources).toHaveLength(1);
});

it('normal completion and game close do not revoke the already published source history', () => {
  const f = fixture();
  const value = f.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(f.task.id) as { data: string };
  f.db.prepare("UPDATE companion_activity_tasks SET status='succeeded',data=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(value.data), status: 'succeeded' }), f.task.id);
  const topic = f.store.request({ type: 'topic.read', conversationId: f.room, topicId: f.topicId, readerId: 'a' }).topic!;
  f.store.request({ type: 'topic.close', conversationId: f.room, topicId: f.topicId, readerId: 'a', expectedRevision: topic.revision });
  expect(f.store.request(f.command).socialGameContext).toBeUndefined();
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'b', conversationId: f.source.conversationId, ids: [f.source.id] }).memorySources).toHaveLength(1);
});

it('captures the actual game-context private checkpoint into a reply proof, rejects a factual diary, and revokes the reply when only the checkpoint source is forgotten', () => {
  const f = fixture();
  const cardSource = f.store.appendMessage({ conversationId: f.room, topicId: f.topicId, authorId: 'a', content: '本局主持确认的实际资料记录。', replyDirective: 'none' });
  const current = f.store.request({ type: 'topic.read', conversationId: f.room, topicId: f.topicId, readerId: 'a' });
  f.store.request({ type: 'topic.update', conversationId: f.room, topicId: f.topicId, readerId: 'a', expectedRevision: current.topic!.revision,
    patch: { privateRecipientId: 'b', workingState: { summary: '只有b能读的查验结果', state: { role: 'seer', secret: 'ACTUAL_B_ONLY_PRIVATE_RESULT' }, sourceMessageIds: [cardSource.id] } } });
  const gameCommunication = f.store.request(f.command).socialGameContext!;
  expect(gameCommunication.topicState.workingState?.sourceMessageIds).toEqual([cardSource.id]);
  const scope = { companionId: 'b', conversationId: f.source.conversationId };
  const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ conversation: { id: scope.conversationId }, messages: [f.source], gameCommunication }) } });
  expect(readset.complete).toBe(true);
  expect(readset.topics[0]?.checkpointEventIds).toContain(gameCommunication.topicState.workingState!.sourceEventId);
  f.advance();
  const reply = f.store.request({ type: 'social.job.complete', id: f.job.id, leaseToken: f.job.leaseToken!, text: '本局本人秘密查验已记录。', executionReadset: readset }).socialMessage!.message;
  expect(() => f.store.request({ type: 'memory.record', ...scope, candidate: { content: reply.content, sourceMessageIds: [reply.id], evidence: [{ sourceMessageId: reply.id, quote: reply.content }] } })).toThrow('游戏与故事');
  expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [reply.id, f.source.id] }).memorySources).toHaveLength(2);
  f.store.request({ type: 'memory.forget', companionId: 'b', conversationId: f.room, sourceMessageIds: [cardSource.id] });
  expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [reply.id] }).memorySources).toHaveLength(0);
  expect(f.db.prepare('SELECT 1 FROM vcp_memory_notes WHERE json_extract(data,\'$.content\')=?').get(reply.content)).toBeUndefined();
  expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [f.source.id] }).memorySources).toHaveLength(1);
  expect(f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: [f.human.id] }).memorySources).toHaveLength(1);
});

it('rejects conflicting versions of one source instead of dropping an old read-time checksum when the last duplicate matches current bytes', () => {
  const f = fixture(), room = f.store.request({ type: 'social.conversation.ensure', companionId: 'a', memberIds: ['a', 'c'] }).socialConversation!.id;
  const readset = f.readset('a', room, [f.human]);
  readset.sources.unshift({ ...readset.sources[0]!, checksum: sha('older bytes that were actually read') });
  const send = { type: 'social.send' as const, companionId: 'a', conversationId: room, content: '本局确认。', channel: 'phone' as const,
    authorizationMessageId: f.human.id, clientId: 'conflicting_source_versions', executionReadset: readset };
  f.store.request(send); f.advance();
  expect(() => f.store.request(send)).toThrow('冲突版本');
  expect(f.db.prepare('SELECT 1 FROM messages WHERE client_id=?').get(send.clientId)).toBeUndefined();
});

it('uses a real staged group→native game topic→actual send/bind receipt without inventing a WorldStore creation reservation', () => {
  const f = fixture(true);
  expect(f.store.request(f.command).socialGameContext?.gamePort).toEqual({ conversationId: f.room, topicId: f.topicId });
  expect(f.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(`world-goal-game-port/a/${f.human.id}`)).toBeUndefined();
});

it.each(['missing_outbox', 'false_source_outbox', 'conflicting_reservation', 'different_active_task_ports'] as const)('does not accept a staged binding with %s', invalidation => {
  const f = fixture(true);
  expect(f.store.request(f.command).socialGameContext).toBeDefined();
  const delivery = f.task.gamePort!.deliveryClientId;
  if (invalidation === 'missing_outbox') f.db.prepare('DELETE FROM companion_social_outbox WHERE client_id=?').run(delivery);
  else if (invalidation === 'false_source_outbox') {
    const value = f.db.prepare('SELECT data FROM companion_social_outbox WHERE client_id=?').get(delivery) as { data: string };
    f.db.prepare('UPDATE companion_social_outbox SET data=? WHERE client_id=?').run(JSON.stringify({ ...JSON.parse(value.data), authorizationMessageId: 'forged', agentSource: { messageId: 'forged', conversationId: f.scope.conversationId } }), delivery);
  } else if (invalidation === 'conflicting_reservation') f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(`world-goal-game-port/a/${f.human.id}`,
    JSON.stringify({ companionId: 'a', sourceChecksum: sha(f.human.content), conversationId: f.room, topicId: 'another_episode', send: { clientId: delivery } }));
  else {
    const alternate = f.store.request({ type: 'topic.create', conversationId: f.room, readerId: 'a', title: '真实但冲突的另一局', kind: 'game', participantIds: ['b', 'c'] }).topic!;
    f.store.request({ type: 'social.send', companionId: 'a', conversationId: f.room, topicId: alternate.id, channel: 'phone', content: '另一局真实但未绑定的通知。',
      authorizationMessageId: f.human.id, agentSource: { conversationId: f.human.conversationId, messageId: f.human.id }, clientId: 'alternate_actual_outbox' });
    const value = f.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(f.task.id) as { data: string };
    const task = { ...JSON.parse(value.data), id: 'conflicting_durable_task', clientId: 'conflicting_durable_client', gamePort: { conversationId: f.room, topicId: alternate.id, deliveryClientId: 'alternate_actual_outbox' } };
    // Simulate a conflicting durable host record from an older writer. Both
    // receipts are real; a read must not silently choose a convenient episode.
    f.db.prepare('INSERT INTO companion_activity_tasks(id,companion_id,conversation_id,source_message_id,status,next_at,client_id,data) VALUES(?,?,?,?,?,?,?,?)')
      .run(task.id, 'a', f.scope.conversationId, f.human.id, task.status, task.nextAt, task.clientId, JSON.stringify(task));
  }
  expect(f.store.request(f.command).socialGameContext).toBeUndefined();
});

function sameEpisodeReboundFixture() {
  const f = fixture();
  f.advance(); f.store.request({ type: 'social.job.complete', id: f.job.id, leaseToken: f.job.leaseToken!, text: null });
  const notice = { type: 'social.send' as const, companionId: 'a', conversationId: f.room, topicId: f.topicId, channel: 'phone' as const,
    content: '本局继续，当前实际进度已确认。', authorizationMessageId: f.human.id, agentSource: { conversationId: f.human.conversationId, messageId: f.human.id },
    clientId: 'later_actual_same_game_receipt', executionReadset: f.readset('a', f.room, [f.human]) };
  f.store.request(notice); f.advance(); f.store.request(notice);
  const task = f.store.request({ type: 'activity.social.ensure', ...f.scope, sourceMessageId: f.human.id, deliveryClientId: notice.clientId, operation: 'message' }).activityTask!;
  expect(task.gamePort?.deliveryClientId).toBe(notice.clientId);
  const reservation = f.db.prepare('SELECT value FROM metadata WHERE key=?').get(`world-goal-game-port/a/${f.human.id}`) as { value: string };
  expect(JSON.parse(reservation.value).send.clientId).toBe('actual_game');
  f.drain();
  const send = { type: 'social.send' as const, companionId: 'a', conversationId: f.source.conversationId, channel: 'phone' as const,
    content: '请继续确认本局夜间行动。', authorizationMessageId: f.human.id, agentSource: { conversationId: f.human.conversationId, messageId: f.human.id },
    clientId: 'later_same_game_private', executionReadset: f.readset('a', f.source.conversationId, [f.human]) };
  f.store.request(send); f.advance();
  const next = f.store.request({ type: 'social.job.claim' }), job = next.socialJob!, source = next.socialMessage!.message;
  expect(job.companionId).toBe('b');
  return { ...f, secondPrivateSource: source,
    command: { ...f.command, id: job.id, leaseToken: job.leaseToken!, sourceMessageId: source.id, sourceChecksum: sha(source.content) } };
}

it('retains the same game when a later actual binding receipt differs from the original creation receipt', () => {
  const f = sameEpisodeReboundFixture();
  expect(f.store.request(f.command).socialGameContext?.gamePort.topicId).toBe(f.topicId);
});

it.each(['missing', 'cancelled', 'source_checksum', 'request_fingerprint', 'declared_source_changed', 'published_bytes_changed'] as const)('rejects an independently %s original creation receipt while the newer same-game binding remains real', invalidation => {
  const f = sameEpisodeReboundFixture();
  expect(f.store.request(f.command).socialGameContext).toBeDefined();
  const original = f.db.prepare('SELECT data,message_id FROM companion_social_outbox WHERE client_id=?').get('actual_game') as { data: string; message_id: string };
  if (invalidation === 'missing') f.db.prepare('DELETE FROM companion_social_outbox WHERE client_id=?').run('actual_game');
  else if (invalidation === 'cancelled') f.db.prepare("UPDATE companion_social_outbox SET status='cancelled' WHERE client_id=?").run('actual_game');
  else if (invalidation === 'published_bytes_changed') f.db.prepare('UPDATE messages SET content=? WHERE id=?').run('actual changed creation announcement', original.message_id);
  else {
    const changed = JSON.parse(original.data);
    if (invalidation === 'source_checksum') changed.agentChecksum = sha('different read-time version');
    else if (invalidation === 'request_fingerprint') changed.fingerprint = sha('different actual request');
    else changed.agentSource = { conversationId: f.secondPrivateSource.conversationId, messageId: f.secondPrivateSource.id };
    f.db.prepare('UPDATE companion_social_outbox SET data=? WHERE client_id=?').run(JSON.stringify(changed), 'actual_game');
  }
  expect(f.store.request({ type: 'activity.get', ...f.scope, id: f.task.id }).activityTask?.historyAvailable).toBe(true);
  expect(f.store.request(f.command).socialGameContext).toBeUndefined();
});
