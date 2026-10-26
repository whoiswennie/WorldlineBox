import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { companionWorldTimeSchema } from '../../src/shared/companion-world';

it('peeks persisted world time without advancing or rolling jobs while preserving the original advancing clock API', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T08:00:00.000Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-clock-peek-')), file = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(file, [{ id: 'alice', name: 'Alice', description: '', persona: '认真', model: '', avatar: 'sister', active: true, proactive: false }]);
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try {
    store.request({ type: 'world.tick' });
    const initial = store.request({ type: 'world.clock.peek' }).worldClock!;
    const state = db.prepare('SELECT data FROM companion_world WHERE id=1').get(), version = db.prepare('PRAGMA data_version').get();
    const jobs = db.prepare('SELECT COUNT(*) AS n FROM companion_world_jobs').get(), admission = db.prepare('SELECT COUNT(*) AS n FROM companion_memory_maintenance_sessions').get();
    const base = Date.now();
    for (const lag of [500, 4_900, 5_000]) {
      vi.setSystemTime(base + lag);
      const observed = store.request({ type: 'world.clock.peek' }).worldClock!;
      const overview = store.request({ type: 'life.overview.read', companionId: 'alice', filter: 'all', limit: 20 }).lifeOverviewContext!;
      expect(observed.backlog, `ordinary tick delay ${lag}ms`).toBe(false);
      expect(overview.clock.backlog, `overview tick delay ${lag}ms`).toBe(false);
      expect(observed.virtualNow).toBe(new Date().toISOString()); expect(overview.clock.virtualNow).toBe(observed.virtualNow);
    }
    vi.setSystemTime(base + 3_600_000);
    for (let n = 0; n < 5; n++) {
      const observed = store.request({ type: 'world.clock.peek' }).worldClock!;
      const overview = store.request({ type: 'life.overview.read', companionId: 'alice', filter: 'all', limit: 20 }).lifeOverviewContext!;
      expect(companionWorldTimeSchema.parse(observed)).toEqual(observed);
      expect(observed.virtualNow).toBe(new Date().toISOString()); expect(observed.backlog).toBe(true);
      expect(overview.clock.virtualNow).toBe(observed.virtualNow); expect(overview.clock.backlog).toBe(true);
      expect(overview.clock.observedRealAt).toBe(initial.realNow);
    }
    expect(db.prepare('SELECT data FROM companion_world WHERE id=1').get()).toEqual(state);
    expect(db.prepare('PRAGMA data_version').get()).toEqual(version);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_world_jobs').get()).toEqual(jobs);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_memory_maintenance_sessions').get()).toEqual(admission);
    store.request({ type: 'world.clock' });
    expect(db.prepare('SELECT data FROM companion_world WHERE id=1').get()).not.toEqual(state);
  } finally {
    db.close(); store.close(); vi.useRealTimers();
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-clock-peek-')) removeOwnedDirectorySync(root);
  }
});
