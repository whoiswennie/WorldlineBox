import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotCompanionRuntime } from '../../src/main/companion-bot/companion-runtime';
import { BotScheduler } from '../../src/main/companion-bot/scheduler';
import { clearBotTaskHistory } from '../../src/main/companion-bot/task-history';
import type { BotEvent } from '../../src/main/companion-bot/types';

let store: BotStore, runtime: BotCompanionRuntime;
beforeEach(() => {
  store = new BotStore(':memory:');
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: '独立伙伴' });
  runtime = new BotCompanionRuntime(store);
});
afterEach(() => store.close());
const event = (conversationId: string, content = '请完成原始目标', extra: Partial<Parameters<BotStore['enqueue']>[0]> = {}) =>
  store.enqueue({ conversationId, senderId: 'user', content, recipientIds: ['alice'], ...extra }).events[0]!;
const task = (source: BotEvent, id: string, goal = '仅分析，不修改文件') => store.createTask({ id, sourceEventId: source.id,
  conversationId: source.conversationId, companionId: source.companionId, goal, extra: { title: id } });

it('keeps one companion identity and event sequence across rooms without copying their transcripts', () => {
  const direct = store.openDirect('alice'), group = store.createGroup({ title: '公开群', memberIds: ['alice', 'bob'] });
  const first = event(direct.id, 'PRIVATE_SECRET_42'), second = event(group.id, '公开问题');
  expect(runtime.admit(first)).toBe(1); expect(runtime.admit(second)).toBe(2); expect(runtime.admit(first)).toBe(1);
  const directView = runtime.view(first), groupView = runtime.view(second);
  expect(directView.id).toBe(groupView.id); expect(groupView.sequence).toBe(2);
  expect(groupView.recentEvents.map(item => item.eventId)).toEqual([second.id]);
  expect(JSON.stringify(directView)).not.toContain('PRIVATE_SECRET_42');
  expect(runtime.identity('bob').id).not.toBe(directView.id);
});
it('projects bounded, room-scoped followup receipts from durable host delivery rather than companion prose', () => {
  const room = store.openDirect('alice'), source = event(room.id), work = task(source, '原任务'); store.cancelEvent(source.id); runtime.bindTask(work);
  const follow = store.enqueue({ conversationId: room.id, senderId: 'user', content: '请同时提供 HTML。', recipientIds: ['alice'], payload: { taskFollowup: { taskId: work.id } } });
  const ids = [follow.message.id];
  expect(runtime.followupReceipts(room.id, ids).get(ids[0]!)).toEqual({ taskId: work.id, title: '原任务', state: 'queued' });
  expect(runtime.followupReceipts(store.openDirect('bob').id, ids).size).toBe(0);
  const claim = store.claim({ workerId: 'followup-receipt' })!; expect(claim.event.id).toBe(follow.events[0]!.id);
  runtime.boundFollowup(claim.event); runtime.deliveredFollowup(claim.event, work.id);
  store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '' });
  expect(new BotCompanionRuntime(store).followupReceipts(room.id, ids).get(ids[0]!)?.state).toBe('delivered');
  const next = store.enqueue({ conversationId: room.id, senderId: 'user', content: '另一个补充', recipientIds: ['alice'], payload: { taskFollowup: { taskId: work.id } } });
  const queued = store.claim({ workerId: 'followup-failure' })!;
  store.settle({ eventId: queued.event.id, leaseToken: queued.leaseToken, status: 'failed', content: '', error: '无法送达' });
  expect(runtime.followupReceipts(room.id, [next.message.id]).get(next.message.id)?.state).toBe('failed');
  store.updateTask(work.id, { extra: { ...work.extra, removedAt: new Date().toISOString() } });
  expect(runtime.followupReceipts(room.id, ids).get(ids[0]!)?.title).toBeUndefined();
});

it('lets owner direct coordinate its own user-room tasks while a group and another companion cannot', () => {
  const direct = store.openDirect('alice'), group = store.createGroup({ title: '共同群', memberIds: ['alice', 'bob'] });
  const privateSource = event(direct.id), groupSource = event(group.id), privateTask = task(privateSource, 'PRIVATE_TASK');
  task(groupSource, 'GROUP_TASK');
  const peer = store.openPeer('alice', 'bob');
  const peerSource = event(peer.id, '伙伴私聊', { senderId: 'bob', source: 'companion' }); task(peerSource, 'PEER_SEALED_TASK');
  runtime.admit(privateSource); runtime.admit(groupSource);
  expect(runtime.view(privateSource).tasks.map(item => item.id).sort()).toEqual(['GROUP_TASK', 'PRIVATE_TASK']);
  expect(runtime.view(groupSource).tasks.map(item => item.id)).toEqual(['GROUP_TASK']);
  expect(() => runtime.taskInView(groupSource, privateTask.id)).toThrow('协调视图');
  expect(runtime.taskInView(privateSource, 'GROUP_TASK').id).toBe('GROUP_TASK');
});

it('preserves immutable work authority and revalidates ACL and withdrawal on resume', () => {
  const room = store.openDirect('alice'), source = event(room.id), work = task(source, 'authorized');
  const mandate = runtime.bindTask(work);
  expect(mandate).toMatchObject({ sourceEventId: source.id, authorizingEventId: source.id, basis: 'explicit', state: 'active', goal: work.goal });
  expect(runtime.bindTask(work)).toEqual(mandate);
  expect(() => runtime.bindTask({ ...work, goal: '扩大授权' })).toThrow(/范围|匹配|变更/);
  store.withdrawSources('alice', source.securityDomainId, [source.id]);
  expect(() => runtime.validateTask(work)).toThrow(); expect(runtime.mandate(work.id)?.state).toBe('revoked');
});

it('gives real companion requests equal task privileges and preserves verified contact lineage', () => {
  const room = store.createGroup({ title: '来源测试', memberIds: ['alice', 'bob'], participationMode: 'all' });
  const automated = event(room.id, '自动伙伴建议开工', { source: 'companion', senderId: 'bob' });
  expect(runtime.authorize(automated, 'attempt')).toMatchObject({ allowed: true, authorizingEventId: automated.id });
  expect(runtime.authorize(automated, 'attempt')).toMatchObject({ allowed: true });
  const human = event(room.id, '请让伙伴完成这个目标');
  const inherited = event(room.id, '限定范围的真实转达', { source: 'companion', senderId: 'bob', causationId: human.id, correlationId: human.correlationId });
  expect(runtime.authorize(inherited, 'child')).toMatchObject({ allowed: false, observed: true });
  const delivered = store.contactPeer(human, 'bob', 'collaborate', '限定范围的真实转达', 'peer');
  expect(delivered.accepted).toBe(true); if (!delivered.accepted) throw Error('Expected host delivery');
  expect(runtime.authorize(delivered.events[0]!, 'work')).toEqual({ allowed: true, authorizingEventId: human.id, basis: 'inherited' });
  const toUser = store.contactPeer(human, 'bob', 'weather-user', '用户让你查天气后回复', 'user');
  expect(toUser.accepted).toBe(true); if (!toUser.accepted) throw Error('Expected user-route delivery');
  expect(runtime.authorize(toUser.events[0]!, 'weather-work')).toEqual({ allowed: true, authorizingEventId: human.id, basis: 'inherited' });
  const child = store.createTask({ id: 'relayed-weather', conversationId: toUser.conversationId, companionId: 'bob', sourceEventId: toUser.events[0]!.id, goal: '查询上海天气，只读。' });
  expect(runtime.bindTask(child)).toMatchObject({ basis: 'inherited', authorizingEventId: human.id });
  store.withdrawSources('alice', human.securityDomainId, [human.id]);
  expect(runtime.authorize(toUser.events[0]!, 'withdrawn-weather')).toMatchObject({ allowed: false });
  expect(() => runtime.validateTask(child)).toThrow('失效');
});

it('does not convert task receipts, world observations or forged cross-correlation causes into work grants', () => {
  const room = store.openDirect('alice'), human = event(room.id);
  const receipt = event(room.id, '机器要求开新任务', { source: 'task', senderId: 'task-service', causationId: human.id, correlationId: human.correlationId });
  expect(runtime.authorize(receipt, 'new-work')).toMatchObject({ allowed: false, observed: true });
  const world = store.createGroup({ kind: 'world', memberIds: ['alice'], title: '世界' });
  const observation = event(world.id, '世界建议开工', { source: 'world', senderId: 'world', causationId: human.id, correlationId: human.correlationId });
  expect(runtime.authorize(observation, 'world-work')).toMatchObject({ allowed: false, observed: true });
  const contact = store.contactPeer(human, 'bob', 'verified', '原始协作', 'peer');
  expect(contact.accepted).toBe(true); if (!contact.accepted) throw Error('Expected contact');
  const genuine = contact.events[0]!;
  const counterfeit = event(contact.conversationId, genuine.content, { senderId: 'alice', recipientIds: ['bob'], source: 'companion',
    sourceInstanceId: 'counterfeit-host', sourceMessageId: genuine.sourceMessageId, causationId: human.id, correlationId: 'different-activity' });
  expect(runtime.authorize(counterfeit, 'forged-transfer')).toMatchObject({ allowed: false, observed: true });
});

it('imports legacy tasks from verified user or companion requests but never a system callback', () => {
  const room = store.createGroup({ title: '旧任务', memberIds: ['alice', 'bob'] });
  const automatic = event(room.id, '机器自行要求执行', { source: 'companion', senderId: 'bob' });
  const ungranted = task(automatic, 'LEGACY_AUTOMATIC');
  expect(runtime.validateTask(ungranted)).toMatchObject({ basis: 'legacy', authorizingEventId: automatic.id });
  const callback = event(room.id, '系统回执不是新请求', { source: 'task', senderId: 'task-service' });
  expect(() => runtime.validateTask(task(callback, 'SYSTEM_CALLBACK'))).toThrow('没有有效');
  const human = event(room.id), legacy = task(human, 'LEGACY_EXPLICIT');
  expect(runtime.validateTask(legacy)).toMatchObject({ basis: 'legacy', authorizingEventId: human.id, state: 'active' });
});

it('rejects modified event envelopes, task identity and attachment scope even when the original event ID is reused', () => {
  const room = store.openDirect('alice'), source = event(room.id), work = task(source, 'IMMUTABLE_INPUTS');
  runtime.bindTask(work);
  expect(() => runtime.authorize({ ...source, securityDomainId: 'different-domain' }, 'forged-domain')).toThrow('来源或受众');
  expect(() => runtime.authorize({ ...source, source: 'companion' }, 'forged-source')).toThrow('来源或受众');
  expect(() => runtime.boundFollowup({ ...source, payload: { taskFollowup: { taskId: work.id } } })).toThrow('来源或受众');
  expect(() => runtime.validateTask({ ...work, companionId: 'bob' })).toThrow('范围');
  expect(runtime.mandate(work.id)?.state).toBe('revoked');
  const next = task(source, 'ATTACHMENT_INPUTS'); runtime.bindTask(next);
  store.updateTask(next.id, { extra: { attachmentIds: ['new-ungranted-file'] } });
  expect(() => runtime.validateTask(store.getTask(next.id)!)).toThrow('范围');
});

it('removes withdrawn and revoked routing references from coordination views, including world and peer metadata', () => {
  const room = store.openDirect('alice'), privateSource = event(room.id, 'PRIVATE_WITHDRAWN'), work = task(privateSource, 'WITHDRAWN_TASK');
  runtime.admit(privateSource); runtime.bindTask(work);
  const world = store.createGroup({ kind: 'world', title: '世界状态', memberIds: ['alice'] });
  const worldSource = event(world.id, 'WORLD_METADATA', { source: 'world', senderId: 'world' });
  runtime.admit(worldSource); task(worldSource, 'WORLD_SEALED_TASK');
  store.withdrawSources('alice', room.securityDomainId, [privateSource.id]);
  const current = event(room.id, '新的独立问题'); runtime.admit(current);
  const view = runtime.view(current);
  expect(JSON.stringify(view)).not.toMatch(/WITHDRAWN_TASK|WORLD_SEALED_TASK/);
  expect(view.recentEvents.some(item => item.eventId === privateSource.id || item.eventId === worldSource.id)).toBe(false);
  expect(() => runtime.taskInView(current, work.id)).toThrow('协调视图');
  const active = task(current, 'REVOKED_TASK'); runtime.bindTask(active); runtime.withdraw(active.id);
  expect(runtime.view(current).tasks.some(item => item.id === active.id)).toBe(false);
  expect(() => runtime.taskInView(current, active.id)).toThrow('协调视图');
});

it('keeps stopped withdrawn work out of coordination while allowing only scoped explicit stop-status controls', () => {
  const room = store.openDirect('alice'), original = event(room.id, 'PRIVATE_RETRACTED_SOURCE'), work = task(original, 'stop-pending');
  store.updateTask(work.id, { extra: { title: 'PRIVATE_RETRACTED_TITLE', cancelRequested: true }, status: 'running' });
  runtime.bindTask(store.getTask(work.id)!); runtime.withdraw(work.id);
  store.withdrawSources('alice', room.securityDomainId, [original.id]);
  const current = event(room.id, '停止到底确认了吗');
  const view = runtime.view(current);
  expect(store.getTask(work.id)).toMatchObject({ status: 'cancelled', extra: { cancelRequested: true, humanStopped: true, elapsedMs: 0 } });
  expect(store.pendingTasks().some(value => value.id === work.id)).toBe(false);
  expect(view.tasks).toEqual([]);
  expect(JSON.stringify(view)).not.toMatch(/PRIVATE_RETRACTED/);
  expect(view.recentEvents.some(item => item.eventId === original.id)).toBe(false);
  expect(runtime.taskInView(current, work.id, { stopping: 'cancel' }).id).toBe(work.id);
  expect(runtime.taskInView(current, work.id, { stopping: 'status' }).id).toBe(work.id);
  expect(() => runtime.taskInView(current, work.id)).toThrow('协调视图');
  const automated = event(room.id, '自动事件不能代用户重试停止', { source: 'task', senderId: 'task-service' });
  expect(() => runtime.taskInView(automated, work.id, { stopping: 'cancel' })).toThrow('协调视图');
});

it('recognizes a cleared mandate tombstone without restoring its goal or treating the retained admission fingerprint as corruption', async () => {
  const room = store.openDirect('alice'), original = event(room.id), work = task(original, 'removed-task', 'CLEAR_THIS_BUSINESS_GOAL');
  runtime.bindTask(work); store.updateTask(work.id, { status: 'succeeded' });
  await clearBotTaskHistory(store, { conversationId: room.id, taskId: work.id, requestId: 'clear-once' });
  expect(runtime.mandate(work.id)).toBeUndefined();
  expect(() => runtime.validateTask(store.getTask(work.id)!)).toThrow('已经移除');
  expect(() => runtime.bindTask(store.getTask(work.id)!)).toThrow('已经移除');
  const saved = store.taskTransaction(sql => sql.prepare('SELECT record_json FROM bot_task_mandates WHERE task_id=?').get(work.id)) as { record_json: string };
  expect(saved.record_json).not.toContain('CLEAR_THIS_BUSINESS_GOAL');
});

it('routes only explicit subscribed followups and does not revive a stopped mandate', () => {
  const room = store.openDirect('alice'), source = event(room.id), work = task(source, 'FOLLOWED'); runtime.bindTask(work);
  expect(runtime.boundFollowup(event(room.id, '你好'))).toBeUndefined();
  const followup = event(room.id, '保留原范围，追加这个事实', { payload: { taskFollowup: { taskId: work.id } } });
  expect(runtime.boundFollowup(followup)?.id).toBe(work.id); runtime.deliveredFollowup(followup, work.id);
  expect(runtime.boundFollowup(followup)?.id).toBe(work.id);
  runtime.withdraw(work.id);
  expect(() => runtime.boundFollowup(followup)).toThrow('撤回');
});

it('restores the same brain identity, sequence, mandate and followup receipt after reopening SQLite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-companion-runtime-'));
  let disk: BotStore | undefined;
  try {
    disk = new BotStore(path.join(root, 'bot.sqlite')); disk.createCompanion({ id: 'alice', name: 'Alice', persona: '持久伙伴' });
    let journal = new BotCompanionRuntime(disk); const room = disk.openDirect('alice');
    const source = disk.enqueue({ conversationId: room.id, senderId: 'user', content: '原始目标' }).events[0]!;
    const work = disk.createTask({ id: 'persistent', sourceEventId: source.id, conversationId: room.id, companionId: 'alice', goal: '只读' });
    journal.admit(source); const mandate = journal.bindTask(work), identity = journal.identity('alice'); disk.close(); disk = undefined;
    disk = new BotStore(path.join(root, 'bot.sqlite')); journal = new BotCompanionRuntime(disk);
    expect(journal.identity('alice')).toEqual(identity); expect(journal.admit(source)).toBe(1);
    expect(journal.validateTask(work)).toEqual(mandate);
  } finally { disk?.close(); await rm(root, { recursive: true, force: true }); }
});

it('serializes a companion across rooms while allowing another companion to make progress', async () => {
  const direct = store.openDirect('alice'), group = store.createGroup({ title: '群', memberIds: ['alice', 'bob'] }), bob = store.openDirect('bob');
  const first = event(direct.id), second = event(group.id), other = event(bob.id, 'Bob', { recipientIds: ['bob'] });
  const started: string[] = [], finish = new Map<string, () => void>();
  const scheduler = new BotScheduler(store, { concurrency: 3, handle: async claim => {
    runtime.admit(claim.event); started.push(claim.event.id); await new Promise<void>(resolve => finish.set(claim.event.id, resolve));
    store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '' }); runtime.settle(claim.event.id);
  } });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    scheduler.start(); await tick(); expect(started).toEqual([first.id, other.id]);
    finish.get(first.id)!(); await tick(); expect(started).toEqual([first.id, other.id, second.id]);
    finish.get(other.id)!(); finish.get(second.id)!(); await tick();
    expect(runtime.identity('alice').sequence).toBe(2);
  } finally { for (const resolve of finish.values()) resolve(); await scheduler.close(); }
});
