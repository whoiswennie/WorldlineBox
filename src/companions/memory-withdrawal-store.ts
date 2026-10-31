import type { CompanionConnection } from './store';
import type { CompanionCaptureProposal } from '../shared/companion-memory';
import type { CompanionJobKind } from '../shared/companion-job-control';

type Version = { companion_id: string; note_id: string; content_revision: number };
export function scrubCompanionJobReceipts(db: CompanionConnection, owner: string, kind: CompanionJobKind, ids: readonly string[]): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_job_control_receipts'").get()) return;
  const clear = db.prepare(`UPDATE companion_job_control_receipts SET data=json_remove(data,'$.lastError')
    WHERE owner_id=? AND json_extract(data,'$.kind')=? AND json_extract(data,'$.id')=?`);
  for (const id of new Set(ids)) clear.run(owner, kind, id);
}
function scrubFilePublicationFailures(db: CompanionConnection, owner: string, kind: 'source_files' | 'history_files',
  selector: { sourceIds: readonly string[]; current?: { revision: number; checksum: string } } | { noteId: string; contentRevision: number }): void {
  const table = kind === 'source_files' ? 'companion_memory_source_outbox' : 'companion_memory_history_outbox';
  const condition = 'sourceIds' in selector
    ? `source_id IN(SELECT value FROM json_each(?)) ${selector.current ? 'AND (source_revision!=? OR source_checksum!=?)' : ''}`
    : 'note_id=? AND content_revision=?';
  const values = 'sourceIds' in selector ? [JSON.stringify([...new Set(selector.sourceIds)]), ...(selector.current ? [selector.current.revision, selector.current.checksum] : [])]
    : [selector.noteId, selector.contentRevision];
  const jobs = db.prepare(`SELECT id FROM ${table} WHERE companion_id=? AND ${condition}`).all(owner, ...values) as Array<{ id: string }>;
  // Some source modules initialize after the memory withdrawal hook. Clear
  // actual producer columns when present; this never changes event bodies,
  // job counters, disposition, authorization or publication state.
  const columns = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>;
  const errors = ['error', 'last_failure_error'].filter(column => columns.some(value => value.name === column));
  if (errors.length) db.prepare(`UPDATE ${table} SET ${errors.map(column => column + '=NULL').join(',')} WHERE companion_id=? AND ${condition}`).run(owner, ...values);
  scrubCompanionJobReceipts(db, owner, kind, jobs.map(job => job.id));
}

function scrubTopicCompactionSourceFailures(db: CompanionConnection, owner: string, ids: readonly string[], current?: { revision: number; checksum: string }): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_topic_compaction_jobs'").get()) return;
  const references = JSON.stringify([...new Set(ids)]), values = [owner, references, ...(current ? [current.revision, current.checksum] : [])];
  // Separate indexed branches also cover a fixed in-flight source after a
  // newer requested horizon has arrived. No lifetime owner/job scan is used.
  const selected = db.prepare(`SELECT id FROM companion_topic_compaction_jobs WHERE companion_id=? AND source_message_id IN(SELECT value FROM json_each(?))
      ${current ? 'AND (source_revision!=? OR source_checksum!=?)' : ''}
    UNION SELECT id FROM companion_topic_compaction_jobs WHERE companion_id=? AND claimed_source_message_id IN(SELECT value FROM json_each(?))
      ${current ? 'AND (claimed_source_revision!=? OR claimed_source_checksum!=?)' : ''}
    UNION SELECT job_id AS id FROM companion_job_input_refs WHERE owner_id=? AND kind='topic_compaction' AND input_kind='source'
      AND input_id IN(SELECT value FROM json_each(?)) ${current ? 'AND (revision!=? OR checksum!=?)' : ''}`)
    .all(...values, ...values, ...values) as Array<{ id: string }>;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_topic_checkpoint_owner_blocks'").get()) {
    const affected = `WITH RECURSIVE affected(event_id) AS (
      SELECT event_id FROM companion_topic_checkpoint_sources WHERE source_id IN(SELECT value FROM json_each(?))
        ${current ? 'AND (revision!=? OR checksum!=?)' : ''}
      UNION SELECT edge.event_id FROM companion_topic_checkpoint_edges edge JOIN affected parent ON edge.parent_event_id=parent.event_id) `;
    const sourceVersions = [references, ...(current ? [current.revision, current.checksum] : [])];
    // A private forget invalidates this reader's use, not Bob's permission to
    // the same shared immutable checkpoint. New children inherit these blocks.
    db.prepare(affected + 'INSERT OR IGNORE INTO companion_topic_checkpoint_owner_blocks(owner_id,event_id) SELECT ?,event_id FROM affected')
      .run(...sourceVersions, owner);
    const checkpointJobs = db.prepare(affected + `SELECT DISTINCT refs.job_id AS id FROM companion_job_input_refs refs
      JOIN affected ON affected.event_id=refs.input_id WHERE refs.owner_id=? AND refs.kind='topic_compaction' AND refs.input_kind='topic_checkpoint'`)
      .all(...sourceVersions, owner) as Array<{ id: string }>;
    selected.push(...checkpointJobs);
  }
  const clear = db.prepare(`UPDATE companion_topic_compaction_jobs SET status=CASE WHEN status IN('parked','abandoned') THEN status ELSE 'stale' END,
    disposition_revision=disposition_revision+1,error=NULL,last_failure_error=NULL,lease_token=NULL,lease_until=NULL,next_attempt=0,
    reconcile_needed=CASE WHEN status IN('parked','abandoned') THEN reconcile_needed ELSE 1 END,
    reconcile_cursor_publication=CASE WHEN status IN('parked','abandoned') THEN reconcile_cursor_publication ELSE requested_publication_revision+1 END
    WHERE companion_id=? AND id=?`);
  const jobIds = [...new Set(selected.map(job => job.id))];
  for (const id of jobIds) clear.run(owner, id);
  scrubCompanionJobReceipts(db, owner, 'topic_compaction', jobIds);
}

/** Dependency metadata only. Unpublished prose is erased when any exact input
 * is withdrawn; no scan of an owner's lifetime proposal/body corpus is used. */
export function initializeCompanionMemoryWithdrawal(db: CompanionConnection): void {
  initializeCompanionJobInputReferences(db);
  db.exec(`CREATE TABLE IF NOT EXISTS companion_capture_proposal_sources(
    job_id TEXT NOT NULL REFERENCES companion_capture_proposals(job_id) ON DELETE CASCADE,companion_id TEXT NOT NULL,
    source_id TEXT NOT NULL,revision INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(job_id,source_id));
    CREATE INDEX IF NOT EXISTS companion_capture_proposal_source ON companion_capture_proposal_sources(companion_id,source_id,revision,checksum,job_id);
    CREATE TABLE IF NOT EXISTS companion_capture_proposal_memories(
    job_id TEXT NOT NULL REFERENCES companion_capture_proposals(job_id) ON DELETE CASCADE,companion_id TEXT NOT NULL,
    note_id TEXT NOT NULL,content_revision INTEGER NOT NULL,PRIMARY KEY(job_id,note_id));
    CREATE INDEX IF NOT EXISTS companion_capture_proposal_memory ON companion_capture_proposal_memories(companion_id,note_id,content_revision,job_id);`);
}

export function initializeCompanionJobInputReferences(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_job_input_refs(owner_id TEXT NOT NULL,kind TEXT NOT NULL,job_id TEXT NOT NULL,
    input_kind TEXT NOT NULL,input_id TEXT NOT NULL,revision INTEGER NOT NULL,checksum TEXT NOT NULL,
    PRIMARY KEY(owner_id,kind,job_id,input_kind,input_id,revision,checksum));
    CREATE INDEX IF NOT EXISTS companion_job_input_source ON companion_job_input_refs(owner_id,input_kind,input_id,revision,checksum,kind,job_id);`);
}
export function indexCompanionJobInputs(db: CompanionConnection, input: { ownerId: string; kind: 'world' | 'timeline' | 'topic_compaction'; jobId: string;
  sourceVersions?: readonly { id: string; revision?: number; checksum?: string }[];
  memoryVersions?: readonly { id: string; contentRevision?: number }[] }): void {
  initializeCompanionJobInputReferences(db);
  db.prepare('DELETE FROM companion_job_input_refs WHERE owner_id=? AND kind=? AND job_id=?').run(input.ownerId, input.kind, input.jobId);
  const insert = db.prepare('INSERT OR IGNORE INTO companion_job_input_refs VALUES(?,?,?,?,?,?,?)');
  for (const reference of input.sourceVersions ?? []) insert.run(input.ownerId, input.kind, input.jobId, 'source', reference.id, reference.revision ?? 0, reference.checksum ?? '');
  for (const reference of input.memoryVersions ?? []) insert.run(input.ownerId, input.kind, input.jobId, 'memory', reference.id, reference.contentRevision ?? 0, '');
}
function scrubReferencedJobErrors(db: CompanionConnection, ownerId: string, selector: { sourceIds: readonly string[]; current?: { revision: number; checksum: string } }
  | { noteId: string; contentRevision?: number }): void {
  const source = 'sourceIds' in selector;
  const matches = db.prepare(`SELECT DISTINCT kind,job_id FROM companion_job_input_refs WHERE owner_id=? AND kind IN('world','timeline') AND input_kind=?
    AND input_id IN(SELECT value FROM json_each(?)) ${source && selector.current ? 'AND (revision!=? OR checksum!=?)' : !source && selector.contentRevision ? 'AND revision IN(0,?)' : ''}`)
    .all(ownerId, source ? 'source' : 'memory', JSON.stringify(source ? [...new Set(selector.sourceIds)] : [selector.noteId]),
      ...(source && selector.current ? [selector.current.revision, selector.current.checksum] : !source && selector.contentRevision ? [selector.contentRevision] : [])) as Array<{ kind: 'world' | 'timeline'; job_id: string }>;
  for (const match of matches) {
    const table = match.kind === 'world' ? 'companion_world_jobs' : 'companion_task_timeline_jobs';
    const columns = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>;
    const updates = ['error', 'last_failure_error'].filter(column => columns.some(value => value.name === column));
    if (updates.length) db.prepare(`UPDATE ${table} SET ${updates.map(column => column + '=NULL').join(',')} WHERE id=? AND companion_id=?`).run(match.job_id, ownerId);
    // These are the actual producers' derived fields, not their original
    // events/messages. Fence live jobs before erasing quotations so a late
    // result or failure cannot repopulate them through its old lease/CAS.
    if (columns.some(value => value.name === 'data')) {
      const nextState = "CASE WHEN status IN('pending','running','failed','parked','waiting_model') THEN 'stale' ELSE status END";
      if (match.kind === 'world') db.prepare(`UPDATE ${table} SET status=${nextState},lease_until=NULL,
        data=json_remove(json_set(data,'$.status',${nextState}),'$.error','$.proposals','$.leaseToken') WHERE id=? AND companion_id=?`).run(match.job_id, ownerId);
      else db.prepare(`UPDATE ${table} SET status=${nextState},input=NULL,output=NULL,
        data=json_remove(json_set(data,'$.status',${nextState}),'$.error','$.preview') WHERE id=? AND companion_id=?`).run(match.job_id, ownerId);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_task_payloads'").get())
      db.prepare('DELETE FROM companion_task_payloads WHERE kind=? AND task_id=? AND companion_id=?').run(match.kind === 'world' ? 'world' : 'memory_timeline', match.job_id, ownerId);
    scrubCompanionJobReceipts(db, ownerId, match.kind, [match.job_id]);
  }
}

export function indexCompanionCaptureProposal(db: CompanionConnection, owner: string, job: string, proposal: CompanionCaptureProposal): void {
  db.prepare('DELETE FROM companion_capture_proposal_sources WHERE job_id=?').run(job);
  db.prepare('DELETE FROM companion_capture_proposal_memories WHERE job_id=?').run(job);
  const source = db.prepare('INSERT INTO companion_capture_proposal_sources VALUES(?,?,?,?,?)');
  for (const reference of proposal.sourceVersions) source.run(job, owner, reference.id, reference.revision, reference.checksum);
  const memory = db.prepare('INSERT INTO companion_capture_proposal_memories VALUES(?,?,?,?)');
  for (const reference of proposal.readMemories) memory.run(job, owner, reference.id, reference.contentRevision);
}

function discardProposals(db: CompanionConnection, jobs: string[]): void {
  for (const job of new Set(jobs)) {
    const owner = db.prepare('SELECT companion_id FROM vcp_capture_jobs WHERE id=?').get(job) as { companion_id: string } | undefined;
    db.prepare('DELETE FROM companion_capture_proposals WHERE job_id=?').run(job);
    // The raw source can still be lawful when only a read memory was revoked.
    // Retain its debt, but revoke the old lease so a late failure cannot write
    // discarded quotes back into an error or checkpoint.
    db.prepare(`UPDATE vcp_capture_jobs SET status=CASE WHEN status='running' THEN 'pending' ELSE status END,
      error=NULL,last_failure_error=NULL,lease_token=NULL,lease_until=NULL,next_attempt=0 WHERE id=?`).run(job);
    if (owner) scrubCompanionJobReceipts(db, owner.companion_id, 'capture', [job]);
  }
}

export function withdrawCompanionCaptureSources(db: CompanionConnection, owner: string, ids: readonly string[],
  current?: { revision: number; checksum: string }): void {
  if (!ids.length) return;
  scrubTopicCompactionSourceFailures(db, owner, ids, current);
  scrubReferencedJobErrors(db, owner, { sourceIds: ids, current });
  const references = JSON.stringify([...new Set(ids)]);
  const jobs = db.prepare(`SELECT DISTINCT job_id FROM companion_capture_proposal_sources WHERE companion_id=?
    AND source_id IN(SELECT value FROM json_each(?)) ${current ? 'AND (revision!=? OR checksum!=?)' : ''}`)
    .all(owner, references, ...(current ? [current.revision, current.checksum] : [])) as Array<{ job_id: string }>;
  discardProposals(db, jobs.map(job => job.job_id));
  const captures = db.prepare(`SELECT id FROM vcp_capture_jobs WHERE companion_id=? AND message_id IN(SELECT value FROM json_each(?))
    ${current ? 'AND (source_revision!=? OR source_checksum!=?)' : ''}`)
    .all(owner, references, ...(current ? [current.revision, current.checksum] : [])) as Array<{ id: string }>;
  // A forgotten raw chat remains in messages. Only its derived extraction
  // jobs stop, and no message content or original chat archive is edited.
  db.prepare(`UPDATE vcp_capture_jobs SET status='done',error=NULL,last_failure_error=NULL,lease_token=NULL,lease_until=NULL WHERE companion_id=?
    AND message_id IN(SELECT value FROM json_each(?)) ${current ? 'AND (source_revision!=? OR source_checksum!=?)' : ''}`)
    .run(owner, references, ...(current ? [current.revision, current.checksum] : []));
  scrubCompanionJobReceipts(db, owner, 'capture', captures.map(job => job.id));
  scrubFilePublicationFailures(db, owner, 'source_files', { sourceIds: ids, current });
  db.prepare(`UPDATE companion_memory_source_outbox SET error=NULL,lease_token=NULL,lease_until=NULL,
    status=CASE WHEN operation='publish' THEN 'stale' WHEN status='running' THEN 'pending' ELSE status END
    WHERE companion_id=? AND source_id IN(SELECT value FROM json_each(?))
    ${current ? 'AND (source_revision!=? OR source_checksum!=?)' : ''}`)
    .run(owner, references, ...(current ? [current.revision, current.checksum] : []));
}

/** Keep opaque version/hash receipts, while removing the retired derived
 * body and every annotation attached to that exact content revision. */
export function eraseCompanionMemoryVersions(db: CompanionConnection, versions: readonly Version[]): void {
  for (const version of versions) {
    scrubFilePublicationFailures(db, version.companion_id, 'history_files', { noteId: version.note_id, contentRevision: version.content_revision });
    scrubReferencedJobErrors(db, version.companion_id, { noteId: version.note_id, contentRevision: version.content_revision });
    const jobs = db.prepare(`SELECT job_id FROM companion_capture_proposal_memories
      WHERE companion_id=? AND note_id=? AND content_revision=?`).all(version.companion_id, version.note_id, version.content_revision) as Array<{ job_id: string }>;
    discardProposals(db, jobs.map(job => job.job_id));
    db.prepare(`UPDATE companion_memory_content_revisions SET data=json_object(
      'schema','worldlinebox.memory-withdrawal-v2','noteId',note_id,'contentRevision',content_revision,'bodyHash',body_hash,'withdrawn',json('true'))
      WHERE companion_id=? AND note_id=? AND content_revision=?`).run(version.companion_id, version.note_id, version.content_revision);
    db.prepare(`UPDATE companion_memory_version_revisions SET annotations='{"withdrawn":true}' WHERE note_id=? AND content_revision=?`)
      .run(version.note_id, version.content_revision);
    const indices = db.prepare(`SELECT id FROM vcp_memory_outbox WHERE companion_id=? AND note_id=?
      AND note_version IN(SELECT version FROM companion_memory_version_revisions WHERE note_id=? AND content_revision=?)`)
      .all(version.companion_id, version.note_id, version.note_id, version.content_revision) as Array<{ id: string }>;
    db.prepare(`UPDATE vcp_memory_outbox SET data=json_object('noteId',note_id,'version',note_version),error=NULL,last_failure_error=NULL
      WHERE companion_id=? AND note_id=? AND note_version IN(SELECT version FROM companion_memory_version_revisions WHERE note_id=? AND content_revision=?)`)
      .run(version.companion_id, version.note_id, version.note_id, version.content_revision);
    scrubCompanionJobReceipts(db, version.companion_id, 'index', indices.map(job => job.id));
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_memory_tag_jobs'").get()) {
      const tags = db.prepare(`SELECT id FROM companion_memory_tag_jobs WHERE companion_id=? AND note_id=?
        AND note_version IN(SELECT version FROM companion_memory_version_revisions WHERE note_id=? AND content_revision=?)`)
        .all(version.companion_id, version.note_id, version.note_id, version.content_revision) as Array<{ id: string }>;
      db.prepare(`UPDATE companion_memory_tag_jobs SET error=NULL,last_failure_error=NULL WHERE companion_id=? AND note_id=?
        AND note_version IN(SELECT version FROM companion_memory_version_revisions WHERE note_id=? AND content_revision=?)`)
        .run(version.companion_id, version.note_id, version.note_id, version.content_revision);
      scrubCompanionJobReceipts(db, version.companion_id, 'tags', tags.map(job => job.id));
    }
  }
}

export function stopCompanionWithdrawnNoteJobs(db: CompanionConnection, owner: string, id: string): void {
  scrubReferencedJobErrors(db, owner, { noteId: id });
  const indices = db.prepare('SELECT id FROM vcp_memory_outbox WHERE companion_id=? AND note_id=?').all(owner, id) as Array<{ id: string }>;
  db.prepare(`UPDATE vcp_memory_outbox SET status=CASE WHEN operation='remember' THEN 'stale' ELSE status END,
    data=json_object('noteId',note_id,'version',note_version),error=NULL,last_failure_error=NULL,lease_token=NULL,lease_until=NULL WHERE companion_id=? AND note_id=?`).run(owner, id);
  scrubCompanionJobReceipts(db, owner, 'index', indices.map(job => job.id));
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_memory_tag_jobs'").get()) {
    const tags = db.prepare('SELECT id FROM companion_memory_tag_jobs WHERE companion_id=? AND note_id=?').all(owner, id) as Array<{ id: string }>;
    db.prepare(`UPDATE companion_memory_tag_jobs SET status='stale',error=NULL,last_failure_error=NULL,lease_token=NULL,lease_until=NULL
      WHERE companion_id=? AND note_id=?`).run(owner, id);
    scrubCompanionJobReceipts(db, owner, 'tags', tags.map(job => job.id));
  }
}
