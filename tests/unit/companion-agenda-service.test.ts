import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CompanionAgendaDeferred, CompanionAgendaEffectNotApplied, CompanionAgendaOutcomeUnknown, CompanionAgendaService,
  companionAgendaCheckpoint, type CompanionAgendaExecutionResult,
} from '../../src/main/companions/agenda-service';
import type {
  CompanionAgendaClaim, CompanionAgendaCommand, CompanionAgendaResponse, CompanionAgendaStep,
} from '../../src/shared/companion-agenda';

const at = '2026-10-29T01:00:00.000Z';
const services: CompanionAgendaService[] = [];
const releases: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at); });
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  for (const service of services.splice(0)) { await service.close(); await service.drain(); }
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await Promise.resolve(); }
  expect(condition()).toBe(true);
}
function sample(owner: string, ordinal: number): CompanionAgendaClaim {
  const ruleId = `rule_${owner}_${ordinal}`, occurrenceId = `occ_${owner}_${ordinal}`, runId = `run_${owner}_${ordinal}`;
  return {
    rule: { id: ruleId, companionId: owner, revision: 1, category: 'task', origin: 'self', status: 'active', title: '本人的一件事', intent: '根据真实结果决定接下来做什么。',
      kind: 'research', executor: 'brain', trigger: { kind: 'at', at, timeZone: 'UTC', repeat: 'once' },
      conditions: [], flexible: true, protected: false, overlapPolicy: 'parallel', resourceKeys: [], reason: '真实兴趣与当前约定', createdAt: at, updatedAt: at },
    occurrence: { id: occurrenceId, companionId: owner, ruleId, ruleRevision: 1, scheduledAt: at,
      lastEvaluatedAt: at, state: 'ready', accumulatedHazard: 0, conditionResults: [], reason: '到达时点' },
    run: { id: runId, companionId: owner, ruleId, occurrenceId, revision: 1, status: 'queued', stage: '等待准入',
      createdAt: at, updatedAt: at, notBefore: at, failureCount: 0, cycleFailureCount: 0, retryCycle: 0, attemptCount: 0 },
    leaseToken: 'token_' + runId,
  };
}
function fixture(claims: CompanionAgendaClaim[] = [sample('alice', 1)], options: Partial<ConstructorParameters<typeof CompanionAgendaService>[0]> = {}) {
  const report = vi.fn(), changed = vi.fn(), steps = new Map<string, CompanionAgendaStep>();
  const request = vi.fn(async (command: CompanionAgendaCommand): Promise<CompanionAgendaResponse> => {
    if (command.type === 'agenda.claim') {
      const next = claims.find(claim => claim.run.companionId === command.companionId
        && ['queued', 'waiting'].includes(claim.run.status) && Date.parse(claim.run.notBefore) <= Date.parse(command.now));
      if (!next) return { ok: true };
      next.run = { ...next.run, status: 'running', leaseToken: next.leaseToken,
        leaseUntil: new Date(Date.parse(command.now) + command.leaseMs).toISOString(), attemptCount: next.run.attemptCount + 1 };
      return { ok: true, agendaClaim: structuredClone(next) };
    }
    if (command.type === 'agenda.run.heartbeat') {
      const next = claims.find(claim => claim.run.id === command.id);
      return { ok: true, ...(next ? { agendaRun: structuredClone(next.run) } : {}) };
    }
    if (command.type === 'agenda.run.checkpoint') {
      const next = claims.find(claim => claim.run.id === command.id)!;
      next.run.checkpoint = command.checkpoint; next.run.stage = command.stage;
      return { ok: true, agendaRun: structuredClone(next.run) };
    }
    if (command.type === 'agenda.run.settle') {
      const next = claims.find(claim => claim.run.id === command.id)!;
      next.run.status = command.outcome === 'failed' ? 'queued' : command.outcome;
      next.run.notBefore = command.notBefore ?? new Date(Date.now() + 1000).toISOString();
      next.run.result = command.result; next.run.error = command.error;
      delete next.run.leaseToken; delete next.run.leaseUntil;
      return { ok: true, agendaRun: structuredClone(next.run) };
    }
    if (command.type === 'agenda.step.read') return { ok: true, agendaStep: steps.get(command.effectKey) };
    if (command.type === 'agenda.step.record') {
      const step: CompanionAgendaStep = { id: command.effectKey, companionId: command.companionId, runId: command.runId,
        effectKey: command.effectKey, title: command.title, status: command.status, result: command.result, createdAt: at, updatedAt: at };
      steps.set(command.effectKey, step); return { ok: true, agendaStep: step };
    }
    return { ok: true };
  });
  const execute = vi.fn<ConstructorParameters<typeof CompanionAgendaService>[0]['execute']>(async () => ({ outcome: 'completed', result: '有实际结果' }));
  const service = new CompanionAgendaService({ request, owners: async () => [...new Set(claims.map(c => c.run.companionId))],
    execute, changed, report, ...options }); services.push(service);
  return { service, request, execute, report, changed, claims, steps };
}
const settles = (f: ReturnType<typeof fixture>) => f.request.mock.calls.flatMap(([command]) => command.type === 'agenda.run.settle' ? [command] : []);

it('claims one event per owner per round and coalesces simultaneous ticks without awaiting long adapters', async () => {
  const held = deferred<CompanionAgendaExecutionResult>(); releases.push(() => held.resolve({ outcome: 'completed' }));
  const f = fixture([sample('alice', 1), sample('alice', 2), sample('bob', 1)], { activeLimit: 2 });
  f.execute.mockReturnValue(held.promise);
  const first = f.service.tick(), second = f.service.tick(); expect(second).toBe(first);
  await first; await until(() => f.execute.mock.calls.length === 2);
  expect(f.execute.mock.calls.map(([claim]) => claim.run.companionId)).toEqual(['alice', 'bob']);
  expect(f.service.snapshot()).toEqual({ active: 2, owners: [{ companionId: 'alice', active: 1 }, { companionId: 'bob', active: 1 }] });
  const claimsBefore = f.request.mock.calls.filter(([command]) => command.type === 'agenda.claim').length;
  await f.service.tick();
  expect(f.request.mock.calls.filter(([command]) => command.type === 'agenda.tick')).toHaveLength(4);
  expect(f.request.mock.calls.filter(([command]) => command.type === 'agenda.claim')).toHaveLength(claimsBefore);
});

it('returns waiting promptly, releases its slot and continues the same persisted checkpoint after the future check', async () => {
  const f = fixture();
  f.execute.mockImplementationOnce(async (_claim, context) => {
    await context.checkpoint('等待资料', { phase: 'read', actualIds: ['read_1'] });
    throw new CompanionAgendaDeferred('等待真实资料返回', new Date(Date.now() + 60000).toISOString(), 'source.available');
  });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(settles(f)[0]).toMatchObject({ outcome: 'waiting', nextCondition: 'source.available' });
  await until(() => f.service.snapshot().active === 0);
  await f.service.tick(); expect(f.execute).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 60000); await f.service.tick(); await until(() => f.execute.mock.calls.length === 2);
  expect(f.execute.mock.calls[1]![0].run.id).toBe(f.claims[0]!.run.id);
  expect(companionAgendaCheckpoint(f.execute.mock.calls[1]![0].run)).toEqual({ phase: 'read', actualIds: ['read_1'] });
});

it('isolates an unavailable owner and does not misclassify a resource wait as processing failure', async () => {
  const f = fixture([sample('alice', 1), sample('bob', 1)], { facts: async owner => {
    if (owner === 'alice') throw new Error('此伙伴的世界状态暂不可读'); return { available: true };
  } });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(f.execute.mock.calls.map(([claim]) => claim.run.companionId)).toEqual(['bob']);
  expect(f.report).toHaveBeenCalledTimes(1);
  expect(f.claims[0]!.run.status).toBe('queued');
});

it('stores successful effect receipts and reuses them across a resumed execution', async () => {
  const f = fixture(), send = vi.fn(async (identity: string) => ({ messageId: 'message_1', identity }));
  f.execute.mockImplementation(async (_claim, context) => {
    const receipt = await context.effect('deliver_report', '交付报告', send);
    expect(receipt.messageId).toBe('message_1');
    return f.execute.mock.calls.length === 1 ? { outcome: 'waiting', notBefore: new Date(Date.now() + 1000).toISOString() } : { outcome: 'completed' };
  });
  await f.service.tick(); await until(() => settles(f).length === 1); await until(() => f.service.snapshot().active === 0);
  vi.setSystemTime(Date.now() + 1000); await f.service.tick(); await until(() => settles(f).length === 2);
  expect(send).toHaveBeenCalledTimes(1);
  expect([...f.steps.values()][0]).toMatchObject({ status: 'succeeded', runId: f.claims[0]!.run.id });
});

it('single-flights duplicate effect keys inside one adapter, including concurrent native requests', async () => {
  const f = fixture(), send = vi.fn(async () => ({ id: 'one_delivery' }));
  f.execute.mockImplementation(async (_claim, context) => {
    const values = await Promise.all([context.effect('send', '发送', send), context.effect('send', '发送', send)]);
    expect(values).toEqual([{ id: 'one_delivery' }, { id: 'one_delivery' }]); return { outcome: 'completed' };
  });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(send).toHaveBeenCalledTimes(1); expect(settles(f)[0]!.outcome).toBe('completed');
});

it('parks uncertain external outcomes for reconciliation rather than repeating the action as a processing retry', async () => {
  const f = fixture(), send = vi.fn(async () => { throw new Error('对方可能已收，连接中断'); });
  f.execute.mockImplementation(async (_claim, context) => { await context.effect('send', '发送', send); return { outcome: 'completed' }; });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(settles(f)[0]).toMatchObject({ outcome: 'unknown' });
  expect([...f.steps.values()][0]!.status).toBe('unknown');
  await f.service.tick(); expect(send).toHaveBeenCalledTimes(1);
});

it('does not replay a dispatched step left by an earlier process', async () => {
  const f = fixture(), effect = vi.fn(async () => ({ id: 'must_not_happen' }));
  f.execute.mockImplementation(async (_claim, context) => {
    const effectKey = context.effectId('send');
    f.steps.set(effectKey, { id: 'prior_step', companionId: 'alice', runId: f.claims[0]!.run.id, effectKey,
      title: '发送', status: 'dispatched', createdAt: at, updatedAt: at });
    await context.effect('send', '发送', effect); return { outcome: 'completed' };
  });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(settles(f)[0]!.outcome).toBe('unknown'); expect(effect).not.toHaveBeenCalled();
});

it('requires the actual dispatched receipt before invoking an external operation', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!, effect = vi.fn(async () => ({ sent: true }));
  f.request.mockImplementation(async command => {
    const response = await original(command);
    return command.type === 'agenda.step.record' && command.status === 'dispatched' ? { ok: true } : response;
  });
  f.execute.mockImplementation(async (_claim, context) => { await context.effect('send', '发送', effect); return { outcome: 'completed' }; });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(effect).not.toHaveBeenCalled();
  expect([...f.steps.values()][0]!.status).toBe('dispatched'); // No action; a future retry must reconcile this uncertain receipt.
});

it('rejects another owner effect receipt instead of returning its private stored value', async () => {
  const f = fixture(), effect = vi.fn(async () => ({ sent: true })), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => command.type === 'agenda.step.read' ? { ok: true,
    agendaStep: { id: 'foreign', companionId: 'bob', runId: 'foreign_run', effectKey: command.effectKey,
      title: '私密回执', status: 'succeeded', result: '{"private":"must_not_read"}', createdAt: at, updatedAt: at } } : original(command));
  f.execute.mockImplementation(async (_claim, context) => { await context.effect('send', '发送', effect); return { outcome: 'completed' }; });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(effect).not.toHaveBeenCalled(); expect(settles(f)[0]!.outcome).toBe('unknown');
});

it('permits a normal processing retry only when the effect owner explicitly confirms no action was applied', async () => {
  const f = fixture(), effect = vi.fn(async () => { throw new CompanionAgendaEffectNotApplied('对方明确拒绝，未发送'); });
  f.execute.mockImplementation(async (_claim, context) => { await context.effect('send', '发送', effect); return { outcome: 'completed' }; });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(settles(f)[0]!.outcome).toBe('failed'); expect([...f.steps.values()][0]!.status).toBe('failed');
});

it('does not turn an unknown settlement acknowledgement into a second callback or failure settlement', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => {
    const response = await original(command);
    if (command.type === 'agenda.run.settle') throw new Error('提交已完成，但确认连接断开'); return response;
  });
  await f.service.tick(); await until(() => f.service.snapshot().active === 0);
  await f.service.tick();
  expect(f.execute).toHaveBeenCalledTimes(1); expect(settles(f)).toHaveLength(1);
  expect(f.claims[0]!.run.status).toBe('completed'); expect(f.report).toHaveBeenCalledTimes(1);
});

it('aborts an old worker after lease loss and never commits its late result', async () => {
  const f = fixture(undefined, { leaseMs: 1000 });
  f.execute.mockImplementation(async (_claim, _context, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { outcome: 'completed' };
  });
  await f.service.tick(); await until(() => f.execute.mock.calls.length === 1);
  f.request.mockImplementationOnce(async () => ({ ok: false, error: '已被其他控制操作撤销' }));
  await vi.advanceTimersByTimeAsync(334); await until(() => f.service.snapshot().active === 0);
  expect(f.execute.mock.calls[0]![2].aborted).toBe(true); expect(settles(f)).toHaveLength(0); expect(f.report).toHaveBeenCalledOnce();
});

it('validates claimed owner/run identities before any adapter can see another companion input', async () => {
  const f = fixture(), wrong = sample('bob', 1);
  f.request.mockImplementation(async command => command.type === 'agenda.claim' ? { ok: true, agendaClaim: wrong } : { ok: true });
  await f.service.tick(); expect(f.execute).not.toHaveBeenCalled(); expect(f.report).toHaveBeenCalledOnce();
});

it('cancels one owner while another event remains active and closes without waiting on external owner shutdown', async () => {
  const f = fixture([sample('alice', 1), sample('bob', 1)]);
  f.execute.mockImplementation(async (_claim, _context, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { outcome: 'completed' };
  });
  await f.service.tick(); await until(() => f.execute.mock.calls.length === 2);
  await f.service.drainCompanion('alice');
  expect(f.service.snapshot()).toEqual({ active: 1, owners: [{ companionId: 'bob', active: 1 }] });
  expect(settles(f)).toHaveLength(0);
  await f.service.close(); await f.service.drain(); expect(f.service.snapshot().active).toBe(0);
});

it('retains uncertain state when a successful effect cannot durably save its receipt', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!, effect = vi.fn(async () => ({ sent: true }));
  f.request.mockImplementation(async command => command.type === 'agenda.step.record' && command.status === 'succeeded'
    ? { ok: false, error: '回执磁盘不可写' } : original(command));
  f.execute.mockImplementation(async (_claim, context) => { await context.effect('send', '发送', effect); return { outcome: 'completed' }; });
  await f.service.tick(); await until(() => settles(f).length === 1);
  expect(effect).toHaveBeenCalledOnce(); expect(settles(f)[0]!.outcome).toBe('unknown');
  expect([...f.steps.values()][0]!.status).toBe('dispatched');
});

it('cannot announce completion when an adapter forgot to await an effect with an uncertain result', async () => {
  const f = fixture(), held = deferred<void>(); releases.push(() => held.resolve());
  f.execute.mockImplementation(async (_claim, context) => {
    void context.effect('deliver', '交付', async () => { await held.promise; throw new Error('外部结果未知'); });
    return { outcome: 'completed', result: '这个提早结论不能被发布' };
  });
  await f.service.tick(); await until(() => [...f.steps.values()].some(step => step.status === 'dispatched'));
  expect(settles(f)).toHaveLength(0);
  held.resolve(); await until(() => settles(f).length === 1);
  expect(settles(f)[0]!.outcome).toBe('unknown');
});

it('interrupts only the selected rule or revoked grant, including a host-bound goal grant', async () => {
  const first = sample('alice', 1), second = sample('alice', 2), third = sample('alice', 3);
  first.rule.grantId = 'grant_direct';
  const f = fixture([first, second, third]);
  f.execute.mockImplementation(async (claim, context, signal) => {
    if (claim.rule.id === second.rule.id) context.bindGrant('grant_inherited');
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { outcome: 'completed' };
  });
  await f.service.tick(); await until(() => f.execute.mock.calls.length === 3);
  f.service.cancelGrant('grant_inherited'); await until(() => f.service.snapshot().active === 2);
  expect(f.execute.mock.calls[0]![2].aborted).toBe(false);
  expect(f.execute.mock.calls[1]![2].aborted).toBe(true);
  expect(f.execute.mock.calls[2]![2].aborted).toBe(false);
  f.service.cancelRule('bob', third.rule.id); expect(f.execute.mock.calls[2]![2].aborted).toBe(false);
  f.service.cancelRule('alice', third.rule.id); await until(() => f.service.snapshot().active === 1);
  f.service.cancelGrant('grant_direct'); await until(() => f.service.snapshot().active === 0);
  expect(settles(f)).toHaveLength(0);
});

it('notifies changed observers only when the persisted revision changes during idle checks', async () => {
  let revision = 7;
  const f = fixture([], { owners: async () => ['alice'] });
  f.request.mockImplementation(async command => ({ ok: true, ...(command.type === 'agenda.tick' ? { agendaRevision: revision } : {}) }));
  await f.service.tick(); await f.service.tick(); expect(f.changed).toHaveBeenCalledTimes(1);
  revision++; await f.service.tick(); expect(f.changed).toHaveBeenCalledTimes(2);
});

it('accepts lifecycle start once and clears timer work on close', async () => {
  const f = fixture([]);
  f.service.start(); f.service.start(); await until(() => vi.getTimerCount() === 1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.execute).not.toHaveBeenCalled();
  await f.service.close(); await f.service.drain(); expect(vi.getTimerCount()).toBe(0);
});

it('rejects corrupt resume checkpoints instead of silently starting from scratch', () => {
  expect(companionAgendaCheckpoint({})).toBeUndefined();
  expect(() => companionAgendaCheckpoint({ checkpoint: '{broken' })).toThrow(CompanionAgendaOutcomeUnknown);
});
