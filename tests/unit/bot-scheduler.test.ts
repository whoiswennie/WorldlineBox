import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotScheduler } from '../../src/main/companion-bot/scheduler';
import type { BotClaim } from '../../src/main/companion-bot/types';

let store: BotStore, scheduler: BotScheduler | undefined;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => { store = new BotStore(':memory:'); store.createCompanion({ id: 'alice', name: 'Alice', persona: '认真' }); store.createCompanion({ id: 'bob', name: 'Bob', persona: '直接' }); });
afterEach(async () => { await scheduler?.close(100); scheduler = undefined; store.close(); });
it('runs lanes in parallel while preserving order within one lane', async () => {
  const a = store.openDirect('alice'), b = store.openDirect('bob');
  const a1 = store.enqueue({ conversationId: a.id, senderId: 'user', content: 'a1' }).events[0]!;
  const a2 = store.enqueue({ conversationId: a.id, senderId: 'user', content: 'a2' }).events[0]!;
  const b1 = store.enqueue({ conversationId: b.id, senderId: 'user', content: 'b1' }).events[0]!;
  const started: BotClaim[] = [], finish = new Map<string, () => void>();
  scheduler = new BotScheduler(store, { concurrency: 2, handle: async claim => {
    started.push(claim); await new Promise<void>(resolve => finish.set(claim.event.id, resolve));
    store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: claim.event.content });
  } });
  scheduler.start(); await tick();
  expect(started.map(claim => claim.event.id)).toEqual([a1.id, b1.id]);
  finish.get(a1.id)!(); await tick(); expect(started.map(claim => claim.event.id)).toEqual([a1.id, b1.id, a2.id]);
  finish.get(b1.id)!(); finish.get(a2.id)!(); await tick();
  expect(store.getEvent(a2.id)?.status).toBe('done'); expect(scheduler.runningCount).toBe(0);
});
it('turns a thrown handler into a terminal failure so later input can run', async () => {
  const conversation = store.openDirect('alice');
  const first = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: 'bad' }).events[0]!;
  const next = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: 'good' }).events[0]!;
  const onError = vi.fn();
  scheduler = new BotScheduler(store, { onError, handle: async claim => {
    if (claim.event.id === first.id) throw new Error('provider unavailable');
    store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '恢复可用' });
  } });
  scheduler.start(); await tick(); await tick();
  expect(store.getEvent(first.id)?.status).toBe('failed'); expect(store.getEvent(next.id)?.status).toBe('done'); expect(onError).toHaveBeenCalledOnce();
});
it('releases its slot after cancellation even when a broken handler ignores AbortSignal forever', async () => {
  const room = store.openDirect('alice');
  const first = store.enqueue({ conversationId: room.id, senderId: 'user', content: 'first' }).events[0]!;
  const next = store.enqueue({ conversationId: room.id, senderId: 'user', content: 'next' }).events[0]!;
  scheduler = new BotScheduler(store, { concurrency: 1, handle: async claim => {
    if (claim.event.id === first.id) return new Promise<void>(() => undefined);
    store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '可继续' });
  } });
  scheduler.start(); await tick(); scheduler.cancel(first.id); await tick(); await tick();
  expect(store.getEvent(next.id)?.status).toBe('done'); expect(scheduler.runningCount).toBe(0);
});
it('cancels a running event without allowing its late handler to publish', async () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: 'cancel' }).events[0]!;
  let finish: (() => void) | undefined, signal: AbortSignal | undefined, accepted: boolean | undefined;
  scheduler = new BotScheduler(store, { handle: async (claim, incomingSignal) => {
    signal = incomingSignal; await new Promise<void>(resolve => { finish = resolve; });
    accepted = store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '迟到答案' });
  } });
  scheduler.start(); await tick(); expect(scheduler.cancel(event.id)).toBe(true); expect(signal?.aborted).toBe(true);
  finish!(); await tick(); expect(accepted).toBe(false); expect(store.getMessage(event.replyMessageId)?.status).toBe('cancelled');
});
it('shutdown fences active work and preserves it for the next runtime', async () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: 'resume' }).events[0]!;
  scheduler = new BotScheduler(store, { handle: async (_claim, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } });
  scheduler.start(); await tick(); await scheduler.close();
  expect(store.getEvent(event.id)?.status).toBe('queued');
  const resumed = store.claim({ workerId: 'next-runtime' }); expect(resumed?.event.id).toBe(event.id);
});
it('detects a handler that silently returns without a durable outcome', async () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: 'no-result' }).events[0]!;
  scheduler = new BotScheduler(store, { handle: async () => {} }); scheduler.start(); await tick();
  expect(store.getEvent(event.id)?.status).toBe('failed'); expect(store.getMessage(event.replyMessageId)?.error).toContain('未提交');
});
