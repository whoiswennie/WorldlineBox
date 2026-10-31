import type { CompanionConnection } from './store';
import type { CompanionActivityTask } from '../shared/companion-activity-task';

export function assertCompanionAgendaActivityParent(db: CompanionConnection, task: CompanionActivityTask,
  runId = task.agendaRunId, leaseToken = task.agendaLeaseToken, stopped = false): void {
  if (!runId || !leaseToken) throw new Error('持续行动没有完整的日程父执行凭据。');
  const parent = db.prepare(`SELECT r.companion_id,r.status,json_extract(r.data,'$.leaseToken') AS lease_token,r.lease_until,o.rule_data,s.status AS rule_status
    FROM companion_agenda_runs r JOIN companion_agenda_occurrences o ON o.id=r.occurrence_id
    JOIN companion_agenda_rules s ON s.id=r.rule_id WHERE r.id=?`).get(runId) as {
      companion_id: string; status: string; lease_token: string; lease_until: string; rule_data: string; rule_status: string;
    } | undefined;
  if (!parent || parent.companion_id !== task.companionId || (!stopped && (parent.status !== 'running' || parent.rule_status !== 'active'
    || parent.lease_token !== leaseToken || !parent.lease_until || !Number.isFinite(Date.parse(parent.lease_until)) || Date.parse(parent.lease_until) <= Date.now()))
    || stopped && parent.status === 'running' && parent.lease_token !== leaseToken) throw new Error('持续行动的日程已停止或租约失效，迟到作用不可提交。');
  const rule = JSON.parse(parent.rule_data) as { executor?: string; referenceId?: string; referenceVersion?: string; companionId?: string; conversationId?: string };
  if (rule.executor !== 'activity' || rule.referenceId !== task.id || rule.referenceVersion !== String(task.agendaAttempt ?? 0)
    || rule.companionId !== task.companionId || rule.conversationId !== task.conversationId) throw new Error('持续行动父日程不属于本次真实目标与版本。');
}
