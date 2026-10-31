import type { CompanionConnection } from './store';
import type { AppendCompanionMessage } from '../shared/companion-storage';
import type { CompanionAgendaGrant, CompanionAgendaGoal, CompanionAgendaRule, CompanionAgendaRun } from '../shared/companion-agenda';

/** The authority check and actual message append share the writer transaction.
 * A UI pause/revoke cannot race the gap between Main's preflight and delivery. */
export function commitCompanionAgendaMessage<T>(db: CompanionConnection, input: { companionId: string; runId: string; leaseToken: string;
  unsolicited: boolean; message: AppendCompanionMessage }, append: (message: AppendCompanionMessage) => T): T {
  return db.transaction(() => {
    const read = <V>(row: unknown): V | undefined => row && typeof row === 'object' && 'data' in row && typeof row.data === 'string' ? JSON.parse(row.data) as V : undefined;
    const run = read<CompanionAgendaRun>(db.prepare('SELECT data FROM companion_agenda_runs WHERE companion_id=? AND id=?').get(input.companionId, input.runId));
    if (!run || run.status !== 'running' || run.leaseToken !== input.leaseToken || !run.leaseUntil || Date.parse(run.leaseUntil) <= Date.now())
      throw new Error('AGENDA_WAITING: 该事件已停止或执行租约失效，消息未发送。');
    const owner = read<{ active?: boolean; proactive?: boolean }>(db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(input.companionId));
    if (!owner || owner.active === false || input.message.authorId !== input.companionId
      || db.prepare('SELECT 1 FROM metadata WHERE key=?').get('recovery-review-required/' + input.companionId))
      throw new Error('AGENDA_WAITING: 当前伙伴不可继续发送事件消息。');
    if (input.unsolicited && !owner.proactive) throw new Error('AGENDA_WAITING: 用户已暂停主动联系，消息未发送。');
    const current = read<CompanionAgendaRule>(db.prepare('SELECT data FROM companion_agenda_rules WHERE companion_id=? AND id=?').get(input.companionId, run.ruleId));
    const occurrence = db.prepare('SELECT rule_data FROM companion_agenda_occurrences WHERE companion_id=? AND id=?').get(input.companionId, run.occurrenceId) as { rule_data: string } | undefined;
    const rule = occurrence ? JSON.parse(occurrence.rule_data) as CompanionAgendaRule : undefined;
    if (!current || current.status !== 'active' || !rule || rule.companionId !== input.companionId || rule.id !== run.ruleId)
      throw new Error('AGENDA_WAITING: 原日程规则不可执行，消息未发送。');
    if (rule.conversationId && rule.conversationId !== input.message.conversationId)
      throw new Error('AGENDA_WAITING: 不能把原事件的消息投递到另一个会话。');
    if (run.activeGrantId || rule.grantId) {
      const grant = read<CompanionAgendaGrant>(db.prepare('SELECT data FROM companion_agenda_grants WHERE companion_id=? AND id=?').get(input.companionId, run.activeGrantId ?? rule.grantId));
      if (!grant || grant.status !== 'active' || grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now() || grant.goalId && grant.goalId !== rule.goalId)
        throw new Error('AGENDA_WAITING: 此事件的持续范围已撤回，消息未发送。');
      if (run.activeGrantRevision && grant.revision !== run.activeGrantRevision) throw new Error('AGENDA_WAITING: 本次持续范围已经修订，旧事件未交付。');
      if (grant.conversationId && grant.conversationId !== input.message.conversationId)
        throw new Error('AGENDA_WAITING: 这份持续范围没有允许向该会话交付。');
    }
    if (rule.goalId) {
      const goal = read<CompanionAgendaGoal>(db.prepare('SELECT data FROM companion_agenda_goals WHERE companion_id=? AND id=?').get(input.companionId, rule.goalId));
      if (!goal || goal.status !== 'active') throw new Error('AGENDA_WAITING: 长期方向已停止，消息未发送。');
    }
    const room = db.prepare('SELECT kind,muted,private_companion_id FROM conversations WHERE id=? AND dissolved_at IS NULL').get(input.message.conversationId) as { kind: string; muted: number; private_companion_id: string | null } | undefined;
    if (!room || !db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(input.message.conversationId, input.companionId))
      throw new Error('AGENDA_WAITING: 消息接收入口已不可用。');
    if (input.unsolicited) {
      if (room.kind !== 'private' || room.private_companion_id !== input.companionId || room.muted || db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + input.message.conversationId))
        throw new Error('AGENDA_WAITING: 当前入口不接受主动打扰。');
    }
    if (!rule.conversationId && (room.kind !== 'private' || room.private_companion_id !== input.companionId))
      throw new Error('AGENDA_WAITING: 未指定接收端口的事件只能交付到本人和用户的私聊。');
    return append(input.message);
  }).immediate();
}
