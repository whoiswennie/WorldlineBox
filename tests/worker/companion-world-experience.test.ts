import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { CompanionWorldStore } from '../../src/companions/world-store';
import type { CompanionLifeOccurrence } from '../../src/shared/companion-life-event';
import { shareWorldAddress } from '../helpers/companion-world-address';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '喜欢散步和阅读，谨慎区分经历与推测。', description: '', model: '', avatar: 'sister', active: true, proactive: true }));
const stores = new Set<CompanionsStore>(), roots: string[] = [];
const Sqlite = BetterSqlite3 as { new(filename: string): CompanionConnection };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { vi.restoreAllMocks(); for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-experience-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, seeds); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
    for (const rule of store.request({ type: 'life-rule.list', companionId }).lifeRules!) store.request({ type: 'life-rule.remove', companionId, id: rule.id, expectedRevision: rule.revision });
  }
  for (;;) { const job = store.request({ type: 'memory.jobs.claim', force: true }).memoryJob; if (!job) break;
    store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] }); }
  return { store, filename, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id },
    bob: { companionId: 'bob', conversationId: store.openPrivate('bob').id }, worldScope: { companionId: 'alice', conversationId: 'world_alice' } };
}
function advance(store: CompanionsStore, ms = 1000) { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function startWalk(store: CompanionsStore) {
  store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '实际散步经历', enabled: true, startMinute: 600, endMinute: 610,
    probability: 1, checkIntervalMinutes: 1, action: 'park_walk', durationMinutes: 35 } });
  advance(store, 61000);
  store.request({ type: 'life-event.tick' }); let occurrence: CompanionLifeOccurrence | undefined;
  for (let i = 0; i < 4 && !occurrence; i++) { advance(store, 61000); occurrence = store.request({ type: 'life-event.claim' }).lifeOccurrence; }
  expect(occurrence, JSON.stringify({ rules: store.request({ type: 'life-rule.list', companionId: 'alice' }), world: store.request({ type: 'world.snapshot' }).world?.actors })).toBeDefined(); store.request({ type: 'life-event.complete', id: occurrence!.id, leaseToken: occurrence!.leaseToken! });
}
function finishWalk(store: CompanionsStore) {
  for (let i = 0; i < 160; i++) { const world = advance(store, 15000); const completed = world.events.find(event => event.kind === 'park_walk_complete'); if (completed) return completed; }
  throw new Error('Actual park walk did not complete');
}
function counts(filename: string) {
  const db = new Sqlite(filename);
  try { return { events: db.prepare('SELECT COUNT(*) AS n FROM companion_world_events').get(),
    receipts: db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'memory-world-observation/%' AND json_extract(value,'$.experience.eventId') IS NOT NULL").get(),
    jobs: db.prepare("SELECT COUNT(*) AS n FROM vcp_capture_jobs WHERE conversation_id='world_alice'").get() }; } finally { db.close(); }
}

it('finds a real directory contact when any name or id alias matches and ranks exact names first', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-experience-')); roots.push(root);
  const roles = [
    { ...seeds[0]!, id: 'zhou-lan', name: '周岚', description: '设计伙伴' },
    { ...seeds[1]!, id: 'reader', name: '周岚的读书搭档', description: '讨论历史与文学' },
  ];
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), roles); stores.add(store);
  const scope = { companionId: 'zhou-lan', conversationId: store.openPrivate('zhou-lan').id };
  const contacts = (query: string) => store.request({ type: 'memory.world_query', ...scope, category: 'people', query, limit: 10 }).worldKnowledge!.items;
  expect(contacts('周岚 zhou').map(item => item.id)).toEqual(['zhou-lan', 'reader']);
  expect(contacts('周岚')[0]!.id).toBe('zhou-lan');
  expect(contacts('不存在 文学').map(item => item.id)).toEqual(['reader']);
  expect(contacts('missing')).toEqual([]);
});

it('durably captures one completed walk in its world domain, survives restart, forms a sourced personal diary and never resurrects forgotten evidence', () => {
  const f = fixture(); startWalk(f.store); const event = finishWalk(f.store);
  expect(counts(f.filename)).toMatchObject({ receipts: { n: 1 }, jobs: { n: 1 } });
  f.store.close(); stores.delete(f.store);
  const reopened = new CompanionsStore(f.filename, seeds); stores.add(reopened);
  const job = reopened.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
  expect(job).toMatchObject({ companionId: 'alice', conversationId: 'world_alice' }); expect(job.sourceMessageIds).toHaveLength(1);
  const source = reopened.getMessage(job.sourceMessageIds[0]!);
  expect(source).toMatchObject({ authorId: 'system', kind: 'notice', memoryEvidenceOnly: true });
  expect(JSON.parse(source.content).items[0]).toMatchObject({ id: event.id, sequence: event.sequence, kind: 'park_walk_complete' });
  expect(reopened.state().conversations.some(room => room.id === 'world_alice')).toBe(false);
  const note = reopened.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [{ diaryName: '自我认识',
    content: '这次实际完成了花园散步，我感到有规律地留出户外时间值得尝试；这是这一次经历的个人认识。', tags: ['花园散步', '生活节奏', '个人认识'],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: event.text }] }] }).memories![0]!;
  expect(note.sourceConversationId).toBe('world_alice'); expect(note.sources[0]).toMatchObject({ sourceType: 'world_observation', messageId: source.id });
  const outbox = reopened.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  reopened.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true, sourceFile: 'fixture/真实生活.txt' });
  expect(reopened.request({ type: 'memory.snapshot', ...f.worldScope }).memorySnapshot!.notes.map(item => item.id)).toEqual([note.id]);
  expect(() => reopened.request({ type: 'memory.read', ...f.bob, id: note.id })).toThrow();
  const db = new Sqlite(f.filename);
  try {
    const memory = new CompanionMemoryStore(db, id => reopened.getMessage(id));
    memory.enqueueWorldExperience(source.id, 'alice'); expect(counts(f.filename).jobs).toEqual({ n: 1 });
    reopened.request({ type: 'memory.forget', ...f.worldScope, sourceMessageIds: [source.id] });
    memory.enqueueWorldExperience(source.id, 'alice');
    expect(reopened.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob).toBeUndefined();
    expect(reopened.request({ type: 'memory.snapshot', ...f.worldScope }).memorySnapshot!.notes).toEqual([]);
  } finally { db.close(); }
});

it('does not auto-learn queries, movement, visit plans or interrupted walks', () => {
  const f = fixture();
  const query = f.store.request({ type: 'memory.world_query', ...f.worldScope, category: 'observations', query: '', limit: 3 }).memorySources![0]!;
  const db = new Sqlite(f.filename);
  try { expect(() => new CompanionMemoryStore(db, id => f.store.getMessage(id)).enqueueWorldExperience(query.id, 'alice')).toThrow('已发生事件'); }
  finally { db.close(); }
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '想一起阅读' } });
  startWalk(f.store); advance(f.store, 1000);
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '现在请处理工作。', replyDirective: 'none' });
  f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'interrupt_walk', kind: 'action', sourceMessageId: source.id }); advance(f.store, 1000);
  const world = f.store.request({ type: 'world.snapshot' }).world!;
  expect(world.events.some(event => event.kind === 'park_walk_interrupted')).toBe(true);
  expect(counts(f.filename).receipts).toEqual({ n: 0 });
  const jobs = f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob;
  expect(jobs?.sourceMessageIds).not.toContain(query.id);
});

it('never treats a reading pose as proof that external material was actually read', () => {
  const f = fixture();
  f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '读书姿态', enabled: true, startMinute: 600,
    endMinute: 610, probability: 1, checkIntervalMinutes: 1, action: 'study' } });
  advance(f.store, 61000);
  f.store.request({ type: 'life-event.tick' }); let occurrence: CompanionLifeOccurrence | undefined;
  for (let i = 0; i < 4 && !occurrence; i++) { advance(f.store, 61000); occurrence = f.store.request({ type: 'life-event.claim' }).lifeOccurrence; }
  f.store.request({ type: 'life-event.complete', id: occurrence!.id, leaseToken: occurrence!.leaseToken! });
  const world = advance(f.store, 20000);
  expect(world.events.some(event => event.kind === 'life_activity' && event.text.endsWith('study'))).toBe(true);
  expect(counts(f.filename).receipts).toEqual({ n: 0 });
  expect(f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob).toBeUndefined();
});

it('captures an actual permitted cross-door arrival and excludes the request, consent and return home', () => {
  const f = fixture(); shareWorldAddress(f.store, f.bob, 'alice', ms => advance(f.store, ms));
  const requested = f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '实际拜访' } }).world!;
  const visit = requested.visits.find(item => item.guestId === 'alice')!;
  f.store.request({ type: 'world.tool', ...f.bob, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎来访' } });
  expect(counts(f.filename).receipts).toEqual({ n: 0 });
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'travel', targetSceneId: 'home_bob' } });
  const arrived = advance(f.store, 40000); expect(arrived.actors.find(actor => actor.companionId === 'alice')!.sceneId).toBe('home_bob');
  expect(counts(f.filename).receipts).toEqual({ n: 1 });
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'leave' } }); advance(f.store, 40000);
  expect(counts(f.filename).receipts).toEqual({ n: 1 });
});

it('rolls back the completed experience, hidden receipt and capture job together when world persistence fails', () => {
  const f = fixture(); startWalk(f.store);
  for (let i = 0; i < 150; i++) {
    const world = f.store.request({ type: 'world.snapshot' }).world!, walk = world.actors.find(actor => actor.companionId === 'alice')!.parkWalk;
    if (walk?.stage === 'strolling' && walk.participatedMinutes >= 33) break;
    advance(f.store, 15000);
  }
  const before = counts(f.filename);
  expect(before.receipts, JSON.stringify(f.store.request({ type: 'world.snapshot' }).world?.actors)).toEqual({ n: 0 });
  const prototype = CompanionWorldStore.prototype as unknown as { save(state: { actors: Array<{ parkWalk?: { stage: string } }> }): void }, save = prototype.save;
  const fault = vi.spyOn(prototype, 'save').mockImplementation(function (this: typeof prototype, state) {
    const connection = (this as unknown as { db: CompanionConnection }).db;
    if (connection.prepare("SELECT 1 FROM companion_world_events WHERE json_extract(data,'$.kind')='park_walk_complete' LIMIT 1").get()) throw new Error('injected world persistence failure');
    return save.call(this, state);
  });
  expect(() => advance(f.store, 3 * 60000)).toThrow('injected world persistence failure'); fault.mockRestore();
  expect(counts(f.filename)).toEqual(before);
  const retried = f.store.request({ type: 'world.tick', snapshot: true }).world!;
  expect(retried.events.filter(event => event.kind === 'park_walk_complete')).toHaveLength(1);
  expect(counts(f.filename)).toMatchObject({ receipts: { n: 1 }, jobs: { n: 1 } });
});
