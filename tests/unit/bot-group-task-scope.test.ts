import { afterEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { clearBotTaskHistory } from '../../src/main/companion-bot/task-history';
import { botRequestSchema } from '../../src/shared/companion-bot';

const owned: BotStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of owned.splice(0)) store.close(); });
function fixture() {
  const store = new BotStore(':memory:', { activityBudget: { maxTasks: 200, maxPendingTasks: 200 } }); owned.push(store);
  store.createCompanion({ id: 'a', name: '大肥鱼', persona: 'PRIVATE_PERSONA_A' }); store.createCompanion({ id: 'b', name: 'GPT', persona: 'PRIVATE_PERSONA_B' });
  const group = store.createGroup({ title: '共同任务', memberIds: ['a', 'b'] }), privateRoom = store.openDirect('a');
  const create = (conversationId: string, companionId: string, prefix: string, count: number) => {
    for (let index = 0; index < count; index++) {
      const id = `${prefix}-${index}`, source = store.enqueue({ conversationId, source: 'user', senderId: 'user', recipientIds: [companionId], sourceMessageId: id, content: 'Human-authored isolated task scope fixture.' }).events[0]!;
      store.cancelEvent(source.id);
      store.createTask({ id, conversationId, companionId, sourceEventId: source.id, goal: `${id} ORIGINAL_TAIL`, extra: { title: id, retryAt: Date.now() + 86400000 } });
      if (index >= 5) store.updateTask(id, { status: 'succeeded', summary: 'REPORT'.repeat(10000) });
    }
  };
  create(group.id, 'a', 'group-a', 8); create(group.id, 'b', 'group-b', 8); create(privateRoom.id, 'a', 'PRIVATE_ROOM', 6);
  return { store, group, privateRoom, runtime: new BotTaskRuntime(store) };
}

it('applies owner plus conversation to real SQL items, filtered totals, pages and operation counts', () => {
  const f = fixture(), input = { conversationId: f.group.id, companionId: 'a', filter: 'all' as const, page: 0, limit: 6 };
  const page = f.runtime.page(input);
  expect(page).toMatchObject({ total: 8, activeCount: 5, queuedCount: 5, finishedCount: 3, page: 0 }); expect(page.items).toHaveLength(6);
  expect(page.items.every(task => task.conversationId === f.group.id && task.companionId === 'a' && task.companionName === '大肥鱼')).toBe(true);
  const next = f.runtime.page({ ...input, page: 1 }); expect(next.items).toHaveLength(2); expect(new Set([...page.items, ...next.items].map(task => task.id)).size).toBe(8);
  expect(f.runtime.page({ ...input, page: 999 })).toMatchObject({ page: 1, total: 8 });
  const query = f.runtime.page({ ...input, query: 'group-a-7' }); expect(query).toMatchObject({ total: 1, activeCount: 5, queuedCount: 5, finishedCount: 3 }); expect(query.items[0]?.id).toBe('group-a-7');
  expect(f.runtime.page({ ...input, filter: 'done' })).toMatchObject({ total: 3, activeCount: 5, queuedCount: 5, finishedCount: 3 });
  expect(f.runtime.page({ ...input, companionId: 'b' }).items.every(task => task.companionName === 'GPT')).toBe(true);
  expect(JSON.stringify(f.runtime.page({ ...input, query: 'PRIVATE_ROOM' }))).not.toContain('PRIVATE_ROOM');
  expect(f.runtime.page({ ...input, companionId: 'absent' })).toMatchObject({ total: 0, activeCount: 0, queuedCount: 0, finishedCount: 0, items: [] });
});

it('projects names without loading personas and limits finished removal to one owner in one group', async () => {
  const f = fixture(), persona = vi.spyOn(f.store, 'getCompanion').mockImplementation(() => { throw Error('Catalog loaded full persona'); });
  const input = { conversationId: f.group.id, companionId: 'a', filter: 'all' as const, page: 0, limit: 30 };
  expect(f.runtime.page(input).items.map(task => task.companionName)).toEqual(Array(8).fill('大肥鱼')); expect(persona).not.toHaveBeenCalled();
  expect(await clearBotTaskHistory(f.store, { conversationId: f.group.id, companionId: 'a', requestId: 'owner-clear' })).toEqual({ cleared: 3, remaining: 5, recordsOnly: true });
  expect(f.runtime.page(input)).toMatchObject({ total: 5, finishedCount: 0 });
  expect(f.runtime.page({ ...input, companionId: 'b' })).toMatchObject({ total: 8, finishedCount: 3 });
  expect(f.runtime.page({ ...input, conversationId: f.privateRoom.id })).toMatchObject({ total: 6, finishedCount: 1 });
  await expect(clearBotTaskHistory(f.store, { conversationId: f.group.id, companionId: 'b', requestId: 'owner-clear' })).rejects.toThrow('不同范围');
  expect(f.store.getTask('PRIVATE_ROOM-5')?.summary).toBeTruthy();
});

it('validates owner filters on public list and bulk protocols without accepting a foreign conversation alias', () => {
  expect(botRequestSchema.parse({ type: 'task.list', conversationId: 'group', companionId: 'a' })).toMatchObject({ companionId: 'a', page: 0, limit: 6 });
  expect(botRequestSchema.parse({ type: 'task.queue.control', conversationId: 'group', companionId: 'a', operation: 'cancel_queued', requestId: 'one' })).toHaveProperty('companionId', 'a');
  expect(botRequestSchema.safeParse({ type: 'task.list', conversationId: 'group', companionId: '', otherConversationId: 'private' }).success).toBe(false);
});
