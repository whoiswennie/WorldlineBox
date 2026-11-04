import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotHistoryProjector } from '../../src/main/companion-bot/history-projection';
import type { BotMemoryMessage, BotMemoryScope } from '../../src/main/companion-bot/memory-service';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-history-projection-')), filename = path.join(root, 'bot.sqlite');
  let store = new BotStore(filename);
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: '可靠伙伴' });
  const conversation = store.createGroup({ title: '共同讨论', memberIds: ['alice', 'bob'], participationMode: 'all' });
  const scope: BotMemoryScope = { companionId: 'alice', conversationId: conversation.id, securityDomainId: conversation.securityDomainId };
  const saved = new Map<string, string>();
  const memory = { appendHistory: vi.fn(async (_scope: BotMemoryScope, messages: BotMemoryMessage[]) => {
    for (const message of messages) {
      const bytes = JSON.stringify(message), previous = saved.get(message.id);
      if (previous && previous !== bytes) throw new Error('Conflicting original projection bytes');
      saved.set(message.id, bytes);
    }
    return { archived: true };
  }) };
  return { root, filename, get store() { return store; }, scope, memory, saved,
    reopen: () => { store.close(); store = new BotStore(filename); return store; },
    upgrade: (change: (filename: string) => void) => { store.close(); change(filename); store = new BotStore(filename); return store; } };
}
it('archives a group reply that finishes late even though its UI message sequence is below the previous cursor', async () => {
  const f = fixture(), sent = f.store.enqueue({ conversationId: f.scope.conversationId, senderId: 'user', content: '请分别回答' });
  const a = f.store.claim({ workerId: 'a' })!, b = f.store.claim({ workerId: 'b' })!;
  expect(a.event.companionId).toBe('alice'); expect(b.event.companionId).toBe('bob');
  f.store.settle({ eventId: b.event.id, leaseToken: b.leaseToken, status: 'done', content: 'Bob先完成' });
  const projector = new BotHistoryProjector({ store: f.store, memory: f.memory });
  expect((await projector.project(f.scope)).projected).toBe(2);
  expect(f.saved.has(a.event.replyMessageId)).toBe(false);
  f.store.settle({ eventId: a.event.id, leaseToken: a.leaseToken, status: 'done', content: 'Alice稍后完成' });
  expect(f.store.getMessage(a.event.replyMessageId)!.sequence).toBeLessThan(f.store.getMessage(b.event.replyMessageId)!.sequence);
  expect((await projector.project(f.scope)).projected).toBe(1);
  expect([...f.saved.keys()]).toEqual([sent.message.id, b.event.replyMessageId, a.event.replyMessageId]);
  expect(JSON.parse(f.saved.get(b.event.replyMessageId)!)).toMatchObject({ role: 'user', senderId: 'bob' });
});
it('advances only after the durable receipt and safely replays a crash between archive and cursor commit', async () => {
  const f = fixture(), sent = f.store.enqueue({ conversationId: f.scope.conversationId, senderId: 'user', content: '不能遗漏的原话' });
  const actual = f.memory.appendHistory.getMockImplementation()!;
  f.memory.appendHistory.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('receipt lost after archive'); });
  await expect(new BotHistoryProjector({ store: f.store, memory: f.memory }).project(f.scope)).rejects.toThrow('receipt lost');
  expect(f.saved.has(sent.message.id)).toBe(true);
  const recovered = new BotHistoryProjector({ store: f.reopen(), memory: f.memory });
  expect((await recovered.project(f.scope)).projected).toBe(1);
  expect((await recovered.project(f.scope)).projected).toBe(0); expect(f.saved.size).toBe(1);
});
it('keeps exact v2 reply timestamps when seeding the publication journal after upgrade', async () => {
  const f = fixture(), event = f.store.enqueue({ conversationId: f.scope.conversationId, senderId: 'user', content: '旧v2新伙伴数据' }).events[0]!;
  const claim = f.store.claim({ workerId: 'worker' })!, timestamp = 1793612345678;
  f.store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: 'done', content: 'v2已归档回答', memoryJobs: [{ kind: 'projection', key: event.id,
    payload: { scope: f.scope, messages: [{ id: event.replyMessageId, timestamp }] } }] });
  const store = f.upgrade(filename => {
    const Database = BetterSqlite3 as { new(filename: string): { exec(sql: string): void; close(): void } };
    const db = new Database(filename); db.exec('DROP TABLE bot_history_projection; PRAGMA user_version=2'); db.close();
  });
  await new BotHistoryProjector({ store, memory: f.memory }).project(f.scope);
  expect(JSON.parse(f.saved.get(event.replyMessageId)!)).toMatchObject({ timestamp, content: 'v2已归档回答' });
});
it('filters withdrawn sources and refuses a forged security domain or absent member', async () => {
  const f = fixture(), secret = f.store.enqueue({ conversationId: f.scope.conversationId, senderId: 'user', content: '已经撤回的原话' });
  f.store.withdrawSources(f.scope.companionId, f.scope.securityDomainId, [secret.message.id]);
  const projector = new BotHistoryProjector({ store: f.store, memory: f.memory });
  expect((await projector.project(f.scope)).projected).toBe(0); expect(f.memory.appendHistory).not.toHaveBeenCalled();
  await expect(projector.project({ ...f.scope, securityDomainId: 'another-private-domain' })).rejects.toThrow('受众');
  await expect(projector.project({ ...f.scope, companionId: 'absent' })).rejects.toThrow('受众');
});
it('archives finite bounded pages and yields cancellation without committing an unconfirmed cursor', async () => {
  const f = fixture();
  for (let i = 0; i < 70; i++) f.store.enqueue({ conversationId: f.scope.conversationId, senderId: 'user', content: `原话${i}` });
  const controller = new AbortController(), actual = f.memory.appendHistory.getMockImplementation()!;
  f.memory.appendHistory.mockImplementationOnce(async (...args) => { await actual(...args); controller.abort(new Error('cancel barrier')); return { archived: true }; });
  const projector = new BotHistoryProjector({ store: f.store, memory: f.memory });
  await expect(projector.project(f.scope, controller.signal)).rejects.toThrow('cancel barrier');
  expect((await projector.project(f.scope)).projected).toBe(70);
  expect(f.saved.size).toBe(70); expect(f.memory.appendHistory.mock.calls.every(call => call[1].length <= 32)).toBe(true);
});
it('reserves durable queue shares for projection and capture under a continuous stream of response jobs', () => {
  const f = fixture(), kinds: string[] = [];
  for (let i = 0; i < 12; i++) {
    for (const kind of ['response', 'projection', 'capture'] as const) f.store.enqueueMemoryJob({ id: `${kind}-${i}`, kind, payload: { scope: f.scope } });
    const claim = f.store.claimMemoryJob({ workerId: 'background', now: 1000 })!; kinds.push(claim.job.kind);
    f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: 'done' });
    if (i === 5) f.reopen();
  }
  expect(kinds).toEqual(['response', 'projection', 'response', 'capture', 'response', 'projection', 'response', 'capture', 'response', 'projection', 'response', 'capture']);
});
