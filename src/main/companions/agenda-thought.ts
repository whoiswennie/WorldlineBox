import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CompanionAgendaClaim, CompanionAgendaGrant } from '../../shared/companion-agenda';
import type { DshRecordScope } from '../../shared/dsh-task-record';
import type { DshTaskExecutionOptions, DshTaskVisualInput } from '../dsh/task-execution';
import type { DshTaskRecord } from '../../shared/dsh-tasks';
import type { CompanionAgendaExecutionContext, CompanionAgendaExecutionResult } from './agenda-service';
import { CompanionAgendaDeferred, CompanionAgendaOutcomeUnknown } from './agenda-service';

export interface CompanionAgendaThoughtNative {
  start(input: { title: string; prompt: string }, execution: DshTaskExecutionOptions): Promise<{ taskId: string }>;
  inspect(taskId: string): Promise<{ record?: Pick<DshTaskRecord, 'status' | 'error'>; scope?: DshRecordScope; text?: string; textTruncated?: boolean }>;
  terminate(taskId: string): Promise<void>;
}
export interface CompanionAgendaThoughtOptions {
  native?: CompanionAgendaThoughtNative;
  workspaceRoot: string;
  validate(): Promise<CompanionAgendaGrant | undefined>;
  wait?(signal: AbortSignal): Promise<void>;
  visualInputs?: DshTaskVisualInput[];
  presentationConversationId?: string;
  presentationTopicId?: string | null;
}
function uuid(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** The native process is a child step of this actual running event. Its empty
 * tool/skill policy is enforced by DSH, not a prompt that promises file scopes.
 * A crash after dispatch preserves an uncertain receipt and never relaunches. */
export async function executeCompanionAgendaThought(claim: CompanionAgendaClaim, context: CompanionAgendaExecutionContext, signal: AbortSignal,
  input: { title: string; prompt: string; key: string }, options: CompanionAgendaThoughtOptions): Promise<CompanionAgendaExecutionResult> {
  const native = options.native;
  if (!native) throw new CompanionAgendaDeferred('等待DSH执行环境可用。', undefined, 'dsh.available');
  const grant = await options.validate();
  const validGrant = (value: CompanionAgendaGrant | undefined) => value?.companionId === claim.rule.companionId && value.status === 'active'
    && value.capabilities.includes('dsh') && (!value.expiresAt || Date.parse(value.expiresAt) > Date.now())
    && (!value.goalId || value.goalId === claim.rule.goalId);
  if (!validGrant(grant) || !grant) throw new CompanionAgendaDeferred('这项日程没有持续深度思考授权。', undefined, 'grant.dsh');
  context.bindGrant(grant.id);
  const scope: DshRecordScope = { actionId: uuid(context.effectId(input.key)), companionId: claim.rule.companionId,
    conversationId: options.presentationConversationId ?? claim.rule.conversationId ?? 'world_' + claim.rule.companionId, invocationId: claim.run.id,
    ...(options.presentationTopicId !== undefined ? { topicId: options.presentationTopicId } : {}),
    agendaOrigin: { ruleId: claim.rule.id, runId: claim.run.id, occurrenceId: claim.occurrence.id, grantId: grant.id, grantRevision: grant.revision } };
  let taskId: string | undefined, terminal = false, mismatchedTask = false;
  try {
    const receipt = await context.effect('thought-start:' + input.key + ':' + claim.run.retryCycle, '启动本次独立深度思考', async () => {
      signal.throwIfAborted();
      const current = await options.validate();
      if (!validGrant(current) || current?.id !== grant.id || current.revision !== grant.revision) throw new CompanionAgendaDeferred('深度思考授权已变化。');
      const started = await native.start({ title: input.title, prompt: input.prompt }, { cognitiveOnly: true, toolkit: true, interactive: true,
        ...(options.visualInputs?.length ? { visualInputs: options.visualInputs } : {}),
        recordScope: scope, workspaceRootPath: options.workspaceRoot, allowedWorkspaceRoots: [], access: { mode: 'read-only' },
        task: { mode: 'native', tools: [], skills: [], session: { mode: 'new' }, workspace: { mode: 'managed' } } });
      taskId = started.taskId;
      if (!taskId) throw new CompanionAgendaOutcomeUnknown('DSH没有返回真实任务标识。');
      return { taskId };
    });
    taskId = receipt.taskId;
    await context.checkpoint('DSH正在分析本次明确提供的资料。', { dshTaskId: taskId, grantId: grant.id, grantRevision: grant.revision });
    for (;;) {
      signal.throwIfAborted();
      const current = await options.validate();
      if (!validGrant(current) || current?.id !== grant.id || current.revision !== grant.revision) throw new CompanionAgendaDeferred('持续授权已变化，旧深度思考停止。');
      const actual = await native.inspect(taskId);
      if (actual.scope && (actual.scope.companionId !== scope.companionId || actual.scope.actionId !== scope.actionId
        || actual.scope.conversationId !== scope.conversationId || actual.scope.invocationId !== scope.invocationId
        || actual.scope.sourceMessageId !== undefined || actual.scope.activityThought !== undefined
        || !actual.scope.agendaOrigin || !Object.entries(scope.agendaOrigin!).every(([key, value]) => actual.scope!.agendaOrigin![key as keyof NonNullable<DshRecordScope['agendaOrigin']>] === value))) {
        mismatchedTask = true;
        throw new CompanionAgendaOutcomeUnknown('原生执行记录不属于本次日程的准确授权。');
      }
      signal.throwIfAborted();
      const after = await options.validate();
      if (!validGrant(after) || after?.id !== grant.id || after.revision !== grant.revision) throw new CompanionAgendaDeferred('读取执行结果期间持续授权已变化，结果未交给主脑。');
      if (actual.record?.status === 'succeeded') {
        if (!actual.scope || actual.text === undefined) throw new CompanionAgendaOutcomeUnknown('原生完成记录尚无可核对的原文与来源。');
        terminal = true;
        const encode = (length: number) => JSON.stringify({ taskId, text: actual.text!.slice(0, length),
          ...(options.visualInputs?.length ? { visualInputs: options.visualInputs.map(({ mime, sha256, source }) => ({ mime, sha256, source })), visualMeaning: 'native_sampled_images_not_full_video' } : {}),
          textTruncated: !!actual.textTruncated || actual.text!.length > length, trust: 'reasoning_result_not_external_action_evidence' });
        let length = Math.min(actual.text.length, 26000), result = encode(length);
        if (result.length > 32000) {
          let low = 0, high = length;
          while (low < high) { const middle = Math.ceil((low + high) / 2); if (encode(middle).length <= 32000) low = middle; else high = middle - 1; }
          length = low; result = encode(length);
        }
        return { outcome: 'completed', stage: '独立思考已有真实执行结果。', result };
      }
      if (actual.record?.status === 'interrupted') throw new CompanionAgendaOutcomeUnknown('原生思考执行中断，结果需要核对，未重新发起。');
      if (actual.record && ['failed', 'cancelled'].includes(actual.record.status)) {
        terminal = true;
        return { outcome: actual.record.status === 'cancelled' ? 'cancelled' : 'failed', error: actual.record.error ?? '原生思考未完成。',
          stage: '原生思考未完成，原执行记录保留。', result: JSON.stringify({ taskId, status: actual.record.status }) };
      }
      await (options.wait?.(signal) ?? delay(500, undefined, { signal }));
    }
  } catch (failure) {
    if (taskId && !terminal && !mismatchedTask) try { await native.terminate(taskId); }
    catch (error) { throw new CompanionAgendaOutcomeUnknown((failure instanceof Error ? failure.message + ' ' : '')
      + '原生子进程尚未确认停止：' + (error instanceof Error ? error.message : '停止回执不可用。')); }
    throw failure;
  }
}
