import { expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { taskContextPolicy } from '../../src/main/companion-bot/task-context-policy';

it('supplies current ended and paused control facts without leaking old goals or other audiences, even after removal', () => {
  const store = new BotStore(':memory:');
  try {
    store.createCompanion({ id: 'policy', name: 'Policy', persona: '测试' });
    const room = store.openDirect('policy'), event = store.enqueue({ conversationId: room.id, senderId: 'user', content: '今天聊点别的', sourceMessageId: 'policy-source' }).events[0]!;
    for (const [id, status] of [['old-work', 'cancelled'], ['paused-work', 'paused'], ['active-work', 'running']] as const) {
      store.createTask({ id, conversationId: room.id, companionId: 'policy', sourceEventId: event.id, goal: 'PRIVATE_OLD_GOAL' });
      store.updateTask(id, { status });
    }
    const old = store.getTask('old-work')!; store.updateTask(old.id, { extra: { ...old.extra, removedAt: new Date().toISOString() } });
    const policy = taskContextPolicy(store, event);
    expect(policy).toMatchObject({ authority: 'current-host-state', reminders: 'only-on-request', endedCount: 1, pausedCount: 1, endedTaskIds: ['old-work'], pausedTaskIds: ['paused-work'] });
    expect(JSON.stringify(policy)).not.toContain('PRIVATE_OLD_GOAL');
    const elsewhere = store.createGroup({ title: '其他受众', memberIds: ['policy'] });
    expect(taskContextPolicy(store, { ...event, conversationId: elsewhere.id })).toBeUndefined();
  } finally { store.close(); }
});
