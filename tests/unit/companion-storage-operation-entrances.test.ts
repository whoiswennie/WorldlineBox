import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAgendaService, type CompanionAgendaExecutionResult } from '../../src/main/companions/agenda-service';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { companionStorageSchedulingContext, currentCompanionStorageOperation, withCompanionStorageOperation, type CompanionStorageOperation } from '../../src/main/companions/storage-operation-context';
import type { CompanionModelConfig } from '../../src/main/companions/model';
import { companionWorldJobSchema, type CompanionWorldJob } from '../../src/shared/companion-world';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';
import type { CompanionAgendaClaim, CompanionAgendaCommand, CompanionAgendaResponse } from '../../src/shared/companion-agenda';
import { createCompanionExecutionValidationSession, memoCompanionExecutionWitnesses } from '../../src/main/companions/source-execution-evidence';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: {}, ipcMain: {}, protocol: {}, shell: {}, safeStorage: {} }));

const scopes = () => {
  const value = currentCompanionStorageOperation();
  expect(value).toBeDefined();
  return value!;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  for (let index = 0; index < 100; index++) { if (condition()) return; await Promise.resolve(); }
  expect(condition()).toBe(true);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
  [{ type: 'state' }, 'interactive'],
  [{ type: 'reply.cancel', conversationId: 'room', workId: 'work' }, 'control'],
  [{ type: 'action.cancel', id: 'action' }, 'control'],
] as const)('starts a fresh authenticated renderer operation for %j', async (request, priority) => {
  const webContents = { mainFrame: {} }, window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
  const seen: CompanionStorageOperation[] = [];
  const handle = vi.fn(async (_request: CompanionsRequest): Promise<CompanionsResponse> => {
    expect(_request).toEqual(request);
    seen.push(scopes()); await Promise.resolve(); seen.push(scopes()); return { ok: true };
  });
  const host = Object.assign(Object.create(CompanionService.prototype), { options: { window: () => window }, handle }) as CompanionService;
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  await withCompanionStorageOperation({ priority: 'background', lane: 'calling-background' }, async () => {
    expect((await host.handleRendererRequest(event, request)).ok).toBe(true);
    expect(scopes()).toEqual({ priority: 'background', lane: 'calling-background' });
  });
  expect(seen).toHaveLength(2); expect(seen[0]).toEqual(seen[1]);
  expect(seen[0]!.priority).toBe(priority); expect(seen[0]!.lane).not.toBe('calling-background');
  expect(handle).toHaveBeenCalledExactlyOnceWith(request);
  expect((await host.handleRendererRequest({ ...event, senderFrame: {} } as IpcMainInvokeEvent, request)).ok).toBe(false);
  expect(handle).toHaveBeenCalledOnce(); expect(currentCompanionStorageOperation()).toBeUndefined();
});

it('keeps attachment reads interactive without changing their unavailable result', async () => {
  const seen: CompanionStorageOperation[] = [];
  const host = Object.assign(Object.create(CompanionService.prototype), {
    call: async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
      expect(command).toEqual({ type: 'attachment.get', id: 'attachment_one' }); seen.push(scopes()); return { ok: true };
    },
  }) as CompanionService;
  const response = await withCompanionStorageOperation({ priority: 'background', lane: 'poll' },
    () => host.attachmentResponse(new Request('worldlinebox-companion://attachment/attachment_one')));
  expect(response.status).toBe(404); expect(seen[0]!.priority).toBe('interactive'); expect(seen[0]!.lane).not.toBe('poll');
});

it.each([false, true])('classifies claimed chat and its respond phase without promoting proactive=%s', async proactive => {
  const seen: CompanionStorageOperation[] = [];
  const host = Object.assign(Object.create(CompanionService.prototype), {
    executeClaimedAgendaChatInOperation: async () => { seen.push(scopes()); await Promise.resolve(); seen.push(scopes()); },
    respondInOperation: async () => { seen.push(scopes()); await Promise.resolve(); seen.push(scopes()); },
  }) as unknown as {
    executeClaimedAgendaChat(work: { proactive: boolean }, signal: AbortSignal): Promise<void>;
    respond(room: string, controller: AbortController, proactive: boolean, delivery: 'auto'): Promise<void>;
  };
  await withCompanionStorageOperation({ priority: proactive ? 'interactive' : 'background', lane: 'parent' }, async () => {
    await host.executeClaimedAgendaChat({ proactive }, new AbortController().signal);
    await host.respond('room', new AbortController(), proactive, 'auto');
  });
  expect(seen).toHaveLength(4);
  expect(seen.every(value => value.priority === (proactive ? 'background' : 'interactive') && value.lane !== 'parent')).toBe(true);
  expect(seen[0]).toEqual(seen[1]); expect(seen[2]).toEqual(seen[3]);
});

it('keeps the received chat lane for respond and uses the same lane for terminal control writes', async () => {
  const seen: CompanionStorageOperation[] = [];
  const host = Object.assign(Object.create(CompanionService.prototype), {
    respondInOperation: async () => { seen.push(scopes()); }, storage: { request: async (): Promise<CompanionStorageResponse> => { seen.push(scopes()); return { ok: true }; } },
    resettingCompanions: new Set<string>(), sourceValidationRevision: 0, options: {},
  }) as unknown as {
    respond(room: string, controller: AbortController, proactive: boolean, delivery: 'auto'): Promise<void>;
    call(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  };
  await withCompanionStorageOperation({ priority: 'interactive', lane: 'received-chat' }, async () => {
    await host.respond('room', new AbortController(), false, 'auto');
    await host.call({ type: 'work.status', id: 'work', status: 'cancelled' });
    expect(scopes()).toEqual({ priority: 'interactive', lane: 'received-chat' });
  });
  expect(seen).toEqual([{ priority: 'interactive', lane: 'received-chat' }, { priority: 'control', lane: 'received-chat' }]);
});

it('creates storage event promises inside a new background lane, before their first instruction', async () => {
  const seen: CompanionStorageOperation[] = [];
  const host = Object.assign(Object.create(CompanionService.prototype), { storageEventJobs: new Map(), options: { report: vi.fn() } }) as unknown as {
    trackStorageEvent(owner: string, operation: () => Promise<unknown>): void;
    drainStorageEvents(owner?: string): Promise<void>;
  };
  await withCompanionStorageOperation({ priority: 'interactive', lane: 'foreground' }, async () => {
    host.trackStorageEvent('alice', async () => { seen.push(scopes()); await Promise.resolve(); seen.push(scopes()); });
    expect(scopes().priority).toBe('interactive'); await host.drainStorageEvents();
  });
  expect(seen).toHaveLength(2); expect(seen[0]).toEqual(seen[1]);
  expect(seen[0]!.priority).toBe('background'); expect(seen[0]!.lane).not.toBe('foreground');
});

it('keeps an independent storage event out of its foreground final fence and alive after that parent is closed and cancelled', async () => {
  const checked = vi.fn(async () => undefined), held = deferred<void>(), started = deferred<void>(), report = vi.fn();
  const parent = new AbortController(), foreground = createCompanionExecutionValidationSession(parent.signal);
  const host = Object.assign(Object.create(CompanionService.prototype), { storageEventJobs: new Map(), options: { report } }) as unknown as {
    trackStorageEvent(owner: string, operation: () => Promise<unknown>): void; drainStorageEvents(owner?: string): Promise<void>;
  };
  const currentRead = () => memoCompanionExecutionWitnesses(['actual_event_input'], { identity: {}, scope: 'event_read', revision: () => 0,
    read: async keys => new Map(keys.map(key => [key, 'current authority'])), verify: checked });
  try {
    await foreground.run(() => withCompanionStorageOperation({ priority: 'interactive', lane: 'foreground' }, async () => {
      host.trackStorageEvent('alice', async () => { await currentRead(); started.resolve(); await held.promise; await currentRead(); });
      await started.promise;
    }));
    expect(checked).toHaveBeenCalledOnce(); await foreground.validate(); expect(checked).toHaveBeenCalledOnce();
    foreground.close(); parent.abort(); held.resolve(); await host.drainStorageEvents();
    expect(checked).toHaveBeenCalledTimes(2); expect(report).not.toHaveBeenCalled();
  } finally { foreground.close(); held.resolve(); await host.drainStorageEvents(); }
});

it('starts the file publication and pending-owner poll in independent background lanes', async () => {
  const seen: CompanionStorageOperation[] = [], pumps = new Map<string, Promise<void>>();
  const host = Object.assign(Object.create(CompanionService.prototype), {
    closed: false, resettingCompanions: new Set<string>(), filePublicationPumps: pumps,
    assetIo: { run: <T>(operation: () => Promise<T>) => operation() }, options: { report: vi.fn() },
    sourceFiles: { flush: async () => { seen.push(scopes()); await Promise.resolve(); return { pending: false }; } },
    historyFiles: { flush: async () => { seen.push(scopes()); return { pending: false, completed: false }; } },
    storage: { request: async (): Promise<CompanionStorageResponse> => { seen.push(scopes()); return { ok: true }; } },
  }) as unknown as { wakeMemoryFiles(owner: string): void; pumpPendingMemoryFiles(): Promise<void> };
  await withCompanionStorageOperation({ priority: 'interactive', lane: 'foreground' }, async () => {
    host.wakeMemoryFiles('alice'); await Promise.all([...pumps.values()]); await host.pumpPendingMemoryFiles();
  });
  expect(seen).toHaveLength(4);
  expect(seen.every(value => value.priority === 'background' && value.lane !== 'foreground')).toBe(true);
  expect(seen[0]!.lane).toBe(seen[1]!.lane); expect(seen[2]!.lane).toBe(seen[3]!.lane); expect(seen[0]!.lane).not.toBe(seen[2]!.lane);
});

it('does not let a user configuration change promote its deferred memory retry', async () => {
  const seen: CompanionStorageOperation[] = [];
  const host = Object.assign(Object.create(CompanionService.prototype), {
    closed: false, initialization: Promise.resolve(), options: { report: vi.fn() },
    call: async () => { seen.push(scopes()); },
    memory: { generationConfigurationChanged: async () => { seen.push(scopes()); }, schedule: () => { seen.push(scopes()); } },
    changed: vi.fn(), agenda: { wake: vi.fn() },
  }) as CompanionService;
  withCompanionStorageOperation({ priority: 'interactive', lane: 'settings' }, () => host.configurationChanged());
  await until(() => seen.length === 3);
  expect(seen.every(value => value.priority === 'background' && value.lane !== 'settings')).toBe(true);
});

it('marks only physical world polling and its leased dream heartbeat, while peer receipt gets a clean interactive lane', async () => {
  const seen: Array<{ type: string; scope: CompanionStorageOperation; poll: boolean }> = [];
  const observe = (type: string) => seen.push({ type, scope: scopes(), poll: companionStorageSchedulingContext().backgroundPoll === true });
  const world = new CompanionWorldService({
    request: async command => { observe(command.type); return { ok: true }; },
    configFor: vi.fn(), fetchFn: vi.fn(), changed: vi.fn(), wakeWaiting: vi.fn(), report: vi.fn(),
  });
  world.setAgendaDriven();
  const internals = world as unknown as {
    jobs: Map<string, { controller: AbortController; worldJob: { kind: string; id: string; leaseToken: string } }>;
    processSocial(job: unknown, signal: AbortSignal): Promise<void>;
    processSocialInOperation(job: unknown, signal: AbortSignal): Promise<void>;
    runAgendaQuantumInOperation(): Promise<{ outcome: 'no_change'; companionId: string; reason: string }>;
  };
  internals.jobs.set('dream', { controller: new AbortController(), worldJob: { kind: 'dream', id: 'dream', leaseToken: 'token' } });
  internals.processSocialInOperation = async () => { observe('peer-body'); };
  internals.runAgendaQuantumInOperation = async () => { observe('world-quantum'); return { outcome: 'no_change', companionId: 'alice', reason: 'none' }; };
  try {
    await withCompanionStorageOperation({ priority: 'interactive', lane: 'ui' }, () => world.tick());
    await withCompanionStorageOperation({ priority: 'interactive', lane: 'ui' }, () => world.runAgendaQuantum({ companionId: 'alice', agendaRunId: 'run', agendaLeaseToken: 'lease' }, new AbortController().signal));
    await withCompanionStorageOperation({ priority: 'background', lane: 'world-pump' }, () => internals.processSocial({}, new AbortController().signal));
    expect(seen.map(value => [value.type, value.scope.priority])).toEqual([
      ['world.tick', 'background'], ['world.job.poll', 'background'], ['world-quantum', 'background'], ['peer-body', 'interactive'],
    ]);
    expect(seen.map(value => value.poll)).toEqual([true, true, false, false]);
    expect(seen.every(value => !['ui', 'world-pump'].includes(value.scope.lane))).toBe(true);
  } finally { internals.jobs.clear(); await world.close(); }
});

it('never marks same-named paid world source checks as background polling or carries a poll marker into their lifecycle', async () => {
  const job = companionWorldJobSchema.parse({ id: 'job', companionId: 'alice', conversationId: 'room', kind: 'dream', status: 'running',
    leaseToken: 'token', throughEventSequence: 1, attempts: 1, createdAt: new Date().toISOString() });
  const seen: Array<ReturnType<typeof companionStorageSchedulingContext>> = [];
  const world = new CompanionWorldService({
    request: async command => { expect(command).toEqual({ type: 'world.job.check', id: job.id, leaseToken: job.leaseToken }); seen.push(companionStorageSchedulingContext()); return { ok: true, worldJob: job }; },
    configFor: vi.fn(), fetchFn: vi.fn(), changed: vi.fn(), wakeWaiting: vi.fn(), report: vi.fn(),
  });
  const internals = world as unknown as { sourceFencedConfig(config: CompanionModelConfig, job: CompanionWorldJob, token: string, signal: AbortSignal): CompanionModelConfig };
  try {
    const config = internals.sourceFencedConfig({ apiFormat: 'openai_chat', model: 'actual-model', apiKey: '' }, job, 'token', new AbortController().signal);
    await withCompanionStorageOperation({ priority: 'background', lane: 'paid-world' }, () => config.providerLifecycle!.beforeDispatch());
    expect(seen).toHaveLength(4);
    expect(seen.every(value => value.priority === 'background' && value.lane === 'paid-world' && value.backgroundPoll !== true)).toBe(true);
  } finally { await world.close(); }
});

it.each([false, true])('only publishes progress when a leased world quantum releases its job, including failed=%s', async failed => {
  const job = companionWorldJobSchema.parse({ id: 'job', companionId: 'alice', conversationId: 'room', kind: 'decision', status: 'running',
    leaseToken: 'token', throughEventSequence: 1, attempts: 1, createdAt: new Date().toISOString(), disposition: { ownerId: 'alice', kind: 'world', id: 'job',
      inputVersion: 'a'.repeat(64), revision: 1, state: 'running', failureCount: 0, cycleFailureCount: 0 } });
  const changed = vi.fn(), configFor = vi.fn(), fetchFn = vi.fn();
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'world.job.claim') return { ok: true, worldJob: job };
    if (command.type === 'world.job.read') return { ok: true, worldJob: { ...job, status: 'done' } };
    throw new Error(`Unexpected request: ${command.type}`);
  });
  const world = new CompanionWorldService({ request, configFor, fetchFn, changed, wakeWaiting: vi.fn(), report: vi.fn() });
  const internals = world as unknown as { process(job: CompanionWorldJob, signal: AbortSignal): Promise<void>; jobs: Map<string, unknown>; agendaOwners: Set<string> };
  internals.process = vi.fn(async actual => { expect(actual).toBe(job); if (failed) throw new Error('actual processor failed'); });
  world.setAgendaDriven();
  try {
    const pending = world.runAgendaQuantum({ companionId: 'alice', agendaRunId: 'run', agendaLeaseToken: 'lease', lane: 'decision' }, new AbortController().signal);
    if (failed) await expect(pending).rejects.toThrow('actual processor failed');
    else expect((await pending).outcome).toBe('complete');
    expect(changed).toHaveBeenCalledExactlyOnceWith('progress');
    expect(internals.jobs.size).toBe(0); expect(internals.agendaOwners.size).toBe(0);
    expect(configFor).not.toHaveBeenCalled(); expect(fetchFn).not.toHaveBeenCalled();
  } finally { await world.close(); }
});

it('resets a scheduled memory callback before its first read even when scheduled from a foreground task', async () => {
  vi.useFakeTimers(); const seen: CompanionStorageOperation[] = [];
  const host = Object.assign(Object.create(CompanionMemoryService.prototype), {
    closed: false, running: undefined, agendaWake: vi.fn(), options: { changed: vi.fn(), report: vi.fn() },
    processIntegrity: async () => { seen.push(scopes()); await Promise.resolve(); seen.push(scopes()); },
  }) as CompanionMemoryService;
  withCompanionStorageOperation({ priority: 'interactive', lane: 'chat' }, () => host.schedule(0));
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toHaveLength(2); expect(seen[0]).toEqual(seen[1]);
  expect(seen[0]!.priority).toBe('background'); expect(seen[0]!.lane).not.toBe('chat');
  vi.clearAllTimers();
});

it('runs agenda pumps and children in separate background lanes, but heartbeats and settlement stay control in the child lane', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-01T00:00:00.000Z');
  const at = new Date().toISOString(), result = deferred<CompanionAgendaExecutionResult>();
  const claim: CompanionAgendaClaim = {
    rule: { id: 'rule', companionId: 'alice', revision: 1, category: 'task', origin: 'self', status: 'active', title: 'one event', intent: 'actual work',
      kind: 'research', executor: 'brain', trigger: { kind: 'at', at, timeZone: 'UTC', repeat: 'once' }, conditions: [], flexible: true, protected: false,
      overlapPolicy: 'parallel', resourceKeys: [], reason: 'actual reason', createdAt: at, updatedAt: at },
    occurrence: { id: 'occ', companionId: 'alice', ruleId: 'rule', ruleRevision: 1, scheduledAt: at, lastEvaluatedAt: at,
      state: 'ready', accumulatedHazard: 0, conditionResults: [], reason: 'actual opportunity' },
    run: { id: 'run', companionId: 'alice', ruleId: 'rule', occurrenceId: 'occ', revision: 1, status: 'queued', stage: 'queued', createdAt: at,
      updatedAt: at, notBefore: at, failureCount: 0, cycleFailureCount: 0, retryCycle: 0, attemptCount: 0 }, leaseToken: 'token',
  };
  const seen: Array<{ type: string; scope: CompanionStorageOperation }> = [], report = vi.fn(); let claimed = false;
  const request = async (command: CompanionAgendaCommand): Promise<CompanionAgendaResponse> => {
    seen.push({ type: command.type, scope: scopes() });
    if (command.type === 'agenda.claim' && !claimed) { claimed = true; claim.run = { ...claim.run, status: 'running', leaseToken: claim.leaseToken, leaseUntil: new Date(Date.now() + 30000).toISOString() }; return { ok: true, agendaClaim: claim }; }
    return { ok: true, ...(command.type === 'agenda.run.heartbeat' ? { agendaRun: claim.run } : {}) };
  };
  const agenda = new CompanionAgendaService({ request, owners: async () => ['alice'], report, changed: vi.fn(),
    execute: async () => { seen.push({ type: 'execute', scope: scopes() }); return result.promise; } });
  try {
    await withCompanionStorageOperation({ priority: 'interactive', lane: 'ui' }, () => agenda.tick());
    await until(() => seen.some(value => value.type === 'execute'));
    await vi.advanceTimersByTimeAsync(10000);
    result.resolve({ outcome: 'completed', result: 'actual result' });
    await until(() => seen.some(value => value.type === 'agenda.run.settle'));
    const pump = seen.find(value => value.type === 'agenda.tick')!.scope, child = seen.find(value => value.type === 'execute')!.scope;
    expect(pump.priority).toBe('background'); expect(child.priority).toBe('background'); expect(child.lane).not.toBe(pump.lane);
    expect(seen.every(value => value.scope.lane !== 'ui')).toBe(true);
    expect(seen.filter(value => ['agenda.run.heartbeat', 'agenda.run.settle'].includes(value.type)).map(value => value.scope))
      .toEqual([{ priority: 'control', lane: child.lane }, { priority: 'control', lane: child.lane }]);
    expect(report).not.toHaveBeenCalled();
  } finally { result.resolve({ outcome: 'completed' }); await agenda.close(); await agenda.drain(); }
});
