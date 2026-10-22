import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionReset } from '../shared/companion-reset';
import type { Companion } from '../shared/companions';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand } from '../shared/companion-storage';
import { companionSearchTokens } from '../shared/companion-search';

type Row = Record<string, string | number | null>;
type Progress = { step: number; roomAfter: string; messageAfter: number; refs: number; taskIds: string[] };
type Job = CompanionReset & { throughSequence: number; progress: Progress };
const row = (input: unknown) => input as Row;
const rows = (input: unknown[]) => input.map(row);
const stamp = () => new Date().toISOString();
const json = <T>(input: unknown) => JSON.parse(String(input)) as T;
const fileOperation = (name: string, arguments_: string): boolean => {
  try { return name === 'dsh' && ['read_file', 'read_image', 'send_file'].includes(json<{ operation?: string }>(arguments_).operation ?? ''); }
  catch { return false; }
};
const ident = (input: string) => { if (!/^[a-z_][a-z0-9_]*$/iu.test(input)) throw new Error('Invalid reset table.'); return '"' + input + '"'; };

/** Incremental deletion on the UtilityProcess's existing connection, with a durable evidence barrier. */
export class CompanionResetStore {
  private messageReferences: Array<{ table: string; column: string }> = [];
  constructor(private readonly db: CompanionConnection, private readonly root: string,
    private readonly defaults: (id: string) => Companion,
    private readonly resetWorld: (id: string) => void,
    private readonly withdrawSources: (ids: string[]) => void,
    private readonly withdrawNote: (id: string) => void, private readonly resetNotes: (owner: string, limit: number) => number) {}

  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_reset_jobs(companion_id TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,phase TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_reset_boundaries(companion_id TEXT PRIMARY KEY,through_sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_reset_rooms(job_id TEXT NOT NULL,conversation_id TEXT NOT NULL,PRIMARY KEY(job_id,conversation_id));
      CREATE TABLE IF NOT EXISTS companion_reset_social_rooms(job_id TEXT NOT NULL,conversation_id TEXT NOT NULL,PRIMARY KEY(job_id,conversation_id));
      CREATE TABLE IF NOT EXISTS companion_reset_messages(job_id TEXT NOT NULL,message_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(job_id,message_id));
      CREATE INDEX IF NOT EXISTS companion_reset_message_id ON companion_reset_messages(message_id);
      CREATE TABLE IF NOT EXISTS companion_reset_garbage(job_id TEXT NOT NULL,attachment_id TEXT NOT NULL,PRIMARY KEY(job_id,attachment_id));
      CREATE TABLE IF NOT EXISTS companion_reset_files(job_id TEXT NOT NULL,relative_path TEXT NOT NULL,PRIMARY KEY(job_id,relative_path));`);
  }
  prepareIndexes(): void {
    this.db.exec(`CREATE INDEX IF NOT EXISTS companion_members_owner ON conversation_members(companion_id,conversation_id);
      CREATE INDEX IF NOT EXISTS companion_reset_metadata_owner ON metadata(CASE WHEN json_valid(value) THEN json_extract(value,'$.companionId') END,key) WHERE key NOT GLOB 'file-result/*';
      CREATE INDEX IF NOT EXISTS companion_reset_metadata_source ON metadata(CASE WHEN json_valid(value) THEN json_extract(value,'$.sourceMessageId') END,key) WHERE key NOT GLOB 'file-result/*';
      CREATE INDEX IF NOT EXISTS companion_reset_file_attachment ON metadata(json_extract(value,'$.attachments[0].id')) WHERE key GLOB 'file-result/*';`);
    const tables = rows(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_search%' AND name NOT LIKE 'companion_reset_%'").all()).map(item => String(item.name));
    for (const table of tables) {
      const columns = rows(this.db.prepare(`PRAGMA table_info(${ident(table)})`).all());
      const indexed = (column: string) => rows(this.db.prepare(`PRAGMA index_list(${ident(table)})`).all()).some(index => !index.partial
        && rows(this.db.prepare(`PRAGMA index_info(${ident(String(index.name))})`).all())[0]?.name === column);
      if (columns.some(column => column.name === 'companion_id') && !indexed('companion_id')) this.db.exec(`CREATE INDEX IF NOT EXISTS ${ident('reset_owner_' + table)} ON ${ident(table)}(companion_id)`);
      for (const fk of rows(this.db.prepare(`PRAGMA foreign_key_list(${ident(table)})`).all())) {
        if (!['messages', 'vcp_memory_notes', 'actions'].includes(String(fk.table))) continue;
        const column = String(fk.from); if (!indexed(column)) this.db.exec(`CREATE INDEX IF NOT EXISTS ${ident('reset_fk_' + table + '_' + column)} ON ${ident(table)}(${ident(column)})`);
        if (fk.table === 'messages') this.messageReferences.push({ table, column });
      }
    }
    for (const field of ['actorId', 'targetId', 'privateOwner', 'sourceMessageId']) this.db.exec(`CREATE INDEX IF NOT EXISTS ${ident('reset_world_' + field.toLowerCase())} ON companion_world_events(json_extract(data,'$.${field}'),sequence)`);
    for (const table of ['companion_social_jobs', 'companion_social_outbox']) this.db.exec(`CREATE INDEX IF NOT EXISTS ${ident('reset_source_' + table)} ON ${ident(table)}(json_extract(data,'$.sourceMessageId'))`);
    this.db.exec("CREATE INDEX IF NOT EXISTS reset_outbox_authorization ON companion_social_outbox(json_extract(data,'$.authorizationMessageId'))");
  }
  list(): CompanionReset[] { return rows(this.db.prepare('SELECT data FROM companion_reset_jobs ORDER BY rowid').all()).map(item => this.public(json<Job>(item.data))); }
  private public(job: Job): CompanionReset {
    return { id: job.id, companionId: job.companionId, scope: job.scope, status: job.status, phase: job.phase, processed: job.processed,
      startedAt: job.startedAt, updatedAt: job.updatedAt, ...(job.error ? { error: job.error } : {}) };
  }
  private load(id: string): Job | undefined { const found = this.db.prepare('SELECT data FROM companion_reset_jobs WHERE companion_id=?').get(id); return found ? json<Job>(row(found).data) : undefined; }
  status(id: string): { reset?: CompanionReset; resetTaskIds: string[] } { const job = this.load(id); return { reset: job && this.public(job), resetTaskIds: job?.progress.taskIds ?? [] }; }
  blocked(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(id); }
  assertCommand(command: CompanionStorageCommand): void {
    if (command.type.startsWith('companion.reset') || command.type.startsWith('memory.outbox.') || command.type === 'companion.task.track') return;
    const input = command as unknown as { type: string; id?: string; actionId?: string; companionId?: string; sourceMessageId?: string;
      action?: { companionId: string; sourceMessageId: string }; work?: { companionId: string; sourceMessageId: string };
      checkpoint?: { companionId?: string; sourceMessageId?: string }; memory?: { companionId: string; sourceMessageId?: string };
      message?: { authorId: string; conversationId: string; replyToId?: string } };
    let owner = input.companionId, source = input.sourceMessageId;
    for (const value of [input.action, input.work, input.checkpoint, input.memory]) if (value?.companionId) { owner = value.companionId; source = value.sourceMessageId; }
    const table = input.type.startsWith('action.') || input.type.startsWith('checkpoint.') || input.type === 'state.action' ? 'actions'
      : input.type.startsWith('activity.') ? 'companion_activity_tasks' : input.type.startsWith('memory.jobs.') ? 'vcp_capture_jobs' : input.type.startsWith('world.job.') ? 'companion_world_jobs'
        : input.type.startsWith('social.job.') ? 'companion_social_jobs' : input.type.startsWith('work-order.') ? 'companion_work_orders' : input.type === 'work.status' ? 'companion_work_queue'
          : input.type === 'memory.delete' ? 'vcp_memory_notes' : input.type.startsWith('schedule.') && 'id' in input ? 'companion_schedules' : undefined;
    if (!owner && table && (input.id || input.actionId)) { const found = this.db.prepare(`SELECT companion_id FROM ${ident(table)} WHERE id=?`).get(input.id ?? input.actionId); if (found) owner = String(row(found).companion_id); }
    if (input.type === 'schedule.occurrence.update' && input.id) { const found = this.db.prepare('SELECT s.companion_id FROM companion_schedule_occurrences o JOIN companion_schedules s ON s.id=o.schedule_id WHERE o.id=?').get(input.id); if (found) owner = String(row(found).companion_id); }
    if (input.message) {
      if (input.message.authorId !== 'user' && input.message.authorId !== 'system') { owner = input.message.authorId; source = input.message.replyToId; }
      else { const room = this.db.prepare('SELECT private_companion_id FROM conversations WHERE id=?').get(input.message.conversationId); if (room && row(room).private_companion_id) owner = String(row(room).private_companion_id); }
    }
    if (!owner) return;
    if (this.blocked(owner)) throw new Error('伙伴正在重置，旧作业不能继续写回。');
    if (source) {
      if (this.db.prepare('SELECT 1 FROM companion_reset_messages WHERE message_id=? LIMIT 1').get(source)) throw new Error('这个来源正在重置，不能继续写回。');
      const before = this.db.prepare('SELECT through_sequence FROM companion_reset_boundaries WHERE companion_id=?').get(owner);
      const message = this.db.prepare('SELECT sequence FROM messages WHERE id=?').get(source);
      if (before && (!message || Number(row(message).sequence) <= Number(row(before).through_sequence))) throw new Error('这个来源早于伙伴重置，不能恢复旧作业。');
    }
  }
  private save(job: Job): void {
    job.updatedAt = stamp(); this.db.prepare('INSERT INTO companion_reset_jobs(companion_id,id,status,phase,data) VALUES(?,?,?,?,?) ON CONFLICT(companion_id) DO UPDATE SET id=excluded.id,status=excluded.status,phase=excluded.phase,data=excluded.data').run(job.companionId, job.id, job.status, job.phase, JSON.stringify(job));
  }
  trackAction(id: string, companionId: string, taskId: string): void {
    this.db.transaction(() => {
      const action = this.db.prepare('SELECT companion_id FROM actions WHERE id=?').get(id);
      if (!action || row(action).companion_id !== companionId) throw new Error('任务不属于这个伙伴，不能登记执行进程。');
      const job = this.load(companionId);
      if (job && job.status !== 'completed' && job.phase !== 'stopping') throw new Error('重置已进入清理阶段，不能新增执行进程。');
      this.db.prepare("UPDATE actions SET data=json_set(data,'$.taskId',?) WHERE id=?").run(taskId, id);
      if (job && job.status !== 'completed' && !job.progress.taskIds.includes(taskId)) { job.progress.taskIds.push(taskId); this.save(job); }
    }).immediate();
  }
  begin(id: string, expectedRevision?: number): { reset: CompanionReset; resetTaskIds: string[] } {
    return this.db.transaction(() => {
      const previous = this.load(id);
      if (previous && previous.status !== 'completed') { previous.status = 'running'; delete previous.error; this.save(previous); return this.status(id) as { reset: CompanionReset; resetTaskIds: string[] }; }
      const found = this.db.prepare('SELECT data FROM companions WHERE id=?').get(id); if (!found) throw new Error('伙伴不存在。');
      const current = json<Companion>(row(found).data), defaults = this.defaults(id);
      if (expectedRevision !== undefined && expectedRevision !== (current.revision ?? 1)) throw new Error('伙伴资料已经更新，请重新读取后重置。');
      const job: Job = { id: randomUUID(), companionId: id, scope: 'all', status: 'running', phase: 'stopping', processed: 0, startedAt: stamp(), updatedAt: stamp(),
        throughSequence: Number(row(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM messages').get()).n),
        progress: { step: 0, roomAfter: '', messageAfter: 0, refs: 0, taskIds: rows(this.db.prepare("SELECT json_extract(data,'$.taskId') AS task FROM actions WHERE companion_id=? AND status IN('queued','running','interrupted') AND json_extract(data,'$.taskId') IS NOT NULL").all(id)).map(item => String(item.task)) } };
      this.save(job); this.db.prepare('INSERT INTO companion_reset_boundaries(companion_id,through_sequence) VALUES(?,?) ON CONFLICT(companion_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence)').run(id, job.throughSequence);
      // Old resets could remove membership from this hidden host port. Capture
      // its exact ownership marker before owner metadata/projections are reset;
      // membership must not be fabricated merely to erase stale observations.
      this.db.prepare(`INSERT OR IGNORE INTO companion_reset_rooms(job_id,conversation_id)
        SELECT ?,c.id FROM conversations c WHERE c.id=? AND c.kind='group' AND c.hidden_at IS NOT NULL
        AND EXISTS(SELECT 1 FROM metadata m WHERE m.key='world-room/'||c.id AND m.value='true')`).run(job.id, 'world_' + id);
      for (const attachment of [current.avatarAttachmentId, current.appearanceAttachmentId]) if (attachment) this.garbage(job, attachment);
      this.db.prepare('UPDATE companions SET deleted_at=NULL,data=? WHERE id=?').run(JSON.stringify({ ...defaults, id, createdAt: current.createdAt, revision: (current.revision ?? 1) + 1 }), id);
      this.db.prepare('UPDATE conversations SET title=? WHERE private_companion_id=?').run(defaults.name, id);
      this.resetWorld(id);
      return { reset: this.public(job), resetTaskIds: job.progress.taskIds };
    }).immediate();
  }
  cleanup(id: string, jobId: string, error?: string): CompanionReset {
    const job = this.load(id); if (!job || job.id !== jobId) throw new Error('重置任务已改变，请重新读取。');
    if (job.status === 'completed') return this.public(job);
    if (job.phase !== 'stopping') { if (error) throw new Error('外部任务清理阶段已经结束。'); return this.public(job); }
    job.status = error ? 'failed' : 'running'; job.error = error?.slice(0, 1000); if (!error) { job.phase = 'rooms'; job.progress.taskIds = []; }
    this.save(job); return this.public(job);
  }
  private garbage(job: Job, attachmentId: string): void { this.db.prepare('INSERT OR IGNORE INTO companion_reset_garbage(job_id,attachment_id) VALUES(?,?)').run(job.id, attachmentId); }
  private invalidate(_job: Job, noteId: string): void { this.withdrawNote(noteId); }
  private removeRows(table: string, predicate: string, args: unknown[], limit: number, before?: (items: Row[]) => void): number {
    if (table === 'companion_social_visit_contacts') {
      const found = rows(this.db.prepare(`SELECT guest_id,host_id FROM companion_social_visit_contacts WHERE ${predicate} LIMIT ?`).all(...args, limit));
      for (const item of found) this.db.prepare('DELETE FROM companion_social_visit_contacts WHERE guest_id=? AND host_id=?').run(item.guest_id, item.host_id);
      return found.length;
    }
    const found = rows(this.db.prepare(`SELECT rowid AS reset_rowid,* FROM ${ident(table)} WHERE ${predicate} LIMIT ?`).all(...args, limit));
    if (!found.length) return 0; before?.(found);
    const remove = this.db.prepare(`DELETE FROM ${ident(table)} WHERE rowid=?`); for (const item of found) remove.run(item.reset_rowid); return found.length;
  }
  private ownerSteps(job: Job): Array<[string, string, unknown[], ((items: Row[]) => void)?]> {
    const id = job.companionId;
    return [
      ['companion_document_catalog', 'companion_id=?', [id]],
      ['companion_topic_participation_receipts', 'companion_id=?', [id]],
      ['companion_topic_current', 'reader_id=?', [id]],
      ['companion_topic_participation', 'reader_id=?', [id]],
      ['companion_topic_state', 'reader_id=?', [id]],
      ['companion_topic_events', 'reader_id=?', [id]],
      ['companion_document_folders', 'companion_id=?', [id]],
      ['companion_character_retirement_watermarks', 'companion_id=?', [id]],
      ['companion_world_sleep_episodes', 'companion_id=?', [id]],
      ['companion_state_change_sources', 'change_id IN(SELECT id FROM companion_state_changes WHERE companion_id=?)', [id]],
      ['companion_state_change_memories', 'change_id IN(SELECT id FROM companion_state_changes WHERE companion_id=?)', [id]],
      ['companion_state_changes', 'companion_id=?', [id]],
      ['companion_learning_goal_sources', 'goal_id IN(SELECT id FROM companion_learning_goals WHERE companion_id=?)', [id]],
      ['companion_learning_goal_rounds', 'companion_id=?', [id]],
      ['companion_learning_goals', 'companion_id=?', [id]],
      ['companion_learning_reads', 'companion_id=?', [id]],
      ['companion_learning_grants', 'companion_id=?', [id]],
      ['vcp_note_source_history', 'note_id IN(SELECT id FROM vcp_memory_notes WHERE companion_id=?)', [id]],
      ...['vcp_capture_jobs', 'vcp_source_observers', 'vcp_source_blocks', 'vcp_source_prohibitions', 'vcp_source_policy_holds', 'vcp_operation_receipts'].map(table => [table, 'companion_id=?', [id]] as [string, string, unknown[]]),
      ['companion_schedule_occurrences', 'schedule_id IN(SELECT id FROM companion_schedules WHERE companion_id=?)', [id]],
      ['companion_work_order_audit', 'order_id IN(SELECT id FROM companion_work_orders WHERE companion_id=?)', [id]],
      ['companion_work_orders', 'companion_id=?', [id]],
      ['companion_life_occurrences', 'companion_id=?', [id]],
      ['metadata', "key IN(SELECT 'life-rule-removed/'||id FROM companion_life_rules WHERE companion_id=?)", [id]],
      ['metadata', 'key GLOB ?', ['life-create/' + id + '/*']],
      ['companion_life_rules', 'companion_id=?', [id]],
      ['metadata', 'key=?', ['life-rules-initialized/' + id]],
      ['metadata', 'key=?', ['life-park-walk-initialized/' + id]],
      ...['companion_schedules', 'companion_state_interactions', 'companion_appraisal_sources', 'companion_state_appraisals', 'companion_state_events', 'companion_routine_interruptions', 'companion_routine_audit', 'companion_routine_work', 'companion_routines', 'companion_runtime_states', 'companion_world_occupancy', 'companion_world_attention', 'companion_focus_interruptions', 'companion_world_work_records', 'companion_world_dream_watermark', 'companion_world_jobs', 'companion_social_jobs', 'companion_social_outbox', 'companion_social_budget', 'companion_social_communication', 'companion_social_delegations', 'companion_social_notifications', 'companion_work_queue', 'proactive_state'].map(table => [table, 'companion_id=?', [id]] as [string, string, unknown[]]),
      ['companion_social_interruptions', 'companion_id=? OR author_id=?', [id, id]],
      ['companion_world_peer_appraisals', 'companion_id=? OR target_id=?', [id, id]],
      ['companion_world_visit_records', 'guest_id=? OR host_id=?', [id, id]],
      ['companion_world_perceptions', 'companion_id=?', [id]],
      ['companion_activity_tasks', 'companion_id=?', [id]],
      ['companion_world_known_entrances', 'companion_id=? OR target_id=?', [id, id]],
      ['companion_world_suspended', 'companion_id=?', [id]],
      ['companion_social_jobs', 'conversation_id IN(SELECT conversation_id FROM companion_reset_social_rooms WHERE job_id=?)', [job.id]],
      ['companion_social_outbox', 'conversation_id IN(SELECT conversation_id FROM companion_reset_social_rooms WHERE job_id=?)', [job.id]],
      ['companion_social_communication', "EXISTS(SELECT 1 FROM json_each(data,'$.recipientIds') WHERE value=?)", [id]],
      ['companion_social_visit_contacts', 'guest_id=? OR host_id=?', [id, id]],
      ['companion_social_delegations', "EXISTS(SELECT 1 FROM json_each(data,'$.recipientIds') WHERE value=?)", [id]],
      ['companion_social_chains', "id IN(SELECT chain_id FROM companion_social_chain_origins WHERE json_extract(data,'$.ownerId')=? OR json_extract(data,'$.initiatorId')=?)", [id, id]],
      ['companion_social_chain_origins', "json_extract(data,'$.ownerId')=? OR json_extract(data,'$.initiatorId')=?", [id, id]],
      ...['actorId', 'targetId', 'privateOwner'].map(field => ['companion_world_events', `json_extract(data,'$.${field}')=?`, [id]] as [string, string, unknown[]]),
    ];
  }
  private memoryBatch(job: Job, limit: number): number { return this.resetNotes(job.companionId, limit); }
  private rooms(job: Job, limit: number): number {
    const found = rows(this.db.prepare('SELECT c.id,c.kind,(SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id=c.id) AS members,EXISTS(SELECT 1 FROM companion_social_conversations s WHERE s.id=c.id) AS peer FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id WHERE m.companion_id=? AND c.id>? ORDER BY c.id LIMIT ?').all(job.companionId, job.progress.roomAfter, limit));
    for (const item of found) {
      if (item.kind === 'private' || Number(item.members) === 1 || item.peer && Number(item.members) === 2) this.db.prepare('INSERT OR IGNORE INTO companion_reset_rooms(job_id,conversation_id) VALUES(?,?)').run(job.id, item.id);
      if (item.peer) {
        this.db.prepare('INSERT OR IGNORE INTO companion_reset_social_rooms(job_id,conversation_id) VALUES(?,?)').run(job.id, item.id);
        // Empty histories must not leave a known social relationship behind.
        // Other participants retain their group messages, with this owner out.
        // Release the old immutable member key so a future introduction starts
        // a genuinely fresh room rather than reviving the pre-reset identity.
        this.db.prepare('UPDATE companion_social_conversations SET member_key=? WHERE id=?').run('reset/' + job.id + '/' + item.id, item.id);
      }
      if (item.kind !== 'private') this.db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(item.id, job.companionId);
      job.progress.roomAfter = String(item.id);
    }
    return found.length;
  }
  private socialRooms(job: Job, limit: number): number {
    const found = rows(this.db.prepare('SELECT conversation_id FROM companion_reset_social_rooms WHERE job_id=? LIMIT ?').all(job.id, Math.min(limit, 32)));
    for (const item of found) {
      const members = rows(this.db.prepare("SELECT p.id,json_extract(p.data,'$.name') AS name FROM conversation_members m JOIN companions p ON p.id=m.companion_id WHERE m.conversation_id=? ORDER BY p.id").all(item.conversation_id));
      this.db.prepare('DELETE FROM companion_social_room_search WHERE id=?').run(item.conversation_id);
      if (members.length < 2) {
        this.db.prepare('DELETE FROM companion_social_conversations WHERE id=?').run(item.conversation_id);
        this.db.prepare('DELETE FROM conversation_members WHERE conversation_id=?').run(item.conversation_id);
        this.db.prepare('DELETE FROM metadata WHERE key=?').run('world-room/' + item.conversation_id);
        this.db.prepare('UPDATE conversations SET dissolved_at=?,hidden_at=? WHERE id=?').run(stamp(), stamp(), item.conversation_id);
      } else {
        const title = members.map(member => member.name).join('、').slice(0, 100);
        this.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(title, item.conversation_id);
        this.db.prepare('INSERT INTO companion_social_room_search(id,title) VALUES(?,?)').run(item.conversation_id, companionSearchTokens(title));
      }
      this.db.prepare('DELETE FROM companion_reset_social_rooms WHERE job_id=? AND conversation_id=?').run(job.id, item.conversation_id);
    }
    return found.length;
  }
  private selectMessages(job: Job, limit: number): number {
    const candidates = rows(this.db.prepare('SELECT id,sequence FROM messages WHERE author_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(job.companionId, job.progress.messageAfter, job.throughSequence, limit));
    for (const room of rows(this.db.prepare('SELECT conversation_id FROM companion_reset_rooms WHERE job_id=?').all(job.id))) candidates.push(...rows(this.db.prepare('SELECT id,sequence FROM messages WHERE conversation_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(room.conversation_id, job.progress.messageAfter, job.throughSequence, limit)));
    const selected = [...new Map(candidates.map(item => [String(item.id), item])).values()].sort((a, b) => Number(a.sequence) - Number(b.sequence)).slice(0, limit);
    const insert = this.db.prepare('INSERT OR IGNORE INTO companion_reset_messages(job_id,message_id,sequence) VALUES(?,?,?)');
    for (const message of selected) insert.run(job.id, message.id, message.sequence);
    if (selected.length) { this.withdrawSources(selected.map(item => String(item.id))); job.progress.messageAfter = Number(selected.at(-1)!.sequence); job.progress.refs = 0; }
    return selected.length;
  }
  private messageLinks(job: Job, limit: number): number {
    const stage = 'SELECT message_id FROM companion_reset_messages WHERE job_id=?';
    if (job.progress.refs < this.messageReferences.length) {
      const ref = this.messageReferences[job.progress.refs]!;
      if (ref.table === 'messages') {
        const found = rows(this.db.prepare(`SELECT rowid AS reset_rowid FROM messages WHERE ${ident(ref.column)} IN(${stage}) LIMIT ?`).all(job.id, limit));
        for (const item of found) this.db.prepare(`UPDATE messages SET ${ident(ref.column)}=NULL WHERE rowid=?`).run(item.reset_rowid);
        if (!found.length) job.progress.refs++; return found.length;
      }
      const count = this.removeRows(ref.table, `${ident(ref.column)} IN(${stage})`, [job.id], limit, items => {
        if (ref.table === 'vcp_note_sources') for (const item of items) this.invalidate(job, String(item.note_id));
        if (ref.table === 'message_attachments') for (const item of items) this.garbage(job, String(item.attachment_id));
        if (ref.table === 'companion_social_messages') for (const item of items) this.db.prepare('DELETE FROM companion_social_search WHERE rowid=?').run(item.sequence);
      });
      if (!count) job.progress.refs++; return count;
    }
    const extras = [
      { table: 'companion_world_events', column: 'sourceMessageId' }, { table: 'companion_social_jobs', column: 'sourceMessageId' },
      { table: 'companion_social_outbox', column: 'sourceMessageId' }, { table: 'companion_social_outbox', column: 'authorizationMessageId' },
    ];
    const extra = extras[job.progress.refs - this.messageReferences.length];
    if (extra) {
      const count = this.removeRows(extra.table, `json_extract(data,'$.${extra.column}') IN(${stage})`, [job.id], limit, items => {
        if (extra.table === 'companion_world_events') return;
        const clear = this.db.prepare("DELETE FROM companion_social_communication WHERE companion_id=? AND json_extract(data,'$.leaseId')=?");
        for (const item of items) clear.run(item.companion_id, extra.table === 'companion_social_jobs' ? 'job:' + item.id : 'outbox:' + item.client_id);
      });
      if (!count) job.progress.refs++; return count;
    }
    return -1;
  }
  private messageMetadata(job: Job, limit: number): number {
    const found = rows(this.db.prepare('SELECT message_id FROM companion_reset_messages WHERE job_id=? LIMIT ?').all(job.id, limit));
    if (!found.length) return 0;
    const stage = 'SELECT message_id FROM companion_reset_messages WHERE job_id=?';
    const removeMetadata = this.db.prepare('DELETE FROM metadata WHERE key IN(SELECT ?||message_id FROM companion_reset_messages WHERE job_id=?)');
    for (const prefix of ['message-loop/', 'message-memory-evidence/', 'message-published-after/', 'reply-source/', 'memory-world-observation/', 'scene-entry-source/']) removeMetadata.run(prefix, job.id);
    this.db.prepare(`DELETE FROM companion_social_budget WHERE message_id IN(${stage})`).run(job.id);
    this.db.prepare(`DELETE FROM messages WHERE id IN(${stage})`).run(job.id);
    this.db.prepare('DELETE FROM companion_reset_messages WHERE job_id=?').run(job.id);
    return found.length;
  }
  private metadata(job: Job, limit: number): number {
    const found = rows(this.db.prepare("SELECT key,value FROM metadata WHERE key NOT GLOB 'file-result/*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.companionId') END=? LIMIT ?").all(job.companionId, Math.min(limit, 16)));
    for (const item of found) {
      const value = json<{ sourceMessageId?: string; invocationKey?: string; turns?: Array<{ calls: Array<{ id: string; name: string; arguments: string }> }> }>(item.value);
      if (value.sourceMessageId && value.turns) value.turns.forEach((turn, index) => {
        for (const call of turn.calls) if (fileOperation(call.name, call.arguments)) {
          const key = 'file-result/' + createHash('sha256').update(`${value.sourceMessageId}:${job.companionId}${value.invocationKey ? ':' + value.invocationKey : ''}:${index}:${call.id}`).digest('hex');
          const saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
          if (saved) for (const attachment of json<{ attachments?: Array<{ id: string }> }>(row(saved).value).attachments ?? []) this.garbage(job, attachment.id);
          this.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
        }
      });
      this.db.prepare('DELETE FROM metadata WHERE key=?').run(item.key);
    }
    return found.length;
  }
  private garbageBatch(job: Job, limit: number): number {
    const found = rows(this.db.prepare('SELECT attachment_id FROM companion_reset_garbage WHERE job_id=? LIMIT ?').all(job.id, limit));
    for (const item of found) {
      const id = String(item.attachment_id), linked = this.db.prepare('SELECT 1 FROM message_attachments WHERE attachment_id=? LIMIT 1').get(id)
        || this.db.prepare("SELECT 1 FROM companions WHERE json_extract(data,'$.avatarAttachmentId')=? OR json_extract(data,'$.appearanceAttachmentId')=? LIMIT 1").get(id, id)
        || this.db.prepare("SELECT 1 FROM player_profile WHERE json_extract(data,'$.avatarAttachmentId')=? OR json_extract(data,'$.appearanceAttachmentId')=? LIMIT 1").get(id, id)
        || this.db.prepare("SELECT 1 FROM metadata WHERE key GLOB 'file-result/*' AND json_extract(value,'$.attachments[0].id')=? LIMIT 1").get(id);
      if (!linked) {
        const attachment = this.db.prepare('SELECT data,relative_path FROM attachments WHERE id=?').get(id);
        if (attachment) {
          const stored = row(attachment); if (!json<{ path?: string }>(stored.data).path) this.db.prepare('INSERT OR IGNORE INTO companion_reset_files(job_id,relative_path) VALUES(?,?)').run(job.id, stored.relative_path);
          this.db.prepare('DELETE FROM attachments WHERE id=?').run(id);
        }
      }
      this.db.prepare('DELETE FROM companion_reset_garbage WHERE job_id=? AND attachment_id=?').run(job.id, id);
    }
    return found.length;
  }
  private async files(job: Job): Promise<number> {
    const pending = rows(this.db.prepare('SELECT relative_path FROM companion_reset_files WHERE job_id=? LIMIT 16').all(job.id));
    const root = await realpath(this.root), directory = path.join(root, 'attachments');
    for (const item of pending) {
      const relative = String(item.relative_path); if (!/^attachments\/[a-zA-Z0-9_-]{1,100}(?:\.[a-zA-Z0-9]{1,16})?$/u.test(relative)) throw new Error('重置附件路径不属于受管目录。');
      const file = path.join(root, relative);
      try { const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile() || path.dirname(await realpath(file)) !== directory) throw new Error('附件路径已改变，已停止清理。'); await unlink(file); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      this.db.prepare('DELETE FROM companion_reset_files WHERE job_id=? AND relative_path=?').run(job.id, relative);
    }
    return pending.length;
  }
  async advance(limit = 300): Promise<CompanionReset | undefined> {
    const found = this.db.prepare("SELECT data FROM companion_reset_jobs WHERE status='running' AND phase!='stopping' ORDER BY rowid LIMIT 1").get(); if (!found) return;
    const job = json<Job>(row(found).data);
    try {
      if (job.phase === 'files') { const count = await this.files(job); job.processed += count; if (!count) job.phase = 'finish'; this.save(job); return this.public(job); }
      this.db.transaction(() => {
        const started = performance.now(); let emptySteps = 0;
        do {
        let count = 0;
        if (job.phase === 'rooms') { count = this.rooms(job, limit); if (!count) job.phase = 'journals'; }
        else if (job.phase === 'journals') { count = this.memoryBatch(job, limit); if (!count) job.phase = 'owner-records'; }
        else if (job.phase === 'owner-records') {
          const step = this.ownerSteps(job)[job.progress.step];
          if (!step) job.phase = 'metadata';
          else { count = this.removeRows(step[0], step[1], step[2], limit, step[3]); if (!count) job.progress.step++; }
        } else if (job.phase === 'metadata') { count = this.metadata(job, limit); if (!count) job.phase = 'select-messages'; }
        else if (job.phase === 'select-messages') { count = this.selectMessages(job, limit); job.phase = count ? 'message-links' : 'social-rooms'; }
        else if (job.phase === 'social-rooms') { count = this.socialRooms(job, limit); if (!count) job.phase = 'actions'; }
        else if (job.phase === 'message-links') { count = this.messageLinks(job, limit); if (count < 0) { count = 0; job.phase = 'messages'; } }
        else if (job.phase === 'messages') { count = this.messageMetadata(job, limit); if (!count) job.phase = 'select-messages'; }
        else if (job.phase === 'actions') { count = this.removeRows('actions', 'companion_id=?', [job.companionId], limit, items => { for (const item of items) { this.db.prepare('DELETE FROM companion_state_actions WHERE action_id=?').run(item.id); this.db.prepare('UPDATE messages SET action_id=NULL WHERE action_id=?').run(item.id); this.db.prepare('DELETE FROM metadata WHERE key=? OR key GLOB ?').run('task-checkpoint/' + item.id, 'task-attempt/' + item.id + '/*'); } }); if (!count) job.phase = 'attachments'; }
        else if (job.phase === 'attachments') { count = this.garbageBatch(job, limit); if (!count) job.phase = 'files'; }
        else if (job.phase === 'finish') {
          for (const table of ['companion_reset_rooms']) { count = this.removeRows(table, 'job_id=?', [job.id], limit); if (count) break; }
          if (!count) { job.status = 'completed'; job.phase = 'completed'; this.resetWorld(job.companionId); }
        }
        job.processed += count;
        if (count || job.status === 'completed' || job.phase === 'files' || performance.now() - started >= 5) break;
        } while (++emptySteps < 32);
        this.save(job);
      }).immediate();
    } catch (error) { job.status = 'failed'; job.error = (error instanceof Error ? error.message : '伙伴重置失败。').slice(0, 1000); this.save(job); }
    return this.public(job);
  }
}
