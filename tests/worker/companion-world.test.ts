import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionWorldCellWalkable, createCompanionWorldHome, createCompanionWorldCommons, findCompanionWorldPath } from '../../src/shared/companion-world-engine';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { recordUrgentAttention } from '../helpers/companion-world-fixture';
import { CompanionWorldStore } from '../../src/companions/world-store';
import { shareWorldAddress } from '../helpers/companion-world-address';
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '认真友好', description: '', model: '', avatar: 'sister', proactive: true }));
const stores = new Set<CompanionsStore>(), roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { vi.restoreAllMocks(); for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture(mode: 'compressed' | 'realtime' = 'compressed') {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-')); roots.push(root); const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, seeds); stores.add(store);
  const alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const initial = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode, timeZone: 'UTC' } });
  for (const scope of [alice, bob]) {
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  }
  return { store, filename, alice, bob, initial };
}
function advance(store: CompanionsStore, milliseconds: number) { vi.setSystemTime(Date.now() + milliseconds); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function tool(store: CompanionsStore, scope: { companionId: string; conversationId: string }, args: Extract<CompanionStorageCommand, { type: 'world.tool' }>['arguments']) {
  const source = args.action === 'visit' ? store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: `请拜访 ${args.targetCompanionId}：${args.reason}`, replyDirective: 'none' }) : undefined;
  return store.request({ type: 'world.tool', ...scope, ...(source ? { sourceMessageId: source.id } : {}), arguments: args }).world!;
}
function allowVisit(f: ReturnType<typeof fixture>) {
  shareWorldAddress(f.store, f.bob, 'alice', ms => advance(f.store, ms));
  const requested = tool(f.store, f.alice, { action: 'visit', targetCompanionId: 'bob', reason: '一起看书' });
  const visit = requested.visits.find(visit => visit.guestId === 'alice')!;
  tool(f.store, f.bob, { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎来做客' });
  tool(f.store, f.alice, { action: 'navigate', targetCompanionId: 'bob' }); advance(f.store, 40000);
  tool(f.store, f.alice, { action: 'enter', targetCompanionId: 'bob' }); advance(f.store, 8000);
  return visit;
}

describe('one authoritative companion world', () => {
  it('does not mistake SQL/projection latency for offline debt or suppress probability observation', () => {
    const f = fixture();
    const prototype = CompanionWorldStore.prototype as unknown as { save(value: unknown): void };
    const save = prototype.save;
    vi.spyOn(prototype, 'save').mockImplementation(function (this: typeof prototype, value) { save.call(this, value); vi.setSystemTime(Date.now() + 8); });
    const world = f.store.request({ type: 'world.observe', ...f.alice }).world!;
    expect(Date.now()).toBeGreaterThan(Date.parse(world.clock.realNow));
    expect(world.backlog).toBe(false);
    f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '正常观察散步机会', action: 'park_walk', startMinute: 600, endMinute: 660, probability: .5, durationMinutes: 35 } });
    f.store.request({ type: 'life-event.tick' });
    expect(f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.some(occ => occ.rule.title === '正常观察散步机会')).toBe(true);
  });
  it('defaults to the computer date, optionally compresses twenty minutes into a day, and realigns to wall time when restored', () => {
    const f = fixture('realtime'), first = f.store.request({ type: 'world.snapshot' }).world!;
    expect(f.initial.settings.mode).toBe('realtime'); expect(first.clock.speed).toBe(1); expect(first.clock.virtualNow).toBe(new Date().toISOString());
    const compressed = f.store.request({ type: 'world.configure', expectedRevision: first.settings.revision, patch: { mode: 'compressed' } }).world!;
    expect(compressed.clock.virtualNow).toBe(first.clock.virtualNow);
    const later = advance(f.store, 20 * 60000); expect(Date.parse(later.clock.virtualNow) - Date.parse(first.clock.virtualNow)).toBe(86400000);
    const changed = f.store.request({ type: 'world.configure', expectedRevision: compressed.settings.revision, patch: { mode: 'realtime' } }).world!;
    expect(changed.clock.virtualNow).toBe(new Date().toISOString()); const real = advance(f.store, 60000); expect(Date.parse(real.clock.virtualNow) - Date.parse(changed.clock.virtualNow)).toBe(60000);
    f.store.close(); stores.delete(f.store); const reopened = new CompanionsStore(f.filename, seeds); stores.add(reopened);
    expect(reopened.request({ type: 'world.snapshot' }).world!.clock.virtualNow).toBe(real.clock.virtualNow);
  });
  it('uses the exact same furniture footprints for collision and reachable adjacent interaction anchors', () => {
    const home = createCompanionWorldHome('alice', 0), route = findCompanionWorldPath(home, { x: 10, y: 13 }, { x: 4, y: 4 })!;
    expect(route.length).toBeGreaterThan(10); expect(route.every(point => companionWorldCellWalkable(home, point))).toBe(true);
    expect(findCompanionWorldPath(home, { x: 10, y: 13 }, { x: 3, y: 2 })).toBeUndefined();
    for (const object of home.objects) expect(companionWorldCellWalkable(home, object.anchor)).toBe(true);
    const commons = createCompanionWorldCommons([home]);
    expect(companionWorldCellWalkable(commons, { x: 10, y: 10 })).toBe(false);
    expect(companionWorldCellWalkable(commons, { x: 14, y: 20 })).toBe(true);
    const exterior = findCompanionWorldPath(commons, { x: 2, y: 10 }, { x: 26, y: 10 })!;
    expect(exterior.length).toBeGreaterThan(24); expect(exterior.every(point => companionWorldCellWalkable(commons, point))).toBe(true);
  });
  it('requires explicit host consent and walks every exterior path before entering another house', () => {
    const f = fixture();
    expect(() => tool(f.store, f.alice, { action: 'move', destinationId: 'home_bob' })).toThrow('enter');
    const visit = tool(f.store, f.alice, { action: 'visit', targetCompanionId: 'bob', reason: '拜访' }).visits[0]!;
    expect(() => tool(f.store, f.alice, { action: 'respond', requestId: visit.id, decision: 'allow', reason: '自己批准' })).toThrow('房主');
    advance(f.store, 40000); expect(f.store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!.sceneId).toBe('home_alice');
    tool(f.store, f.bob, { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎' });
    shareWorldAddress(f.store, f.bob, 'alice', ms => advance(f.store, ms));
    tool(f.store, f.alice, { action: 'navigate', targetCompanionId: 'bob' });
    const moving = advance(f.store, 100); expect(moving.actors.find(actor => actor.companionId === 'alice')!.activity).toBe('walking');
    advance(f.store, 40000); expect(f.store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!.sceneId).toBe('commons');
    tool(f.store, f.alice, { action: 'enter', targetCompanionId: 'bob' });
    const arrived = advance(f.store, 8000); expect(arrived.actors.find(actor => actor.companionId === 'alice')!.sceneId).toBe('home_bob');
  });
  it('persists partial physical movement and resumes it after a restart without teleporting or fake completed work', () => {
    const f = fixture(); tool(f.store, f.alice, { action: 'move', destinationId: 'alice_computer' }); const partial = advance(f.store, 500);
    const actor = partial.actors.find(actor => actor.companionId === 'alice')!; expect(actor.route.length).toBeGreaterThan(0); expect(actor.position).not.toEqual({ x: 4, y: 4 });
    f.store.close(); stores.delete(f.store); const reopened = new CompanionsStore(f.filename, seeds); stores.add(reopened);
    const same = reopened.request({ type: 'world.observe', ...f.alice }).world!.actors.find(actor => actor.companionId === 'alice')!; expect(same.position).toEqual(actor.position);
    const arrived = advance(reopened, 12000).actors.find(actor => actor.companionId === 'alice')!; expect(arrived.position).toEqual({ x: 4, y: 4 }); expect(arrived.route).toEqual([]);
  });
  it('does not become work-ready until arrival and seating, and shared jobs release the reservation only after the final end', () => {
    vi.setSystemTime('2026-10-14T02:00:00Z');
    const f = fixture(), source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '请帮我解释代码' });
    const request = { type: 'world.work.begin', ...f.alice, kind: 'action', sourceMessageId: source.id } as const;
    const initial = f.store.request({ ...request, workId: 'chat_one' }).worldWork!; expect(initial.status).toBe('waiting');
    // This virtual clock is 02:00 UTC: ordinary requests sleep, urgent requests wake.
    const urgent = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '紧急，马上帮我处理' });
    recordUrgentAttention(f.store, 'alice', urgent);
    const moving = f.store.request({ ...request, sourceMessageId: urgent.id, urgent: true, workId: 'chat_two' }).worldWork!; expect(moving.status).toBe('moving');
    advance(f.store, 1000); expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'chat_two' }).worldWork!.status).not.toBe('ready');
    advance(f.store, 7000); expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'chat_two' }).worldWork!.status).toBe('ready');
    expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'chat_one' }).worldWork!.status).toBe('waiting');
    const followup = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '补充这件事的细节' });
    f.store.request({ ...request, workId: 'chat_followup', sourceMessageId: followup.id });
    f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'chat_two' });
    expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.find(scene => scene.ownerId === 'alice')!.objects.find(object => object.kind === 'computer')!.reservedBy).toBe('alice');
    f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'chat_followup' });
    f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'chat_one' });
    advance(f.store, 1500);
    expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.find(scene => scene.ownerId === 'alice')!.objects.find(object => object.kind === 'computer')!.reservedBy).toBeUndefined();
  });
  it('borrows a free invited computer and returns home by foot when the host computer is occupied', () => {
    vi.setSystemTime('2026-10-14T10:00:00Z'); const f = fixture(); allowVisit(f); advance(f.store, 30000);
    const user = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '紧急帮忙' });
    recordUrgentAttention(f.store, 'alice', user);
    const borrowed = f.store.request({ type: 'world.work.begin', ...f.alice, kind: 'action', workId: 'borrow', sourceMessageId: user.id, urgent: true }).worldWork!;
    expect(borrowed.computerId).toBe('bob_computer'); advance(f.store, 15000); expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'borrow' }).worldWork!.status).toBe('ready');
    f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'borrow' });
    advance(f.store, 1500);
    const hostSource = f.store.appendMessage({ conversationId: f.bob.conversationId, authorId: 'user', content: '请处理任务' });
    f.store.request({ type: 'world.work.begin', ...f.bob, kind: 'action', workId: 'host_work', sourceMessageId: hostSource.id });
    const returning = f.store.request({ type: 'world.work.begin', ...f.alice, kind: 'action', workId: 'return_home', sourceMessageId: user.id, urgent: true }).worldWork!;
    expect(returning.computerId).toBe('alice_computer'); expect(returning.status).toBe('moving');
    expect(f.store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!.route.some(point => point.sceneId === 'commons')).toBe(true);
  });
  it('shares virtual routine time with the rendered world and routes sleep and meals to their real furniture', () => {
    vi.setSystemTime('2026-10-14T02:00:00Z');
    const f = fixture(), before = f.store.request({ type: 'routine.get', ...f.alice }).routine!;
    expect(before.runtime).toMatchObject({ phase: 'awake', plannedPhase: 'sleeping', canRespond: false }); const asleep = advance(f.store, 10000);
    expect(asleep.actors.find(actor => actor.companionId === 'alice')).toMatchObject({ activity: 'sleeping', furnitureId: 'alice_bed' });
    const configured = f.store.request({ type: 'routine.configure', ...f.alice, expectedRevision: before.revision, patch: { meals: [{ name: '午饭', at: '12:00', durationMinutes: 40 }] } }).routine!;
    expect(configured.config.meals[0]!.at).toBe('12:00');
    const target = Date.parse(asleep.clock.realNow) + (Date.parse('2026-10-14T12:05:00Z') - Date.parse(asleep.clock.virtualNow)) / 72;
    vi.setSystemTime(target); const lunch = f.store.request({ type: 'world.tick', snapshot: true }).world!;
    expect(f.store.request({ type: 'routine.get', ...f.alice }).routine!.runtime).toMatchObject({ phase: 'awake', plannedPhase: 'eating', canRespond: false });
    expect(lunch.actors.find(actor => actor.companionId === 'alice')!.destinationId).toBe('alice_dining');
    advance(f.store, 10000); expect(f.store.request({ type: 'routine.get', ...f.alice }).routine!.runtime.phase).toBe('eating');
  });
  it('does not expose another private house or private-source world text in a different chat', () => {
    const f = fixture(), secret = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '拜访理由秘密_984' });
    f.store.request({ type: 'world.tool', ...f.alice, sourceMessageId: secret.id, arguments: { action: 'visit', targetCompanionId: 'bob', reason: secret.content } });
    const bob = f.store.request({ type: 'world.observe', ...f.bob }).world!;
    expect(bob.scenes.some(scene => scene.ownerId === 'alice')).toBe(false); expect(JSON.stringify(bob)).not.toContain(secret.content);
    expect(() => f.store.request({ type: 'world.observe', ...f.alice, conversationId: f.bob.conversationId })).toThrow('当前伙伴');
  });
  it('durably leases autonomous work and does not grant peer friendship for an ordinary greeting', () => {
    vi.setSystemTime('2026-10-14T10:00:00Z'); const f = fixture(); allowVisit(f); advance(f.store, 30000);
    tool(f.store, f.bob, { action: 'move', destinationId: 'home_bob' }); advance(f.store, 5000);
    // Both actors are near the accepted entrance after the visit.
    const snapshot = f.store.request({ type: 'world.snapshot' }).world!, guest = snapshot.actors.find(actor => actor.companionId === 'alice')!, host = snapshot.actors.find(actor => actor.companionId === 'bob')!;
    expect(guest.sceneId).toBe(host.sceneId);
    tool(f.store, f.alice, { action: 'social', targetCompanionId: 'bob', text: '你好', kind: 'greet' });
    const relation = f.store.request({ type: 'world.snapshot' }).world!.relationships.find(relation => relation.companionId === 'alice')!;
    expect(relation.affinity).toBe(50); expect(relation.trust).toBe(50);
    const job = f.store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob!; expect(job.leaseToken).toBeTruthy();
    expect(f.store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob?.id).not.toBe(job.id);
    expect(() => f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: 'wrong' })).toThrow('租约');
    f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken! });
    expect(() => f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken! })).not.toThrow();
  });
  it('writes NPC speech as one real source visible only to the actual two participants, without increasing player relationship', () => {
    const f = fixture(); allowVisit(f); advance(f.store, 30000); tool(f.store, f.bob, { action: 'move', destinationId: 'home_bob' }); advance(f.store, 5000);
    const before = f.store.request({ type: 'state.get', ...f.alice }).runtimeState!;
    const world = tool(f.store, f.alice, { action: 'social', targetCompanionId: 'bob', text: '今天一起分享读书感受。', kind: 'talk' });
    const event = world.events.find(event => event.kind === 'social_talk')!, message = f.store.getMessage(event.sourceMessageId!);
    expect(message).toMatchObject({ authorId: 'alice', content: '今天一起分享读书感受。', status: 'sent' });
    for (const scope of [f.alice, f.bob]) expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [message.id] }).memorySources).toHaveLength(1);
    expect(f.store.state().conversations.some(conversation => conversation.id === message.conversationId)).toBe(false);
    const after = f.store.request({ type: 'state.get', ...f.alice }).runtimeState!;
    expect(after.relationship).toEqual(before.relationship); expect(after.familiarity).toEqual(before.familiarity);
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [message.id] });
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(item => item.id === event.id)).toBe(false);
    expect(f.store.request({ type: 'world.observe', ...f.bob }).world!.events.some(item => item.id === event.id)).toBe(true);
  });
  it('waits for an actual sleeping actor and validates dream dependencies again after forgetting', () => {
    vi.setSystemTime('2026-10-14T02:00:00Z'); const f = fixture();
    const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '我们今天一起完成读书计划。' });
    const memory = f.store.request({ type: 'memory.record', ...f.alice, candidate: { kind: 'event', content: source.content, subject: 'user', eventId: 'read_together',
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
    expect(f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob).toBeUndefined();
    advance(f.store, 10000); advance(f.store, 6000);
    const job = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!; expect(job.companionId).toBe('alice');
    const complete = { type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, dream: { text: '梦中回顾读书的经历。', sourceMessageIds: [source.id], relatedMemoryIds: [memory.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } } as const;
    f.store.request({ ...complete, dream: { ...complete.dream, sourceMessageIds: [...complete.dream.sourceMessageIds], relatedMemoryIds: [...complete.dream.relatedMemoryIds], evidence: [...complete.dream.evidence] } });
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(true);
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [source.id] });
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(false);
  });
  it('stops a computer reservation when its real user evidence is withdrawn', () => {
    const f = fixture(), source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '处理我的请求' });
    f.store.request({ type: 'world.work.begin', ...f.alice, workId: 'withdrawn', kind: 'chat', sourceMessageId: source.id });
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [source.id] });
    expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'withdrawn' }).worldWork!.status).toBe('ended');
    expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy === 'alice')).toBe(false);
  });
  it('finishes the full lying-down and waking transitions before sleep recovery or movement', () => {
    vi.setSystemTime('2026-10-14T02:00:00Z'); const f = fixture();
    let world = f.store.request({ type: 'world.snapshot' }).world!, actor = world.actors.find(actor => actor.companionId === 'alice')!;
    for (let index = 0; index < 100 && actor.activity !== 'lyingDown'; index++) { world = advance(f.store, 100); actor = world.actors.find(actor => actor.companionId === 'alice')!; }
    expect(actor.artAction).toBe('lieDown'); const position = actor.position, start = Date.parse(actor.activityStartedAtReal), end = Date.parse(actor.transitionEndsAtReal!);
    expect(end - start).toBe(2800); const energy = actor.state.energy;
    const beforeEnd = advance(f.store, end - Date.now() - 1).actors.find(actor => actor.companionId === 'alice')!;
    expect(beforeEnd).toMatchObject({ activity: 'lyingDown', frame: 2, position }); expect(beforeEnd.state.energy).toBeLessThan(energy);
    expect(f.store.request({ type: 'routine.get', ...f.alice }).routine!.runtime.phase).toBe('awake');
    const rested = advance(f.store, 5001).actors.find(actor => actor.companionId === 'alice')!; expect(rested.activity).toBe('sleeping'); expect(rested.state.energy).toBeGreaterThan(beforeEnd.state.energy);
    const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '现在有一件必须立即帮忙的事。' }); recordUrgentAttention(f.store, 'alice', source);
    f.store.request({ type: 'world.work.begin', ...f.alice, workId: 'wake_real', kind: 'action', sourceMessageId: source.id });
    const waking = f.store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!; expect(waking.artAction).toBe('wake');
    expect(advance(f.store, 2700).actors.find(actor => actor.companionId === 'alice')!.position).toEqual(position);
    expect(advance(f.store, 500).actors.find(actor => actor.companionId === 'alice')!.position).not.toEqual(position);
  });
  it('watermarks every reviewed atom in stable batches and does not repeat unchanged nightly reflection', () => {
    vi.setSystemTime('2026-10-14T02:00:00Z'); const f = fixture();
    const ids: string[] = [];
    for (let index = 0; index < 25; index++) {
      const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '真实测试事实条目' + index });
      ids.push(f.store.request({ type: 'memory.record', ...f.alice, candidate: { kind: 'fact', subject: 'user', factKey: 'item_' + index, content: source.content,
        sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!.id);
    }
    advance(f.store, 16000); const first = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
    expect(first.sourceMemoryIds).toEqual(ids.slice(0, 20)); f.store.request({ type: 'world.job.complete', id: first.id, leaseToken: first.leaseToken! });
    advance(f.store, 1000); const second = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
    expect(second.sourceMemoryIds).toEqual(ids.slice(20)); f.store.request({ type: 'world.job.complete', id: second.id, leaseToken: second.leaseToken! });
    advance(f.store, 1000); expect(f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob).toBeUndefined();
  });
});
