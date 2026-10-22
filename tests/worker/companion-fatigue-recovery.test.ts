import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import { shareWorldAddress } from '../helpers/companion-world-address';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const seed: CompanionSeed = { id: 'alice', name: 'Alice', persona: '认真生活', description: '', model: '', avatar: 'sister', proactive: true };
const seeds: CompanionSeed[] = [seed, { ...seed, id: 'bob', name: 'Bob' }];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-16T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function open(file: string) { const store = new CompanionsStore(file, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store); return store; }
function setSavedEnergy(file: string, energy: number) {
  const Database = BetterSqlite3 as { new(filename: string): CompanionConnection }, db = new Database(file);
  const record = db.prepare('SELECT data FROM companion_runtime_states WHERE companion_id=?').get('alice') as { data: string };
  db.prepare('UPDATE companion_runtime_states SET data=?,energy_clock=? WHERE companion_id=?').run(JSON.stringify({ ...JSON.parse(record.data), energy }), Date.now(), 'alice');
  db.close();
}
function fixture(energy: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-fatigue-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite'), initial = open(file), scope = { companionId: 'alice', conversationId: initial.openPrivate('alice').id };
  const world = initial.request({ type: 'world.snapshot' }).world!;
  initial.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = initial.request({ type: 'routine.get', ...scope }).routine!;
  initial.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  initial.request({ type: 'state.get', ...scope });
  initial.close(); stores.delete(initial);
  // A deliberately exhausted synthetic save, edited only while its sole store
  // owner is closed. No production API can arbitrarily refill/deplete energy.
  setSavedEnergy(file, energy);
  return { store: open(file), file, scope };
}
const actor = (world: CompanionWorldSnapshot) => world.actors.find(actor => actor.companionId === 'alice')!;
const snapshot = (store: CompanionsStore) => store.request({ type: 'world.snapshot' }).world!;
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; }

it('responds to a real 3% energy state with a physical walk and seating, and never awards recovery before arrival', () => {
  const f = fixture(3), first = snapshot(f.store), initial = actor(first);
  expect(initial.destinationId).toBe('alice_sofa'); expect(initial.route.length).toBeGreaterThan(0);
  expect(initial.state.energy).toBe(3);
  const beforeArrival = actor(advance(f.store, 500)); expect(beforeArrival.state.energy).toBeLessThan(3);
  expect(beforeArrival.activity).not.toBe('resting');
  const rested = actor(advance(f.store, 10000)); expect(rested).toMatchObject({ activity: 'resting', furnitureId: 'alice_sofa', route: [], activityLabel: '正在休息，恢复精力' });
  const later = actor(advance(f.store, 60000)); expect(later.state.energy).toBeGreaterThan(rested.state.energy);
  const routine = f.store.request({ type: 'routine.get', ...f.scope }).routine!.runtime;
  expect(routine).toMatchObject({ phase: 'resting', canRespond: true }); expect(routine.activity).toContain('恢复');
});

it('keeps recovering above the entry threshold across restart, ends at the higher threshold, and does not emit a per-tick loop', () => {
  const f = fixture(20); advance(f.store, 10000);
  let world = advance(f.store, 30 * 60000); expect(actor(world).state.energy).toBeGreaterThan(20); expect(actor(world).activity).toBe('resting');
  for (let index = 0; index < 15; index++) world = advance(f.store, 1000);
  expect(world.events.filter(event => event.kind === 'recovery_needed')).toHaveLength(1);
  expect(world.events.filter(event => event.kind === 'recovery_started')).toHaveLength(1);
  f.store.close(); stores.delete(f.store); const resumed = open(f.file);
  expect(actor(snapshot(resumed)).activity).toBe('resting');
  world = advance(resumed, 3 * 3600000); expect(actor(world).activity).toBe('resting'); expect(actor(world).state.energy).toBeLessThan(55);
  world = advance(resumed, 3600000); expect(actor(world).activity).toBe('idle'); expect(actor(world).state.energy).toBeGreaterThan(50);
  expect(world.events.filter(event => event.kind === 'recovery_completed')).toHaveLength(1);
});

it('splits a long offline interval at actual fatigue instead of standing idle until the next manual interaction', () => {
  const f = fixture(21), before = Date.now(); snapshot(f.store);
  const world = advance(f.store, 60 * 60000), actual = actor(world);
  expect(actual.activity).toBe('resting'); expect(actual.state.energy).toBeGreaterThan(26);
  const needed = world.events.find(event => event.kind === 'recovery_needed')!;
  expect(Date.parse(needed.realAt)).toBe(before + 12.5 * 60000);
  expect(world.backlog).toBe(false);
});

it('does not abandon accepted work or its real route, then physically rests when the work releases', () => {
  const f = fixture(3), source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请先把这项工作做完。', replyDirective: 'none' });
  f.store.request({ type: 'world.work.begin', ...f.scope, kind: 'action', workId: 'concentrated', sourceMessageId: source.id, fixed: true });
  const recoveryStarts = snapshot(f.store).events.filter(event => event.kind === 'recovery_started').length;
  let world = advance(f.store, 10000); expect(actor(world).activity).toBe('working');
  expect(f.store.request({ type: 'routine.get', ...f.scope }).routine!.runtime.canRespond).toBe(true);
  expect(world.works.find(work => work.workId === 'concentrated')?.status).toBe('ready');
  world = advance(f.store, 2 * 60000); expect(actor(world).activity).toBe('working'); expect(world.events.filter(event => event.kind === 'recovery_started')).toHaveLength(recoveryStarts);
  f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'concentrated' });
  world = advance(f.store, 10000); expect(actor(world).activity).toBe('resting');
});

it('keeps sleep and meals above fatigue recovery but permits ordinary player phone replies while seated and tired', () => {
  const f = fixture(3), source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '你累吗？', replyDirective: 'none' });
  f.store.request({ type: 'world.work.begin', ...f.scope, kind: 'chat', workId: 'phone', sourceMessageId: source.id });
  let world = advance(f.store, 10000); expect(actor(world)).toMatchObject({ activity: 'resting', artAction: 'phoneTypingSeated' });
  expect(world.works.find(work => work.workId === 'phone')?.status).toBe('ready');
  f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'phone' });
  let routine = f.store.request({ type: 'routine.get', ...f.scope }).routine!;
  f.store.request({ type: 'routine.configure', ...f.scope, expectedRevision: routine.revision, patch: { meals: [{ name: '午餐', at: '10:00', durationMinutes: 30 }] } });
  world = advance(f.store, 10000); expect(actor(world).activity).toBe('eating');
  expect(f.store.request({ type: 'routine.get', ...f.scope }).routine!.runtime.canRespond).toBe(true);
  routine = f.store.request({ type: 'routine.get', ...f.scope }).routine!;
  f.store.request({ type: 'routine.configure', ...f.scope, expectedRevision: routine.revision, patch: { sleepAt: '09:00', wakeAt: '11:00' } });
  world = advance(f.store, 20000); expect(actor(world).activity).toBe('sleeping');
  expect(f.store.request({ type: 'routine.get', ...f.scope }).routine!.runtime.canRespond).toBe(true);
});

it('leaves a foreign recovery sofa at the actual permission expiry and only resumes recovery after reaching its own sofa', () => {
  const f = fixture(100), bob = { companionId: 'bob', conversationId: f.store.openPrivate('bob').id };
  shareWorldAddress(f.store, bob, 'alice', ms => advance(f.store, ms));
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请去 Bob 家做客。', replyDirective: 'none' });
  const requested = f.store.request({ type: 'world.tool', ...f.scope, sourceMessageId: source.id, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '交流近况' } }).world!;
  const visit = requested.visits.find(visit => visit.guestId === 'alice' && visit.hostId === 'bob')!;
  f.store.request({ type: 'world.tool', ...bob, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎来玩' } });
  advance(f.store, Date.parse(visit.expiresAt) - Date.now() - 120000);
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'travel', targetSceneId: 'home_' + 'bob' } }); advance(f.store, 40000);
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'travel', targetSceneId: 'home_' + 'bob' } }); advance(f.store, 8000);
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', position: { x: 8, y: 12 } } }); advance(f.store, 3000);
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'bob_sofa' } }); advance(f.store, 10000);
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'interact', furnitureId: 'bob_sofa', interaction: 'rest' } }); advance(f.store, 10000);
  expect(actor(snapshot(f.store))).toMatchObject({ sceneId: 'home_bob', activity: 'resting', furnitureId: 'bob_sofa' });
  f.store.close(); stores.delete(f.store); setSavedEnergy(f.file, 3); const resumed = open(f.file);
  let world = snapshot(resumed); expect(actor(world)).toMatchObject({ sceneId: 'home_bob', activity: 'resting', state: { energy: 3 } });
  world = advance(resumed, Date.parse(visit.expiresAt) - Date.now() - 1);
  const before = actor(world); expect(before.activity).toBe('resting'); expect(before.state.energy).toBeLessThan(55);
  world = advance(resumed, 1); const leaving = actor(world);
  expect(world.visits.find(item => item.id === visit.id)?.status).toBe('expired');
  expect(leaving).toMatchObject({ sceneId: 'home_bob', activity: 'standingUp', position: before.position, destinationId: 'alice_sofa' });
  expect(leaving.travel?.targetSceneId).toBe('home_alice'); expect(leaving.route.every(point => point.sceneId === 'home_bob')).toBe(true);
  const walking = actor(advance(resumed, 2500)); expect(walking.state.energy).toBeLessThanOrEqual(leaving.state.energy);
  expect(walking.activity).not.toBe('resting'); expect(walking.destinationId).toBe('alice_sofa');
  const home = actor(advance(resumed, 60000)); expect(home).toMatchObject({ sceneId: 'home_alice', activity: 'resting', furnitureId: 'alice_sofa' });
  expect(actor(advance(resumed, 60000)).state.energy).toBeGreaterThan(home.state.energy);
});
