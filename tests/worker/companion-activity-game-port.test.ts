import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { ActivityDecision } from '../../src/shared/companion-activity-task';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
const owned: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => { for (const { root, store } of owned.splice(0)) { store.close(); if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-activity-game-port-')) throw new Error('Unexpected fixture'); removeOwnedDirectorySync(root); } vi.useRealTimers(); });
it('retains only a source-backed actual game port across private messages and more than 32 social effects, then hides it after topic withdrawal', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-23T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-activity-game-port-'));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['a', 'b', 'c'].map(id => ({ id, name: id, persona: '友好',
    description: '', avatar: 'sister', model: '', active: true, proactive: false }))); owned.push({ root, store });
  const scope = { companionId: 'a', conversationId: store.openPrivate('a').id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['a', 'b', 'c']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
  }
  const advance = () => { vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' }); };
  advance();
  store.request({ type: 'world.tool', ...scope, arguments: { action: 'query', category: 'people' } });
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请和b、c玩完这一局游戏。', replyDirective: 'none' });
  for (const targetCompanionId of ['b', 'c']) {
    const input = { type: 'world.tool' as const, ...scope, sourceMessageId: source.id, clientId: 'intro_' + targetCompanionId,
      arguments: { action: 'introduce' as const, targetCompanionId, text: '我是a，想认识你。' } };
    store.request(input); advance(); store.request(input); advance();
  }
  const group = store.request({ type: 'world.tool', ...scope, sourceMessageId: source.id, clientId: 'actual_game_group',
    arguments: { action: 'create_group', recipientIds: ['b', 'c'], title: '本局群', text: '进来确认本局吧。', topic: { title: '本局', kind: 'game' } } });
  expect(group.topic?.kind).toBe('game');
  let task = store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: source.id, deliveryClientId: 'actual_game_group', operation: 'create_group' }).activityTask!;
  expect(task.gamePort).toEqual({ conversationId: group.socialConversation!.id, topicId: group.topic!.id, deliveryClientId: 'actual_game_group' });
  advance();
  const pair = store.request({ type: 'social.conversation.ensure', companionId: 'a', memberIds: ['a', 'b'] }).socialConversation!;
  for (let index = 0; index < 35; index++) {
    const clientId = 'actual_private_game_message_' + index;
    store.request({ type: 'social.send', companionId: 'a', conversationId: pair.id, content: `本局第${index + 1}条必要私信。`, clientId,
      channel: 'phone', authorizationMessageId: source.id, agentSource: { conversationId: source.conversationId, messageId: source.id } });
    task = store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: source.id, deliveryClientId: clientId, operation: 'message' }).activityTask!;
    advance();
  }
  expect(task.step).toBe(36); expect(task.peerConversationId).toBe(pair.id); expect(task.peerTopicId).toBeNull();
  expect(task.gamePort?.topicId).toBe(group.topic!.id);
  expect(store.request({ type: 'activity.history', ...scope, id: task.id, limit: 100 }).activityHistory?.total).toBe(36);
  const competingTopic = store.request({ type: 'topic.create', conversationId: group.socialConversation!.id, readerId: 'a', title: '另一个真实话题', kind: 'game' }).topic!;
  const secondMessage = { type: 'social.send' as const, companionId: 'a', conversationId: group.socialConversation!.id, topicId: competingTopic.id,
    content: '另一个实际话题的独立消息。', clientId: 'actual_other_topic_message', channel: 'phone' as const, authorizationMessageId: source.id };
  store.request(secondMessage);
  const rebind = () => store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: source.id, deliveryClientId: secondMessage.clientId, operation: 'message' });
  expect(rebind).toThrow('原游戏端口尚未明确关闭');
  const old = store.request({ type: 'topic.read', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'a' }).topic!;
  const paused = store.request({ type: 'topic.pause', conversationId: old.conversationId, topicId: old.id, readerId: 'a', expectedRevision: old.revision }).topic!;
  expect(rebind).toThrow('原游戏端口尚未明确关闭');
  store.request({ type: 'topic.resume', conversationId: old.conversationId, topicId: old.id, readerId: 'a', expectedRevision: paused.revision });
  expect(store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask?.gamePort?.topicId).toBe(old.id);
  for (const readerId of ['b', 'c']) store.request({ type: 'topic.join', conversationId: group.socialConversation!.id,
    topicId: group.topic!.id, readerId });
  const livePublicReply = store.appendMessage({ conversationId: group.socialConversation!.id, topicId: group.topic!.id,
    authorId: 'b', content: '我已阅读本局公共规则，接下来会按真实阶段行动。', replyDirective: 'none' });
  const beforeLongCheckpoint = store.request({ type: 'topic.read', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'a' }).topic!;
  const actualLongPublicSummary = '已经实际公开的本局规则与准备信息。'.repeat(180);
  store.request({ type: 'topic.update', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'a',
    expectedRevision: beforeLongCheckpoint.revision, patch: { shared: { summary: actualLongPublicSummary } } });
  // Main's last real send is in an external reply wait. Let that durable wait
  // expire, rather than bypassing its stored status to obtain a planner lease.
  vi.setSystemTime(Date.now() + 310000);
  for (let tick = 0; tick < 1000; tick++) if (!store.request({ type: 'world.tick' }).world?.backlog) break;
  const step = (topic: NonNullable<ActivityDecision['topic']>) => {
    advance(); const leased = store.request({ type: 'activity.claim' }).activityTask!;
    expect(leased?.id).toBe(task.id);
    const observed = store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! });
    expect(observed.activityGameRoom).toEqual({ conversationId: group.socialConversation!.id, memberIds: ['a', 'b', 'c'] });
    expect(observed.topic?.participantIds.slice().sort()).toEqual(['a', 'b', 'c']);
    if (task.step === 36) expect(observed.activityMessages?.some(message => message.id === livePublicReply.id)).toBe(true);
    task = store.request({ type: 'activity.commit', id: leased.id, leaseToken: leased.leaseToken!,
      decision: { status: 'continue', topic, action: null, wait: null, summary: '本局真实话题操作。' } }).activityTask!;
    return task.history.at(-1)!;
  };
  const read = step({ action: 'read', topicId: group.topic!.id });
  expect(read.ok).toBe(true);
  expect(read.result.length).toBeGreaterThan(2000);
  expect(JSON.parse(read.result).topicState.shared.summary).toBe(actualLongPublicSummary);
  expect(task.stage.length).toBeLessThanOrEqual(2000); expect(task.stage).toContain('history');
  const revision = JSON.parse(read.result).topic.revision;
  expect(step({ action: 'update', topicId: group.topic!.id, expectedRevision: revision,
    patch: { privateRecipientId: 'b', workingState: { summary: '本人私牌', state: { role: 'seer', secret: 'ONLY_B_CAN_SEE_THIS' }, sourceMessageIds: [] } } }).ok).toBe(true);
  expect(task.history.at(-1)!.result.length).toBeGreaterThan(2000);
  expect(task.stage.length).toBeLessThanOrEqual(2000);
  const privateB = store.request({ type: 'topic.read', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'b' });
  expect(privateB.topicState?.workingState?.state?.secret).toBe('ONLY_B_CAN_SEE_THIS');
  const privateC = store.request({ type: 'topic.read', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'c' });
  expect(JSON.stringify(privateC)).not.toContain('ONLY_B_CAN_SEE_THIS');
  const ownerView = step({ action: 'read', topicId: group.topic!.id });
  expect(ownerView.result).not.toContain('ONLY_B_CAN_SEE_THIS');
  expect(ownerView.result).toContain('"readerId":"a"');
  const latest = store.request({ type: 'topic.read', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'a' }).topic!;
  const largerPublicSummary = '真实公开长规则。'.repeat(3000);
  const publicSourceIds = Array.from({ length: 20 }, (_, index) => store.appendMessage({ conversationId: group.socialConversation!.id,
    topicId: group.topic!.id, authorId: 'a', content: '真实本局公开规则来源' + index, replyDirective: 'none' }).id);
  store.request({ type: 'topic.update', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'a',
    expectedRevision: latest.revision, patch: { shared: { summary: largerPublicSummary, sourceMessageIds: publicSourceIds } } });
  const preview = JSON.parse(step({ action: 'read', topicId: group.topic!.id }).result);
  expect(preview).toMatchObject({ displayPreview: true, truncated: true, originalChars: expect.any(Number),
    topicReceiptReference: { conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'a' } });
  expect(preview.originalChars).toBeGreaterThan(16000); expect(task.history.at(-1)!.result.length).toBeLessThanOrEqual(16000);
  expect(preview.topicReceiptReference.checkpointEventIds).toHaveLength(1);
  expect(preview.topicReceiptReference.sourceMessageIdCount).toBe(20);
  expect(preview.topicReceiptReference.sourceMessageIdsTruncated).toBe(true);
  expect(preview.topicReceiptReference.sourceMessageIds).toEqual(publicSourceIds.slice(0, 8));
  expect(store.request({ type: 'topic.sources.valid', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'a',
    sourceMessageIds: preview.topicReceiptReference.sourceMessageIds, checkpointEventIds: preview.topicReceiptReference.checkpointEventIds }).topicSourcesValid).toBe(true);
  const actualFull = store.request({ type: 'topic.read', conversationId: group.socialConversation!.id, topicId: group.topic!.id, readerId: 'a' });
  expect(actualFull.topicState?.shared?.summary).toBe(largerPublicSummary);
  expect(actualFull.topicState?.shared?.sourceEventId).toBe(preview.topicReceiptReference.checkpointEventIds[0]);
  expect(preview.originalChecksum).toBe(createHash('sha256').update(JSON.stringify(actualFull)).digest('hex'));
  const denied = step({ action: 'read', roomId: pair.id, topicId: group.topic!.id });
  expect(denied.ok).toBe(false); expect(denied.result).toContain('实际已绑定');
  expect(task.gamePort?.topicId).toBe(group.topic!.id);
  const current = store.request({ type: 'topic.read', conversationId: group.socialConversation!.id, readerId: 'a', topicId: group.topic!.id }).topic!;
  store.request({ type: 'topic.delete', conversationId: current.conversationId, readerId: 'user', topicId: current.id, expectedRevision: current.revision });
  expect(rebind).toThrow();
  expect(store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask).toMatchObject({ historyAvailable: false, history: [] });
  expect(() => store.request({ type: 'activity.history', ...scope, id: task.id, limit: 100 })).toThrow('不可访问');
});
it.each(['cancel', 'source_withdrawn', 'peer_withdrawn', 'topic_source_withdrawn', 'closed_episode'] as const)('binds an owner peer-created game through its exact live human delegation and handles %s', invalidation => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-23T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-activity-game-port-'));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['a', 'b', 'c'].map(id => ({ id, name: id, persona: '友好',
    description: '', avatar: 'sister', model: '', active: true, proactive: false }))); owned.push({ root, store });
  const scope = { companionId: 'a', conversationId: store.openPrivate('a').id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['a', 'b', 'c']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
  }
  const advance = () => { vi.setSystemTime(Date.now() + 5000); store.request({ type: 'world.tick' }); };
  advance(); store.request({ type: 'world.tool', ...scope, arguments: { action: 'query', category: 'people' } });
  const human = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '认识 b 和 c，一起玩完这一局游戏。', replyDirective: 'none' });
  for (const targetCompanionId of ['b', 'c']) {
    const command = { type: 'world.tool' as const, ...scope, sourceMessageId: human.id, clientId: 'peer_bind_intro_' + targetCompanionId,
      arguments: { action: 'introduce' as const, targetCompanionId, text: '我是a，想认识你。' } };
    store.request(command); advance(); store.request(command); advance();
  }
  const claim = (owner: string) => {
    for (let index = 0; index < 100; index++) {
      advance(); const job = store.request({ type: 'social.job.claim' }).socialJob;
      if (!job) continue;
      if (job.companionId === owner) return job;
      advance();
      store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null });
    }
    throw new Error('Expected actual social job for ' + owner);
  };
  // Settle the old introductions before the single goal invitation.
  for (let index = 0; index < 20; index++) {
    advance(); const job = store.request({ type: 'social.job.claim' }).socialJob;
    if (job) { advance(); store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null }); }
  }
  const pair = store.request({ type: 'social.conversation.ensure', companionId: 'a', memberIds: ['a', 'b'] }).socialConversation!;
  const invite = { type: 'social.send' as const, companionId: 'a', conversationId: pair.id, authorizationMessageId: human.id,
    agentSource: { conversationId: human.conversationId, messageId: human.id }, channel: 'phone' as const, clientId: 'peer_bind_goal_invite',
    content: '一起玩游戏，愿意的话就建群开始。' };
  store.request(invite); advance(); store.request(invite); advance();
  const task = store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: human.id, deliveryClientId: invite.clientId, operation: 'message' }).activityTask!;
  const b = claim('b'); advance();
  store.request({ type: 'social.job.complete', id: b.id, leaseToken: b.leaseToken!, text: '愿意，建群开始吧。' });
  const a = claim('a');
  const peerScope = { companionId: 'a', conversationId: a.conversationId, sourceMessageId: a.sourceMessageId };
  const create = { type: 'world.tool' as const, ...peerScope, clientId: 'peer_actual_game_created', arguments: { action: 'create_group' as const,
    recipientIds: ['b', 'c'], title: '本次真实目标游戏', text: '本人愿意一起玩吗？', topic: { title: '这局', kind: 'game' as const } } };
  const pending = store.request(create);
  const competing = { ...create, ...scope, sourceMessageId: human.id, clientId: 'main_race_same_game', arguments: { ...create.arguments,
    title: '另一个调用中的同局提案', text: '这是另一模型提案，不应该另外发送。' } };
  const reusedPending = store.request(competing);
  expect(reusedPending).toMatchObject({ socialDeliveryReused: true, socialDeliveryClientId: create.clientId, topic: { id: pending.topic!.id } });
  advance(); const created = store.request(create); advance();
  const reusedSent = store.request(competing);
  expect(reusedSent.socialMessage?.message.id).toBe(created.socialMessage?.message.id);
  expect(reusedSent.socialMessage?.message.content).toBe(create.arguments.text);
  expect(store.request({ type: 'topic.list', conversationId: created.socialConversation!.id, readerId: 'a' }).topics).toHaveLength(1);
  expect(() => store.request({ ...competing, clientId: 'main_conflicting_game_audience', arguments: { ...competing.arguments, includePlayer: true } }))
    .toThrow('收件人与原端口不一致');
  const bound = store.request({ type: 'activity.social.bind_peer_port', ...peerScope, deliveryClientId: create.clientId });
  expect(bound.activityTask?.id, JSON.stringify({ bound, a, created })).toBe(task.id);
  expect(bound.activityTask?.gamePort).toMatchObject({ conversationId: created.socialConversation!.id, topicId: created.topic!.id,
    deliveryClientId: create.clientId, peerOriginId: a.origin!.id });
  expect(store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: human.id,
    deliveryClientId: reusedSent.socialDeliveryClientId!, operation: 'create_group' }).activityTask?.id).toBe(task.id);
  expect(store.request({ type: 'activity.social.bind_peer_port', ...peerScope, companionId: 'b', deliveryClientId: create.clientId }).activityTask).toBeUndefined();
  expect(store.request({ type: 'activity.social.bind_peer_port', ...peerScope, sourceMessageId: human.id, deliveryClientId: create.clientId }).activityTask).toBeUndefined();
  if (invalidation === 'closed_episode') {
    const topic = store.request({ type: 'topic.read', conversationId: created.socialConversation!.id, topicId: created.topic!.id, readerId: 'a' }).topic!;
    store.request({ type: 'topic.close', conversationId: topic.conversationId, topicId: topic.id, readerId: 'a', expectedRevision: topic.revision });
    const nextCommand = { ...create, clientId: 'peer_actual_next_episode', arguments: { ...create.arguments, text: '上一局已实际结束，开始下一局。' } };
    const next = store.request(nextCommand);
    expect(next.topic!.id).not.toBe(topic.id); expect(next.topicState?.workingState).toBeUndefined(); expect(next.topicState?.shared).toBeUndefined();
    expect(store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: human.id, deliveryClientId: nextCommand.clientId, operation: 'create_group' }).activityTask?.gamePort?.topicId).toBe(next.topic!.id);
    expect(store.request({ type: 'activity.social.bind_peer_port', ...peerScope, deliveryClientId: nextCommand.clientId }).activityTask?.gamePort?.topicId).toBe(next.topic!.id);
    const oldRetry = store.request(competing);
    expect(oldRetry).toMatchObject({ socialDeliveryClientId: create.clientId, topic: { id: topic.id, status: 'closed' } });
    expect(oldRetry.socialMessage?.message.id).toBe(created.socialMessage?.message.id);
    expect(store.request({ type: 'topic.list', conversationId: topic.conversationId, readerId: 'a' }).topics).toHaveLength(2);
    expect(() => store.request({ ...competing, arguments: { ...competing.arguments, text: '试图更改原调用内容' } })).toThrow('另一提案');
    return;
  }
  if (invalidation === 'topic_source_withdrawn') {
    const room = created.socialConversation!.id, topicId = created.topic!.id, topicMessage = created.socialMessage!.message.id;
    store.request({ type: 'topic.update', conversationId: room, topicId, readerId: 'a', expectedRevision: created.topic!.revision,
      patch: { shared: { summary: '根据真实本局消息作出的进展', sourceMessageIds: [topicMessage] } } });
    advance(); store.request({ type: 'social.job.complete', id: a.id, leaseToken: a.leaseToken!, text: null });
    vi.setSystemTime(Date.now() + 310000);
    for (let tick = 0; tick < 1000; tick++) if (!store.request({ type: 'world.tick' }).world?.backlog) break;
    advance(); const leased = store.request({ type: 'activity.claim' }).activityTask!;
    expect(leased?.id).toBe(task.id);
    const observed = store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! });
    expect(observed.topicState?.shared?.sourceMessageIds).toEqual([topicMessage]);
    // A fresh replacement does not erase the immutable checkpoint which was
    // actually read by this task's earlier inference.
    store.request({ type: 'topic.update', conversationId: room, topicId, readerId: 'a', expectedRevision: observed.topic!.revision,
      patch: { shared: { summary: '后来独立更新', sourceMessageIds: [] } } });
    expect(store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask?.historyAvailable).toBe(true);
    store.request({ type: 'memory.forget', companionId: 'a', conversationId: room, sourceMessageIds: [topicMessage] });
  }
  if (invalidation === 'cancel') store.request({ type: 'activity.cancel', ...scope, id: task.id });
  else if (invalidation === 'source_withdrawn') store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [human.id] });
  else if (invalidation === 'peer_withdrawn') store.request({ type: 'memory.forget', companionId: peerScope.companionId, conversationId: peerScope.conversationId,
    sourceMessageIds: [peerScope.sourceMessageId] });
  expect(store.request({ type: 'activity.social.bind_peer_port', ...peerScope, deliveryClientId: create.clientId }).activityTask).toBeUndefined();
  const after = store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!;
  if (invalidation === 'cancel') expect(after.status).toBe('cancelled');
  else expect(after.historyAvailable).toBe(false);
});
