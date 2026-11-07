import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotCompanionRuntime } from '../../src/main/companion-bot/companion-runtime';
import { BotWorkflowRuntime } from '../../src/main/companion-bot/workflow-runtime';
import type { BotEvent } from '../../src/main/companion-bot/types';

const stores: BotStore[] = [], roots: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-workflow-')) throw Error('Unexpected fixture directory');
  await rm(root, { recursive: true, force: true });
} });
function fixture(filename = ':memory:') {
  const store = new BotStore(filename); stores.push(store);
  if (!store.getCompanion('alice')) store.createCompanion({ id: 'alice', name: 'Alice', persona: '本地协作验收' });
  const room = store.openDirect('alice'), workflows = new BotWorkflowRuntime(store), runtime = new BotCompanionRuntime(store, { taskAuthority: task => workflows.taskAuthority(task) });
  const source = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'source-' + stores.length, content: '并行核算与审计，再依照两边真实结果生成汇总文件。' }).events[0]!;
  const stages = [{ key: 'calculate', title: '核算', dependsOn: [] }, { key: 'audit', title: '审计', dependsOn: [] }, { key: 'combine', title: '汇总', dependsOn: ['calculate', 'audit'] }];
  const create = (callId = 'one') => workflows.create(source, callId, '真实资料核对', stages).plans[0]!;
  const attach = (planId: string, stageKey: string, id: string, event = source) => store.taskTransaction(() => {
    const task = store.createTask({ id, conversationId: room.id, companionId: 'alice', sourceEventId: event.id, goal: stageKey + '：只处理本阶段相关资料，不改原件。',
      extra: { workflowId: planId, workflowStage: stageKey, attachmentIds: [] } });
    workflows.bind(event, task, planId, stageKey); runtime.bindTask(task); return task;
  });
  const notice = (taskId: string, overrides: Partial<BotEvent> = {}) => {
    const event = store.enqueue({ conversationId: room.id, senderId: 'task-service', source: 'task', recipientIds: ['alice'], kind: 'task_done',
      sourceMessageId: 'done-' + taskId, content: '前置任务已完成', payload: { taskId }, correlationId: source.correlationId, causationId: source.id }).events[0]!;
    return { ...event, ...overrides };
  };
  return { store, room, workflows, runtime, source, stages, create, attach, notice };
}

it('allows independent stages and requires both real success and observed current results before the dependent stage', () => {
  const f = fixture(), plan = f.create(), one = f.attach(plan.id, 'calculate', 'one'), two = f.attach(plan.id, 'audit', 'two');
  expect(() => f.workflows.ready(f.source, plan.id, 'combine')).toThrow('尚未成功');
  f.store.updateTask(one.id, { status: 'succeeded', summary: '核算207元' }); f.store.updateTask(two.id, { status: 'succeeded', summary: '审计通过' });
  expect(() => f.workflows.ready(f.source, plan.id, 'combine')).toThrow('先用status');
  f.workflows.observedResult(f.source, f.store.getTask(one.id)!); f.workflows.observedResult(f.source, f.store.getTask(two.id)!);
  const notice = f.notice(two.id);
  expect(f.runtime.authorize(notice, 'unqualified-new-task')).toMatchObject({ allowed: false });
  const combined = f.attach(plan.id, 'combine', 'three', notice);
  expect(f.runtime.validateTask(combined)).toMatchObject({ basis: 'inherited', authorizingEventId: f.source.id });
  expect(f.workflows.status(f.source, plan.id).plans[0]!.stages.map(stage => stage.taskId)).toEqual(['one', 'two', 'three']);
  expect(() => f.attach(plan.id, 'combine', 'duplicate', notice)).toThrow('不能重复派发'); expect(f.store.getTask('duplicate')).toBeUndefined();
});

it.each(['queued', 'running', 'waiting', 'paused', 'failed', 'cancelled', 'unknown'] as const)('never treats a %s prerequisite as complete', status => {
  const f = fixture(), plan = f.create(), one = f.attach(plan.id, 'calculate', 'one');
  f.store.updateTask(one.id, { status });
  expect(() => f.workflows.ready(f.source, plan.id, 'combine')).toThrow('尚未成功');
});

it('invalidates stale result receipts and rejects a removed or human-stopped prerequisite', () => {
  const f = fixture(), plan = f.create();
  for (const stage of ['calculate', 'audit']) { const task = f.attach(plan.id, stage, stage); f.store.updateTask(task.id, { status: 'succeeded', summary: '旧结果' }); f.workflows.observedResult(f.source, f.store.getTask(task.id)!); }
  f.store.updateTask('calculate', { summary: '已纠正的新结果' }); expect(() => f.workflows.ready(f.source, plan.id, 'combine')).toThrow('先用status');
  f.workflows.observedResult(f.source, f.store.getTask('calculate')!); expect(() => f.workflows.ready(f.source, plan.id, 'combine')).not.toThrow();
  f.store.updateTask('calculate', { extra: { ...f.store.getTask('calculate')!.extra, humanStopped: true } }); expect(() => f.workflows.ready(f.source, plan.id, 'combine')).toThrow('尚未成功');
});

it('rejects cyclic, unknown, duplicate or oversized stage graphs', () => {
  const f = fixture();
  for (const [label, stages] of [
    ['cycle', [{ key: 'a', title: 'A', dependsOn: ['b'] }, { key: 'b', title: 'B', dependsOn: ['a'] }]],
    ['missing', [{ key: 'a', title: 'A', dependsOn: ['missing'] }]],
    ['duplicate', [f.stages[0], f.stages[0]]], ['oversized', Array.from({ length: 9 }, (_, index) => ({ key: String(index), title: '阶段', dependsOn: [] }))],
  ] as const) expect(() => f.workflows.create(f.source, label, '非法计划', stages)).toThrow();
});

it('keeps scopes and ordinary notifications isolated and never converts a task receipt into a new plan', () => {
  const f = fixture(), plan = f.create(), task = f.attach(plan.id, 'calculate', 'one'), notice = f.notice(task.id);
  expect(() => f.workflows.create(notice, 'new-plan', '未经用户请求', f.stages)).toThrow('用户明确委派');
  expect(() => f.workflows.ready({ ...notice, source: 'companion' }, plan.id, 'audit')).toThrow('不能推进');
  expect(() => f.workflows.ready({ ...notice, payload: { taskId: 'other-task' } }, plan.id, 'audit')).toThrow('不能推进');
  expect(() => f.workflows.status({ ...f.source, companionId: 'other' }, plan.id)).toThrow('不属于');
  expect(() => f.workflows.status({ ...f.source, conversationId: 'other-room' }, plan.id)).toThrow('不属于');
  f.store.withdrawSources(f.source.companionId, f.source.securityDomainId, [f.source.sourceMessageRecordId]);
  expect(() => f.workflows.ready(notice, plan.id, 'audit')).toThrow('授权已失效'); expect(() => f.runtime.validateTask(task)).toThrow();
  expect(f.workflows.status(f.source, plan.id).plans[0]).toMatchObject({ title: '', state: 'unavailable', stages: [] });
});

it('persists the plan, stage bindings and observed results across a real SQLite reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-workflow-')); roots.push(root); const filename = path.join(root, 'bot.sqlite');
  const f = fixture(filename), plan = f.create();
  for (const stage of ['calculate', 'audit']) { const task = f.attach(plan.id, stage, stage); f.store.updateTask(task.id, { status: 'succeeded', summary: stage + '真实结果' }); f.workflows.observedResult(f.source, f.store.getTask(task.id)!); }
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const next = fixture(filename); expect(() => next.workflows.ready(next.source, plan.id, 'combine')).not.toThrow();
  expect(next.workflows.status(next.source, plan.id).plans[0]!.stages.filter(stage => stage.status === 'succeeded')).toHaveLength(2);
});

it('makes create idempotent and keeps a cancelled plan closed to late notices and scope cancellation', () => {
  const f = fixture(), plan = f.create(), task = f.attach(plan.id, 'calculate', 'one');
  expect(f.create().id).toBe(plan.id); expect(f.workflows.status(f.source).plans).toHaveLength(1);
  expect(f.workflows.cancel(f.source, plan.id)).toEqual([task.id]);
  expect(() => f.workflows.ready(f.notice(task.id), plan.id, 'audit')).toThrow('停止');
  const other = f.create('two'); f.workflows.cancelScope(f.room.id, 'another'); expect(f.workflows.status(f.source, other.id).plans[0]!.state).toBe('active');
  f.workflows.cancelScope(f.room.id, 'alice'); expect(f.workflows.status(f.source).plans.every(plan => plan.state === 'cancelled')).toBe(true);
});

it('pages large plan catalogs without exposing unrelated scopes', () => {
  const f = fixture(); for (let index = 0; index < 12; index++) f.create(String(index));
  const first = f.workflows.status(f.source), next = f.workflows.status(f.source, undefined, first.nextOffset);
  expect(first.plans).toHaveLength(10); expect(next.plans).toHaveLength(2); expect(next).not.toHaveProperty('nextOffset');
  expect(f.workflows.status({ ...f.source, conversationId: 'another-room' }).plans).toEqual([]);
});

it('keeps exact durable command receipts across a lost outer callback and refuses changed replay arguments', () => {
  const f = fixture(), plan = f.create();
  const args = { operation: 'create', title: '真实资料核对', stages: f.stages };
  expect(f.workflows.receipt(f.source, 'one', args)).toEqual({ state: 'committed', planId: plan.id });
  expect(f.workflows.receipt(f.source, 'never-invoked', args)).toEqual({ state: 'absent' });
  expect(() => f.workflows.receipt(f.source, 'one', { ...args, title: '另一个目标' })).toThrow('回执参数');
  f.workflows.cancel(f.source, plan.id, 'cancel-once');
  expect(f.workflows.receipt(f.source, 'cancel-once', { operation: 'cancel', planId: plan.id })).toEqual({ state: 'committed', planId: plan.id });
});

it('permits bounded original-stage corrections only inside an unfinished plan, never across plans or after final dispatch', () => {
  const f = fixture(), plan = f.create(), one = f.attach(plan.id, 'calculate', 'one'), two = f.attach(plan.id, 'audit', 'two');
  const notice = f.notice(two.id);
  expect(f.workflows.canCoordinate(notice, one)).toBe(true);
  const other = f.create('other'), foreign = f.attach(other.id, 'calculate', 'foreign');
  expect(f.workflows.canCoordinate(notice, foreign)).toBe(false);
  f.workflows.rework(notice, one, 'correction-1'); f.workflows.rework(notice, one, 'correction-1');
  f.workflows.rework(notice, one, 'correction-2'); expect(() => f.workflows.rework(notice, one, 'correction-3')).toThrow('返工上限');
  for (const task of [one, two]) { f.store.updateTask(task.id, { status: 'succeeded', summary: '真实核对结果' }); f.workflows.observedResult(f.source, f.store.getTask(task.id)!); }
  f.attach(plan.id, 'combine', 'final', notice);
  expect(() => f.workflows.rework(notice, two, 'late-correction')).toThrow('仍待汇总');
  f.workflows.cancel(f.source, plan.id); expect(f.workflows.canCoordinate(notice, one)).toBe(false);
});
