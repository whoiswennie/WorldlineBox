import type { CompanionConnection } from './store';
import type { CompanionWork } from '../shared/companion-loop';

/** The worker checks the sealed occurrence, not a model-provided title or the
 * latest editable rule. Parent pause/revocation fences publication immediately. */
export function assertCompanionAgendaChatParent(db: CompanionConnection, work: CompanionWork,
  runId = work.agendaRunId, leaseToken = work.agendaLeaseToken): void {
  if (!runId || !leaseToken) throw new Error('聊天日程没有完整的父执行凭据。');
  const parent = db.prepare(`SELECT r.companion_id,r.status,json_extract(r.data,'$.leaseToken') AS lease_token,r.lease_until,o.rule_data,s.status AS rule_status
    FROM companion_agenda_runs r JOIN companion_agenda_occurrences o ON o.id=r.occurrence_id
    JOIN companion_agenda_rules s ON s.id=r.rule_id WHERE r.id=?`).get(runId) as {
      companion_id: string; status: string; lease_token: string; lease_until: string; rule_data: string; rule_status: string;
    } | undefined;
  if (!parent || parent.companion_id !== work.companionId || parent.status !== 'running' || parent.rule_status !== 'active'
    || parent.lease_token !== leaseToken || parent.lease_until <= new Date().toISOString())
    throw new Error('聊天的日程执行已停止或租约失效，迟到结果不可发布。');
  const rule = JSON.parse(parent.rule_data) as { executor?: string; referenceId?: string; referenceVersion?: string; companionId?: string; conversationId?: string };
  if (rule.executor !== 'chat' || rule.referenceId !== work.id || rule.referenceVersion !== String(work.agendaAttempt ?? 0)
    || rule.companionId !== work.companionId || rule.conversationId !== work.conversationId)
    throw new Error('聊天父日程不属于本次真实消息与任务。');
}
