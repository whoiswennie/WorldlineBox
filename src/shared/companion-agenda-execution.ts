import { z } from 'zod';
import type { CompanionAction } from './companions';
import { companionDshPendingApproval } from './companion-dsh-receipt';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
/** A read projection of an existing DSH action. It owns no new trigger,
 * scheduler, execution lease, editable prompt or task status. */
export const companionAgendaExecutionSchema = z.strictObject({
  id, companionId: id, conversationId: id, sourceMessageId: id.optional(), parentMessageId: id.optional(),
  title: z.string().max(120), status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  stage: z.string().max(1000).optional(), taskId: id.optional(),
  createdAt: z.string(), updatedAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  canResume: z.boolean(), contentAvailable: z.boolean(),
  waitingApproval: z.boolean().optional(),
});
export type CompanionAgendaExecution = z.infer<typeof companionAgendaExecutionSchema>;
export function companionAgendaExecution(action: CompanionAction): CompanionAgendaExecution {
  const visible = action.contentAvailable !== false;
  const approval = companionDshPendingApproval(action);
  return companionAgendaExecutionSchema.parse({ id: action.id, companionId: action.companionId, conversationId: action.conversationId,
    ...(visible ? { sourceMessageId: action.sourceMessageId, parentMessageId: action.parentMessageId, taskId: action.taskId } : {}),
    title: visible ? action.title : '来源已变化的执行任务', status: action.status,
    stage: visible ? approval ? '等待你确认执行权限。' : action.stage : '实际执行状态保留；旧目标与结果正文当前不可引用。',
    ...(approval ? { waitingApproval: true } : {}),
    createdAt: action.createdAt, updatedAt: action.updatedAt, startedAt: action.startedAt, finishedAt: action.finishedAt,
    canResume: visible && action.canResume === true, contentAvailable: visible });
}
