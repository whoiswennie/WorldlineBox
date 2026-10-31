import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import type { CompanionWorldPerception } from '../../src/shared/companion-world-perception';
import { companionWorldEnvironment } from '../../src/shared/companion-world-engine';

const Sqlite = BetterSqlite3 as { new(filename: string): CompanionConnection }, roots: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '认真观察周围', description: '', model: '', avatar: 'sister', proactive: false }));
type PerceptionRow = { companion_id: string; samples: number; last_event_at: number; data: string };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture(positions?: Array<{ x: number; y: number }>, proactive = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-perception-')); roots.push(root); const filename = path.join(root, 'messages.sqlite'), roles = seeds.map(seed => ({ ...seed, proactive }));
  let store = new CompanionsStore(filename, roles.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const role of roles) {
    const scope = { companionId: role.id, conversationId: store.openPrivate(role.id).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  }
  if (positions) {
    store.close(); stores.delete(store); const db = new Sqlite(filename);
    try {
      const saved = db.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }, state = JSON.parse(saved.data) as { actors: Array<Record<string, unknown>> };
      state.actors.forEach((actor, index) => Object.assign(actor, { sceneId: 'park', position: positions[index], route: [], activity: 'idle' }));
      db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(state)); db.prepare('DELETE FROM companion_world_perceptions').run();
    } finally { db.close(); }
    store = new CompanionsStore(filename, roles.map(seed => ({ ...seed, active: true }))); stores.add(store);
  }
  store.request({ type: 'world.snapshot' });
  return { store, filename, roles, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function advance(store: CompanionsStore, milliseconds: number): CompanionWorldSnapshot { vi.setSystemTime(Date.now() + milliseconds); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function observe(f: ReturnType<typeof fixture>): CompanionWorldSnapshot { return f.store.request({ type: 'world.observe', ...f.scope }).world!; }
function read<T>(filename: string, query: string): T { const db = new Sqlite(filename); try { return db.prepare(query).all() as T; } finally { db.close(); } }
function records(filename: string): PerceptionRow[] { return read(filename, 'SELECT * FROM companion_world_perceptions ORDER BY companion_id'); }
function knowledge(filename: string, owner = 'alice'): CompanionWorldPerception { return JSON.parse(records(filename).find(row => row.companion_id === owner)!.data) as CompanionWorldPerception; }
function audit(filename: string) {
  return { perceptions: records(filename), world: read(filename, 'SELECT * FROM companion_world'), events: read(filename, 'SELECT * FROM companion_world_events ORDER BY sequence'),
    occupancy: read(filename, 'SELECT * FROM companion_world_occupancy ORDER BY id'), jobs: read(filename, 'SELECT * FROM companion_world_jobs ORDER BY id') };
}
function rememberWeather(f: ReturnType<typeof fixture>, weather?: 'rain' | 'clear', ageMinutes = 0) {
  const value = knowledge(f.filename), environment = value.environment;
  delete environment.weather; delete environment.weatherObservedAtVirtual; delete environment.weatherObservedAtReal; delete environment.weatherSource;
  if (weather) Object.assign(environment, { weather, weatherObservedAtReal: new Date(Date.now() - ageMinutes * 60000).toISOString(),
    weatherObservedAtVirtual: new Date(Date.parse(value.observedAtVirtual) - ageMinutes * 60000).toISOString(), weatherSource: 'door' });
  const db = new Sqlite(f.filename); try { db.prepare('UPDATE companion_world_perceptions SET data=? WHERE companion_id=?').run(JSON.stringify(value), 'alice'); } finally { db.close(); }
}
function indoors() {
  const f = fixture(undefined, true);
  for (const role of f.roles) for (const rule of f.store.request({ type: 'life-rule.list', companionId: role.id }).lifeRules!) {
    f.store.request({ type: 'life-rule.remove', companionId: role.id, id: rule.id, expectedRevision: rule.revision });
  }
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_computer' } });
  advance(f.store, 9000);
  expect(observe(f).perception).toMatchObject({ sceneId: 'home_alice', position: { x: 4, y: 4 } }); return f;
}

describe('authoritative continuous subjective perception', () => {
  it('refreshes a moving actor immediately on its explicit observation without resampling other actors or duplicating unchanged reads', () => {
    const f = indoors();
    f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_door' } });
    advance(f.store, 4000); observe(f);
    const before = records(f.filename), beforeBob = before.find(row => row.companion_id === 'bob')!;
    advance(f.store, 150);
    const authoritative = f.store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!;
    const actual = observe(f);
    expect(actual.perception!.position).toEqual(authoritative.position);
    expect(actual.perception!.activity).toBe(authoritative.activity);
    expect(actual.perception!.observedAtReal).toBe(new Date(Date.now()).toISOString());
    expect(records(f.filename).find(row => row.companion_id === 'bob')).toEqual(beforeBob);
    const after = records(f.filename);
    for (let poll = 0; poll < 40; poll++) { observe(f); f.store.request({ type: 'world.snapshot' }); }
    expect(records(f.filename)).toEqual(after);
  });
  it('limits a private tool view to self and locally discovered facts while the observer retains the full world', () => {
    const f = fixture(), observer = f.store.request({ type: 'world.snapshot' }).world!, subjective = observe(f);
    expect(observer.actors.map(actor => actor.companionId)).toEqual(['alice', 'bob']);
    expect(observer.scenes.find(scene => scene.ownerId === 'bob')!.objects.length).toBeGreaterThan(5);
    expect(subjective.actors.map(actor => actor.companionId)).toEqual(['alice']); expect(subjective.scenes.some(scene => scene.ownerId === 'bob')).toBe(false);
    expect(subjective.perception).toMatchObject({ companionId: 'alice', sceneId: 'home_alice', awake: true, visibleCompanionIds: [] });
    expect(subjective.perception!.objects.every(object => object.sceneId === 'home_alice')).toBe(true);
    expect(subjective.scenes.flatMap(scene => scene.objects).every(object => subjective.perception!.objects.some(known => known.id === object.id))).toBe(true);
    expect(subjective.events.filter(event => event.kind === 'perception').every(event => event.actorId === 'alice')).toBe(true);
  });

  it('discovers furniture by physically approaching and preserves its old observation after walking out of sight', () => {
    const f = fixture(), before = observe(f).perception!;
    expect(before.objects.some(object => object.id === 'alice_desk')).toBe(false);
    f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_computer' } });
    const discoveries: CompanionWorldPerception[] = [];
    for (let step = 0; step < 9; step++) { advance(f.store, 1000); discoveries.push(observe(f).perception!); }
    const first = discoveries.find(perception => perception.objects.some(object => object.id === 'alice_desk' && object.visible))!;
    expect(first).toBeDefined(); expect(Date.parse(first.objects.find(object => object.id === 'alice_desk')!.firstObservedAt)).toBeGreaterThan(Date.parse(before.observedAtVirtual));
    expect(discoveries.at(-1)!.visibleObjectIds).toContain('alice_computer');
    f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_door' } });
    for (let step = 0; step < 10; step++) advance(f.store, 1000);
    const away = observe(f).perception!.objects.find(object => object.id === 'alice_desk')!;
    expect(away.visible).toBe(false); advance(f.store, 5000);
    expect(observe(f).perception!.objects.find(object => object.id === 'alice_desk')).toEqual(away);
  });

  it('keeps a departed peer at the last observed position instead of remotely refreshing their current body or private room', () => {
    const f = fixture([{ x: 14, y: 25 }, { x: 17, y: 25 }]);
    expect(observe(f).perception!.visibleCompanionIds).toContain('bob');
    const bob = { companionId: 'bob', conversationId: f.store.openPrivate('bob').id };
    f.store.request({ type: 'world.tool', ...bob, arguments: { action: 'move', destinationId: 'park_tree_east' } });
    let perception = observe(f).perception!;
    for (let step = 0; step < 20 && perception.visibleCompanionIds.includes('bob'); step++) { advance(f.store, 1000); perception = observe(f).perception!; }
    const last = perception.people.find(person => person.companionId === 'bob')!; expect(last.visible).toBe(false);
    advance(f.store, 6000); const later = observe(f);
    expect(later.perception!.people.find(person => person.companionId === 'bob')).toEqual(last);
    expect(later.actors.some(actor => actor.companionId === 'bob')).toBe(false);
    expect(f.store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'bob')!.position).not.toEqual(last.position);
  });

  it('samples once per real second regardless of observer polling and coalesces same-scene durable changes', () => {
    const f = fixture(), before = records(f.filename), beforeLog = read<unknown[]>(f.filename, "SELECT id FROM companion_world_events WHERE json_extract(data,'$.kind')='perception' AND json_extract(data,'$.actorId')='alice'").length;
    for (let poll = 0; poll < 40; poll++) { f.store.request({ type: 'world.snapshot' }); observe(f); }
    expect(records(f.filename)).toEqual(before);
    advance(f.store, 500); for (let poll = 0; poll < 20; poll++) observe(f);
    expect(records(f.filename)).toEqual(before); advance(f.store, 500);
    expect(records(f.filename).map(row => row.samples)).toEqual(before.map(row => row.samples + 1));
    f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_computer' } });
    for (let step = 0; step < 8; step++) advance(f.store, 1000);
    f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_door' } });
    for (let step = 0; step < 3; step++) advance(f.store, 1000);
    const events = read<Array<{ data: string }>>(f.filename, "SELECT data FROM companion_world_events WHERE json_extract(data,'$.kind')='perception' AND json_extract(data,'$.actorId')='alice' ORDER BY sequence");
    expect(events.length - beforeLog).toBeLessThanOrEqual(1);
    for (let index = 1; index < events.length; index++) expect(Date.parse(JSON.parse(events[index]!.data).realAt) - Date.parse(JSON.parse(events[index - 1]!.data).realAt)).toBeGreaterThanOrEqual(10000);
  });

  it('restores bounded knowledge and samples only the reached present without fabricating sightings along an offline route', () => {
    const f = fixture(); f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'travel', targetSceneId: 'park' } });
    const before = records(f.filename), stoppedAt = Date.now(); f.store.close(); stores.delete(f.store); vi.setSystemTime(stoppedAt + 120000);
    const reopened = new CompanionsStore(f.filename, f.roles); stores.add(reopened);
    const subjective = reopened.request({ type: 'world.observe', ...f.scope }).world!, after = records(f.filename);
    expect(subjective.perception!.sceneId).toBe('park');
    expect(subjective.perception!.objects.some(object => object.id === 'bob_building')).toBe(false);
    expect(after.every(row => row.samples <= before.find(previous => previous.companion_id === row.companion_id)!.samples + 1)).toBe(true);
    expect(after.every(row => { const value = JSON.parse(row.data) as CompanionWorldPerception; return value.objects.length <= 256 && value.people.length <= 64; })).toBe(true);
    const fresh = read<Array<{ data: string }>>(f.filename, `SELECT data FROM companion_world_events WHERE json_extract(data,'$.kind')='perception' AND json_extract(data,'$.realAt')>'${new Date(stoppedAt).toISOString()}'`);
    expect(fresh.every(row => JSON.parse(row.data).realAt === new Date().toISOString())).toBe(true);
    const authority = read<Array<{ data: string }>>(f.filename, 'SELECT data FROM companion_world')[0]!.data;
    expect(authority).not.toContain('visibleObjectIds'); expect(authority).not.toContain('firstObservedAt');
  });

  it('rolls back world movement, perception samples and events together if a later actor perception write fails', () => {
    const f = fixture(); f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_computer' } });
    const before = audit(f.filename), fault = new Sqlite(f.filename);
    try { fault.exec("CREATE TRIGGER fail_subjective_sample BEFORE UPDATE ON companion_world_perceptions WHEN NEW.companion_id='bob' BEGIN SELECT RAISE(ABORT,'injected perception write failure'); END"); } finally { fault.close(); }
    vi.setSystemTime(Date.now() + 11000);
    expect(() => f.store.request({ type: 'world.tick', snapshot: true })).toThrow('injected perception'); expect(audit(f.filename)).toEqual(before);
    const repair = new Sqlite(f.filename); try { repair.exec('DROP TRIGGER fail_subjective_sample'); } finally { repair.close(); }
    const world = f.store.request({ type: 'world.tick', snapshot: true }).world!;
    expect(world.actors.find(actor => actor.companionId === 'alice')!.position).toEqual({ x: 4, y: 4 });
    expect(records(f.filename).map(row => row.samples)).toEqual(before.perceptions.map(row => row.samples + 1));
    expect(knowledge(f.filename).observedAtReal).toBe(new Date().toISOString());
  });

  it('does not accumulate encounter probability for two nearby bodies hidden behind a real tree', () => {
    const f = fixture([{ x: 41, y: 9 }, { x: 44, y: 9 }], true);
    expect(observe(f).perception!.visibleCompanionIds).not.toContain('bob');
    for (let step = 0; step < 30; step++) advance(f.store, 1000);
    expect(read<unknown[]>(f.filename, 'SELECT * FROM companion_world_encounters')).toEqual([]);
    expect(read<unknown[]>(f.filename, "SELECT * FROM companion_world_jobs WHERE json_extract(data,'$.encounterMemberIds') IS NOT NULL")).toEqual([]);
    expect(() => f.store.request({ type: 'world.tool', ...f.scope,
      arguments: { action: 'social', targetCompanionId: 'bob', kind: 'talk', text: '树后面看不见你，不能假装已经当面交谈。' } })).toThrow('5格');
    expect(read<unknown[]>(f.filename, 'SELECT * FROM companion_social_messages')).toEqual([]);
    const room = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    expect(() => f.store.request({ type: 'social.send', companionId: 'alice', conversationId: room.id, channel: 'face_to_face',
      content: '即使绕过世界工具，也不能隔着树进行当面交流。', clientId: 'occluded-direct-face' })).toThrow('5格');
    expect(read<unknown[]>(f.filename, "SELECT * FROM companion_social_outbox WHERE client_id='occluded-direct-face'")).toEqual([]);
    expect(f.store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.total).toBe(0);
    const phone = { type: 'social.send' as const, companionId: 'alice', conversationId: room.id, channel: 'phone' as const,
      content: '我看不见你，先给你发条手机消息。', clientId: 'occluded-phone' };
    expect(f.store.request(phone).socialMessage).toBeUndefined(); advance(f.store, 1300);
    const delivered = f.store.request(phone).socialMessage!;
    expect(delivered.channel).toBe('phone');
    expect(f.store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.items.map(message => message.channel)).toEqual(['phone']);
  });

  it('treats fresh rain as strong evidence but lets old rain fade into a cautious unknown-weather opportunity', () => {
    const f = indoors(), rule = f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: {
      title: '核验有限天气见闻', enabled: true, startMinute: 0, endMinute: 1440, probability: .01, action: 'park_walk', durationMinutes: 35 } }).lifeRule!;
    const multiplier = () => {
      f.store.request({ type: 'life-event.tick' });
      return f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(occurrence => occurrence.ruleId === rule.id)!.multiplier;
    };
    rememberWeather(f, 'rain'); const freshRain = multiplier();
    rememberWeather(f, 'rain', 120); const oldRain = multiplier();
    rememberWeather(f); const unknown = multiplier();
    rememberWeather(f, 'clear'); const freshClear = multiplier();
    expect(freshRain).toBe(0); expect(unknown).toBeGreaterThan(0);
    expect(oldRain).toBeGreaterThan(unknown * .95); expect(oldRain).toBeLessThanOrEqual(unknown);
    expect(unknown).toBeCloseTo(freshClear * .4, 8);
    expect(observe(f).perception!.position).toEqual({ x: 4, y: 4 });
  });

  it('can leave home without knowing the actual rain, then turns back only after entering outdoors without earning park relaxation', () => {
    const rainyAt = Array.from({ length: 31 }, (_, index) => Date.UTC(2026, 9, index + 1, 10))
      .find(at => companionWorldEnvironment(at, 'UTC').environment.weather === 'rain');
    expect(rainyAt).toBeDefined(); vi.setSystemTime(rainyAt!);
    const f = indoors(); rememberWeather(f);
    expect(observe(f).perception!.environment.weather).toBeUndefined();
    expect(f.store.request({ type: 'world.snapshot' }).world!.environment.weather).toBe('rain');
    const rule = f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: {
      title: '出门确认天气再散步', enabled: true, startMinute: 600, endMinute: 610, probability: 1, checkIntervalMinutes: 1, action: 'park_walk', durationMinutes: 35 } }).lifeRule!;
    f.store.request({ type: 'life-event.tick' });
    const occurrence = f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(value => value.ruleId === rule.id)!;
    // Seed only the random clock's threshold; all perception, dispatch and body movement remain authoritative.
    const db = new Sqlite(f.filename); try { db.prepare('UPDATE companion_life_occurrences SET data=? WHERE id=?').run(JSON.stringify({ ...occurrence, threshold: 1e-9 }), occurrence.id); } finally { db.close(); }
    // Realtime mode must actually reach the configured one-minute evaluation.
    advance(f.store, 60000); const claimed = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!;
    expect(claimed.ruleId).toBe(rule.id);
    expect(f.store.request({ type: 'life-event.complete', id: claimed.id, leaseToken: claimed.leaseToken! }).lifeOccurrence!.status).toBe('active');
    let world = f.store.request({ type: 'world.snapshot' }).world!, subject = world.actors.find(actor => actor.companionId === 'alice')!;
    expect(subject).toMatchObject({ sceneId: 'home_alice', parkWalk: { stage: 'travelling', participatedMinutes: 0 } });
    for (let step = 0; step < 60 && subject.sceneId === 'home_alice' && subject.parkWalk?.stage === 'travelling'; step++) {
      expect(['travelling', 'returning']).toContain(subject.parkWalk?.stage); world = advance(f.store, 500); subject = world.actors.find(actor => actor.companionId === 'alice')!;
    }
    expect(world.events.some(event => event.kind === 'park_walk_interrupted' && event.sceneId === 'park')).toBe(true); world = advance(f.store, 500); subject = world.actors.find(actor => actor.companionId === 'alice')!;
    expect(subject.parkWalk).toMatchObject({ stage: 'returning', participatedMinutes: 0 });
    expect(world.events.find(event => event.kind === 'park_walk_interrupted')).toMatchObject({ sceneId: 'park', text: expect.stringContaining('散步0分钟') });
    expect(world.events.some(event => ['park_walk_enter', 'park_walk_relax', 'park_walk_complete'].includes(event.kind))).toBe(false);
    for (let step = 0; step < 60 && subject.parkWalk; step++) { world = advance(f.store, 500); subject = world.actors.find(actor => actor.companionId === 'alice')!; }
    expect(subject.parkWalk).toBeUndefined(); expect(subject.sceneId).toBe('home_alice');
    expect(f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(value => value.id === claimed.id)).toMatchObject({ status: 'cancelled', result: expect.stringContaining('实际散步0分钟') });
  });

  it('retires old knowledge in bounded cleanup and gives an explicitly created new identity fresh local awareness', async () => {
    const f = fixture([{ x: 18, y: 26 }, { x: 20, y: 26 }]); expect(knowledge(f.filename).visibleObjectIds).toContain('park_bench');
    const job = f.store.request({ type: 'companion.retire', id: 'alice', scope: 'all' }).reset!;
    f.store.request({ type: 'companion.retire.cleanup', id: 'alice', jobId: job.id });
    for (let step = 0; step < 1000 && f.store.request({ type: 'companion.retire.status', id: 'alice' }).reset!.status !== 'completed'; step++) await f.store.advanceReset();
    expect(f.store.request({ type: 'companion.retire.status', id: 'alice' }).reset!.status).toBe('completed');
    expect(records(f.filename).some(row => row.companion_id === 'alice')).toBe(false);
    expect(() => f.store.openPrivate('alice')).toThrow('伙伴不存在或已移除');
    expect(() => observe(f)).toThrow();
    const peerBefore = records(f.filename).find(row => row.companion_id === 'bob');
    const owner = f.store.createCompanion({ name: 'New Alice', description: '', persona: '认真观察周围', model: '', avatar: 'sister', proactive: false });
    expect(owner.id).not.toBe('alice'); f.store.setCompanionActive(owner.id, true);
    const freshScope = { companionId: owner.id, conversationId: f.store.openPrivate(owner.id).id };
    const fresh = f.store.request({ type: 'world.observe', ...freshScope }).world!.perception!;
    expect(records(f.filename).find(row => row.companion_id === 'bob')).toEqual(peerBefore);
    expect(fresh.sceneId).toBe('home_' + owner.id); expect(fresh.objects.some(object => object.id === 'park_bench')).toBe(false);
    expect(fresh.people.some(person => person.companionId === 'bob')).toBe(false);
  });
});
