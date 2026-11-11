import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotMaintenanceStore } from '../../src/main/companion-bot/memory-maintenance-store';
import { BotMaintenanceRuntime, type BotMaintenanceRuntimeOptions } from '../../src/main/companion-bot/memory-maintenance-runtime';
import { BotMemoryMaintenance, maintenanceDigest, type BotMemoryMaintenancePlan } from '../../src/main/companion-bot/memory-maintenance';
import { MEMORY_REVIEW_CRITERIA, MEMORY_REVIEW_PROMPT_VERSION } from '../../src/main/companion-bot/memory-maintenance-reviewer';
import { BotDshTurnFailedError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const at = '2026-11-11T00:00:00Z', a = 'a'.repeat(64), b = 'b'.repeat(64);
const verdict = (input: BotDshRun) => {
  const data = JSON.parse(input.prompt);
  return { decision: 'approve', reason: '逐项核对通过，来源和限定均完整保留。', checks: MEMORY_REVIEW_CRITERIA.map(criterion => ({ criterion, passed: true, reason: '已对照完整原件核查。' })),
    evidence: data.candidate.sources.map((source: { id: string }) => ({ sourceId: source.id, quote: source.id === a ? '用户计划周六去湖边，尚未出发。' : '用户改为博物馆，尚未订票。' })) };
};
async function fixture(types: Array<'organize' | 'update' | 'archive'> = ['organize']) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-auto-review-')), filename = path.join(root, 'bot.sqlite'); let store = new BotStore(filename);
  store.createCompanion({ id: 'alice', name: 'Alice', persona: '认真核对' }); const room = store.openDirect('alice');
  const scope = { companionId: 'alice', conversationId: room.id, securityDomainId: room.securityDomainId };
  const notes = [{ id: a, checksum: 'a'.repeat(32), content: '用户计划周六去湖边，尚未出发。', indexState: 'indexed', tags: [], createdAt: at, sourceMessageIds: [] },
    { id: b, checksum: 'b'.repeat(32), content: '用户改为博物馆，尚未订票。', indexState: 'indexed', tags: [], createdAt: at, sourceMessageIds: [] }];
  const run = vi.fn<BotMaintenanceRuntimeOptions['brain']['run']>(async input => ({ text: JSON.stringify(verdict(input)), eventId: input.eventId, sessionId: input.laneId, status: 'succeeded' }));
  const memory = { readNote: vi.fn(async (_scope: unknown, input: { id: string }) => notes.find(note => note.id === input.id)), withdrawnSources: vi.fn(async () => ({ revision: '0', sourceEventIds: [], sourceMessageIds: [] })), catalog: vi.fn(async () => ({ items: notes, liveEligibleCount: 2 })),
    maintenanceWork: vi.fn(async (_scope: unknown, input: { action: string }) => input.action === 'identity' ? { generation: 'fixture-native-v1' } : input.action === 'seed' ? { imported: true } : input.action === 'associate' ? { items: [] } : { mode: 'incremental-v1', ready: 0, retrying: 0, processing: 0 }),
    operationReceipt: vi.fn<(scope: unknown, kind: string, input: { operationId: string }) => Promise<Record<string, unknown>>>(async () => ({ found: false })),
    organize: vi.fn<(scope: unknown, input: { operationId: string }) => Promise<Record<string, unknown>>>(async () => ({ state: 'indexed' })) };
  const options = { store, root, brain: { run, archive: vi.fn(async () => undefined) }, memory,
    model: () => ({ apiFormat: 'openai_chat', model: 'GLOBAL-MODEL', baseUrl: 'http://127.0.0.1:9', apiKey: 'PRIVATE_API_KEY_NEVER_PERSIST', contextWindow: 1048576, maxTokens: 4096, maxOutputTokens: 32768 }),
    callback: async () => ({ url: 'http://127.0.0.1:9/bot/tool', token: 'a'.repeat(64) }), changed: vi.fn(), report: vi.fn() } as unknown as BotMaintenanceRuntimeOptions;
  const runtime = new BotMaintenanceRuntime(options), job = runtime.journal.enqueue(scope, 'organize', 'review-fixture');
  const body: Omit<BotMemoryMaintenancePlan, 'id'> = { format: 'worldlinebox-memory-maintenance-v1', operationId: job.id, scope, kind: 'organize', contextEpoch: 1, sourceRevision: '0', createdAt: at,
    scan: { examined: 2, selected: 2, deferred: [] }, sources: notes.map(note => ({ ...note, checksum: note.checksum })), retrieval: { engine: 'LightMemo', result: {} }, narrative: '保留计划更正和未完成状态。',
    candidates: types.map((type, index) => ({ id: 'candidate-' + index, type, sourceIds: type === 'organize' ? [a, b] : [index ? b : a], content: type === 'archive' ? '' : '用户原计划周六去湖边，后改为博物馆，尚未订票。', tags: [], reason: '保存更正脉络。', uncertainties: [], quotes: [{ sourceId: index ? b : a, text: index ? notes[1]!.content : notes[0]!.content }] })) };
  runtime.journal.savePlan(scope, job.id, { ...body, id: maintenanceDigest(body) });
  const apply = vi.spyOn(BotMemoryMaintenance.prototype, 'applyCandidate').mockResolvedValue({ actionId: 'applied', operationId: 'applied-operation', status: 'indexed' });
  const step = async () => { const claim = store.claimMemoryJob({ workerId: 'auto-review-test' }); if (!claim) return; const result = await runtime.run(claim, new AbortController().signal); store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result }); return result; };
  await step(); // Settle the generation queue item whose frozen plan was seeded above.
  cleanups.push(async () => { await runtime.close(); store.close(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-auto-review-')) throw Error('Invalid owned review fixture'); rmSync(root, { recursive: true, force: true }); });
  return { runtime, run, memory, notes, scope, job, apply, step, get store() { return store; }, candidate: (index = 0) => runtime.journal.candidate(scope, job.id, 'candidate-' + index),
    toggle: (autoReview: boolean) => runtime.handle({ type: 'memory.maintenance.settings.update', conversationId: scope.conversationId, companionId: scope.companionId, settings: { autoReview } }, scope),
    async reopen() { await runtime.close(); store.close(); store = new BotStore(filename); return new BotMaintenanceStore(store); } };
}

it('defaults to manual review, uses the global model when enabled, applies only after approval and persists the complete audit', async () => {
  const f = await fixture(); expect(f.runtime.journal.queueAutomaticReview()).toBeUndefined(); expect(f.run).not.toHaveBeenCalled();
  await f.toggle(true); await f.step(); expect(f.candidate().status).toBe('approved'); expect(f.apply).not.toHaveBeenCalled();
  expect(f.run.mock.calls[0]![0]).toMatchObject({ role: 'brain', tools: [], model: { model: 'GLOBAL-MODEL', maxTokens: 32768 } });
  await f.step(); expect(f.candidate().status).toBe('applied');
  expect(f.store.taskTransaction(sql => sql.prepare('SELECT dirty FROM bot_maintenance_settings').get())).toMatchObject({ dirty: 0 });
  const audit = f.runtime.journal.reviews(f.scope, f.job.id).items[0]!;
  expect(audit).toMatchObject({ actor: 'model', decision: 'approve', model: 'GLOBAL-MODEL', promptVersion: MEMORY_REVIEW_PROMPT_VERSION }); expect(audit.checks).toHaveLength(8); expect(audit.evidence).toHaveLength(2);
  expect(JSON.stringify(audit)).not.toContain('PRIVATE_API_KEY_NEVER_PERSIST');
  const reopened = await f.reopen(); expect(reopened.reviews(f.scope, f.job.id).items[0]).toEqual(audit);
});

it.each([true, false])('reconciles a manually approved duplicate only with a verified indexed replacement (valid checksum: %s)', async valid => {
  const f = await fixture(); f.apply.mockRestore();
  const current = f.runtime.journal.get(f.scope, f.job.id).plan!, { id: _id, ...original } = current; void _id;
  const priorJob = f.runtime.journal.enqueue(f.scope, 'organize', 'prior-organized');
  const body = { ...original, operationId: priorJob.id, candidates: [{ ...original.candidates[0]!, id: 'prior-candidate', content: '已完整保存的原件合并结果。' }] }, prior = { ...body, id: maintenanceDigest(body) };
  f.runtime.journal.savePlan(f.scope, priorJob.id, prior); f.runtime.journal.candidateResult(f.scope, priorJob.id, 'prior-candidate', 'applied', { status: 'indexed' });
  const outputId = 'd'.repeat(64), checksum = 'd'.repeat(32), operationId = 'maintenance-' + maintenanceDigest([prior.id, 'prior-candidate', 'review']);
  f.memory.operationReceipt.mockImplementation(async (_scope, _kind, input) => input.operationId === operationId ? { found: true, receipt: { operationId, state: 'indexed', id: outputId, checksum } } : { found: false });
  f.notes.forEach(note => { note.indexState = 'archived'; }); f.notes.push({ ...f.notes[0]!, id: outputId, indexState: 'indexed', checksum: valid ? checksum : 'e'.repeat(32) });
  f.memory.organize.mockRejectedValueOnce(Object.assign(new Error('Only an active confirmed note can be updated or organized.'), { code: 'MEMORY_NOTE_UNAVAILABLE' }));
  f.runtime.journal.review(f.scope, f.job.id, f.candidate().id, f.candidate().revision, 'approve', 'human-approval'); await f.step();
  expect(f.candidate().status).toBe(valid ? 'superseded' : 'conflict');
  f.runtime.journal.candidateResult(f.scope, f.job.id, f.candidate().id, 'unknown', { error: { code: 'MEMORY_NOTE_UNAVAILABLE' } }); f.memory.organize.mockClear();
  await f.runtime.handle({ type: 'memory.maintenance.resume', conversationId: f.scope.conversationId, companionId: f.scope.companionId, jobId: f.job.id, candidateId: f.candidate().id, revision: f.candidate().revision, requestId: 'resume-original-approval' }, f.scope);
  await f.step(); expect(f.candidate().status).toBe(valid ? 'superseded' : 'conflict'); expect(f.candidate().approval?.actor).toBe('user'); expect(f.memory.organize).not.toHaveBeenCalled();
  if (valid) {
    expect(f.candidate().receipt?.resolution).toMatchObject({ noteId: outputId, checksum }); expect(f.runtime.journal.get(f.scope, f.job.id).job.metrics).toMatchObject({ applied: 0, superseded: 1 });
    expect(f.runtime.journal.review(f.scope, f.job.id, f.candidate().id, f.candidate().revision, 'approve', 'human-approval').status).toBe('superseded');
  }
});

it('checks an unknown operation and continues its original approved write with the same operation ID', async () => {
  const f = await fixture(); f.apply.mockRestore(); f.memory.organize.mockRejectedValueOnce(Object.assign(new Error('Lost acknowledgement'), { code: 'SESSION_CLOSED' }));
  f.runtime.journal.review(f.scope, f.job.id, f.candidate().id, f.candidate().revision, 'approve', 'human-approval'); await f.step();
  expect(f.candidate().status).toBe('unknown'); const originalId = f.memory.organize.mock.calls[0]![1].operationId;
  await f.runtime.handle({ type: 'memory.maintenance.resume', conversationId: f.scope.conversationId, companionId: f.scope.companionId, jobId: f.job.id, candidateId: f.candidate().id, revision: f.candidate().revision, requestId: 'check-and-continue' }, f.scope);
  await f.step(); expect(f.memory.organize).toHaveBeenCalledOnce(); await f.step();
  expect(f.candidate().status).toBe('applied'); expect(f.memory.organize.mock.calls[1]![1].operationId).toBe(originalId);
});

it.each(['missing-check', 'fake-quote', 'archive-without-coverage'] as const)('routes %s to manual review without mutation', async problem => {
  const f = await fixture(problem === 'archive-without-coverage' ? ['archive'] : ['organize']);
  f.run.mockImplementation(async input => { const output = verdict(input); if (problem === 'missing-check') output.checks.pop(); if (problem === 'fake-quote') output.evidence[0]!.quote = '用户已经订票。'; return { text: JSON.stringify(output), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }; });
  await f.toggle(true); await f.step(); expect(f.candidate().status).toBe('pending'); expect(f.apply).not.toHaveBeenCalled();
  expect(f.runtime.journal.reviews(f.scope, f.job.id).items[0]!.decision).toBe('manual'); expect(f.runtime.journal.queueAutomaticReview()).toBeUndefined();
});

it('does not trust a source that changes before or during review', async () => {
  const f = await fixture(); f.run.mockImplementation(async input => { f.notes[0]!.checksum = 'f'.repeat(32); return { text: JSON.stringify(verdict(input)), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }; });
  await f.toggle(true); await f.step(); expect(f.candidate().status).toBe('pending'); expect(f.apply).not.toHaveBeenCalled();
  expect(f.runtime.journal.reviews(f.scope, f.job.id).items[0]!.reason).toContain('来源发生变化');
});
it('checks that retained archive coverage is still valid at application time', async () => {
  const f = await fixture(['archive']);
  f.run.mockImplementation(async input => { const result = verdict(input); result.evidence.push({ sourceId: b, quote: f.notes[1]!.content }); return { text: JSON.stringify(result), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }; });
  await f.toggle(true); await f.step(); expect(f.candidate().status).toBe('approved');
  f.notes[1]!.checksum = 'f'.repeat(32); await f.step();
  expect(f.candidate().status).toBe('conflict'); expect(f.apply).not.toHaveBeenCalled(); expect(f.candidate().receipt?.error).toContain('覆盖证据已变化');
});
it('disabling review also holds queued model approvals, and re-enabling reviews them in a new cycle', async () => {
  const f = await fixture(); await f.toggle(true); await f.step(); expect(f.candidate().status).toBe('approved');
  await f.toggle(false); await f.step(); expect(f.candidate().status).toBe('pending'); expect(f.apply).not.toHaveBeenCalled();
  await f.toggle(true); await f.step(); await f.step(); expect(f.candidate().status).toBe('applied'); expect(f.run).toHaveBeenCalledTimes(2); expect(f.apply).toHaveBeenCalledOnce();
});

it('retrying a model-approved archive preserves the review provenance and rechecks its coverage', async () => {
  const f = await fixture(['archive']);
  f.run.mockImplementation(async input => { const result = verdict(input); result.evidence.push({ sourceId: b, quote: f.notes[1]!.content }); return { text: JSON.stringify(result), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }; });
  await f.toggle(true); await f.step();
  f.notes[1]!.checksum = 'f'.repeat(32); await f.step(); expect(f.candidate().status).toBe('conflict');
  f.runtime.journal.control(f.scope, f.job.id, 'retry', 'retry-coverage'); await f.step();
  expect(f.candidate().status).toBe('conflict'); expect(f.apply).not.toHaveBeenCalled();
});

it('a temporary review failure retains a retry and continues to the next candidate', async () => {
  const f = await fixture(['update', 'update']); let calls = 0;
  f.run.mockImplementation(async input => { if (++calls === 1) throw Error('provider HTTP 503'); return { text: JSON.stringify(verdict(input)), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }; });
  await f.toggle(true); await f.step(); await f.step(); await f.step();
  expect(f.candidate(0).status).toBe('pending'); expect(f.candidate(1).status).toBe('applied'); expect(f.apply).toHaveBeenCalledOnce();
  expect(f.runtime.journal.reviews(f.scope, f.job.id).items.map(item => item.decision)).toEqual(['approve', 'retry']);
  const pending = f.store.listPendingMemory().find(item => item.payload.candidateId === f.candidate(0).id)!;
  expect(pending.status).toBe('queued');
  const claim = f.store.claimMemoryJob({ workerId: 'after-backoff', now: Date.now() + 300001 })!;
  const result = await f.runtime.run(claim, new AbortController().signal); f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result });
  await f.step(); expect(f.candidate(0).status).toBe('applied'); expect(f.apply).toHaveBeenCalledTimes(2);
});

it('reports queued and running reviews, and publishes a manual verdict with a new UI revision', async () => {
  const f = await fixture(); await f.toggle(true);
  expect(f.runtime.journal.get(f.scope, f.job.id).job.autoReview).toMatchObject({ state: 'queued', total: 1, reviewed: 0 });
  let release!: () => void, started!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
  f.run.mockImplementationOnce(async input => { started(); await held; const output = verdict(input); output.checks.pop(); return { text: JSON.stringify(output), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }; });
  const task = f.step(); await began;
  expect(f.runtime.journal.get(f.scope, f.job.id).job.autoReview).toMatchObject({ state: 'running', currentPosition: 1 });
  const before = f.candidate().updatedAt; await new Promise(resolve => setTimeout(resolve, 2)); release(); await task;
  expect(f.candidate().updatedAt).not.toBe(before); expect(f.candidate().autoReview?.state).toBe('manual');
  expect(f.runtime.journal.get(f.scope, f.job.id).job.autoReview).toMatchObject({ state: 'manual', reviewed: 1, manual: 1 });
});

it('services an existing review before an older queued plan in the same memory domain', async () => {
  const f = await fixture(); f.runtime.journal.enqueue(f.scope, 'organize', 'older-queued-generation', true);
  await f.toggle(true); const claim = f.store.claimMemoryJob({ workerId: 'review-priority' })!;
  expect(claim.job.payload.operation).toBe('review'); expect(claim.job.payload.jobId).toBe(f.job.id);
  const result = await f.runtime.run(claim, new AbortController().signal); f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result });
  await f.step(); expect(f.candidate().status).toBe('applied');
});

it('applies a recorded approval before starting another queued model review', async () => {
  const f = await fixture(['update', 'update']); await f.toggle(true); f.runtime.journal.queueAutomaticReview(f.scope);
  await f.step(); expect(f.candidate(0).status).toBe('approved');
  await f.step(); expect(f.candidate(0).status).toBe('applied'); expect(f.candidate(1).status).toBe('pending'); expect(f.run).toHaveBeenCalledOnce();
});

it('keeps the last genuine user-activity time when maintenance writes a new indexed note', async () => {
  const f = await fixture(), before = f.runtime.journal.settings(f.scope).lastActivityAt;
  await f.toggle(true); await f.step(); await new Promise(resolve => setTimeout(resolve, 3)); await f.step();
  expect(f.candidate().status).toBe('applied'); expect(f.runtime.journal.settings(f.scope).lastActivityAt).toBe(before);
});

it('uses a fresh native admission after a confirmed provider failure instead of replaying the failed receipt forever', async () => {
  const f = await fixture(); f.run.mockImplementationOnce(async input => { throw new BotDshTurnFailedError(input.eventId, 'HTTP 503 temporary provider outage'); });
  await f.toggle(true); await f.step();
  const claim = f.store.claimMemoryJob({ workerId: 'retry-provider', now: Date.now() + 300001 })!;
  const result = await f.runtime.run(claim, new AbortController().signal); f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result });
  expect(f.run.mock.calls[1]![0].eventId).not.toBe(f.run.mock.calls[0]![0].eventId);
  await f.step(); expect(f.candidate().status).toBe('applied');
  expect(f.runtime.journal.reviews(f.scope, f.job.id).items.map(item => item.decision)).toEqual(['approve', 'retry']);
});

it('retries a temporarily busy real-memory workspace instead of permanently handing every candidate to manual review', async () => {
  const f = await fixture(); f.memory.readNote.mockRejectedValueOnce(Object.assign(new Error('Memory workspace is still owned by another runtime'), { code: 'MEMORY_WORKSPACE_BUSY' }));
  await f.toggle(true); await f.step(); expect(f.run).not.toHaveBeenCalled();
  expect(f.runtime.journal.reviews(f.scope, f.job.id).items[0]!.decision).toBe('retry');
  const claim = f.store.claimMemoryJob({ workerId: 'memory-recovered', now: Date.now() + 300001 })!;
  const result = await f.runtime.run(claim, new AbortController().signal); f.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result });
  await f.step(); expect(f.candidate().status).toBe('applied');
});

it('disabling automatic review stops an in-flight model decision and re-enabling creates a fresh review cycle', async () => {
  const f = await fixture(); let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  f.run.mockImplementationOnce(input => new Promise((_resolve, reject) => { started(); input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }); }));
  await f.toggle(true); const pending = f.step(); await began; await f.toggle(false); await pending;
  expect(f.candidate().status).toBe('pending'); expect(f.apply).not.toHaveBeenCalled();
  await f.toggle(true); await f.step(); expect(f.candidate().status).toBe('approved'); expect(f.run).toHaveBeenCalledTimes(2);
});

it('does not override a human decision made during the model review and retains both records', async () => {
  const f = await fixture(); let release!: () => void, started!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
  f.run.mockImplementationOnce(async input => { started(); await held; return { text: JSON.stringify(verdict(input)), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }; });
  await f.toggle(true); const pending = f.step(); await began;
  f.runtime.journal.review(f.scope, f.job.id, f.candidate().id, f.candidate().revision, 'reject', 'human-first'); release(); await pending;
  expect(f.candidate().status).toBe('rejected'); expect(f.apply).not.toHaveBeenCalled();
  expect(f.runtime.journal.reviews(f.scope, f.job.id).items.map(item => [item.actor, item.decision])).toEqual([['model', 'manual'], ['user', 'reject']]);
});

it('clears withdrawn review prose and quoted evidence while retaining decision and model provenance', async () => {
  const f = await fixture(); await f.toggle(true); await f.step(); f.runtime.journal.invalidate(f.scope);
  const stored = f.store.taskTransaction(sql => sql.prepare('SELECT record_json FROM bot_maintenance_reviews').all()) as Array<{ record_json: string }>;
  expect(stored).toHaveLength(1); expect(stored[0]!.record_json).toContain('GLOBAL-MODEL'); expect(stored[0]!.record_json).not.toContain('用户计划周六去湖边');
});
