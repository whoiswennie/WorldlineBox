import { expect, it, vi } from 'vitest';
import { executeCompanionAgendaChat, reconcileCompanionAgendaChat, restoreCompanionAgendaChat } from '../../src/main/companions/agenda-chat';
import { companionAgendaClaimSchema, companionAgendaRuleSchema, type CompanionAgendaRule } from '../../src/shared/companion-agenda';
import type { CompanionWork } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';

const at = '2026-10-29T02:00:00.000Z';
const work: CompanionWork = { id: 'native_chat', companionId: 'alice', conversationId: 'room', sourceMessageId: 'source',
  proactive: false, status: 'queued', createdAt: at, updatedAt: at };
const answer = (value: object = {}) => ({ ok: true, ...value }) as CompanionStorageResponse;
function fixture() {
  let current: CompanionWork = { ...work }, claimed = true;
  const rules = new Map<string, CompanionAgendaRule>();
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'work.list') return answer({ works: [current] });
    if (command.type === 'work.get') return answer({ work: { ...current } });
    if (command.type === 'agenda.rule.create') {
      if (!rules.has(command.operationId)) rules.set(command.operationId, companionAgendaRuleSchema.parse({ ...command.rule,
        id: 'rule_' + rules.size, companionId: command.companionId, revision: 1, origin: 'system', status: 'active', createdAt: at, updatedAt: at }));
      return answer({ agendaRule: rules.get(command.operationId) });
    }
    if (command.type === 'work.claim') {
      if (!claimed) return answer();
      current = { ...current, status: 'running', agendaRunId: command.agendaRunId, agendaLeaseToken: command.agendaLeaseToken };
      return answer({ work: current });
    }
    if (command.type === 'work.status') { current = { ...current, status: command.status }; return answer(); }
    if (command.type === 'loop.get') return answer({ loop: { companionId: current.companionId, conversationId: current.conversationId,
      sourceMessageId: current.sourceMessageId, status: current.status === 'done' ? 'done' : 'running', turns: [], supplements: [] } });
    return answer();
  });
  const context: CompanionAgendaExecutionContext = { checkpoint: vi.fn(async () => undefined), effect: vi.fn(), effectId: vi.fn(), bindGrant: vi.fn() };
  const execute = vi.fn(async () => { current = { ...current, status: 'done' }; });
  const claim = async () => {
    const [rule] = await reconcileCompanionAgendaChat({ request });
    return companionAgendaClaimSchema.parse({ rule, occurrence: { id: 'occ', companionId: 'alice', ruleId: rule!.id, ruleRevision: 1,
      scheduledAt: at, lastEvaluatedAt: at, state: 'running', reason: '已就绪' }, run: { id: 'run', companionId: 'alice', ruleId: rule!.id,
      occurrenceId: 'occ', revision: 2, status: 'running', stage: '开始', createdAt: at, updatedAt: at, notBefore: at, leaseToken: 'lease',
      leaseUntil: '2026-10-29T02:01:00.000Z', failureCount: 0, cycleFailureCount: 0, retryCycle: 0, attemptCount: 1 }, leaseToken: 'lease' });
  };
  return { request, context, execute, claim, rules, get current() { return current; }, set current(value: CompanionWork) { current = value; }, set claimed(value: boolean) { claimed = value; } };
}

it('reconciles real queued sources idempotently and creates a new immutable event only for an explicit native attempt', async () => {
  const f = fixture();
  const first = (await reconcileCompanionAgendaChat({ request: f.request }))[0]!;
  const again = (await reconcileCompanionAgendaChat({ request: f.request }))[0]!;
  expect(first.id).toBe(again.id); expect(first).toMatchObject({ executor: 'chat', referenceId: work.id, referenceVersion: '0', protected: true,
    trigger: { kind: 'at', at: work.createdAt }, resourceKeys: ['chat:' + work.id] });
  f.current = { ...work, status: 'interrupted' };
  expect(await reconcileCompanionAgendaChat({ request: f.request })).toEqual([]);
  f.current = { ...work, status: 'queued', agendaAttempt: 1 };
  const next = (await reconcileCompanionAgendaChat({ request: f.request }))[0]!;
  expect(next.id).not.toBe(first.id); expect(next.referenceVersion).toBe('1'); expect(f.rules.size).toBe(2);
  expect(f.request.mock.calls.some(([command]) => command.type === 'agenda.run.control')).toBe(false);
});

it('does not create an event from a stale candidate whose native source identity changed', async () => {
  const f = fixture(); f.current = { ...work, sourceMessageId: 'different_source' };
  expect(await reconcileCompanionAgendaChat({ request: f.request, works: [work] })).toEqual([]);
  expect(f.rules.size).toBe(0);
});

it('checkpoints the actual claimed work before the original reply callback and verifies its native completion', async () => {
  const f = fixture(), claim = await f.claim();
  f.execute.mockImplementation(async () => {
    expect(f.context.checkpoint).toHaveBeenCalledWith('已认领真实聊天循环。', expect.objectContaining({ chatWorkId: work.id, chatAttempt: 0 }));
    f.current = { ...f.current, status: 'done' };
  });
  const result = await executeCompanionAgendaChat(claim, f.context, new AbortController().signal, { request: f.request, execute: f.execute });
  expect(result.outcome).toBe('completed');
  expect(f.request).toHaveBeenCalledWith({ type: 'work.claim', companionId: 'alice', id: work.id, agendaRunId: 'run', agendaLeaseToken: 'lease' });
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ agendaRunId: 'run', agendaLeaseToken: 'lease' }), expect.any(AbortSignal));
});

it('releases native condition waits without charging a processing failure or invoking a model', async () => {
  const f = fixture(), claim = await f.claim(); f.claimed = false;
  const result = await executeCompanionAgendaChat(claim, f.context, new AbortController().signal,
    { request: f.request, execute: f.execute, now: () => new Date(at) });
  expect(result).toMatchObject({ outcome: 'waiting', nextCondition: 'chat.native_admission', notBefore: '2026-10-29T02:00:01.000Z' });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.context.checkpoint).not.toHaveBeenCalled();
});

it('preserves the durable agenda not-before boundary when the exact queued task retries', async () => {
  const f = fixture(), claim = await f.claim(); f.claimed = false;
  claim.run.notBefore = '2026-10-29T02:00:20.000Z';
  const result = await executeCompanionAgendaChat(claim, f.context, new AbortController().signal,
    { request: f.request, execute: f.execute, now: () => new Date(at) });
  expect(result.notBefore).toBe(claim.run.notBefore);
  expect(f.execute).not.toHaveBeenCalled();
});

it('does not accelerate a native miss when the queued source no longer matches the original attempt', async () => {
  const f = fixture(), claim = await f.claim(), request = f.request.getMockImplementation()!; f.claimed = false;
  f.request.mockImplementation(async command => {
    const result = await request(command);
    if (command.type === 'work.claim') f.current = { ...f.current, sourceMessageId: 'replaced_source' };
    return result;
  });
  const result = await executeCompanionAgendaChat(claim, f.context, new AbortController().signal,
    { request: f.request, execute: f.execute, now: () => new Date(at) });
  expect(result.notBefore).toBe('2026-10-29T02:00:05.000Z');
  expect(f.execute).not.toHaveBeenCalled();
});

it('rejects a foreign claim receipt before invoking the original reply callback', async () => {
  const f = fixture(), claim = await f.claim(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => command.type === 'work.claim'
    ? answer({ work: { ...work, status: 'running', companionId: 'bob', agendaRunId: 'run', agendaLeaseToken: 'lease' } }) : original(command));
  await expect(executeCompanionAgendaChat(claim, f.context, new AbortController().signal, { request: f.request, execute: f.execute })).rejects.toThrow('认领回执');
  expect(f.execute).not.toHaveBeenCalled();
});

it('does not strand native running work when parent checkpoint linkage fails before inference', async () => {
  const f = fixture(), claim = await f.claim(); vi.mocked(f.context.checkpoint).mockRejectedValue(new Error('旧租约'));
  await expect(executeCompanionAgendaChat(claim, f.context, new AbortController().signal, { request: f.request, execute: f.execute })).rejects.toThrow('旧租约');
  expect(f.current.status).toBe('interrupted'); expect(f.execute).not.toHaveBeenCalled();
  expect(f.request).toHaveBeenCalledWith({ type: 'work.status', id: work.id, status: 'interrupted', agendaRunId: 'run', agendaLeaseToken: 'lease' });
});

it('releases its exact native claim if cancellation arrives after checkpointing but before inference', async () => {
  const f = fixture(), claim = await f.claim(), controller = new AbortController();
  vi.mocked(f.context.checkpoint).mockImplementation(async () => { controller.abort(); });
  expect((await executeCompanionAgendaChat(claim, f.context, controller.signal, { request: f.request, execute: f.execute })).outcome).toBe('cancelled');
  expect(f.current.status).toBe('interrupted'); expect(f.execute).not.toHaveBeenCalled();
});

it('requires a matching completed native loop instead of trusting a bare done flag', async () => {
  const f = fixture(), claim = await f.claim(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => command.type === 'loop.get' ? answer({ loop: { companionId: 'bob', conversationId: 'foreign',
    sourceMessageId: 'foreign_source', status: 'done', turns: [], supplements: [] } }) : original(command));
  expect((await executeCompanionAgendaChat(claim, f.context, new AbortController().signal, { request: f.request, execute: f.execute })).outcome).toBe('unknown');
});

it('parks an interrupted original instead of silently retrying its loop', async () => {
  const f = fixture(), claim = await f.claim(); f.execute.mockImplementation(async () => { f.current = { ...f.current, status: 'interrupted' }; });
  expect((await executeCompanionAgendaChat(claim, f.context, new AbortController().signal, { request: f.request, execute: f.execute })).outcome).toBe('parked');
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('marks incomplete tool effects unknown even if the callback only reports interruption', async () => {
  const f = fixture(), claim = await f.claim(), original = f.request.getMockImplementation()!;
  f.execute.mockImplementation(async () => { f.current = { ...f.current, status: 'interrupted' }; });
  f.request.mockImplementation(async command => command.type === 'loop.get' ? answer({ loop: { companionId: 'alice', conversationId: 'room', sourceMessageId: 'source',
    status: 'running', turns: [{ text: '', rawText: '', calls: [{ id: 'effect_1', name: 'send_file', arguments: '{}' }] }], supplements: [] } }) : original(command));
  expect((await executeCompanionAgendaChat(claim, f.context, new AbortController().signal, { request: f.request, execute: f.execute })).outcome).toBe('unknown');
});

it('does not resurrect a previous attempt when the native queue has advanced', async () => {
  const f = fixture(), claim = await f.claim(); f.current = { ...work, agendaAttempt: 1 };
  expect((await executeCompanionAgendaChat(claim, f.context, new AbortController().signal, { request: f.request, execute: f.execute })).outcome).toBe('cancelled');
  expect(f.execute).not.toHaveBeenCalled();
});

it('restores the exact interrupted child of a paused run without changing its native attempt', async () => {
  const f = fixture(), claim = await f.claim(), original = f.request.getMockImplementation()!;
  const run = { ...claim.run, status: 'parked' as const, revision: 3 };
  f.current = { ...work, status: 'interrupted', agendaRunId: run.id, agendaLeaseToken: 'lease' };
  f.request.mockImplementation(async command => {
    if (command.type === 'agenda.event.read') return answer({ agendaEvent: { rule: claim.rule, runs: [run], occurrences: [claim.occurrence], steps: [] } });
    if (command.type === 'work.agenda.restore') { f.current = { ...f.current, status: 'queued' }; return answer({ work: f.current }); }
    return original(command);
  });
  expect(await restoreCompanionAgendaChat(run, { request: f.request })).toMatchObject({ canResume: true, work: { id: work.id, status: 'queued', agendaRunId: run.id } });
  expect(f.request).toHaveBeenCalledWith({ type: 'work.agenda.restore', companionId: 'alice', id: work.id, agendaRunId: run.id, expectedUpdatedAt: at });
  expect(f.current.agendaAttempt ?? 0).toBe(0);
  f.current = { ...f.current, status: 'cancelled' }; f.request.mockClear();
  expect((await restoreCompanionAgendaChat(run, { request: f.request })).canResume).toBe(false);
  expect(f.request.mock.calls.some(([command]) => command.type === 'work.agenda.restore')).toBe(false);
});
