import { expect, it, vi } from 'vitest';
import { DesktopInbox } from '../../src/main/companion-bot/desktop-inbox';
import { BotStore } from '../../src/main/companion-bot/store';

it('acknowledges the rendered boundary without clearing later messages or another conversation', () => {
  const store = new BotStore(':memory:');
  try {
    for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: id });
    const alice = store.openDirect('alice'), bob = store.openDirect('bob');
    const notify = vi.fn();
    const inbox = new DesktopInbox(store, () => undefined, notify);
    const publish = (room: string, sender: string, content: string) => store.enqueue({ conversationId: room,
      senderId: sender, source: 'companion', recipientIds: [], content });
    publish(alice.id, 'alice', 'Already shown before notification scan');
    const first = store.historyProjectionHead(alice.id);
    publish(bob.id, 'bob', 'Another conversation');
    inbox.read(alice.id, first);
    expect(inbox.snapshot()).toEqual({ [bob.id]: 1 });
    expect(notify.mock.calls.map(call => call[0])).toEqual([bob.id]);
    publish(alice.id, 'alice', 'Now rendered');
    const rendered = store.historyProjectionHead(alice.id);
    publish(alice.id, 'alice', 'Arrived after the snapshot');
    inbox.sync();
    expect(inbox.snapshot()[alice.id]).toBe(2);
    inbox.read(alice.id, rendered);
    expect(inbox.snapshot()).toEqual({ [alice.id]: 1, [bob.id]: 1 });
    inbox.read(alice.id, first);
    expect(inbox.snapshot()[alice.id]).toBe(1);
    inbox.read(alice.id, store.historyProjectionHead(alice.id));
    expect(new DesktopInbox(store, () => undefined, notify).snapshot()).toEqual({ [bob.id]: 1 });
  } finally {
    store.close();
  }
});
