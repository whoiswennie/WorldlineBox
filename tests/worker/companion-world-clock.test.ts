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
afterEach(() => { vi.restoreAllMocks(); for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
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
it('starts with the new maintenance schema and preserves actual narrative cooldown across restart', () => {
  vi.spyOn(Math, 'random').mockReturnValue(.1);
  const f = fixture(), source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '应保留出处的重要学习经历。', replyDirective: 'none' });
  const memory = f.store.request({ type: 'memory.record', ...f.scope, candidate: { content: source.content, tags: ['重要'],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const delivery = f.store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  f.store.request({ type: 'memory.outbox.complete', id: delivery.id, leaseToken: delivery.leaseToken, indexed: true });
  vi.setSystemTime(Date.now() + 6000); f.store.request({ type: 'world.tick' });
  const job = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
  expect(job).toMatchObject({ maintenanceMode: 'background', dreamAllowed: true });
  f.store.request({ type: 'world.job.complete', stage: 'real', id: job.id, leaseToken: job.leaseToken!, sourceMemoryIds: [memory.id] });
  f.store.request({ type: 'world.job.narrative.begin', id: job.id, leaseToken: job.leaseToken! });
  f.store.request({ type: 'world.job.complete', stage: 'dream', id: job.id, leaseToken: job.leaseToken!, dream: { text: '我想象书页化为云朵；这只是清醒联想。',
    relatedMemoryIds: [memory.id], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
  const expectedCooldown = new Date(Date.now() + COMPANION_SLEEP_DREAM_COOLDOWN_MS).toISOString();
  const db = new (Database as { new(file: string): CompanionConnection })(f.file);
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='companion_world_sleep_episodes'").get()).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM companion_memory_maintenance_sessions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM companion_memory_maintenance_sources').get()).toEqual({ n: 1 });
  } finally { db.close(); }
  f.store.close(); stores.delete(f.store); const reopened = open(f.file);
  expect(reopened.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!).toMatchObject({
    admission: 'admitted', dreamCooldownUntilWorld: expectedCooldown, maintenance: { narrativeStatus: 'completed', narrativeAttempts: 1 } });
  expect(reopened.getMessage(source.id)).toMatchObject({ createdAt: source.createdAt, worldCreatedAt: source.worldCreatedAt });
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
