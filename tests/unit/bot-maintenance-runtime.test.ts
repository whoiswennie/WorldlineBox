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
  return { format: 'worldlinebox-memory-maintenance-snapshot-v1', operationId, scope, kind: 'organize', contextEpoch: 1, sourceRevision: '0', createdAt: new Date().toISOString(), scan: { examined: 2, selected: 2, deferred: [] },
    sources: ['a', 'b'].map(id => ({ id: id.repeat(64), checksum: id.repeat(32), content: 'PRIVATE 原始资料 ' + id, tags: ['日常'], createdAt: new Date().toISOString(), sourceMessageIds: ['message-' + id] })), retrieval: { engine: 'LightMemo', result: {} } };
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
      tool: vi.fn(async () => ({ results: [] })) },
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
});
function plan(scope: BotMemoryScope, operationId: string, types: Array<'organize' | 'insight' | 'archive'> = ['organize']): BotMemoryMaintenancePlan {
  return { ...snapshot(scope, operationId), format: 'worldlinebox-memory-maintenance-v1', id: 'f'.repeat(64), narrative: '推测：可能有共同线索，尚未写成用户事实。', candidates: types.map((type, index) => ({ id: 'candidate-' + index, type, sourceIds: type === 'organize' ? ['a'.repeat(64), 'b'.repeat(64)] : ['a'.repeat(64)], content: 'PRIVATE 提案正文 ' + index, tags: ['待审'], reason: '待人工确认', uncertainties: ['未证实的联系'], quotes: [{ sourceId: 'a'.repeat(64), text: 'PRIVATE 原始资料 a' }] })) };
}
function runtime(f: ReturnType<typeof fixture>, liveEligibleCount: number | null = 12) {
  const catalog = vi.fn(async () => ({ items: [{ indexState: 'indexed' }], total: 999, ...(liveEligibleCount === null ? {} : { liveEligibleCount }) }));
  const options = { store: f.store, root: f.root, memory: { catalog, maintenanceWork: workFixture(catalog) }, brain: {}, model: () => ({ apiKey: 'never-used', model: 'fixture', baseUrl: 'http://127.0.0.1:9', apiFormat: 'openai_chat' }), callback: async () => ({ url: 'http://127.0.0.1:9', token: 'never-used' }), changed: vi.fn(), report: vi.fn() } as unknown as BotMaintenanceRuntimeOptions;
  const value = new BotMaintenanceRuntime(options); cleanups.push(() => value.close()); return { value, catalog };
}
async function execute(f: ReturnType<typeof fixture>, value: BotMaintenanceRuntime) {
  const claim = f.store.claimMemoryJob({ workerId: 'maintenance-test' })!; expect(claim).toBeDefined();
  const result = await value.run(claim, new AbortController().signal); f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result }); return { claim, result };
}
async function settlePoll(value: BotMaintenanceRuntime) { value.poll(); await new Promise(resolve => setTimeout(resolve, 20)); }
it('keeps invalid source evidence distinct from executor outages and releases the failed generation queue item', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(); f.journal.settings(f.scope); const r = runtime(f);
  vi.setSystemTime(Date.now() + 3600000); const job = r.value.journal.enqueue(f.scope, 'organize', 'invalid-evidence', true);
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockRejectedValueOnce(Object.assign(new Error('候选引用无法在来源原文中核对。'), { code: 'MEMORY_MAINTENANCE_INVALID_PLAN' }));
  const { result } = await execute(f, r.value); expect(result.status).toBe('failed');
  expect(r.value.journal.get(f.scope, job.id).job).toMatchObject({ status: 'blocked', phase: 'invalid_plan' });
  expect(f.store.listPendingMemory().filter(item => item.status === 'queued')).toHaveLength(0);
  const next = r.value.journal.enqueue(f.foreign, 'organize', 'other-task');
  expect(f.store.claimMemoryJob({ workerId: 'next-task' })?.job.payload.jobId).toBe(next.id);
});
it('backs off repeated provider failures without exhausting a retry quota or blocking another memory domain', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), at = Date.now(); f.journal.activity(f.scope, 'diary'); vi.setSystemTime(at + 86400001);
  let calls = 0;
  const run = vi.fn<BotMaintenanceRuntimeOptions['brain']['run']>(async input => {
    if (++calls <= 5) throw new BotDshTurnFailedError(input.eventId, 'provider temporarily HTTP 503');
    return { text: '{"narrative":"已恢复","candidates":[]}', status: 'succeeded', eventId: input.eventId, sessionId: input.laneId };
  });
  const r = realCoreRuntime(f, { run, archive: vi.fn(async () => undefined) } as unknown as BotMaintenanceRuntimeOptions['brain']);
  const job = r.value.journal.enqueue(f.scope, 'organize', 'retry-until-recovery', true);
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
  expect(run).toHaveBeenCalledTimes(6); expect(r.memory.catalog).toHaveBeenCalledOnce();
});
it('catches up after several days offline and continues all pages without daily or unfinished-plan quotas', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), at = Date.now();
  f.journal.activity(f.scope, 'new-diary'); f.journal.updateSettings(f.scope, { intervalHours: 1, idleMinutes: 1 });
  f.reopen(); vi.setSystemTime(at + 3 * 86400000);
  const r = runtime(f); let page = 0;
  const prepare = vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => {
    const result = plan(input.scope, input.operationId); result.scan = { examined: 24, selected: 2, deferred: [], cursor: input.cursor, nextCursor: ++page < 6 ? `page-${page}` : undefined }; return result;
  });
  await settlePoll(r.value);
  expect(f.journal.list(f.scope).items).toHaveLength(1);
  for (let index = 0; index < 6; index++) expect((await execute(f, r.value)).result.status).toBe('done');
  expect(prepare).toHaveBeenCalledTimes(6); expect(f.journal.list(f.scope).items).toHaveLength(6);
  expect(f.journal.list(f.scope).items.every(job => job.status === 'review')).toBe(true);
  expect(f.store.listPendingMemory().filter(job => job.kind === 'maintenance')).toHaveLength(0);
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

it('automatically resumes a legacy output-limit failure and leaves unrelated failed jobs out of the scheduling gate', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), at = Date.now(); f.journal.activity(f.scope, 'source');
  const job = f.journal.enqueue(f.scope, 'organize', 'legacy-output', true), claim = f.store.claimMemoryJob({ workerId: 'old' })!;
  f.journal.start(f.scope, job.id, false); f.journal.snapshot(f.scope, job.id, snapshot(f.scope, job.id));
  f.journal.diagnostic(f.scope, job.id, 'error', { code: 'BOT_OUTPUT_LIMIT' }); f.journal.progress(f.scope, job.id, 'blocked', 'blocked', 'old output limit');
  f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: 'failed' });
  f.reopen(); vi.setSystemTime(at + 20 * 60000); const r = runtime(f);
  await settlePoll(r.value); expect(f.journal.get(f.scope, job.id).job.status).toBe('queued');
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => { const result = plan(input.scope, input.operationId); result.candidates = []; return result; });
  expect((await execute(f, r.value)).result.status).toBe('done');
  f.journal.activity(f.scope, 'later-diary');
  const bad = f.journal.enqueue(f.scope, 'organize', 'bad-plan', true);
  const queued = f.store.claimMemoryJob({ workerId: 'bad' })!;
  f.store.settleMemoryJob({ id: queued.job.id, leaseToken: queued.leaseToken, status: 'failed' });
  f.journal.progress(f.scope, bad.id, 'blocked', 'blocked', 'requires inspection');
  vi.setSystemTime(at + 2 * 86400000); expect(f.journal.due()).toEqual(f.scope);
});
function realCoreRuntime(f: ReturnType<typeof fixture>, brain: BotMaintenanceRuntimeOptions['brain'], baseUrl = 'http://127.0.0.1:9') {
  const originals = ['a', 'b'].map(id => ({ id: id.repeat(64), checksum: id.repeat(32), indexState: 'indexed', content: '隔离HTTP回归测试的来源日记：' + id,
    tags: ['测试'], createdAt: '2026-11-03T10:00:00Z', sourceMessageIds: [] }));
  const memory = { withdrawnSources: vi.fn(async () => ({ revision: '0', sourceEventIds: [], sourceMessageIds: [] })), catalog: vi.fn(async () => ({ items: originals, tags: [] })),
    readNote: vi.fn(async (_scope: unknown, input: { id: string }) => originals.find(note => note.id === input.id)), tool: vi.fn(async () => ({ results: [] })), maintenanceWork: undefined as unknown as BotMemoryService['maintenanceWork'] };
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
it('persists cold-start cooldown, unique dirty changes and settings without automatically admitting a model', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = fixture(), settings = f.journal.settings(f.scope), at = Date.now();
  expect(settings).toMatchObject({ enabled: true, autoApply: 'never', minNotes: 12, idleMinutes: 15 });
  expect(Date.parse(settings.nextEligibleAt) - at).toBe(86400000); expect(f.journal.due()).toBeUndefined();
  f.journal.activity(f.scope, 'source-indexed'); f.journal.activity(f.scope, 'source-indexed');
  f.reopen(); expect(f.journal.settings(f.scope)).toEqual({ ...settings, lastActivityAt: new Date(at).toISOString() });
  vi.setSystemTime(at + 86400001); expect(f.journal.due()).toEqual(f.scope);
  f.journal.updateSettings(f.scope, { enabled: false }); expect(f.journal.due()).toBeUndefined();
});
it('requires pending incremental versions and never treats retained catalog total as automatic eligibility', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), at = Date.now(); f.journal.activity(f.scope, 'changed'); vi.setSystemTime(at + 86400001);
  const r = runtime(f, null); await settlePoll(r.value);
  expect(r.catalog).toHaveBeenCalledTimes(1); expect(f.journal.list(f.scope).items).toEqual([]);
});
it('enforces same-domain memory leases before background planning and queues only one daily automatic plan', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), at = Date.now(); f.journal.activity(f.scope, 'changed'); vi.setSystemTime(at + 86400001);
  const r = runtime(f), capture = f.store.enqueueMemoryJob({ kind: 'capture', key: 'capture', payload: { scope: f.scope } });
  await settlePoll(r.value); expect(r.catalog).not.toHaveBeenCalled();
  const claim = f.store.claimMemoryJob({ workerId: 'capture' })!; expect(claim.job.id).toBe(capture.id); f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: 'done' });
  vi.setSystemTime(Date.now() + 60001); await settlePoll(r.value); expect(f.journal.list(f.scope).items).toHaveLength(1);
  const job = f.journal.list(f.scope).items[0]!; expect(job).toMatchObject({ automatic: true, status: 'queued' });
  expect(f.journal.enqueue(f.scope, 'dream', 'second-auto', true)).toMatchObject({ automatic: true, status: 'queued' });
  expect(f.store.claimMemoryJob({ workerId: 'one' })).toBeDefined(); expect(f.store.claimMemoryJob({ workerId: 'two' })).toBeUndefined();
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
  expect(f.store.getMetadata(`memory-capture-backfill-v2-suppressed:${maintenanceDomain(f.scope)}`)).toBe(job.id);
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
  expect(botRequestSchema.safeParse({ ...base, type: 'memory.maintenance.settings.update', settings: { intervalHours: 1, idleMinutes: 1 } }).success).toBe(true);
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
it('preempts automatic planning even for a greeting, yields its lease to capture, then resumes the same job after idle', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), r = runtime(f), started = Date.now(); f.journal.settings(f.scope); vi.setSystemTime(started + 16 * 60000);
  let admitted!: () => void; const waiting = new Promise<void>(resolve => { admitted = resolve; }); const attempts: number[] = [];
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => {
    attempts.push(input.admissionAttempt ?? 0);
    if (attempts.length > 1) return plan(input.scope, input.operationId);
    await input.onSnapshot(snapshot(input.scope, input.operationId)); admitted();
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Known cancelled'), { code: 'BOT_ABORT_ACKNOWLEDGED' })), { once: true })); throw new Error('Unreachable');
  });
  const job = f.journal.enqueue(f.scope, 'organize', 'automatic-idle', true), first = execute(f, r.value); await waiting;
  r.value.userMessage(f.scope, false); expect((await first).result.status).toBe('retry'); expect(f.journal.get(f.scope, job.id).job).toMatchObject({ status: 'queued', phase: 'waiting_idle' });
  const capture = f.store.enqueueMemoryJob({ kind: 'capture', key: 'new-user-capture', payload: { scope: f.scope } }), claim = f.store.claimMemoryJob({ workerId: 'capture-now' })!;
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
it('persists lossless approval mode through an unknown write and never auto-approves dream insights or archives', async () => {
  const f = fixture(), r = runtime(f); f.journal.updateSettings(f.scope, { autoApply: 'lossless' });
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => plan(input.scope, input.operationId, ['organize', 'insight', 'archive']));
  const apply = vi.spyOn(BotMemoryMaintenance.prototype, 'applyCandidate').mockResolvedValue({ actionId: 'candidate-0', operationId: 'lossless-effect', status: 'unknown' });
  const job = f.journal.enqueue(f.scope, 'organize', 'lossless'); await execute(f, r.value);
  expect(f.journal.candidates(f.scope, job.id).items.map(item => item.status)).toEqual(['approved', 'pending', 'pending']);
  await execute(f, r.value); expect(apply.mock.calls[0]![0].approval).toBe('lossless');
  f.journal.updateSettings(f.scope, { autoApply: 'never' }); f.journal.control(f.scope, job.id, 'retry', 'recover-lossless'); await execute(f, r.value);
  expect(apply.mock.calls[1]![0].approval).toBe('lossless'); expect(f.journal.candidates(f.scope, job.id).items.slice(1).every(item => item.status === 'pending')).toBe(true);
});
it('continues finite catalog batches past an archived first page and resets the cursor only at the true end', async () => {
  const f = fixture(), r = runtime(f); const cursors: Array<string | undefined> = [];
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => {
    cursors.push(input.cursor);
    const result = plan(input.scope, input.operationId, []); result.scan = { ...result.scan, examined: 24, selected: 0, nextCursor: cursors.length === 1 ? 'page-two' : undefined }; return result;
  });
  const first = f.journal.enqueue(f.scope, 'organize', 'batch-first'); await execute(f, r.value); expect(f.journal.get(f.scope, first.id).job.nextCursor).toBe('page-two');
  f.reopen(); const next = runtime(f); f.journal.enqueue(f.scope, 'organize', 'batch-second'); await execute(f, next.value); f.journal.enqueue(f.scope, 'organize', 'batch-third'); await execute(f, next.value);
  expect(cursors).toEqual([undefined, 'page-two', undefined]);
});
it('retains deferred sources across every page and revisits the cycle instead of claiming whole-library completion', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), at = Date.now(); f.journal.activity(f.scope, 'first-note-change'); vi.setSystemTime(at + 86400001);
  const seen: Array<string | undefined> = []; let r = runtime(f);
  vi.spyOn(BotMemoryMaintenance.prototype, 'preparePlan').mockImplementation(async input => {
    seen.push(input.cursor); const result = plan(input.scope, input.operationId, []);
    result.scan = { ...result.scan, cursor: input.cursor, nextCursor: seen.length === 1 ? 'later-page' : undefined, deferred: seen.length === 1 ? [{ id: 'a'.repeat(64), reason: 'temporarily over current model budget' }] : [] }; return result;
  });
  f.journal.enqueue(f.scope, 'organize', 'deferred-first'); await execute(f, r.value);
  await r.value.close(); f.reopen(); r = runtime(f); f.journal.enqueue(f.scope, 'organize', 'deferred-last'); await execute(f, r.value);
  const state = () => f.store.taskTransaction(sql => sql.prepare('SELECT dirty,planned FROM bot_maintenance_settings WHERE owner_key=?').get(maintenanceOwner(f.scope))) as { dirty: number; planned: number };
  expect(state()).toEqual({ dirty: 1, planned: 0 }); expect(f.journal.due()).toEqual(f.scope);
  f.journal.enqueue(f.scope, 'organize', 'deferred-next-cycle'); await execute(f, r.value);
  expect(seen).toEqual([undefined, 'later-page', undefined]); expect(state()).toEqual({ dirty: 1, planned: 1 }); expect(f.journal.due()).toEqual(f.scope); // Eligibility now comes from the version queue, rather than the coarse dirty counter.
});
it.each(['resolve', 'reject'] as const)('bounds close while catalog never settles and fences late %s from the closed store', async outcome => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), at = Date.now(); f.journal.activity(f.scope, 'changed'); vi.setSystemTime(at + 86400001);
  const r = runtime(f); let reject!: (cause: unknown) => void, resolve!: (value: Awaited<ReturnType<typeof r.catalog>>) => void;
  r.catalog.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
  const defer = vi.spyOn(r.value.journal, 'defer'), enqueue = vi.spyOn(r.value.journal, 'enqueue'); r.value.poll();
  await new Promise(done => setTimeout(done, 10));
  const started = performance.now(); await r.value.close(); expect(performance.now() - started).toBeLessThan(2600);
  const rows = f.journal.list(f.scope).items.length;
  f.reopen();
  if (outcome === 'reject') reject(new Error('late native reader rejection after shutdown'));
  else resolve({ items: [{ indexState: 'indexed' }], total: 999, liveEligibleCount: 12 });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(defer).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled(); expect(f.journal.list(f.scope).items).toHaveLength(rows);
});
