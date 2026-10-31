import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { reconcileCompanionAgendaChat, executeCompanionAgendaChat, restoreCompanionAgendaChat } from '../../src/main/companions/agenda-chat';
import type { CompanionAgendaClaim } from '../../src/shared/companion-agenda';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionWork } from '../../src/shared/companion-loop';
import type { CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';

let store: CompanionsStore, root: string;
const at = '2026-10-29T10:00:00.000Z';
const context: CompanionAgendaExecutionContext = { checkpoint: vi.fn(async () => undefined), effect: vi.fn(), effectId: vi.fn(), bindGrant: vi.fn() };
const request = async (command: CompanionStorageCommand) => store.request(command);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
  root = mkdtempSync(path.join(tmpdir(), 'agenda-chat-'));
  store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, persona: '只依据实际经历表达。',
    description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'UTC' } });
  for (const id of ['alice', 'bob']) {
    const room = store.openPrivate(id), scope = { companionId: id, conversationId: room.id };
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
  vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
});
afterEach(() => {
  store.close(); vi.useRealTimers();
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('agenda-chat-')) throw Error('Unexpected cleanup');
  rmSync(root, { recursive: true, force: true });
});
async function queued() {
  const room = store.openPrivate('alice');
  const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '处理这一条实际消息。', replyDirective: 'queue' });
  await reconcileCompanionAgendaChat({ request });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const claim = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaim!;
  return { room, source, claim };
}
function nativeClaim(claim: CompanionAgendaClaim) {
  return store.request({ type: 'work.claim', companionId: claim.rule.companionId, id: claim.rule.referenceId,
    agendaRunId: claim.run.id, agendaLeaseToken: claim.leaseToken }).work!;
}

it('retries the same FIFO-blocked queued chat after one second without bypassing admission or its agenda lease', async () => {
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 3 });
  const room = store.openPrivate('alice');
  const first = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '先收到的独立消息。', replyDirective: 'queue' });
  const second = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '随后收到的独立消息。', replyDirective: 'queue' });
  await reconcileCompanionAgendaChat({ request });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const claims = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000,
    limit: 2, excludedOwners: [] }).agendaClaims!;
  expect(claims).toHaveLength(2);
  const sourceFor = (claim: CompanionAgendaClaim) => store.request({ type: 'work.get', companionId: 'alice', id: claim.rule.referenceId! }).work!.sourceMessageId;
  const earlier = claims.find(claim => sourceFor(claim) === first.id)!;
  const later = claims.find(claim => sourceFor(claim) === second.id)!;
  const execute = vi.fn(async () => undefined);
  const waiting = await executeCompanionAgendaChat(later, context, new AbortController().signal, { request, execute });
  expect(waiting).toMatchObject({ outcome: 'waiting', nextCondition: 'chat.native_admission',
    notBefore: new Date(Date.now() + 1000).toISOString() });
  expect(execute).not.toHaveBeenCalled();
  expect(store.request({ type: 'work.get', companionId: 'alice', id: later.rule.referenceId! }).work!.status).toBe('queued');
  store.request({ type: 'agenda.run.settle', companionId: 'alice', id: later.run.id, leaseToken: later.leaseToken,
    now: new Date().toISOString(), outcome: 'waiting', notBefore: waiting.notBefore, nextCondition: waiting.nextCondition });
  const runningFirst = nativeClaim(earlier);
  expect(runningFirst.sourceMessageId).toBe(first.id);
  vi.setSystemTime(Date.now() + 999);
  expect(store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000,
    limit: 1, excludedOwners: [] }).agendaClaim).toBeUndefined();
  vi.setSystemTime(Date.now() + 2);
  const resumed = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000,
    limit: 1, excludedOwners: [] }).agendaClaim!;
  expect(resumed.run.id).toBe(later.run.id);
  expect(resumed.leaseToken).not.toBe(later.leaseToken);
  expect(() => nativeClaim(later)).toThrow('租约失效');
  const runningSecond = nativeClaim(resumed);
  expect(runningSecond).toMatchObject({ sourceMessageId: second.id, status: 'running', agendaRunId: later.run.id, agendaLeaseToken: resumed.leaseToken });
  expect(store.request({ type: 'work.get', companionId: 'alice', id: runningFirst.id }).work!.status).toBe('running');
});

it('runs normal chat under one actual agenda slot and preserves original loop completion', async () => {
  const { source, claim } = await queued();
  const result = await executeCompanionAgendaChat(claim, context, new AbortController().signal, { request, execute: async work => {
    expect(store.request({ type: 'tasks.concurrency.get', companionId: 'alice' }).taskConcurrency!.policies[0]).toMatchObject({ active: 1, limit: 1 });
    expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
    const loop = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
    loop.turns.push({ text: '已核对这条消息。', rawText: '已核对这条消息。', calls: [] }); loop.status = 'done';
    store.request({ type: 'loop.save', checkpoint: loop });
    store.request({ type: 'work.status', id: work.id, status: 'done', agendaRunId: work.agendaRunId, agendaLeaseToken: work.agendaLeaseToken });
  } });
  expect(result.outcome).toBe('completed');
  const loop = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  expect(store.getMessage(loop.messageId!).content).toBe('已核对这条消息。');
});

it('fences late chat publication after parent pause and restores the same native attempt with a fresh lease', async () => {
  const { source, claim } = await queued(), work = nativeClaim(claim);
  const parent = store.request({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!;
  const held = store.request({ type: 'agenda.run.control', companionId: 'alice', id: parent.id, expectedRevision: parent.revision,
    operationId: 'hold_chat', authority: { kind: 'user' }, action: 'pause' }).agendaRun!;
  const loop = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  loop.turns.push({ text: '迟到回复', rawText: '迟到回复', calls: [] }); loop.status = 'done';
  expect(() => store.request({ type: 'loop.save', checkpoint: loop })).toThrow('日程执行已停止');
  store.request({ type: 'work.status', id: work.id, status: 'interrupted', agendaRunId: work.agendaRunId, agendaLeaseToken: work.agendaLeaseToken });
  expect((await restoreCompanionAgendaChat(held, { request })).canResume).toBe(true);
  store.request({ type: 'agenda.run.control', companionId: 'alice', id: held.id, expectedRevision: held.revision,
    operationId: 'resume_chat', authority: { kind: 'user' }, action: 'resume' });
  const resumed = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaim!;
  const next = nativeClaim(resumed);
  expect(next.agendaAttempt ?? 0).toBe(0); expect(next.agendaRunId).toBe(work.agendaRunId); expect(next.agendaLeaseToken).not.toBe(work.agendaLeaseToken);
  expect(() => store.request({ type: 'work.status', id: work.id, status: 'interrupted', agendaRunId: work.agendaRunId,
    agendaLeaseToken: work.agendaLeaseToken })).toThrow('旧租约');
  expect(store.request({ type: 'tasks.concurrency.get', companionId: 'alice' }).taskConcurrency!.policies[0]!.active).toBe(1);
});

it('keeps a cancelled attempt as history and creates the next event only after explicit native retry', async () => {
  const { claim } = await queued(), work = nativeClaim(claim);
  store.request({ type: 'work.status', id: work.id, status: 'cancelled', agendaRunId: work.agendaRunId, agendaLeaseToken: work.agendaLeaseToken });
  const prior = store.request({ type: 'agenda.run.settle', companionId: 'alice', id: claim.run.id, leaseToken: claim.leaseToken,
    now: new Date().toISOString(), outcome: 'cancelled' }).agendaRun!;
  expect(await reconcileCompanionAgendaChat({ request })).toEqual([]);
  store.request({ type: 'work.enqueue', work, resume: true });
  const next = (await reconcileCompanionAgendaChat({ request }))[0]!;
  expect(next.id).not.toBe(claim.rule.id); expect(next.referenceId).toBe(work.id); expect(next.referenceVersion).toBe('1');
  expect(store.request({ type: 'agenda.run.read', companionId: 'alice', id: prior.id }).agendaRun!.status).toBe('cancelled');
  store.request({ type: 'work.enqueue', work, resume: true });
  expect(store.request({ type: 'work.get', companionId: 'alice', id: work.id }).work!.agendaAttempt).toBe(1);
});

it('releases only the exact safely interrupted host lease before automatically restoring its chat attempt', async () => {
  const { source, claim } = await queued(), work = nativeClaim(claim);
  const before = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  store.request({ type: 'work.status', id: work.id, status: 'interrupted', resumeOnRestart: true,
    agendaRunId: work.agendaRunId, agendaLeaseToken: work.agendaLeaseToken });
  const interrupted = store.request({ type: 'work.get', companionId: 'alice', id: work.id }).work!;
  expect(store.request({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!.status).toBe('running');
  store.request({ type: 'work.enqueue', work: interrupted, resume: true });
  expect(store.request({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!.status).toBe('cancelled');
  const resumed = store.request({ type: 'work.get', companionId: 'alice', id: work.id }).work!;
  expect(resumed).toMatchObject({ status: 'queued', agendaAttempt: 1 });
  expect(store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!.receivedState).toEqual(before.receivedState);
  await reconcileCompanionAgendaChat({ request });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const next = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000,
    limit: 1, excludedOwners: [] }).agendaClaim!;
  expect(next.rule.referenceVersion).toBe('1');
  expect(() => nativeClaim(claim)).toThrow('租约失效');
  expect(nativeClaim(next)).toMatchObject({ id: work.id, sourceMessageId: source.id, status: 'running', agendaRunId: next.run.id });
});

it('retains the previous lease when a restart-marked loop has an unconfirmed tool effect', async () => {
  const { source, claim } = await queued(), work = nativeClaim(claim);
  const loop = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
  loop.turns.push({ text: '', rawText: '', calls: [{ id: 'unconfirmed', name: 'dsh_task', arguments: '{}' }] });
  store.request({ type: 'loop.save', checkpoint: loop });
  store.request({ type: 'work.status', id: work.id, status: 'interrupted', resumeOnRestart: true,
    agendaRunId: work.agendaRunId, agendaLeaseToken: work.agendaLeaseToken });
  const interrupted = store.request({ type: 'work.get', companionId: 'alice', id: work.id }).work!;
  expect(() => store.request({ type: 'work.enqueue', work: interrupted, resume: true })).toThrow('未核实作用');
  expect(store.request({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!.status).toBe('running');
  expect(store.request({ type: 'work.get', companionId: 'alice', id: work.id }).work!).toMatchObject({ status: 'interrupted', agendaRunId: claim.run.id });
});

it('rejects a foreign parent and a retargeted immutable attempt before native chat starts', async () => {
  const { claim } = await queued();
  expect(() => store.request({ type: 'work.claim', companionId: 'alice', id: claim.rule.referenceId,
    agendaRunId: claim.run.id, agendaLeaseToken: 'wrong_token' })).toThrow('租约失效');
  store.request({ type: 'agenda.run.settle', companionId: 'alice', id: claim.run.id, leaseToken: claim.leaseToken,
    now: new Date().toISOString(), outcome: 'waiting', notBefore: '2027-01-01T00:00:00.000Z' });
  store.request({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'wrong_attempt', authority: { kind: 'system' },
    rule: { title: '错误的版本绑定', intent: '不能替代原始版本', kind: 'chat', executor: 'chat', trigger: { kind: 'at', at, timeZone: 'UTC' },
      referenceId: claim.rule.referenceId, referenceVersion: '7', conversationId: claim.rule.conversationId, reason: '测试作用范围' } });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const wrong = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaim!;
  expect(wrong.rule.referenceVersion).toBe('7');
  expect(() => nativeClaim(wrong)).toThrow('真实消息与任务');
});

it('keeps an ordinary message with a legacy steer hint as an independent task when another slot is available', async () => {
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 2 });
  const { room, source, claim } = await queued(); nativeClaim(claim);
  const guidance = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '补充：先检查一个条件。', replyDirective: 'steer' });
  await reconcileCompanionAgendaChat({ request });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const second = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaim!;
  expect(second).toBeDefined();
  const execute = vi.fn(async (work: CompanionWork) => {
    expect(work.sourceMessageId).toBe(guidance.id);
    const loop = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: guidance.id }).loop!;
    loop.turns.push({ text: '独立处理这条新消息。', rawText: '独立处理这条新消息。', calls: [] }); loop.status = 'done';
    store.request({ type: 'loop.save', checkpoint: loop });
    store.request({ type: 'work.status', id: work.id, status: 'done', agendaRunId: work.agendaRunId, agendaLeaseToken: work.agendaLeaseToken });
  });
  expect((await executeCompanionAgendaChat(second, context, new AbortController().signal, { request, execute })).outcome).toBe('completed');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!.supplements).toEqual([]);
  expect(store.request({ type: 'work.get', companionId: 'alice', id: claim.rule.referenceId! }).work!.status).toBe('running');
  expect(store.request({ type: 'work.get', companionId: 'alice', id: second.rule.referenceId! }).work!.status).toBe('done');
});
