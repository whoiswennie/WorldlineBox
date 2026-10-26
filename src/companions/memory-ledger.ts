import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMemory } from '../shared/companions';
import type { CompanionMemoryLifecycleChange, CompanionMemoryLifecycleState } from '../shared/companion-memory';

type StoredRevision = { memory: CompanionMemory; dependencies: Array<{ id: string; contentRevision: number }> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentValue = (note: CompanionMemory) => [note.content, note.sources, note.occurredAt, note.metadata?.characterDevelopment,
  note.procedure ? [note.procedure.applicability, note.procedure.steps, note.procedure.limitations, note.procedure.verification] : undefined];
const annotations = (note: CompanionMemory) => [note.tags, note.diaryName, note.metadata?.autoTags, note.procedure?.validation];

/** The public version fences mutations and index receipts; content/annotation
 * revisions fence their own dependencies. History is never a second index. */
export class CompanionMemoryLedger {
  constructor(private readonly db: CompanionConnection) {}
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_memory_lifecycle_state(companion_id TEXT PRIMARY KEY,ledger_sequence INTEGER NOT NULL DEFAULT 0,revocation_epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS companion_memory_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,companion_id TEXT NOT NULL,kind TEXT NOT NULL,note_id TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_memory_changes_owner ON companion_memory_changes(companion_id,sequence);
      CREATE TABLE IF NOT EXISTS companion_memory_content_revisions(note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,content_revision INTEGER NOT NULL,companion_id TEXT NOT NULL,body_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(note_id,content_revision));
      CREATE TABLE IF NOT EXISTS companion_memory_version_revisions(note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,version INTEGER NOT NULL,content_revision INTEGER NOT NULL,annotations TEXT NOT NULL,PRIMARY KEY(note_id,version));
      CREATE TABLE IF NOT EXISTS companion_memory_source_coverage(companion_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,source_revision INTEGER NOT NULL,source_checksum TEXT NOT NULL,note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,content_revision INTEGER NOT NULL,PRIMARY KEY(companion_id,message_id,source_revision,source_checksum));
      CREATE TRIGGER IF NOT EXISTS companion_memory_membership_revoked AFTER DELETE ON conversation_members BEGIN
        INSERT INTO companion_memory_lifecycle_state(companion_id,revocation_epoch) VALUES(OLD.companion_id,1) ON CONFLICT(companion_id) DO UPDATE SET revocation_epoch=revocation_epoch+1;
      END;
      CREATE TRIGGER IF NOT EXISTS companion_memory_conversation_revoked AFTER UPDATE OF dissolved_at ON conversations WHEN NEW.dissolved_at IS NOT OLD.dissolved_at BEGIN
        INSERT INTO companion_memory_lifecycle_state(companion_id,revocation_epoch) SELECT companion_id,1 FROM conversation_members WHERE conversation_id=NEW.id ON CONFLICT(companion_id) DO UPDATE SET revocation_epoch=revocation_epoch+1;
      END;
    `);
  }
  stamp(note: CompanionMemory, previous?: CompanionMemory): CompanionMemoryLifecycleChange['kind'] | undefined {
    if (!previous) { note.contentRevision = 1; note.annotationRevision = 1; note.semanticRevision = 1; return 'create'; }
    const bodyChanged = digest(contentValue(note)) !== digest(contentValue(previous));
    const annotationChanged = digest(annotations(note)) !== digest(annotations(previous));
    note.contentRevision = previous.contentRevision! + Number(bodyChanged);
    note.annotationRevision = previous.annotationRevision! + Number(annotationChanged);
    note.semanticRevision = previous.semanticRevision! + Number(bodyChanged);
    if (bodyChanged) return 'content';
    if (annotationChanged) return 'annotation';
    if (note.archivedAt !== previous.archivedAt || note.supersededBy !== previous.supersededBy) return 'archive';
    return undefined;
  }
  change(owner: string, kind: CompanionMemoryLifecycleChange['kind'], note?: CompanionMemory): number {
    const change = { companionId: owner, kind, ...(note ? { noteId: note.id, contentRevision: note.contentRevision,
      annotationRevision: note.annotationRevision, semanticRevision: note.semanticRevision } : {}),
      sourceMessageIds: note?.sources.map(source => source.messageId) ?? [], at: new Date().toISOString() };
    const result = this.db.prepare('INSERT INTO companion_memory_changes(companion_id,kind,note_id,data) VALUES(?,?,?,?)')
      .run(owner, kind, note?.id ?? null, JSON.stringify(change));
    const sequence = Number(result.lastInsertRowid);
    this.db.prepare(`INSERT INTO companion_memory_lifecycle_state(companion_id,ledger_sequence,revocation_epoch) VALUES(?,?,?)
      ON CONFLICT(companion_id) DO UPDATE SET ledger_sequence=excluded.ledger_sequence,revocation_epoch=revocation_epoch+excluded.revocation_epoch`)
      .run(owner, sequence, Number(kind === 'revoke'));
    return sequence;
  }
  state(owner: string): CompanionMemoryLifecycleState {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(owner)) throw new Error('伙伴不存在。');
    const state = this.db.prepare('SELECT ledger_sequence,revocation_epoch FROM companion_memory_lifecycle_state WHERE companion_id=?').get(owner) as { ledger_sequence: number; revocation_epoch: number } | undefined;
    return { companionId: owner, ledgerSequence: state?.ledger_sequence ?? 0, revocationEpoch: state?.revocation_epoch ?? 0 };
  }
  changes(owner: string, after: number, limit: number) {
    this.state(owner);
    const rows = this.db.prepare('SELECT sequence,data FROM companion_memory_changes WHERE companion_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(owner, after, limit + 1) as Array<{ sequence: number; data: string }>;
    const page = rows.slice(0, limit);
    return { changes: page.map(row => ({ ...JSON.parse(row.data), sequence: row.sequence }) as CompanionMemoryLifecycleChange),
      nextSequence: page.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  }
  recordVersion(note: CompanionMemory): void {
    const existing = this.versionRevision(note.id, note.version);
    if (existing !== undefined && existing !== note.contentRevision) throw new Error('已登记的记忆版本不能指向不同正文。');
    this.db.prepare('INSERT OR IGNORE INTO companion_memory_version_revisions VALUES(?,?,?,?)').run(note.id, note.version, note.contentRevision,
      JSON.stringify({ tags: note.tags, diaryName: note.diaryName, autoTags: note.metadata?.autoTags !== false }));
  }
  versionRevision(id: string, version: number): number | undefined {
    return (this.db.prepare('SELECT content_revision FROM companion_memory_version_revisions WHERE note_id=? AND version=?').get(id, version) as { content_revision: number } | undefined)?.content_revision;
  }
  versionAnnotations(id: string, version: number): { tags: string[]; diaryName?: string; autoTags?: boolean } | undefined {
    const saved = this.db.prepare('SELECT annotations FROM companion_memory_version_revisions WHERE note_id=? AND version=?').get(id, version) as { annotations: string } | undefined;
    return saved ? JSON.parse(saved.annotations) : undefined;
  }
  recordBody(note: CompanionMemory, dependencies: StoredRevision['dependencies']): void {
    if (note.contentRevision === undefined) throw new Error('记忆正文缺少内容修订。');
    const bodyHash = digest(contentValue(note));
    const saved = this.db.prepare('SELECT body_hash FROM companion_memory_content_revisions WHERE note_id=? AND content_revision=?')
      .get(note.id, note.contentRevision) as { body_hash: string } | undefined;
    if (saved && saved.body_hash !== bodyHash) throw new Error('不可变的记忆正文修订不能被覆盖。');
    this.db.prepare('INSERT OR IGNORE INTO companion_memory_content_revisions VALUES(?,?,?,?,?)')
      .run(note.id, note.contentRevision, note.companionId, bodyHash, JSON.stringify({ memory: note, dependencies }));
  }
  readBody(owner: string, id: string, contentRevision: number): StoredRevision | undefined {
    const value = this.db.prepare('SELECT data FROM companion_memory_content_revisions WHERE companion_id=? AND note_id=? AND content_revision=?')
      .get(owner, id, contentRevision) as { data: string } | undefined;
    return value ? JSON.parse(value.data) as StoredRevision : undefined;
  }
  cover(note: CompanionMemory, completeSources: readonly string[]): void {
    for (const source of note.sources) if (completeSources.includes(source.messageId)) this.db.prepare(`INSERT INTO companion_memory_source_coverage VALUES(?,?,?,?,?,?)
      ON CONFLICT(companion_id,message_id,source_revision,source_checksum) DO UPDATE SET note_id=excluded.note_id,content_revision=excluded.content_revision`)
      .run(note.companionId, source.messageId, source.revision, source.checksum, note.id, note.contentRevision);
  }
  coverage(owner: string, source: { message_id: string; source_revision: number; source_checksum: string }): { noteId: string; contentRevision: number } | undefined {
    const value = this.db.prepare('SELECT note_id,content_revision FROM companion_memory_source_coverage WHERE companion_id=? AND message_id=? AND source_revision=? AND source_checksum=?')
      .get(owner, source.message_id, source.source_revision, source.source_checksum) as { note_id: string; content_revision: number } | undefined;
    return value ? { noteId: value.note_id, contentRevision: value.content_revision } : undefined;
  }
}
