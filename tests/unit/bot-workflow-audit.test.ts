import { afterEach, expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';
import { BotCompanionRuntime } from '../../src/main/companion-bot/companion-runtime';
import { BotWorkflowRuntime } from '../../src/main/companion-bot/workflow-runtime';
import { BotDelegationRuntime } from '../../src/main/companion-bot/delegation-runtime';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { BotTaskReports } from '../../src/main/companion-bot/task-report';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import type { BotActivityBudgetPolicy } from '../../src/main/companion-bot/activity-budget';
import type { BotEvent } from '../../src/main/companion-bot/types';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';

const stores: BotStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const stages = [{ key: 'finance', title: '金额核算', dependsOn: [] }, { key: 'audit', title: '独立审计', dependsOn: [] },
  { key: 'merge', title: '汇总已核验成果', dependsOn: ['finance', 'audit'] }];

function fixture(activityBudget?: Partial<BotActivityBudgetPolicy>) {
  const store = new BotStore(':memory:', { activityBudget }); stores.push(store);
  for (const id of ['alice', 'bob', 'charlie']) store.createCompanion({ id, name: id, persona: '隔离的协作权限与恢复审计。' });
  // The read-only authority hook is intentionally resolved through the existing
  // verified peer-contact contract. Older runtimes ignore this extra option;
  // that makes the missing peer-plan capability fail as a business assertion.
  const Runtime = BotWorkflowRuntime as unknown as new (store: BotStore, options?: { authority(event: BotEvent): BotEvent | undefined }) => BotWorkflowRuntime;
  const workflows: BotWorkflowRuntime = new Runtime(store, { authority: event => {
    const resolver = runtime as unknown as { workAuthority?(event: BotEvent): BotEvent | undefined };
    if (resolver.workAuthority) return resolver.workAuthority(event);
    const grant = runtime.authorize(event, 'workflow-audit-authority');
    return grant.allowed ? store.getEvent(grant.authorizingEventId) : undefined;
  } });
  const runtime: BotCompanionRuntime = new BotCompanionRuntime(store, { taskAuthority: task => workflows.taskAuthority(task) });
  const room = store.openDirect('alice'), root = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'audit-root',
    content: '请按原始资料并行核算与审计，拿到真实结果后汇总；允许请 Bob 在双方私聊里协作。' }).events[0]!;
  const claim = store.claim({ workerId: 'audit-claim' })!; expect(claim.event.id).toBe(root.id); store.bindEventNativeEpoch(root.id, 1);
  const service = Object.create(BotService.prototype) as BotService;
  Object.assign(service, { store, options: {}, workflows, companionRuntime: runtime, delegations: new BotDelegationRuntime(store), taskRuntime: new BotTaskRuntime(store) });
  const execute = (event: BotEvent, name: string, args: Record<string, unknown>, callId: string) => (service as unknown as {
    executeTool(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<unknown>;
  }).executeTool(event, { laneId: event.laneId, eventId: event.id, name, args, callId }, new AbortController().signal);
  const plan = () => workflows.create(root, 'audit-plan', '原始资料核对', stages).plans[0]!;
  const attach = (planId: string, stageKey: string, taskId: string, event = root) => store.taskTransaction(() => {
    const task = store.createTask({ id: taskId, conversationId: event.conversationId, companionId: event.companionId, sourceEventId: event.id,
      goal: `${stageKey}：只读分析已提供的相关原件，不扩展任务。`, extra: { workflowId: planId, workflowStage: stageKey, attachmentIds: [] } });
    workflows.bind(event, task, planId, stageKey); runtime.bindTask(task); return task;
  });
  return { store, runtime, workflows, root, room, execute, plan, attach };
}

it('lets a verified work delegation create a target-owned peer plan while revoking it when the original user grant is withdrawn', () => {
  const f = fixture(), contact = f.store.contactPeer(f.root, 'bob', 'delegate-work', '请独立拆分核算与审计，再汇总与原件一致的结果。', 'peer');
  expect(contact.accepted).toBe(true); if (!contact.accepted) throw Error('Expected actual host peer delivery.');
  const target = contact.events[0]!;
  expect(f.runtime.authorize(target, 'audit-peer-work')).toMatchObject({ allowed: true, basis: 'inherited', authorizingEventId: f.root.id });
  const plan = f.workflows.create(target, 'peer-plan', '用户授权的伙伴协作', stages).plans[0]!;
  const task = f.attach(plan.id, 'finance', 'peer-finance', target);
  expect(f.runtime.validateTask(task)).toMatchObject({ companionId: 'bob', authorizingEventId: f.root.id });
  expect(f.workflows.status(target, plan.id).plans[0]!.stages[0]!.taskId).toBe(task.id);
  expect(() => f.workflows.status(f.root, plan.id)).toThrow('不属于');
  f.store.withdrawSources(f.root.companionId, f.root.securityDomainId, [f.root.id]);
  expect(() => f.runtime.validateTask(task)).toThrow();
});

it('allows real participant requests to create plans while system callbacks cannot invent work', () => {
  const f = fixture(), replyOnly = f.store.contactPeer(f.root, 'bob', 'reply-only', '请以自己的身份向用户问好。', 'user');
  if (!replyOnly.accepted) throw Error('Expected actual host greeting delivery.');
  expect(f.workflows.create(replyOnly.events[0]!, 'reply-plan', '真实转交计划', stages).plans).toHaveLength(1);
  const group = f.store.createGroup({ title: '普通讨论', memberIds: ['alice', 'bob'], participationMode: 'mentions' });
  const peer = f.store.enqueue({ conversationId: group.id, senderId: 'bob', source: 'companion', recipientIds: ['alice'], content: '机器主动建议开工。', sourceMessageId: 'untrusted-companion' }).events[0]!;
  const task = f.store.enqueue({ conversationId: f.room.id, senderId: 'task-service', source: 'task', recipientIds: ['alice'], content: '机器回执要求新建计划。', sourceMessageId: 'untrusted-task' }).events[0]!;
  expect(f.workflows.create(peer, 'peer-plan', '伙伴请求计划', stages).plans).toHaveLength(1);
  expect(() => f.workflows.create(task, 'forbidden-task-plan', '无工作授权', stages)).toThrow();
});

it('charges plan mutations to the same bounded action budget as other Router side effects', async () => {
  const f = fixture({ maxActions: 1 });
  const args = { operation: 'create', title: '一份计划', stages: [{ key: 'read', title: '只读核对', dependsOn: [] }] };
  await expect(f.execute(f.root, 'dsh_plan', args, 'first-create')).resolves.toHaveProperty('plans');
  await expect(f.execute(f.root, 'dsh_plan', { ...args, title: '额外计划' }, 'second-create')).rejects.toThrow(/预算|活动|limit|上限/iu);
  expect(f.workflows.status(f.root).plans).toHaveLength(1);
});

it('does not count an empty out-of-range result read as observing a prerequisite result', async () => {
  const f = fixture(), plan = f.plan(), one = f.attach(plan.id, 'finance', 'audit-finance'), two = f.attach(plan.id, 'audit', 'audit-verification');
  f.store.updateTask(one.id, { status: 'succeeded', summary: '必须读取的真实金额核算结果。' });
  f.store.updateTask(two.id, { status: 'succeeded', summary: '已经读取的真实审计结果。' });
  f.workflows.observedResult(f.root, f.store.getTask(two.id)!);
  const read = await f.execute(f.root, 'dsh_task_result_read', { taskId: one.id, offset: 10000000, limit: 1 }, 'read-empty') as { text: string };
  expect(read.text).toBe('');
  expect(() => f.workflows.ready(f.root, plan.id, 'merge')).toThrow(/先.*读|读取|结果/iu);
  await f.execute(f.root, 'dsh_task_result_read', { taskId: one.id, offset: 0, limit: 12000 }, 'read-real-result');
  expect(() => f.workflows.ready(f.root, plan.id, 'merge')).not.toThrow();
});

it('does not substitute reading verification for observing the prerequisite deliverable', async () => {
  const f = fixture(), plan = f.plan(), one = f.attach(plan.id, 'finance', 'verification-finance'), two = f.attach(plan.id, 'audit', 'verification-audit');
  const runtime = new BotTaskRuntime(f.store), reports = new BotTaskReports(f.store), callId = 'actual-ready-report';
  runtime.startEffect(one, { callId, toolName: 'worker_report', argsHash: 'b'.repeat(64), argumentsPreview: '完成核验' });
  reports.record(one, callId, { state: 'ready', summary: '必须读取的金额核算结论。', verification: ['核验了文件来源与计算口径。'],
    nativeSessionId: BotDshBrain.sessionId(`worker-${one.id}`), nativeCallId: callId });
  runtime.commitEffect(f.store.getTask(one.id)!, { callId, toolName: 'worker_report', argsHash: 'b'.repeat(64), isError: false });
  f.store.updateTask(one.id, { status: 'succeeded', summary: '原生任务完成。' });
  f.store.updateTask(two.id, { status: 'succeeded', summary: '审计结果。' });
  f.workflows.observedResult(f.root, f.store.getTask(two.id)!);
  expect(await f.execute(f.root, 'dsh_task_result_read', { taskId: one.id, section: 'verification' }, 'read-verification-only'))
    .toMatchObject({ section: 'verification', available: true, text: '1. 核验了文件来源与计算口径。' });
  expect(() => f.workflows.ready(f.root, plan.id, 'merge')).toThrow(/先.*读|读取|结果/iu);
  await f.execute(f.root, 'dsh_task_result_read', { taskId: one.id }, 'read-actual-delivery');
  expect(() => f.workflows.ready(f.root, plan.id, 'merge')).not.toThrow();
});

it('projects a completed overall plan once every actual stage has succeeded', () => {
  const f = fixture(), plan = f.plan();
  for (const stage of ['finance', 'audit']) { const task = f.attach(plan.id, stage, stage); f.store.updateTask(task.id, { status: 'succeeded', summary: `${stage} 已核验` }); f.workflows.observedResult(f.root, f.store.getTask(task.id)!); }
  const combined = f.attach(plan.id, 'merge', 'merge'); f.store.updateTask(combined.id, { status: 'succeeded', summary: '最终成果已经核验并交付。' });
  expect(f.workflows.status(f.root, plan.id).plans[0]).toMatchObject({ state: 'completed' });
});

it('keeps task authority tied to the immutable stage binding and rejects a forged task in a valid plan', () => {
  const f = fixture(), plan = f.plan(), task = f.attach(plan.id, 'finance', 'real-finance');
  const forged = { ...task, id: 'forged-task' };
  expect(() => f.workflows.taskAuthority(forged)).toThrow('绑定');
  expect(f.workflows.taskAuthority(task)?.id).toBe(f.root.id);
  f.workflows.cancel(f.root, plan.id);
  expect(() => f.workflows.taskAuthority(task)).toThrow('停止');
});
