import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { advanceCompanionWorldEnergy, companionWorldEnvironment, companionWorldVirtualAt } from '../../src/shared/companion-world-engine';
import type { CompanionWorldSettings } from '../../src/shared/companion-world';
import type { CompanionRoutineConfig } from '../../src/shared/companion-routine';
import { evaluateCompanionRoutine } from '../../src/shared/companion-routine-time';

const Sqlite = BetterSqlite3 as { new(filename: string, options?: { readonly: boolean }): CompanionConnection };
const seed: CompanionSeed = { id: 'alice', name: 'Alice', persona: '认真友好', description: '', model: '', avatar: 'sister', proactive: false };
const roots: string[] = [], connections = new Set<{ close(): void }>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const connection of connections) connection.close(); connections.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const row = (value: unknown) => value as Record<string, string | number>;
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-observation-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, [{ ...seed, active: true }]); connections.add(store);
  const scope = { companionId: seed.id, conversationId: store.openPrivate(seed.id).id };
  const settings = store.request({ type: 'world.snapshot' }).world!.settings;
  store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  return { filename, store, scope };
}
function close(connection: { close(): void }) { connection.close(); connections.delete(connection); }

it('observes only the materialized world clock and physical recovery while a long offline interval is still catching up', () => {
  const f = fixture(), start = Date.now();
  // This is a real saved world advanced through its ordinary bounded tick, not
  // an injected snapshot or a modified cursor. The huge interval must backlog.
  vi.setSystemTime(start + 365 * 86400000);
  const world = f.store.request({ type: 'world.tick', snapshot: true }).world!;
  expect(world.backlog).toBe(true); expect(world.clock.realNow).toBe(new Date().toISOString());
  close(f.store); const db = new Sqlite(f.filename, { readonly: true }); connections.add(db);
  const authority = JSON.parse(String(row(db.prepare('SELECT data FROM companion_world WHERE id=1').get()).data)) as {
    cursor: number; anchors: Array<{ realAt: number; virtualAt: number; settings: CompanionWorldSettings }>;
  };
  const anchor = authority.anchors[0]!, materializedVirtual = companionWorldVirtualAt(anchor, anchor.settings, authority.cursor);
  expect(authority.cursor).toBeLessThan(Date.now() - 86400000);
  expect(Date.parse(world.clock.virtualNow)).toBeCloseTo(materializedVirtual, -1);
  const climate = companionWorldEnvironment(materializedVirtual, 'UTC');
  expect(world.environment).toEqual(climate.environment);
  expect(world.clock).toMatchObject(climate.clock);
  const actor = world.actors[0]!;
  const state = row(db.prepare('SELECT data,energy_clock FROM companion_runtime_states WHERE companion_id=?').get(seed.id));
  expect(Number(state.energy_clock)).toBeLessThanOrEqual(authority.cursor);
  const windows = (db.prepare('SELECT starts_at,ends_at,phase FROM companion_world_occupancy WHERE companion_id=? ORDER BY starts_at').all(seed.id) as Array<Record<string, string | number | null>>)
    .map(value => ({ start: Number(value.starts_at), end: Math.min(authority.cursor, Number(value.ends_at ?? authority.cursor)), phase: value.phase as 'sleeping' }));
  expect(windows.every(window => window.start <= authority.cursor && window.end <= authority.cursor)).toBe(true);
  const expectedEnergy = advanceCompanionWorldEnergy(windows, start, authority.cursor, 100, at => companionWorldVirtualAt(anchor, anchor.settings, at));
  expect(actor.state.energy).toBeCloseTo(expectedEnergy, 5);
  expect(JSON.parse(String(state.data)).energy).toBe(actor.state.energy);
  expect(actor.state.thermalComfort).toBeCloseTo(Math.max(0, 1 - Math.abs(climate.environment.indoorTemperature - 22) / 15), 10);
  expect(Number(row(db.prepare("SELECT COUNT(*) AS n FROM companion_world_jobs WHERE status='done'").get()).n)).toBe(0);
  expect(world.events.some(event => event.kind === 'dream' || event.kind.startsWith('social_'))).toBe(false);
});

it('perceives actual rain and cold while walking outside once per climate change, without changing player relationship', () => {
  const rainy = Array.from({ length: 31 }, (_, index) => Date.parse('2026-01-01T10:00:00Z') + index * 86400000)
    .find(at => { const value = companionWorldEnvironment(at, 'UTC').environment; return value.weather === 'rain' && value.outdoorTemperature < 10; })!;
  expect(rainy).toBeTypeOf('number'); vi.setSystemTime(rainy);
  const f = fixture(), initial = f.store.request({ type: 'world.snapshot' }).world!;
  f.store.request({ type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'realtime' } });
  const before = f.store.request({ type: 'state.get', ...f.scope }).runtimeState!;
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'travel', targetSceneId: 'park' } });
  vi.setSystemTime(Date.now() + 5000); f.store.request({ type: 'world.tick' });
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'park_tree_east' } });
  vi.setSystemTime(Date.now() + 10000);
  const walking = f.store.request({ type: 'world.tick', snapshot: true }).world!, actor = walking.actors[0]!;
  expect(actor).toMatchObject({ sceneId: 'park', activity: 'walking' }); expect(actor.route.length).toBeGreaterThan(0);
  const perceived = walking.events.filter(event => event.kind === 'environment' && event.actorId === seed.id);
  expect(perceived).toHaveLength(1); expect(perceived[0]!.effect).toMatchObject({ type: 'stress' });
  vi.setSystemTime(Date.now() + 120000);
  const arrived = f.store.request({ type: 'world.tick', snapshot: true }).world!;
  expect(arrived.actors[0]!.route).toEqual([]);
  expect(arrived.events.filter(event => event.kind === 'environment' && event.actorId === seed.id)).toHaveLength(1);
  const after = f.store.request({ type: 'state.get', ...f.scope }).runtimeState!;
  expect(after.affect.pleasure).toBeLessThan(before.affect.pleasure);
  expect(after.relationship).toEqual(before.relationship);
});

it.each(['routine.get', 'state.get'] as const)('returns one materialized instant for %s during bounded offline catch-up', type => {
  const f = fixture(); vi.setSystemTime(Date.now() + 365 * 86400000);
  const response = f.store.request({ type, ...f.scope });
  const runtime = response.routine?.runtime ?? response.runtimeState!.routine!;
  close(f.store); const db = new Sqlite(f.filename, { readonly: true }); connections.add(db);
  const saved = JSON.parse(String(row(db.prepare('SELECT data FROM companion_world WHERE id=1').get()).data)) as {
    cursor: number; anchors: Array<{ realAt: number; virtualAt: number; settings: CompanionWorldSettings }>;
    actors: Array<{ activity: string; transition?: unknown }>;
  };
  const config = JSON.parse(String(row(db.prepare('SELECT data FROM companion_routines WHERE companion_id=?').get(seed.id)).data)).config as CompanionRoutineConfig;
  const anchor = saved.anchors[0]!, virtualAt = companionWorldVirtualAt(anchor, anchor.settings, saved.cursor);
  const planned = evaluateCompanionRoutine(config, new Date(virtualAt).toISOString());
  expect(runtime.plannedPhase).toBe(planned.phase);
  const actor = saved.actors[0]!;
  const actual = !actor.transition && ['sleeping', 'eating', 'resting', 'habit'].includes(actor.activity) ? actor.activity : 'awake';
  expect(runtime.phase).toBe(actual);
  if (response.runtimeState) expect(Date.parse(response.runtimeState.updatedAt)).toBeCloseTo(saved.cursor, -1);
});
