import type { CompanionConnection } from './store';
import type { CompanionAgendaAuthority, CompanionAgendaRule, CompanionAgendaRuleDraft } from '../shared/companion-agenda';

type Proof = NonNullable<CompanionAgendaRule['classification']>;
type Classification = Pick<CompanionAgendaRule, 'category' | 'classification'>;
const exists = (db: CompanionConnection, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const maintenance = new Set(['memory', 'growth', 'world', 'reflection']);

/** Classification is worker authority. A model's kind/title/category never
 * proves that an external delegation or a system maintenance event exists. */
export function classifyCompanionAgendaRule(db: CompanionConnection, owner: string, rule: CompanionAgendaRuleDraft | CompanionAgendaRule,
  authority?: CompanionAgendaAuthority, strictNative = false): Classification {
  const origin = authority?.kind ?? ('origin' in rule ? rule.origin : 'self');
  let sourceId = authority?.sourceMessageId ?? ('sourceMessageId' in rule ? rule.sourceMessageId : undefined);
  if (rule.executor === 'routine') return { category: 'daily', classification: { basis: 'daily_routine', reason: '伙伴的作息与日常生活窗口，不是一项待完成的委托。',
    ...(rule.referenceId ? { referenceId: rule.referenceId } : {}), ...(sourceId ? { sourceMessageId: sourceId } : {}) } };
  if (origin === 'system' && rule.executor === 'brain' && rule.referenceId === 'system_self_wake_v1')
    return { category: 'daily', classification: { basis: 'daily_review', reason: '伙伴初始的日常自主回看节奏；具体形成的任务另有正式安排。', referenceId: rule.referenceId } };
  let native: { companionId: string; conversationId: string; sourceMessageId?: string; clientId?: string } | undefined;
  if (rule.executor === 'chat' || rule.executor === 'activity') {
    const table = rule.executor === 'chat' ? 'companion_work_queue' : 'companion_activity_tasks';
    const row = rule.referenceId && exists(db, table) ? db.prepare(`SELECT companion_id,data FROM ${table} WHERE id=?`).get(rule.referenceId) as { companion_id: string; data: string } | undefined : undefined;
    if (row) {
      native = JSON.parse(row.data) as typeof native;
      if (row.companion_id !== owner || !native || native.companionId !== owner || rule.conversationId && rule.conversationId !== native.conversationId
        || sourceId && native.sourceMessageId && sourceId !== native.sourceMessageId) throw new Error('AGENDA_NOT_AUTHORIZED: 原生任务不属于当前伙伴、来源或端口。');
      sourceId ??= native.sourceMessageId;
      if (rule.executor === 'activity' && native.clientId?.startsWith('world_activity_') && exists(db, 'companion_world_jobs')
        && db.prepare('SELECT 1 FROM companion_world_jobs WHERE id=? AND companion_id=?').get(native.clientId.slice('world_activity_'.length), owner))
        return { category: 'task', classification: { basis: 'native_task', reason: '伙伴根据真实世界情境主动发起的持续行动；父世界轮询仍是独立系统事件。',
          referenceId: rule.referenceId, sourceConversationId: native.conversationId, ...(sourceId ? { sourceMessageId: sourceId } : {}) } };
    } else if (strictNative) throw new Error('AGENDA_NOT_AUTHORIZED: 原生聊天或持续任务缺少真实本人记录。');
  }
  let proof: Proof | undefined;
  if (sourceId && exists(db, 'messages') && exists(db, 'conversation_members')) {
    const source = db.prepare(`SELECT m.id,m.author_id,m.conversation_id FROM messages m JOIN conversation_members c ON c.conversation_id=m.conversation_id
      WHERE m.id=? AND c.companion_id=? AND m.status='sent' AND m.kind='text'
      AND NOT EXISTS(SELECT 1 FROM metadata l WHERE l.key='message-loop/'||m.id AND json_extract(l.value,'$.status')!='done')
      AND (json_extract(m.request_fingerprint,'$.loopStep') IS NULL OR EXISTS(SELECT 1 FROM metadata l WHERE l.key='message-loop/'||m.id AND json_extract(l.value,'$.status')='done'))`)
      .get(sourceId, owner) as { id: string; author_id: string; conversation_id: string } | undefined;
    if (!source && strictNative && !native) throw new Error('AGENDA_NOT_AUTHORIZED: 任务来源不是当前伙伴真实可访问的正式消息。');
    if (source && rule.conversationId && source.conversation_id !== rule.conversationId) throw new Error('AGENDA_NOT_AUTHORIZED: 任务端口与正式来源不一致。');
    if (source) proof = { basis: native ? 'native_task' : source.author_id === owner ? 'self_task' : 'source_task',
      reason: source.author_id === owner ? '伙伴依据自己的正式言行发起的任务。' : '来源于真实可见的外界来信或委托；保留原始作者和端口。',
      sourceMessageId: source.id, sourceAuthorId: source.author_id, sourceConversationId: source.conversation_id, ...(rule.referenceId ? { referenceId: rule.referenceId } : {}) };
  }
  if (rule.executor === 'chat') return { category: 'daily', classification: { ...proof, basis: 'daily_conversation',
    reason: '本次普通交流的执行过程；收到或回复一条消息不直接构成一项独立任务。', referenceId: rule.referenceId,
    ...(sourceId ? { sourceMessageId: sourceId } : {}), ...(native ? { sourceConversationId: native.conversationId } : {}) } };
  if (native) return { category: 'task', classification: proof ?? { basis: 'native_task', reason: '绑定当前伙伴真实原生任务；来源可见性仍由执行器逐步核验。',
    referenceId: rule.referenceId, ...(sourceId ? { sourceMessageId: sourceId } : {}), sourceConversationId: native.conversationId } };
  if (proof && (proof.sourceAuthorId === 'user' || proof.sourceAuthorId === owner || !!db.prepare('SELECT 1 FROM companions WHERE id=?').get(proof.sourceAuthorId!)))
    return { category: 'task', classification: proof };
  if (origin === 'user') return { category: 'task', classification: { basis: 'source_task', reason: '由真人通过已认证的伙伴面板直接建立的任务。', sourceAuthorId: 'user' } };
  if (maintenance.has(rule.executor)) return { category: 'event', classification: { basis: 'system_maintenance', reason: '宿主记忆、人格或世界系统的维护处理流程。', ...(rule.referenceId ? { referenceId: rule.referenceId } : {}) } };
  if (rule.executor === 'activity') return { category: 'task', classification: { basis: 'native_task', reason: '宿主登记的历史原生任务；原始执行可用性另行核验。', ...(rule.referenceId ? { referenceId: rule.referenceId } : {}), ...(sourceId ? { sourceMessageId: sourceId } : {}) } };
  return { category: 'task', classification: { basis: 'self_task', reason: '伙伴明确安排的具体任务、周期探索或学习计划；不以发起者是否为系统决定归类。' } };
}
