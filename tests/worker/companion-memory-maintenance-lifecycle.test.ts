import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryMaintenanceStore } from '../../src/companions/memory-maintenance-store';
import type { CompanionWorldJob } from '../../src/shared/companion-world';
import { initialCompanionMemoryPolicy, COMPANION_MEMORY_POLICY_FILE } from '../../src/shared/companion-memory-policy';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { CompanionLearningService } from '../../src/main/companions/learning-service';
import type { AssetSummary } from '../../src/shared/asset-types';

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
  return { root, get store() { return store; }, scope, record, tick, claim, bind, index, database,
    restart: () => { store.close(); stores.delete(store); store = new CompanionsStore(filename, seeds); stores.add(store); } };
}

it('fences narrative admission refunds to one live lease, persists the deadline and preserves completed real phases', () => {
  vi.mocked(Math.random).mockReturnValue(.1); const f = fixture(); f.record('本轮实际重要经历。', true); f.tick();
  const job = f.claim()!; f.bind(job);
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'reflection' });
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: job.sourceMemoryIds });
  expect(f.store.request({ type: 'world.job.narrative.begin', id: job.id, leaseToken: job.leaseToken! }).worldJob?.narrativeAttempts).toBe(1);
  expect(f.store.request({ type: 'world.job.narrative.begin', id: job.id, leaseToken: job.leaseToken! }).worldJob?.narrativeAttempts).toBe(1);
  const deadline = Date.now() + 3600000;
  f.store.request({ type: 'world.job.defer', id: job.id, leaseToken: job.leaseToken!, error: 'Local host admission refused before HTTP.', retryAfterMs: 3600000 });
  expect(() => f.store.request({ type: 'world.job.defer', id: job.id, leaseToken: job.leaseToken!, error: 'Cannot refund twice.', retryAfterMs: 1000 })).toThrow('租约');
  f.restart(); f.tick(3599999); expect(f.claim()).toBeUndefined(); f.tick(2);
  const next = f.claim()!; expect(next).toMatchObject({ id: job.id, attempts: 1, narrativeAttempts: 0,
    realCompletedAt: expect.any(String), reflectionCompletedAt: expect.any(String) }); expect(Date.now()).toBeGreaterThan(deadline);
  expect(() => f.store.request({ type: 'world.job.defer', id: job.id, leaseToken: job.leaseToken!, error: 'Old lease cannot touch this attempt.', retryAfterMs: 1000 })).toThrow('租约');
  expect(f.store.request({ type: 'world.job.narrative.begin', id: next.id, leaseToken: next.leaseToken! }).worldJob?.narrativeAttempts).toBe(1);
  f.store.request({ type: 'world.job.fail', id: next.id, leaseToken: next.leaseToken!, error: 'Actual provider HTTP 429 still uses failure policy.' });
  f.tick(60001); const third = f.claim()!; expect(third.narrativeAttempts).toBe(1);
  f.store.request({ type: 'world.job.defer', id: third.id, leaseToken: third.leaseToken!, error: 'No narrative begin in this lease.', retryAfterMs: 1000 });
  const db = f.database(); try {
    const saved = JSON.parse((db.prepare('SELECT data FROM companion_memory_maintenance_sessions WHERE id=?').get(job.maintenanceSessionId) as { data: string }).data);
    expect(saved).toMatchObject({ narrativeAttempts: 1, narrativeStatus: 'pending' });
  } finally { db.close(); }
  f.store.request({ type: 'world.job.retry-admission', companionId: 'bob' }); expect(f.claim()).toBeUndefined();
  f.store.request({ type: 'world.job.retry-admission' }); const awakened = f.claim()!;
  expect(awakened).toMatchObject({ id: job.id, attempts: 2, narrativeAttempts: 1, realCompletedAt: next.realCompletedAt, reflectionCompletedAt: next.reflectionCompletedAt });
  f.store.request({ type: 'world.job.retry-admission' });
  expect(f.store.request({ type: 'world.job.check', id: awakened.id, leaseToken: awakened.leaseToken! }).worldJob?.leaseToken).toBe(awakened.leaseToken);
});

it('does not admit new reflection sessions for one hundred annotations or one evidence-free week after a real settled episode', () => {
  const f = fixture(), { note } = f.record('这项重要约定已经核对，后续仍保留原始依据。', true);
  f.tick(); const initial = f.claim()!; expect(initial).toBeDefined(); f.bind(initial);
  f.store.request({ type: 'world.job.complete', id: initial.id, leaseToken: initial.leaseToken!, stage: 'real', sourceMemoryIds: initial.sourceMemoryIds });
  const counts = () => { const db = f.database(); try { return {
    jobs: (db.prepare("SELECT COUNT(*) AS n FROM companion_world_jobs WHERE companion_id='alice' AND kind='dream'").get() as { n: number }).n,
    sessions: (db.prepare("SELECT COUNT(*) AS n FROM companion_memory_maintenance_sessions WHERE companion_id='alice'").get() as { n: number }).n,
    sources: (db.prepare("SELECT COUNT(*) AS n FROM companion_memory_maintenance_sources WHERE companion_id='alice'").get() as { n: number }).n,
  }; } finally { db.close(); } };
  const before = counts(); let newClaims = 0;
  for (let index = 0; index < 100; index++) {
    f.store.request({ type: 'memory.organize', ...f.scope, ids: [note.id], tags: ['重要', '新标签' + index] }); f.index();
    if (index === 49) f.restart();
    f.tick(60000); if (f.claim()) newClaims++;
  }
  f.tick(7 * 24 * 60 * 60000); if (f.claim()) newClaims++;
  expect(newClaims).toBe(0); expect(counts()).toEqual(before);
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead!.memory).toMatchObject({ contentRevision: note.contentRevision, version: note.version + 100 });
});

it('admits daytime maintenance while physical work and the ordinary task allowance are occupied', () => {
  const f = fixture();
  f.store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
  const { source } = f.record('第一次实际交流。'); vi.setSystemTime(Date.now() + 61_000);
  f.record('第二次具体经历。'); vi.setSystemTime(Date.now() + 61_000); f.record('第三次确定的变化。');
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

it('counts three real episodes rather than three notes split out of one conversation window', () => {
  const f = fixture(); f.record('同一次交流中的第一段。'); f.record('同一次交流中的第二段。'); f.record('同一次交流中的第三段。');
  f.tick(); expect(f.claim()).toBeUndefined();
  vi.setSystemTime(Date.now() + 61_000); f.record('另一次交流的变化。'); f.tick(); expect(f.claim()).toBeUndefined();
  vi.setSystemTime(Date.now() + 61_000); f.record('第三个独立交流窗口。'); f.tick(); expect(f.claim()?.sourceMemoryIds).toHaveLength(5);
});

it('reads live owner policy, parks only the damaged owner and pins a session policy across edits and restart', () => {
  const f = fixture(), root = path.join(f.root, '伙伴记忆'), policy = initialCompanionMemoryPolicy();
  const write = (owner: string) => { mkdirSync(path.join(root, owner), { recursive: true }); writeFileSync(path.join(root, owner, COMPANION_MEMORY_POLICY_FILE),
    JSON.stringify({ schema: 'worldlinebox.companion-memory-policy-v1', companionId: owner, policy })); };
  write('alice'); write('bob'); f.store.request({ type: 'world.maintenance.bind-policy-root', root });
  f.record('需要维护的重要来源。', true); unlinkSync(path.join(root, 'alice', COMPANION_MEMORY_POLICY_FILE));
  f.tick(); expect(f.claim()).toBeUndefined();
  expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!.maintenance).toMatchObject({ eligible: false, policyError: expect.any(String) });
  expect(f.store.request({ type: 'world.sleep-plan', companionId: 'bob' }).worldSleepPlan!.maintenance).not.toHaveProperty('policyError');
  policy.dream.probability = 1; policy.dream.maxAttempts = 1; write('alice'); f.tick(); const first = f.claim()!;
  expect(first.dreamAllowed).toBe(true); f.bind(first);
  f.store.request({ type: 'world.job.complete', id: first.id, leaseToken: first.leaseToken!, stage: 'real', sourceMemoryIds: first.sourceMemoryIds });
  policy.dream.maxAttempts = 3; policy.dream.probability = 0; write('alice'); f.restart();
  f.store.request({ type: 'world.maintenance.bind-policy-root', root }); f.tick(130_000); const resumed = f.claim()!;
  expect(resumed.id).toBe(first.id); expect(resumed.dreamAllowed).toBe(true);
  expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!.maintenance!.policy!.dream).toMatchObject({ probability: 1, maxAttempts: 1 });
  f.store.request({ type: 'world.job.narrative.begin', id: resumed.id, leaseToken: resumed.leaseToken! });
  f.store.request({ type: 'world.job.fail', id: resumed.id, leaseToken: resumed.leaseToken!, error: '一次真实叙述失败耗尽开始时策略' });
  f.tick(130_000); expect(f.claim()).toBeUndefined();
  const db = f.database(); try {
    const session = JSON.parse((db.prepare('SELECT data FROM companion_memory_maintenance_sessions WHERE id=?').get(first.maintenanceSessionId) as { data: string }).data);
    expect(session).toMatchObject({ policy: { dream: { probability: 1, maxAttempts: 1 } }, narrativeAttempts: 1, narrativeStatus: 'failed' });
  } finally { db.close(); }
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

it('persists dream questions separately, guides an authorized actual file read and revokes withdrawn reading observations', async () => {
  vi.mocked(Math.random).mockReturnValue(.1);
  const f = fixture(), { note, source } = f.record('需要有真实资料核验的重要经历。', true); f.tick(); const job = f.claim()!; f.bind(job);
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: job.sourceMemoryIds });
  f.store.request({ type: 'world.job.narrative.begin', id: job.id, leaseToken: job.leaseToken! });
  f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'dream', dream: {
    text: '我想象着一片会说话的森林；这没有真实发生。', relatedMemoryIds: [note.id], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }],
    investigations: [{ question: '已获权资料是否出现过核对出处的方法？', hypothesis: '也许资料提过先核对出处，但尚未验证。', relatedMemoryIds: [note.id],
      test: { kind: 'authorized_source_contains', quote: '先核对出处，再记录条件' } },
    { question: '核对出处这份资料中有没有不应臆造的另一句话？', hypothesis: '这只是梦的猜想，不能当真。', relatedMemoryIds: [note.id],
      test: { kind: 'authorized_source_contains', quote: '并不存在于实际片段的特殊句子' } }] } });
  f.restart(); const queued = f.store.request({ type: 'world.investigations.list', companionId: 'alice' }).memoryInvestigations!
    .find(item => item.proposal.test?.quote === '先核对出处，再记录条件')!;
  expect(queued).toMatchObject({ status: 'awaiting_authorization', reason: expect.stringContaining('授权') });
  expect(f.store.request({ type: 'world.investigations.list', companionId: 'bob' }).memoryInvestigations).toEqual([]);
  const dream = f.store.request({ type: 'memory.library.read', companionId: 'alice', id: queued.dreamMemoryId }).memoryRead!.memory;
  expect(dream.content).toContain('待核查问题（未经验证'); expect(dream.metadata?.dream).toBe(true);
  const grant = f.store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'authorized-library', libraryName: '已授权资料', libraryPath: f.root,
    autonomous: true, intervalMinutes: 30 }).learning!.grants[0]!;
  const file = path.join(f.root, '核对出处.md'); writeFileSync(file, '本页明确建议先核对出处，再记录条件；只适用于这份资料。');
  const picked: string[] = [], service = new CompanionLearningService({ request: async command => f.store.request(command), configured: () => true,
    assets: { catalog: async () => [], grant: async () => ({ libraryName: grant.libraryName, libraryPath: f.root }),
      page: async (current, _after, focus) => { expect(current.id).toBe(grant.id); expect(focus?.pendingQuestions.some(item => item.id === queued.id)).toBe(true);
        return { assets: [{ assetId: 'unrelated', displayName: '其它主题.md' }, { assetId: 'read-asset', displayName: '核对出处.md' }] as AssetSummary[], hasMore: false }; },
      read: async (current, asset) => { expect(current.id).toBe(grant.id); picked.push(asset.assetId); const content = readFileSync(file, 'utf8');
        return { content, revisionId: createHash('sha256').update(content).digest('hex'), truncated: false }; } },
    changed: () => undefined, report: error => { throw error; } });
  try { await service.tick(); await vi.waitFor(() => expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(1)); }
  finally { await service.close(); }
  expect(picked).toEqual(['read-asset']);
  const receipt = f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads[0]!;
  const actual = f.store.getMessage(receipt.sourceMessageId), readset = { schema: 'worldlinebox.companion-execution-readset-v1' as const, companionId: 'alice',
    conversationId: actual.conversationId, complete: true, memories: [], sources: [{ id: actual.id, conversationId: actual.conversationId,
      checksum: createHash('sha256').update(actual.content).digest('hex') }], knowledgeReads: [], contexts: [], topics: [] };
  const pending = f.store.request({ type: 'world.investigations.list', companionId: 'alice' }).memoryInvestigations!.find(item => item.id === queued.id)!;
  expect(pending.status).toBe('pending');
  expect(() => f.store.request({ type: 'world.investigations.observe', companionId: 'alice', id: queued.id, expectedRevision: pending.revision, receiptId: receipt.id,
    readset: { ...readset, sources: [{ ...readset.sources[0]!, checksum: '0'.repeat(64) }] } })).toThrow();
  const before = f.store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus!;
  const observed = f.store.request({ type: 'world.investigations.observe', companionId: 'alice', id: queued.id, expectedRevision: pending.revision, receiptId: receipt.id, readset }).memoryInvestigation!;
  expect(observed).toMatchObject({ status: 'observed', reason: expect.stringContaining('不证明假设'), result: { kind: 'reading_confirmation', matched: true, receiptId: receipt.id } });
  expect(f.store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus).toEqual(before);
  f.tick();
  expect(f.store.request({ type: 'world.investigations.list', companionId: 'alice' }).memoryInvestigations!.find(item => item.id !== queued.id))
    .toMatchObject({ status: 'not_observed', reason: expect.stringContaining('不证明假设为假'), result: { kind: 'reading_confirmation', matched: false } });
  f.store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  expect(f.store.request({ type: 'world.investigations.list', companionId: 'alice' }).memoryInvestigations![0]!.status).toBe('invalid');
});

/** Simulated civil time, real SQLite close/reopen and actual Main maintenance
 * pipeline. Provider responses are controlled; no external model/encoder runs. */
it('services a week of debt with only twenty daytime minutes per day across durable restarts', async () => {
  const f = fixture(), commands: CompanionStorageCommand[] = [], modelPurposes: string[] = [];
  let completed = 0;
  for (let day = 0; day < 7; day++) {
    vi.setSystemTime(Date.UTC(2026, 9, 27 + day, 10));
    f.record(`第${day + 1}天唯一一次真实独立交流。`);
    const service = simulatedMaintenanceService(f, commands, modelPurposes);
    try {
      for (let minute = 0; minute <= 20; minute++) {
        vi.setSystemTime(Date.UTC(2026, 9, 27 + day, 10, minute));
        const due = f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!.maintenance?.eligible;
        await service.tick();
        if (due) { completed++; await vi.waitFor(() => expect(commands.filter(command => command.type === 'world.job.complete' && command.stage === 'real')).toHaveLength(completed)); }
      }
      expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!.actor?.activity).not.toBe('sleeping');
    } finally { await service.close(); }
    f.restart();
  }
  const debug = f.database();
  try {
    expect(debug.prepare('SELECT count(*) AS n FROM companion_memory_maintenance_sessions').get()).toEqual({ n: 3 });
    expect(debug.prepare('SELECT count(*) AS n FROM companion_memory_maintenance_sources').get()).toEqual({ n: 6 });
  } finally { debug.close(); }
  // A session may process bounded audience batches; count sessions separately
  // from provider operations and never treat two batches as two paid reruns.
  expect(completed).toBe(6); expect(modelPurposes.filter(purpose => purpose === 'vcp_sleep_reflection')).toHaveLength(6);
  expect(modelPurposes.filter(purpose => purpose === 'vcp_sleep_memory_maintenance').length).toBeLessThanOrEqual(6);
  expect(commands.filter(command => command.type === 'world.job.narrative.begin')).toHaveLength(0);
  // Day seven's one new source is correctly waiting for its next real deadline.
  expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!.maintenance?.eligible).toBe(false);
});

it('makes no additional paid maintenance calls through an unchanged simulated week of daytime restarts', async () => {
  const f = fixture(), commands: CompanionStorageCommand[] = [], modelPurposes: string[] = [];
  f.record('第一天已核实并完成回顾的重要约定。', true);
  const first = simulatedMaintenanceService(f, commands, modelPurposes);
  try { f.tick(); await first.tick(); await vi.waitFor(() => expect(commands.some(command => command.type === 'world.job.complete' && command.stage === 'real')).toBe(true)); }
  finally { await first.close(); }
  const paidBefore = modelPurposes.length; expect(paidBefore).toBeGreaterThan(0);
  for (let day = 1; day <= 7; day++) {
    f.restart(); const service = simulatedMaintenanceService(f, commands, modelPurposes);
    try { for (let minute = 0; minute <= 20; minute++) { vi.setSystemTime(Date.UTC(2026, 9, 26 + day, 10, minute)); await service.tick(); } }
    finally { await service.close(); }
  }
  expect(modelPurposes).toHaveLength(paidBefore);
  expect(commands.filter(command => command.type === 'world.job.complete' && command.stage === 'real')).toHaveLength(1);
});

function simulatedMaintenanceService(f: ReturnType<typeof fixture>, commands: CompanionStorageCommand[], purposes: string[]) {
  return new CompanionWorldService({ request: async command => {
    // Isolate the independently scheduled maintenance channel; unrelated world
    // decisions and social providers are covered in their own service tests.
    if (command.type === 'world.job.claim' && command.kind === 'decision') return { ok: true };
    commands.push(command); return f.store.request(command);
  }, fetchFn: async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); purposes.push(payload.purpose);
    const value = payload.purpose === 'vcp_sleep_reflection' ? { notes: [], dream: null }
      : { decision: 'defer', reason: '各日独立事实保持原文，本次没有有用的新整合。', consolidations: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
  }, configFor: async () => ({ apiFormat: 'openai_chat', model: 'simulated-maintenance', apiKey: 'synthetic-only', baseUrl: 'https://fixture.invalid' }),
  changed: () => undefined, wakeWaiting: () => undefined, report: error => { throw error; } });
}
