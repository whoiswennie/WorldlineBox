import { createHash } from 'node:crypto';
import { companionAgendaRuleDraftSchema, type CompanionAgendaClaim, type CompanionAgendaRule, type CompanionAgendaRun } from '../../shared/companion-agenda';
import type { CompanionWork } from '../../shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionAgendaExecutionContext, CompanionAgendaExecutionResult } from './agenda-service';

interface Options { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>; now?(): Date }
const identity = (work: CompanionWork) => createHash('sha256').update(JSON.stringify(['agenda-chat-v1', work.companionId, work.id, work.agendaAttempt ?? 0])).digest('hex');
const sameWork = (a: CompanionWork, b: CompanionWork) => a.id === b.id && a.companionId === b.companionId && a.conversationId === b.conversationId
  && a.sourceMessageId === b.sourceMessageId && a.createdAt === b.createdAt && (a.agendaAttempt ?? 0) === (b.agendaAttempt ?? 0);
async function read(work: Pick<CompanionWork, 'companionId' | 'id'>, options: Options): Promise<CompanionWork | undefined> {
  const response = await options.request({ type: 'work.get', companionId: work.companionId, id: work.id });
  if (!response.ok) throw new Error(response.error ?? '原聊天队列暂不可读取。');
  if (response.work && (response.work.id !== work.id || response.work.companionId !== work.companionId)) throw new Error('聊天回执不属于当前伙伴与真实任务。');
  return response.work;
}

/** Explicit queue reconciliation, never a model call. Only queued native work
 * becomes an agenda event. Repeated scans do not resume interrupted work, and
 * an explicit native retry receives a new immutable attempt, preserving history. */
export async function reconcileCompanionAgendaChat(options: Options & { works?: readonly CompanionWork[] }): Promise<CompanionAgendaRule[]> {
  let works = options.works;
  if (!works) {
    const response = await options.request({ type: 'work.list', unfinishedOnly: true });
    if (!response.ok) throw new Error(response.error ?? '聊天队列暂不可读取。');
    works = response.works ?? [];
  }
  const rules: CompanionAgendaRule[] = [];
  for (const candidate of works) {
    if (candidate.status !== 'queued') continue;
    const work = await read(candidate, options);
    if (!work || work.status !== 'queued' || !sameWork(candidate, work)) continue;
    const rule = companionAgendaRuleDraftSchema.parse({ title: work.proactive ? '继续主动交流' : '回应收到的消息',
      intent: '处理此日程绑定的真实聊天队列与原始循环；保留来源核对、引导消息、工具回执和正式回复流程。',
      kind: 'chat', executor: 'chat', trigger: { kind: 'at', at: new Date(work.createdAt).toISOString(), timeZone: 'UTC', repeat: 'once' },
      conditions: [{ key: 'active', equals: true, label: '伙伴已激活' }], protected: true, flexible: false,
      overlapPolicy: 'parallel', resourceKeys: ['chat:' + work.id], reason: '真实消息入队后由统一日程安排；原循环及其工具子过程只占一份并发。',
      conversationId: work.conversationId, referenceId: work.id, referenceVersion: String(work.agendaAttempt ?? 0) });
    const response = await options.request({ type: 'agenda.rule.create', companionId: work.companionId,
      operationId: 'agenda-chat-' + identity(work), authority: { kind: 'system', sourceMessageId: work.sourceMessageId }, rule });
    const saved = response.agendaRule;
    if (!response.ok || !saved || saved.companionId !== work.companionId || saved.executor !== 'chat' || saved.referenceId !== work.id
      || saved.referenceVersion !== rule.referenceVersion || saved.conversationId !== work.conversationId)
      throw new Error(response.error ?? '聊天日程未返回匹配原始队列与版本的凭据。');
    rules.push(saved);
  }
  return rules;
}

/** Human resume of a paused batch keeps the same native attempt. A cancelled
 * or uncertain original is not resurrected; ordinary reply.retry creates its
 * next attempt through the existing explicit queue recovery path. */
export async function restoreCompanionAgendaChat(run: CompanionAgendaRun, options: Options): Promise<{ canResume: boolean; work?: CompanionWork }> {
  const response = await options.request({ type: 'agenda.event.read', companionId: run.companionId, id: run.ruleId });
  const event = response.agendaEvent;
  if (!response.ok || !event || event.rule.executor !== 'chat' || !event.rule.referenceId || event.rule.companionId !== run.companionId)
    throw new Error(response.error ?? '原聊天日程尚不可核实。');
  const actual = event.runs.find(item => item.id === run.id);
  if (!actual || actual.revision !== run.revision || !['parked', 'waiting'].includes(actual.status)) throw new Error('原聊天日程已变化，请重新读取。');
  const work = await read({ companionId: run.companionId, id: event.rule.referenceId }, options);
  if (!work || work.agendaRunId !== run.id || event.rule.referenceVersion !== String(work.agendaAttempt ?? 0)
    || work.conversationId !== event.rule.conversationId || work.status === 'cancelled') return { canResume: false, work };
  if (work.status === 'queued' || work.status === 'done') return { canResume: true, work };
  if (work.status !== 'interrupted') return { canResume: false, work };
  const restored = await options.request({ type: 'work.agenda.restore', companionId: run.companionId, id: work.id,
    agendaRunId: run.id, expectedUpdatedAt: work.updatedAt });
  if (!restored.ok || !restored.work || !sameWork(work, restored.work) || restored.work.status !== 'queued' || restored.work.agendaRunId !== run.id)
    throw new Error(restored.error ?? '原聊天恢复没有返回匹配的原始版本。');
  return { canResume: true, work: restored.work };
}

function disposition(work: CompanionWork, error?: unknown): CompanionAgendaExecutionResult | undefined {
  if (work.status === 'done') return { outcome: 'completed', stage: '这次交流已完成，正式回复和工具回执保存在原聊天。' };
  if (work.status === 'cancelled') return { outcome: 'cancelled', stage: '原聊天任务已经停止，保留消息与已有结果。' };
  if (work.status === 'interrupted') return { outcome: 'parked', stage: '原聊天已中断，保留循环与来源，等待明确恢复。',
    ...(error ? { error: (error instanceof Error ? error.message : '聊天未完成。').slice(0, 2000) } : {}) };
  return undefined;
}

/** Executes the original reply lifecycle under one authoritative agenda lease.
 * Interactive tool/phone waits still hold this single root permit in the first
 * cutover; releasing them requires a real resumable loop-yield protocol. */
export async function executeCompanionAgendaChat(claim: CompanionAgendaClaim, context: CompanionAgendaExecutionContext,
  signal: AbortSignal, options: Options & { execute(work: CompanionWork, signal: AbortSignal): Promise<void> }): Promise<CompanionAgendaExecutionResult> {
  const { rule, run } = claim;
  if (rule.executor !== 'chat' || !rule.referenceId || !rule.conversationId) throw new Error('此日程没有绑定真实聊天队列。');
  const original = await read({ companionId: rule.companionId, id: rule.referenceId }, options);
  if (!original || original.conversationId !== rule.conversationId || String(original.agendaAttempt ?? 0) !== rule.referenceVersion)
    return { outcome: 'cancelled', stage: '原聊天已删除或进入新的明确重试；本次历史执行不再重放。' };
  if (signal.aborted) return { outcome: 'cancelled' };
  const prior = disposition(original); if (prior) return prior;
  const response = await options.request({ type: 'work.claim', companionId: rule.companionId, id: original.id,
    agendaRunId: run.id, agendaLeaseToken: claim.leaseToken });
  if (!response.ok) throw new Error(response.error ?? '原聊天队列暂未认领。');
  const work = response.work;
  if (!work) {
    const actual = await read(original, options), settled = actual && disposition(actual);
    if (settled) return settled;
    if (actual?.status === 'running') return { outcome: 'unknown', stage: '原聊天已有运行中的原生执行，需先核对其真实结果。' };
    // A preceding inbox item can win the native FIFO immediately before its
    // own claim. Once it is running, another cognitive lane may be available;
    // retry the same queued attempt promptly through the unchanged SQL claim.
    // This neither skips attention/routine admission nor advances a durable
    // agenda not-before boundary.
    const retryMs = actual?.status === 'queued' && sameWork(original, actual) ? 1000 : 5000;
    return { outcome: 'waiting', stage: '原消息仍在队列，等待引导归并、注意力或作息条件。',
      notBefore: new Date(Math.max((options.now?.() ?? new Date()).getTime() + retryMs, Date.parse(run.notBefore))).toISOString(), nextCondition: 'chat.native_admission' };
  }
  if (!sameWork(original, work) || work.status !== 'running' || work.agendaRunId !== run.id || work.agendaLeaseToken !== claim.leaseToken)
    throw new Error('聊天认领回执没有匹配当前日程租约，未启动推理。');
  try {
    await context.checkpoint('已认领真实聊天循环。', { chatWorkId: work.id, chatAttempt: work.agendaAttempt ?? 0,
      sourceMessageId: work.sourceMessageId, conversationId: work.conversationId });
  } catch (error) {
    // No model/tool has started; do not strand the native running row when its
    // parent checkpoint was rejected. The exact lease cannot touch a new retry.
    await options.request({ type: 'work.status', id: work.id, status: 'interrupted', agendaRunId: run.id, agendaLeaseToken: claim.leaseToken });
    throw error;
  }
  if (signal.aborted) {
    await options.request({ type: 'work.status', id: work.id, status: 'interrupted', agendaRunId: run.id, agendaLeaseToken: claim.leaseToken });
    return { outcome: 'cancelled' };
  }
  let failure: unknown;
  try { await options.execute(work, signal); } catch (error) { failure = error; }
  const actual = await read(original, options);
  if (!actual || !sameWork(work, actual)) return { outcome: 'unknown', stage: '原聊天状态已变化，请核对已发生的结果。' };
  const loopResponse = await options.request({ type: 'loop.get', companionId: work.companionId, sourceMessageId: work.sourceMessageId,
    ...(work.proactive ? { invocationKey: work.id } : {}) });
  const loop = loopResponse.loop;
  if (!loopResponse.ok || !loop || loop.companionId !== work.companionId || loop.conversationId !== work.conversationId
    || loop.sourceMessageId !== work.sourceMessageId || loop.invocationKey !== (work.proactive ? work.id : undefined)
    || actual.status === 'done' && loop.status !== 'done')
    return { outcome: 'unknown', stage: '原聊天没有返回匹配来源与执行的循环凭据，请先核对。' };
  if (loop?.turns.some(turn => turn.calls.some(call => !turn.results?.some(result => result.callId === call.id))))
    return { outcome: 'unknown', stage: '原循环保留了尚未核实的工具作用，停止自动重放。' };
  return disposition(actual, failure) ?? { outcome: 'unknown', stage: '原聊天执行尚无匹配的终态回执，请先核对原始循环。',
    ...(failure ? { error: (failure instanceof Error ? failure.message : '原聊天没有确认终态。').slice(0, 2000) } : {}) };
}
