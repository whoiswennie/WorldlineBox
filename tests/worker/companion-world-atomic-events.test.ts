import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionWorldStore } from '../../src/companions/world-store';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const Sqlite = BetterSqlite3 as { new(filename: string): CompanionConnection };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { vi.restoreAllMocks(); for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-atomic-events-')); roots.push(root); const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, [{ id: 'alice', name: 'Alice', persona: '喜欢散步，认真生活。', description: '', model: '', avatar: 'sister', active: true, proactive: true }]); stores.add(store);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'compressed', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  store.request({ type: 'world.snapshot' });
  return { store, scope, filename };
}

/** Read committed authority, including tables that must roll back with actor state. */
function committed(filename: string) {
  const db = new Sqlite(filename);
  try {
    return { world: db.prepare('SELECT data FROM companion_world WHERE id=1').get(),
      events: db.prepare('SELECT sequence,id,data FROM companion_world_events ORDER BY sequence').all(),
      occupancy: db.prepare('SELECT * FROM companion_world_occupancy ORDER BY id').all(),
      works: db.prepare('SELECT * FROM companion_world_work_records ORDER BY work_id').all(),
      visits: db.prepare('SELECT * FROM companion_world_visit_records ORDER BY id').all() };
  } finally { db.close(); }
}

function failSaveWhen(predicate: (state: { works: Array<{ workId: string; status: string }> }) => boolean) {
  const prototype = CompanionWorldStore.prototype as unknown as { save(state: { works: Array<{ workId: string; status: string }> }): void }, save = prototype.save;
  return vi.spyOn(prototype, 'save').mockImplementation(function (this: typeof prototype, state) {
    if (predicate(state)) throw new Error('injected durable world write failure');
    return save.call(this, state);
  });
}

it('persists one primitive transition identity and confirms completion only after its physical deadline', () => {
  const f = fixture();
  const moving = f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_sofa' } }).world!;
  const started = moving.events.findLast(event => event.behavior?.phase === 'started' && event.behavior.kind === 'turning')!;
  expect(started?.behavior?.id).toBeTruthy();
  for (let index = 0; index < 4; index++) {
    vi.setSystemTime(Date.now() + 100);
    const during = f.store.request({ type: 'world.tick', snapshot: true }).world!;
    expect(during.events.filter(event => event.behavior?.id === started.behavior!.id)).toHaveLength(1);
  }
  vi.setSystemTime(Date.now() + 600);
  const after = f.store.request({ type: 'world.tick', snapshot: true }).world!;
  expect(after.events.filter(event => event.behavior?.id === started.behavior!.id).map(event => event.behavior?.phase)).toEqual(['started', 'completed']);
  expect(after.events.find(event => event.behavior?.id === started.behavior!.id && event.behavior.phase === 'completed')?.behavior?.kind).toBe('turning');
});

it('rolls back new work movement, its events, occupancy and durable work rows when admission persistence fails', () => {
  const f = fixture(), source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请处理这份正式工作。', replyDirective: 'none' });
  f.store.request({ type: 'world.snapshot' }); const before = committed(f.filename);
  const fault = failSaveWhen(state => state.works.some(work => work.workId === 'atomic_begin'));
  expect(() => f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'atomic_begin', kind: 'action', sourceMessageId: source.id })).toThrow('injected durable');
  fault.mockRestore(); expect(committed(f.filename)).toEqual(before);
  const resumed = f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'atomic_begin', kind: 'action', sourceMessageId: source.id }).worldWork!;
  expect(resumed.status).toBe('moving');
  expect(f.store.request({ type: 'world.snapshot' }).world!.events.filter(event => event.kind === 'move' && event.actorId === 'alice')).toHaveLength(1);
});

it('rolls back work cancellation and its terminal event together, then accepts a clean retry', () => {
  const f = fixture(), source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请完成这项工作。', replyDirective: 'none' });
  f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'atomic_end', kind: 'action', sourceMessageId: source.id });
  f.store.request({ type: 'world.snapshot' }); const before = committed(f.filename);
  const fault = failSaveWhen(state => state.works.some(work => work.workId === 'atomic_end' && work.status === 'ended'));
  expect(() => f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'atomic_end' })).toThrow('injected durable');
  fault.mockRestore(); expect(committed(f.filename)).toEqual(before);
  expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'atomic_end' }).worldWork!.status).not.toBe('ended');
  expect(f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'atomic_end' }).worldWork!.status).toBe('ended');
  expect(f.store.request({ type: 'world.snapshot' }).world!.events.filter(event => event.kind === 'work_end' && event.actorId === 'alice')).toHaveLength(1);
});

it('rejects an impossible replacement without cancelling the existing physical park composite or leaking interruption events', () => {
  const f = fixture();
  for (const rule of f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeRules!) f.store.request({ type: 'life-rule.remove', companionId: 'alice', id: rule.id, expectedRevision: rule.revision });
  f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '原有散步活动', action: 'park_walk', startMinute: 600, endMinute: 602, probability: 1, durationMinutes: 35 } });
  f.store.request({ type: 'life-event.tick' });
  vi.setSystemTime(Date.now() + 1600); f.store.request({ type: 'world.tick' });
  const claim = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!;
  expect(claim?.rule.action).toBe('park_walk'); f.store.request({ type: 'life-event.complete', id: claim.id, leaseToken: claim.leaseToken! });
  const physical = f.store.request({ type: 'world.snapshot' }).world!, subject = (world: CompanionWorldSnapshot) => world.actors.find(actor => actor.companionId === 'alice')!;
  expect(subject(physical).parkWalk?.stage).toBe('travelling'); const before = committed(f.filename);
  expect(() => f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'nonexistent_destination' } })).toThrow('地点不存在');
  expect(committed(f.filename)).toEqual(before);
  const after = f.store.request({ type: 'world.snapshot' }).world!;
  expect(subject(after).parkWalk).toEqual(subject(physical).parkWalk); expect(subject(after).route).toEqual(subject(physical).route);
  expect(after.events.some(event => event.kind === 'park_walk_interrupted')).toBe(false);
});
