import { mkdtemp, lstat, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { clearBotTaskHistory, resumeBotTaskHistoryClears, botTaskRemovalFingerprint } from '../../src/main/companion-bot/task-history';

const owned: Array<{ store: BotStore; root?: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0)) {
    item.store.close();
    if (item.root) {
      const resolved = path.resolve(item.root);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('wlb-task-clear-') || (await lstat(resolved)).isSymbolicLink() || path.resolve(await realpath(resolved)) !== resolved) throw new Error('Unexpected task clear fixture root');
      await rm(resolved, { recursive: true, force: true });
    }
  }
});
function fixture(filename = ':memory:') {
  const store = new BotStore(filename, { activityBudget: { maxTasks: 200, maxPendingTasks: 200 } }); owned.push({ store });
  store.createCompanion({ id: 'clear-agent', name: '清理夹具', persona: 'Task record lifecycle fixture.' });
  const room = store.openDirect('clear-agent');
  const source = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'clear-source', content: 'Human-authored task record fixture.' }).events[0]!;
  const create = (id: string, terminal = true) => {
    const input = { id, conversationId: room.id, companionId: 'clear-agent', sourceEventId: source.id, goal: '原始任务正文 ' + id,
      extra: { title: '任务 ' + id, workerPrompt: 'SECRET_FROZEN_PROMPT'.repeat(4000), activity: [{ detail: 'large internal activity' }], attachmentIds: [] } };
    const task = store.createTask(input);
    if (terminal) store.updateTask(id, { status: 'succeeded', summary: 'REPORT_CONTENT'.repeat(4000), error: 'OLD_DIAGNOSTIC' });
    return { task, input };
  };
  return { store, room, source, create };
}

it('removes ended task bodies and preserves the admission tombstone and exact replay identity', async () => {
  const f = fixture(), item = f.create('ended');
  expect(await clearBotTaskHistory(f.store, { conversationId: f.room.id, taskId: item.task.id, requestId: 'clear-one' })).toEqual({ cleared: 1, remaining: 0, recordsOnly: true });
  const retained = f.store.getTask(item.task.id)!;
  expect(retained.status).toBe('succeeded'); expect(retained.sourceEventId).toBe(item.task.sourceEventId);
  expect(retained.goal).toBe(''); expect(retained.summary).toBeUndefined(); expect(retained.error).toBeUndefined();
  expect(retained.extra).not.toHaveProperty('workerPrompt'); expect(retained.extra).not.toHaveProperty('activity');
  expect(retained.extra.removedFingerprint).toBe(botTaskRemovalFingerprint({ sourceEventId: item.input.sourceEventId, goal: item.input.goal, ...item.input.extra }));
  expect(f.store.createTask(item.input).extra.removedAt).toBeTruthy();
  expect(() => f.store.createTask({ ...item.input, goal: '不能复用原标识启动另一任务' })).toThrow();
  f.store.updateTask(item.task.id, { status: 'succeeded', summary: '迟到的报告不能恢复已移除正文' });
  expect(f.store.getTask(item.task.id)?.summary).toBeUndefined();
});

it('rejects live and foreign tasks while allowing a stopped task to be cleared', async () => {
  const f = fixture(), live = f.create('live', false);
  await expect(clearBotTaskHistory(f.store, { conversationId: f.room.id, taskId: live.task.id, requestId: 'reject-live' })).rejects.toThrow('尚未结束');
  await expect(clearBotTaskHistory(f.store, { conversationId: f.room.id, taskId: live.task.id, companionId: 'other-agent', requestId: 'reject-owner' })).rejects.toThrow('不属于');
  f.store.updateTask(live.task.id, { status: 'cancelled' });
  expect((await clearBotTaskHistory(f.store, { conversationId: f.room.id, taskId: live.task.id, requestId: 'clear-stopped' })).cleared).toBe(1);
});

it('freezes bulk membership and replays its fixed receipt instead of clearing newly finished work', async () => {
  const f = fixture(); for (let index = 0; index < 40; index++) f.create(`done-${index}`);
  const live = f.create('still-running', false), input = { conversationId: f.room.id, requestId: 'clear-batch' };
  const clearing = clearBotTaskHistory(f.store, input);
  const added = f.create('created-after-clear-start');
  const result = await clearing;
  expect(result).toEqual({ cleared: 40, remaining: 2, recordsOnly: true });
  expect(f.store.getTask(added.task.id)?.extra.removedAt).toBeUndefined();
  expect(f.store.getTask(live.task.id)?.extra.removedAt).toBeUndefined();
  expect(await clearBotTaskHistory(f.store, input)).toEqual(result);
  await expect(clearBotTaskHistory(f.store, { ...input, taskId: added.task.id })).rejects.toThrow('不同范围');
});

it('recovers a committed partial clear after reopening SQLite and never removes an output file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-task-clear-')), filename = path.join(root, 'bot.sqlite');
  const f = fixture(filename); owned.at(-1)!.root = root;
  for (let index = 0; index < 40; index++) f.create(`restart-${index}`);
  const sentinel = path.join(root, 'user-output.txt'); await writeFile(sentinel, 'User-owned output remains.');
  const original = f.store.taskTransaction.bind(f.store); let calls = 0;
  const interrupted = vi.spyOn(f.store, 'taskTransaction').mockImplementation(action => { if (++calls === 3) throw new Error('Simulated shutdown between committed batches'); return original(action); });
  await expect(clearBotTaskHistory(f.store, { conversationId: f.room.id, requestId: 'recover-clear' })).rejects.toThrow('Simulated shutdown');
  interrupted.mockRestore(); f.store.close(); owned.pop();
  const reopened = new BotStore(filename); owned.push({ store: reopened, root });
  await resumeBotTaskHistoryClears(reopened);
  expect(await clearBotTaskHistory(reopened, { conversationId: f.room.id, requestId: 'recover-clear' })).toEqual({ cleared: 40, remaining: 0, recordsOnly: true });
  expect(await readFile(sentinel, 'utf8')).toBe('User-owned output remains.');
  expect(reopened.taskTransaction(sql => sql.prepare('SELECT COUNT(*) AS n FROM bot_task_history_clear_targets').get())).toEqual({ n: 0 });
});
