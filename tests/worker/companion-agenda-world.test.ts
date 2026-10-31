import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionAgendaClaim } from '../../src/shared/companion-agenda';
import type { CompanionWorldJob } from '../../src/shared/companion-world';
import { controlCompanionAgendaWorld, restoreCompanionAgendaWorld } from '../../src/main/companions/agenda-world-recovery';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { executeAgendaWorld } from '../../src/main/companions/agenda-world';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';

let store: CompanionsStore, db: CompanionConnection, root: string;
const at = '2026-10-29T10:00:00.000Z';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
  root = mkdtempSync(path.join(tmpdir(), 'agenda-world-')); const filename = path.join(root, 'messages.sqlite');
  store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, persona: '依据实际经历表达。', description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  db = new (Database as { new(filename: string): CompanionConnection })(filename);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
    store.request({ type: 'tasks.concurrency.set', companionId, limit: 1 });
  }
  advance(10000);
});
afterEach(() => { db.close(); store.close(); vi.useRealTimers(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('agenda-world-')) throw Error('Unexpected cleanup'); rmSync(root, { recursive: true, force: true }); });
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function parent(companionId = 'alice'): CompanionAgendaClaim {
  store.request({ type: 'agenda.rule.create', companionId, operationId: 'world-parent-' + companionId, authority: { kind: 'system' }, rule: {
    title: '真实世界机会', intent: '处理本人真实发生的世界和社交事件', executor: 'world', kind: 'world', reason: '有实际机会时才行动', referenceId: 'system_world_v1',
    trigger: { kind: 'at', at: new Date().toISOString(), repeat: 'once', timeZone: 'UTC' } } });
  store.request({ type: 'agenda.tick', companionId, now: new Date().toISOString(), facts: {} });
  return store.request({ type: 'agenda.claim', companionId, now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
}
const scope = (claim: CompanionAgendaClaim) => ({ companionId: claim.rule.companionId, agendaRunId: claim.run.id, agendaLeaseToken: claim.leaseToken });
function incoming() {
  const room = store.openPrivate('bob'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请联系alice核对真实读书安排。', replyDirective: 'none' });
  const peer = store.request({ type: 'social.conversation.ensure', companionId: 'bob', memberIds: ['alice', 'bob'] }).socialConversation!;
  const send = { type: 'social.send' as const, companionId: 'bob', conversationId: peer.id, channel: 'phone' as const, content: '可以一起核对读书安排吗？', clientId: 'actual_world_send', authorizationMessageId: source.id,
    agentSource: { conversationId: room.id, messageId: source.id } };
  store.request(send); advance(1500); store.request(send); return { source, peer };
}

it('retries real same-owner world contention after one second and rechecks the native source and lease on admission', async () => {
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 3 });
  incoming();
  const native = db.prepare("SELECT id FROM companion_social_jobs WHERE companion_id='alice'").get() as { id: string };
  const first = parent();
  store.request({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'second-real-world-opportunity', authority: { kind: 'system' }, rule: {
    title: '下一次真实世界机会', intent: '核对待处理的同一收件事件', executor: 'world', kind: 'world', reason: '真实并发的第二个世界入口', referenceId: 'system_world_v1',
    trigger: { kind: 'at', at: new Date().toISOString(), repeat: 'once', timeZone: 'UTC' } } });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const second = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
  expect(first.run.id).not.toBe(second.run.id);
  let entered!: () => void, release!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; }), transport = new Promise<void>(resolve => { release = resolve; });
  const firstController = new AbortController(), nextController = new AbortController();
  let firstHeld = false, renewedClaim = false;
  const request = async (command: CompanionStorageCommand) => {
    const response = store.request(command);
    if (command.type === 'social.job.claim' && response.socialJob) {
      // Hold the actual SQL claim response: owner admission, real source,
      // phone reservation and the native lease have already been checked.
      if (!firstHeld) { firstHeld = true; entered(); await transport; }
      else { renewedClaim = true; nextController.abort(); }
    }
    return response;
  };
  const service = new CompanionWorldService({ request, changed: vi.fn(), wakeWaiting: vi.fn(), report: vi.fn(), fetchFn: vi.fn(),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'not-dispatched', apiKey: 'fixture' }) });
  service.setAgendaDriven();
  const running = service.runAgendaQuantum({ ...scope(first), lane: 'social', referenceId: native.id }, firstController.signal);
  try {
    await Promise.race([acquired, running.then(() => { throw new Error('The real first native claim did not stay active.'); })]);
    const context: CompanionAgendaExecutionContext = { checkpoint: vi.fn(async () => undefined), effect: vi.fn(), effectId: vi.fn(), bindGrant: vi.fn() };
    const waiting = await executeAgendaWorld(second, context, new AbortController().signal, { world: service, lane: 'social' });
    expect(waiting).toMatchObject({ outcome: 'waiting', notBefore: new Date(Date.now() + 1000).toISOString() });
    store.request({ type: 'agenda.run.settle', companionId: 'alice', id: second.run.id, leaseToken: second.leaseToken,
      now: new Date().toISOString(), outcome: 'waiting', notBefore: waiting.notBefore });
    firstController.abort(); release(); await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    store.request({ type: 'agenda.run.settle', companionId: 'alice', id: first.run.id, leaseToken: first.leaseToken,
      now: new Date().toISOString(), outcome: 'cancelled' });
    advance(999);
    expect(store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim).toBeUndefined();
    advance(2);
    const next = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
    expect(next.run.id).toBe(second.run.id);
    await expect(service.runAgendaQuantum({ ...scope(next), lane: 'social', referenceId: native.id }, nextController.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(renewedClaim).toBe(true);
  } finally { firstController.abort(); release(); await running.catch(() => undefined); await service.close(); }
});

it('claims an exact owner world event under one slot and fences old publication after the parent lease is replaced', async () => {
  const claim = parent(), now = new Date().toISOString();
  const job: CompanionWorldJob = { id: 'exact_world', kind: 'decision', companionId: 'alice', conversationId: 'world_alice', status: 'pending', attempts: 0, createdAt: now, throughEventSequence: 0, sourceMemoryIds: [] };
  db.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,data) VALUES(?,?,?,?,?)').run(job.id, job.companionId, job.kind, job.status, JSON.stringify(job));
  expect(() => store.request({ type: 'world.job.claim', kind: 'decision', ...scope(claim), agendaLeaseToken: 'wrong_token', id: job.id })).toThrow('日程执行已经停止');
  const native = store.request({ type: 'world.job.claim', kind: 'decision', ...scope(claim), id: job.id }).worldJob!;
  expect(native.id).toBe(job.id); expect(native.disposition?.inputVersion).toHaveLength(64);
  expect(store.request({ type: 'tasks.concurrency.get', companionId: 'alice' }).taskConcurrency!.policies[0]!.active).toBe(1);
  const current = store.request({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!;
  const held = store.request({ type: 'agenda.run.control', companionId: 'alice', id: current.id, expectedRevision: current.revision, operationId: 'hold_world', authority: { kind: 'user' }, action: 'pause' }).agendaRun!;
  expect(store.request({ type: 'world.job.check', id: job.id, leaseToken: native.leaseToken! }).worldJob).toBeUndefined();
  expect(() => store.request({ type: 'world.job.complete', id: job.id, leaseToken: native.leaseToken!, sourceMemoryIds: [], memoryCandidates: [] })).toThrow('日程执行已经停止');
  const sourceRun = { ...held, checkpoint: JSON.stringify({ nativeJob: { kind: 'world', id: native.id, inputVersion: native.disposition!.inputVersion, revision: native.disposition!.revision, lane: 'decision' } }) };
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => store.request(command);
  expect((await controlCompanionAgendaWorld(sourceRun, 'park', { request })).handled).toBe(true);
  expect((await restoreCompanionAgendaWorld(sourceRun, { request })).canResume).toBe(true);
  store.request({ type: 'agenda.run.control', companionId: 'alice', id: held.id, expectedRevision: held.revision, operationId: 'resume_world', authority: { kind: 'user' }, action: 'resume' });
  const renewed = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
  const next = store.request({ type: 'world.job.claim', kind: 'decision', ...scope(renewed), id: native.id }).worldJob!;
  expect(next.id).toBe(native.id); expect(next.leaseToken).not.toBe(native.leaseToken);
  expect(store.request({ type: 'world.job.check', id: native.id, leaseToken: native.leaseToken! }).worldJob).toBeUndefined();
  expect(store.request({ type: 'world.job.check', id: next.id, leaseToken: next.leaseToken! }).worldJob?.id).toBe(next.id);
});

it('parks three actual social failures, preserves the source and lifetime count, and supports exact idempotent resume/abandon', () => {
  const actual = incoming(), claim = parent();
  let job = store.request({ type: 'social.job.claim', ...scope(claim) }).socialJob!;
  expect(job.companionId).toBe('alice'); expect(job.agendaInputVersion).toHaveLength(64);
  expect(store.request({ type: 'tasks.concurrency.get', companionId: 'alice' }).taskConcurrency!.policies[0]!.active).toBe(1);
  for (let cycle = 1; cycle <= 3; cycle++) {
    store.request({ type: 'social.job.fail', id: job.id, leaseToken: job.leaseToken!, error: '可见处理故障' });
    job = store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!;
    if (cycle < 3) { advance(cycle === 1 ? 21000 : 41000); job = store.request({ type: 'social.job.claim', ...scope(claim), id: job.id }).socialJob!; }
  }
  expect(job).toMatchObject({ status: 'parked', agendaFailureCount: 3, agendaCycleFailureCount: 3 });
  expect(store.request({ type: 'social.job.claim', ...scope(claim), id: job.id }).socialJob).toBeUndefined();
  const command = { type: 'social.job.control' as const, companionId: 'alice', id: job.id, inputVersion: job.agendaInputVersion!, expectedRevision: job.agendaRevision!, operationId: randomUUID(), action: 'resume' as const };
  const resumed = store.request(command).socialJob!; expect(resumed).toMatchObject({ status: 'pending', agendaFailureCount: 3, agendaCycleFailureCount: 0 });
  expect(store.request(command).socialJob).toEqual(resumed);
  const ended = store.request({ ...command, action: 'abandon', expectedRevision: resumed.agendaRevision!, operationId: randomUUID() }).socialJob!;
  expect(ended.status).toBe('abandoned'); expect(store.getMessage(actual.source.id).content).toContain('真实读书安排');
  expect(store.request({ type: 'social.job.read', companionId: 'bob', id: job.id }).socialJob).toBeUndefined();
});

it('binds real continuation notifications and fences late reports after parent pause without discarding the actual event', () => {
  incoming(); const peerParent = parent('alice');
  const job = store.request({ type: 'social.job.claim', ...scope(peerParent) }).socialJob!;
  advance(1500); store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '我已经核对，明天可以一起读书。' });
  advance(1500); const ownerParent = parent('bob');
  const notice = store.request({ type: 'social.notification.claim', ...scope(ownerParent) }).socialNotification!;
  expect(notice.companionId).toBe('bob'); expect(notice.agendaInputVersion).toHaveLength(64);
  expect(store.request({ type: 'tasks.concurrency.get', companionId: 'bob' }).taskConcurrency!.policies[0]!.active).toBe(1);
  const run = store.request({ type: 'agenda.run.read', companionId: 'bob', id: ownerParent.run.id }).agendaRun!;
  store.request({ type: 'agenda.run.control', companionId: 'bob', id: run.id, expectedRevision: run.revision, operationId: 'hold_notice', authority: { kind: 'user' }, action: 'pause' });
  expect(() => store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '迟到回报' })).toThrow('日程执行已经停止');
  store.request({ type: 'social.notification.defer', companionId: 'bob', id: notice.id, leaseToken: notice.leaseToken!, error: '结果尚未确认', retryAfterMs: 1000, uncertain: true });
  const current = store.request({ type: 'social.notification.read', companionId: 'bob', id: notice.id }).socialNotification!;
  expect(current).toMatchObject({ status: 'parked', agendaUncertain: true, agendaFailureCount: 0 }); expect(current.evidence.text).toContain('核对');
  expect(store.request({ type: 'social.notification.read', companionId: 'alice', id: notice.id }).socialNotification).toBeUndefined();
});

it('resumes the same native input after rule pause/resume but fences an actual semantic rule edit', () => {
  const claim = parent(), now = new Date().toISOString();
  const job: CompanionWorldJob = { id: 'rule_held_world', kind: 'decision', companionId: 'alice', conversationId: 'world_alice', status: 'pending', attempts: 0, createdAt: now, throughEventSequence: 0, sourceMemoryIds: [] };
  db.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,data) VALUES(?,?,?,?,?)').run(job.id, job.companionId, job.kind, job.status, JSON.stringify(job));
  const original = store.request({ type: 'world.job.claim', kind: 'decision', ...scope(claim), id: job.id }).worldJob!;
  const paused = store.request({ type: 'agenda.rule.control', companionId: 'alice', id: claim.rule.id, expectedRevision: claim.rule.revision,
    operationId: 'pause_world_rule', authority: { kind: 'user' }, action: 'pause' }).agendaRule!;
  const held = store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'world', id: original.id, inputVersion: original.disposition!.inputVersion,
    expectedRevision: original.disposition!.revision, operationId: randomUUID(), action: 'park' }).jobDisposition!;
  store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'world', id: original.id, inputVersion: held.inputVersion, expectedRevision: held.revision, operationId: randomUUID(), action: 'resume' });
  const resumedRule = store.request({ type: 'agenda.rule.control', companionId: 'alice', id: claim.rule.id, expectedRevision: paused.revision,
    operationId: 'resume_world_rule', authority: { kind: 'user' }, action: 'resume' }).agendaRule!;
  const resumed = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
  expect(resumed.run.id).toBe(claim.run.id); expect(resumed.rule.revision).toBe(claim.rule.revision); expect(resumedRule.revision).toBeGreaterThan(resumed.rule.revision);
  const current = store.request({ type: 'world.job.claim', kind: 'decision', ...scope(resumed), id: job.id, expectedInputVersion: held.inputVersion }).worldJob!;
  expect(current.id).toBe(original.id); expect(current.disposition!.inputVersion).toBe(held.inputVersion);
  store.request({ type: 'agenda.rule.update', companionId: 'alice', id: claim.rule.id, expectedRevision: resumedRule.revision, operationId: 'change_world_meaning', authority: { kind: 'user' },
    rule: { title: '已经改变的行动含义', intent: '与原来不同的未来行动', kind: 'world', executor: 'world', trigger: claim.rule.trigger, reason: '实际改变语义', referenceId: 'system_world_v1' } });
  expect(store.request({ type: 'world.job.check', id: current.id, leaseToken: current.leaseToken! }).worldJob).toBeUndefined();
  expect(() => store.request({ type: 'world.job.complete', id: current.id, leaseToken: current.leaseToken!, sourceMemoryIds: [], memoryCandidates: [] })).toThrow('日程不属于');
});
