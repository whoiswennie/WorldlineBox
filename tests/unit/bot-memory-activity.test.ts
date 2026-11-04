import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotHistoryProjector } from '../../src/main/companion-bot/history-projection';
import type { BotEvent } from '../../src/main/companion-bot/types';

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
  function capture(event: BotEvent, policyVersion?: 1 | 2) {
    return store.enqueueMemoryJob({ kind: 'capture', key: policyVersion === 2 ? `capture:v2:${event.id}` : `legacy:${event.id}`, payload: { scope, sourceEventId: event.id,
      ...(policyVersion ? { policyVersion } : {}), messages: [{ id: event.sourceMessageRecordId, role: 'user', content: event.content, timestamp: Date.now() }], answer: '仅讨论，没有执行', answerMessageId: event.replyMessageId } });
  }
  function settleCapture(notes?: number, status: 'done' | 'failed' = 'done') {
    const claim = store.claimMemoryJob({ workerId: 'capture' })!;
    expect(claim).toBeDefined();
    store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status,
      metadata: notes === undefined ? undefined : [{ key: `memory-capture-result:${claim.job.id}`, value: JSON.stringify({ policyVersion: 2, notes, completedAt: new Date().toISOString() }) }] });
    return claim;
  }
  return { store, scope, source, capture, settleCapture };
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
it('distinguishes legacy unknown outcomes, real empty results, notes, failures and unfinished jobs atomically', () => {
  const f = fixture();
  f.capture(f.source(1)); f.settleCapture();
  const empty = f.capture(f.source(2), 2); f.settleCapture(0);
  f.capture(f.source(3), 2); f.settleCapture(2);
  f.capture(f.source(4), 2); f.settleCapture(undefined, 'failed');
  f.capture(f.source(5), 2);
  f.capture(f.source(6), 2);
  const running = f.store.claimMemoryJob({ workerId: 'busy' })!;
  expect(f.store.memoryActivity(f.scope).capture).toEqual({ queued: 1, running: 1, failed: 1, empty: 1, withNotes: 1, unknownDone: 1 });
  expect(f.store.settleMemoryJob({ id: running.job.id, leaseToken: 'stale', status: 'done', metadata: [{ key: 'must-not-exist', value: 'bad' }] })).toBe(false);
  expect(f.store.getMetadata('must-not-exist')).toBeUndefined();
  expect(f.store.getMetadata(`memory-capture-result:${empty.id}`)).toContain('"notes":0');
  f.store.withdrawSources(f.scope.companionId, f.scope.securityDomainId, [String(empty.payload.sourceEventId)]);
  expect(f.store.memoryActivity(f.scope).capture.empty).toBe(0);
});
it('backfills at most 24 validated legacy captures, persists its cursor and never resets existing v2 outcomes', () => {
  const f = fixture();
  for (let i = 0; i < 26; i++) { const event = f.source(i); f.capture(event); f.settleCapture(); }
  expect(f.store.enqueueLegacyCaptureBackfill(f.scope, 2)).toEqual({ scanned: 24, queued: 24 });
  expect(f.store.enqueueLegacyCaptureBackfill(f.scope, 2)).toEqual({ scanned: 0, queued: 0 });
  for (let i = 0; i < 24; i++) f.settleCapture(0, i === 0 ? 'failed' : 'done');
  expect(f.store.enqueueLegacyCaptureBackfill(f.scope, 2)).toEqual({ scanned: 2, queued: 2 });
  f.settleCapture(0); f.settleCapture(0);
  expect(f.store.enqueueLegacyCaptureBackfill(f.scope, 2)).toEqual({ scanned: 0, queued: 0 });
  expect(f.store.memoryActivity(f.scope).capture).toMatchObject({ failed: 1, empty: 25, unknownDone: 0 });
});
it('does not upgrade withdrawn, stale-ACL or foreign source events and does not replay chats', () => {
  const f = fixture(), withdrawn = f.source(1); f.capture(withdrawn); f.settleCapture();
  f.store.withdrawSources(f.scope.companionId, f.scope.securityDomainId, [withdrawn.id]);
  const foreignRoom = f.store.openDirect('bob');
  const sent = f.store.enqueue({ conversationId: foreignRoom.id, senderId: 'user', content: '私有Bob原话' }), claim = f.store.claim({ workerId: 'bob' })!;
  f.store.settle({ eventId: sent.events[0]!.id, leaseToken: claim.leaseToken, status: 'done', content: 'Bob回答' });
  f.capture(f.store.getEvent(sent.events[0]!.id)!); f.settleCapture();
  const group = f.store.createGroup({ title: '旧受众', memberIds: ['alice'], participationMode: 'all' });
  const old = f.store.enqueue({ conversationId: group.id, senderId: 'user', content: '旧受众内讨论的内容' }), oldClaim = f.store.claim({ workerId: 'old' })!;
  f.store.settle({ eventId: old.events[0]!.id, leaseToken: oldClaim.leaseToken, status: 'done', content: '旧受众回答' });
  const oldScope = { companionId: 'alice', conversationId: group.id, securityDomainId: group.securityDomainId };
  f.store.enqueueMemoryJob({ kind: 'capture', key: 'stale-acl', payload: { scope: oldScope, sourceEventId: oldClaim.event.id, messages: [], answer: '旧受众回答' } }); f.settleCapture();
  // Participation policy alone is not an audience revision. Model an actual
  // ACL revision persisted by a future membership migration, without weakening
  // production authorization or relying on a policy toggle as proof.
  f.store.taskTransaction(sql => sql.prepare('UPDATE bot_conversations SET revision=revision+1 WHERE id=?').run(group.id));
  const head = f.store.historyProjectionHead(f.scope.conversationId);
  expect(f.store.enqueueLegacyCaptureBackfill(f.scope, 2)).toEqual({ scanned: 2, queued: 0 });
  expect(f.store.enqueueLegacyCaptureBackfill(oldScope, 2)).toEqual({ scanned: 1, queued: 0 });
  expect(f.store.historyProjectionHead(f.scope.conversationId)).toBe(head);
  expect(f.store.claim({ workerId: 'no-chat-replay' })).toBeUndefined();
});
it('never resurrects legacy v1 diary sources after managed archival/organization has fenced backfill', () => {
  const f = fixture(), source = f.source(1); f.capture(source); f.settleCapture();
  // Same stable per-domain fence written before a managed effect is admitted;
  // unknown acknowledgements are conservative too. New v2 capture is unaffected.
  const domain = f.store.getMemoryJob(f.capture(f.source(2), 2).id)!.domainKey;
  f.store.setMetadata(`memory-capture-backfill-v2-suppressed:${domain}`, 'managed-archive-operation');
  f.settleCapture(1);
  expect(f.store.enqueueLegacyCaptureBackfill(f.scope, 2)).toEqual({ scanned: 0, queued: 0 });
  expect(f.store.memoryActivity(f.scope).capture).toMatchObject({ unknownDone: 1, withNotes: 1 });
});
