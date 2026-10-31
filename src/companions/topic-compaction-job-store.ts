import { companionTopicAncestorIds } from './topic-context';
import { companionTopicCheckpointIndexed, companionTopicCheckpointInputValid, ensureCompanionTopicCheckpointOwnerRead, indexCompanionTopicCheckpoint } from './topic-checkpoint-index';
import { initializeCompanionJobInputReferences, scrubCompanionJobReceipts } from './memory-withdrawal-store';
import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionTopicState } from '../shared/companion-topic';
import { companionTopicSchema } from '../shared/companion-topic';
import { companionTopicCompactionCommandSchema, companionTopicCompactionJobSchema, type CompanionTopicCompactionCommand, type CompanionTopicCompactionJob } from '../shared/companion-topic-compaction-jobs';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { COMPANION_JOB_FAILURES_PER_CYCLE, type CompanionJobDisposition } from '../shared/companion-job-control';
import { companionJobInputVersion, initializeCompanionJobDisposition, pageCompanionJobIds, type CompanionJobControlAdapter } from './job-control-store';

type Scope = { companionId: string; conversationId: string; topicId: string };
type Row = { id: string; companion_id: string; conversation_id: string; topic_id: string; status: CompanionJobDisposition['state'];
  source_message_id: string; source_revision: number; source_checksum: string; requested_through: number; checked_through: number;
  requested_publication_revision: number; checked_publication_revision: number; claimed_publication_revision: number | null;
  claimed_through: number | null; claimed_source_message_id: string | null; claimed_source_revision: number | null; claimed_source_checksum: string | null;
  attempts: number; failure_count: number; cycle_failure_count: number; disposition_revision: number; next_attempt: number;
  lease_token: string | null; lease_until: number | null; last_failure_at: string | null; last_failure_error: string | null;
  last_checkpoint_event_id: string | null; error: string | null; bound_acl_revision: string | null; reconcile_needed: number; reconcile_cursor_publication: number | null };
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = (row: Row): Scope => ({ companionId: row.companion_id, conversationId: row.conversation_id, topicId: row.topic_id });

/** Scheduling metadata only. Original messages and formal topic checkpoints
 * stay with their existing ACL, immutable DAG and publication transactions. */
export class CompanionTopicCompactionJobStore {
  constructor(private readonly db: CompanionConnection,
    private readonly source: (scope: Scope, id: string) => CompanionMessage | undefined,
    private readonly state: (scope: Scope) => CompanionTopicState | undefined,
    private readonly checkpointSourcesValid: (scope: Scope, ids: readonly string[]) => boolean,
    private readonly prohibitionRevision: (scope: Scope) => string) {}

  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_topic_compaction_jobs(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,topic_id TEXT NOT NULL,source_message_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_checksum TEXT NOT NULL,
      requested_through INTEGER NOT NULL,checked_through INTEGER NOT NULL DEFAULT 0,claimed_through INTEGER,
      requested_publication_revision INTEGER NOT NULL DEFAULT 0,checked_publication_revision INTEGER NOT NULL DEFAULT 0,claimed_publication_revision INTEGER,
      claimed_source_message_id TEXT,claimed_source_revision INTEGER,claimed_source_checksum TEXT,
      status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_served INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_until INTEGER,error TEXT,last_checkpoint_event_id TEXT,bound_acl_revision TEXT,
      reconcile_needed INTEGER NOT NULL DEFAULT 0,reconcile_cursor_publication INTEGER,
      UNIQUE(companion_id,conversation_id,topic_id));
      CREATE INDEX IF NOT EXISTS companion_topic_compaction_claim ON companion_topic_compaction_jobs(status,next_attempt,last_served,ordinal);
      CREATE INDEX IF NOT EXISTS companion_topic_compaction_reconcile ON companion_topic_compaction_jobs(status,reconcile_needed,next_attempt,last_served,ordinal);
      CREATE INDEX IF NOT EXISTS companion_topic_compaction_turn ON companion_topic_compaction_jobs(last_served);
      CREATE INDEX IF NOT EXISTS companion_topic_compaction_lease ON companion_topic_compaction_jobs(status,lease_until);
      CREATE INDEX IF NOT EXISTS companion_topic_compaction_source ON companion_topic_compaction_jobs(companion_id,source_message_id,source_revision,source_checksum);
      CREATE INDEX IF NOT EXISTS companion_topic_compaction_claimed_source ON companion_topic_compaction_jobs(companion_id,claimed_source_message_id,claimed_source_revision,claimed_source_checksum);`);
    initializeCompanionJobDisposition(this.db, 'companion_topic_compaction_jobs');
    initializeCompanionJobInputReferences(this.db);
    // A crashed provider request has an unknown outcome. It needs explicit
    // inspection/resume, not an automatic repeat merely because Main restarted.
    this.db.prepare("UPDATE companion_topic_compaction_jobs SET status='parked',lease_token=NULL,lease_until=NULL,next_attempt=0,error='整理中断，先核对已发布检查点再明确恢复。' WHERE status='running'").run();
  }

  private read(id: string): Row | undefined { return this.db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(id) as Row | undefined; }
  private lawful(value: Scope, active = false): boolean {
    const found = this.db.prepare(`SELECT t.data FROM companion_topics t
      JOIN conversations r ON r.id=t.conversation_id AND r.dissolved_at IS NULL
      JOIN conversation_members m ON m.conversation_id=r.id AND m.companion_id=?
      JOIN companions c ON c.id=m.companion_id AND c.deleted_at IS NULL
      WHERE t.id=? AND t.conversation_id=?
        AND NOT EXISTS(SELECT 1 FROM companion_topic_participation p WHERE p.topic_id=t.id AND p.reader_id=m.companion_id AND p.status='paused')
        AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs d WHERE d.companion_id=c.id AND d.status!='completed') ${active ? "AND json_extract(c.data,'$.active')=1" : ''}`)
      .get(value.companionId, value.topicId, value.conversationId) as { data: string } | undefined;
    if (!found) return false;
    const topic = companionTopicSchema.parse(JSON.parse(found.data));
    return !topic.deletedAt && topic.status === 'active' && topic.participantIds.includes(value.companionId);
  }
  private actual(value: Scope, id: string): { message: CompanionMessage; revision: number; hash: string } | undefined {
    const message = this.source(value, id);
    if (!message || message.conversationId !== value.conversationId || message.topicId !== value.topicId
      || message.status !== 'sent' || message.isReplyDraft || message.replyDraft || !message.content.trim()) return;
    const original = this.db.prepare('SELECT revision FROM messages WHERE id=? AND conversation_id=?').get(id, value.conversationId) as { revision: number } | undefined;
    return original ? { message, revision: original.revision, hash: checksum(message.content) } : undefined;
  }
  private version(row: Row): string { return companionJobInputVersion(['topic_compaction', row.companion_id, row.conversation_id, row.topic_id]); }
  private project(row: Row): CompanionTopicCompactionJob {
    return companionTopicCompactionJobSchema.parse({ id: row.id, ...scope(row),
      sourceMessageId: row.status === 'running' ? row.claimed_source_message_id : row.source_message_id,
      requestedThroughSequence: row.requested_through, checkedThroughSequence: row.checked_through,
      requestedPublicationRevision: row.requested_publication_revision, checkedPublicationRevision: row.checked_publication_revision,
      ...(row.claimed_publication_revision !== null ? { claimedPublicationRevision: row.claimed_publication_revision } : {}),
      ...(row.claimed_through !== null ? { claimedThroughSequence: row.claimed_through } : {}),
      attempts: row.attempts, status: row.status, revision: row.disposition_revision, inputVersion: this.version(row),
      ...(row.lease_token ? { leaseToken: row.lease_token } : {}) });
  }
  private valid(row: Row, token: string, active = true): boolean {
    if (row.status !== 'running' || row.lease_token !== token || (row.lease_until ?? 0) <= Date.now()) return false;
    if (!this.lawful(scope(row), active) || !row.claimed_source_message_id) return false;
    const source = this.actual(scope(row), row.claimed_source_message_id);
    return !!source && source.message.sequence <= (row.claimed_through ?? 0) && source.revision === row.claimed_source_revision && source.hash === row.claimed_source_checksum && this.boundCurrent(row);
  }
  private aclRevision(row: Row): string {
    const state = this.db.prepare('SELECT revocation_epoch FROM companion_memory_lifecycle_state WHERE companion_id=?').get(row.companion_id) as { revocation_epoch: number } | undefined;
    return companionJobInputVersion([state?.revocation_epoch ?? 0, this.prohibitionRevision(scope(row))]);
  }
  private boundCurrent(row: Row): boolean {
    const refs = this.db.prepare("SELECT input_kind,input_id,revision,checksum FROM companion_job_input_refs WHERE owner_id=? AND kind='topic_compaction' AND job_id=?")
      .all(row.companion_id, row.id) as Array<{ input_kind: string; input_id: string; revision: number; checksum: string }>;
    if (refs.length && row.bound_acl_revision !== this.aclRevision(row)) return false;
    for (const ref of refs) {
      if (ref.input_kind === 'topic_checkpoint') {
        if (!companionTopicCheckpointInputValid(this.db, row.companion_id, ref.input_id, ref.checksum)) return false;
      } else if (ref.input_kind === 'source') {
        const source = this.actual(scope(row), ref.input_id);
        if (!source || source.message.sequence > (row.claimed_through ?? 0) || source.revision !== ref.revision || source.hash !== ref.checksum) return false;
      } else return false;
    }
    return true;
  }
  private bind(row: Row, input: Extract<CompanionTopicCompactionCommand, { type: 'topic.compaction.bind' }>): boolean {
    if (!this.publicationValid({ id: row.id, leaseToken: input.leaseToken }, scope(row), { sourceMessageIds: input.sources.map(source => source.id) }, false)) return false;
    for (const reference of input.sources) {
      const source = this.actual(scope(row), reference.id);
      if (!source || source.revision !== reference.revision || source.hash !== reference.checksum) return false;
    }
    const heads = this.db.prepare("SELECT data FROM companion_topic_state WHERE topic_id=? AND reader_id IN(?,'*')").all(row.topic_id, row.companion_id) as Array<{ data: string }>;
    const allowed = new Set(heads.map(head => (JSON.parse(head.data) as { sourceEventId: string }).sourceEventId));
    const aclRevision = this.aclRevision(row);
    const topicRow = this.db.prepare('SELECT data FROM companion_topics WHERE id=?').get(row.topic_id) as { data: string };
    const topics = companionTopicAncestorIds(this.db, companionTopicSchema.parse(JSON.parse(topicRow.data))); if (!topics) return false;
    const checkpoints: Array<{ id: string; hash: string }> = [];
    for (const id of input.checkpointEventIds) {
      if (!allowed.has(id) || !companionTopicCheckpointIndexed(this.db, id) && !indexCompanionTopicCheckpoint(this.db, id)
        || !ensureCompanionTopicCheckpointOwnerRead(this.db, row.companion_id, id, topics, aclRevision, ids => this.checkpointSourcesValid(scope(row), ids))) return false;
      const node = this.db.prepare('SELECT body_hash FROM companion_topic_checkpoint_nodes WHERE event_id=?').get(id) as { body_hash: string };
      checkpoints.push({ id, hash: node.body_hash });
    }
    const insert = this.db.prepare("INSERT OR IGNORE INTO companion_job_input_refs(owner_id,kind,job_id,input_kind,input_id,revision,checksum) VALUES(?,'topic_compaction',?,?,?,?,?)");
    for (const reference of input.sources) insert.run(row.companion_id, row.id, 'source', reference.id, reference.revision, reference.checksum);
    for (const checkpoint of checkpoints) insert.run(row.companion_id, row.id, 'topic_checkpoint', checkpoint.id, 0, checkpoint.hash);
    this.db.prepare('UPDATE companion_topic_compaction_jobs SET bound_acl_revision=? WHERE id=? AND lease_token=?').run(aclRevision, row.id, input.leaseToken);
    return true;
  }
  private invalidate(row: Row): void {
    this.db.prepare("UPDATE companion_topic_compaction_jobs SET status='stale',lease_token=NULL,lease_until=NULL,next_attempt=0,error=NULL,reconcile_needed=1,reconcile_cursor_publication=requested_publication_revision+1 WHERE id=? AND status='running' AND lease_token=?")
      .run(row.id, row.lease_token);
  }
  private checked(id: string, token: string, active = true): Row | undefined {
    const row = this.read(id); if (!row || row.status !== 'running' || row.lease_token !== token || (row.lease_until ?? 0) <= Date.now()) return;
    if (!this.valid(row, token, active)) {
      // Inactivation suspends dispatch, but preserves the exact live lease long
      // enough for Main to classify a known unsent wait or unknown sent result.
      if (active && this.valid(row, token, false)) return;
      this.invalidate(row); return;
    } return row;
  }

  sourcePageValid(guard: { id: string; leaseToken: string }, value: Scope & { beforeSequence: number;
    throughPublicationRevision?: number; sourceMessageId?: string; sourceChecksum?: string }): boolean {
    const row = this.read(guard.id);
    return !!row && row.companion_id === value.companionId && row.conversation_id === value.conversationId && row.topic_id === value.topicId
      && row.claimed_through === value.beforeSequence && typeof value.throughPublicationRevision === 'number'
      && Number.isSafeInteger(value.throughPublicationRevision) && value.throughPublicationRevision >= 0 && value.throughPublicationRevision <= (row.claimed_publication_revision ?? 0)
      && row.claimed_source_message_id === value.sourceMessageId && row.claimed_source_checksum === value.sourceChecksum && this.valid(row, guard.leaseToken);
  }

  publicationValid(guard: { id: string; leaseToken: string }, value: Scope,
    publication: { sourceMessageIds: readonly string[]; continuity?: unknown; checkpointEventIds?: readonly string[] }, requireBound = true): boolean {
    const row = this.read(guard.id);
    if (!row || row.companion_id !== value.companionId || row.conversation_id !== value.conversationId || row.topic_id !== value.topicId || !this.valid(row, guard.leaseToken)) return false;
    if (requireBound && (!row.bound_acl_revision || !this.db.prepare("SELECT 1 FROM companion_job_input_refs WHERE owner_id=? AND kind='topic_compaction' AND job_id=? AND input_kind='source' LIMIT 1").get(row.companion_id, row.id))) return false;
    const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const continuity = object(publication.continuity), coverage = object(continuity?.publicationCoverage);
    if (continuity && (continuity.topicId !== value.topicId || continuity.companionId !== value.companionId || continuity.conversationId !== value.conversationId
      || typeof continuity.throughSequence !== 'number' || !Number.isSafeInteger(continuity.throughSequence) || continuity.throughSequence < 0 || continuity.throughSequence > (row.claimed_through ?? 0))) return false;
    if (coverage && (typeof coverage.publicationRevision !== 'number' || !Number.isSafeInteger(coverage.publicationRevision)
      || coverage.publicationRevision < 0 || coverage.publicationRevision > (row.claimed_publication_revision ?? 0))) return false;
    if (requireBound) for (const id of publication.checkpointEventIds ?? []) if (!this.db.prepare("SELECT 1 FROM companion_job_input_refs WHERE owner_id=? AND kind='topic_compaction' AND job_id=? AND input_kind='topic_checkpoint' AND input_id=?").get(row.companion_id, row.id, id)) return false;
    for (const id of publication.sourceMessageIds) {
      if (requireBound && id !== row.claimed_source_message_id && !this.db.prepare("SELECT 1 FROM companion_job_input_refs WHERE owner_id=? AND kind='topic_compaction' AND job_id=? AND input_kind='source' AND input_id=?").get(row.companion_id, row.id, id)) return false;
      const source = this.db.prepare('SELECT sequence FROM messages WHERE id=? AND conversation_id=?').get(id, value.conversationId) as { sequence: number } | undefined;
      if (!source || source.sequence > (row.claimed_through ?? 0)) return false;
      const saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-topic-publication/' + id) as { value: string } | undefined;
      if (saved) {
        const actual = object(JSON.parse(saved.value));
        if (!actual || actual.topicId !== value.topicId || typeof actual.revision !== 'number' || !Number.isSafeInteger(actual.revision)
          || actual.revision < 1 || actual.revision > (row.claimed_publication_revision ?? 0)) return false;
      }
    }
    return true;
  }

  jobControlAdapter(): CompanionJobControlAdapter {
    const read = (ownerId: string, id: string): CompanionJobDisposition | undefined => {
      const row = this.read(id); if (!row || row.companion_id !== ownerId) return;
      return { ownerId, kind: 'topic_compaction', id, inputVersion: this.version(row), revision: row.disposition_revision,
        state: row.status, failureCount: row.failure_count, cycleFailureCount: row.cycle_failure_count, attemptCount: row.attempts,
        processorId: id, conversationId: row.conversation_id, topicId: row.topic_id,
        sourceMessageId: row.status === 'running' ? row.claimed_source_message_id ?? row.source_message_id : row.source_message_id,
        ...(row.last_failure_at ? { lastErrorAt: row.last_failure_at } : {}), ...(row.last_failure_error || row.error ? { lastError: row.last_failure_error ?? row.error! } : {}) };
    };
    return { read, page: input => {
      const ids = pageCompanionJobIds(this.db, 'companion_topic_compaction_jobs', input), selected = ids.slice(0, input.limit);
      return { items: selected.map(id => read(input.ownerId, id)!), hasMore: ids.length > input.limit,
        ...(ids.length > input.limit && selected.length ? { nextId: selected.at(-1)! } : {}) };
    }, transition: (current, action) => {
      const row = this.read(current.id); if (!row) throw new Error('话题整理作业已不存在。');
      if (action === 'resume' && (!this.lawful(scope(row)) || row.reconcile_needed !== 1 && !this.actual(scope(row), row.source_message_id))) throw new Error('话题或固定来源已经失效，不能恢复旧整理。');
      const reconcile = action === 'resume' && row.reconcile_needed === 1;
      this.db.prepare(`UPDATE companion_topic_compaction_jobs SET status=?,cycle_failure_count=?,disposition_revision=disposition_revision+1,
        lease_token=NULL,lease_until=NULL,next_attempt=?,reconcile_needed=?,reconcile_cursor_publication=CASE WHEN ? THEN reconcile_cursor_publication ELSE NULL END WHERE id=? AND companion_id=? AND disposition_revision=?`)
        .run(action === 'resume' ? 'pending' : action === 'park' ? 'parked' : 'abandoned', action === 'resume' ? 0 : current.cycleFailureCount, Date.now(), reconcile ? 1 : 0, reconcile ? 1 : 0, current.id, current.ownerId, current.revision);
      const next = read(current.ownerId, current.id); if (!next) throw new Error('话题整理作业已不存在。'); return next;
    } };
  }

  private enqueue(command: Extract<CompanionTopicCompactionCommand, { type: 'topic.compaction.enqueue' }>): CompanionStorageResponse {
    if (!this.lawful(command)) throw new Error('话题不属于当前伙伴或聊天，不能登记整理。');
    const source = this.actual(command, command.sourceMessageId); if (!source) throw new Error('话题整理只能登记实际可读的正式消息来源。');
    const id = 'topic_compact_' + checksum([command.companionId, command.conversationId, command.topicId].join('\n')).slice(0, 48);
    const before = this.read(id), topic = this.db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(command.topicId, command.conversationId) as { data: string };
    const publication = companionTopicSchema.parse(JSON.parse(topic.data)).formalPublicationRevision ?? 0;
    if (!before) this.db.prepare(`INSERT INTO companion_topic_compaction_jobs(id,companion_id,conversation_id,topic_id,source_message_id,source_revision,source_checksum,requested_through,requested_publication_revision)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, command.companionId, command.conversationId, command.topicId, source.message.id, source.revision, source.hash, source.message.sequence, publication);
    else if (publication > before.requested_publication_revision || before.status === 'stale' || source.message.sequence > before.requested_through || source.message.sequence === before.requested_through && (source.revision !== before.source_revision || source.hash !== before.source_checksum)) {
      const state = ['completed', 'cancelled', 'stale'].includes(before.status) ? 'pending' : before.status;
      this.db.prepare(`UPDATE companion_topic_compaction_jobs SET requested_through=MAX(requested_through,?),requested_publication_revision=MAX(requested_publication_revision,?),source_message_id=?,source_revision=?,source_checksum=?,status=?,
        disposition_revision=disposition_revision+1,reconcile_needed=CASE WHEN status='stale' THEN 0 ELSE reconcile_needed END,
        reconcile_cursor_publication=CASE WHEN status='stale' THEN NULL ELSE reconcile_cursor_publication END,
        next_attempt=CASE WHEN status IN('completed','cancelled','stale') THEN 0 ELSE next_attempt END WHERE id=?`)
        .run(source.message.sequence, publication, source.message.id, source.revision, source.hash, state, id);
    }
    return { ok: true, topicCompactionJob: this.project(this.read(id)!), jobDisposition: this.jobControlAdapter().read(command.companionId, id) };
  }

  private reconcile(excludedOwners: readonly string[]): void {
    const excluded = excludedOwners.length ? `AND j.companion_id NOT IN(${excludedOwners.map(() => '?').join(',')})` : '';
    const jobs = this.db.prepare(`SELECT j.* FROM companion_topic_compaction_jobs j INDEXED BY companion_topic_compaction_reconcile
      JOIN companions c ON c.id=j.companion_id AND c.deleted_at IS NULL AND json_extract(c.data,'$.active')=1
      WHERE j.status='stale' AND j.reconcile_needed=1 AND j.next_attempt<=? ${excluded}
      ORDER BY j.next_attempt,j.last_served,j.ordinal LIMIT 8`).all(Date.now(), ...excludedOwners) as Row[];
    for (const job of jobs) {
      const turn = (this.db.prepare('SELECT COALESCE(MAX(last_served),0)+1 AS n FROM companion_topic_compaction_jobs').get() as { n: number }).n;
      if (!this.lawful(scope(job), true)) {
        // Scope permission can return after an explicit topic resume. Preserve
        // its debt, but move this unavailable head behind other ready scopes.
        this.db.prepare("UPDATE companion_topic_compaction_jobs SET next_attempt=?,last_served=? WHERE id=? AND status='stale' AND reconcile_needed=1")
          .run(Date.now() + 5000, turn, job.id);
        continue;
      }
      const cursor = Math.min(job.reconcile_cursor_publication ?? job.requested_publication_revision + 1, job.requested_publication_revision + 1);
      const page = this.db.prepare(`SELECT key,value FROM metadata INDEXED BY companion_topic_publication_page
        WHERE key GLOB 'message-topic-publication/*' AND json_extract(value,'$.topicId')=?
        AND CAST(json_extract(value,'$.revision') AS INTEGER)<? ORDER BY CAST(json_extract(value,'$.revision') AS INTEGER) DESC LIMIT 32`)
        .all(job.topic_id, cursor) as Array<{ key: string; value: string }>;
      let selected: { message: CompanionMessage; revision: number; hash: string } | undefined, through = cursor;
      for (const item of page) {
        const reference = JSON.parse(item.value) as { revision: number; checksum: string };
        through = Math.min(through, reference.revision);
        const id = item.key.slice('message-topic-publication/'.length), actual = this.actual(scope(job), id);
        if (actual && actual.message.sequence <= job.requested_through && actual.hash === reference.checksum) { selected = actual; break; }
      }
      if (selected) this.db.prepare(`UPDATE companion_topic_compaction_jobs SET status='pending',source_message_id=?,source_revision=?,source_checksum=?,
        reconcile_needed=0,reconcile_cursor_publication=NULL,next_attempt=?,last_served=? WHERE id=? AND status='stale' AND reconcile_needed=1`)
        .run(selected.message.id, selected.revision, selected.hash, Date.now(), turn, job.id);
      else if (page.length < 32) this.db.prepare(`UPDATE companion_topic_compaction_jobs SET status='cancelled',reconcile_needed=0,reconcile_cursor_publication=NULL,
        lease_token=NULL,lease_until=NULL,error='已请求范围内没有仍可读取的正式来源；原事件保留。',next_attempt=0,last_served=? WHERE id=? AND status='stale' AND reconcile_needed=1`).run(turn, job.id);
      else this.db.prepare(`UPDATE companion_topic_compaction_jobs SET reconcile_cursor_publication=?,next_attempt=?,last_served=? WHERE id=? AND status='stale' AND reconcile_needed=1`)
        .run(through, Date.now(), turn, job.id);
    }
  }

  private claim(command: Extract<CompanionTopicCompactionCommand, { type: 'topic.compaction.claim' }>): CompanionStorageResponse {
    this.db.prepare("UPDATE companion_topic_compaction_jobs SET status='stale' WHERE status='pending' AND reconcile_needed=1").run();
    this.reconcile(command.excludedCompanionIds);
    this.db.prepare("UPDATE companion_topic_compaction_jobs SET status='parked',lease_token=NULL,lease_until=NULL,next_attempt=0,error='整理租约到期，结果未知，需核对后明确恢复。' WHERE status='running' AND lease_until<=?").run(Date.now());
    const excluded = command.excludedCompanionIds.length ? `AND j.companion_id NOT IN(${command.excludedCompanionIds.map(() => '?').join(',')})` : '';
    // Two small indexed heads prevent settled history or one poisoned owner
    // from turning every claim into an unbounded source/body scan.
    for (let skipped = 0; skipped < 50; skipped++) {
      const candidates = ['pending', 'failed'].flatMap(status => {
        const found = this.db.prepare(`SELECT j.* FROM companion_topic_compaction_jobs j INDEXED BY companion_topic_compaction_claim
          JOIN companions c ON c.id=j.companion_id AND c.deleted_at IS NULL AND json_extract(c.data,'$.active')=1
          WHERE j.status=? AND j.next_attempt<=? ${excluded} ORDER BY j.next_attempt,j.last_served,j.ordinal LIMIT 1`)
          .get(status, Date.now(), ...command.excludedCompanionIds) as (Row & { ordinal: number; last_served: number }) | undefined;
        return found ? [found] : [];
      }).sort((a, b) => a.next_attempt - b.next_attempt || a.last_served - b.last_served || a.ordinal - b.ordinal);
      const row = candidates[0]; if (!row) return { ok: true };
      const source = this.lawful(scope(row), true) ? this.actual(scope(row), row.source_message_id) : undefined;
      if (!source || source.revision !== row.source_revision || source.hash !== row.source_checksum) {
        this.db.prepare("UPDATE companion_topic_compaction_jobs SET status='stale',error=NULL,reconcile_needed=1,reconcile_cursor_publication=requested_publication_revision+1,next_attempt=0 WHERE id=? AND status IN('pending','failed')").run(row.id); continue;
      }
      // Old diagnostics and their receipts are redacted before replacing the
      // prior lease's input set. A held lease never reaches this path.
      scrubCompanionJobReceipts(this.db, row.companion_id, 'topic_compaction', [row.id]);
      this.db.prepare("DELETE FROM companion_job_input_refs WHERE owner_id=? AND kind='topic_compaction' AND job_id=?").run(row.companion_id, row.id);
      this.db.prepare('UPDATE companion_topic_compaction_jobs SET error=NULL,last_failure_error=NULL,bound_acl_revision=NULL,reconcile_needed=0,reconcile_cursor_publication=NULL WHERE id=?').run(row.id);
      const token = randomUUID(), turn = (this.db.prepare('SELECT COALESCE(MAX(last_served),0)+1 AS n FROM companion_topic_compaction_jobs').get() as { n: number }).n;
      this.db.prepare(`UPDATE companion_topic_compaction_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,last_served=?,
        claimed_through=requested_through,claimed_publication_revision=requested_publication_revision,claimed_source_message_id=source_message_id,claimed_source_revision=source_revision,claimed_source_checksum=source_checksum
        WHERE id=? AND status=?`).run(token, Date.now() + command.leaseMs, turn, row.id, row.status);
      return { ok: true, topicCompactionJob: this.project(this.read(row.id)!) };
    }
    return { ok: true };
  }

  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!['topic.compaction.enqueue', 'topic.compaction.claim', 'topic.compaction.bind', 'topic.compaction.check', 'topic.compaction.settle', 'topic.compaction.fail'].includes(command.type)) return;
    const input = companionTopicCompactionCommandSchema.parse(command);
    return this.db.transaction(() => {
      if (input.type === 'topic.compaction.enqueue') return this.enqueue(input);
      if (input.type === 'topic.compaction.claim') return this.claim(input);
      if (input.type !== 'topic.compaction.bind' && input.type !== 'topic.compaction.check' && input.type !== 'topic.compaction.settle' && input.type !== 'topic.compaction.fail') throw new Error('未知话题整理命令。');
      const row = this.checked(input.id, input.leaseToken, input.type !== 'topic.compaction.fail');
      if (input.type === 'topic.compaction.bind') return { ok: true, ...(row && this.bind(row, input) ? { topicCompactionJob: this.project(row) } : {}) };
      if (input.type === 'topic.compaction.check') {
        if (row && input.extendLeaseMs !== undefined) this.db.prepare("UPDATE companion_topic_compaction_jobs SET lease_until=MAX(lease_until,?) WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").run(Date.now() + input.extendLeaseMs, row.id, input.leaseToken, Date.now());
        return { ok: true, ...(row ? { topicCompactionJob: this.project(row) } : {}) };
      }
      if (!row) {
        if (input.type === 'topic.compaction.fail') return { ok: true };
        throw new Error('话题整理租约已失效，旧结果不能结算。');
      }
      if (input.type === 'topic.compaction.fail') {
        const processing = input.failureKind === 'processing' && !input.unknownOutcome, failures = row.cycle_failure_count + (processing ? 1 : 0);
        const status = input.unknownOutcome ? 'parked' : processing ? failures >= COMPANION_JOB_FAILURES_PER_CYCLE ? 'parked' : 'failed'
          : input.failureKind === 'waiting' ? 'pending' : input.failureKind;
        this.db.prepare(`UPDATE companion_topic_compaction_jobs SET status=?,failure_count=failure_count+?,cycle_failure_count=?,
          last_failure_at=CASE WHEN ? THEN ? ELSE last_failure_at END,last_failure_error=CASE WHEN ? THEN ? ELSE last_failure_error END,
          error=?,next_attempt=?,lease_token=NULL,lease_until=NULL,reconcile_needed=?,reconcile_cursor_publication=CASE WHEN ? THEN requested_publication_revision+1 ELSE NULL END WHERE id=? AND status='running' AND lease_token=?`)
          .run(status, processing ? 1 : 0, failures, processing ? 1 : 0, new Date().toISOString(), processing ? 1 : 0, input.error,
            input.error, Date.now() + input.retryAfterMs, status === 'stale' ? 1 : 0, status === 'stale' ? 1 : 0, row.id, input.leaseToken);
      } else {
        const current = this.state(scope(row));
        if (input.checkpointEventId && current?.workingState?.sourceEventId !== input.checkpointEventId) throw new Error('话题整理检查点已经变化，旧结果未结算。');
        if (input.hasMore && (!input.checkpointEventId || input.checkpointEventId === row.last_checkpoint_event_id
          || !current?.workingState?.state?.__continuity)) throw new Error('话题整理没有新的正式进度，不能虚报继续推进。');
        const more = input.hasMore || row.requested_through > (row.claimed_through ?? 0) || row.requested_publication_revision > (row.claimed_publication_revision ?? 0);
        this.db.prepare(`UPDATE companion_topic_compaction_jobs SET status=?,checked_publication_revision=CASE WHEN ? THEN checked_publication_revision ELSE MAX(checked_publication_revision,claimed_publication_revision) END,checked_through=CASE WHEN ? THEN checked_through ELSE MAX(checked_through,claimed_through) END,
          last_checkpoint_event_id=COALESCE(?,last_checkpoint_event_id),lease_token=NULL,lease_until=NULL,next_attempt=?,error=NULL
          WHERE id=? AND status='running' AND lease_token=?`).run(more ? 'pending' : 'completed', input.hasMore ? 1 : 0, input.hasMore ? 1 : 0,
            input.checkpointEventId ?? null, Date.now(), row.id, input.leaseToken);
      }
      const next = this.read(row.id)!;
      return { ok: true, topicCompactionJob: this.project(next), jobDisposition: this.jobControlAdapter().read(row.companion_id, row.id) };
    }).immediate();
  }
}
