import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionReplyElapsedMs } from '../../src/shared/companion-reply-progress';

let store: CompanionsStore | undefined, root: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-attention-'));
  store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id,
    persona: '友好', description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'UTC' } });
  for (const id of ['alice', 'bob']) {
    const room = store.openPrivate(id), scope = { companionId: id, conversationId: room.id };
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
  vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
});
afterEach(() => { store?.close(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-attention-')) throw Error('Unexpected cleanup'); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
it('records the terminal time on interruption and clears it only when the work is queued again', () => {
  const room = store!.openPrivate('alice');
  const source = store!.appendMessage({ conversationId: room.id, authorId: 'user', content: '检查一次', replyDirective: 'queue' });
  const work = store!.request({ type: 'work.claim' }).work!;
  vi.setSystemTime(Date.now() + 5000);
  store!.request({ type: 'work.status', id: work.id, status: 'interrupted' });
  const interrupted = store!.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  expect(interrupted.progress!.finishedAt).toBe(new Date().toISOString());
  expect(interrupted.progress!.timing).toEqual({ elapsedMs: 5000 });
  vi.setSystemTime(Date.now() + 3600000);
  store!.request({ type: 'work.status', id: work.id, status: 'interrupted' });
  expect(store!.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!.progress!.finishedAt).toBe(interrupted.progress!.finishedAt);
  store!.request({ type: 'work.status', id: work.id, status: 'queued' });
  expect(store!.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!.progress!.finishedAt).toBeUndefined();
  store!.request({ type: 'work.claim' });
  vi.setSystemTime(Date.now() + 7000);
  const resumed = store!.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  expect(companionReplyElapsedMs(resumed.progress!, Date.now())).toBe(12000);
  store!.request({ type: 'work.status', id: work.id, status: 'cancelled' });
  const frozen = store!.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  vi.setSystemTime(Date.now() + 3600000);
  expect(companionReplyElapsedMs(frozen.progress!, Date.now())).toBe(12000);
});
it('does not count offline time when recovering a previously running process', () => {
  const room = store!.openPrivate('alice');
  const source = store!.appendMessage({ conversationId: room.id, authorId: 'user', content: '检查一次', replyDirective: 'queue' });
  store!.request({ type: 'work.claim' });
  vi.setSystemTime(Date.now() + 6000);
  const checkpoint = store!.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  checkpoint.progress = { ...checkpoint.progress!, updatedAt: new Date().toISOString() };
  store!.request({ type: 'loop.save', checkpoint });
  vi.setSystemTime(Date.now() + 3600000);
  store!.request({ type: 'work.interrupt-running' });
  const recovered = store!.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  expect(recovered.progress!.timing).toEqual({ elapsedMs: 6000 });
});
it('shares one FIFO between private and group messages while other companions remain independent', () => {
  store!.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
  store!.request({ type: 'tasks.concurrency.set', companionId: 'bob', limit: 1 });
  const privateRoom = store!.openPrivate('alice'), group = store!.createConversation('群聊', ['alice', 'bob']);
  const first = store!.appendMessage({ conversationId: privateRoom.id, authorId: 'user', content: '第一个请求', replyDirective: 'queue' });
  const active = store!.request({ type: 'work.claim' }).work!; expect(active.sourceMessageId).toBe(first.id);
  const second = store!.appendMessage({ conversationId: group.id, authorId: 'user', content: '@alice 第二个请求', replyDirective: 'queue' });
  const third = store!.appendMessage({ conversationId: privateRoom.id, authorId: 'user', content: '第三个请求', replyDirective: 'queue' });
  const independent = store!.appendMessage({ conversationId: store!.openPrivate('bob').id, authorId: 'user', content: '独立请求', replyDirective: 'queue' });
  expect(store!.request({ type: 'work.claim' }).work?.sourceMessageId).toBe(independent.id);
  expect(store!.request({ type: 'work.claim' }).work).toBeUndefined();
  store!.request({ type: 'work.status', id: active.id, status: 'done' });
  const next = store!.request({ type: 'work.claim' }).work!; expect(next.sourceMessageId).toBe(second.id);
  expect(store!.request({ type: 'work.claim' }).work).toBeUndefined();
  store!.request({ type: 'work.status', id: next.id, status: 'done' });
  expect(store!.request({ type: 'work.claim' }).work?.sourceMessageId).toBe(third.id);
});
it('accepts 100 waiting messages and atomically rejects the next publication without losing retriable content', () => {
  const room = store!.openPrivate('alice');
  store!.appendMessage({ conversationId: room.id, authorId: 'user', content: '正在处理', replyDirective: 'queue' });
  store!.request({ type: 'work.claim' });
  for (let i = 0; i < 100; i++) store!.appendMessage({ conversationId: room.id, authorId: 'user', content: '等候' + i, replyDirective: 'queue' });
  expect(store!.request({ type: 'work.list' }).works?.filter(work => work.status === 'queued')).toHaveLength(100);
  expect(() => store!.appendMessage({ conversationId: room.id, authorId: 'user', content: '未投递内容', clientId: 'full-retry', replyDirective: 'queue' })).toThrow('已满100条');
  expect(store!.search({ conversationId: room.id, query: '未投递内容' }).messages).toHaveLength(0);
  const queued = store!.request({ type: 'work.list' }).works!.find(work => work.status === 'queued')!;
  store!.request({ type: 'work.status', id: queued.id, status: 'cancelled' });
  expect(store!.appendMessage({ conversationId: room.id, authorId: 'user', content: '未投递内容', clientId: 'full-retry', replyDirective: 'queue' }).content).toBe('未投递内容');
});
