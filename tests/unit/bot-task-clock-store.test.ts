import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';

const owners: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of owners.splice(0).reverse()) await close(); });
function fixture(filename = ':memory:') {
  const store = new BotStore(filename); owners.push(() => store.close());
  store.createCompanion({ id: 'clock', name: 'Clock', persona: 'Task timing fixture.' });
  const room = store.openDirect('clock');
  const source = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'timing-source', content: 'Run only this task.' }).events[0]!;
  const task = store.createTask({ conversationId: room.id, companionId: 'clock', sourceEventId: source.id, goal: 'Task timing.' });
  return { store, room, task, runtime: new BotTaskRuntime(store) };
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));

it('persists only active slices across a long pause, resumes at zero additional paused time, and freezes late receipts after stop', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); at('2026-11-05T09:00:00Z');
  const f = fixture();
  at('2026-11-05T10:00:00Z'); let task = f.store.updateTask(f.task.id, { status: 'running' });
  expect(task.extra.elapsedMs).toBe(0); expect(task.extra.timerStartedAt).toBe('2026-11-05T10:00:00.000Z');
  at('2026-11-05T10:01:00Z'); task = f.store.updateTask(task.id, { extra: { ...task.extra, pauseRequested: true, pauseRequestedAt: new Date().toISOString() } });
  expect(task.status).toBe('paused'); expect(task.extra.elapsedMs).toBe(60000); expect(task.extra.timerStartedAt).toBeUndefined();
  at('2026-11-06T10:01:00Z');
  task = f.store.updateTask(task.id, { extra: { ...task.extra, sessionId: 'late-native-receipt' } });
  expect(task.extra.elapsedMs).toBe(60000);
  task = f.store.updateTask(task.id, { status: 'queued', extra: { ...task.extra, pausedAt: undefined, pauseRequestedAt: undefined } });
  expect(task.extra.elapsedMs).toBe(60000); expect(task.extra.timerStartedAt).toBeUndefined();
  at('2026-11-06T10:01:20Z'); task = f.store.updateTask(task.id, { status: 'running' });
  at('2026-11-06T10:01:30Z'); task = f.store.updateTask(task.id, { extra: { ...task.extra, cancelRequested: true, cancelRequestedAt: new Date().toISOString() } });
  expect(task.status).toBe('cancelled'); expect(task.extra.elapsedMs).toBe(70000); expect(task.extra.timerStartedAt).toBeUndefined();
  at('2026-11-07T11:00:00Z'); task = f.store.updateTask(task.id, { summary: 'A late native cleanup result.' });
  expect(task.extra.elapsedMs).toBe(70000);
  const card = f.runtime.card(task);
  const listed = f.store.listTaskCatalog({ conversationId: f.room.id, view: 'directory', filter: 'done' }).map(value => f.runtime.card(value, false));
  expect(card.elapsedMs).toBe(70000); expect(listed[0]?.elapsedMs).toBe(70000);
  expect(f.runtime.page({ conversationId: f.room.id, filter: 'active', page: 0, limit: 6 }).activeCount).toBe(0);
  expect(() => f.store.updateTask(task.id, { status: 'running' })).toThrow('任务已结束');
});

it.each(['stop-unconfirmed', 'stopping', 'pause-unconfirmed'] as const)('normalizes a legacy %s task on restart using the original request time', async phase => {
  vi.useFakeTimers({ toFake: ['Date'] }); at('2026-11-05T09:00:00Z');
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-task-clock-'));
  owners.push(async () => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-task-clock-')) throw Error('Invalid timing fixture root'); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const filename = path.join(root, 'bot.sqlite'), f = fixture(filename);
  const paused = phase.startsWith('pause');
  f.store.taskTransaction(sql => sql.prepare('UPDATE bot_tasks SET status=?,updated_at=?,extra_json=? WHERE id=?').run('waiting', '2026-11-06T07:00:00.000Z',
    JSON.stringify({ presenceStartedAt: '2026-11-05T09:00:00.000Z', nativeAttempted: true,
      ...(phase === 'stop-unconfirmed' ? { cancelRequested: true, cancelRequestedAt: '2026-11-05T09:02:00.000Z' } : {}),
      progress: { phase, updatedAt: '2026-11-05T09:02:00.000Z' } }), f.task.id));
  f.store.close(); owners.pop();
  at('2026-11-06T10:00:00Z'); const reopened = new BotStore(filename); owners.push(() => reopened.close());
  const task = reopened.getTask(f.task.id)!;
  expect(task.status).toBe(paused ? 'paused' : 'cancelled');
  expect(task.extra.elapsedMs).toBe(120000); expect(task.extra.timerStartedAt).toBeUndefined();
  expect(task.extra.executorControl).toMatchObject({ kind: paused ? 'pause' : 'cancel', state: 'pending' });
  expect(reopened.pendingTasks()).toEqual([]);
  at('2026-11-07T10:00:00Z'); expect(new BotTaskRuntime(reopened).card(task).elapsedMs).toBe(120000);
});

it('does not include queued, waiting, unknown or application-off intervals in execution time', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); at('2026-11-05T09:00:00Z');
  const f = fixture(); let task = f.store.updateTask(f.task.id, { status: 'running' });
  at('2026-11-05T09:00:10Z'); task = f.store.updateTask(task.id, { status: 'waiting' });
  expect(task.extra.elapsedMs).toBe(10000); expect(task.extra.timerStartedAt).toBeUndefined();
  at('2026-11-05T12:00:00Z'); task = f.store.updateTask(task.id, { status: 'queued' });
  expect(task.extra.elapsedMs).toBe(10000); expect(task.extra.timerStartedAt).toBeUndefined();
  at('2026-11-05T13:00:00Z'); task = f.store.updateTask(task.id, { status: 'running' });
  at('2026-11-05T13:00:20Z'); task = f.store.updateTask(task.id, { status: 'unknown' });
  expect(task.extra.elapsedMs).toBe(30000); expect(task.extra.timerStartedAt).toBeUndefined();
  at('2026-11-05T14:00:00Z'); task = f.store.updateTask(task.id, { status: 'running' });
  at('2026-11-05T14:00:05Z'); f.store.suspendTaskTimers();
  expect(f.store.getTask(task.id)!.extra.elapsedMs).toBe(35000);
  at('2026-11-06T14:00:00Z'); task = f.store.updateTask(task.id, { summary: 'Reconnect preparation only.' });
  expect(task.extra.elapsedMs).toBe(35000); expect(task.extra.timerStartedAt).toBeUndefined();
});

it('caps an interrupted running slice at the last durable observation after a crash restart', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); at('2026-11-05T09:00:00Z');
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-task-clock-'));
  owners.push(async () => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-task-clock-')) throw Error('Invalid timing fixture root'); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const filename = path.join(root, 'bot.sqlite'), f = fixture(filename);
  let task = f.store.updateTask(f.task.id, { status: 'running' });
  at('2026-11-05T09:00:15Z'); task = f.store.updateTask(task.id, { summary: 'Last real worker observation.' });
  f.store.close(); owners.pop();
  at('2026-11-06T09:00:00Z'); const reopened = new BotStore(filename); owners.push(() => reopened.close());
  task = reopened.getTask(task.id)!;
  expect(task.status).toBe('running'); expect(task.extra.elapsedMs).toBe(15000); expect(task.extra.timerStartedAt).toBeUndefined();
  at('2026-11-06T10:00:00Z'); task = reopened.updateTask(task.id, { status: 'running' });
  at('2026-11-06T10:00:05Z'); task = reopened.updateTask(task.id, { status: 'paused' });
  expect(task.extra.elapsedMs).toBe(20000);
});
