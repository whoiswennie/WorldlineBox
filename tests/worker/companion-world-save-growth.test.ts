import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { CompanionWorldStore } from '../../src/companions/world-store';
import type { CompanionWorldSettings } from '../../src/shared/companion-world';

const Sqlite = BetterSqlite3 as { new(filename: string, options?: { readonly: boolean }): CompanionConnection };
const seeds: CompanionSeed[] = ['alice', 'bob', 'carol'].map(id => ({ id, name: id, persona: '尊重彼此边界。', description: '', model: '', avatar: 'sister', proactive: true }));
const roots: string[] = [], connections = new Set<{ close(): void }>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => {
  for (const connection of connections) connection.close(); connections.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-save-growth-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true }))); connections.add(store);
  const scopes = Object.fromEntries(seeds.map(seed => [seed.id, { companionId: seed.id, conversationId: store.openPrivate(seed.id).id }]));
  const settings = store.request({ type: 'world.snapshot' }).world!.settings;
  store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const scope of Object.values(scopes)) {
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
  return { store, filename, alice: scopes.alice!, bob: scopes.bob!, carol: scopes.carol! };
}
function close(connection: { close(): void }) { connection.close(); connections.delete(connection); }
function audit(filename: string) { const db = new Sqlite(filename, { readonly: true }); connections.add(db); return db; }
const record = (value: unknown) => value as Record<string, string | number>;

it('retains the full visit audit but only active permission and recent settled visits in a long-running save', () => {
  const f = fixture();
  const visit = (scope = f.carol) => {
    const world = f.store.request({ type: 'world.tool', ...scope, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '真实拜访历史：' + Date.now() } }).world!;
    return world.visits.find(value => value.guestId === scope.companionId && value.status === 'requested')!;
  };
  const expired = visit(); vi.setSystemTime(Date.now() + 6 * 3600000 + 1); f.store.request({ type: 'world.tick' });
  const allowed = visit(f.alice);
  f.store.request({ type: 'world.tool', ...f.bob, arguments: { action: 'respond', requestId: allowed.id, decision: 'allow', reason: '这项仍然有效的许可不能被历史窗口挤掉。' } });
  const deniedIds: string[] = [];
  for (let index = 0; index < 360; index++) {
    vi.setSystemTime(Date.now() + 1); const pending = visit(); deniedIds.push(pending.id);
    f.store.request({ type: 'world.tool', ...f.bob, arguments: { action: 'respond', requestId: pending.id, decision: 'deny', reason: '本次不方便：' + index } });
  }
  const left = visit(); f.store.request({ type: 'world.tool', ...f.carol, arguments: { action: 'leave' } });
  const pending = visit(), world = f.store.request({ type: 'world.snapshot' }).world!;
  expect(world.visits).toHaveLength(102);
  expect(world.visits.find(value => value.id === allowed.id)?.status).toBe('allowed');
  expect(world.visits.find(value => value.id === pending.id)?.status).toBe('requested');
  expect(world.visits.find(value => value.id === left.id)?.status).toBe('left');
  expect(world.visits.some(value => value.id === deniedIds[0])).toBe(false);
  // The retained permission must still authorize actual physical entry.
  f.store.request({ type: 'world.tool', ...f.bob, arguments: { action: 'share_entrance', recipientIds: ['alice'] } });
  f.store.request({ type: 'social.job.claim' }); vi.setSystemTime(Date.now() + 1600); f.store.request({ type: 'world.tick' }); const delivery = f.store.request({ type: 'social.job.claim' });
  if (delivery.socialJob) { vi.setSystemTime(Date.now() + 1600); f.store.request({ type: 'world.tick' }); f.store.request({ type: 'social.job.complete', id: delivery.socialJob.id, leaseToken: delivery.socialJob.leaseToken!, text: null }); }
  vi.setSystemTime(Date.now() + 6000); f.store.request({ type: 'world.tick' });
  f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'travel', targetSceneId: 'home_' + 'bob' } });
  vi.setSystemTime(Date.now() + 30000); f.store.request({ type: 'world.tick' });
  f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'travel', targetSceneId: 'home_' + 'bob' } });
  vi.setSystemTime(Date.now() + 30000); f.store.request({ type: 'world.tick' });
  expect(f.store.request({ type: 'world.snapshot' }).world!.actors.find(value => value.companionId === 'alice')!.sceneId).toBe('home_bob');
  close(f.store);
  const db = audit(f.filename), hot = JSON.parse(String(record(db.prepare('SELECT data FROM companion_world WHERE id=1').get()).data));
  expect(hot.visits).toHaveLength(102); expect(hot.anchors).toHaveLength(1);
  expect(Number(record(db.prepare('SELECT COUNT(*) AS n FROM companion_world_visit_records').get()).n)).toBe(364);
  const history = (id: string) => JSON.parse(String(record(db.prepare('SELECT data FROM companion_world_visit_records WHERE id=?').get(id)).data));
  expect(history(expired.id).status).toBe('expired'); expect(history(deniedIds[0]!).response).toBe('本次不方便：0'); expect(history(left.id).status).toBe('left');
  close(db);
  const reopened = new CompanionsStore(f.filename, seeds.map(seed => ({ ...seed, active: true }))); connections.add(reopened);
  const restored = reopened.request({ type: 'world.snapshot' }).world!;
  expect(restored.visits).toHaveLength(102); expect(restored.visits.find(value => value.id === allowed.id)?.status).toBe('allowed');
  expect(restored.actors.find(value => value.companionId === 'alice')!.sceneId).toBe('home_bob');
  expect(() => reopened.request({ type: 'world.tool', ...f.bob, arguments: { action: 'respond', requestId: deniedIds[0]!, decision: 'allow', reason: '旧拒绝不能变成新授权。' } })).toThrow();
  vi.setSystemTime(Date.now() + 1);
  const newlyEnded = reopened.request({ type: 'world.tool', ...f.alice, arguments: { action: 'leave' } }).world!;
  // A very old permission that ends now belongs to the recent window, even
  // after hundreds of newer requests have already settled.
  expect(newlyEnded.visits.find(value => value.id === allowed.id)?.status).toBe('left');
  expect(reopened.request({ type: 'world.snapshot' }).world!.visits.filter(value => !['allowed', 'requested'].includes(value.status))).toHaveLength(100);
}, 30000);

it('keeps one hot clock anchor through hundreds of edits while historical real/virtual accounting survives reopening', () => {
  const f = fixture(); let world = f.store.request({ type: 'world.snapshot' }).world!, expected = Date.parse(world.clock.virtualNow), speed = 1;
  const checkpoints: Array<{ real: number; virtual: number; speed: number }> = [];
  for (let index = 0; index < 300; index++) {
    vi.setSystemTime(Date.now() + 1000); expected += 1000 * speed;
    const patch: Partial<CompanionWorldSettings> = index % 2 ? { mode: 'realtime' } : { mode: 'compressed', dayDurationMinutes: 30 };
    if (patch.mode === 'realtime') expected = Date.now();
    world = f.store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch }).world!;
    expect(Date.parse(world.clock.virtualNow)).toBe(expected);
    speed = patch.mode === 'compressed' ? 48 : 1; checkpoints.push({ real: Date.now(), virtual: expected, speed });
  }
  close(f.store); const db = audit(f.filename);
  const hot = JSON.parse(String(record(db.prepare('SELECT data FROM companion_world WHERE id=1').get()).data));
  expect(hot.anchors).toHaveLength(1); expect(Number(record(db.prepare('SELECT COUNT(*) AS n FROM companion_world_clock_segments').get()).n)).toBe(302);
  const unused = () => { throw new Error('Historical clock lookup must not execute world behavior.'); };
  const clock = new CompanionWorldStore(db, unused, unused, unused, unused, unused);
  for (const checkpoint of checkpoints) {
    expect(clock.virtualAt(checkpoint.real)).toBe(checkpoint.virtual);
    expect(clock.realAt(checkpoint.virtual, checkpoint.real)).toBe(checkpoint.real);
  }
  // Verify points inside segments too, not only the exact edit boundaries.
  for (let index = 0; index < checkpoints.length - 1; index++) {
    const a = checkpoints[index]!, b = checkpoints[index + 1]!, mid = (a.real + b.real) / 2, virtual = a.virtual + (mid - a.real) * a.speed;
    expect(clock.virtualAt(mid)).toBe(virtual); expect(clock.realAt(virtual, mid)).toBe(mid);
  }
  close(db); const reopened = new CompanionsStore(f.filename, seeds.map(seed => ({ ...seed, active: true }))); connections.add(reopened);
  expect(reopened.request({ type: 'world.snapshot' }).world!.clock.virtualNow).toBe(world.clock.virtualNow);
}, 30000);

it('rolls back a visit decision and its event when its durable history cannot be written', () => {
  const f = fixture(), pending = f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '原子存档验收。' } }).world!.visits[0]!;
  close(f.store);
  const db = new Sqlite(f.filename); connections.add(db);
  db.exec("CREATE TRIGGER fail_visit_archive BEFORE INSERT ON companion_world_visit_records WHEN NEW.status='denied' BEGIN SELECT RAISE(ABORT,'synthetic disk write failure'); END"); close(db);
  const reopened = new CompanionsStore(f.filename, seeds.map(seed => ({ ...seed, active: true }))); connections.add(reopened);
  const before = reopened.request({ type: 'world.snapshot' }).world!;
  expect(() => reopened.request({ type: 'world.tool', ...f.bob, arguments: { action: 'respond', requestId: pending.id, decision: 'deny', reason: '这次拒绝必须与存档一起提交。' } })).toThrow();
  const after = reopened.request({ type: 'world.snapshot' }).world!;
  expect(after.visits.find(value => value.id === pending.id)?.status).toBe('requested'); expect(after.lastEventSequence).toBe(before.lastEventSequence);
  close(reopened); const persisted = audit(f.filename);
  expect(record(persisted.prepare('SELECT status FROM companion_world_visit_records WHERE id=?').get(pending.id)).status).toBe('requested');
});
