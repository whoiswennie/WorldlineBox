import type { CompanionConnection } from './store';
import type { CompanionMemoryProcessing, CompanionMemoryProcessingFilter, CompanionMemoryProcessingJob } from '../shared/companion-memory-processing';

const tables = { capture: 'vcp_capture_jobs', index: 'vcp_memory_outbox', tags: 'companion_memory_tag_jobs' } as const;
type Kind = keyof typeof tables;
type Row = { id: string; status: string; attempts: number; ordinal: number; created_at?: string; updated_at?: string;
  next_attempt: number; error?: string; note_id?: string; note_version?: number; message_id?: string; conversation_id?: string; operation?: string; source_revision?: number; source_checksum?: string };

/** Record real queue creation/transitions. Existing historical times remain unknown. */
export function initializeMemoryProcessingJournal(db: CompanionConnection, kinds: readonly Kind[]): void {
  for (const kind of kinds) {
    const table = tables[kind];
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    for (const column of ['created_at', 'updated_at']) if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_processing_owner ON ${table}(companion_id,status,ordinal);
      CREATE INDEX IF NOT EXISTS ${table}_processing_recent ON ${table}(companion_id,status,updated_at DESC,ordinal DESC);
      CREATE TRIGGER IF NOT EXISTS ${table}_processing_created AFTER INSERT ON ${table}
      BEGIN UPDATE ${table} SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_processing_updated AFTER UPDATE OF status,attempts,error ON ${table}
      BEGIN UPDATE ${table} SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;`);
  }
}

function job(kind: Kind, item: Row): CompanionMemoryProcessingJob {
  const status = item.status === 'done' ? 'completed' : item.status as CompanionMemoryProcessingJob['status'];
  const title = kind === 'capture' ? '整理聊天与经历' : kind === 'tags' ? '整理文档标签' : item.operation === 'forget' ? '撤回记忆索引' : '建立记忆索引';
  const stage = status === 'running' ? kind === 'capture' ? '正在理解来源并判断哪些内容值得记录' : kind === 'tags' ? '正在根据原文整理标签' : item.operation === 'forget' ? '正在从检索中撤回记忆' : '正在生成向量并写入 VCP 索引'
    : status === 'completed' ? kind === 'capture' ? '来源已处理；是否写成日记由内容价值决定' : kind === 'tags' ? '标签整理已完成' : item.operation === 'forget' ? '记忆已退出检索' : '索引投递已完成'
      : status === 'waiting_model' ? '等待可用的全局聊天模型' : status === 'failed' ? item.attempts >= 8 ? '自动重试次数已用尽，可手动重试' : '处理失败，等待重试' : status === 'stale' ? '文档或来源已变化，旧任务不再发布'
        : status === 'cancelled' ? '任务已取消' : '已排队，等待后台处理';
  return { id: item.id, kind, status, title, stage, attempts: item.attempts,
    ...(item.created_at ? { createdAt: item.created_at } : {}), ...(item.updated_at ? { updatedAt: item.updated_at } : {}),
    ...(item.next_attempt > 0 && ['pending', 'failed', 'waiting_model'].includes(status) ? { nextAttemptAt: new Date(item.next_attempt).toISOString() } : {}),
    ...(item.error ? { error: item.error.slice(0, 1000) } : {}), ...(item.note_id ? { noteId: item.note_id } : {}),
    ...(kind === 'capture' ? { sourceRevision: `${item.source_revision}:${item.source_checksum}` } : item.note_version ? { sourceRevision: String(item.note_version) } : {}),
    ...(item.message_id ? { sourceMessageId: item.message_id } : {}), ...(item.conversation_id ? { conversationId: item.conversation_id } : {}) };
}

/** Main-window owner report, bounded before materialization; authorized previews never exceed 160 characters. */
export function memoryProcessingStatus(db: CompanionConnection, companionId: string, limit = 30,
  filter: CompanionMemoryProcessingFilter = 'all',
  preview?: (job: CompanionMemoryProcessingJob) => string | undefined): CompanionMemoryProcessing {
  if (!db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(companionId)) throw new Error('伙伴不存在。');
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
    const columns = ['id', 'status', 'attempts', 'ordinal', 'created_at', 'updated_at', 'next_attempt', 'error', ...(kind === 'capture' ? ['message_id', 'conversation_id', 'source_revision', 'source_checksum'] : ['note_id', 'note_version']), ...(kind === 'index' ? ['operation'] : [])].join(',');
    // The equality on status keeps each LIMIT on a matching owner/status/time index,
    // even when a companion has years of completed queue history.
    for (const state of counts.map(entry => entry.status)) {
      if (!(filter === 'all' || filter === 'active' && ['pending', 'running', 'waiting_model'].includes(state) || filter === 'failed' && state === 'failed' || filter === 'completed' && ['done', 'completed'].includes(state))) continue;
      matching += counts.find(entry => entry.status === state)!.n;
      const found = db.prepare(`SELECT ${columns} FROM ${table} WHERE companion_id=? AND status=? ORDER BY updated_at DESC,ordinal DESC LIMIT ?`).all(companionId, state, bound + 1) as Row[];
      for (const entry of found) candidates.push({ item: job(kind, entry), ordinal: entry.ordinal });
    }
  }
  const priority = (value: CompanionMemoryProcessingJob) => value.status === 'running' ? 0 : ['pending', 'waiting_model', 'failed'].includes(value.status) ? 1 : 2;
  candidates.sort((a, b) => priority(a.item) - priority(b.item) || (b.item.updatedAt ?? b.item.createdAt ?? '').localeCompare(a.item.updatedAt ?? a.item.createdAt ?? '') || b.ordinal - a.ordinal || a.item.id.localeCompare(b.item.id));
  return { companionId, summary, jobs: candidates.slice(0, bound).map(entry => {
    const text = preview?.(entry.item)?.replace(/\s+/gu, ' ').trim().slice(0, 160);
    return text ? { ...entry.item, preview: text } : entry.item;
  }), hasMore: matching > bound };
}
