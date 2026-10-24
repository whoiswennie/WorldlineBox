import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed, type CompanionConnection } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionWorldRealAt, companionWorldSpeed, companionWorldVirtualAt } from '../../src/shared/companion-world-engine';
import { COMPANION_SLEEP_DREAM_COOLDOWN_MS } from '../../src/shared/companion-sleep';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '友善', description: '', model: '', avatar: 'sister', proactive: false }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function open(file: string) { const store = new CompanionsStore(file, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store); return store; }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-clock-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite'), store = open(file), settings = store.request({ type: 'world.clock' }).worldClock!;
  expect(settings).toMatchObject({ mode: 'realtime', speed: 1, virtualNow: new Date().toISOString() });
  const revision = store.request({ type: 'world.snapshot' }).world!.settings.revision;
  store.request({ type: 'world.configure', expectedRevision: revision, patch: { timeZone: 'UTC' } });
  return { store, file, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
it('uses real elapsed time and preserves message/source dates through reopening', () => {
  const f = fixture(), start = new Date().toISOString();
  vi.setSystemTime(Date.now() + 60000);
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '我今天买了一盆兰花。', replyDirective: 'none' });
  expect(source.worldCreatedAt).toBe(source.createdAt); expect(source.createdAt).toBe('2026-10-14T10:01:00.000Z');
  f.store.request({ type: 'memory.record', ...f.scope, candidate: { content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
  vi.setSystemTime(Date.now() + 120000);
  const response = companionStorageResponseSchema.parse(f.store.request({ type: 'world.clock', since: [start] }));
  expect(response.worldClock).toMatchObject({ mode: 'realtime', speed: 1, virtualNow: new Date().toISOString(), elapsed: [{ realAt: start, milliseconds: 3 * 60000 }] });
  f.store.close(); stores.delete(f.store); const store = open(f.file);
  expect(store.getMessage(source.id)).toMatchObject({ createdAt: source.createdAt, worldCreatedAt: source.worldCreatedAt });
  const query = { ...f.scope, query: '兰花', from: '2026-10-14T10:00:00Z', to: '2026-10-14T10:30:00Z' };
  expect(store.request({ type: 'memory.browse', ...query, query: '' }).memoryPage!.items).toHaveLength(1);
  expect(store.request({ type: 'memory.sources.filter', ...f.scope, ids: [source.id] }).memorySources!.map(message => message.id)).toEqual([source.id]);
  expect(store.request({ type: 'memory.browse', ...query, query: '', from: '2026-10-14T11:00:00Z', to: '2026-10-14T11:30:00Z' }).memoryPage?.items).toEqual([]);
});
it('migrates legacy offsets and dream cooldowns once without rewriting historical evidence', () => {
  const f = fixture(), now = Date.now(), offset = 30 * 86400000;
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请去 Bob 家分享植物近况。', replyDirective: 'none' });
  f.store.request({ type: 'world.tool', ...f.scope, sourceMessageId: source.id, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '分享植物近况' } });
  f.store.close(); stores.delete(f.store);
  const db = new (Database as { new(file: string): CompanionConnection })(f.file);
  const state = JSON.parse((db.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }).data);
  const settings = { ...state.settings, revision: state.settings.revision + 10, mode: 'compressed', dayDurationMinutes: 20 };
  const anchor = { realAt: now, virtualAt: now + offset, settings };
  state.settings = settings; state.anchors = [anchor]; state.cursor = now;
  state.visits[0].expiresAt = new Date(now + offset + 600000).toISOString();
  for (const actor of state.actors) { actor.lastDecisionAt = now + offset; actor.manualActivityUntil = now + offset + 60000; }
  const suspended = state.actors.find((actor: { companionId: string }) => actor.companionId === 'bob');
  state.actors = state.actors.filter((actor: { companionId: string }) => actor.companionId !== 'bob');
  db.prepare('INSERT INTO companion_world_suspended(companion_id,data) VALUES(?,?)').run('bob', JSON.stringify({ actor: suspended, since: now }));
  const history = db.prepare('SELECT id,data FROM companion_world_events ORDER BY sequence').all();
  db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(state));
  db.prepare('INSERT INTO companion_world_clock_segments(revision,real_at,virtual_at,data) VALUES(?,?,?,?)').run(settings.revision, now, now + offset, JSON.stringify(anchor));
  const historicWorldAt = new Date(now + offset).toISOString();
  db.prepare('UPDATE companion_message_times SET world_at=? WHERE message_id=?').run(historicWorldAt, source.id);
  const oldJob = { id: 'legacy_dream_job', companionId: 'alice', conversationId: f.scope.conversationId,
    kind: 'dream', status: 'done', throughEventSequence: 0, attempts: 1, sourceMemoryIds: [], createdAt: new Date(now - 3600000).toISOString() };
  db.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,data) VALUES(?,?,?,?,?)').run(oldJob.id, 'alice', 'dream', 'done', JSON.stringify(oldJob));
  // Simulate a pre-upgrade row: original virtual timestamp has no real_at yet.
  db.prepare('INSERT INTO companion_world_sleep_episodes(companion_id,episode_id,virtual_at,roll,admitted,job_id) VALUES(?,?,?,?,?,?)').run('alice', 'legacy_sleep', now + offset, 0, 1, oldJob.id);
  db.close();
  const store = open(f.file), real = store.request({ type: 'world.snapshot' }).world!;
  expect(real.settings).toMatchObject({ mode: 'realtime', dayDurationMinutes: 1440, revision: settings.revision + 1 });
  expect(real.clock).toMatchObject({ realNow: new Date(now).toISOString(), virtualNow: new Date(now).toISOString(), speed: 1 });
  expect(Date.parse(real.visits[0]!.expiresAt) - now).toBe(600000);
  expect(store.getMessage(source.id)).toMatchObject({ createdAt: source.createdAt, worldCreatedAt: historicWorldAt });
  const plan = store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!;
  expect(plan.dreamCooldownUntilWorld).toBe(new Date(now - 3600000 + COMPANION_SLEEP_DREAM_COOLDOWN_MS).toISOString());
  const check = new (Database as { new(file: string): CompanionConnection })(f.file);
  expect(check.prepare('SELECT data FROM companion_world_clock_segments WHERE revision=?').get(settings.revision)).toEqual({ data: JSON.stringify(anchor) });
  for (const event of history as { id: string; data: string }[]) expect(check.prepare('SELECT id,data FROM companion_world_events WHERE id=?').get(event.id)).toEqual(event);
  expect(check.prepare('SELECT virtual_at,real_at FROM companion_world_sleep_episodes WHERE episode_id=?').get('legacy_sleep')).toEqual({ virtual_at: now + offset, real_at: now - 3600000 });
  const normalized = JSON.parse((check.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }).data);
  expect(normalized.actors.find((actor: { companionId: string }) => actor.companionId === 'bob').manualActivityUntil).toBe(now + 60000);
  check.close();
  const changed = store.request({ type: 'world.configure', expectedRevision: real.settings.revision, patch: { timeZone: 'America/Los_Angeles' } }).world!;
  expect(changed.settings.timeZone).toBe('America/Los_Angeles');
  for (const companionId of ['alice', 'bob']) {
    const scope = { companionId, conversationId: store.openPrivate(companionId).id };
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    expect(routine.config.timeZone).toBe('America/Los_Angeles'); expect(routine.runtime.plannedPhase).toBe('sleeping');
  }
  store.close(); stores.delete(store);
  expect(open(f.file).request({ type: 'world.snapshot' }).world!.settings.revision).toBe(changed.settings.revision);
});
it('rejects accelerated settings and ignores legacy anchors in clock calculations', () => {
  const f = fixture(), settings = f.store.request({ type: 'world.snapshot' }).world!.settings;
  expect(() => f.store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { mode: 'compressed' } })).toThrow('现实时间');
  expect(() => f.store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { dayDurationMinutes: 20 } })).toThrow('现实时间');
  const legacy = { ...settings, mode: 'compressed' as const, dayDurationMinutes: 5 }, anchor = { realAt: 100, virtualAt: 99999999 };
  expect(companionWorldSpeed(legacy)).toBe(1); expect(companionWorldVirtualAt(anchor, legacy, 500)).toBe(500);
  expect(companionWorldRealAt(anchor, legacy, 750)).toBe(750);
});
it('does not insert a present-day task into the offline past and refuses clock edits until catch-up completes', () => {
  const f = fixture(); vi.setSystemTime(Date.now() + 1000 * 86400000);
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '现在处理这个新任务', replyDirective: 'none' });
  const work = f.store.request({ type: 'world.work.begin', ...f.scope, kind: 'action', workId: 'present_request', sourceMessageId: source.id, fixed: true }).worldWork!;
  expect(work.status).toBe('waiting'); expect(work.reason).toContain('补算');
  expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: work.workId }).worldWork!.status).toBe('waiting');
  const world = f.store.request({ type: 'world.snapshot' }).world!; expect(world.backlog).toBe(true);
  expect(world.events.some(event => event.kind === 'work_ready' || event.kind === 'work_start')).toBe(false);
  expect(world.clock.virtualNow).toBe(new Date().toISOString()); expect(world.clock.speed).toBe(1);
  expect(() => f.store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'UTC' } })).toThrow('补算');
});
