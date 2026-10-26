import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMemory } from '../shared/companions';
import { companionMemoryHistoryPath, renderCompanionMemoryHistory, type CompanionMemoryHistoryDescriptor, type CompanionMemoryHistoryPayload } from '../shared/companion-memory-history';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionMemoryProcedureValidation } from '../shared/companion-procedure';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type File = { companion_id: string; note_id: string; content_revision: number; body_hash: string; document_hash: string; relative_path: string;
  state: 'pending' | 'published' | 'retracted'; sources: string; dependencies: string };
type Job = File & { id: string; operation: 'publish' | 'retract'; lease_token: string; attempts: number };
const checksum = (text: string) => createHash('sha256').update(text).digest('hex');

export function initializeCompanionMemoryHistory(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_memory_history_files(companion_id TEXT NOT NULL,note_id TEXT NOT NULL,content_revision INTEGER NOT NULL,
    body_hash TEXT NOT NULL,document_hash TEXT NOT NULL,relative_path TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',sources TEXT NOT NULL,dependencies TEXT NOT NULL,
    PRIMARY KEY(note_id,content_revision));
    CREATE INDEX IF NOT EXISTS companion_memory_history_owner ON companion_memory_history_files(companion_id,state);
    CREATE TABLE IF NOT EXISTS companion_memory_history_sources(companion_id TEXT NOT NULL,note_id TEXT NOT NULL,content_revision INTEGER NOT NULL,source_id TEXT NOT NULL,
      PRIMARY KEY(note_id,content_revision,source_id)); CREATE INDEX IF NOT EXISTS companion_memory_history_source ON companion_memory_history_sources(companion_id,source_id);
    CREATE TABLE IF NOT EXISTS companion_memory_history_dependencies(companion_id TEXT NOT NULL,note_id TEXT NOT NULL,content_revision INTEGER NOT NULL,parent_id TEXT NOT NULL,parent_revision INTEGER NOT NULL,
      PRIMARY KEY(note_id,content_revision,parent_id,parent_revision));
    CREATE INDEX IF NOT EXISTS companion_memory_history_dependency_owner ON companion_memory_history_dependencies(companion_id);
    CREATE INDEX IF NOT EXISTS companion_memory_history_parent ON companion_memory_history_dependencies(parent_id,parent_revision);
    CREATE TABLE IF NOT EXISTS companion_memory_history_outbox(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL,note_id TEXT NOT NULL,
      content_revision INTEGER NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_until INTEGER,error TEXT,UNIQUE(note_id,content_revision,operation));
    CREATE INDEX IF NOT EXISTS companion_memory_history_delivery ON companion_memory_history_outbox(companion_id,status,next_attempt,ordinal);`);
  db.prepare("UPDATE companion_memory_history_outbox SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running'").run();
}
export function enqueueCompanionMemoryHistory(db: CompanionConnection, note: CompanionMemory, dependencies: CompanionMemoryHistoryPayload['dependencies'], bodyHash: string): void {
  const documentHash = checksum(renderCompanionMemoryHistory({ memory: note, dependencies }, bodyHash));
  const existing = db.prepare('SELECT body_hash FROM companion_memory_history_files WHERE note_id=? AND content_revision=?').get(note.id, note.contentRevision) as { body_hash: string } | undefined;
  if (existing) { if (existing.body_hash !== bodyHash) throw new Error('历史文件不可变身份冲突。'); return; }
  const sources = note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum, revision: source.revision }));
  db.prepare('INSERT INTO companion_memory_history_files VALUES(?,?,?,?,?,?,\'pending\',?,?)').run(note.companionId, note.id, note.contentRevision,
    bodyHash, documentHash, companionMemoryHistoryPath(note.id, note.contentRevision!, bodyHash), JSON.stringify(sources), JSON.stringify(dependencies));
  for (const source of sources) db.prepare('INSERT INTO companion_memory_history_sources VALUES(?,?,?,?)').run(note.companionId, note.id, note.contentRevision, source.id);
  for (const dependency of dependencies) db.prepare('INSERT INTO companion_memory_history_dependencies VALUES(?,?,?,?,?)').run(note.companionId, note.id, note.contentRevision, dependency.id, dependency.contentRevision);
  db.prepare("INSERT INTO companion_memory_history_outbox(id,companion_id,note_id,content_revision,operation) VALUES(?,?,?,?,'publish')").run(randomUUID(), note.companionId, note.id, note.contentRevision);
}
function retract(db: CompanionConnection, versions: Array<{ companion_id: string; note_id: string; content_revision: number }>): void {
  for (const version of versions) {
    db.prepare("UPDATE companion_memory_history_files SET state='retracted' WHERE note_id=? AND content_revision=?").run(version.note_id, version.content_revision);
    db.prepare("UPDATE companion_memory_history_outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE note_id=? AND content_revision=? AND operation='publish' AND status IN('pending','failed')").run(version.note_id, version.content_revision);
    db.prepare("INSERT OR IGNORE INTO companion_memory_history_outbox(id,companion_id,note_id,content_revision,operation) VALUES(?,?,?,?,'retract')")
      .run(randomUUID(), version.companion_id, version.note_id, version.content_revision);
  }
}
export function retractCompanionMemoryHistorySources(db: CompanionConnection, owner: string, sourceIds: readonly string[]): void {
  if (!sourceIds.length) return;
  const versions = db.prepare(`WITH RECURSIVE affected(note_id,content_revision) AS (
    SELECT note_id,content_revision FROM companion_memory_history_sources WHERE companion_id=? AND source_id IN(SELECT value FROM json_each(?))
    UNION SELECT d.note_id,d.content_revision FROM companion_memory_history_dependencies d JOIN affected a ON a.note_id=d.parent_id AND a.content_revision=d.parent_revision)
    SELECT f.companion_id,f.note_id,f.content_revision FROM affected a JOIN companion_memory_history_files f USING(note_id,content_revision) WHERE f.companion_id=?`)
    .all(owner, JSON.stringify(sourceIds), owner) as Array<{ companion_id: string; note_id: string; content_revision: number }>;
  retract(db, versions);
}
export function forgetCompanionMemoryHistoryNote(db: CompanionConnection, owner: string, id: string): void {
  const versions = db.prepare(`WITH RECURSIVE affected(note_id,content_revision) AS (
    SELECT note_id,content_revision FROM companion_memory_history_files WHERE companion_id=? AND note_id=?
    UNION SELECT d.note_id,d.content_revision FROM companion_memory_history_dependencies d JOIN affected a ON a.note_id=d.parent_id AND a.content_revision=d.parent_revision)
    SELECT f.companion_id,f.note_id,f.content_revision FROM affected a JOIN companion_memory_history_files f USING(note_id,content_revision) WHERE f.companion_id=?`)
    .all(owner, id, owner) as Array<{ companion_id: string; note_id: string; content_revision: number }>;
  retract(db, versions);
}
export class CompanionMemoryHistoryOutboxStore {
  constructor(private readonly db: CompanionConnection, private readonly ports: {
    ownerScope(owner: string): Scope; authorize(scope: Scope, id: string, contentRevision: number): boolean;
    annotations?(scope: Scope, id: string, contentRevision: number): { procedureValidation?: CompanionMemoryProcedureValidation };
  }) {}
  private descriptor(file: File): CompanionMemoryHistoryDescriptor {
    return { companionId: file.companion_id, id: file.note_id, contentRevision: file.content_revision, bodyHash: file.body_hash,
      documentHash: file.document_hash, relativePath: file.relative_path, sources: JSON.parse(file.sources), dependencies: JSON.parse(file.dependencies) };
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type === 'memory.revision.describe') {
      const file = this.db.prepare('SELECT * FROM companion_memory_history_files WHERE companion_id=? AND note_id=? AND content_revision=?')
        .get(command.companionId, command.id, command.contentRevision) as File | undefined;
      if (!file || file.state !== 'published' || !this.ports.authorize(command, command.id, command.contentRevision)) throw new Error('历史记忆文件尚未发布、已撤回或当前范围无权读取。');
      return { ok: true, memoryHistoryDescriptor: { ...this.descriptor(file), ...this.ports.annotations?.(command, command.id, command.contentRevision) } };
    }
    if (command.type === 'memory.history.outbox.owners') {
      const owners = this.db.prepare(`SELECT o.companion_id FROM companion_memory_history_outbox o JOIN companions c ON c.id=o.companion_id
        WHERE c.deleted_at IS NULL AND (o.status IN('pending','failed') AND o.next_attempt<=? OR o.status='running' AND o.lease_until<=?)
        AND o.companion_id NOT IN(SELECT value FROM json_each(?)) GROUP BY o.companion_id ORDER BY MIN(o.ordinal) LIMIT ?`)
        .all(Date.now(), Date.now(), JSON.stringify(command.excludedOwners ?? []), command.limit ?? 4) as Array<{ companion_id: string }>;
      return { ok: true, memoryHistoryPendingOwners: owners.map(owner => owner.companion_id) };
    }
    if (command.type === 'memory.history.outbox.claim') return this.db.transaction(() => {
      const now = Date.now();
      const job = this.db.prepare(`SELECT f.*,o.id,o.operation,o.attempts FROM companion_memory_history_outbox o JOIN companion_memory_history_files f USING(note_id,content_revision)
        WHERE o.companion_id=? AND (o.status IN('pending','failed') AND o.next_attempt<=? OR o.status='running' AND o.lease_until<=?)
        ${command.memoryId ? 'AND o.note_id=?' : ''} ${command.contentRevision ? 'AND o.content_revision=?' : ''} ORDER BY o.ordinal LIMIT 1`)
        .get(command.companionId, now, now, ...(command.memoryId ? [command.memoryId] : []), ...(command.contentRevision ? [command.contentRevision] : [])) as Job | undefined;
      if (!job) return { ok: true };
      const valid = job.state !== 'retracted' && this.ports.authorize(this.ports.ownerScope(job.companion_id), job.note_id, job.content_revision);
      const token = randomUUID(); this.db.prepare("UPDATE companion_memory_history_outbox SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?")
        .run(token, now + (command.leaseMs ?? 120000), job.id);
      const payload = job.operation === 'publish' && valid ? this.db.prepare('SELECT data FROM companion_memory_content_revisions WHERE companion_id=? AND note_id=? AND content_revision=? AND body_hash=?')
        .get(job.companion_id, job.note_id, job.content_revision, job.body_hash) as { data: string } | undefined : undefined;
      if (job.operation === 'publish' && valid && !payload) throw new Error('历史发布缺少已提交的不可变正文。');
      return { ok: true, memoryHistoryOutbox: { id: job.id, companionId: job.companion_id, memoryId: job.note_id, contentRevision: job.content_revision,
        bodyHash: job.body_hash, documentHash: job.document_hash, relativePath: job.relative_path,
        operation: job.operation === 'publish' && valid ? 'publish' as const : 'retract' as const, leaseToken: token, attempts: job.attempts + 1,
        ...(payload ? { payload: JSON.parse(payload.data) } : {}) } };
    }).immediate();
    if (command.type === 'memory.history.outbox.check') {
      const job = this.db.prepare(`SELECT f.*,o.id,o.operation FROM companion_memory_history_outbox o JOIN companion_memory_history_files f USING(note_id,content_revision)
        WHERE o.id=? AND o.status='running' AND o.lease_token=? AND o.lease_until>?`).get(command.id, command.leaseToken, Date.now()) as Job | undefined;
      return { ok: true, memoryHistoryOutboxAccepted: !!job && (job.operation === 'retract' || job.state !== 'retracted'
        && this.ports.authorize(this.ports.ownerScope(job.companion_id), job.note_id, job.content_revision)) };
    }
    if (command.type !== 'memory.history.outbox.complete' && command.type !== 'memory.history.outbox.fail') return;
    return this.db.transaction(() => {
      const job = this.db.prepare(`SELECT f.*,o.id,o.operation,o.attempts FROM companion_memory_history_outbox o JOIN companion_memory_history_files f USING(note_id,content_revision)
        WHERE o.id=? AND o.status='running' AND o.lease_token=? AND o.lease_until>?`).get(command.id, command.leaseToken, Date.now()) as Job | undefined;
      if (!job) throw new Error('历史发布租约已取消或过期。');
      if (command.type === 'memory.history.outbox.fail') {
        this.db.prepare("UPDATE companion_memory_history_outbox SET status='failed',error=?,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE id=?")
          .run(command.error, Date.now() + (command.retryAfterMs ?? 30000), job.id); return { ok: true };
      }
      const accepted = command.documentHash === job.document_hash && (job.operation === 'retract' || job.state !== 'retracted'
        && this.ports.authorize(this.ports.ownerScope(job.companion_id), job.note_id, job.content_revision));
      this.db.prepare("UPDATE companion_memory_history_outbox SET status='done',lease_token=NULL,lease_until=NULL,error=NULL WHERE id=?").run(job.id);
      if (job.operation === 'publish' && accepted) this.db.prepare("UPDATE companion_memory_history_files SET state='published' WHERE note_id=? AND content_revision=?")
        .run(job.note_id, job.content_revision);
      else retract(this.db, [job]);
      return { ok: true, memoryHistoryOutboxAccepted: accepted };
    }).immediate();
  }
}
