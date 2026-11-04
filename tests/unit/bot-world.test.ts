import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotWorld } from '../../src/main/companion-bot/world';
import { createWorldHome, findWorldPath, worldCellWalkable } from '../../src/shared/world-physics';

let store: BotStore, world: BotWorld, time: number, root: string, conversationId: string;
const scope = (companionId = 'alice') => ({ companionId, conversationId });
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'worldline-bot-world-')); store = new BotStore(path.join(root, 'bot.sqlite')); time = 1000;
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: '真诚可靠' });
  conversationId = store.createGroup({ title: '世界', memberIds: ['alice', 'bob'], kind: 'world' }).id;
  world = new BotWorld(store, () => time);
});
afterEach(() => {
  store.close(); const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldline-bot-world-')) throw Error('Invalid test cleanup');
  rmSync(resolved, { force: true, recursive: true });
});
it('creates the actual original room and park geometry without revealing other private homes', () => {
  const snapshot = world.observe(scope());
  expect(snapshot.scenes.map(scene => [scene.id, scene.width, scene.depth])).toEqual([['park', 56, 36], ['home_alice', 20, 16]]);
  expect(snapshot.actors.map(actor => actor.companionId)).toEqual(['alice']);
  const home = snapshot.scenes.find(scene => scene.id === 'home_alice')!;
  expect(home.objects.find(object => object.kind === 'bed')).toMatchObject({ position: { x: 14, y: 2 }, width: 3, depth: 2 });
  expect(() => world.observe({ companionId: 'alice', conversationId: store.openDirect('bob').id })).toThrow('不属于');
});
it('uses cardinal A* around solid furniture and refuses blocked destinations', () => {
  const home = createWorldHome('alice'), route = findWorldPath(home, { x: 10, y: 15 }, { x: 14, y: 4 })!;
  expect(route.length).toBeGreaterThan(0); expect(route.every(point => worldCellWalkable(home, point))).toBe(true);
  expect(findWorldPath(home, { x: 10, y: 15 }, { x: 14, y: 2 })).toBeUndefined();
  expect(() => world.execute(scope(), { operation: 'move', sceneId: 'home_alice', x: 14, y: 2 }, 'blocked')).toThrow('不可到达');
});
it('advances at the original 2.4 tiles per real second and emits one durable arrival', () => {
  const command = { operation: 'move' as const, sceneId: 'home_alice', x: 10, y: 13 };
  const moved = world.execute(scope(), command, 'walk-1');
  expect(moved.receipt.status).toBe('moving'); expect(moved.snapshot.actors[0]?.position).toEqual({ x: 10, y: 15 });
  time += 500; const midway = world.observe(scope()); expect(midway.actors[0]?.position.y).toBeCloseTo(13.8);
  expect(midway.revision).toBe(moved.snapshot.revision);
  time += 500; const arrived = world.observe(scope()); expect(arrived.actors[0]?.position).toEqual({ x: 10, y: 13 }); expect(arrived.actors[0]?.activity).toBe('idle');
  expect(world.pendingEvents().map(event => event.kind)).toEqual(['move', 'arrival']);
  const pending = world.pendingEvents(); world.ackEvents(pending.map(event => event.id)); expect(world.pendingEvents()).toEqual([]);
  const retry = world.execute(scope(), command, 'walk-1'); expect(retry.event.id).toBe(moved.event.id); expect(world.pendingEvents()).toEqual([]);
});
it('travels through the current exit instead of using cross-scene coordinate teleportation', () => {
  world.execute(scope(), { operation: 'move', sceneId: 'home_alice', x: 10, y: 10 }, 'inside'); time += 3000; world.tick();
  expect(() => world.execute(scope(), { operation: 'move', sceneId: 'park', x: 28, y: 30 }, 'teleport')).toThrow('不能跨');
  const travel = world.execute(scope(), { operation: 'travel', sceneId: 'park' }, 'portal');
  expect(travel.snapshot.actors[0]?.sceneId).toBe('home_alice'); expect(travel.receipt.status).toBe('moving');
  time += 3000; const result = world.observe(scope()); expect(result.actors[0]?.sceneId).toBe('park'); expect(result.actors[0]?.position).toEqual({ x: 28, y: 34 });
  expect(() => world.execute(scope(), { operation: 'travel', sceneId: 'home_bob' }, 'private')).toThrow('私人小屋');
});
it('only changes a physical activity after reaching the object anchor and releases occupancy on stand', () => {
  const sit = world.execute(scope(), { operation: 'interact', objectId: 'alice_chair', action: 'sit' }, 'sit');
  expect(sit.snapshot.actors[0]?.activity).toBe('walking'); expect(sit.snapshot.scenes.find(scene => scene.id === 'home_alice')?.objects.find(object => object.id === 'alice_chair')?.occupantId).toBeUndefined();
  time += 10000; const arrived = world.observe(scope()); expect(arrived.actors[0]).toMatchObject({ activity: 'sitting', objectId: 'alice_chair', position: { x: 4, y: 4 } });
  expect(arrived.scenes.find(scene => scene.id === 'home_alice')?.objects.find(object => object.id === 'alice_chair')?.occupantId).toBe('alice');
  const stood = world.execute(scope(), { operation: 'interact', action: 'stand' }, 'stand'); expect(stood.snapshot.actors[0]?.activity).toBe('idle');
  expect(stood.snapshot.scenes.find(scene => scene.id === 'home_alice')?.objects.find(object => object.id === 'alice_chair')?.occupantId).toBeUndefined();
});
it('reserves shared furniture and only witnesses actors in the same real scene', () => {
  const alice = world.execute(scope(), { operation: 'travel', sceneId: 'park' }, 'a-park');
  expect(alice.event.recipientIds).toEqual(['alice']);
  const bob = world.execute(scope('bob'), { operation: 'travel', sceneId: 'park' }, 'b-park'); expect(bob.event.recipientIds.sort()).toEqual(['alice', 'bob']);
  expect(world.observe(scope()).actors).toHaveLength(2);
  world.execute(scope(), { operation: 'interact', objectId: 'park_bench', action: 'sit' }, 'a-reserve');
  expect(() => world.execute(scope('bob'), { operation: 'interact', objectId: 'park_bench', action: 'sit' }, 'b-reserve')).toThrow('占用或预约');
  world.execute(scope(), { operation: 'interact', action: 'stand' }, 'a-release');
  expect(world.execute(scope('bob'), { operation: 'interact', objectId: 'park_bench', action: 'sit' }, 'b-next').receipt.status).toBe('moving');
});
it('recovers movement and undelivered events from the new database after restart', () => {
  const result = world.execute(scope(), { operation: 'move', sceneId: 'home_alice', x: 10, y: 10 }, 'durable');
  store.close(); store = new BotStore(path.join(root, 'bot.sqlite')); time += 4000; world = new BotWorld(store, () => time);
  expect(world.observe(scope()).actors[0]?.position).toEqual({ x: 10, y: 10 });
  expect(world.pendingEvents().some(event => event.id === result.event.id)).toBe(true);
  expect(world.pendingEvents().filter(event => event.kind === 'arrival')).toHaveLength(1);
  expect(world.pendingEvents().filter(event => event.kind === 'arrival')).toHaveLength(1);
});
it('rejects stale revisions and reuse of effect IDs for different physical effects', () => {
  const initial = world.observe(scope()); world.execute(scope(), { operation: 'move', sceneId: 'home_alice', x: 10, y: 14 }, 'once');
  expect(() => world.execute(scope(), { operation: 'move', sceneId: 'home_alice', x: 10, y: 12, expectedRevision: initial.revision }, 'stale')).toThrow('已变化');
  expect(() => world.execute(scope(), { operation: 'move', sceneId: 'home_alice', x: 11, y: 14 }, 'once')).toThrow('其他动作');
});
