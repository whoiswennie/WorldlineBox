import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';

let store: BotStore;
beforeEach(() => {
  store = new BotStore(':memory:');
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: 'A test companion.' });
});
afterEach(() => { vi.restoreAllMocks(); store.close(); });
const presence = (configured = true) => store.companionPresence(store.listCompanions(), configured);

it('tracks queued and running native chat turns independently for each companion', () => {
  expect(presence().alice).toMatchObject({ status: 'idle', counts: { activeTasks: 0, replying: 0, pendingMessages: 0 } });
  expect(presence(false).bob?.status).toBe('unconfigured');
  const room = store.openDirect('alice');
  store.enqueue({ conversationId: room.id, senderId: 'user', content: 'Hello' });
  expect(presence().alice).toMatchObject({ status: 'waiting', counts: { pendingMessages: 1 } });
  const claim = store.claim({ workerId: 'fixture' })!;
  expect(presence().alice).toMatchObject({ status: 'replying', counts: { replying: 1, pendingMessages: 0 } });
  expect(presence().bob?.status).toBe('idle');
  store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: 'Hello back' });
  expect(presence().alice).toMatchObject({ status: 'idle', counts: { activeTasks: 0, replying: 0 } });
});

it('keeps archived task records from becoming active companion work', () => {
  const room = store.openDirect('alice'), source = store.enqueue({ conversationId: room.id, senderId: 'user', content: 'Historical source', recipientIds: [] });
  store.taskTransaction(sql => sql.prepare('INSERT INTO bot_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('historical-task', room.id, 'alice', 'historical-event', 'PRIVATE_TASK_BODY', 'running', 'old-attempt', null, null, 'PRIVATE_REPORT', null, source.message.createdAt, source.message.createdAt, '{}'));
  expect(presence().alice).toMatchObject({ status: 'idle', counts: { activeTasks: 0, running: 0 } });
  expect(JSON.stringify(presence())).not.toContain('PRIVATE');
  expect(store.taskTransaction(sql => sql.prepare('SELECT status,summary FROM bot_tasks WHERE id=?').get('historical-task'))).toEqual({ status: 'running', summary: 'PRIVATE_REPORT' });
});

it('projects only bounded inbox metadata without loading private message bodies', () => {
  const room = store.openDirect('alice');
  store.enqueue({ conversationId: room.id, senderId: 'user', content: 'PRIVATE_BODY_' + 'x'.repeat(32000) });
  const history = vi.spyOn(store, 'messagesPage').mockImplementation(() => { throw Error('Presence must not load message bodies'); });
  expect(JSON.stringify(presence())).not.toContain('PRIVATE_BODY');
  expect(history).not.toHaveBeenCalled();
  expect(BotStore.prototype.companionPresence.toString()).not.toMatch(/SELECT\s+(?:[A-Za-z_]+\.)?\*/iu);
});
