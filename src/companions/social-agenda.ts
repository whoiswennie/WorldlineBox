import { createHash } from 'node:crypto';
import { companionAgendaRuleDraftSchema, type CompanionAgendaCommand, type CompanionAgendaResponse } from '../shared/companion-agenda';
import type { CompanionSocialJob } from '../shared/companion-social';

/** Register inside the incoming job's receipt transaction. This exact, once-only
 * event uses the normal agenda/native claim and cannot start another world job. */
export function registerCompanionSocialAgenda(job: Pick<CompanionSocialJob, 'id' | 'companionId' | 'conversationId' | 'sourceMessageId' | 'createdAt'>,
  request: (command: CompanionAgendaCommand) => CompanionAgendaResponse | undefined): void {
  const rule = companionAgendaRuleDraftSchema.parse({ title: '回应伙伴来信',
    intent: '仅处理此日程绑定的一条真实伙伴来信及其原始社交回复任务；保留来源、参与者、当前可用性与租约核验，不认领其他世界或自主行为。',
    kind: 'world', executor: 'world', trigger: { kind: 'at', at: job.createdAt, timeZone: 'UTC', repeat: 'once' },
    conditions: [{ key: 'active', equals: true, label: '伙伴已激活' }], protected: true, flexible: false,
    overlapPolicy: 'parallel', resourceKeys: ['social:' + job.id],
    reason: '真实伙伴消息收到即登记对应任务，不等待每分钟的世界观察机会；无来信不创建任务。',
    conversationId: job.conversationId, referenceId: job.id, referenceVersion: 'world-native-v1' });
  const identity = createHash('sha256').update(JSON.stringify(['agenda-social-receipt-v1', job.companionId, job.id])).digest('hex');
  const response = request({ type: 'agenda.rule.create', companionId: job.companionId, operationId: 'agenda-social-' + identity,
    authority: { kind: 'system', sourceMessageId: job.sourceMessageId }, rule });
  const saved = response?.agendaRule;
  if (!response?.ok || !saved || saved.companionId !== job.companionId || saved.executor !== 'world' || saved.referenceId !== job.id
    || saved.referenceVersion !== rule.referenceVersion || saved.conversationId !== job.conversationId)
    throw new Error(response?.error ?? '来信日程未返回匹配原始消息与任务的凭据，收信事务未提交。');
}
