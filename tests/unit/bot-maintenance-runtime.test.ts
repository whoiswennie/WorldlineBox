import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BotDshDeliveryUnknownError, BotDshTurnFailedError, BotDshOutputLimitError } from '../../src/main/companion-bot/dsh-brain';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotMaintenanceStore, maintenanceDomain, maintenanceOwner } from '../../src/main/companion-bot/memory-maintenance-store';
import { BotMaintenanceRuntime } from '../../src/main/companion-bot/memory-maintenance-runtime';
import { BotMemoryMaintenance, type BotMemoryMaintenanceSnapshot, type BotMemoryMaintenancePlan } from '../../src/main/companion-bot/memory-maintenance';
import type { BotMemoryScope, BotMemoryService, BotMaintenanceWorkStats } from '../../src/main/companion-bot/memory-service';
import type { BotMaintenanceRuntimeOptions } from '../../src/main/companion-bot/memory-maintenance-runtime';
import { botRequestSchema } from '../../src/shared/companion-bot';

const cleanups: Array<() => void | Promise<void>> = [];
function workFixture(catalog: () => Promise<unknown>, store?: BotStore): BotMemoryService['maintenanceWork'] {
  const batches = new Map<string, object>();
  return vi.fn<BotMemoryService['maintenanceWork']>(async (_scope, input) => {
    if (input.action === 'identity') return { generation: 'fixture-native-v1' };
    if (input.action === 'seed') return { imported: true };
    if (input.action === 'associate') return { items: [] };
    if (input.action === 'claim') {
      const key = 'fixture-incremental-batch:' + input.jobId, persisted = store?.getMetadata(key), previous = persisted ? JSON.parse(persisted) : batches.get(key); if (previous) return previous;
      const page = await catalog() as { items: Array<{ id: string; checksum: string }>; nextCursor?: string }, batch = { mode: 'incremental-v1' as const, ...page, revision: '0', state: 'processing' };
      batches.set(key, batch); store?.setMetadata(key, JSON.stringify(batch)); return batch;
    }
    if (input.action === 'stats') { const page = await catalog() as { liveEligibleCount?: number }; return { mode: 'incremental-v1', ready: page.liveEligibleCount ?? 0, retrying: 0, processing: 0 } as BotMaintenanceWorkStats; }
    return { mode: 'incremental-v1', ready: 0, retrying: 0, processing: 0 };
  });
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-maintenance-runtime-')), filename = path.join(root, 'bot.sqlite');
  let store = new BotStore(filename), journal = new BotMaintenanceStore(store);
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: '伙伴' });
  const room = store.openDirect('alice'), other = store.openDirect('bob');
  const scope = { companionId: 'alice', conversationId: room.id, securityDomainId: room.securityDomainId }, foreign = { companionId: 'bob', conversationId: other.id, securityDomainId: other.securityDomainId };
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, scope, foreign, get store() { return store; }, get journal() { return journal; }, reopen() { store.close(); store = new BotStore(filename); journal = new BotMaintenanceStore(store); } };
}
function snapshot(scope: BotMemoryScope, operationId: string): BotMemoryMaintenanceSnapshot {
  return { format: 'worldlinebox-memory-maintenance-snapshot-v2', operationId, scope, kind: 'organize', contextEpoch: 1, sourceRevision: '0', createdAt: new Date().toISOString(), scan: { examined: 2, selected: 2, deferred: [] },
    sources: ['a', 'b'].map(id => ({ id: id.repeat(64), checksum: id.repeat(32), content: 'PRIVATE 原始资料 ' + id, tags: ['日常'], createdAt: new Date().toISOString(), sourceMessageIds: ['message-' + id] })), retrieval: { engine: 'DailyNoteManager.Associate', result: {} } };
}
it('connects a fresh durable job to the actual core with a valid frozen epoch before model admission', async () => {
  const f = fixture();
  const originals = ['a', 'b'].map(id => ({ id: id.repeat(64), checksum: id.repeat(32), indexState: 'indexed',
    content: '来源明确的隔离日记：' + id, tags: ['测试'], createdAt: new Date().toISOString(), sourceMessageIds: [] }));
  const run = vi.fn(async () => ({ status: 'succeeded', text: '{"narrative":"本批不需要更改。","candidates":[]}', eventId: 'fixture-core-result', sessionId: 'fixture-core-lane' }));
  const options = {
    store: f.store, root: f.root, brain: { run, archive: vi.fn(async () => undefined) },
    memory: { withdrawnSources: vi.fn(async () => ({ revision: '0', sourceEventIds: [], sourceMessageIds: [] })),
      catalog: vi.fn(async () => ({ items: originals, tags: [] })), readNote: vi.fn(async (_scope: unknown, input: { id: string }) => originals.find(note => note.id === input.id)),
      associateDiaries: vi.fn(async () => ({ engine: 'DailyNoteManager.Associate', sourceRevision: '0', items: [], queries: [] })) },
    model: () => ({ apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1', apiKey: 'local-protocol-fixture', model: 'fixture', contextWindow: 65536, maxTokens: 512 }),
    callback: async () => ({ url: 'http://127.0.0.1/bot/tool', token: 'fixture' }), changed: () => undefined,
  } as unknown as BotMaintenanceRuntimeOptions;
  options.memory.maintenanceWork = workFixture(() => options.memory.catalog(f.scope, {}), f.store);
  const maintenance = new BotMaintenanceRuntime(options); cleanups.push(() => maintenance.close());
  const job = maintenance.journal.enqueue(f.scope, 'organize', 'real-core-identity');
  const claim = f.store.claimMemoryJob({ workerId: 'core-identity-check' })!;
  expect(await maintenance.run(claim, new AbortController().signal)).toEqual({ status: 'done' });
  const saved = maintenance.journal.get(f.scope, job.id);
  expect(saved.snapshot?.contextEpoch).toBe(1); expect(saved.plan?.contextEpoch).toBe(1);
  expect(saved.job.status).toBe('completed'); expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: path.join(f.root, 'vcp-maintenance-v2', 'plans', maintenanceDomain(f.scope), job.id) }));
});
function plan(scope: BotMemoryScope, operationId: string, types: Array<'organize' | 'insight' | 'archive'> = ['organize']): BotMemoryMaintenancePlan {
  return { ...snapshot(scope, operationId), format: 'worldlinebox-memory-maintenance-v2', id: 'f'.repeat(64), narrative: '推测：可能有共同线索，尚未写成用户事实。', candidates: types.map((type, index) => ({ id: 'candidate-' + index, type, sourceIds: type === 'organize' ? ['a'.repeat(64), 'b'.repeat(64)] : ['a'.repeat(64)], content: 'PRIVATE 提案正文 ' + index, tags: ['待审'], reason: '待人工确认', uncertainties: ['未证实的联系'], quotes: [{ sourceId: 'a'.repeat(64), text: 'PRIVATE 原始资料 a' }] })) };
}
function runtime(f: ReturnType<typeof fixture>, liveEligibleCount: number | null = 12, companionBusy?: (id: string) => boolean) {
  const catalog = vi.fn(async () => ({ items: [{ indexState: 'indexed' }], total: 999, ...(liveEligibleCount === null ? {} : { liveEligibleCount }) }));
  const options = { store: f.store, root: f.root, memory: { catalog, maintenanceWork: workFixture(catalog) }, brain: {}, model: () => ({ apiKey: 'never-used', model: 'fixture', baseUrl: 'http://127.0.0.1:9', apiFormat: 'openai_chat' }), callback: async () => ({ url: 'http://127.0.0.1:9', token: 'never-used' }), changed: vi.fn(), report: vi.fn() } as unknown as BotMaintenanceRuntimeOptions;
  const value = new BotMaintenanceRuntime({ ...options, companionBusy }); cleanups.push(() => value.close()); return { value, catalog };
}
async function execute(f: ReturnType<typeof fixture>, value: BotMaintenanceRuntime) {
  const claim = f.store.claimMemoryJob({ workerId: 'maintenance-test' })!; expect(claim).toBeDefined();
  const result = await value.run(claim, new AbortController().signal); f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result }); return { claim, result };
}
async function settlePoll(value: BotMaintenanceRuntime) {
  value.poll();
  // The UI polls without waiting. Finish its real asynchronous check before
  // advancing the simulated clock to the next sampling window.
  await value['polling'];
}
async function scheduled(journal: BotMaintenanceStore, now: number, random: () => number) {
  const scopes: BotMemoryScope[] = [];
  await journal.scheduleDreams({ now, random, onScheduled: scope => scopes.push(scope) });
  return scopes;
}

it('organizes the original older diaries after an empty daytime wave and consumes their version only after the batch receipt', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const noon = new Date(2026, 10, 27, 12).getTime();
  vi.setSystemTime(noon);
  const f = fixture();
  const notes = ['a', 'b'].map(key => ({ id: key.repeat(64), checksum: key.repeat(32), content: '去年约定的集合地点 ' + key,
    indexState: 'indexed', tags: ['观鸟'], createdAt: '2025-04-01T00:00:00Z', sourceMessageIds: [] }));
  const model = vi.fn(async () => ({ status: 'succeeded', text: JSON.stringify({ narrative: '核对了两篇旧日记，保留各自的约定。', candidates: [] }) }));
  const configuration = vi.fn(() => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://localhost', apiKey: 'fixture' }));
  const readNote = vi.fn(async (_scope: BotMemoryScope, input: { id: string }) => notes.find(note => note.id === input.id));
  const work = workFixture(async () => ({ items: notes, liveEligibleCount: 0 }), f.store);
  const runtime = new BotMaintenanceRuntime({
    store: f.store, root: f.root, changed: () => undefined, brain: { run: model, archive: async () => undefined },
    memory: { readNote, associateDiaries: async () => ({ engine: 'DailyNoteManager.Associate', sourceRevision: '0', items: [], queries: [] }), maintenanceWork: work,
      withdrawnSources: async () => ({ revision: '0', sourceMessageIds: [], sourceEventIds: [] }),
      dreamRecall: async () => ({ engine: 'DreamWaveEngine', sourceRevision: '0', sources: [] }) },
    model: configuration,
    callback: async () => ({ url: 'http://localhost', token: 'fixture' }),
  } as unknown as BotMaintenanceRuntimeOptions);
  cleanups.push(() => runtime.close());
  runtime.activity(f.scope, 'version-from-last-year');
  vi.setSystemTime(noon + 180000);
  await settlePoll(runtime);
  expect(configuration).not.toHaveBeenCalled();
  expect(f.journal.list(f.scope).items).toMatchObject([{ kind: 'dream', trigger: 'idle' }]);
  await execute(f, runtime);
  expect(model).not.toHaveBeenCalled();
  expect(f.journal.list(f.scope).items[0]).toMatchObject({ kind: 'organize', trigger: 'idle', status: 'queued' });
  vi.setSystemTime(Date.now() + 31000);
  await execute(f, runtime);
  expect(readNote.mock.calls.map(([, input]) => input.id)).toEqual(notes.map(note => note.id));
  expect(model).toHaveBeenCalledOnce();
  expect(f.journal.list(f.scope).items[0]).toMatchObject({ kind: 'organize', automatic: true, status: 'completed' });
  vi.setSystemTime(Date.now() + 86400000);
  await settlePoll(runtime);
  expect(f.journal.list(f.scope).items).toHaveLength(2);
});
async function idleDream(journal: BotMaintenanceStore, now: number, isIdle: (companion: string) => boolean = () => true) {
  const scopes: BotMemoryScope[] = [];
  await journal.scheduleIdleDream({ now, isIdle, onScheduled: scope => scopes.push(scope) });
  return scopes;
}
function dreamPlan(scope: BotMemoryScope, jobId: string, seeded = true): BotMemoryMaintenancePlan {
  const result = plan(scope, jobId, []);
  return { ...result, kind: 'dream', sources: seeded ? result.sources.map(source => ({ ...source, role: 'seed' })) : [] };
}
it.each([false, true])('reopens an unfinished retired automatic dream once after its cooldown, migrated watermark=%s', async unknownWatermark => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = new Date(2026, 0, 26, 9).getTime();
  vi.setSystemTime(at);
  const f = fixture();
  for (const [scope, finished] of [[f.scope, false], [f.foreign, true]] as const) {
    f.journal.activity(scope, 'original-indexed-diary');
    const job = f.journal.enqueue(scope, 'dream', 'previous-dream', true, undefined, 'idle');
    const frozen = dreamPlan(scope, job.id);
    if (!finished) frozen.candidates = plan(scope, job.id, ['insight']).candidates;
    f.journal.savePlan(scope, job.id, frozen);
    f.journal.recordDreamSuccess(scope, at);
    f.store.taskTransaction(sql => {
      sql.prepare("UPDATE bot_maintenance_jobs SET plan_json=json_set(plan_json,'$.format','worldlinebox-memory-maintenance-v1') WHERE id=?").run(job.id);
      if (unknownWatermark) sql.prepare('UPDATE bot_maintenance_settings SET dream_planned=-1 WHERE owner_key=?').run(maintenanceOwner(scope));
    });
  }
  f.store.taskTransaction(sql => sql.prepare('DELETE FROM bot_metadata WHERE key=?').run('maintenance-native-submission-v2'));
  f.reopen();
  expect(await idleDream(f.journal, at + 60000)).toEqual([]);
  const later = at + 8 * 3600000;
  vi.setSystemTime(later);
  expect(await idleDream(f.journal, later)).toEqual([f.scope]);
  const replacement = f.journal.list(f.scope).items[0]!;
  expect(replacement).toMatchObject({ status: 'queued', trigger: 'idle', kind: 'dream' });
  f.reopen();
  expect(await idleDream(f.journal, later + 120000)).toEqual([]);
  f.journal.savePlan(f.scope, replacement.id, dreamPlan(f.scope, replacement.id));
  f.journal.recordDreamSuccess(f.scope, later);
  f.reopen();
  expect(await idleDream(f.journal, later + 86400000)).toEqual([]);
  expect(f.journal.list(f.scope).items).toHaveLength(2);
  expect(f.journal.list(f.foreign).items).toHaveLength(1);
});

it('retires an unfinished frozen DSH turn and its unsent survey page while keeping an unrelated fresh request', () => {
  const f = fixture();
  const old = f.journal.enqueue(f.scope, 'organize', 'old-report', false, undefined, undefined, undefined, 'scan');
  const next = f.journal.enqueue(f.scope, 'organize', 'old-next-page', false, 'obsolete-page', undefined, undefined, 'scan', { rootId: old.id, page: 2 });
  const fresh = f.journal.enqueue(f.foreign, 'organize', 'fresh-unfrozen');
  f.store.taskTransaction(sql => {
    sql.prepare('DELETE FROM bot_metadata WHERE key=?').run('maintenance-native-submission-v2');
    sql.prepare('UPDATE bot_maintenance_jobs SET snapshot_json=? WHERE id=?').run(JSON.stringify({ ...snapshot(f.scope, old.id), format: 'worldlinebox-memory-maintenance-snapshot-v1' }), old.id);
  });
  f.store.setMetadata('maintenance-output:' + old.id + ':0', JSON.stringify({ eventId: 'retired-dsh-event', checkpoint: 17, text: '旧回复片段' }));
  f.reopen();
  for (const job of [old, next]) {
    expect(f.journal.get(f.scope, job.id).job).toMatchObject({ phase: 'planner_retired', status: 'cancelled' });
    expect(() => f.journal.control(f.scope, job.id, 'retry', job.id + '-retry')).toThrow('旧版');
  }
  expect(f.journal.get(f.foreign, fresh.id).job.status).toBe('queued');
  expect(f.store.claimMemoryJob({ workerId: 'new-executor' })?.job.payload.jobId).toBe(fresh.id);
});
it('keeps invalid source evidence distinct from executor outages and releases the failed generation queue item', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(); f.journal.settings(f.scope); const r = runtime(f);
  vi.setSystemTime(Date.now() + 3600000); const job = r.value.journal.enqueue(f.scope, 'organize', 'invalid-evidence');
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockRejectedValueOnce(Object.assign(new Error('候选引用无法在来源原文中核对。'), { code: 'MEMORY_MAINTENANCE_INVALID_PLAN' }));
  const { result } = await execute(f, r.value); expect(result.status).toBe('failed');
  expect(r.value.journal.get(f.scope, job.id).job).toMatchObject({ status: 'blocked', phase: 'invalid_plan' });
  expect(f.store.listPendingMemory().filter(item => item.status === 'queued')).toHaveLength(0);
  const next = r.value.journal.enqueue(f.foreign, 'organize', 'other-task');
  expect(f.store.claimMemoryJob({ workerId: 'next-task' })?.job.payload.jobId).toBe(next.id);
});
it('backs off repeated provider failures without exhausting a retry quota or blocking another memory domain', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 0, 21, 1, 15));
  const f = fixture(), r = runtime(f), job = f.journal.enqueue(f.scope, 'dream', 'retry-until-recovery', true);
  let attempts = 0;
  const run = vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => {
    if (++attempts <= 5) throw Object.assign(new Error('provider temporarily HTTP 503'), { code: 'MEMORY_MAINTENANCE_MODEL_FAILED' });
    return { ...plan(input.scope, input.operationId), kind: 'dream', candidates: [] };
  });
  for (let index = 0; index < 5; index++) {
    expect((await execute(f, r.value)).result.status).toBe('retry');
    expect(r.value.journal.get(f.scope, job.id).job).toMatchObject({ status: 'queued', phase: 'waiting_executor' });
    const other = f.store.enqueueMemoryJob({ kind: 'projection', key: 'unrelated-' + index, payload: { scope: f.foreign } });
    const claim = f.store.claimMemoryJob({ workerId: 'unrelated' })!; expect(claim.job.id).toBe(other.id);
    f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: 'done' });
    vi.setSystemTime(Date.now() + 300001);
  }
  expect((await execute(f, r.value)).result.status).toBe('done');
  expect(r.value.journal.get(f.scope, job.id).job.status).toBe('completed');
  expect(run).toHaveBeenCalledTimes(6);
});
it('checks the native window at most once each 15 minutes and rolls without consulting pending diary counts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = new Date(2026, 0, 21, 0, 45).getTime();
  vi.setSystemTime(at);
  const f = fixture(), r = runtime(f);
  f.journal.settings(f.scope);
  const roll = vi.spyOn(Math, 'random').mockReturnValue(0.6);
  await settlePoll(r.value);
  expect(roll).not.toHaveBeenCalled();
  vi.setSystemTime(at + 15 * 60000);
  await settlePoll(r.value);
  expect(roll).toHaveBeenCalledTimes(1);
  expect(f.journal.list(f.scope).items).toHaveLength(0);
  roll.mockReturnValue(0.59);
  vi.setSystemTime(at + 29 * 60000);
  await settlePoll(r.value);
  expect(roll).toHaveBeenCalledTimes(1);
  vi.setSystemTime(at + 30 * 60000);
  await settlePoll(r.value);
  expect(f.journal.list(f.scope).items).toMatchObject([{ kind: 'dream', automatic: true }]);
  expect(r.catalog).not.toHaveBeenCalled();
});

it('restores the exact output checkpoint after reopening without rescanning or replaying the original model input', async () => {
  const f = fixture(); let calls = 0;
  const run = vi.fn<BotMaintenanceRuntimeOptions['brain']['run']>(async input => {
    if (++calls === 1) throw new BotDshOutputLimitError(input.eventId, input.laneId, 41, '{"narrative":"已保存');
    if (calls === 2) throw Object.assign(new Error('application closed'), { code: 'BOT_SUSPEND' });
    return { status: 'succeeded', text: '的进度","candidates":[]}', eventId: input.eventId, sessionId: input.laneId };
  });
  const brain = { run, archive: vi.fn(async () => undefined) } as unknown as BotMaintenanceRuntimeOptions['brain'];
  const first = realCoreRuntime(f, brain), job = first.value.journal.enqueue(f.scope, 'organize', 'output-restart');
  expect((await execute(f, first.value)).result.status).toBe('retry');
  const frozen = JSON.stringify(first.value.journal.get(f.scope, job.id).snapshot);
  await first.value.close(); f.reopen(); const next = realCoreRuntime(f, brain);
  expect((await execute(f, next.value)).result.status).toBe('done');
  expect(next.value.journal.get(f.scope, job.id).plan?.narrative).toBe('已保存的进度');
  expect(JSON.stringify(next.value.journal.get(f.scope, job.id).snapshot)).toBe(frozen);
  expect(run.mock.calls[2]![0]).toMatchObject({ eventId: run.mock.calls[0]![0].eventId, continueAfterSeq: 41 });
  expect(next.memory.catalog).not.toHaveBeenCalled();
});

it('keeps manual organization out of the native automatic scheduler after reopening', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = new Date(2026, 0, 21, 12).getTime(); vi.setSystemTime(at);
  const f = fixture();
  const job = f.journal.enqueue(f.scope, 'organize', 'manual-org');
  f.journal.progress(f.scope, job.id, 'blocked', 'blocked', 'manual attention');
  f.reopen();
  expect(await scheduled(f.journal, at + 24 * 3600000, () => 0)).toEqual([]);
  expect(f.journal.get(f.scope, job.id).job.status).toBe('blocked');
});

function realCoreRuntime(f: ReturnType<typeof fixture>, brain: BotMaintenanceRuntimeOptions['brain'], baseUrl = 'http://127.0.0.1:9') {
  const originals = ['a', 'b'].map(id => ({ id: id.repeat(64), checksum: id.repeat(32), indexState: 'indexed', content: '隔离HTTP回归测试的来源日记：' + id,
    tags: ['测试'], createdAt: '2026-11-03T10:00:00Z', sourceMessageIds: [] }));
  const memory = { withdrawnSources: vi.fn(async () => ({ revision: '0', sourceEventIds: [], sourceMessageIds: [] })), catalog: vi.fn(async () => ({ items: originals, tags: [] })),
    readNote: vi.fn(async (_scope: unknown, input: { id: string }) => originals.find(note => note.id === input.id)), associateDiaries: vi.fn(async () => ({ engine: 'DailyNoteManager.Associate', sourceRevision: '0', items: [], queries: [] })), maintenanceWork: undefined as unknown as BotMemoryService['maintenanceWork'] };
  memory.maintenanceWork = workFixture(memory.catalog, f.store);
  const report = vi.fn<(error: unknown) => void>();
  const value = new BotMaintenanceRuntime({ store: f.store, root: f.root, brain, memory, report,
    model: () => ({ apiFormat: 'openai_chat', baseUrl, apiKey: 'localhost-fixture-no-production-key', model: 'local-http-fixture', contextWindow: 65536, maxTokens: 512 }),
    callback: async () => ({ url: 'http://127.0.0.1:9/bot/tool', token: 'unused-fixture' }), changed: () => undefined } as unknown as BotMaintenanceRuntimeOptions);
  cleanups.push(() => value.close()); return { value, memory, report };
}
it('renews native admission after a confirmed terminal failure while preserving the frozen source snapshot', async () => {
  const f = fixture();
  let attempts = 0;
  const admissions = vi.fn<BotMaintenanceRuntimeOptions['brain']['run']>(async input => {
    if (++attempts === 1) throw new BotDshTurnFailedError(input.eventId, 'DSH model HTTP 503', '', false);
    return { status: 'succeeded', text: '{"narrative":"本批无需改写。","candidates":[]}', eventId: input.eventId, sessionId: input.laneId };
  });
  const brain = { run: admissions, archive: vi.fn(async () => undefined) };
  const r = realCoreRuntime(f, brain as unknown as BotMaintenanceRuntimeOptions['brain']);
  const job = r.value.journal.enqueue(f.scope, 'organize', 'native-terminal-retry');
  expect((await execute(f, r.value)).result.status).toBe('failed');
  const before = r.value.journal.get(f.scope, job.id), frozen = JSON.stringify(before.snapshot);
  expect(before.job.status).toBe('blocked'); expect(before.job.error).toContain('HTTP 503');
  expect(r.report).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEMORY_MAINTENANCE_MODEL_FAILED', cause: expect.any(BotDshTurnFailedError) }));
  expect(f.store.getMetadata(`maintenance-new-admission:${job.id}`)).toBe('1');
  r.value.journal.control(f.scope, job.id, 'retry', 'explicit-native-retry');
  expect((await execute(f, r.value)).result.status).toBe('done');
  const after = r.value.journal.get(f.scope, job.id);
  expect(after.job.status).toBe('completed'); expect(after.plan).toBeDefined(); expect(JSON.stringify(after.snapshot)).toBe(frozen);
  expect(admissions).toHaveBeenCalledTimes(2);
  expect(admissions.mock.calls[0]![0].laneId).not.toBe(admissions.mock.calls[1]![0].laneId);
  expect(admissions.mock.calls[0]![0].eventId).not.toBe(admissions.mock.calls[1]![0].eventId);
  expect(admissions.mock.calls[0]![0].prompt).toBe(admissions.mock.calls[1]![0].prompt);
  expect(r.memory.catalog).toHaveBeenCalledOnce(); expect(r.memory.readNote).toHaveBeenCalledTimes(2);
});
it('preserves typed unknown delivery through the actual core/runtime without enabling a fresh admission', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = fixture(), unknown = new BotDshDeliveryUnknownError('unconfirmed model delivery');
  const brain = { run: vi.fn<BotMaintenanceRuntimeOptions['brain']['run']>(async () => { throw unknown; }), archive: vi.fn(async () => undefined) };
  const r = realCoreRuntime(f, brain as unknown as BotMaintenanceRuntimeOptions['brain']);
  const job = r.value.journal.enqueue(f.scope, 'organize', 'typed-unknown'); await execute(f, r.value);
  expect(r.report).toHaveBeenCalledWith(unknown); expect(f.store.getMetadata(`maintenance-new-admission:${job.id}`)).not.toBe('1');
  vi.setSystemTime(Date.now() + 30001); await execute(f, r.value);
  expect(brain.run).toHaveBeenCalledTimes(2);
  const identities = brain.run.mock.calls.map(([input]) => ({ laneId: input.laneId, eventId: input.eventId, prompt: input.prompt }));
  expect(identities[0]).toEqual(identities[1]); expect(brain.archive).not.toHaveBeenCalled();
  expect(f.store.getMetadata(`maintenance-new-admission:${job.id}`)).not.toBe('1');
});
it('does not let terminal-lane cleanup failure mask the confirmed failure receipt', async () => {
  const f = fixture();
  const brain = { run: vi.fn<BotMaintenanceRuntimeOptions['brain']['run']>(async input => { throw new BotDshTurnFailedError(input.eventId, 'confirmed HTTP 503', '', false); }),
    archive: vi.fn(async () => { throw new Error('local cleanup failed'); }) };
  const r = realCoreRuntime(f, brain as unknown as BotMaintenanceRuntimeOptions['brain']);
  const job = r.value.journal.enqueue(f.scope, 'organize', 'cleanup-after-terminal'); await execute(f, r.value);
  expect(r.report).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEMORY_MAINTENANCE_MODEL_FAILED', cause: expect.any(BotDshTurnFailedError) }));
  expect(f.store.getMetadata(`maintenance-new-admission:${job.id}`)).toBe('1');
  const diagnostic = f.store.taskTransaction(sql => sql.prepare("SELECT text FROM bot_maintenance_diagnostics WHERE job_id=? AND phase='model-response' ORDER BY sequence DESC LIMIT 1").get(job.id)) as { text: string };
  expect(JSON.parse(diagnostic.text)).toMatchObject({ outcome: 'host-terminal-failure-confirmed', cleanupError: 'local cleanup failed' });
});
it('persists successful companion cooldowns across restart and separates successive agent dreams', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = new Date(2026, 0, 21, 1, 30).getTime(); vi.setSystemTime(at);
  const f = fixture(); f.journal.settings(f.scope); f.journal.settings(f.foreign);
  f.journal.recordDreamAttemptFinished(at - 60000);
  expect(f.journal.dreamExecutionDelay(f.scope, at - 59500)).toBe(29500);
  expect(f.journal.dreamExecutionDelay(f.scope, at)).toBe(0);
  f.journal.recordDreamSuccess(f.scope, at); f.reopen();
  expect(f.journal.dreamExecutionDelay(f.scope, at + 1000)).toBe(8 * 3600000 - 1000);
  expect(f.journal.dreamExecutionDelay(f.foreign, at + 1000)).toBe(29000);
  expect(f.journal.dreamExecutionDelay(f.foreign, at + 30000)).toBe(0);
  expect(await scheduled(f.journal, at + 15 * 60000, () => 0)).toEqual([f.foreign]);
  expect(await scheduled(f.journal, at + 30 * 60000, () => 0)).toEqual([]);
});
it('stops sampling at 06:00 local, respects disabling the clock and never replays missed daytime draws', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = new Date(2026, 0, 21, 5, 45).getTime(); vi.setSystemTime(at);
  const f = fixture(), roll = vi.fn(() => 0);
  f.journal.settings(f.scope);
  expect(await scheduled(f.journal, at + 15 * 60000, roll)).toEqual([]);
  expect(roll).not.toHaveBeenCalled();
  f.journal.updateSettings(f.scope, { enabled: false });
  expect(await scheduled(f.journal, at + 24 * 3600000, roll)).toEqual([]);
  expect(roll).not.toHaveBeenCalled();
});
it('rolls once per companion and isolates the selected audience when several chats are eligible', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = new Date(2026, 0, 21, 1, 0).getTime(); vi.setSystemTime(at);
  const f = fixture(), group = f.store.createGroup({ title: 'group', memberIds: ['alice', 'bob'] });
  const newer = { ...f.scope, conversationId: group.id, securityDomainId: group.securityDomainId };
  f.journal.activity(f.scope);
  vi.setSystemTime(at + 1000); f.journal.activity(newer);
  vi.setSystemTime(at + 2000);
  for (let i = 0; i < 34; i++) {
    const departed = f.store.createGroup({ title: 'departed-' + i, memberIds: ['alice', 'bob'], reuseMembers: false });
    f.journal.activity({ ...f.scope, conversationId: departed.id, securityDomainId: departed.securityDomainId });
    f.store.taskTransaction(sql => sql.prepare('DELETE FROM bot_members WHERE conversation_id=? AND member_id=?').run(departed.id, 'alice'));
  }
  const roll = vi.fn(() => 0);
  expect(await scheduled(f.journal, at + 15 * 60000, roll)).toEqual([newer]);
  expect(roll).toHaveBeenCalledTimes(1);
  expect(f.journal.list(f.scope).items).toHaveLength(0);
});
it('serves foreground work between native clock pages and advances the clock without rewriting audience settings', async () => {
  const at = new Date(2026, 0, 21, 1).getTime(), f = fixture();
  const existing = f.journal.settings(f.scope, at);
  for (let i = 0; i < 65; i++) {
    const id = 'dream-test-' + i;
    f.store.createCompanion({ id, name: id, persona: '伙伴' });
    const room = f.store.openDirect(id);
    f.journal.settings({ companionId: id, conversationId: room.id, securityDomainId: room.securityDomainId }, at);
  }
  const rawSettings = () => f.store.taskTransaction(sql => sql.prepare('SELECT settings_json FROM bot_maintenance_settings ORDER BY owner_key').all());
  const before = rawSettings();
  let draws = 0, drawsAtRead = 0;
  let result: ReturnType<BotStore['getConversation']>;
  const roll = () => {
    if (++draws === 1) setImmediate(() => { result = f.store.getConversation(f.scope.conversationId); drawsAtRead = draws; });
    return 1;
  };
  expect(await scheduled(f.journal, at + 15 * 60000, roll)).toEqual([]);
  expect(result?.id).toBe(f.scope.conversationId);
  expect(drawsAtRead).toBeGreaterThan(0); expect(drawsAtRead).toBeLessThanOrEqual(16); expect(draws).toBe(66);
  expect(rawSettings()).toEqual(before);
  expect(existing.nextEligibleAt).toBe(new Date(at + 15 * 60000).toISOString());
  expect(f.journal.settings(f.scope, at + 15 * 60000).nextEligibleAt).toBe(new Date(at + 30 * 60000).toISOString());
});

it('keeps plan snapshots and candidate reviews durable across reopen, with CAS revision and no self-approval', () => {
  const f = fixture(), job = f.journal.enqueue(f.scope, 'dream', 'manual-one'); f.journal.snapshot(f.scope, job.id, snapshot(f.scope, job.id)); f.journal.savePlan(f.scope, job.id, plan(f.scope, job.id, ['organize', 'insight', 'archive']));
  f.reopen(); expect(f.journal.get(f.scope, job.id).snapshot?.sources).toHaveLength(2);
  const detail = f.journal.candidate(f.scope, job.id, 'candidate-1'); expect(detail).toMatchObject({ type: 'insight', status: 'pending', uncertaintyCount: 1 });
  expect(() => f.journal.review(f.scope, job.id, detail.id, '0'.repeat(64), 'approve', 'stale')).toThrow('版本');
  expect(f.journal.review(f.scope, job.id, detail.id, detail.revision, 'reject', 'reject-one').status).toBe('rejected');
  expect(() => f.journal.review(f.scope, job.id, detail.id, detail.revision, 'approve', 'different')).toThrow('其他决定');
  expect(f.journal.candidates(f.scope, job.id).items.filter(item => item.status === 'pending')).toHaveLength(2);
});
it('requires a human decision on dream proposals even when the organizer has automatic review enabled', () => {
  const f = fixture(), job = f.journal.enqueue(f.scope, 'dream', 'dream-for-review');
  f.journal.updateSettings(f.scope, { autoReview: true });
  f.journal.savePlan(f.scope, job.id, { ...plan(f.scope, job.id, ['insight', 'archive']), kind: 'dream' });
  expect(f.journal.queueAutomaticReview()).toBeUndefined();
  expect(f.journal.get(f.scope, job.id).job.autoReview).toBeUndefined();
  expect(f.journal.candidates(f.scope, job.id).items.map(item => item.status)).toEqual(['pending', 'pending']);
});
it('defers model review before admission while that companion already has a foreground turn', async () => {
  const f = fixture(), busy = vi.fn(() => true), { value } = runtime(f, 12, busy);
  const job = f.journal.enqueue(f.scope, 'organize', 'busy-review');
  const planning = f.store.claimMemoryJob({ workerId: 'fixture-planner' })!;
  f.store.settleMemoryJob({ id: planning.job.id, leaseToken: planning.leaseToken, status: 'done' });
  f.journal.savePlan(f.scope, job.id, plan(f.scope, job.id));
  expect(f.journal.queueAutomaticReview(f.scope)).toEqual(f.scope);
  const claim = f.store.claimMemoryJob({ workerId: 'fixture-reviewer' })!;
  expect(claim.job.payload.operation).toBe('review');
  expect(await value.run(claim, new AbortController().signal)).toMatchObject({ status: 'retry' });
  expect(busy).toHaveBeenCalledWith(f.scope.companionId);
  expect(f.journal.reviews(f.scope, job.id).items).toHaveLength(0);
});
it('binds jobs/candidates/diagnostic pages to the real audience and returns exact Unicode pages', () => {
  const f = fixture(), job = f.journal.enqueue(f.scope, 'organize', 'page'); f.journal.savePlan(f.scope, job.id, plan(f.scope, job.id));
  const body = '🐳辉夜'.repeat(2000); f.journal.diagnostic(f.scope, job.id, 'raw', body);
  const log = f.journal.diagnostics(f.scope, job.id, { limit: 1 }); expect(log.items).toHaveLength(1); expect(log.nextAfter).toBeDefined();
  const id = f.journal.diagnostics(f.scope, job.id, { after: log.nextAfter }).items[0]!.id;
  const first = f.journal.diagnostics(f.scope, job.id, { entryId: id }).entry!, second = f.journal.diagnostics(f.scope, job.id, { entryId: id, offset: first.nextOffset }).entry!;
  expect(first.text + second.text).toBe(body); expect(first.total).toBe(6000);
  expect(() => f.journal.get(f.foreign, job.id)).toThrow('受众'); expect(() => f.journal.candidate(f.foreign, job.id, 'candidate-0')).toThrow(); expect(() => f.journal.diagnostics(f.foreign, job.id, { entryId: id })).toThrow();
});
it('replays both accepted and deduplicated tool admissions from durable receipts after the old job finishes', () => {
  const f = fixture(), first = f.journal.planTool(f.scope, 'organize', 'call-1') as { accepted: boolean; job: { id: string } }, second = f.journal.planTool(f.scope, 'dream', 'call-2');
  expect(first.accepted).toBe(true); expect(second).toMatchObject({ accepted: false, job: { id: first.job.id } });
  f.journal.progress(f.scope, first.job.id, 'completed', 'completed'); f.reopen();
  expect(f.journal.planTool(f.scope, 'dream', 'call-2')).toEqual(second); expect(f.journal.list(f.scope).items).toHaveLength(1);
  expect(f.journal.toolReceipt(f.scope, 'organize', 'missing')).toEqual({ found: false }); expect(() => f.journal.toolReceipt(f.scope, 'dream', 'call-1')).toThrow('参数');
});
it('stores a frozen plan before model admission, and only finishes an approved candidate on a real indexed receipt', async () => {
  const f = fixture(), r = runtime(f); const prepare = vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => { const value = snapshot(input.scope, input.operationId); await input.onSnapshot(value); expect(f.journal.get(f.scope, input.operationId).snapshot).toEqual(value); return plan(input.scope, input.operationId); });
  const apply = vi.spyOn(BotMemoryMaintenance.prototype, 'applyCandidate').mockResolvedValue({ actionId: 'candidate-0', operationId: 'same-operation', status: 'pending', receipt: { state: 'pending' } });
  const job = f.journal.enqueue(f.scope, 'organize', 'prepare'); await execute(f, r.value); expect(prepare).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled();
  const candidate = f.journal.candidate(f.scope, job.id, 'candidate-0'); f.journal.review(f.scope, job.id, candidate.id, candidate.revision, 'approve', 'approve');
  const pending = await execute(f, r.value); expect(pending.result.status).toBe('retry'); expect(f.journal.get(f.scope, job.id).job.status).not.toBe('completed');
  apply.mockResolvedValue({ actionId: 'candidate-0', operationId: 'same-operation', status: 'indexed', receipt: { state: 'indexed', id: 'c'.repeat(64) } });
  const second = f.store.claimMemoryJob({ workerId: 'retry', now: Date.now() + 30000 })!; const result = await r.value.run(second, new AbortController().signal); f.store.settleMemoryJob({ id: second.job.id, leaseToken: second.leaseToken, ...result });
  expect(f.journal.get(f.scope, job.id).job).toMatchObject({ status: 'completed', metrics: { applied: 1 } }); expect(apply.mock.calls[0]![0].plan).toEqual(apply.mock.calls[1]![0].plan);
});
it('clears withdrawn maintenance material and blocks old candidates without silently replacing original source notes', () => {
  const f = fixture(), job = f.journal.enqueue(f.scope, 'dream', 'withdraw'); f.journal.snapshot(f.scope, job.id, snapshot(f.scope, job.id)); f.journal.savePlan(f.scope, job.id, plan(f.scope, job.id));
  f.journal.invalidate(f.scope); const saved = f.journal.get(f.scope, job.id);
  expect(saved).toMatchObject({ job: { status: 'blocked', phase: 'source_withdrawn' } }); expect(saved.plan).toBeUndefined(); expect(saved.snapshot).toBeUndefined();
  expect(JSON.stringify(f.journal.candidates(f.scope, job.id))).not.toContain('PRIVATE'); expect(JSON.stringify(f.journal.diagnostics(f.scope, job.id, { entryId: 1 }))).not.toContain('PRIVATE');
  expect(() => f.journal.candidate(f.scope, job.id, 'candidate-0')).toThrow();
});
it('validates bounded maintenance input and rejects approval via an unrecognized action', () => {
  const base = { conversationId: 'room', companionId: 'alice' };
  expect(botRequestSchema.safeParse({ ...base, type: 'memory.maintenance.list', limit: 21 }).success).toBe(false);
  expect(botRequestSchema.safeParse({ ...base, type: 'memory.maintenance.settings.update', settings: { enabled: true, autoReview: true } }).success).toBe(true);
  expect(botRequestSchema.safeParse({ ...base, type: 'memory.maintenance.review', jobId: 'j', candidateId: 'c', revision: 'a'.repeat(64), decision: 'self-approve', requestId: 'r' }).success).toBe(false);
});
it('cancels a real in-flight planning signal, then explicitly resumes the same frozen source with one known-cancel admission', async () => {
  const f = fixture(), r = runtime(f); let admitted!: () => void; const waiting = new Promise<void>(resolve => { admitted = resolve; });
  const calls: Array<{ attempt: number; source?: BotMemoryMaintenanceSnapshot }> = [];
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => {
    calls.push({ attempt: input.admissionAttempt ?? 0, source: input.snapshot });
    if (calls.length > 1) return plan(input.scope, input.operationId);
    await input.onSnapshot(snapshot(input.scope, input.operationId)); admitted();
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Durably cancelled'), { code: 'BOT_ABORT_ACKNOWLEDGED' })), { once: true }));
    throw new Error('Unreachable');
  });
  const job = f.journal.enqueue(f.scope, 'organize', 'cancel'); const first = execute(f, r.value); await waiting;
  await r.value.handle({ type: 'memory.maintenance.cancel', companionId: f.scope.companionId, conversationId: f.scope.conversationId, jobId: job.id, requestId: 'stop' }, f.scope); await first;
  expect(f.journal.get(f.scope, job.id).job.status).toBe('cancelled');
  f.journal.control(f.scope, job.id, 'retry', 'resume'); await execute(f, r.value);
  expect(calls.map(call => call.attempt)).toEqual([0, 1]); expect(calls[1]!.source?.sources).toHaveLength(2); expect(f.journal.get(f.scope, job.id).job.status).toBe('review');
});
it.each([true, false])('yields an in-flight dream to a new greeting and resumes it (automatic=%s)', async automatic => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), r = runtime(f), started = new Date(2026, 0, 21, 1).getTime(); vi.setSystemTime(started); f.journal.settings(f.scope); vi.setSystemTime(started + 16 * 60000);
  let admitted!: () => void; const waiting = new Promise<void>(resolve => { admitted = resolve; }); const attempts: number[] = [];
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => {
    attempts.push(input.admissionAttempt ?? 0);
    if (attempts.length > 1) return plan(input.scope, input.operationId);
    await input.onSnapshot(snapshot(input.scope, input.operationId)); admitted();
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Known cancelled'), { code: 'BOT_ABORT_ACKNOWLEDGED' })), { once: true })); throw new Error('Unreachable');
  });
  const job = f.journal.enqueue(f.scope, 'dream', 'interruptible-dream', automatic), first = execute(f, r.value); await waiting;
  r.value.userMessage(f.scope, false); expect((await first).result.status).toBe('retry'); expect(f.journal.get(f.scope, job.id).job).toMatchObject({ status: 'queued', phase: 'waiting_idle' });
  const capture = f.store.enqueueMemoryJob({ kind: 'mutation', key: 'new-user-mutation', payload: { scope: f.scope } }), claim = f.store.claimMemoryJob({ workerId: 'foreground-mutation' })!;
  expect(claim.job.id).toBe(capture.id); f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: 'done' });
  vi.setSystemTime(Date.now() + 15 * 60000 + 1); await execute(f, r.value);
  expect(attempts).toEqual([0, 1]); expect(f.journal.get(f.scope, job.id).job.status).toBe('review'); expect(f.journal.list(f.scope).items).toHaveLength(1);
});
it('never creates a fresh model admission to hide an unknown delivery, including after durable reopen', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = fixture(); let r = runtime(f); const attempts: number[] = [];
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => { attempts.push(input.admissionAttempt ?? 0); if (attempts.length > 1) return plan(input.scope, input.operationId); await input.onSnapshot(snapshot(input.scope, input.operationId)); throw Object.assign(new Error('delivery unknown'), { code: 'BOT_DELIVERY_UNKNOWN' }); });
  const job = f.journal.enqueue(f.scope, 'organize', 'unknown'); expect((await execute(f, r.value)).result.status).toBe('retry'); expect(f.journal.get(f.scope, job.id).job.status).toBe('queued');
  await r.value.close(); f.reopen(); r = runtime(f); vi.setSystemTime(Date.now() + 30001); await execute(f, r.value);
  expect(attempts).toEqual([0, 0]); expect(f.journal.get(f.scope, job.id).snapshot?.sourceRevision).toBe('0');
});
it('starts new native jobs without reusing a saved legacy catalog cursor or deferred cycle', async () => {
  const f = fixture(), r = runtime(f);
  const owner = maintenanceOwner(f.scope);
  f.store.setMetadata('maintenance-scan-cursor:' + owner + ':organize', 'obsolete-page');
  f.store.setMetadata('maintenance-scan-cycle:' + owner + ':organize', '{"version":1,"deferred":true}');
  const prepare = vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => plan(input.scope, input.operationId, []));
  f.journal.enqueue(f.scope, 'organize', 'after-old-cursor');
  await execute(f, r.value);
  expect(prepare.mock.calls[0]![0]).toMatchObject({ cursor: undefined, selectBatch: expect.any(Function) });
});
it('only polls the persisted journal, and leaves it untouched after shutdown', async () => {
  const f = fixture(), r = runtime(f);
  await r.value.close();
  const sample = vi.spyOn(r.value.journal, 'scheduleDreams');
  r.value.poll();
  expect(sample).not.toHaveBeenCalled();
  expect(r.catalog).not.toHaveBeenCalled();
});

it('coalesces offline diary changes into one idle dream and preserves concurrent writes plus the previous foreground time across restart', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const at = new Date(2026, 0, 21, 15).getTime(), week = 7 * 86400000;
  vi.setSystemTime(at - week);
  const f = fixture();
  f.journal.activity(f.scope);
  expect(await idleDream(f.journal, at - week)).toEqual([]);
  f.journal.activity(f.scope, 'indexed-v1'); f.journal.activity(f.scope, 'indexed-v1'); f.journal.activity(f.scope, 'indexed-v2');
  f.journal.recordForeground('alice', at - week); f.journal.recordForeground('alice', at - week - 1);
  f.reopen(); vi.setSystemTime(at);
  expect(f.journal.lastForegroundAt('alice')).toBe(at - week);
  expect(await idleDream(f.journal, at)).toEqual([f.scope]);
  const first = f.journal.list(f.scope).items[0]!;
  expect(first).toMatchObject({ kind: 'dream', trigger: 'idle', automatic: true });
  expect(await idleDream(f.journal, at + 60000)).toEqual([]);
  f.journal.activity(f.scope, 'indexed-while-dreaming');
  f.journal.savePlan(f.scope, first.id, dreamPlan(f.scope, first.id));
  f.journal.recordDreamSuccess(f.scope, at);
  expect(await idleDream(f.journal, at + 2 * 3600000)).toEqual([]);
  expect(await idleDream(f.journal, at + 8 * 3600000)).toEqual([f.scope]);
  const next = f.journal.list(f.scope).items[0]!;
  f.journal.savePlan(f.scope, next.id, dreamPlan(f.scope, next.id));
  expect(await idleDream(f.journal, at + week)).toEqual([]);
  expect(f.journal.list(f.scope).items).toHaveLength(2);
});
it('allows Bob to be admitted while Alice yielded or is backing off, while keeping separate audiences for Alice deduplicated', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const at = new Date(2026, 0, 21, 13).getTime(); vi.setSystemTime(at);
  const f = fixture(), group = f.store.createGroup({ title: 'another audience', memberIds: ['alice', 'bob'] });
  const otherAlice = { companionId: 'alice', conversationId: group.id, securityDomainId: group.securityDomainId };
  f.journal.activity(f.scope, 'v1');
  expect(await idleDream(f.journal, at)).toEqual([f.scope]);
  const alice = f.journal.list(f.scope).items[0]!;
  const lease = f.store.claimMemoryJob({ workerId: 'actual-running-dream', now: at })!;
  f.journal.start(f.scope, alice.id, false);
  f.journal.activity(otherAlice, 'other-audience-v1'); f.journal.activity(f.foreign, 'bob-v1');
  expect(await idleDream(f.journal, at + 1000)).toEqual([]);
  f.journal.progress(f.scope, alice.id, 'waiting_idle', 'queued');
  f.store.settleMemoryJob({ id: lease.job.id, leaseToken: lease.leaseToken, status: 'retry', retryDelayMs: 3600000 });
  expect(await idleDream(f.journal, at + 60000, id => id === 'bob')).toEqual([f.foreign]);
  expect(f.journal.list(otherAlice).items).toHaveLength(0);
  expect(f.journal.list(f.foreign).items[0]!.trigger).toBe('idle');
});
it('recovers old confirmed changes after manual organizing and honors exactly the frozen nightly source version at midday', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const at = new Date(2026, 0, 21, 12).getTime(); vi.setSystemTime(at);
  const f = fixture();
  f.journal.activity(f.scope, 'pre-upgrade-note');
  const organized = f.journal.enqueue(f.scope, 'organize', 'manual');
  f.journal.savePlan(f.scope, organized.id, plan(f.scope, organized.id, []));
  f.store.taskTransaction(sql => sql.prepare('UPDATE bot_maintenance_settings SET dream_planned=-1,dream_ready_at=0').run());
  expect(await idleDream(f.journal, at)).toEqual([f.scope]);
  const idle = f.journal.list(f.scope).items[0]!;
  f.journal.control(f.scope, idle.id, 'cancel', 'cancel-empty-lease');
  const night = f.journal.enqueue(f.scope, 'dream', 'night-carryover', true);
  expect(f.journal.dreamExecutionDelay(f.scope, at, { trigger: 'night', allowDaytime: false })).toBe(60000);
  expect(f.journal.dreamExecutionDelay(f.scope, at, { trigger: 'night', allowDaytime: true })).toBe(0);
  expect(f.journal.dreamExecutionDelay(f.scope, at, { trigger: 'idle', allowDaytime: false })).toBe(60000);
  f.journal.savePlan(f.scope, night.id, dreamPlan(f.scope, night.id, false));
  expect(f.journal.enqueueIdleOrganization(f.scope, night.id)).toBeUndefined();
  f.store.taskTransaction(sql => sql.prepare('UPDATE bot_maintenance_settings SET dream_planned=-1,dream_ready_at=0').run());
  expect(await idleDream(f.journal, at + 2 * 3600000)).toEqual([f.scope]);
  const later = f.journal.list(f.scope).items[0]!;
  f.journal.savePlan(f.scope, later.id, dreamPlan(f.scope, later.id));
  expect(await idleDream(f.journal, at + 4 * 3600000)).toEqual([]);
});
it('falls back from old seedless diaries to durable incremental organization until its native queue is empty and honors the organizer review setting', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const at = new Date(2026, 0, 21, 12).getTime(); vi.setSystemTime(at);
  const f = fixture(); f.journal.updateSettings(f.scope, { autoReview: true }); f.journal.activity(f.scope, 'old-indexed-diary');
  await idleDream(f.journal, at);
  const wave = f.journal.list(f.scope).items[0]!;
  const empty = dreamPlan(f.scope, wave.id, false);
  f.journal.savePlan(f.scope, wave.id, { ...empty, scan: { ...empty.scan, deferred: [{ id: 'a', reason: 'temporarily unavailable', retryable: true }] } });
  expect(f.journal.enqueueIdleOrganization(f.scope, wave.id)).toBeUndefined();
  f.journal.savePlan(f.scope, wave.id, empty);
  const fallback = f.journal.enqueueIdleOrganization(f.scope, wave.id)!;
  expect(fallback).toMatchObject({ kind: 'organize', trigger: 'idle', automatic: true });
  expect(f.journal.enqueueIdleOrganization(f.scope, wave.id)!.id).toBe(fallback.id);
  f.reopen();
  f.journal.activity(f.scope, 'new-during-fallback');
  f.journal.savePlan(f.scope, fallback.id, plan(f.scope, fallback.id, ['organize']));
  expect(f.journal.queueAutomaticReview(f.scope)).toEqual(f.scope);
  expect(f.journal.get(f.scope, fallback.id).job.autoReview?.total).toBe(1);
  f.journal.finishIdleOrganization(f.scope, fallback.id, { hasMore: true, retryAt: at + 120000 });
  expect(await idleDream(f.journal, at + 60000)).toEqual([]);
  vi.setSystemTime(at + 120000);
  expect(await idleDream(f.journal, at + 120000)).toEqual([f.scope]);
  const continued = f.journal.list(f.scope).items[0]!;
  expect(continued).toMatchObject({ kind: 'organize', trigger: 'idle' });
  f.journal.savePlan(f.scope, continued.id, plan(f.scope, continued.id, []));
  f.journal.finishIdleOrganization(f.scope, continued.id, { hasMore: false });
  expect(await idleDream(f.journal, at + 3600000)).toEqual([f.scope]);
  const newer = f.journal.list(f.scope).items[0]!;
  expect(newer).toMatchObject({ kind: 'dream', trigger: 'idle' });
  f.journal.savePlan(f.scope, newer.id, dreamPlan(f.scope, newer.id));
  expect(await idleDream(f.journal, at + 2 * 3600000)).toEqual([]);
});

it('reopens after the 30-day maturation and organizes once even when the dream already covered the last diary', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const created = new Date(2026, 0, 2, 12).getTime();
  vi.setSystemTime(created);
  const f = fixture(); f.journal.activity(f.scope, 'indexed-in-january');
  const wave = f.journal.enqueue(f.scope, 'dream', 'night-after-writing', true);
  f.journal.savePlan(f.scope, wave.id, dreamPlan(f.scope, wave.id));
  expect(await idleDream(f.journal, created + 29 * 86400000)).toEqual([]);
  f.reopen();
  const opened = created + 37 * 86400000; vi.setSystemTime(opened);
  expect(await idleDream(f.journal, opened, () => false)).toEqual([]);
  vi.setSystemTime(opened + 60001);
  expect(await idleDream(f.journal, Date.now())).toEqual([f.scope]);
  const job = f.journal.list(f.scope).items[0]!;
  expect(job).toMatchObject({ kind: 'organize', trigger: 'idle', automatic: true });
  f.journal.savePlan(f.scope, job.id, plan(f.scope, job.id, []));
  f.journal.finishIdleOrganization(f.scope, job.id, { hasMore: false });
  expect(await idleDream(f.journal, opened + 7 * 86400000)).toEqual([]);
});
