import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryMaintenanceStore } from '../../src/companions/memory-maintenance-store';
import type { CompanionWorldJob } from '../../src/shared/companion-world';

const stores = new Set<CompanionsStore>(), roots: string[] = [];
const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真记住真实经历', model: '',
  avatar: 'sister' as const, active: true, proactive: false }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-26T10:00:00Z'); vi.spyOn(Math, 'random').mockReturnValue(.99); });
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-maintenance-life-')) throw Error('Unexpected cleanup');
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-maintenance-life-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite');
  let store = new CompanionsStore(filename, seeds); stores.add(store);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const initial = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
    patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  const index = () => { for (let count = 0; count < 100; count++) {
    const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!outbox) break;
    store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
  } };
  const record = (content: string, important = false) => {
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' });
    const note = store.request({ type: 'memory.record', ...scope, candidate: { content, tags: important ? ['重要'] : ['经历'],
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }] } }).memories![0]!;
    index(); return { source, note };
  };
  const tick = (ms = 6000) => { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; };
  const claim = () => store.request({ type: 'world.job.claim', kind: 'dream', excludedCompanionIds: ['bob'] }).worldJob;
  const bind = (job: CompanionWorldJob) => {
    const ids = [...new Set([...job.sourceMemoryIds, ...(job.maintenanceMemoryIds ?? [])])];
    const notes = ids.map(id => store.request({ type: 'memory.read', ...scope, id, sourceLimit: 100 }).memoryRead!.memory);
    store.request({ type: 'world.job.bind-memories', id: job.id, leaseToken: job.leaseToken!, memoryVersions: notes.map(note => ({ id: note.id, version: note.version })) });
    return notes;
  };
  const database = () => new (BetterSqlite3 as unknown as { new(filename: string): CompanionConnection })(filename);
  return { get store() { return store; }, scope, record, tick, claim, bind, index, database,
    restart: () => { store.close(); stores.delete(store); store = new CompanionsStore(filename, seeds); stores.add(store); } };
}

it('admits daytime maintenance while physical work and the ordinary task allowance are occupied', () => {
  const f = fixture();
  f.store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
  const { source } = f.record('第一次实际交流。'); f.record('第二次具体经历。'); f.record('第三次确定的变化。');
  const ordinary = (id: string) => ({ id, companionId: 'alice', conversationId: f.scope.conversationId, sourceMessageId: source.id,
    status: 'queued' as const, proactive: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  f.store.request({ type: 'work.enqueue', work: ordinary('occupied_ordinary_slot') });
  expect(f.store.request({ type: 'work.claim' }).work?.id).toBe('occupied_ordinary_slot');
  f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'long_foreground_work', kind: 'chat', sourceMessageId: source.id });
  const world = f.tick(); expect(world.works.some(work => work.workId === 'long_foreground_work' && work.status !== 'ended')).toBe(true);
  const job = f.claim()!; expect(job).toMatchObject({ kind: 'dream', maintenanceMode: 'background', dreamAllowed: false });
  expect(job.sourceMemoryIds).toHaveLength(3); expect(f.bind(job)).toHaveLength(3);
  expect(f.store.request({ type: 'tasks.concurrency.get', companionId: 'alice' }).taskConcurrency!.policies[0]!.active).toBe(1);
  f.store.request({ type: 'work.status', id: 'occupied_ordinary_slot', status: 'done' });
  f.store.request({ type: 'work.enqueue', work: ordinary('new_ordinary_slot') });
  expect(f.store.request({ type: 'work.claim' }).work?.id).toBe('new_ordinary_slot');
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: job.sourceMemoryIds });
  f.tick(); expect(f.claim()).toBeUndefined();
});

it('does not repeatedly pay for unchanged provenance or tag-only revisions across restart', () => {
  const f = fixture(), { note } = f.record('已经核对的重要约定。', true); f.tick(); const job = f.claim()!; f.bind(job);
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: job.sourceMemoryIds });
  const before = f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead!.memory;
  f.store.request({ type: 'memory.organize', ...f.scope, ids: [note.id], tags: ['新标签'] }); f.index();
  const after = f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead!.memory;
  expect(after.version).toBeGreaterThan(before.version); expect(after.semanticRevision).toBe(before.semanticRevision);
  f.restart(); f.tick(); expect(f.claim()).toBeUndefined();
  const db = f.database(); try {
    expect(db.prepare('SELECT count(*) AS n FROM companion_memory_maintenance_sources WHERE companion_id=?').get('alice')).toEqual({ n: 1 });
    expect(JSON.parse((db.prepare('SELECT data FROM companion_memory_maintenance_owners WHERE companion_id=?').get('alice') as { data: string }).data).lastDecisionAt).toBeDefined();
  } finally { db.close(); }
});

it('keeps a real reflection when a concurrent task has already changed the optional runtime state', () => {
  const f = fixture(), { note, source } = f.record('确有来源的重要任务进展。', true); f.tick(); const job = f.claim()!; f.bind(job);
  const originalState = f.store.request({ type: 'state.get', ...f.scope }).runtimeState!;
  const evidence = [{ sourceMessageId: source.id, quote: source.content }];
  f.store.request({ type: 'state.update', ...f.scope, expectedRevision: originalState.revision, proposal: {
    focus: '另一任务刚确认的新关注', reason: '实际任务已进入新的关注阶段。', sourceMessageIds: [source.id], evidence } });
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'reflection', sourceMemoryIds: [note.id],
    memoryCandidates: [{ content: '这次重要任务的进展提示我之后仍应保留来源核验。', tags: ['实际反思'], sourceMessageIds: [source.id], relatedMemoryIds: [note.id], evidence }],
    expectedStateRevision: originalState.revision, stateProposal: { focus: '过时的关注提议', reason: '基于刚才的旧状态提出。', sourceMessageIds: [source.id], evidence } });
  expect(f.store.request({ type: 'state.get', ...f.scope }).runtimeState?.focus).toBe('另一任务刚确认的新关注');
  expect(f.store.request({ type: 'memory.browse', ...f.scope }).memoryPage!.items.some(hit => hit.memory.tags.includes('实际反思'))).toBe(true);
  expect(f.store.request({ type: 'world.job.check', id: job.id, leaseToken: job.leaseToken! }).worldJob)
    .toMatchObject({ reflectionCompletedAt: expect.any(String), stateIntegrationSkipped: 'stale_state_revision' });
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: [note.id] });
});

it('persists a fixed draw and a real checkpoint, then resumes only the bounded narrative stage', () => {
  vi.mocked(Math.random).mockReturnValue(.1);
  const f = fixture(); f.record('有真实来源的重要学习成果。', true); f.tick(); const job = f.claim()!; expect(job.dreamAllowed).toBe(true); f.bind(job);
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: job.sourceMemoryIds });
  const first = f.store.request({ type: 'world.job.narrative.begin', id: job.id, leaseToken: job.leaseToken! }).worldJob!;
  expect(first.realCompletedAt).toBeDefined(); expect(first.narrativeAttempts).toBe(1);
  f.store.request({ type: 'world.job.fail', id: job.id, leaseToken: job.leaseToken!, error: '受控叙述服务失败' });
  f.restart(); f.tick(65000); const retried = f.claim()!;
  expect(retried).toMatchObject({ id: job.id, realCompletedAt: first.realCompletedAt, narrativeAttempts: 1 });
  f.store.request({ type: 'world.job.narrative.begin', id: retried.id, leaseToken: retried.leaseToken! });
  f.store.request({ type: 'world.job.fail', id: retried.id, leaseToken: retried.leaseToken!, error: '第二次受控叙述失败' });
  f.tick(130000); const third = f.claim()!;
  expect(third.id).toBe(job.id); expect(f.store.request({ type: 'world.job.narrative.begin', id: third.id, leaseToken: third.leaseToken! }).worldJob?.narrativeAttempts).toBe(3);
  f.store.request({ type: 'world.job.fail', id: third.id, leaseToken: third.leaseToken!, error: '第三次受控叙述失败' });
  f.tick(1000); expect(f.claim()).toBeUndefined();
  const db = f.database(); try {
    expect(db.prepare('SELECT count(*) AS n FROM companion_world_dream_watermark WHERE companion_id=?').get('alice')).toEqual({ n: 1 });
    const session = JSON.parse((db.prepare('SELECT data FROM companion_memory_maintenance_sessions WHERE id=?').get(job.maintenanceSessionId) as { data: string }).data);
    expect(session).toMatchObject({ narrativeAttempts: 3, narrativeStatus: 'failed' });
  } finally { db.close(); }
});

it('keeps real maintenance legal after the body wakes but rejects a withdrawn seed', () => {
  const f = fixture(), { note } = f.record('应保留原始来源的重要经历。', true); f.tick(); const job = f.claim()!; f.bind(job);
  const routine = f.store.request({ type: 'routine.get', ...f.scope }).routine!;
  f.store.request({ type: 'routine.configure', ...f.scope, expectedRevision: routine.revision, patch: { sleepAt: '11:00', wakeAt: '12:00' } });
  expect(f.store.request({ type: 'world.job.check', id: job.id, leaseToken: job.leaseToken! }).worldJob?.id).toBe(job.id);
  f.store.request({ type: 'memory.library.delete', companionId: 'alice', id: note.id, expectedVersion: note.version });
  expect(f.store.request({ type: 'world.job.check', id: job.id, leaseToken: job.leaseToken! }).worldJob).toBeUndefined();
  expect(() => f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: job.sourceMemoryIds })).toThrow();
});

it('coalesces old real debt without creating one job for every offline night', () => {
  const f = fixture(), { note } = f.record('先前尚未结算的一次实际经历。');
  const db = f.database(); try {
    db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.createdAt',?) WHERE id=?")
      .run(new Date(Date.now() - 8 * 86400000).toISOString(), note.id);
  } finally { db.close(); }
  f.restart(); f.tick(); const job = f.claim()!;
  expect(job).toMatchObject({ maintenanceMode: 'background' }); expect(job.sourceMemoryIds).toEqual([note.id]);
  f.bind(job); f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: [note.id] });
  f.tick(); expect(f.claim()).toBeUndefined();
  const read = f.database(); try {
    expect(read.prepare("SELECT count(*) AS n FROM companion_world_jobs WHERE companion_id='alice' AND kind='dream'").get()).toEqual({ n: 1 });
  } finally { read.close(); }
});

it('does not restart a stopped source range when a different source later creates new debt', () => {
  const f = fixture(), first = f.record('用户停止的这批重要回顾。', true); f.tick();
  const queuedDb = f.database(); let stopped: CompanionWorldJob;
  try { stopped = JSON.parse((queuedDb.prepare("SELECT data FROM companion_world_jobs WHERE kind='dream' AND status='pending'").get() as { data: string }).data); }
  finally { queuedDb.close(); }
  expect(stopped.status).toBe('pending');
  f.store.request({ type: 'task-control.stop', companionId: 'alice', kind: 'world', id: stopped.id,
    stop: { actor: 'user', reason: 'user_requested', requestedAt: new Date().toISOString() } });
  const second = f.record('后来新增的独立重要事实。', true);
  const db = f.database(); try {
    const owner = JSON.parse((db.prepare('SELECT data FROM companion_memory_maintenance_owners WHERE companion_id=?').get('alice') as { data: string }).data);
    owner.lastDecisionAt = Date.now() - 7 * 3600000;
    db.prepare('UPDATE companion_memory_maintenance_owners SET data=? WHERE companion_id=?').run(JSON.stringify(owner), 'alice');
  } finally { db.close(); }
  f.tick(); const next = f.claim()!; expect(next.sourceMemoryIds).toContain(second.note.id); expect(next.sourceMemoryIds).not.toContain(first.note.id);
});

it('counts new episodes across source domains and drains fixed domain batches fairly', () => {
  const f = fixture(), first = f.record('私聊里的一次普通事实。');
  const room = f.store.createConversation('共同资料', ['alice', 'bob']);
  const shared = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '共同资料中的普通经历。', replyDirective: 'none' });
  const observed = f.store.request({ type: 'memory.world_query', companionId: 'alice', conversationId: 'world_alice', category: 'observations', query: '', limit: 1 }).memorySources![0]!;
  for (const source of [shared, observed]) {
    f.store.request({ type: 'memory.record', companionId: 'alice', conversationId: source.conversationId, candidate: { content: source.content, tags: ['经历'],
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
  }
  f.index(); f.tick(); const jobs: CompanionWorldJob[] = [];
  for (let count = 0; count < 3; count++) {
    const job = f.claim()!; expect(job).toBeDefined(); expect(job.sourceMemoryIds).toHaveLength(1); f.bind(job); jobs.push(job);
    f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: job.sourceMemoryIds }); f.tick();
  }
  expect(jobs[0]!.sourceMemoryIds).toEqual([first.note.id]); expect(new Set(jobs.map(job => job.maintenanceSessionId)).size).toBe(1);
  expect(f.claim()).toBeUndefined();
});

it('keeps a failed fixed readset fenced when later data arrives during its retry budget', () => {
  const f = fixture(), original = f.record('尚未成功回顾的重要事实。', true); f.tick(); const first = f.claim()!;
  const second = f.record('运行期间新增的独立重要事实。', true);
  for (let attempt = 1, job = first; attempt <= 3; attempt++) {
    expect(job.sourceMemoryIds).toEqual([original.note.id]);
    f.store.request({ type: 'world.job.fail', id: job.id, leaseToken: job.leaseToken!, error: '受控真实阶段故障' });
    f.tick(130000); if (attempt < 3) job = f.claim()!;
  }
  expect(f.claim()).toBeUndefined();
  const db = f.database(); try {
    const owner = JSON.parse((db.prepare('SELECT data FROM companion_memory_maintenance_owners WHERE companion_id=?').get('alice') as { data: string }).data);
    owner.lastDecisionAt = Date.now() - 7 * 3600000;
    db.prepare('UPDATE companion_memory_maintenance_owners SET data=? WHERE companion_id=?').run(JSON.stringify(owner), 'alice');
  } finally { db.close(); }
  f.tick(); expect(f.claim()?.sourceMemoryIds).toEqual([second.note.id]);
});

it('enforces owner-local session admission without needing world or model services', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-maintenance-life-')); roots.push(root);
  const db = new (BetterSqlite3 as unknown as { new(filename: string): CompanionConnection })(path.join(root, 'authority.sqlite'));
  try {
    const memory = new CompanionMemoryMaintenanceStore(db); memory.initialize();
    const session = memory.begin('alice', 'background', Date.now());
    expect(memory.begin('alice', 'sleep', Date.now()).id).toBe(session.id);
    expect(memory.owner('bob').activeSessionId).toBeUndefined();
    expect(session.narrativeStatus).toBe('skipped');
    expect(memory.bindDream(session.id, 'job')).toBe(false);
  } finally { db.close(); }
});
