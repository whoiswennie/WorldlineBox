import { createHash } from 'node:crypto';
import type { CompanionAgendaClaim, CompanionAgendaRule, CompanionAgendaRun } from '../../shared/companion-agenda';
import type { CompanionActivityTask } from '../../shared/companion-activity-task';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionAgendaExecutionContext, CompanionAgendaExecutionResult } from './agenda-service';
import type { CompanionActivityAgendaParent, CompanionActivityAgendaPhase } from './activity-task-service';
import { companionAgendaActivityPresentation } from '../../shared/companion-agenda-presentation';

interface Options { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>; now?(): Date }
const edition = (task: CompanionActivityTask) => String(task.agendaAttempt ?? 0);
const same = (left: CompanionActivityTask, right: CompanionActivityTask) => left.id === right.id && left.companionId === right.companionId
  && left.conversationId === right.conversationId && left.sourceMessageId === right.sourceMessageId && left.goal === right.goal
  && left.createdAt === right.createdAt && edition(left) === edition(right);
async function read(owner: string, id: string, options: Options) {
  const response = await options.request({ type: 'activity.agenda.get', companionId: owner, id });
  if (!response.ok || !response.activityTask || response.activityTask.id !== id || response.activityTask.companionId !== owner)
    throw new Error(response.error ?? '持续行动未返回准确本人记录。');
  return response.activityTask;
}
async function previousRule(task: CompanionActivityTask, options: Options): Promise<CompanionAgendaRule | undefined> {
  let afterId: string | undefined; const cursors = new Set<string>();
  for (;;) {
    const response = await options.request({ type: 'agenda.read', companionId: task.companionId, afterId, limit: 100 });
    if (!response.ok || !response.agenda) throw new Error(response.error ?? '原持续行动的正式安排暂不可核对。');
    const found = response.agenda.rules.find(rule => rule.companionId === task.companionId && rule.executor === 'activity'
      && rule.referenceId === task.id && rule.referenceVersion === edition(task) && rule.conversationId === task.conversationId);
    if (found) return found;
    if (!response.agenda.hasMore) return;
    afterId = response.agenda.nextId;
    if (!afterId || cursors.has(afterId)) throw new Error('原持续行动的日程分页未前进。');
    cursors.add(afterId);
  }
}
/** Reconciliation is a read of real native sources. No goal, result, action or
 * virtual arrival is fabricated, and a stopped attempt is never auto-revived. */
export async function reconcileCompanionAgendaActivity(options: Options & { companionId?: string; tasks?: readonly CompanionActivityTask[] }): Promise<CompanionAgendaRule[]> {
  const tasks: CompanionActivityTask[] = [...options.tasks ?? []];
  if (!options.tasks) {
    let afterId: string | undefined; const cursors = new Set<string>();
    for (;;) {
      const response = await options.request({ type: 'activity.agenda.pending', companionId: options.companionId, afterId, limit: 50 });
      if (!response.ok || !response.activityAgendaPage) throw new Error(response.error ?? '持续行动来源暂不可读取。');
      tasks.push(...response.activityAgendaPage.tasks); if (!response.activityAgendaPage.hasMore) break;
      afterId = response.activityAgendaPage.nextId;
      if (!afterId || cursors.has(afterId)) throw new Error('持续行动来源分页未前进，未遗漏或复制事件。');
      cursors.add(afterId);
    }
  }
  const rules: CompanionAgendaRule[] = [];
  for (const candidate of tasks) {
    if (candidate.historyAvailable === false || ['succeeded', 'failed', 'cancelled'].includes(candidate.status) && !candidate.reportPending) continue;
    const task = await read(candidate.companionId, candidate.id, options);
    if (!same(candidate, task) || task.historyAvailable === false) continue;
    const identity = createHash('sha256').update(JSON.stringify(['agenda-activity-v1', task.id, task.companionId, edition(task)])).digest('hex');
    const response = await options.request({ type: 'agenda.rule.create', companionId: task.companionId, operationId: 'agenda-activity-' + identity,
      authority: { kind: 'system', ...(task.sourceMessageId ? { sourceMessageId: task.sourceMessageId } : {}) },
      rule: { ...companionAgendaActivityPresentation(task), kind: 'world', executor: 'activity',
        trigger: { kind: 'at', at: task.createdAt, timeZone: 'UTC', repeat: 'once' },
        protected: true, flexible: false, conditions: [{ key: 'active', equals: true, label: '伙伴生活已继续' }],
        overlapPolicy: 'parallel', resourceKeys: ['activity:' + task.id], conversationId: task.conversationId, referenceId: task.id,
        referenceVersion: edition(task), reason: '原生持续行动按统一日程接续；规划、真实等待、记忆与报告均为同一事件的子过程。' } }).catch(async (error): Promise<CompanionStorageResponse> => {
      // A previous host version used generic display text under this same
      // immutable creation receipt. Reuse its exact attempt instead of
      // minting a second task merely to refresh a label.
      if (!(error instanceof Error) || !error.message.includes('AGENDA_CONFLICT: 操作标识已用于其他日程内容。')) throw error;
      const existing = await previousRule(task, options); if (!existing) throw error;
      return { ok: true, agendaRule: existing };
    });
    const rule = response.agendaRule;
    if (!response.ok || !rule || rule.companionId !== task.companionId || rule.executor !== 'activity' || rule.referenceId !== task.id
      || rule.referenceVersion !== edition(task) || rule.conversationId !== task.conversationId) throw new Error(response.error ?? '持续行动日程未返回匹配来源的正式凭据。');
    rules.push(rule);
  }
  return rules;
}
function settled(task: CompanionActivityTask): CompanionAgendaExecutionResult | undefined {
  if (task.historyAvailable === false) return { outcome: 'cancelled', stage: '原持续行动来源已撤回，旧目标与正文不再执行。' };
  if (task.reportPending || task.memoryIntentId) return undefined;
  if (task.status === 'succeeded') return { outcome: 'completed', stage: '原持续行动与必要的正式报告已经结束，真实回执保留。' };
  if (task.status === 'cancelled') return { outcome: 'cancelled', stage: '原持续行动已停止，已发生步骤与来源保留。' };
  if (task.status === 'failed') return { outcome: 'parked', stage: task.stage, nextCondition: '明确核对原生行动的停止原因' };
  return undefined;
}
export async function executeCompanionAgendaActivity(claim: CompanionAgendaClaim, context: CompanionAgendaExecutionContext, signal: AbortSignal,
  options: Options & { run(parent: CompanionActivityAgendaParent, signal: AbortSignal,
    onPhase?: (phase: CompanionActivityAgendaPhase, task: CompanionActivityTask) => Promise<void>): Promise<{ task: CompanionActivityTask; phase: CompanionActivityAgendaPhase }> }): Promise<CompanionAgendaExecutionResult> {
  const rule = claim.rule;
  if (rule.executor !== 'activity' || !rule.referenceId || !rule.conversationId) throw new Error('日程没有绑定准确原生持续行动。');
  const original = await read(rule.companionId, rule.referenceId, options);
  if (original.conversationId !== rule.conversationId || edition(original) !== rule.referenceVersion) return { outcome: 'cancelled', stage: '原持续行动已明确进入新的尝试，本次历史不再重放。' };
  const prior = settled(original); if (prior) return prior;
  signal.throwIfAborted();
  let failure: unknown, phase: CompanionActivityAgendaPhase = 'waiting';
  try {
    const result = await options.run({ companionId: rule.companionId, id: original.id, agendaRunId: claim.run.id, agendaLeaseToken: claim.leaseToken }, signal,
      async (next, task) => { if (!same(original, task)) throw new Error('持续行动子过程切换了原始来源。'); phase = next;
        await context.checkpoint(task.stage.trim().slice(0, 1000) || (next === 'report' ? '核对并发布原行动报告。' : next === 'memory' ? '接续本行动登记的记忆步骤。' : '接续原目标的一个实际行动步骤。'),
          { activityTaskId: task.id, phase: next, nativeStep: task.step, sourceMessageId: task.sourceMessageId }); });
    phase = result.phase;
  } catch (error) { failure = error; }
  signal.throwIfAborted();
  const actual = await read(rule.companionId, original.id, options);
  if (!same(original, actual)) return { outcome: 'unknown', stage: '持续行动来源或版本已变化，需要核对原始结果。' };
  await context.checkpoint(actual.stage, { activityTaskId: actual.id, phase, nativeStep: actual.step, status: actual.status,
    reportPending: !!actual.reportPending, memoryIntentId: actual.memoryIntentId });
  const disposition = settled(actual); if (disposition) return { ...disposition, ...(failure ? { error: failure instanceof Error ? failure.message : '原生行动未完成。' } : {}) };
  if (actual.status === 'running') return { outcome: 'unknown', stage: '原生行动仍有未核实的运行租约，未另起新执行。' };
  if (failure) return { outcome: 'failed', stage: '本次持续行动子过程未完成，原目标、提案与已有回执保留。', error: failure instanceof Error ? failure.message : '原生行动本次步骤未完成。' };
  const now = (options.now?.() ?? new Date()).getTime(), next = actual.nextAt && actual.nextAt > now ? actual.nextAt : now + 1500;
  return { outcome: 'waiting', stage: actual.stage, notBefore: new Date(next).toISOString(), nextCondition: 'activity.' + (actual.wait?.kind ?? phase),
    result: JSON.stringify({ activityTaskId: actual.id, nativeStep: actual.step, status: actual.status, reportPending: !!actual.reportPending }),
    ...(failure ? { error: failure instanceof Error ? failure.message : '原生行动本次步骤未完成。' } : {}) };
}

export async function restoreCompanionAgendaActivity(run: CompanionAgendaRun, options: Options): Promise<{ canResume: boolean; task?: CompanionActivityTask }> {
  const response = await options.request({ type: 'agenda.event.read', companionId: run.companionId, id: run.ruleId }), event = response.agendaEvent;
  if (!response.ok || !event || event.rule.executor !== 'activity' || !event.rule.referenceId) throw new Error(response.error ?? '持续行动的原日程不可核实。');
  const actual = event.runs.find(item => item.id === run.id);
  if (!actual || actual.revision !== run.revision || !['parked', 'waiting'].includes(actual.status)) throw new Error('持续行动父执行已变化，请重新核对。');
  const task = await read(run.companionId, event.rule.referenceId, options);
  if (task.conversationId !== event.rule.conversationId || edition(task) !== event.rule.referenceVersion || task.historyAvailable === false
    || ['cancelled', 'running'].includes(task.status) || task.agendaRunId && task.agendaRunId !== run.id) return { canResume: false, task };
  if (task.agendaRunId) {
    const restored = await options.request({ type: 'activity.agenda.restore', companionId: run.companionId, id: task.id, agendaRunId: run.id, expectedUpdatedAt: task.updatedAt });
    if (!restored.ok || !restored.activityTask || !same(task, restored.activityTask)) throw new Error(restored.error ?? '原持续行动没有返回准确恢复凭据。');
    return { canResume: true, task: restored.activityTask };
  }
  return { canResume: true, task };
}

export async function stopCompanionAgendaActivity(run: CompanionAgendaRun, action: 'pause' | 'abandon', options: Options & { cancel?(taskId: string): void }): Promise<void> {
  const response = await options.request({ type: 'agenda.event.read', companionId: run.companionId, id: run.ruleId }), rule = response.agendaEvent?.rule;
  if (!response.ok || rule?.executor !== 'activity' || !rule.referenceId) throw new Error(response.error ?? '持续行动的原父执行不可核实。');
  const task = await read(run.companionId, rule.referenceId, options);
  if (!task.agendaRunId) return;
  if (task.agendaRunId !== run.id || edition(task) !== rule.referenceVersion || !task.agendaLeaseToken) throw new Error('原持续行动已属于另一尝试，不控制它的执行。');
  options.cancel?.(task.id);
  const stopped = await options.request({ type: 'activity.agenda.release', companionId: task.companionId, id: task.id,
    agendaRunId: run.id, agendaLeaseToken: task.agendaLeaseToken, action });
  if (!stopped.ok) throw new Error(stopped.error ?? '持续行动没有确认停止，原记录保留。');
}
