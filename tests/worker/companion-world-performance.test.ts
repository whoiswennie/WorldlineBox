import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
interface PressureDatabase { transaction(fn: () => void): () => void; prepare(sql: string): { run(...values: unknown[]): unknown; get(): unknown }; close(): void }
const PressureSqlite = BetterSqlite3 as { new(filename: string, options?: { readonly: boolean }): PressureDatabase };

// Explicit opt-in because this creates a sizeable synthetic audit history and
// exercises a hundred thousand real authority ticks, not a renderer-only loop.
it.runIf(process.env.COMPANION_WORLD_STRESS === '1')('keeps 50k events and 100k ended works out of the live tick state', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-pressure-')), filename = path.join(root, 'messages.sqlite');
  const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '压力验证', description: '', model: '', avatar: 'sister', proactive: false }));
  let store: CompanionsStore | undefined;
  try {
    store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true }))); const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
    const conversation = store.openPrivate('alice'), source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '合成压力测试来源。' });
    store.close(); store = undefined;
    // Transfer the connection only while the UtilityProcess store is closed.
    const database = new PressureSqlite(filename);
    database.transaction(() => {
      const event = database.prepare('INSERT INTO companion_world_events(id,data) VALUES(?,?)'), work = database.prepare('INSERT INTO companion_world_work_records(work_id,companion_id,status,data) VALUES(?,?,?,?)');
      for (let index = 0; index < 50000; index++) event.run('pressure_event_' + index, JSON.stringify({ id: 'pressure_event_' + index, sequence: index + 1, kind: 'audit', actorId: 'alice', at: source.createdAt, realAt: source.createdAt, text: '合成虚拟审计事件。', simulation: true }));
      for (let index = 0; index < 100000; index++) work.run('pressure_work_' + index, 'alice', 'ended', JSON.stringify({ workId: 'pressure_work_' + index, companionId: 'alice', conversationId: conversation.id, sourceMessageId: source.id, kind: 'chat', status: 'ended', urgent: false, fixed: false }));
    })(); database.close();
    store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true })));
    const start = Date.now(), measured = performance.now();
    for (let index = 1; index <= 100000; index++) {
      vi.setSystemTime(start + index * 10);
      store.request({ type: 'world.tick' });
    }
    const elapsedMs = performance.now() - measured, snapshot = store.request({ type: 'world.snapshot' }).world!;
    expect(snapshot.events.length).toBeLessThanOrEqual(100); expect(snapshot.works).toHaveLength(0);
    store.close(); store = undefined;
    const audit = new PressureSqlite(filename, { readonly: true });
    const live = JSON.parse(String((audit.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }).data)) as { works: unknown[]; peerLedger?: unknown };
    expect(live.works).toEqual([]); expect(live.peerLedger).toBeUndefined();
    expect((audit.prepare('SELECT COUNT(*) AS n FROM companion_world_work_records').get() as { n: number }).n).toBe(100000);
    expect((audit.prepare('SELECT COUNT(*) AS n FROM companion_world_events').get() as { n: number }).n).toBeGreaterThanOrEqual(50000);
    audit.close(); console.info(JSON.stringify({ worldPressure: { events: 50000, endedWorks: 100000, advancingTicks: 100000, elapsedMs: Math.round(elapsedMs), averageTickMs: elapsedMs / 100000 } }));
    expect(elapsedMs).toBeLessThan(120000);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); }
}, 180000);
