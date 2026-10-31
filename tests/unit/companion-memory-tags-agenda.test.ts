import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryTagJob } from '../../src/shared/companion-memory-tags';
import { CompanionMemoryTagService } from '../../src/main/companions/memory-tags-service';

const model = vi.hoisted(() => ({ generate: vi.fn(), repair: vi.fn() }));
vi.mock('../../src/main/companions/model', () => ({
  CompanionModelError: class extends Error { constructor(readonly code: string, message: string, readonly diagnostic?: string) { super(message); } },
  companionModelAdmissionRetryAfter: () => undefined,
  generateCompanionText: model.generate,
  repairCompanionStructured: model.repair,
}));
const at = '2026-10-29T02:00:00.000Z', services: CompanionMemoryTagService[] = [], releases: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at); model.generate.mockReset().mockResolvedValue('[[Tag: 原始资料, 条件核验]]'); model.repair.mockReset().mockResolvedValue({ tags: ['原始资料'] }); });
afterEach(async () => { releases.splice(0).forEach(release => release()); for (const service of services.splice(0)) await service.close(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await Promise.resolve(); } expect(predicate()).toBe(true); }
const answer = (value: unknown = {}) => ({ ok: true, ...value as object }) as CompanionStorageResponse;
function fixture() {
  const jobs = new Map<string, CompanionMemoryTagJob>(['alice', 'bob'].map(owner => [owner, { id: 'tag_' + owner, companionId: owner,
    noteId: 'note_' + owner, content: '实际来源资料，保留适用条件。', version: 1, attempts: 1, failureCount: 0, cycleFailureCount: 0, leaseToken: 'token_' + owner }]));
  const states = new Map<string, string>([...jobs.keys()].map(owner => [owner, 'pending']));
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'memory.tags.claim') {
      const owner = command.companionId ?? [...states].find(([, state]) => state === 'pending')?.[0];
      if (!owner || states.get(owner) !== 'pending') return answer();
      states.set(owner, 'running'); return answer({ memoryTagJob: jobs.get(owner) });
    }
    if (command.type === 'memory.tags.validate' || command.type === 'memory.tags.heartbeat') {
      const job = [...jobs.values()].find(value => value.id === command.id);
      return answer({ memoryTagValid: !!job && states.get(job.companionId) === 'running', memoryTagJob: job });
    }
    if (command.type === 'memory.tags.complete') { const owner = [...jobs.values()].find(job => job.id === command.id)!.companionId; states.set(owner, 'completed'); return answer(); }
    if (command.type === 'memory.tags.defer') { const owner = [...jobs.values()].find(job => job.id === command.id)!.companionId; states.set(owner, command.reason === 'retry' ? 'failed' : command.reason === 'cancelled' || command.reason === 'stale' ? command.reason : 'pending'); return answer(); }
    if (command.type === 'memory.tags.status') {
      const state = states.get(command.companionId), job = jobs.get(command.companionId);
      return answer({ memoryTagStatus: { pending: +(state === 'pending'), running: +(state === 'running'), waitingModel: 0,
        failed: +(state === 'failed'), completed: +(state === 'completed'), cancelled: +(state === 'cancelled'),
        ...(command.noteId && job ? { note: { noteId: job.noteId, version: job.version, state } } : {}) } });
    }
    return answer();
  });
  const wake = vi.fn(), fetchFn = vi.fn<typeof fetch>(), changed = vi.fn(), report = vi.fn();
  const service = new CompanionMemoryTagService({ request, config: async () => ({ model: 'synthetic', apiFormat: 'openai_chat', apiKey: 'synthetic', baseUrl: 'https://not-called.invalid' }),
    prompt: async () => 'Original TagMaster fixture', fetchFn, changed, report });
  services.push(service); service.setAgendaDriven(wake); return { service, request, jobs, states, wake, fetchFn, report };
}

it('disables the independent tag model pump in agenda mode', async () => {
  const f = fixture(); f.service.start(); await f.service.tick(); await vi.advanceTimersByTimeAsync(120000);
  expect(f.request).not.toHaveBeenCalled(); expect(model.generate).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('claims one owned note and records its actual child ID before asking for tags', async () => {
  const f = fixture(), progress = vi.fn(async () => undefined);
  expect((await f.service.runAgendaQuantum('bob', new AbortController().signal, progress)).outcome).toBe('completed');
  expect(f.request.mock.calls.filter(([command]) => command.type === 'memory.tags.claim')).toHaveLength(1);
  expect(f.request).toHaveBeenCalledWith({ type: 'memory.tags.claim', companionId: 'bob', leaseMs: 120000 });
  expect(progress).toHaveBeenCalledWith({ kind: 'tags', id: 'tag_bob', stage: '核对正式正文后补充检索标签。' });
  expect(f.states.get('alice')).toBe('pending'); expect(f.states.get('bob')).toBe('completed');
});

it('allows two owners to progress independently without a whole-service model lock', async () => {
  const f = fixture(), held = deferred<string>(); releases.push(() => held.resolve('[[Tag: 来源]]'));
  model.generate.mockImplementationOnce(() => held.promise).mockResolvedValue('[[Tag: 来源]]');
  const alice = f.service.runAgendaQuantum('alice', new AbortController().signal);
  await until(() => model.generate.mock.calls.length === 1);
  expect((await f.service.runAgendaQuantum('alice', new AbortController().signal)).outcome).toBe('waiting');
  expect((await f.service.runAgendaQuantum('bob', new AbortController().signal)).outcome).toBe('completed');
  held.resolve('[[Tag: 来源]]'); expect((await alice).outcome).toBe('completed');
});

it('honors an explicit Tag line without using a model', async () => {
  const f = fixture(); f.jobs.get('alice')!.content += '\nTag: 手工来源, 条件';
  expect((await f.service.runAgendaQuantum('alice', new AbortController().signal)).outcome).toBe('completed');
  expect(model.generate).not.toHaveBeenCalled(); expect(model.repair).not.toHaveBeenCalled();
});

it('links failure as waiting instead of consuming native processing failures', async () => {
  const f = fixture();
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal, async () => { throw new Error('日程存储尚不可用'); });
  expect(result.outcome).toBe('waiting'); expect(model.generate).not.toHaveBeenCalled();
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.tags.defer' && command.reason === 'admission')).toBe(true);
});

it('keeps the parent continuation pending when more owned documents remain after this one', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => {
    const response = await original(command);
    if (command.type === 'memory.tags.status' && command.noteId && response.memoryTagStatus)
      response.memoryTagStatus.pending = 2;
    return response;
  });
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(result).toMatchObject({ outcome: 'waiting', notBefore: '2026-10-29T02:00:01.000Z' });
  expect(model.generate).toHaveBeenCalledTimes(1); // One bounded phase, next phase returns to the agenda.
});

it('does not apply a late tag result after source validity is lost', async () => {
  const f = fixture(), held = deferred<string>(); releases.push(() => held.resolve('[[Tag: 来源]]'));
  model.generate.mockReturnValue(held.promise);
  const run = f.service.runAgendaQuantum('alice', new AbortController().signal); await until(() => model.generate.mock.calls.length === 1);
  f.states.set('alice', 'stale'); held.resolve('[[Tag: 来源]]');
  expect((await run).outcome).toBe('silent');
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.tags.complete')).toBe(false);
});

it('renews a long tag stage using a matched lease and stops when renewal fails', async () => {
  const f = fixture(), held = deferred<string>(), original = f.request.getMockImplementation()!;
  releases.push(() => held.resolve('[[Tag: 来源]]')); model.generate.mockReturnValue(held.promise);
  const run = f.service.runAgendaQuantum('alice', new AbortController().signal); await until(() => model.generate.mock.calls.length === 1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.tags.heartbeat')).toBe(true);
  f.request.mockImplementation(async command => command.type === 'memory.tags.heartbeat' ? answer({ memoryTagValid: false }) : original(command));
  await vi.advanceTimersByTimeAsync(30000); held.resolve('[[Tag: 来源]]');
  expect((await run).outcome).toBe('silent'); // Lease loss invalidates the old tag attempt without a processing failure.
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.tags.complete')).toBe(false);
});
