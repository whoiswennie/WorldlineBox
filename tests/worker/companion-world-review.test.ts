import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { advanceCompanionWorldActor, routeCompanionWorldActor } from '../../src/shared/companion-world-engine';

const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-review-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, persona: '尊重彼此边界。', description: '', model: '', avatar: 'sister' as const, active: true, proactive: true }))); stores.add(store);
  const alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const scope of [alice, bob]) { const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } }); }
  return { store, alice, bob };
}
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); return store.request({ type: 'world.snapshot' }).world!; }
describe('independent world cross-layer regression review', () => {
  it('walks the final fractional tile after a mid-stride replan instead of treating a rounded cell as exact arrival', () => {
    const f = fixture(), world = f.store.request({ type: 'world.snapshot' }).world!;
    const actor = { ...world.actors.find(actor => actor.companionId === 'alice')!, position: { x: 4.24, y: 4 } };
    const route = routeCompanionWorldActor(world.scenes, actor, actor.homeSceneId, { x: 4, y: 4 }, owner => owner === 'alice')!;
    expect(route.at(-1)).toMatchObject({ x: 4, y: 4 });
    const moved = advanceCompanionWorldActor({ ...actor, activity: 'walking', route }, 1000);
    expect(moved.actor.position).toEqual({ x: 4, y: 4 }); expect(moved.arrived).toBe(true);
  });
  it('does not reuse expired urgency when the same ended work identity is resumed later', () => {
    vi.setSystemTime('2026-10-14T02:00:00Z'); const f = fixture();
    const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '两分钟后截止，快帮我处理。', replyDirective: 'none' });
    f.store.request({ type: 'world.attention.record', ...f.alice, sourceMessageId: source.id, sourceChecksum: createHash('sha256').update(source.content).digest('hex'),
      urgency: 'urgent', confidence: .97, evidence: [source.content], reason: '用户当前确实临近截止并求助。' });
    const begin = { type: 'world.work.begin', ...f.alice, workId: 'same_interrupted_work', sourceMessageId: source.id, kind: 'action' } as const;
    expect(f.store.request(begin).worldWork!.status).toBe('moving');
    f.store.request({ type: 'world.work.end', companionId: 'alice', workId: begin.workId });
    advance(f.store, 31 * 60000);
    expect(f.store.request(begin).worldWork!.status).toBe('waiting');
  });
  it('does not cross a private doorway after consent expires while still approaching it', () => {
    const f = fixture();
    const request = f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '想分享书里的看法。' } }).world!.visits[0]!;
    advance(f.store, 30000);
    vi.setSystemTime(Date.parse(request.expiresAt) - 100);
    for (let catchup = 0; catchup < 100 && f.store.request({ type: 'world.snapshot' }).world!.backlog; catchup++) f.store.request({ type: 'world.tick' });
    f.store.request({ type: 'world.tool', ...f.bob, arguments: { action: 'respond', requestId: request.id, decision: 'allow', reason: '现在方便。' } });
    const world = advance(f.store, 3000);
    expect(world.actors.find(actor => actor.companionId === 'alice')!.sceneId).not.toBe('home_bob');
    expect(world.visits[0]!.status).toBe('expired');
  });
  it('preserves the compressed start and realigns the world to computer time on returning to realtime', () => {
    const f = fixture(), initial = f.store.request({ type: 'world.snapshot' }).world!;
    const schedule = f.store.request({ type: 'schedule.create', ...f.alice, entries: [{ title: '固定提醒', prompt: '提醒喝水', kind: 'reminder', runAt: '2026-10-14T11:00:00Z' }] }).schedules![0]!;
    advance(f.store, 30000);
    const realBefore = f.store.request({ type: 'world.snapshot' }).world!;
    const fast = f.store.request({ type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'compressed', dayDurationMinutes: 20 } }).world!;
    expect(fast.clock.virtualNow).toBe(realBefore.clock.virtualNow);
    advance(f.store, 60000);
    const sync = f.store.request({ type: 'world.configure', expectedRevision: fast.settings.revision, patch: { mode: 'realtime' } }).world!;
    expect(sync.clock.virtualNow).toBe(new Date().toISOString());
    expect(f.store.request({ type: 'schedule.list', ...f.alice }).schedules![0]).toMatchObject({ id: schedule.id, nextRunAt: '2026-10-14T11:00:00.000Z' });
    expect(f.store.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
  });
  it('does not show forgotten request or response facts in the human world snapshot', () => {
    const f = fixture(), reason = 'PRIVATE_REASON_5382', response = 'PRIVATE_RESPONSE_6341';
    const guestSource = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '申请拜访，因为' + reason, replyDirective: 'none' });
    const visit = f.store.request({ type: 'world.tool', ...f.alice, sourceMessageId: guestSource.id,
      arguments: { action: 'visit', targetCompanionId: 'bob', reason } }).world!.visits[0]!;
    const hostSource = f.store.appendMessage({ conversationId: f.bob.conversationId, authorId: 'user', content: '请回复允许，原因是' + response, replyDirective: 'none' });
    f.store.request({ type: 'world.tool', ...f.bob, sourceMessageId: hostSource.id,
      arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: response } });
    expect(JSON.stringify(f.store.request({ type: 'world.snapshot' }).world!.visits)).toContain(reason);
    expect(JSON.stringify(f.store.request({ type: 'world.snapshot' }).world!.visits)).toContain(response);
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [guestSource.id] });
    expect(JSON.stringify(f.store.request({ type: 'world.snapshot' }).world!.visits)).not.toContain(reason);
    f.store.request({ type: 'memory.forget', ...f.bob, sourceMessageIds: [hostSource.id] });
    expect(JSON.stringify(f.store.request({ type: 'world.snapshot' }).world!.visits)).not.toContain(response);
  });
  it('does not make a guest leave an active computer task when a delayed host accepts the visit', () => {
    const f = fixture();
    const visit = f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '有空时分享读书感受。' } }).world!.visits[0]!;
    const user = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '请先帮我处理代码任务。', replyDirective: 'none' });
    f.store.request({ type: 'world.work.begin', ...f.alice, sourceMessageId: user.id, kind: 'action', workId: 'actual_code_task' });
    advance(f.store, 15000);
    expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'actual_code_task' }).worldWork!.status).toBe('ready');
    f.store.request({ type: 'world.tool', ...f.bob, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '有空时欢迎。' } });
    const accepted = f.store.request({ type: 'world.snapshot' }).world!;
    const guest = accepted.actors.find(actor => actor.companionId === 'alice')!;
    expect(guest.activity).toBe('working'); expect(guest.route).toEqual([]); expect(guest.furnitureId).toBe('alice_computer');
  });
  it('rejects a pending autonomous response if the NPC speech it observed is forgotten before completion', () => {
    const f = fixture(), secret = 'WITHDRAWN_PEER_FACT_9183';
    f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'travel', targetSceneId: 'park' } }); advance(f.store, 30000);
    f.store.request({ type: 'world.tool', ...f.bob, arguments: { action: 'travel', targetSceneId: 'park' } }); advance(f.store, 30000);
    const sourceEvent = f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'social', targetCompanionId: 'bob', kind: 'talk', text: secret } }).world!.events.find(event => event.text === secret)!;
    const job = f.store.request({ type: 'social.job.claim' }).socialJob!;
    expect(job.companionId).toBe('bob');
    expect(f.store.request({ type: 'world.observe', companionId: job.companionId, conversationId: job.conversationId }).world!.events.some(event => event.id === sourceEvent.id)).toBe(true);
    f.store.request({ type: 'memory.forget', companionId: 'bob', conversationId: job.conversationId, sourceMessageIds: [sourceEvent.sourceMessageId!] });
    advance(f.store, Math.max(0, Date.parse(job.typingNotBefore) - Date.now()) + 1);
    expect(() => f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '刚才你说的' + secret })).toThrow();
    expect(f.store.request({ type: 'world.snapshot' }).world!.events.some(event => event.actorId === 'bob' && event.text.includes(secret))).toBe(false);
  });
});
