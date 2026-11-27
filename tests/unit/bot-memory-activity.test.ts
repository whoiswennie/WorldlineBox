import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotHistoryProjector } from '../../src/main/companion-bot/history-projection';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-memory-activity-')), store = new BotStore(path.join(root, 'bot.sqlite'));
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: '伙伴' });
  const room = store.openDirect('alice'), scope = { companionId: 'alice', conversationId: room.id, securityDomainId: room.securityDomainId };
  function source(index: number, status: 'done' | 'failed' = 'done') {
    const sent = store.enqueue({ conversationId: room.id, senderId: 'user', source: 'user', sourceMessageId: String(index), content: `询问桌面整理 ${index}` });
    const claim = store.claim({ workerId: 'chat' })!;
    expect(claim.event.id).toBe(sent.events[0]!.id);
    store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status, content: status === 'done' ? `讨论了桌面整理 ${index}` : '' });
    return store.getEvent(claim.event.id)!;
  }
  return { store, scope, source };
}
it('counts only receipt-confirmed VCP originals and excludes withdrawn/foreign sources', async () => {
  const f = fixture(), first = f.source(1), second = f.source(2, 'failed');
  expect(f.store.memoryActivity(f.scope).originals).toEqual({ archived: 0, pending: 3 });
  const projector = new BotHistoryProjector({ store: f.store, memory: { appendHistory: async () => ({ archived: true }) } });
  await projector.project(f.scope);
  expect(f.store.memoryActivity(f.scope).originals).toEqual({ archived: 3, pending: 0 });
  f.source(3);
  expect(f.store.memoryActivity(f.scope).originals).toEqual({ archived: 3, pending: 2 });
  f.store.withdrawSources(f.scope.companionId, f.scope.securityDomainId, [first.id]);
  expect(f.store.memoryActivity(f.scope).originals).toEqual({ archived: 1, pending: 2 });
  expect(f.store.getMessage(second.replyMessageId)?.status).toBe('failed');
  expect(() => f.store.memoryActivity({ ...f.scope, companionId: 'bob' })).toThrow('受众');
  expect(() => f.store.memoryActivity({ ...f.scope, securityDomainId: 'forged' })).toThrow('受众');
});
