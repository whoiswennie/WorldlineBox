import { createHash } from 'node:crypto';
import { COMPANION_JOB_FAILURES_PER_CYCLE, companionJobDispositionSchema, type CompanionJobControlCommand, type CompanionJobDisposition, type CompanionJobPage, type CompanionJobPageCommand } from '../shared/companion-job-control';
import type { CompanionConnection } from './store';

export interface CompanionJobControlAdapter {
  read(ownerId: string, id: string): CompanionJobDisposition | undefined;
  page(input: CompanionJobPageCommand): CompanionJobPage;
  transition(current: CompanionJobDisposition, action: CompanionJobControlCommand['action']): CompanionJobDisposition;
}
export const companionJobInputVersion = (parts: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const pageLayouts = {
  companion_topic_compaction_jobs: { id: 'id', state: 'status', page: 'companion_topic_compaction_jobs_control_page', filtered: 'companion_topic_compaction_jobs_control_state_page' },
  companion_memory_source_outbox: { id: 'id', state: 'status', page: 'companion_memory_source_outbox_control_page', filtered: 'companion_memory_source_outbox_control_state_page' },
  companion_memory_history_outbox: { id: 'id', state: 'status', page: 'companion_memory_history_outbox_control_page', filtered: 'companion_memory_history_outbox_control_state_page' },
  vcp_capture_jobs: { id: 'id', state: 'status', page: 'vcp_capture_jobs_control_page', filtered: 'vcp_capture_jobs_control_state_page' },
  vcp_memory_outbox: { id: 'id', state: 'status', page: 'vcp_memory_outbox_control_page', filtered: 'vcp_memory_outbox_control_state_page' },
  companion_memory_tag_jobs: { id: 'id', state: 'status', page: 'companion_memory_tag_jobs_control_page', filtered: 'companion_memory_tag_jobs_control_state_page' },
  companion_task_timeline_jobs: { id: 'id', state: 'status', page: 'companion_task_timeline_jobs_control_page', filtered: 'companion_task_timeline_jobs_control_state_page' },
  companion_learning_grants: { id: 'id', state: 'status', page: 'companion_learning_grants_control_page', filtered: 'companion_learning_grants_control_state_page' },
  companion_learning_goal_rounds: { id: 'id', state: 'status', page: 'companion_learning_goal_rounds_control_page', filtered: 'companion_learning_goal_rounds_control_state_page' },
  companion_world_jobs: { id: 'id', state: "CASE WHEN status='done' THEN CASE WHEN json_extract(data,'$.stop.actor')='user' THEN 'cancelled' ELSE 'completed' END ELSE status END",
    page: 'companion_world_jobs_control_page', filtered: 'companion_world_jobs_normalized_state_page' },
  companion_learning_observed_assets: { id: 'job_id', state: "CASE WHEN job_status IN('parked','abandoned') THEN job_status WHEN status='withdrawn' THEN 'stale' ELSE job_status END",
    page: 'companion_learning_asset_job_page', filtered: 'companion_learning_asset_normalized_state_page' },
  companion_learning_asset_job_history: { id: 'job_id', state: 'job_status', page: 'companion_learning_asset_history_page', filtered: 'companion_learning_asset_history_state_page' },
} as const;

/** Each requested state performs its own indexed keyset query. At most nine
 * small pages are merged; a rare parked item cannot cause a scan of an owner's
 * entire completed history just because a global id index satisfies ORDER BY. */
export function pageCompanionJobIds(db: CompanionConnection, table: keyof typeof pageLayouts,
  input: { ownerId: string; afterId?: string; states?: readonly string[]; limit: number }): string[] {
  const layout = pageLayouts[table], states = input.states ? [...new Set(input.states)] : [undefined], selected = new Set<string>();
  for (const state of states) {
    const rows = db.prepare(`SELECT ${layout.id} AS id FROM ${table} INDEXED BY ${state === undefined ? layout.page : layout.filtered}
      WHERE companion_id=? ${state === undefined ? '' : `AND (${layout.state})=?`} AND ${layout.id}>? ORDER BY ${layout.id} LIMIT ?`)
      .all(input.ownerId, ...(state === undefined ? [] : [state]), input.afterId ?? '', input.limit + 1) as Array<{ id: string }>;
    for (const row of rows) selected.add(row.id);
  }
  return [...selected].sort().slice(0, input.limit + 1);
}

/** Receipts contain metadata only. Actual scheduling state stays on each
 * existing job row and is checked by its real consumer. */
export function initializeCompanionJobControlReceipts(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_job_control_receipts(operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,
    command_hash TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS companion_job_control_owner ON companion_job_control_receipts(owner_id,operation_id);
    CREATE INDEX IF NOT EXISTS companion_job_control_target ON companion_job_control_receipts(owner_id,json_extract(data,'$.kind'),json_extract(data,'$.id'));`);
}

export function controlCompanionJob(db: CompanionConnection, command: CompanionJobControlCommand, adapter: CompanionJobControlAdapter): CompanionJobDisposition {
  return db.transaction(() => {
    const commandHash = companionJobInputVersion([command.ownerId, command.kind, command.id, command.inputVersion, command.expectedRevision, command.action]);
    const previous = db.prepare('SELECT owner_id,command_hash,data FROM companion_job_control_receipts WHERE operation_id=?').get(command.operationId) as { owner_id: string; command_hash: string; data: string } | undefined;
    if (previous) {
      if (previous.owner_id !== command.ownerId || previous.command_hash !== commandHash) throw new Error('处理操作标识已用于另一个范围或动作。');
      return companionJobDispositionSchema.parse(JSON.parse(previous.data));
    }
    const current = adapter.read(command.ownerId, command.id);
    if (!current || current.ownerId !== command.ownerId || current.kind !== command.kind || current.id !== command.id) throw new Error('处理作业不存在或不属于当前伙伴。');
    if (current.inputVersion !== command.inputVersion || current.revision !== command.expectedRevision) throw new Error('作业输入或状态已经变化，请重新读取后操作。');
    if (['completed', 'cancelled', 'stale', 'abandoned'].includes(current.state)) throw new Error('这个作业已经终结，不能通过普通恢复重建旧处理。');
    if (command.action === 'resume' && current.state !== 'parked') throw new Error('只有已搁置的处理可以明确恢复。');
    const next = companionJobDispositionSchema.parse(adapter.transition(current, command.action));
    if (command.action !== 'resume' && current.processorId) next.processorId = current.processorId;
    const state = command.action === 'resume' ? 'pending' : command.action === 'park' ? 'parked' : 'abandoned';
    if (next.ownerId !== current.ownerId || next.kind !== current.kind || next.id !== current.id || next.inputVersion !== current.inputVersion
      || next.revision <= current.revision || next.state !== state || next.failureCount !== current.failureCount
      || next.cycleFailureCount !== (command.action === 'resume' ? 0 : current.cycleFailureCount)) throw new Error('作业处置没有保持原输入、累计失败与真实状态。');
    db.prepare('INSERT INTO companion_job_control_receipts(operation_id,owner_id,command_hash,data,created_at) VALUES(?,?,?,?,?)')
      .run(command.operationId, command.ownerId, commandHash, JSON.stringify(next), new Date().toISOString());
    return next;
  }).immediate();
}

export type CompanionDispositionTable = 'vcp_capture_jobs' | 'vcp_memory_outbox' | 'companion_memory_tag_jobs' | 'companion_task_timeline_jobs' | 'companion_world_jobs' | 'companion_learning_grants' | 'companion_learning_goal_rounds' | 'companion_memory_source_outbox' | 'companion_memory_history_outbox' | 'companion_topic_compaction_jobs';
/** Add fields to the current protocol's job tables. No old owner/schema is
 * discovered or imported by this initializer. */
export function initializeCompanionJobDisposition(db: CompanionConnection, table: CompanionDispositionTable): void {
  const columns = new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>).map(row => row.name));
  if (!columns.size) throw new Error('The actual job table must exist before failure disposition is attached.');
  if ((table === 'companion_memory_source_outbox' || table === 'companion_memory_history_outbox') && !columns.has('retry_cycle'))
    db.exec(`ALTER TABLE ${table} ADD COLUMN retry_cycle INTEGER NOT NULL DEFAULT 0`);
  if (table === 'companion_learning_grants' || table === 'companion_learning_goal_rounds') {
    if (!columns.has('status')) db.exec(`ALTER TABLE ${table} ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
    if (!columns.has('attempts')) db.exec(`ALTER TABLE ${table} ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
    if (!columns.has('input_version')) db.exec(`ALTER TABLE ${table} ADD COLUMN input_version TEXT NOT NULL DEFAULT ''`);
  }
  for (const [name, declaration] of [['failure_count', 'INTEGER NOT NULL DEFAULT 0'], ['cycle_failure_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['disposition_revision', 'INTEGER NOT NULL DEFAULT 0'], ['last_failure_at', 'TEXT'], ['last_failure_error', 'TEXT']] as const)
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_disposition_revision AFTER UPDATE OF status,failure_count,cycle_failure_count ON ${table}
    WHEN OLD.status IS NOT NEW.status OR OLD.failure_count IS NOT NEW.failure_count OR OLD.cycle_failure_count IS NOT NEW.cycle_failure_count
    BEGIN UPDATE ${table} SET disposition_revision=OLD.disposition_revision+1 WHERE id=NEW.id; END;`);
  db.exec(`CREATE INDEX IF NOT EXISTS ${table}_control_page ON ${table}(companion_id,id);
    CREATE INDEX IF NOT EXISTS ${table}_control_state_page ON ${table}(companion_id,status,id);`);
  if (table === 'companion_world_jobs') db.exec(`CREATE INDEX IF NOT EXISTS companion_world_jobs_normalized_state_page ON companion_world_jobs(companion_id,
    (CASE WHEN status='done' THEN CASE WHEN json_extract(data,'$.stop.actor')='user' THEN 'cancelled' ELSE 'completed' END ELSE status END),id);`);
}

type QueueTable = 'vcp_capture_jobs' | 'vcp_memory_outbox' | 'companion_memory_tag_jobs' | 'companion_memory_source_outbox' | 'companion_memory_history_outbox';
type QueueRow = Record<string, unknown> & { id: string; companion_id: string; status: string; failure_count: number;
  cycle_failure_count: number; disposition_revision: number; last_failure_at?: string; last_failure_error?: string };
const queueColumns = { vcp_capture_jobs: ['message_id', 'conversation_id', 'source_revision', 'source_checksum'],
  companion_memory_source_outbox: ['source_id', 'source_revision', 'source_checksum', 'operation'], companion_memory_history_outbox: ['note_id', 'content_revision', 'operation'],
  vcp_memory_outbox: ['note_id', 'note_version', 'operation'], companion_memory_tag_jobs: ['note_id', 'note_content_revision', 'content_hash'] } as const;

/** Metadata projection and controls operate on the real queue row. Body text
 * never becomes a job-control capability or a substitute for source checks. */
export function companionQueueJobAdapter(db: CompanionConnection, table: QueueTable): CompanionJobControlAdapter {
  const kind = table === 'vcp_capture_jobs' ? 'capture' : table === 'vcp_memory_outbox' ? 'index' : table === 'companion_memory_tag_jobs' ? 'tags' : table === 'companion_memory_source_outbox' ? 'source_files' : 'history_files';
  const fileJob = kind === 'source_files' || kind === 'history_files';
  const columns = ['id', 'companion_id', 'status', 'attempts', 'failure_count', 'cycle_failure_count', 'disposition_revision', 'last_failure_at', 'last_failure_error', ...(fileJob ? ['retry_cycle'] : []), ...(kind === 'capture' ? ['lease_token'] : []), ...queueColumns[table]];
  const read = (ownerId: string, id: string): CompanionJobDisposition | undefined => {
    const row = db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE companion_id=? AND id=?`).get(ownerId, id) as QueueRow | undefined;
    if (!row) return;
    const state = row.status === 'done' ? 'completed' : row.status;
    const sourceId = typeof row.message_id === 'string' ? row.message_id : typeof row.source_id === 'string' ? row.source_id : undefined;
    const conversation = kind === 'source_files' && sourceId ? (db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(sourceId) as { conversation_id: string } | undefined)?.conversation_id : row.conversation_id;
    return companionJobDispositionSchema.parse({ ownerId, kind, id,
      inputVersion: companionJobInputVersion([ownerId, kind, id, ...queueColumns[table].map(key => row[key])]), revision: row.disposition_revision,
      state, failureCount: row.failure_count, cycleFailureCount: row.cycle_failure_count, attemptCount: Number(row.attempts),
      processorId: kind === 'capture' && row.lease_token ? (db.prepare("SELECT id FROM vcp_capture_jobs WHERE lease_token=? AND status='running' ORDER BY ordinal LIMIT 1").get(row.lease_token) as { id: string } | undefined)?.id ?? id : id,
      ...(row.last_failure_at ? { lastErrorAt: row.last_failure_at } : {}), ...(row.last_failure_error ? { lastError: row.last_failure_error.slice(0, 1000) } : {}),
      ...(sourceId ? { sourceMessageId: sourceId } : {}), ...(typeof conversation === 'string' ? { conversationId: conversation } : {}),
      ...(kind === 'history_files' ? { memoryId: row.note_id, contentRevision: row.content_revision } : {}),
      ...(kind === 'source_files' ? { sourceRevision: row.source_revision } : {}), ...(fileJob ? { retryCycle: row.retry_cycle } : {}) });
  };
  return { read, page: input => {
    const states = input.states?.map(state => state === 'completed' && kind !== 'tags' ? 'done' : state);
    const selected = pageCompanionJobIds(db, table, { ...input, states }).map(id => ({ id }));
    const ids = selected.slice(0, input.limit);
    return { items: ids.map(row => read(input.ownerId, row.id)!), hasMore: selected.length > input.limit,
      ...(selected.length > input.limit && ids.length ? { nextId: ids.at(-1)!.id } : {}) };
  }, transition: (current, action) => {
    if (table === 'companion_memory_tag_jobs' && action === 'resume') {
      const note = db.prepare(`SELECT n.data,j.note_content_revision,j.content_hash FROM companion_memory_tag_jobs j JOIN vcp_memory_notes n ON n.id=j.note_id AND n.companion_id=j.companion_id WHERE j.id=? AND j.companion_id=?`)
        .get(current.id, current.ownerId) as { data: string; note_content_revision: number; content_hash: string } | undefined;
      const body = note ? JSON.parse(note.data) as { content: string; contentRevision: number; version: number } : undefined;
      if (!note || !body || body.contentRevision !== note.note_content_revision || createHash('sha256').update(body.content).digest('hex') !== note.content_hash)
        throw new Error('标签作业的固定正文或来源版本已变化，不能恢复原处理。');
      // A label/config annotation may advance the note's optimistic version,
      // while the fixed body and source revision remain the same input.
      db.prepare('UPDATE companion_memory_tag_jobs SET note_version=? WHERE id=?').run(body.version, current.id);
    }
    // Revoke the cohort's old lease before any late result can publish. Other
    // original events return to their own queue entries, without fake success.
    if (table === 'vcp_capture_jobs') {
      const row = db.prepare('SELECT lease_token FROM vcp_capture_jobs WHERE id=?').get(current.id) as { lease_token?: string } | undefined;
      if (row?.lease_token) db.prepare("UPDATE vcp_capture_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE lease_token=? AND id!=? AND status='running'").run(row.lease_token, current.id);
    }
    db.prepare(`UPDATE ${table} SET status=?,cycle_failure_count=?,disposition_revision=disposition_revision+1,
      ${fileJob && action === 'resume' ? 'retry_cycle=retry_cycle+1,' : ''}
      lease_token=NULL,lease_until=NULL,next_attempt=0 WHERE id=? AND companion_id=? AND disposition_revision=?`)
      .run(action === 'resume' ? 'pending' : action === 'park' ? 'parked' : 'abandoned', action === 'resume' ? 0 : current.cycleFailureCount,
        current.id, current.ownerId, current.revision);
    const updated = read(current.ownerId, current.id); if (!updated) throw new Error('作业处置期间对象已消失。'); return updated;
  } };
}

/** Call only for an actual processing failure, never host waiting, user stop
 * or source invalidation. Lifetime counts are not reset by a new cycle. */
export function failCompanionQueueJob(db: CompanionConnection, table: QueueTable, selector: { id: string } | { leaseToken: string }, error: string, retryAfterMs: number): void {
  const column = 'id' in selector ? 'id' : 'lease_token', value = 'id' in selector ? selector.id : selector.leaseToken;
  db.prepare(`UPDATE ${table} SET status=CASE WHEN cycle_failure_count+1>=? THEN 'parked' ELSE 'failed' END,
    failure_count=failure_count+1,cycle_failure_count=cycle_failure_count+1,last_failure_at=?,last_failure_error=?,
    error=?,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE ${column}=? AND status='running'`)
    .run(COMPANION_JOB_FAILURES_PER_CYCLE, new Date().toISOString(), error.slice(0, 1000), error, Date.now() + retryAfterMs, value);
}

/** Reading definitions and goal rounds already own the durable row and lease;
 * this adapter projects only their scalar processing metadata. */
export function companionStoredLearningAdapter(db: CompanionConnection, table: 'companion_learning_grants' | 'companion_learning_goal_rounds',
  apply: (current: CompanionJobDisposition, action: CompanionJobControlCommand['action']) => void): CompanionJobControlAdapter {
  const kind = table === 'companion_learning_grants' ? 'learning' : 'learning_goal';
  const read = (ownerId: string, id: string): CompanionJobDisposition | undefined => {
    const row = db.prepare(`SELECT id,status,input_version,attempts,disposition_revision,failure_count,cycle_failure_count,last_failure_at,last_failure_error,
      ${kind === 'learning_goal' ? 'goal_id' : 'id'} AS processor_id FROM ${table} WHERE companion_id=? AND id=?`).get(ownerId, id) as
      { status: CompanionJobDisposition['state']; input_version: string; attempts: number; disposition_revision: number; failure_count: number; cycle_failure_count: number;
        last_failure_at?: string; last_failure_error?: string; processor_id: string } | undefined;
    if (!row) return;
    return { ownerId, kind, id, processorId: row.processor_id, inputVersion: row.input_version, revision: row.disposition_revision, state: row.status,
      failureCount: row.failure_count, cycleFailureCount: row.cycle_failure_count, attemptCount: row.attempts,
      conversationId: 'world_' + ownerId, ...(row.last_failure_at ? { lastErrorAt: row.last_failure_at } : {}), ...(row.last_failure_error ? { lastError: row.last_failure_error } : {}) };
  };
  return { read, page: input => {
    const rows = pageCompanionJobIds(db, table, input).map(id => ({ id }));
    const page = rows.slice(0, input.limit); return { items: page.map(row => read(input.ownerId, row.id)!), hasMore: rows.length > input.limit,
      ...(rows.length > input.limit && page.length ? { nextId: page.at(-1)!.id } : {}) };
  }, transition: (current, action) => { apply(current, action); const next = read(current.ownerId, current.id); if (!next) throw new Error('学习处理作业已消失。'); return next; } };
}
