import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BotStore } from './store';
import type { BotEvent, BotTask } from './types';
import { isBotParticipantRequest } from './participant-request';

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
export const botWorkflowStages = z.array(z.strictObject({ key, title: z.string().trim().min(1).max(120), dependsOn: z.array(key).max(8).default([]) })).min(1).max(8);
type Stage = z.infer<typeof botWorkflowStages>[number] & { taskId?: string; revisions?: number };
interface Plan { id: string; companionId: string; conversationId: string; sourceEventId: string; authorizingEventId?: string; title: string; state: 'active' | 'cancelled'; stages: Stage[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const resultDigest = (task: BotTask) => hash([task.id, task.status, task.summary, task.error]);

/** Bounded, durable routing DAG. It does not execute, poll or author worker
 * instructions. Only the Router dispatches a stage after reading its inputs. */
export class BotWorkflowRuntime {
  constructor(private readonly store: BotStore, private readonly options: { authority?(event: BotEvent): BotEvent | undefined } = {}) {
    store.taskTransaction(sql => {
      sql.prepare(`CREATE TABLE IF NOT EXISTS bot_workflows(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,record_json TEXT NOT NULL)`).run();
      sql.prepare('CREATE INDEX IF NOT EXISTS bot_workflows_scope ON bot_workflows(companion_id,conversation_id,id)').run();
      sql.prepare('CREATE TABLE IF NOT EXISTS bot_workflow_reads(plan_id TEXT NOT NULL,task_id TEXT NOT NULL,result_digest TEXT NOT NULL,PRIMARY KEY(plan_id,task_id))').run();
    });
  }
  private get(id: string): Plan {
    const value = this.store.taskTransaction(sql => sql.prepare('SELECT record_json FROM bot_workflows WHERE id=?').get(id)) as { record_json: string } | undefined;
    if (!value) throw Error('协作计划不存在。'); return JSON.parse(value.record_json) as Plan;
  }
  private save(plan: Plan): void {
    this.store.taskTransaction(sql => sql.prepare('INSERT INTO bot_workflows VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json')
      .run(plan.id, plan.companionId, plan.conversationId, JSON.stringify(plan)));
  }
  private commandFingerprint(args: Record<string, unknown>): string {
    return args.operation === 'create' ? hash(['create', z.string().trim().min(1).max(120).parse(args.title), botWorkflowStages.parse(args.stages)])
      : hash(['cancel', z.string().min(1).max(200).parse(args.planId)]);
  }
  private recordCommand(event: BotEvent, callId: string, planId: string, args: Record<string, unknown>): void {
    const key = `workflow-command:${event.id}:${callId}`, fingerprint = this.commandFingerprint(args), saved = this.store.getMetadata(key);
    if (saved && JSON.parse(saved).fingerprint !== fingerprint) throw Error('协作操作回执参数不匹配。');
    this.store.setMetadata(key, JSON.stringify({ planId, fingerprint }));
  }
  receipt(event: BotEvent, callId: string, args: Record<string, unknown>): { state: 'absent' } | { state: 'committed'; planId: string } {
    const saved = this.store.getMetadata(`workflow-command:${event.id}:${callId}`); if (!saved) return { state: 'absent' };
    const receipt = JSON.parse(saved) as { planId: string; fingerprint: string };
    if (receipt.fingerprint !== this.commandFingerprint(args)) throw Error('协作操作回执参数不匹配。');
    this.scoped(event, receipt.planId); return { state: 'committed', planId: receipt.planId };
  }
  private root(plan: Plan): BotEvent {
    const event = this.store.getEvent(plan.sourceEventId), room = this.store.getConversation(plan.conversationId);
    if (plan.state !== 'active' || !event
      || event.companionId !== plan.companionId || event.conversationId !== plan.conversationId || event.status === 'cancelled'
      || !room || room.dissolvedAt || room.revision !== event.aclRevision || !room.memberIds.includes(plan.companionId)
      || this.store.withdrawnIn(plan.companionId, event.securityDomainId, [event.id, event.sourceMessageRecordId, ...this.store.eventSourceIds(event.id)]).size) throw Error('协作计划的原始用户授权已失效或停止。');
    const authority = this.options.authority?.(event) ?? (event.source === 'user' && event.senderId === 'user' && event.senderType === 'user' ? event : undefined);
    if (!authority || plan.authorizingEventId && authority.id !== plan.authorizingEventId) throw Error('协作计划没有可核实的原始用户授权。');
    return authority;
  }
  private scoped(event: BotEvent, id: string): Plan {
    const plan = this.get(id);
    if (plan.companionId !== event.companionId || plan.conversationId !== event.conversationId) throw Error('协作计划不属于当前伙伴和聊天。');
    return plan;
  }
  create(event: BotEvent, callId: string, title: string, input: unknown) {
    if (event.source === 'task' || !this.options.authority?.(event) && !(event.source === 'user' && event.senderId === 'user')) throw Error('新协作计划需要当前用户明确委派，任务通知不能自行创建计划。');
    const stages = botWorkflowStages.parse(input), keys = new Set(stages.map(stage => stage.key));
    if (keys.size !== stages.length) throw Error('协作阶段标识不可重复。');
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (stageKey: string) => {
      if (visiting.has(stageKey)) throw Error('协作阶段依赖不能形成循环。'); if (visited.has(stageKey)) return;
      const stage = stages.find(stage => stage.key === stageKey); if (!stage) throw Error('协作阶段引用了不存在的前置阶段。');
      visiting.add(stageKey); for (const dependency of stage.dependsOn) visit(dependency); visiting.delete(stageKey); visited.add(stageKey);
    };
    for (const stage of stages) visit(stage.key);
    const id = 'plan-' + hash([event.id, callId]).slice(0, 40), plan: Plan = { id, companionId: event.companionId, conversationId: event.conversationId, sourceEventId: event.id,
      authorizingEventId: (this.options.authority?.(event) ?? event).id, title: z.string().trim().min(1).max(120).parse(title), state: 'active', stages };
    this.root(plan);
    return this.store.taskTransaction(sql => {
      const old = sql.prepare('SELECT record_json FROM bot_workflows WHERE id=?').get(id) as { record_json: string } | undefined;
      if (old) {
        const previous = JSON.parse(old.record_json) as Plan;
        if (previous.title !== plan.title || hash(previous.stages.map(({ key, title, dependsOn }) => ({ key, title, dependsOn }))) !== hash(stages)) throw Error('协作调用标识不能用于不同计划。');
      } else this.save(plan);
      this.recordCommand(event, callId, id, { operation: 'create', title, stages });
      return this.status(event, id);
    });
  }
  /** A task notice is not new authority. The exact stage binding below is the
   * only way a bounded continuation can reuse its original human mandate. */
  ready(event: BotEvent, planId: string, stageKey: string): void {
    const plan = this.scoped(event, planId), root = this.root(plan), stage = plan.stages.find(stage => stage.key === stageKey);
    if (!stage) throw Error('协作阶段不存在。');
    if (!isBotParticipantRequest(event, this.store.getConversation(event.conversationId)!) && event.id !== plan.sourceEventId) {
      const parent = plan.stages.find(value => value.taskId === event.payload.taskId);
      if (event.source !== 'task' || !parent || event.correlationId !== root.correlationId) throw Error('该通知不能推进此协作计划。');
    }
    for (const dependency of stage.dependsOn) {
      const prior = plan.stages.find(value => value.key === dependency), task = prior?.taskId ? this.store.getTask(prior.taskId) : undefined;
      if (!task || task.status !== 'succeeded' || task.extra.humanStopped || task.extra.removedAt || this.store.taskSourcesWithdrawn(task.id)) throw Error('前置阶段尚未成功完成，不能派发依赖任务：' + dependency);
      const receipt = this.store.taskTransaction(sql => sql.prepare('SELECT result_digest FROM bot_workflow_reads WHERE plan_id=? AND task_id=?').get(planId, task.id)) as { result_digest: string } | undefined;
      if (receipt?.result_digest !== resultDigest(task)) throw Error('请先用status或dsh_task_result_read读取前置任务的当前结果：' + task.id);
    }
  }
  /** Require an explicit artifact handoff from every file-producing prerequisite.
   * The Router still chooses the files; this gate never adds another task's
   * output, scans a directory or substitutes a pasted summary for a real file. */
  requireDependencyArtifacts(event: BotEvent, planId: string, stageKey: string, attachmentIds: string[]): void {
    const selected = new Set(z.array(z.string().min(1).max(160)).max(64).parse(attachmentIds));
    this.ready(event, planId, stageKey);
    const plan = this.scoped(event, planId), stage = plan.stages.find(value => value.key === stageKey)!;
    for (const dependency of stage.dependsOn) {
      const taskId = plan.stages.find(value => value.key === dependency)!.taskId!;
      const outputs = this.store.publicationsForTask(taskId), candidates = outputs.flatMap(output => output.attachmentIds);
      if (candidates.length && !candidates.some(id => selected.has(id))) throw Error(`前置任务 ${taskId} 已产生真实文件；请明确选择至少一个该任务产物附件，不能只把摘要抄进目标。可选 outputs：${JSON.stringify(outputs)}`);
    }
  }
  receivedNotice(event: BotEvent): void {
    if (event.source !== 'task' || event.kind !== 'task_done' || typeof event.payload.taskId !== 'string') return;
    const task = this.store.getTask(event.payload.taskId);
    if (!task || event.causationId !== task.sourceEventId || event.payload.attemptId !== task.attemptId
      || !event.sourceMessageId.startsWith(`task-result:${task.id}:${task.attemptId}`)) return;
    this.observedResult(event, task);
  }
  bind(event: BotEvent, task: BotTask, planId: string, stageKey: string): void {
    this.ready(event, planId, stageKey);
    const plan = this.scoped(event, planId), stage = plan.stages.find(stage => stage.key === stageKey)!;
    if (stage.taskId && stage.taskId !== task.id) throw Error('该协作阶段已绑定任务，不能重复派发；请管理原任务。');
    stage.taskId = task.id; this.save(plan);
  }
  taskAuthority(task: BotTask): BotEvent | undefined {
    if (typeof task.extra.workflowId !== 'string' || typeof task.extra.workflowStage !== 'string') return;
    const plan = this.get(task.extra.workflowId), stage = plan.stages.find(stage => stage.key === task.extra.workflowStage);
    if (plan.companionId !== task.companionId || plan.conversationId !== task.conversationId || stage?.taskId !== task.id) throw Error('协作任务缺少匹配的耐久阶段绑定。');
    return this.root(plan);
  }
  canCoordinate(event: BotEvent, task: BotTask): boolean {
    if (event.source !== 'task' || typeof task.extra.workflowId !== 'string') return false;
    try {
      const plan = this.scoped(event, task.extra.workflowId), root = this.taskAuthority(task);
      return !!root && event.correlationId === root.correlationId && plan.stages.some(stage => stage.taskId === event.payload.taskId);
    } catch { return false; }
  }
  /** Corrections stay on the original Session. A finished graph cannot wake
   * itself, and each prerequisite has at most two automatic correction passes. */
  rework(event: BotEvent, task: BotTask, requestId: string): void {
    if (!this.canCoordinate(event, task)) throw Error('当前通知没有此协作阶段的返工授权。');
    const plan = this.scoped(event, String(task.extra.workflowId)), stage = plan.stages.find(stage => stage.taskId === task.id)!;
    if (!plan.stages.some(next => next.dependsOn.includes(stage.key) && !next.taskId)) throw Error('只有仍待汇总的前置阶段可以自动返工。');
    this.store.taskTransaction(() => {
      const key = `workflow-rework:${plan.id}:${task.id}:${requestId}`; if (this.store.getMetadata(key)) return;
      if ((stage.revisions ?? 0) >= 2) throw Error('该阶段已达到自动返工上限，请向用户说明差异，不能无限互相唤醒。');
      stage.revisions = (stage.revisions ?? 0) + 1; this.save(plan); this.store.setMetadata(key, 'accepted');
    });
  }
  observedResult(event: BotEvent, task: BotTask): void {
    if (task.status !== 'succeeded' || task.companionId !== event.companionId || task.conversationId !== event.conversationId || typeof task.extra.workflowId !== 'string') return;
    if (this.scoped(event, task.extra.workflowId).state !== 'active') return;
    this.taskAuthority(task);
    this.store.taskTransaction(sql => sql.prepare('INSERT INTO bot_workflow_reads VALUES(?,?,?) ON CONFLICT(plan_id,task_id) DO UPDATE SET result_digest=excluded.result_digest')
      .run(task.extra.workflowId, task.id, resultDigest(task)));
  }
  status(event: BotEvent, id?: string, offset = 0) {
    const plans = id ? [this.scoped(event, id)] : this.store.taskTransaction(sql => (sql.prepare('SELECT record_json FROM bot_workflows WHERE companion_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 11 OFFSET ?')
      .all(event.companionId, event.conversationId, offset) as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json) as Plan));
    return { plans: plans.slice(0, 10).map(plan => {
      const source = this.store.getEvent(plan.sourceEventId);
      const withdrawn = !source || this.store.withdrawnIn(plan.companionId, source.securityDomainId, [source.id, source.sourceMessageRecordId, ...this.store.eventSourceIds(source.id)]).size > 0;
      const statuses = plan.stages.map(stage => stage.taskId ? this.store.getTask(stage.taskId)?.status : 'planned');
      const state = statuses.every(status => status === 'succeeded') ? 'completed' : statuses.some(status => status === 'failed' || status === 'cancelled') ? 'blocked'
        : statuses.some(status => status === 'paused') ? 'paused' : 'active';
      return { id: plan.id, title: withdrawn ? '' : plan.title, state: withdrawn ? 'unavailable' : plan.state === 'cancelled' ? 'cancelled' : state, stages: withdrawn ? [] : plan.stages.map(stage => {
      const task = stage.taskId ? this.store.getTask(stage.taskId) : undefined;
      return { ...stage, status: task?.extra.removedAt ? 'removed' : task?.status ?? 'planned' };
    }) }; }), ...(plans.length > 10 ? { nextOffset: offset + 10 } : {}) };
  }
  cancel(event: BotEvent, id: string, callId?: string): string[] {
    if (!isBotParticipantRequest(event, this.store.getConversation(event.conversationId)!)) throw Error('停止整个协作计划需要用户或伙伴请求。');
    const plan = this.scoped(event, id);
    this.store.taskTransaction(() => { plan.state = 'cancelled'; this.save(plan); if (callId) this.recordCommand(event, callId, id, { operation: 'cancel', planId: id }); });
    return plan.stages.flatMap(stage => stage.taskId ? [stage.taskId] : []);
  }
  cancelScope(conversationId: string, companionId?: string): void {
    this.store.taskTransaction(sql => {
      const rows = sql.prepare(`SELECT record_json FROM bot_workflows WHERE conversation_id=?${companionId ? ' AND companion_id=?' : ''}`).all(conversationId, ...(companionId ? [companionId] : [])) as Array<{ record_json: string }>;
      for (const row of rows) { const plan = JSON.parse(row.record_json) as Plan; if (plan.state === 'active') { plan.state = 'cancelled'; this.save(plan); } }
    });
  }
}
