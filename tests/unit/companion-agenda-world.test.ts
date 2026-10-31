import { afterEach, expect, it, vi } from 'vitest';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionWorldJob } from '../../src/shared/companion-world';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionAgendaClaimSchema, companionAgendaRunSchema } from '../../src/shared/companion-agenda';
import { controlCompanionAgendaWorld, restoreCompanionAgendaWorld } from '../../src/main/companions/agenda-world-recovery';
import { executeAgendaWorld } from '../../src/main/companions/agenda-world';
import type { CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';
import { CompanionAutonomyService } from '../../src/main/companions/autonomy-service';

const services: CompanionWorldService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });
const at = '2026-10-29T10:00:00.000Z';
function fixture() {
  let current: CompanionWorldJob | undefined;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'world.job.claim') return { ok: true, worldJob: current };
    if (command.type === 'world.job.read') return { ok: true, worldJob: current };
    if (command.type === 'world.job.defer') { if (current) current = { ...current, status: 'pending', leaseToken: undefined }; return { ok: true }; }
    return { ok: true };
  });
  const tickLife = vi.fn(), config = vi.fn(), fetchFn = vi.fn(), changed = vi.fn();
  const service = new CompanionWorldService({ request, configFor: config, fetchFn, changed, tickLife, wakeWaiting: vi.fn(), report: vi.fn() }); services.push(service);
  service.setAgendaDriven();
  const process = vi.spyOn(service as unknown as { process(job: CompanionWorldJob, signal: AbortSignal): Promise<void> }, 'process').mockImplementation(async job => { current = { ...job, status: 'done' }; });
  const seed = (kind: 'decision' | 'dream' = 'decision') => current = { id: 'native_world', companionId: 'alice', conversationId: 'world_alice', kind,
    status: 'running', leaseToken: 'native_lease', throughEventSequence: 0, createdAt: at, attempts: 1, sourceMemoryIds: [],
    disposition: { ownerId: 'alice', kind: 'world', id: 'native_world', inputVersion: 'a'.repeat(64), revision: 1, state: 'running', failureCount: 0, cycleFailureCount: 0 } };
  return { service, request, process, seed, tickLife, config, fetchFn, get current() { return current; }, set current(value) { current = value; } };
}
const input = { companionId: 'alice', agendaRunId: 'parent_run', agendaLeaseToken: 'parent_lease' };

it('keeps physical clock ticking while the legacy life/social/world semantic pumps stay disabled', async () => {
  const f = fixture(); await f.service.tick();
  expect(f.request.mock.calls.map(([command]) => command.type)).toEqual(['world.tick']); expect(f.tickLife).not.toHaveBeenCalled();
  expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.config).not.toHaveBeenCalled();
});

it('disables direct legacy autonomy ticks as well as the world heartbeat caller', async () => {
  const request = vi.fn();
  const service = new CompanionAutonomyService({ request, configFor: vi.fn(), fetchFn: vi.fn(), ready: vi.fn(), end: vi.fn(), runGoal: vi.fn(), blocked: vi.fn(), changed: vi.fn(), report: vi.fn() });
  service.setAgendaDriven(); service.tick(); await Promise.resolve(); expect(request).not.toHaveBeenCalled(); await service.close();
});

it('does not claim another owner and records the actual native input before the original processor', async () => {
  const f = fixture(); f.seed(); const progress = vi.fn(async () => undefined);
  f.process.mockImplementation(async job => {
    expect(progress).toHaveBeenCalledWith('本次世界行为已取得准确事件租约', { kind: 'world', id: job.id, inputVersion: 'a'.repeat(64), revision: 1, lane: 'decision' });
    f.current = { ...job, status: 'done' };
  });
  const result = await f.service.runAgendaQuantum({ ...input, lane: 'decision' }, new AbortController().signal, progress);
  expect(result.outcome).toBe('complete'); expect(result.nativeJob?.id).toBe('native_world');
  expect(f.request).toHaveBeenCalledWith({ type: 'world.job.claim', kind: 'decision', companionId: 'alice', agendaRunId: 'parent_run', agendaLeaseToken: 'parent_lease' });
});

it('releases the exact child without model execution if the parent checkpoint fails before dispatch', async () => {
  const f = fixture(); f.seed();
  await expect(f.service.runAgendaQuantum({ ...input, lane: 'decision' }, new AbortController().signal, async (_stage, native) => { if (native) throw new Error('revoked parent'); })).rejects.toThrow('revoked parent');
  expect(f.process).not.toHaveBeenCalled(); expect(f.current?.status).toBe('pending');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'world.job.defer', id: 'native_world', leaseToken: 'native_lease' }));
});

it('reports a still-running or missing native result as unknown instead of assuming callback success', async () => {
  const f = fixture(); f.seed(); f.process.mockResolvedValue();
  expect((await f.service.runAgendaQuantum({ ...input, lane: 'decision' }, new AbortController().signal)).outcome).toBe('unknown');
  f.process.mockImplementation(async () => { f.current = undefined; });
  expect((await f.service.runAgendaQuantum({ ...input, lane: 'decision' }, new AbortController().signal)).outcome).toBe('unknown');
});

it('rotates ordinary source lanes fairly and admits dream work only through an explicit dream event', async () => {
  const f = fixture();
  expect((await f.service.runAgendaQuantum(input, new AbortController().signal)).outcome).toBe('no_change');
  expect(f.request.mock.calls.filter(([command]) => command.type.endsWith('.claim')).map(([command]) => command.type)).toEqual(['social.notification.claim', 'social.job.claim', 'world.job.claim']);
  expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.claim' && command.kind === 'dream')).toBe(false);
  f.seed('dream'); expect((await f.service.runAgendaQuantum({ ...input, lane: 'dream' }, new AbortController().signal)).outcome).toBe('complete');
  expect(f.process).toHaveBeenCalledTimes(1);
});

function recovery(kind: 'world' | 'social' | 'notification') {
  const native = { kind, id: 'actual_child', inputVersion: 'a'.repeat(64), revision: 2 };
  const run = companionAgendaRunSchema.parse({ id: 'run', companionId: 'alice', ruleId: 'rule', occurrenceId: 'occ', status: 'parked', revision: 3,
    stage: '原事件已保留', createdAt: at, updatedAt: at, notBefore: at, failureCount: 0, cycleFailureCount: 0, retryCycle: 0, attemptCount: 1, checkpoint: JSON.stringify({ nativeJob: native }) });
  let state = 'running', parent = run.id, version = native.inputVersion, uncertain = false;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    const actual = { id: native.id, companionId: 'alice', status: state, agendaParentRunId: parent, agendaUncertain: uncertain,
      agendaInputVersion: version, agendaRevision: 5, disposition: { inputVersion: version, revision: 5 } };
    if (command.type.endsWith('.read')) return { ok: true, ...(kind === 'world' ? { worldJob: actual } : kind === 'social' ? { socialJob: actual } : { socialNotification: actual }) } as unknown as CompanionStorageResponse;
    if (command.type === 'jobs.control' || command.type === 'social.job.control' || command.type === 'social.notification.control') { state = command.action === 'resume' ? 'pending' : command.action === 'park' ? 'parked' : 'abandoned'; return { ok: true }; }
    throw new Error('Unexpected native recovery command');
  });
  return { run, native, request, set state(value: string) { state = value; }, set parent(value: string) { parent = value; }, set version(value: string) { version = value; }, set uncertain(value: boolean) { uncertain = value; } };
}

it.each(['world', 'social', 'notification'] as const)('routes exact %s pause/resume/abandon to its real native CAS instead of making a second event', async kind => {
  const f = recovery(kind);
  expect((await controlCompanionAgendaWorld(f.run, 'park', { request: f.request })).canResume).toBe(true);
  expect((await restoreCompanionAgendaWorld(f.run, { request: f.request })).canResume).toBe(true);
  await controlCompanionAgendaWorld(f.run, 'abandon', { request: f.request });
  const commands = f.request.mock.calls.map(([command]) => command).filter(command => command.type.endsWith('.control'));
  expect(commands).toHaveLength(3);
  for (const command of commands) expect(command).toMatchObject({ id: f.native.id, inputVersion: f.native.inputVersion, expectedRevision: 5, operationId: expect.stringMatching(/^[a-f0-9-]{36}$/u) });
  expect(commands.map(command => command.type)).toEqual(Array(3).fill(kind === 'world' ? 'jobs.control' : `social.${kind === 'social' ? 'job' : 'notification'}.control`));
});

it('does not revive uncertain, replaced-parent or changed-input native work', async () => {
  const f = recovery('social'); f.state = 'parked'; f.uncertain = true;
  expect((await restoreCompanionAgendaWorld(f.run, { request: f.request })).canResume).toBe(false);
  f.uncertain = false; f.parent = 'different_run'; await expect(restoreCompanionAgendaWorld(f.run, { request: f.request })).rejects.toThrow('另一项日程');
  f.parent = f.run.id; f.version = 'b'.repeat(64); await expect(controlCompanionAgendaWorld(f.run, 'abandon', { request: f.request })).rejects.toThrow('原始输入已变化');
  expect(f.request.mock.calls.some(([command]) => command.type.endsWith('.control'))).toBe(false);
});

it('resumes the original native lane and input rather than claiming unrelated newly queued world work', async () => {
  const f = recovery('world'); f.run.checkpoint = JSON.stringify({ nativeJob: { ...f.native, lane: 'dream' } });
  const claim = companionAgendaClaimSchema.parse({ rule: { id: 'rule', companionId: 'alice', revision: 1, title: '世界机会', intent: '核验真实事件', kind: 'world', executor: 'world',
    reason: '实际事件', origin: 'system', status: 'active', createdAt: at, updatedAt: at, referenceId: 'system_world_v1', trigger: { kind: 'at', at, timeZone: 'UTC', repeat: 'once' } },
  occurrence: { id: 'occ', companionId: 'alice', ruleId: 'rule', ruleRevision: 1, scheduledAt: at, lastEvaluatedAt: at, state: 'running', reason: '真实机会' }, run: f.run, leaseToken: 'new_parent_lease' });
  const context: CompanionAgendaExecutionContext = { checkpoint: vi.fn(async () => undefined), effect: vi.fn(), effectId: vi.fn(), bindGrant: vi.fn() };
  const runAgendaQuantum = vi.fn<CompanionWorldService['runAgendaQuantum']>(async (_input, _signal, progress) => {
    await progress?.('准备恢复'); return { outcome: 'waiting', companionId: 'alice', reason: '等待原始阶段' };
  });
  await executeAgendaWorld(claim, context, new AbortController().signal, { world: { runAgendaQuantum } });
  expect(runAgendaQuantum).toHaveBeenCalledWith(expect.objectContaining({ lane: 'dream', referenceId: f.native.id, nativeInputVersion: f.native.inputVersion }), expect.any(AbortSignal), expect.any(Function));
  expect(context.checkpoint).toHaveBeenCalledWith('准备恢复', expect.objectContaining({ nativeJob: expect.objectContaining({ id: f.native.id, lane: 'dream' }) }));
});
