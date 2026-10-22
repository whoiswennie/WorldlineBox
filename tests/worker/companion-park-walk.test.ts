import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import type { CompanionLifeOccurrence } from '../../src/shared/companion-life-event';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import { companionWorldCellWalkable } from '../../src/shared/companion-world-engine';
import { companionWorldParkContains, companionWorldParkLayout } from '../../src/shared/companion-world-park';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '友好且喜欢散步', description: '', model: '', avatar: 'sister', proactive: true }));
const stores = new Set<CompanionsStore>(), roots: string[] = [];
const Sqlite = BetterSqlite3 as { new(filename: string): CompanionConnection };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-park-walk-')); roots.push(root); const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'compressed', timeZone: 'UTC' } });
  for (const companionId of seeds.map(seed => seed.id)) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
    for (const rule of store.request({ type: 'life-rule.list', companionId }).lifeRules!) store.request({ type: 'life-rule.remove', companionId, id: rule.id, expectedRevision: rule.revision });
  }
  return { store, filename, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function advance(store: CompanionsStore, milliseconds: number): CompanionWorldSnapshot { vi.setSystemTime(Date.now() + milliseconds); return store.request({ type: 'world.tick', snapshot: true }).world!; }
const actor = (world: CompanionWorldSnapshot) => world.actors.find(actor => actor.companionId === 'alice')!;
function start(store: CompanionsStore, durationMinutes = 35): CompanionLifeOccurrence {
  store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '测试实际公园散步', enabled: true, startMinute: 600, endMinute: 610, probability: 1, checkIntervalMinutes: 1, action: 'park_walk', durationMinutes } });
  store.request({ type: 'life-event.tick' });
  let claim: CompanionLifeOccurrence | undefined;
  for (let index = 0; index < 4 && !claim; index++) { advance(store, 1000); claim = store.request({ type: 'life-event.claim' }).lifeOccurrence; }
  expect(claim?.rule.action).toBe('park_walk');
  return store.request({ type: 'life-event.complete', id: claim!.id, leaseToken: claim!.leaseToken! }).lifeOccurrence!;
}
function untilStrolling(store: CompanionsStore): CompanionWorldSnapshot {
  let world = store.request({ type: 'world.snapshot' }).world!;
  for (let index = 0; index < 120 && actor(world).parkWalk?.stage !== 'strolling'; index++) world = advance(store, 1000);
  expect(actor(world).parkWalk?.stage).toBe('strolling'); return world;
}

describe('persistent physical park walks', () => {
  it('counts actual garden walking across independent phone replies, survives restart and returns home after a long session', () => {
    const f = fixture(), started = start(f.store);
    expect(started).toMatchObject({ status: 'active', result: expect.stringContaining('抵达公园后') });
    let world = advance(f.store, 5000);
    expect(actor(world).parkWalk).toMatchObject({ stage: 'travelling', participatedMinutes: 0 });
    expect(world.events.some(event => event.kind === 'park_walk_relax')).toBe(false);
    world = untilStrolling(f.store);
    const commons = world.scenes.find(scene => scene.kind === 'park')!, garden = companionWorldParkLayout(commons)!;
    expect(actor(world).route.every(point => point.sceneId === commons.id && companionWorldCellWalkable(commons, point) && companionWorldParkContains(garden, point))).toBe(true);
    const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '你今天在做什么？' });
    f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'phone_pause', kind: 'chat', sourceMessageId: source.id });
    const paused = f.store.request({ type: 'world.snapshot' }).world!, progress = actor(paused).parkWalk!.participatedMinutes;
    world = advance(f.store, 4000);
    expect(actor(world).parkWalk!.participatedMinutes).toBeGreaterThan(progress);
    expect(world.works.find(work => work.workId === 'phone_pause')?.status).toBe('ready');
    expect(world.events.some(event => event.kind === 'park_walk_interrupted')).toBe(false);
    f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'phone_pause' });
    world = advance(f.store, 4000); expect(actor(world).parkWalk!.participatedMinutes).toBeGreaterThan(progress);
    const saved = actor(world); f.store.close(); stores.delete(f.store);
    const reopened = new CompanionsStore(f.filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened);
    world = reopened.request({ type: 'world.snapshot' }).world!;
    expect(actor(world).parkWalk).toEqual(saved.parkWalk); expect(actor(world).position).toEqual(saved.position); expect(actor(world).route).toEqual(saved.route);
    for (let index = 0; index < 120 && actor(world).parkWalk; index++) world = advance(reopened, 1000);
    expect(actor(world).parkWalk).toBeUndefined(); expect(actor(world).sceneId).toBe(actor(world).homeSceneId);
    expect(world.events.filter(event => event.kind === 'park_walk_complete')).toHaveLength(1);
    expect(world.events.filter(event => event.kind === 'park_walk_enter')).toHaveLength(1);
    expect(world.events.filter(event => event.kind === 'park_walk_relax')).toHaveLength(3);
    expect(world.events.some(event => event.kind === 'park_walk_interrupted')).toBe(false);
    expect(reopened.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(occurrence => occurrence.id === started.id)?.status).toBe('done');
  });

  it('ends a partial walk for concentrated work and grants no invented completion or journey relaxation', () => {
    const f = fixture(), started = start(f.store); untilStrolling(f.store); let world = advance(f.store, 4000);
    const actual = actor(world).parkWalk!.participatedMinutes; expect(actual).toBeGreaterThan(0); expect(actual).toBeLessThan(10);
    const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请开始处理正式工作。' });
    f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'focused', kind: 'action', sourceMessageId: source.id });
    world = advance(f.store, 1000);
    expect(actor(world).parkWalk).toBeUndefined(); expect(actor(world).destinationId).toBe('alice_computer');
    expect(world.events.filter(event => event.kind === 'park_walk_interrupted')).toHaveLength(1);
    expect(world.events.some(event => event.kind === 'park_walk_complete' || event.kind === 'park_walk_relax')).toBe(false);
    expect(world.works.find(work => work.workId === 'focused')?.status).toBe('moving');
    expect(f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(occurrence => occurrence.id === started.id)?.status).toBe('cancelled');
  });

  it('yields to a scheduled meal while physically travelling and restores the meal at the real dining anchor', () => {
    const f = fixture(); start(f.store);
    const routine = f.store.request({ type: 'routine.get', ...f.scope }).routine!;
    f.store.request({ type: 'routine.configure', ...f.scope, expectedRevision: routine.revision, patch: { meals: [{ name: '午餐', at: '10:05', durationMinutes: 30 }] } });
    let world = advance(f.store, 8000);
    expect(actor(world).parkWalk).toBeUndefined(); expect(actor(world).destinationId).toBe('alice_dining');
    expect(world.events.find(event => event.kind === 'park_walk_interrupted')?.text).toContain('实际在园中散步0分钟');
    for (let index = 0; index < 20 && actor(world).activity !== 'eating'; index++) world = advance(f.store, 1000);
    expect(actor(world)).toMatchObject({ activity: 'eating', sceneId: actor(world).homeSceneId, position: { x: 5, y: 12 } });
    expect(world.events.some(event => event.kind === 'park_walk_complete' || event.kind === 'park_walk_relax')).toBe(false);
  });

  it('repairs saved local routes crossing furniture and physically exits a newly occupied footprint without teleporting', () => {
    for (const position of [{ x: 24, y: 14 }, { x: 27, y: 14 }]) {
      const f = fixture(); f.store.close(); stores.delete(f.store);
      const db = new Sqlite(f.filename);
      try {
        const saved = db.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }, state = JSON.parse(saved.data) as { actors: Array<Record<string, unknown>> };
        const subject = state.actors.find(actor => actor.companionId === 'alice')!;
        Object.assign(subject, { sceneId: 'park', position, route: [{ sceneId: 'park', x: 27, y: 14 }, { sceneId: 'park', x: 33, y: 14 }], destinationId: 'park', arrivalActivity: 'idle', activity: 'walking' });
        db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(state));
      } finally { db.close(); }
      const reopened = new CompanionsStore(f.filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened);
      let world = reopened.request({ type: 'world.snapshot' }).world!, previous = actor(world).position;
      expect(previous).toEqual(position);
      expect(world.events.some(event => event.kind === 'route_replanned')).toBe(true);
      const commons = world.scenes.find(scene => scene.kind === 'park')!;
      let outside = companionWorldCellWalkable(commons, position);
      for (const point of actor(world).route) {
        if (companionWorldCellWalkable(commons, point)) outside = true;
        if (outside) expect(companionWorldCellWalkable(commons, point)).toBe(true);
      }
      for (let index = 0; index < 25 && actor(world).route.length; index++) {
        world = advance(reopened, 500); const actual = actor(world).position;
        expect(Math.hypot(actual.x - previous.x, actual.y - previous.y)).toBeLessThanOrEqual(1.201); previous = actual;
      }
      expect(actor(world).position).toEqual({ x: 33, y: 14 }); expect(actor(world).route).toEqual([]);
    }
  });

  it('reserves one real bench while approaching, holds it while seated and releases only after standing', () => {
    const f = fixture(), bob = { companionId: 'bob', conversationId: f.store.openPrivate('bob').id };
    const move = (scope: typeof bob, destinationId: string) => f.store.request({ type: 'world.tool', ...scope, arguments: { action: 'move', destinationId } }).world!;
    for (const scope of [f.scope, bob]) { f.store.request({ type: 'world.tool', ...scope, arguments: { action: 'travel', targetSceneId: 'park' } }); advance(f.store, 5000); }
    let world = move(f.scope, 'park_bench');
    const bench = () => f.store.request({ type: 'world.snapshot' }).world!.scenes.find(scene => scene.kind === 'park')!.objects.find(object => object.id === 'park_bench')!;
    expect(bench().reservedBy).toBe('alice'); expect(bench().occupantId).toBeUndefined();
    expect(() => move(bob, 'park_bench')).toThrow('长椅');
    for (let index = 0; index < 120 && actor(world).route.length; index++) world = advance(f.store, 1000);
    f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'interact', furnitureId: 'park_bench', interaction: 'rest' } });
    advance(f.store, 1500); expect(bench().occupantId).toBe('alice');
    expect(() => move(bob, 'park_bench')).toThrow('长椅');
    world = f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'leave' } }).world!; expect(actor(world).activity).toBe('standingUp'); expect(bench().occupantId).toBe('alice');
    advance(f.store, 1500); expect(bench().reservedBy).toBeUndefined();
    move(bob, 'park_bench'); expect(bench().reservedBy).toBe('bob');
  });
});
