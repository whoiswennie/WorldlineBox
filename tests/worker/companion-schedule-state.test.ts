import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionScheduleEntry } from '../../src/shared/companion-schedule';
import type { CompanionStateProposal } from '../../src/shared/companion-state';
import type { CompanionMessage } from '../../src/shared/companions';
import { recordUrgentAttention } from '../helpers/companion-world-fixture';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '认真而尊重用户', description: '', model: '', avatar: 'sister', proactive: false }));
const stores = new Set<CompanionsStore>(), folders: string[] = [];
const time = '2026-10-14T08:00:00.000Z';
function open(filename: string) { const store = new CompanionsStore(filename, seeds); stores.add(store); return store; }
function close(store: CompanionsStore) { store.close(); stores.delete(store); }
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'companion-schedule-')); folders.push(folder);
  const filename = path.join(folder, 'messages.sqlite'), store = open(filename);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
  return { filename, store, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function entry(patch: Partial<CompanionScheduleEntry> = {}): CompanionScheduleEntry {
  return { title: '喝水', prompt: '提醒我喝一杯水。', runAt: time, timeZone: 'Asia/Shanghai', ...patch };
}
function proposal(message: CompanionMessage, patch: Partial<CompanionStateProposal> = {}): CompanionStateProposal {
  return { reason: '依据实际互动调整表达。', sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }], ...patch };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(time); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); vi.useRealTimers(); });

describe('persistent companion schedules', () => {
  it('stores actual human form evidence atomically and deduplicates a create retry', () => {
    const { store, scope } = fixture(), content = '只读取文件，绝对不要修改。'.repeat(400);
    const request = { type: 'schedule.create' as const, ...scope, clientId: 'form_retry', entries: [entry({ kind: 'task', prompt: content })] };
    const schedule = store.request(request).schedules![0]!;
    expect(store.request(request).schedules![0]!.id).toBe(schedule.id);
    const evidence = store.getMessage(schedule.sourceMessageId);
    expect(evidence.authorId).toBe('user'); expect(evidence.memoryEvidenceOnly).toBe(true); expect(evidence.content).toContain(content);
    expect(store.request({ type: 'memory.status', ...scope }).memoryStatus?.pending).toBe(1);
    expect(store.request({ type: 'schedule.list', ...scope }).schedules).toHaveLength(1);
  });

  it('requires an affirmative, unquoted user request in the actual owner conversation', () => {
    const { store, scope } = fixture();
    for (const content of ['不要给我设置提醒', '以前你提醒过吗？', '取消我的提醒', '他说明天安排提醒', '“明天提醒我喝水”']) {
      const message = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content });
      expect(() => store.request({ type: 'schedule.create', ...scope, sourceMessageId: message.id, entries: [entry()] })).toThrow('明确要求');
    }
    const peer = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '明天八点叫我喝水' });
    expect(() => store.request({ type: 'schedule.create', ...scope, sourceMessageId: peer.id, entries: [entry()] })).toThrow('真实用户');
    const original = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '明天八点叫我喝水' });
    const created = store.request({ type: 'schedule.create', ...scope, sourceMessageId: original.id, entries: [entry()] }).schedules![0]!;
    const group = store.createConversation('群', ['alice']);
    expect(() => store.request({ type: 'schedule.pause', companionId: 'alice', conversationId: group.id, id: created.id, expectedRevision: 1, paused: true })).toThrow('另一个');
    expect(store.request({ type: 'schedule.list', companionId: 'alice', conversationId: group.id }).schedules).toEqual([]);
  });

  it('claims due once across a restart, reuses expired occurrence and records actual delivery', () => {
    const { store, scope, filename } = fixture();
    const schedule = store.request({ type: 'schedule.create', ...scope, entries: [entry()] }).schedules![0]!;
    const first = store.request({ type: 'schedule.due.claim' }).scheduleOccurrence!;
    expect(first.scheduleId).toBe(schedule.id); expect(first.status).toBe('dispatching');
    expect(store.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
    close(store); vi.setSystemTime(new Date(time).getTime() + 31000);
    const reopened = open(filename), resumed = reopened.request({ type: 'schedule.due.claim' }).scheduleOccurrence!;
    expect(resumed.id).toBe(first.id); expect(resumed.leaseToken).not.toBe(first.leaseToken);
    const message = reopened.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '记得喝水', clientId: 'schedule_' + resumed.id });
    expect(() => reopened.request({ type: 'schedule.occurrence.update', id: resumed.id, leaseToken: first.leaseToken, status: 'done', messageId: message.id })).toThrow('租约');
    const done = reopened.request({ type: 'schedule.occurrence.update', id: resumed.id, leaseToken: resumed.leaseToken, status: 'done', messageId: message.id }).scheduleOccurrence!;
    expect(done.result).toBe('记得喝水'); expect(reopened.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
    expect(reopened.request({ type: 'schedule.occurrence.update', id: done.id, leaseToken: resumed.leaseToken, status: 'done', messageId: message.id }).scheduleOccurrence?.id).toBe(done.id);
  });

  it('advances recurring next time to the future without replaying a downtime backlog', () => {
    const { store, scope } = fixture();
    store.request({ type: 'schedule.create', ...scope, entries: [entry({ runAt: '2026-10-01T08:00:00Z', recurrence: 'daily' })] });
    const claimed = store.request({ type: 'schedule.due.claim' });
    expect(claimed.schedule?.nextRunAt).toBe('2026-10-15T08:00:00.000Z');
    expect(claimed.scheduleOccurrence?.scheduledAt).toBe('2026-10-01T08:00:00.000Z');
    expect(store.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
  });

  it('keeps one actual action per occurrence and recovers only interrupted execution', () => {
    const { store, scope } = fixture();
    store.request({ type: 'schedule.create', ...scope, entries: [entry({ kind: 'task' })] });
    const claimed = store.request({ type: 'schedule.due.claim' }), occurrence = claimed.scheduleOccurrence!, schedule = claimed.schedule!;
    const input = { ...scope, sourceMessageId: schedule.sourceMessageId, title: '执行任务', status: 'running' as const, scheduleOccurrenceId: occurrence.id };
    const action = store.createAction(input);
    expect(store.createAction(input).id).toBe(action.id);
    store.request({ type: 'schedule.occurrence.update', id: occurrence.id, leaseToken: occurrence.leaseToken, actionId: action.id, status: 'running' });
    vi.setSystemTime(new Date(time).getTime() + 120000);
    expect(store.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
    store.request({ type: 'action.interrupt-pending' });
    const resumed = store.request({ type: 'schedule.due.claim' }).scheduleOccurrence!;
    expect(resumed.id).toBe(occurrence.id); expect(resumed.actionId).toBe(action.id);
    store.updateAction(action.id, { status: 'succeeded', result: '实际执行完成' });
    expect(store.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
    expect(store.request({ type: 'schedule.list', ...scope }).scheduleOccurrences?.[0]).toMatchObject({ id: occurrence.id, status: 'done', result: '实际执行完成' });
  });

  it('protects concurrent edits, records changed authorization and pauses or cancels future work', () => {
    const { store, scope } = fixture();
    const original = store.request({ type: 'schedule.create', ...scope, entries: [entry()] }).schedules![0]!;
    const updated = store.request({ type: 'schedule.update', ...scope, id: original.id, expectedRevision: 1, patch: { prompt: '改为提醒喝茶' } }).schedule!;
    expect(updated.sourceMessageId).not.toBe(original.sourceMessageId); expect(updated.authorizationSourceMessageIds).toEqual([original.sourceMessageId, updated.sourceMessageId]);
    expect(store.getMessage(updated.sourceMessageId).content).toContain('改为提醒喝茶');
    expect(() => store.request({ type: 'schedule.update', ...scope, id: updated.id, expectedRevision: 1, patch: { title: '过期编辑' } })).toThrow('已更新');
    const paused = store.request({ type: 'schedule.pause', ...scope, id: updated.id, expectedRevision: updated.revision, paused: true }).schedule!;
    expect(store.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
    const active = store.request({ type: 'schedule.pause', ...scope, id: updated.id, expectedRevision: paused.revision, paused: false }).schedule!;
    const claimed = store.request({ type: 'schedule.due.claim' }).scheduleOccurrence!;
    const cancelled = store.request({ type: 'schedule.cancel', ...scope, id: active.id, expectedRevision: store.request({ type: 'schedule.list', ...scope }).schedules![0]!.revision });
    expect(cancelled.scheduleOccurrences).toMatchObject([{ id: claimed.id, status: 'cancelled' }]);
    expect(store.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
  });
});

describe('sourced companion runtime state', () => {
  it('derives actual interaction counts and reply cost without gifting relationship for ordinary chatting', () => {
    const { store, scope } = fixture();
    const initial = store.request({ type: 'state.get', ...scope }).runtimeState!;
    const user = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '今天做什么？' });
    const reply = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '一起看看计划。' });
    store.request({ type: 'state.interaction', companionId: 'alice', messageId: user.id }); store.request({ type: 'state.interaction', companionId: 'alice', messageId: reply.id });
    const state = store.request({ type: 'state.get', ...scope }).runtimeState!;
    expect(state.familiarity.interactionCount).toBe(2); expect(state.energy).toBeCloseTo(initial.energy - 2, 4); expect(state.relationship).toEqual(initial.relationship);
  });

  it('validates exact evidence and commits an automatic state proposal with its leased extraction', () => {
    const { store, scope } = fixture(), message = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我支持你，也尊重你的选择。' });
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [], stateProposal: proposal(message, { evidence: [{ sourceMessageId: message.id, quote: '捏造来源' }] }) })).toThrow('原文');
    expect(store.request({ type: 'memory.status', ...scope }).memoryStatus?.running).toBe(1);
    store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [], stateProposal: proposal(message, { expression: 'playful', focus: '讨论选择', appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] }) });
    const state = store.request({ type: 'state.get', ...scope }).runtimeState!;
    expect(state.expression).toBe('playful'); expect(state.relationship.affinity).toBeGreaterThan(50);
    expect(store.request({ type: 'memory.status', ...scope }).memoryStatus?.completed).toBe(1);
    store.request({ type: 'state.update', ...scope, proposal: proposal(message, { appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] }) });
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.relationship).toEqual(state.relationship);
  });

  it('keeps an inspected authored revision valid while natural energy and affect clocks advance', () => {
    const { store, scope } = fixture(), message = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '谢谢你，我尊重你的选择。' });
    const inspected = store.request({ type: 'state.inspect', ...scope }).runtimeState!;
    vi.setSystemTime(new Date(time).getTime() + 5000);
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.revision).toBe(inspected.revision);
    const result = store.request({ type: 'state.update', ...scope, expectedRevision: inspected.revision, proposal: proposal(message, { appraisals: [{ type: 'respect', target: 'user', intensity: 1, confidence: 1 }] }) }).runtimeState!;
    expect(result.relationship.respect).toBeGreaterThan(inspected.relationship.respect);
    expect(result.revision).toBe(inspected.revision + 1);
    const newer = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '新一条真实互动。' });
    expect(() => store.request({ type: 'state.update', ...scope, expectedRevision: result.revision, proposal: proposal(newer) })).toThrow('已更新');
  });

  it('does not reserve low confidence evidence, and never rewards negation or penalizes quoted hostility', () => {
    const { store, scope } = fixture(), user = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我支持你。' });
    store.request({ type: 'state.update', ...scope, proposal: proposal(user, { appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 0.4 }] }) });
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.relationship.affinity).toBe(50);
    store.request({ type: 'state.update', ...scope, proposal: proposal(user, { appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] }) });
    const before = store.request({ type: 'state.get', ...scope }).runtimeState!.relationship;
    for (const [content, type] of [['我不支持你', 'support'], ['我不尊重你', 'respect'], ['不要说谢谢', 'respect'], ['不需要道歉', 'repair'], ['他说你是废物', 'hostility']] as const) {
      const message = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content });
      store.request({ type: 'state.update', ...scope, proposal: proposal(message, { appraisals: [{ type, target: 'user', intensity: 1, confidence: 1 }] }) });
    }
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.relationship).toEqual(before);
  });

  it('caps positive daily change, hides private state explanations from groups and withdraws forgotten effects', () => {
    const { store, scope } = fixture();
    const original = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我支持你，私人项目甲。' });
    store.request({ type: 'state.update', ...scope, proposal: proposal(original, { focus: '私人项目甲', reason: original.content, appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] }) });
    const influenced = store.request({ type: 'state.get', ...scope }).runtimeState!.relationship;
    const group = store.createConversation('群', ['alice']);
    const publicState = store.request({ type: 'state.get', companionId: 'alice', conversationId: group.id }).runtimeState!;
    expect(publicState.focus).not.toContain('私人'); expect(publicState.reason).not.toContain('私人'); expect(publicState.sourceMessageIds).toEqual([]); expect(publicState.familiarity.interactionCount).toBe(0);
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [original.id] });
    const withdrawn = store.request({ type: 'state.get', ...scope }).runtimeState!;
    expect(withdrawn.focus).toBeUndefined(); expect(withdrawn.relationship.affinity).toBeLessThan(influenced.affinity);
    for (let i = 0; i < 12; i++) { const message = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我支持你，谢谢。' + i }); store.request({ type: 'state.update', ...scope, proposal: proposal(message, { appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] }) }); }
    const state = store.request({ type: 'state.get', ...scope }).runtimeState!;
    expect(state.relationship.affinity + state.relationship.trust + state.relationship.respect - 150).toBeLessThanOrEqual(6.000001);
  });

  it('keeps newer state provenance out of a reply bounded to an earlier source', () => {
    const { store, scope } = fixture();
    const old = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '先讨论旧话题。' });
    const newer = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'NEW_PRIVATE_FOCUS_稍后才提出' });
    store.request({ type: 'state.update', ...scope, proposal: proposal(newer, { focus: newer.content, reason: newer.content }) });
    const earlierScope = { ...scope, beforeSequence: old.sequence };
    expect(JSON.stringify(store.request({ type: 'state.get', ...earlierScope }).runtimeState)).not.toContain('NEW_PRIVATE_FOCUS');
    expect(() => store.request({ type: 'state.update', ...earlierScope, proposal: proposal(newer) })).toThrow('可见');
    const late = store.request({ type: 'state.update', ...earlierScope, proposal: proposal(old) }).runtimeState!;
    expect(JSON.stringify(late)).not.toContain('NEW_PRIVATE_FOCUS');
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.focus).toBe(newer.content);
  });

  it('completes a leased state extraction harmlessly when its source is withdrawn mid-flight', () => {
    const { store, scope } = fixture(), source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我支持你，暂时的私密计划。' });
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id] });
    expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [],
      stateProposal: proposal(source, { focus: source.content, appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] }) })).not.toThrow();
    expect(store.request({ type: 'memory.status', ...scope }).memoryStatus?.completed).toBe(1);
    expect(store.request({ type: 'state.get', ...scope }).runtimeState).toMatchObject({ relationship: { affinity: 50, trust: 50, respect: 50 } });
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.focus).toBeUndefined();
  });

  it('charges actual task start once and never blames the user relationship for an execution failure', () => {
    const { store, scope } = fixture(), source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请执行检查。' });
    const action = store.createAction({ ...scope, sourceMessageId: source.id, title: '检查任务', status: 'running' });
    store.request({ type: 'state.action', actionId: action.id });
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.energy).toBe(88);
    store.updateAction(action.id, { status: 'failed', error: '实际程序报错' });
    expect(store.request({ type: 'state.get', ...scope }).runtimeState).toMatchObject({ energy: 88, relationship: { affinity: 50, trust: 50, respect: 50 } });
  });
});

describe('virtual routine scheduling and offline energy', () => {
  it('integrates offline awake consumption and sleep recovery from the same persisted clock', () => {
    const { store, scope, filename } = fixture();
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'Asia/Shanghai', sleepAt: '23:00', wakeAt: '07:00', meals: [] } });
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '检查任务' });
    for (let i = 0; i < 2; i++) { const action = store.createAction({ ...scope, sourceMessageId: source.id, title: '检查', status: 'running' }); store.updateAction(action.id, { status: 'succeeded', result: '完成' }); }
    expect(store.request({ type: 'state.get', ...scope }).runtimeState!.energy).toBe(76);
    store.request({ type: 'work.enqueue', work: { id: 'interrupted_offline', ...scope, sourceMessageId: source.id, proactive: false, status: 'queued', createdAt: source.createdAt, updatedAt: source.createdAt } });
    expect(store.request({ type: 'work.claim' }).work?.id).toBe('interrupted_offline');
    close(store);
    vi.setSystemTime('2026-10-14T16:00:00Z'); // Seven awake hours and one sleeping hour.
    const reopened = open(filename);
    reopened.request({ type: 'action.interrupt-pending' }); reopened.request({ type: 'work.interrupt-running' });
    const state = reopened.request({ type: 'state.get', ...scope }).runtimeState!;
    const plannedRecovery = 76 - 7 * 60 * 0.08 + 60 * 0.3;
    expect(state.energy).toBeLessThan(plannedRecovery); expect(state.energy).toBeGreaterThan(plannedRecovery - .1); // Walking to the bed earns no sleep recovery.
    expect(state.routine?.phase).toBe('sleeping');
  });

  it('keeps ordinary sleeping work queued, admits a real urgent source and returns to the clock phase', () => {
    const { store, scope } = fixture();
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'Asia/Shanghai', sleepAt: '23:00', wakeAt: '07:00', meals: [] } });
    vi.setSystemTime('2026-10-14T15:30:00Z');
    const ordinary = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '明天再说普通话题。' });
    const enqueue = (id: string, message: CompanionMessage, proactive = false) => store.request({ type: 'work.enqueue', work: { id, ...scope, sourceMessageId: message.id, proactive, status: 'queued', createdAt: message.createdAt, updatedAt: message.createdAt } });
    enqueue('ordinary', ordinary);
    expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
    const urgent = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '紧急，马上醒来帮我处理。' }); enqueue('urgent', urgent);
    recordUrgentAttention(store, 'alice', urgent);
    expect(store.request({ type: 'work.claim' }).work?.id).toBe('urgent');
    enqueue('proactive', urgent, true);
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.routine).toMatchObject({ phase: 'sleeping', canRespond: true });
    expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
    const followup = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '补充这件急事的具体要求。' }); enqueue('followup', followup);
    expect(store.request({ type: 'work.claim' }).work?.id).toBe('followup');
    store.request({ type: 'work.status', id: 'followup', status: 'done' });
    store.request({ type: 'work.status', id: 'urgent', status: 'done' });
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.routine?.phase).toBe('sleeping');
    vi.setSystemTime('2026-10-15T00:00:00Z');
    expect(store.request({ type: 'work.claim' }).work?.id).toBe('ordinary');
  });

  it('defers flexible tasks without consuming their period while a fixed commitment can wake', () => {
    const { store, scope } = fixture();
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'Asia/Shanghai', sleepAt: '23:00', wakeAt: '07:00', meals: [] } });
    vi.setSystemTime('2026-10-14T15:30:00Z');
    const runAt = new Date().toISOString();
    const ordinary = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '普通聊天稍后再处理。' });
    store.request({ type: 'work.enqueue', work: { id: 'sleeping_chat', ...scope, sourceMessageId: ordinary.id, proactive: false, status: 'queued', createdAt: ordinary.createdAt, updatedAt: ordinary.createdAt } });
    const flexible = store.request({ type: 'schedule.create', ...scope, entries: [entry({ title: '弹性检查', kind: 'task', flexible: true, runAt })] }).schedules![0]!;
    expect(store.request({ type: 'schedule.due.claim' }).scheduleOccurrence).toBeUndefined();
    const deferred = store.request({ type: 'schedule.list', ...scope }).schedules![0]!;
    expect(deferred.nextRunAt).toBe(flexible.nextRunAt); expect(deferred.deferredUntil).toBe('2026-10-14T23:00:00.000Z');
    store.request({ type: 'schedule.create', ...scope, entries: [entry({ title: '固定提醒', runAt })] });
    const fixed = store.request({ type: 'schedule.due.claim' });
    expect(fixed.schedule?.title).toBe('固定提醒'); expect(fixed.scheduleOccurrence).toBeDefined();
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.routine).toMatchObject({ phase: 'sleeping', canRespond: true });
    store.request({ type: 'world.work.begin', ...scope, workId: 'fixed_reminder', kind: 'schedule', sourceMessageId: fixed.schedule!.sourceMessageId, fixed: true });
    vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
    expect(store.request({ type: 'state.get', ...scope }).runtimeState?.routine?.phase).toBe('awake');
    expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
  });

  it('excludes observed long work from habit completion but does not invent work throughout a crash gap', () => {
    const { store, scope, filename } = fixture();
    const initial = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'Asia/Shanghai', meals: [],
      habits: [{ id: 'virtual-music', title: '听音乐', at: '16:45', durationMinutes: 15, kind: 'leisure' }] } });
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '先完成真实检查任务。' });
    store.request({ type: 'world.work.begin', ...scope, workId: 'long_check', kind: 'action', sourceMessageId: source.id });
    vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
    const action = store.createAction({ ...scope, sourceMessageId: source.id, title: '长期检查', status: 'running' });
    vi.setSystemTime('2026-10-14T09:10:00Z');
    expect(store.request({ type: 'routine.get', ...scope }).routine).toMatchObject({ runtime: { phase: 'awake' }, habitProgress: [{ id: 'virtual-music', completedCount: 0 }] });
    store.updateAction(action.id, { status: 'succeeded', result: '实际检查完成' });
    store.request({ type: 'world.work.end', companionId: 'alice', workId: 'long_check' });
    store.request({ type: 'world.work.begin', ...scope, workId: 'crash_check', kind: 'action', sourceMessageId: source.id });
    store.createAction({ ...scope, sourceMessageId: source.id, title: '退出前的新检查', status: 'running' });
    vi.setSystemTime('2026-10-14T09:15:00Z');
    store.request({ type: 'state.get', ...scope });
    close(store);
    vi.setSystemTime('2026-10-15T09:10:00Z');
    const reopened = open(filename); reopened.request({ type: 'action.interrupt-pending' }); reopened.request({ type: 'work.interrupt-running' });
    const progress = reopened.request({ type: 'routine.get', ...scope }).routine!.habitProgress[0]!;
    expect(progress).toMatchObject({ id: 'virtual-music', completedCount: 0, streak: 1 }); expect(progress.practicedMinutes).toBeGreaterThan(14); expect(progress.practicedMinutes).toBeLessThan(15);
  });
});
