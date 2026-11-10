import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';

it('persists an unconfirmed interruption across restart, never auto-claims it, and resumes once after its durable acknowledgement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-interruption-store-')), filename = path.join(root, 'bot.sqlite');
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-interruption-store-')) throw Error('Invalid fixture root');
  let store = new BotStore(filename);
  try {
    store.createCompanion({ id: 'fish', name: 'Fish', persona: 'Helpful' });
    const room = store.openDirect('fish'), event = store.enqueue({ conversationId: room.id, senderId: 'user', content: '原始任务' }).events[0]!;
    const original = store.claim({ workerId: 'first' })!;
    store.setMetadata('native-input:' + event.id, JSON.stringify({ system: 'persona', prompt: 'original input' }));
    expect(store.interruptNativeReply(event.id)).toBe(true);
    expect(store.settle({ eventId: event.id, leaseToken: original.leaseToken, status: 'done', content: '迟到结果' })).toBe(false);
    store.close(); store = new BotStore(filename);
    expect(store.claim({ workerId: 'after-restart' })).toBeUndefined();
    expect(JSON.parse(store.getMetadata('native-stop:' + event.id)!)).toMatchObject({ eventId: event.id, suspend: true });
    expect(() => store.continueNativeReply(event.replyMessageId, 'before-confirmation')).toThrow('没有可继续');
    store.confirmNativeInterruption(event.id);
    expect(store.getMetadata('native-stop:' + event.id)).toBe('');
    expect(store.continueNativeReply(event.replyMessageId, 'one-click')).toBe(room.id);
    expect(store.continueNativeReply(event.replyMessageId, 'one-click')).toBe(room.id);
    const resumed = store.claim({ workerId: 'continued' })!;
    expect(resumed.event.id).toBe(event.id); expect(resumed.event.replyMessageId).toBe(event.replyMessageId);
    expect(store.settle({ eventId: event.id, leaseToken: original.leaseToken, status: 'done', content: '迟到旧租约' })).toBe(false);
    expect(store.settle({ eventId: event.id, leaseToken: resumed.leaseToken, status: 'done', content: '完成' })).toBe(true);
    expect(store.continueNativeReply(event.replyMessageId, 'one-click')).toBe(room.id);
    expect(store.claim({ workerId: 'duplicate' })).toBeUndefined();
    expect(store.messagesPage(room.id, {}).items.filter(message => message.senderId === 'user')).toHaveLength(1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('interrupts before native admission without a Host request and keeps destructive cancellation terminal', () => {
  const store = new BotStore(':memory:');
  try {
    store.createCompanion({ id: 'fish', name: 'Fish', persona: 'Helpful' }); const room = store.openDirect('fish');
    const a = store.enqueue({ conversationId: room.id, senderId: 'user', content: '投递前停止' }).events[0]!;
    expect(store.interruptNativeReply(a.id)).toBe(true);
    expect(store.getMetadata('native-stop:' + a.id)).toBeUndefined();
    expect(JSON.parse(store.getMetadata('execution:' + a.replyMessageId)!).interruption).toEqual({ state: 'ready' });
    expect(store.continueNativeReply(a.replyMessageId, 'resume-unadmitted')).toBe(room.id);
    const b = store.enqueue({ conversationId: room.id, senderId: 'user', content: '撤回的任务' }).events[0]!;
    expect(store.cancelEvent(b.id, true)).toBe(true);
    expect(() => store.continueNativeReply(b.replyMessageId, 'must-not-revive')).toThrow('没有可继续');
  } finally { store.close(); }
});
