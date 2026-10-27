import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionSocialStore } from '../../src/companions/social-store';
import { companionSocialDelegatedPortOrigin } from '../../src/companions/social-goal-origin';
import { findCompanionActivityPortCandidate, findJoinedCompanionActivityPortCandidate, registerCompanionActivityPortCandidate } from '../../src/companions/activity-port-candidates';
import { companionTopicCapabilities } from '../../src/main/companions/topic-capabilities';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
const owned: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
afterEach(() => { for (const f of owned.splice(0)) { f.db.close(); f.store.close(); removeOwnedDirectorySync(f.root); } vi.useRealTimers(); });
function fixture(earlierOwnerPort = false) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-25T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-port-candidates-')), filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, ['a', 'b', 'c'].map(id => ({ id, name: id, description: '', persona: '自主决定',
    avatar: 'sister' as const, model: '', active: true, proactive: false })));
  const db = new (Database as { new(file: string): CompanionConnection })(filename); owned.push({ root, store, db });
  const visible = (scope: { companionId: string; conversationId: string }, ids: string[]) => store.request({ type: 'memory.sources.filter', ...scope, ids }).memorySources!;
  const social = new CompanionSocialStore(db, input => store.appendMessage(input), id => store.getMessage(id), visible,
    () => ({ timeZone: 'UTC', virtualNow: new Date().toISOString(), observedDay: '2026-10-25', backlog: false }), () => true, () => {});
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['a', 'b', 'c']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
  }
  const advance = () => { vi.setSystemTime(Date.now() + 5000); store.request({ type: 'world.tick' }); };
  const scope = { companionId: 'a', conversationId: store.openPrivate('a').id };
  const human = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请和b、c共同完成一次讨论活动。', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: human.id, clientId: 'one_original_goal', title: '共同活动', goal: human.content }).activityTask!;
  advance();
  for (const [companionId, targetCompanionId] of [['a', 'b'], ['a', 'c'], ['b', 'c']]) {
    const port = { companionId: companionId!, conversationId: store.openPrivate(companionId!).id };
    const introSource = companionId === 'a' ? human : store.appendMessage({ conversationId: port.conversationId,
      authorId: 'user', content: '先认识c，后续由你自主决定是否参加共同讨论。', replyDirective: 'none' });
    store.request({ type: 'world.tool', ...port, arguments: { action: 'query', category: 'people' } });
    const intro = { type: 'world.tool' as const, ...port, sourceMessageId: introSource.id, clientId: `intro_${companionId}_${targetCompanionId}`,
      arguments: { action: 'introduce' as const, targetCompanionId: targetCompanionId!, text: '想认识你。' } };
    store.request(intro); advance(); store.request(intro); advance();
  }
  // Retire actual introduction replies before claiming the exact delegation.
  for (let n = 0; n < 20; n++) { advance(); const job = store.request({ type: 'social.job.claim' }).socialJob;
    if (job) { advance(); store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null }); } }
  const originalCreate = { type: 'world.tool' as const, ...scope, sourceMessageId: human.id, clientId: 'owner_group_proposal',
    arguments: { action: 'create_group' as const, recipientIds: ['b', 'c'], title: '原目标讨论群', text: '请自主参加讨论。', topic: { title: '共同讨论', kind: 'game' as const } } };
  const old = earlierOwnerPort ? store.request(originalCreate) : undefined;
  if (old) store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: human.id, deliveryClientId: originalCreate.clientId, operation: 'create_group' });
  const pair = store.request({ type: 'social.conversation.ensure', companionId: 'a', memberIds: ['a', 'b'] }).socialConversation!;
  const invite = { type: 'social.send' as const, companionId: 'a', conversationId: pair.id, authorizationMessageId: human.id,
    agentSource: { conversationId: human.conversationId, messageId: human.id }, channel: 'phone' as const, clientId: 'actual_delegated_invite', content: '你愿意的话请建群开展这次共同讨论。' };
  let invited = store.request(invite);
  for (let n = 0; !invited.socialMessage && n < 80; n++) { advance(); invited = store.request(invite); }
  const sent = invited.socialMessage!.message; advance();
  let job;
  for (let n = 0; n < 80; n++) { advance(); const claimed = store.request({ type: 'social.job.claim' }).socialJob;
    if (claimed?.companionId === 'b' && claimed.sourceMessageId === sent.id) { job = claimed; break; }
    if (claimed) { advance(); store.request({ type: 'social.job.complete', id: claimed.id, leaseToken: claimed.leaseToken!, text: null }); } }
  if (!job) throw new Error('Expected the actual delegated peer job');
  const peerScope = { companionId: 'b', conversationId: pair.id, sourceMessageId: sent.id };
  const create = { type: 'world.tool' as const, ...peerScope, clientId: 'peer_real_group', arguments: { action: 'create_group' as const,
    recipientIds: ['a', 'c'], title: '伙伴实际创建', text: '我愿意开展讨论，请各自加入。', topic: { title: '同一原目标讨论', kind: 'game' as const } } };
  let created = store.request(create);
  for (let n = 0; !created.socialMessage && n < 80; n++) { advance(); created = store.request(create); }
  expect(created.socialMessage?.message.authorId).toBe('b');
  const origin = companionSocialDelegatedPortOrigin(db, social, visible, 'b', sent)!;
  expect(origin.companionId).toBe('a');
  return { store, db, visible, social, scope, human, task, advance, originalCreate, created, create, sent, origin, old };
}

it('returns the actual peer-created candidate instead of a second topic, then binds only after the owner really joins', async () => {
  const f = fixture(), { store } = f, topic = f.created.topic!;
  expect(topic.participantIds).toEqual(['b']);
  const offered = store.request(f.originalCreate);
  expect(offered.activityPortCandidate).toMatchObject({ conversationId: topic.conversationId, topicId: topic.id, creatorCompanionId: 'b', requiresJoin: true });
  expect(offered.socialMessage).toBeUndefined(); expect(offered.socialPending).toBe(false);
  expect(store.request({ type: 'topic.list', conversationId: topic.conversationId, readerId: 'a' }).topics?.filter(topic => !topic.isPrimary)).toHaveLength(1);
  expect(store.request({ type: 'activity.port.adopt_candidate', companionId: 'a', conversationId: topic.conversationId, topicId: topic.id }).activityTask).toBeUndefined();
  store.request({ type: 'topic.update', conversationId: topic.conversationId, topicId: topic.id, readerId: 'b', expectedRevision: topic.revision,
    patch: { workingState: { summary: '仅创建者自己可见', state: { privateCanary: 'CREATOR_PRIVATE_REMAINS_PRIVATE' } } } });
  const capabilities = companionTopicCapabilities(async command => store.request(command), f.scope);
  const joined = await capabilities.execute({ id: 'real_owner_join', name: 'world', arguments: JSON.stringify({ action: 'topic',
    parameters: { action: 'join', roomId: topic.conversationId, topicId: topic.id } }) });
  expect(joined).toMatchObject({ activityTask: { id: f.task.id, gamePort: { topicId: topic.id, delegatedCandidateId: offered.activityPortCandidate!.id } } });
  expect(JSON.stringify(joined)).not.toContain('CREATOR_PRIVATE_REMAINS_PRIVATE');
  expect(store.request({ type: 'activity.port.adopt_candidate', companionId: 'c', conversationId: topic.conversationId, topicId: topic.id }).activityTask).toBeUndefined();
  const current = store.request({ type: 'topic.read', conversationId: topic.conversationId, topicId: topic.id, readerId: 'b' }).topic!;
  store.request({ type: 'topic.close', conversationId: topic.conversationId, topicId: topic.id, readerId: 'b', expectedRevision: current.revision });
  expect(findCompanionActivityPortCandidate(f.db, f.social, f.visible, { ...f.scope, sourceMessageId: f.human.id })).toBeUndefined();
  expect(findJoinedCompanionActivityPortCandidate(f.db, f.social, f.visible, { companionId: 'a', conversationId: topic.conversationId, topicId: topic.id }, { includeClosed: true })?.id).toBe(offered.activityPortCandidate!.id);
  expect(store.request({ type: 'activity.get', ...f.scope, id: f.task.id }).activityTask?.historyAvailable).toBe(true);
});

it('keeps an existing live port until explicitly closed and never copies another participant private state', () => {
  const f = fixture(true), old = f.old!.topic!, next = f.created.topic!;
  f.store.request({ type: 'topic.join', conversationId: next.conversationId, topicId: next.id, readerId: 'a' });
  const adopt: CompanionStorageCommand = { type: 'activity.port.adopt_candidate', companionId: 'a', conversationId: next.conversationId, topicId: next.id };
  expect(f.store.request(adopt).activityTask).toBeUndefined();
  expect(f.store.request({ type: 'activity.get', ...f.scope, id: f.task.id }).activityTask?.gamePort?.topicId).toBe(old.id);
  const actualOld = f.store.request({ type: 'topic.read', conversationId: old.conversationId, topicId: old.id, readerId: 'a' }).topic!;
  f.store.request({ type: 'topic.close', conversationId: old.conversationId, topicId: old.id, readerId: 'a', expectedRevision: actualOld.revision });
  expect(f.store.request(adopt).activityTask?.gamePort?.topicId).toBe(next.id);
});

it('preserves two independently valid candidate ports as ambiguous instead of overwriting with the newest', () => {
  const f = fixture(), first = f.created.topic!;
  const second = f.store.request({ type: 'topic.create', conversationId: first.conversationId, readerId: 'b', title: '另一个实际端口', kind: 'game', participantIds: ['a', 'c'] }).topic!;
  f.store.request({ type: 'social.send', companionId: 'b', conversationId: first.conversationId, topicId: second.id, clientId: 'second_real_candidate_send',
    content: '这是另一个实际话题。', channel: 'phone', agentSource: { conversationId: f.sent.conversationId, messageId: f.sent.id } });
  registerCompanionActivityPortCandidate(f.db, f.social, f.visible, { origin: f.origin, creatorCompanionId: 'b', source: f.sent,
    deliveryClientId: 'second_real_candidate_send', conversationId: first.conversationId, topicId: second.id, memberIds: ['a', 'b', 'c'], includePlayer: false });
  expect(findCompanionActivityPortCandidate(f.db, f.social, f.visible, { ...f.scope, sourceMessageId: f.human.id })).toBeUndefined();
  expect(() => f.store.request(f.originalCreate)).toThrow('多个有效候选');
  expect(f.store.request({ type: 'topic.list', conversationId: first.conversationId, readerId: 'a' }).topics?.filter(topic => !topic.isPrimary)).toHaveLength(2);
});

it.each(['root', 'peer'] as const)('does not discover or adopt a candidate after its actual %s source is withdrawn', withdrawn => {
  const f = fixture(), topic = f.created.topic!;
  f.store.request({ type: 'topic.join', conversationId: topic.conversationId, topicId: topic.id, readerId: 'a' });
  f.store.request({ type: 'memory.forget', companionId: withdrawn === 'root' ? 'a' : 'b',
    conversationId: withdrawn === 'root' ? f.human.conversationId : f.sent.conversationId, sourceMessageIds: [withdrawn === 'root' ? f.human.id : f.sent.id] });
  expect(findCompanionActivityPortCandidate(f.db, f.social, f.visible, { ...f.scope, sourceMessageId: f.human.id })).toBeUndefined();
  expect(f.store.request({ type: 'activity.port.adopt_candidate', companionId: 'a', conversationId: topic.conversationId, topicId: topic.id }).activityTask).toBeUndefined();
});
