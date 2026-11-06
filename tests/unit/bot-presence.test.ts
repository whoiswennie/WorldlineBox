import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import type { BotConversation } from '../../src/main/companion-bot/types';

let store: BotStore, next = 0;
beforeEach(() => {
  store = new BotStore(':memory:', { activityBudget: { maxTasks: 1000, maxPendingTasks: 1000 } });
  store.createCompanion({ id: 'alice', name: 'Alice', persona: '核对事实。' });
  store.createCompanion({ id: 'bob', name: 'Bob', persona: '简明交流。' });
  next = 0;
});
afterEach(() => { vi.restoreAllMocks(); store.close(); });
const companions = () => ['alice', 'bob'].map(id => ({ id, updatedAt: store.getCompanion(id)!.updatedAt }));
const presence = (configured = true, now?: number) => store.companionPresence(companions(), configured, now);
function task(room: BotConversation, title = '整理资料', owner = 'alice', extra: Record<string, unknown> = {}) {
  const source = store.enqueue({ conversationId: room.id, senderId: room.memberIds.includes('user') ? 'user' : 'world-service',
    source: room.memberIds.includes('user') ? 'user' : 'world', recipientIds: [owner], senderName: '隔离世界', sourceMessageId: `presence-source-${++next}`, content: '本次测试任务。' }).events[0]!;
  const claim = store.claim({ workerId: 'presence-test' });
  if (!claim || claim.event.id !== source.id || !store.settle({ eventId: source.id, leaseToken: claim.leaseToken, status: 'done', content: '来源已处理。' })) throw Error('Could not settle the real presence source.');
  return store.createTask({ id: `presence-task-${next}`, conversationId: room.id, companionId: owner, sourceEventId: source.id, goal: '本次测试任务。', extra: { title, ...extra } });
}

it('aggregates active tasks and simultaneous brain replies across user-visible rooms without calling another Host or mislabeling busy companions as offline', () => {
  const direct = store.openDirect('alice'), group = store.createGroup({ title: '另一个项目', memberIds: ['alice', 'bob'] });
  const one = task(direct, '整理附件'), two = task(group, '查询天气');
  store.updateTask(one.id, { status: 'running', extra: { title: '整理附件', progress: { phase: 'executing-tool', toolName: 'read' } } });
  store.updateTask(two.id, { status: 'running', extra: { title: '查询天气', progress: { phase: 'executing-tool', toolName: 'search' } } });
  store.enqueue({ conversationId: direct.id, senderId: 'user', recipientIds: ['alice'], sourceMessageId: 'reply-in-progress', content: '同时聊一下。' });
  expect(store.claim({ workerId: 'replying' })).toBeDefined();
  store.enqueue({ conversationId: group.id, senderId: 'user', recipientIds: ['alice'], sourceMessageId: 'queued-message', content: '另一个来源的消息。' });
  const current = presence(false);
  expect(current.alice).toMatchObject({ status: 'replying', counts: { activeTasks: 2, queued: 0, running: 2, waiting: 0, stopping: 0, blocked: 0, replying: 1, pendingMessages: 1 } });
  expect([direct.id, group.id]).toContain(current.alice!.activity!.conversationId);
  expect(store.getConversation(current.alice!.activity!.conversationId)!.memberIds).toContain('user');
  expect(current.bob).toMatchObject({ status: 'unconfigured', counts: { activeTasks: 0, replying: 0, pendingMessages: 0 } });
});

it('keeps queued work visible when the model setting is unavailable and removes stopped work from active presence immediately', () => {
  const room = store.openDirect('alice'), current = task(room);
  expect(presence(false).alice).toMatchObject({ status: 'working', counts: { activeTasks: 1, queued: 1 } });
  store.updateTask(current.id, { status: 'waiting', extra: { title: '用户问题', progress: { phase: 'waiting' } } });
  expect(presence(false).alice).toMatchObject({ status: 'waiting', counts: { activeTasks: 1, waiting: 1 } });
  store.updateTask(current.id, { status: 'queued', extra: { title: '停止中的任务', cancelRequested: true, cancelRequestedAt: new Date().toISOString(), progress: { phase: 'stopping' } } });
  expect(store.getTask(current.id)?.status).toBe('cancelled');
  expect(() => store.updateTask(current.id, { status: 'waiting' })).toThrow('任务已结束');
  expect(presence(false).alice).toMatchObject({ status: 'unconfigured', counts: { activeTasks: 0, stopping: 0, blocked: 0 } });
  expect(presence(true).alice!.status).toBe('idle');
});

it('uses stable real transition events, does not repeat notices for progress-only updates and caps recent history at eight', () => {
  const room = store.openDirect('alice'), first = task(room, '首个任务');
  store.updateTask(first.id, { status: 'running' });
  const started = presence().alice!.lastEvent!;
  expect(started).toMatchObject({ kind: 'task-started', taskId: first.id, title: '首个任务', status: 'running' });
  store.updateTask(first.id, { status: 'running', extra: { ...store.getTask(first.id)!.extra, progress: { phase: 'executing-tool', toolName: 'read' } } });
  expect(presence().alice!.lastEvent!.id).toBe(started.id);
  expect(presence().alice!.events).toHaveLength(1);
  store.updateTask(first.id, { status: 'succeeded', summary: '真实完成。' });
  const completed = presence().alice!.lastEvent!;
  expect(completed).toMatchObject({ kind: 'task-completed', taskId: first.id, status: 'succeeded' });
  store.updateTask(first.id, { status: 'succeeded', summary: '只是保存补充摘要。' });
  expect(presence().alice!.lastEvent!.id).toBe(completed.id);
  for (let index = 0; index < 5; index++) { const current = task(room, `后续任务${index}`); store.updateTask(current.id, { status: 'running' }); store.updateTask(current.id, { status: 'succeeded' }); }
  const recent = presence().alice!.events!;
  expect(recent).toHaveLength(8); expect(new Set(recent.map(event => event.id)).size).toBe(8);
  expect(recent.every(event => Number.isSafeInteger(event.sequence) && event.sequence > 0)).toBe(true);
  expect(recent.every((event, index) => index === 0 || event.sequence < recent[index - 1]!.sequence)).toBe(true);
  expect(recent[0]!.taskId).toBe(`presence-task-${next}`);
  expect(recent.map(event => event.id)).toEqual(presence().alice!.events!.map(event => event.id));
});

it('uses a durable monotonic sequence to distinguish same-millisecond new events from older history filling the recent window', () => {
  const room = store.openDirect('alice'), first = task(room, '同毫秒旧记录'), next = task(room, '同毫秒新记录');
  store.updateTask(first.id, { status: 'running' }); store.updateTask(first.id, { status: 'succeeded' });
  const prior = presence().alice!.lastEvent!;
  store.updateTask(next.id, { status: 'running' }); store.updateTask(next.id, { status: 'succeeded' });
  const stamp = '2026-11-04T00:00:00.000Z';
  store.taskTransaction(sql => sql.prepare('UPDATE bot_task_presence_events SET occurred_at=?').run(stamp));
  const current = presence().alice!.events!;
  expect(current.every(event => event.occurredAt === stamp)).toBe(true);
  expect(current.filter(event => event.sequence > prior.sequence).map(event => event.taskId)).toEqual([next.id, next.id]);
  const highWatermark = current[0]!.sequence;
  store.taskTransaction(sql => sql.prepare('DELETE FROM bot_task_presence_events WHERE task_id=?').run(next.id));
  const refilled = presence().alice!.events!;
  expect(refilled.map(event => event.taskId)).toEqual([first.id, first.id]);
  expect(refilled.filter(event => event.sequence > highWatermark)).toEqual([]);
});

it('counts paused work immediately and never treats native cleanup as active or blocked work', () => {
  const room = store.openDirect('alice'), current = task(room);
  store.updateTask(current.id, { status: 'paused', extra: { title: '暂停的任务', userPaused: true, progress: { phase: 'paused' } } });
  expect(presence().alice).toMatchObject({ status: 'waiting', counts: { activeTasks: 1, paused: 1, running: 0, blocked: 0 } });
  store.updateTask(current.id, { extra: { title: '请求停止', cancelRequested: true, progress: { phase: 'stopping' } } });
  expect(presence().alice).toMatchObject({ status: 'idle', counts: { activeTasks: 0, paused: 0, stopping: 0, blocked: 0 } });
  const another = task(room);
  store.updateTask(another.id, { extra: { title: '暂停任务', pauseRequested: true, pauseRecoveryPaused: true, progress: { phase: 'pause-unconfirmed' } } });
  expect(presence().alice).toMatchObject({ status: 'waiting', counts: { activeTasks: 1, paused: 1, blocked: 0 } });
});

it('expires a recent failure after ten minutes and never turns historical failed rows into a permanent red presence', () => {
  const room = store.openDirect('alice'), legacy = task(room, '旧任务');
  // A real pre-feature historical terminal row has no invented transition.
  store.taskTransaction(sql => sql.prepare("UPDATE bot_tasks SET status='failed',updated_at=? WHERE id=?").run('2020-01-01T00:00:00.000Z', legacy.id));
  expect(presence().alice).toMatchObject({ status: 'idle', counts: { activeTasks: 0 } });
  expect(presence().alice!.lastEvent).toBeUndefined();
  const recent = task(room, '刚失败的任务'); store.updateTask(recent.id, { status: 'failed', error: '隔离执行错误。' });
  const event = presence().alice!.lastEvent!, time = Date.parse(event.occurredAt);
  expect(presence(true, time + 599999).alice).toMatchObject({ status: 'error', expiresAt: new Date(time + 600000).toISOString() });
  expect(presence(true, time + 600001).alice).toMatchObject({ status: 'idle', lastEvent: { id: event.id } });
  expect(presence(true, time + 600001).alice!.expiresAt).toBeUndefined();
});

it('exposes only coarse activity for private world lanes while visible tasks remain navigable from another chat', () => {
  const visible = store.createGroup({ title: '用户可看的群', memberIds: ['alice', 'bob'] });
  const hidden = store.createGroup({ title: 'PRIVATE_WORLD_TITLE', kind: 'world', memberIds: ['alice', 'bob'], includeUser: false });
  const secret = task(hidden, 'PRIVATE_WORLD_TASK'); store.updateTask(secret.id, { status: 'running' });
  const privateOnly = presence().alice!;
  expect(privateOnly).toMatchObject({ status: 'working', counts: { activeTasks: 1, running: 1 } });
  expect(privateOnly.activity).toBeUndefined(); expect(privateOnly.lastEvent).toBeUndefined();
  const publicTask = task(visible, '用户可看的执行任务'); store.updateTask(publicTask.id, { status: 'running' });
  const projection = presence().alice!;
  expect(projection.activity).toMatchObject({ taskId: publicTask.id, conversationId: visible.id, title: '用户可看的执行任务' });
  expect(projection.events!.every(event => event.conversationId === visible.id)).toBe(true);
  expect(JSON.stringify(projection)).not.toMatch(/PRIVATE_WORLD|隔离世界/);
});

it('projects bounded SQL metadata without loading full task reports, frozen worker prompts or message bodies into JavaScript', () => {
  const room = store.openDirect('alice'), privateText = 'NEVER_INCLUDE_PRIVATE_REPORT_' + 'x'.repeat(1024 * 1024);
  const current = task(room, '简短任务标题', 'alice', { workerPrompt: privateText });
  store.updateTask(current.id, { status: 'running', summary: privateText });
  const get = vi.spyOn(store, 'getTask').mockImplementation(() => { throw Error('Full task read during presence projection.'); });
  const list = vi.spyOn(store, 'listTasks').mockImplementation(() => { throw Error('Full task scan during presence projection.'); });
  const history = vi.spyOn(store, 'messagesPage').mockImplementation(() => { throw Error('Message bodies must not load during presence projection.'); });
  const metadata = companions(), result = store.companionPresence(metadata, true);
  expect(result.alice).toMatchObject({ status: 'working', activity: { title: '简短任务标题' } });
  expect(JSON.stringify(result).length).toBeLessThan(5000); expect(JSON.stringify(result)).not.toContain('NEVER_INCLUDE');
  expect(get).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled();
  // This query-policy assertion catches future broad row projections even
  // when fixture reports happen to be small; COUNT(*) remains allowed.
  expect(BotStore.prototype.companionPresence.toString()).not.toMatch(/SELECT\s+(?:[A-Za-z_]+\.)?\*/iu);
});
