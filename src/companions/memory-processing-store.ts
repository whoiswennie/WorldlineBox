import type { CompanionConnection } from './store';
import { MEMORY_PROCESSING_TRIGGERS, MEMORY_SCHEDULE_EXPLANATION,
  type CompanionMemoryJobSchedule, type CompanionMemoryProcessing, type CompanionMemoryProcessingFilter, type CompanionMemoryProcessingJob } from '../shared/companion-memory-processing';

const tables = { capture: 'vcp_capture_jobs', index: 'vcp_memory_outbox', tags: 'companion_memory_tag_jobs' } as const;
type Kind = keyof typeof tables;
type Row = { id: string; status: string; attempts: number; ordinal: number; created_at?: string; updated_at?: string;
  next_attempt: number; lease_until?: number; scope_id?: string; error?: string; note_id?: string; note_version?: number; message_id?: string; conversation_id?: string; operation?: string; source_revision?: number; source_checksum?: string };

/** Record real queue creation/transitions in the current queue schema. */
export function initializeMemoryProcessingJournal(db: CompanionConnection, kinds: readonly Kind[]): void {
  for (const kind of kinds) {
    const table = tables[kind];
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_processing_owner ON ${table}(companion_id,status,ordinal);
      CREATE INDEX IF NOT EXISTS ${table}_processing_recent ON ${table}(companion_id,status,updated_at DESC,ordinal DESC);
      CREATE TRIGGER IF NOT EXISTS ${table}_processing_created AFTER INSERT ON ${table}
      BEGIN UPDATE ${table} SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_processing_updated AFTER UPDATE OF status,attempts,error ON ${table}
      BEGIN UPDATE ${table} SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;`);
    if (kind === 'index') db.exec('CREATE INDEX IF NOT EXISTS vcp_memory_outbox_processing_scope ON vcp_memory_outbox(scope_id,status,lease_until)');
  }
}

type QueueContext = { now: number; active: boolean; resetting: boolean;
  scopeBusy(scope: string, id: string): boolean };
function queueSchedule(kind: Kind, item: Row, status: CompanionMemoryProcessingJob['status'], context: QueueContext): CompanionMemoryJobSchedule {
  const base: CompanionMemoryJobSchedule = { scheduleKind: 'condition', timeBasis: 'real', observedAt: new Date(context.now).toISOString(),
    triggerRule: MEMORY_PROCESSING_TRIGGERS[kind], explanation: MEMORY_SCHEDULE_EXPLANATION,
    waitingReason: 'queue', condition: '已进入队列，等待主进程下一轮检查；存储队列本身不掌握主进程定时器。' };
  if (['completed', 'cancelled', 'stale'].includes(status)) return { ...base, scheduleKind: 'finished', waitingReason: undefined,
    condition: status === 'completed' ? '本次任务已结束；来源或文档再次变化才会产生新的整理任务。' : '本次任务已停止，不会自动执行旧版本。' };
  if (status === 'running' && item.lease_until && item.lease_until <= context.now && item.attempts >= 8) return { ...base, scheduleKind: 'manual', waitingReason: 'retry_limit',
    condition: '上次处理租约已经过期，且八次自动尝试已耗尽。请检查错误后点击“重试失败的整理”，不会中断有效的运行任务。' };
  if (status === 'running') return item.lease_until && item.lease_until <= context.now
    ? { ...base, waitingReason: 'lease_expired', condition: '上次处理的租约已过期，等待下一轮领取时回收并核验；租约到期不是完成时间。' }
    : { ...base, scheduleKind: 'running', waitingReason: undefined, condition: '任务已经领取并正在处理，完成时间取决于模型和实际内容。' };
  if (item.attempts >= 8 && status !== 'waiting_model') return { ...base, scheduleKind: 'manual', waitingReason: 'retry_limit',
    condition: '自动尝试次数已达到八次上限。请检查模型与错误原因后，点击“重试失败的整理”。' };
  const nextAttemptAt = item.next_attempt > 0 ? new Date(item.next_attempt).toISOString() : undefined;
  const eligible = { ...base, ...(nextAttemptAt ? { nextAttemptAt } : {}) };
  if ((kind === 'capture' || kind === 'tags') && context.resetting) return { ...eligible, waitingReason: 'reset_in_progress', condition: '伙伴正在重置，队列不会领取新任务。请先完成或重试伙伴重置。' };
  if (kind === 'capture' && !context.active) return { ...eligible, waitingReason: 'companion_inactive', condition: '此伙伴未启用或已暂停活动，来源整理暂停。请到联系人资料启用伙伴后继续检查；这与夜间睡眠不同。' };
  if (kind === 'index' && item.scope_id && context.scopeBusy(item.scope_id, item.id)) return { ...eligible, waitingReason: 'scope_busy',
    condition: '同一记忆范围已有索引投递进行中，等待它释放租约后再领取，保持版本顺序。' };
  if (status === 'waiting_model') return { ...eligible, waitingReason: 'model_unconfigured',
    condition: '正文已保存。请在“设置 → 全局模型”配置可用聊天模型；冷却到期后由后台检查是否能够继续。' };
  if (item.next_attempt > context.now) return { ...eligible, scheduleKind: 'retry', waitingReason: 'retry_backoff',
    condition: '正在等待已记录的重试冷却下限；到时仍需等待后台检查、模型及队列条件。' };
  return { ...eligible, condition: status === 'failed' ? '已达到最早重试条件，等待后台下一轮领取；也可手动重试失败的整理。' : base.condition };
}

function job(kind: Kind, item: Row, context: QueueContext): CompanionMemoryProcessingJob {
  const status = item.status === 'done' ? 'completed' : item.status as CompanionMemoryProcessingJob['status'];
  const title = kind === 'capture' ? '整理聊天与经历' : kind === 'tags' ? '整理文档标签' : item.operation === 'forget' ? '撤回记忆索引' : '建立记忆索引';
  const stage = status === 'running' ? kind === 'capture' ? '正在理解来源并判断哪些内容值得记录' : kind === 'tags' ? '正在根据原文整理标签' : item.operation === 'forget' ? '正在从检索中撤回记忆' : '正在生成向量并写入 VCP 索引'
    : status === 'completed' ? kind === 'capture' ? '来源已处理；是否写成日记由内容价值决定' : kind === 'tags' ? '标签整理已完成' : item.operation === 'forget' ? '记忆已退出检索' : '索引投递已完成'
      : status === 'waiting_model' ? '等待可用的全局聊天模型' : status === 'failed' ? item.attempts >= 8 ? '自动重试次数已用尽，可手动重试' : '处理失败，等待重试' : status === 'stale' ? '文档或来源已变化，旧任务不再发布'
        : status === 'cancelled' ? '任务已取消' : '已排队，等待后台处理';
  const schedule = queueSchedule(kind, item, status, context);
  return { id: item.id, kind, status, title, stage, attempts: item.attempts, schedule,
    ...(item.created_at ? { createdAt: item.created_at } : {}), ...(item.updated_at ? { updatedAt: item.updated_at } : {}),
    ...(schedule.nextAttemptAt ? { nextAttemptAt: schedule.nextAttemptAt } : {}),
    ...(item.error ? { error: item.error.slice(0, 1000) } : {}), ...(item.note_id ? { noteId: item.note_id } : {}),
    ...(kind === 'capture' ? { sourceRevision: `${item.source_revision}:${item.source_checksum}` } : item.note_version ? { sourceRevision: String(item.note_version) } : {}),
    ...(item.message_id ? { sourceMessageId: item.message_id } : {}), ...(item.conversation_id ? { conversationId: item.conversation_id } : {}) };
}

/** Main-window owner report, bounded before materialization; authorized previews never exceed 160 characters. */
export function memoryProcessingStatus(db: CompanionConnection, companionId: string, limit = 30,
  filter: CompanionMemoryProcessingFilter = 'all',
  preview?: (job: CompanionMemoryProcessingJob) => string | undefined): CompanionMemoryProcessing {
  const owner = db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(companionId) as { data: string } | undefined;
  if (!owner) throw new Error('伙伴不存在。');
  const context: QueueContext = { now: Date.now(), active: JSON.parse(owner.data).active !== false,
    resetting: !!db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(companionId),
    scopeBusy: (scope, id) => !!db.prepare("SELECT 1 FROM vcp_memory_outbox WHERE scope_id=? AND id!=? AND status='running' AND lease_until>? LIMIT 1").get(scope, id, Date.now()) };
  const bound = Math.min(50, Math.max(1, Math.floor(limit)));
  const summary = { pending: 0, running: 0, failed: 0, completed: 0, cancelled: 0 };
  const candidates: Array<{ item: CompanionMemoryProcessingJob; ordinal: number }> = [];
  let matching = 0;
  for (const kind of Object.keys(tables) as Kind[]) {
    const table = tables[kind];
    const counts = db.prepare(`SELECT status,COUNT(*) AS n FROM ${table} WHERE companion_id=? GROUP BY status`).all(companionId) as Array<{ status: string; n: number }>;
    for (const entry of counts) {
      const key = entry.status === 'done' || entry.status === 'completed' ? 'completed' : entry.status === 'stale' || entry.status === 'cancelled' ? 'cancelled'
        : entry.status === 'waiting_model' ? 'pending' : entry.status as keyof typeof summary;
      if (key in summary) summary[key] += entry.n;
    }
    const columns = ['id', 'status', 'attempts', 'ordinal', 'created_at', 'updated_at', 'next_attempt', 'lease_until', 'error', ...(kind === 'capture' ? ['message_id', 'conversation_id', 'source_revision', 'source_checksum'] : ['note_id', 'note_version']), ...(kind === 'index' ? ['operation', 'scope_id'] : [])].join(',');
    // The equality on status keeps each LIMIT on a matching owner/status/time index,
    // even when a companion has years of completed queue history.
    for (const state of counts.map(entry => entry.status)) {
      if (!(filter === 'all' || filter === 'active' && ['pending', 'running', 'waiting_model'].includes(state) || filter === 'failed' && state === 'failed' || filter === 'completed' && ['done', 'completed'].includes(state))) continue;
      matching += counts.find(entry => entry.status === state)!.n;
      const found = db.prepare(`SELECT ${columns} FROM ${table} WHERE companion_id=? AND status=? ORDER BY updated_at DESC,ordinal DESC LIMIT ?`).all(companionId, state, bound + 1) as Row[];
      for (const entry of found) candidates.push({ item: job(kind, entry, context), ordinal: entry.ordinal });
    }
  }
  const priority = (value: CompanionMemoryProcessingJob) => value.status === 'running' ? 0 : ['pending', 'waiting_model', 'failed'].includes(value.status) ? 1 : 2;
  candidates.sort((a, b) => priority(a.item) - priority(b.item) || (b.item.updatedAt ?? b.item.createdAt ?? '').localeCompare(a.item.updatedAt ?? a.item.createdAt ?? '') || b.ordinal - a.ordinal || a.item.id.localeCompare(b.item.id));
  return { companionId, summary, jobs: candidates.slice(0, bound).map(entry => {
    const text = preview?.(entry.item)?.replace(/\s+/gu, ' ').trim().slice(0, 160);
    return text ? { ...entry.item, preview: text } : entry.item;
  }), hasMore: matching > bound };
}
