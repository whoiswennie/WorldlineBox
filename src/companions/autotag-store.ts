import { createHash, randomUUID } from 'node:crypto';
import type { CompanionMemory } from '../shared/companions';
import type { CompanionMemoryTagJob } from '../shared/companion-memory-tags';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionConnection } from './store';
import { initializeMemoryProcessingJournal } from './memory-processing-store';

type Job = { id: string; companion_id: string; note_id: string; note_version: number; content_hash: string; status: string;
  attempts: number; lease_token?: string; lease_until?: number; prohibition_revision?: string; error?: string };
const checksum = (content: string) => createHash('sha256').update(content).digest('hex');
const eligible = (note: CompanionMemory) => note.captureMethod === 'manual' && note.metadata?.autoTags !== false && !note.tags.length
  && ['queued', 'indexed'].includes(note.status) && (note.metadata?.manualDocument === true || note.sources.some(source => source.sourceType === 'manual_input'));

/** TagMaster delivery only. This queue neither captures experiences nor invents tags locally. */
export class CompanionMemoryTagStore {
  constructor(private readonly db: CompanionConnection,
    private readonly memory: (command: CompanionStorageCommand) => CompanionStorageResponse | undefined) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_memory_tag_jobs(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL,note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,
      note_version INTEGER NOT NULL,content_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,prohibition_revision TEXT,error TEXT,created_at TEXT,updated_at TEXT,
      UNIQUE(note_id,note_version));
      CREATE INDEX IF NOT EXISTS companion_memory_tag_pending ON companion_memory_tag_jobs(status,next_attempt,ordinal);
      CREATE INDEX IF NOT EXISTS companion_memory_tag_owner ON companion_memory_tag_jobs(companion_id,note_id,ordinal);
      CREATE INDEX IF NOT EXISTS companion_memory_tag_untagged ON vcp_memory_notes(companion_id)
        WHERE json_extract(data,'$.captureMethod')='manual' AND json_array_length(json_extract(data,'$.tags'))=0
        AND json_extract(data,'$.status') IN('queued','indexed');`);
    initializeMemoryProcessingJournal(this.db, ['tags']);
  }
  observe(note: CompanionMemory): void {
    if (!eligible(note)) return;
    this.db.prepare('INSERT OR IGNORE INTO companion_memory_tag_jobs(id,companion_id,note_id,note_version,content_hash) VALUES(?,?,?,?,?)')
      .run(randomUUID(), note.companionId, note.id, note.version, checksum(note.content));
  }
  private discover(owner?: string): void {
    const notes = this.db.prepare(`SELECT n.data FROM vcp_memory_notes n WHERE json_extract(n.data,'$.captureMethod')='manual'
      AND json_array_length(json_extract(n.data,'$.tags'))=0 AND json_extract(n.data,'$.status') IN('queued','indexed')
      AND COALESCE(json_extract(n.data,'$.metadata.autoTags'),1)!=0
      AND (json_extract(n.data,'$.metadata.manualDocument')=1 OR EXISTS(SELECT 1 FROM json_each(n.data,'$.sources') s WHERE json_extract(s.value,'$.sourceType')='manual_input'))
      ${owner ? 'AND n.companion_id=?' : ''}
      AND NOT EXISTS(SELECT 1 FROM companion_memory_tag_jobs j WHERE j.note_id=n.id AND j.note_version=json_extract(n.data,'$.version'))
      ORDER BY n.rowid LIMIT 32`).all(...(owner ? [owner] : [])) as Array<{ data: string }>;
    for (const note of notes) this.observe(JSON.parse(note.data) as CompanionMemory);
  }
  private current(job: Job): CompanionMemory | undefined {
    try { return this.memory({ type: 'memory.library.read', companionId: job.companion_id, id: job.note_id, sourceLimit: 1 })?.memoryRead?.memory; }
    catch { return undefined; }
  }
  private valid(job: Job, note?: CompanionMemory): note is CompanionMemory {
    return !!note && note.companionId === job.companion_id && note.version === job.note_version && eligible(note) && checksum(note.content) === job.content_hash;
  }
  private finish(id: string, status: string, error?: string): void {
    this.db.prepare('UPDATE companion_memory_tag_jobs SET status=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=?').run(status, error ?? null, id);
  }
  private policy(note: CompanionMemory): string {
    return this.memory({ type: 'memory.prohibitions', companionId: note.companionId, conversationId: note.sourceConversationId, noteId: note.id })?.memoryProhibitionRevision ?? '';
  }
  private claim(leaseMs: number): CompanionMemoryTagJob | undefined {
    return this.db.transaction(() => {
      this.discover(); const now = Date.now();
      this.db.prepare("UPDATE companion_memory_tag_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
      const jobs = this.db.prepare(`SELECT j.* FROM companion_memory_tag_jobs j JOIN companions c ON c.id=j.companion_id
        WHERE c.deleted_at IS NULL AND j.status IN('pending','waiting_model','failed') AND j.next_attempt<=?
        AND (j.attempts<8 OR j.status='waiting_model')
        AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=j.companion_id AND r.status!='completed')
        ORDER BY j.ordinal LIMIT 32`).all(now) as Job[];
      for (const job of jobs) {
        const note = this.current(job); if (!this.valid(job, note)) { this.finish(job.id, 'stale', '文档已修订、遗忘或已有手工标签。'); continue; }
        const token = randomUUID(), policy = this.policy(note);
        this.db.prepare("UPDATE companion_memory_tag_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,prohibition_revision=?,error=NULL WHERE id=?")
          .run(token, now + leaseMs, policy, job.id);
        return { id: job.id, leaseToken: token, companionId: note.companionId, noteId: note.id, version: note.version, content: note.content, attempts: job.attempts + 1 };
      }
      return undefined;
    }).immediate();
  }
  private leased(id: string, token: string): Job | undefined {
    return this.db.prepare("SELECT * FROM companion_memory_tag_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").get(id, token, Date.now()) as Job | undefined;
  }
  private complete(command: Extract<CompanionStorageCommand, { type: 'memory.tags.complete' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const job = this.leased(command.id, command.leaseToken); if (!job) return { ok: true };
      const note = this.current(job);
      if (!this.valid(job, note) || job.prohibition_revision !== this.policy(note)) { this.finish(job.id, 'stale', '文档或禁记规则已变化，旧标签未发布。'); return { ok: true }; }
      const result = this.memory({ type: 'memory.library.organize', companionId: note.companionId, id: note.id, expectedVersion: note.version,
        tags: command.tags, diaryName: note.diaryName ?? '日记', expectedProhibitionRevision: job.prohibition_revision });
      if (!result?.ok) throw new Error('自动标签未能写回日记。');
      this.finish(job.id, 'completed'); return result;
    }).immediate();
  }
  private status(owner: string, noteId?: string): NonNullable<CompanionStorageResponse['memoryTagStatus']> {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(owner)) throw new Error('伙伴不存在。');
    this.discover(owner);
    const counts = this.db.prepare('SELECT status,COUNT(*) AS n FROM companion_memory_tag_jobs WHERE companion_id=? GROUP BY status').all(owner) as Array<{ status: string; n: number }>;
    const total = (state: string) => counts.find(item => item.status === state)?.n ?? 0;
    const last = noteId ? this.db.prepare('SELECT note_id,note_version,status,error FROM companion_memory_tag_jobs WHERE companion_id=? AND note_id=? ORDER BY ordinal DESC LIMIT 1').get(owner, noteId) as
      { note_id: string; note_version: number; status: NonNullable<NonNullable<CompanionStorageResponse['memoryTagStatus']>['note']>['state']; error?: string } | undefined : undefined;
    return { pending: total('pending'), running: total('running'), waitingModel: total('waiting_model'), failed: total('failed'), completed: total('completed'), cancelled: total('cancelled'),
      ...(last ? { note: { noteId: last.note_id, version: last.note_version, state: last.status, ...(last.error ? { error: last.error } : {}) } } : {}) };
  }
  private enable(owner: string, noteId: string, enabled: boolean): void {
    const note = this.memory({ type: 'memory.library.read', companionId: owner, id: noteId, sourceLimit: 1 })?.memoryRead?.memory;
    if (!note) throw new Error('实际日记已经变化或不可访问。');
    const changed = this.memory({ type: 'memory.library.organize', companionId: owner, id: note.id, expectedVersion: note.version,
      tags: note.tags, diaryName: note.diaryName ?? '日记', autoTags: enabled })?.memories?.[0];
    if (!changed) throw new Error('文档自动标签设置尚未提交。');
    if (enabled) this.observe(changed);
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'memory.tags.claim': return { ok: true, memoryTagJob: this.claim(command.leaseMs ?? 120000) };
      case 'memory.tags.complete': return this.complete(command);
      case 'memory.tags.defer': {
        const job = this.leased(command.id, command.leaseToken); if (!job) return { ok: true };
        this.db.prepare('UPDATE companion_memory_tag_jobs SET status=?,next_attempt=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=?')
          .run(command.reason === 'needs_model' ? 'waiting_model' : 'failed', Date.now() + (command.retryAfterMs ?? 30000), command.error, job.id);
        return { ok: true };
      }
      case 'memory.tags.status': return { ok: true, memoryTagStatus: this.status(command.companionId, command.noteId) };
      case 'memory.tags.cancel': this.enable(command.companionId, command.noteId, false); this.db.prepare("UPDATE companion_memory_tag_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,error=NULL WHERE companion_id=? AND note_id=? AND status NOT IN('completed','stale')")
        .run(command.companionId, command.noteId); return { ok: true };
      case 'memory.tags.retry': if (command.noteId) this.enable(command.companionId, command.noteId, true); this.db.prepare(`UPDATE companion_memory_tag_jobs SET status='pending',attempts=0,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL WHERE companion_id=?
        AND (status IN('waiting_model','failed'${command.noteId ? ",'cancelled','stale'" : ''}) OR status='pending' AND attempts>=8
          OR status='running' AND attempts>=8 AND lease_until<=?) ${command.noteId ? 'AND note_id=?' : ''}`)
        .run(command.companionId, Date.now(), ...(command.noteId ? [command.noteId] : [])); return { ok: true };
    }
  }
}
