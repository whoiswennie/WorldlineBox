import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionMemoryService, type CompanionMemoryAgendaProgress } from '../../src/main/companions/memory-service';
import type { Companion, CompanionConversation } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryRuntime } from '../../src/main/companions/vcp-runtime';

const at = '2026-10-29T02:00:00.000Z';
const services: CompanionMemoryService[] = [];
const releases: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at); });
afterEach(async () => { releases.splice(0).forEach(release => release()); for (const service of services.splice(0)) await service.close(); vi.useRealTimers(); });
const answer = (value: unknown) => ({ ok: true, ...value as object }) as CompanionStorageResponse;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await Promise.resolve(); } expect(predicate()).toBe(true); }
function fixture(withRuntime = false) {
  const companions: Companion[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '只依据实际来源表达。',
    model: '', avatar: 'custom', builtin: false, proactive: false, active: true, createdAt: at }));
  const conversations: CompanionConversation[] = companions.map(role => ({ id: 'room_' + role.id, title: role.name,
    kind: 'private', memberIds: [role.id], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: at }));
  const queue = new Set(['alice', 'bob']);
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'state') return answer({ state: { companions, conversations } });
    if (command.type === 'memory.jobs.claim' && command.companionId && queue.delete(command.companionId))
      return answer({ memoryJob: { id: 'capture_' + command.companionId, companionId: command.companionId,
        conversationId: 'room_' + command.companionId, sourceMessageIds: [], throughSequence: 1,
        leaseToken: 'token_' + command.companionId, attempts: 1, sourceChecksums: {}, sourceRevisions: {} } });
    if (command.type === 'memory.sources.filter') return answer({ memorySources: [] });
    if (command.type === 'memory.outbox.pending') return answer({ memoryOutboxPending: false });
    if (command.type === 'memory.status') return answer({ memoryStatus: { pending: 0, running: 0, failed: 0, completed: 0,
      memories: 0, forgotten: 0, indexed: 0, pendingIndex: 0, messageWatermark: 0, captureWatermark: 0 } });
    return answer({});
  });
  const wake = vi.fn(), fetchFn = vi.fn<typeof fetch>(), changed = vi.fn(), report = vi.fn(), flush = vi.fn(async () => undefined);
  const options: ConstructorParameters<typeof CompanionMemoryService>[0] = { request, changed, report, busy: () => false,
    configFor: async () => ({ model: 'synthetic-model', apiKey: 'synthetic-key', apiFormat: 'openai_chat', baseUrl: 'https://never-called.invalid' }),
    fetchFn, flushSourceFiles: flush, ...(withRuntime ? { runtime: { get: vi.fn(), close: vi.fn(async () => undefined) } as unknown as CompanionMemoryRuntime } : {}) };
  const service = new CompanionMemoryService(options); services.push(service); service.setAgendaDriven(wake);
  return { service, request, wake, fetchFn, changed, report, flush, queue, options };
}

it('keeps semantic capture behind agenda claims while integrity delivery timers remain live', async () => {
  const f = fixture(true);
  await vi.advanceTimersByTimeAsync(31000);
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.jobs.claim')).toBe(false);
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.outbox.claim')).toBe(true);
  expect(f.flush.mock.calls.length).toBeGreaterThanOrEqual(2); expect(f.fetchFn).not.toHaveBeenCalled();
  expect(f.wake).not.toHaveBeenCalled();
  f.service.changed('alice'); expect(f.wake.mock.calls).toEqual([['alice']]);
  f.service.schedule(0); await vi.advanceTimersByTimeAsync(1);
  expect(f.wake).toHaveBeenCalledTimes(1); // Read/integrity scheduling does not manufacture experiences.
});

it('processes only the claimed owner and links an actual native capture ID before processing', async () => {
  const f = fixture(), progress = vi.fn(async () => undefined);
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal, progress);
  expect(result).toMatchObject({ outcome: 'completed', stage: '本次经历整理已核对。' });
  expect(f.request.mock.calls.flatMap(([command]) => command.type === 'memory.jobs.claim' ? [command.companionId] : [])).toEqual(['alice']);
  expect(progress).toHaveBeenCalledWith({ kind: 'capture', id: 'capture_alice', stage: '核对本批真实来源与已存记录。' });
  expect(f.queue.has('bob')).toBe(true); expect(f.fetchFn).not.toHaveBeenCalled();
});

it('links every exact source-job ID returned by one actual claimed cohort', async () => {
  const f = fixture(), progress = vi.fn<(child: CompanionMemoryAgendaProgress) => Promise<void>>(async () => undefined), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => {
    const response = await original(command);
    if (command.type === 'memory.jobs.claim' && response.memoryJob) response.memoryJob.sourceJobIds = ['capture_alice', 'source_peer_2'];
    return response;
  });
  expect((await f.service.runAgendaQuantum('alice', new AbortController().signal, progress)).outcome).toBe('completed');
  expect(progress.mock.calls.map(([child]) => child.id)).toEqual(['capture_alice', 'source_peer_2']);
});

it('releases a parent as waiting when the native source policy has not admitted a batch', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!; f.queue.clear();
  f.request.mockImplementation(async command => command.type === 'memory.status'
    ? answer({ memoryStatus: { pending: 1, running: 0, failed: 0, completed: 0, memories: 0, forgotten: 0,
      indexed: 0, pendingIndex: 0, messageWatermark: 1, captureWatermark: 0 } }) : original(command));
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(result).toMatchObject({ outcome: 'waiting', notBefore: '2026-10-29T02:00:30.000Z' });
  expect(f.fetchFn).not.toHaveBeenCalled();
});

it('stops before a stale empty-source completion when the agenda is cancelled during a source read', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!, held = deferred<CompanionStorageResponse>();
  releases.push(() => held.resolve(answer({ memorySources: [] })));
  f.request.mockImplementation(async command => command.type === 'memory.sources.filter' ? held.promise : original(command));
  const controller = new AbortController(), run = f.service.runAgendaQuantum('alice', controller.signal);
  await until(() => f.request.mock.calls.some(([command]) => command.type === 'memory.sources.filter'));
  controller.abort(); held.resolve(answer({ memorySources: [] }));
  expect((await run).outcome).toBe('cancelled');
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.jobs.complete')).toBe(false);
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.jobs.fail' && command.failureKind === 'cancelled')).toBe(true);
});

it('does not start a second capture for one owner while another agenda occurrence can run independently', async () => {
  const f = fixture(true), original = f.request.getMockImplementation()!, held = deferred<CompanionStorageResponse>();
  releases.push(() => held.resolve(answer({ memorySources: [] })));
  f.request.mockImplementation(async command => command.type === 'memory.sources.filter' && command.companionId === 'alice' ? held.promise : original(command));
  const run = f.service.runAgendaQuantum('alice', new AbortController().signal);
  await until(() => f.request.mock.calls.some(([command]) => command.type === 'memory.sources.filter'));
  expect((await f.service.runAgendaQuantum('alice', new AbortController().signal)).outcome).toBe('waiting');
  expect((await f.service.runAgendaQuantum('bob', new AbortController().signal)).outcome).toBe('completed');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.flush.mock.calls.length).toBeGreaterThanOrEqual(3);
  held.resolve(answer({ memorySources: [] })); await run;
  expect(f.request.mock.calls.filter(([command]) => command.type === 'memory.jobs.claim' && command.companionId === 'alice')).toHaveLength(1);
});

it('treats a failed parent linkage checkpoint as waiting, preserving the native source rather than using a processing failure', async () => {
  const f = fixture();
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal, async () => { throw new Error('父日程磁盘尚不可写'); });
  expect(result.outcome).toBe('waiting'); expect(f.fetchFn).not.toHaveBeenCalled();
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.jobs.fail' && command.failureKind === 'waiting')).toBe(true);
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.sources.filter')).toBe(false);
});

it('waits without claiming a source when the configured model is unavailable', async () => {
  const f = fixture(); f.options.configFor = async () => { throw new Error('模型连接尚未配置'); };
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(result.outcome).toBe('waiting');
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.jobs.claim')).toBe(false);
});

it('does not advertise an integrity timer as the semantic capture execution time', async () => {
  const f = fixture();
  const schedule = await f.service.schedulingFor('alice');
  const capture = schedule.schedulers.find(item => item.kind === 'capture')!;
  expect(capture.scheduleKind).toBe('condition'); expect(capture.nextCheckAt).toBeUndefined();
  expect(capture.condition).toContain('统一日程');
});
