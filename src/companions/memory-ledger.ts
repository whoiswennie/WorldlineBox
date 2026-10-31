import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMemory } from '../shared/companions';
import type { CompanionMemoryLifecycleChange, CompanionMemoryLifecycleState, CompanionMemoryLifecycleCause } from '../shared/companion-memory';
import { initializeCompanionMemoryHistory, enqueueCompanionMemoryHistory } from './memory-history-outbox';

type StoredRevision = { memory: CompanionMemory; dependencies: Array<{ id: string; contentRevision: number }> };
export type CompanionMemoryWriteCause = CompanionMemoryLifecycleCause & { eventId?: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const orderedDependencies = (values: StoredRevision['dependencies']) => [...values].sort((a, b) => a.id.localeCompare(b.id) || a.contentRevision - b.contentRevision);
const contentValue = (note: CompanionMemory, dependencies: StoredRevision['dependencies']) => [note.content, note.sources, note.occurredAt, note.metadata?.characterDevelopment,
  note.procedure ? [note.procedure.applicability, note.procedure.steps, note.procedure.limitations, note.procedure.verification] : undefined, orderedDependencies(dependencies)];
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
      CREATE TABLE IF NOT EXISTS companion_memory_evidence_versions(companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,source_revision INTEGER NOT NULL,source_checksum TEXT NOT NULL,first_note_id TEXT NOT NULL,PRIMARY KEY(companion_id,message_id,source_revision,source_checksum));
      DROP TRIGGER IF EXISTS companion_memory_membership_revoked;
      CREATE TRIGGER companion_memory_membership_revoked AFTER DELETE ON conversation_members BEGIN
        INSERT INTO companion_memory_lifecycle_state(companion_id,revocation_epoch) VALUES(OLD.companion_id,1) ON CONFLICT(companion_id) DO UPDATE SET revocation_epoch=revocation_epoch+1;
        INSERT INTO companion_memory_changes(companion_id,kind,data) VALUES(OLD.companion_id,'revoke',json_object(
          'companionId',OLD.companion_id,'kind','revoke','causeEventId','membership/'||lower(hex(randomblob(16))),
          'cause',json_object('operation','membership_revoke','conversationId',OLD.conversation_id,
            'sourceMessageIds',json((SELECT json_group_array(message_id) FROM (SELECT o.message_id FROM vcp_source_observers o JOIN messages m ON m.id=o.message_id
              WHERE o.companion_id=OLD.companion_id AND m.conversation_id=OLD.conversation_id ORDER BY o.message_id LIMIT 10000))),
            'sourceTargetCount',(SELECT COUNT(*) FROM vcp_source_observers o JOIN messages m ON m.id=o.message_id WHERE o.companion_id=OLD.companion_id AND m.conversation_id=OLD.conversation_id),
            'sourceTargetsComplete',json(CASE WHEN (SELECT COUNT(*) FROM vcp_source_observers o JOIN messages m ON m.id=o.message_id WHERE o.companion_id=OLD.companion_id AND m.conversation_id=OLD.conversation_id)<=10000 THEN 'true' ELSE 'false' END)),
          'changeKind','revocation','evidenceDelta',json_object('added',json('[]'),'removed',json('[]'),'revised',json('[]'),'newSourceVersions',json('[]')),
          'lineageRootIds',json((SELECT json_group_array(message_id) FROM (SELECT o.message_id FROM vcp_source_observers o JOIN messages m ON m.id=o.message_id
            WHERE o.companion_id=OLD.companion_id AND m.conversation_id=OLD.conversation_id ORDER BY o.message_id LIMIT 10000))),
          'sourceMessageIds',json('[]'),'at',strftime('%Y-%m-%dT%H:%M:%fZ','now')));
        UPDATE companion_memory_lifecycle_state SET ledger_sequence=(SELECT MAX(sequence) FROM companion_memory_changes WHERE companion_id=OLD.companion_id) WHERE companion_id=OLD.companion_id;
      END;
      DROP TRIGGER IF EXISTS companion_memory_conversation_revoked;
      CREATE TRIGGER companion_memory_conversation_revoked AFTER UPDATE OF dissolved_at ON conversations WHEN NEW.dissolved_at IS NOT OLD.dissolved_at BEGIN
        INSERT INTO companion_memory_lifecycle_state(companion_id,revocation_epoch) SELECT companion_id,1 FROM conversation_members WHERE conversation_id=NEW.id ON CONFLICT(companion_id) DO UPDATE SET revocation_epoch=revocation_epoch+1;
        INSERT INTO companion_memory_changes(companion_id,kind,data) SELECT member.companion_id,'revoke',json_object(
          'companionId',member.companion_id,'kind','revoke','causeEventId','conversation/'||lower(hex(randomblob(16))),
          'cause',json_object('operation','conversation_dissolve','conversationId',NEW.id,
            'sourceMessageIds',json((SELECT json_group_array(message_id) FROM (SELECT o.message_id FROM vcp_source_observers o JOIN messages m ON m.id=o.message_id
              WHERE o.companion_id=member.companion_id AND m.conversation_id=NEW.id ORDER BY o.message_id LIMIT 10000))),
            'sourceTargetCount',(SELECT COUNT(*) FROM vcp_source_observers o JOIN messages m ON m.id=o.message_id WHERE o.companion_id=member.companion_id AND m.conversation_id=NEW.id),
            'sourceTargetsComplete',json(CASE WHEN (SELECT COUNT(*) FROM vcp_source_observers o JOIN messages m ON m.id=o.message_id WHERE o.companion_id=member.companion_id AND m.conversation_id=NEW.id)<=10000 THEN 'true' ELSE 'false' END)),
          'changeKind','revocation','evidenceDelta',json_object('added',json('[]'),'removed',json('[]'),'revised',json('[]'),'newSourceVersions',json('[]')),
          'lineageRootIds',json((SELECT json_group_array(message_id) FROM (SELECT o.message_id FROM vcp_source_observers o JOIN messages m ON m.id=o.message_id
            WHERE o.companion_id=member.companion_id AND m.conversation_id=NEW.id ORDER BY o.message_id LIMIT 10000))),
          'sourceMessageIds',json('[]'),'at',strftime('%Y-%m-%dT%H:%M:%fZ','now')) FROM conversation_members member WHERE member.conversation_id=NEW.id;
        UPDATE companion_memory_lifecycle_state SET ledger_sequence=(SELECT MAX(sequence) FROM companion_memory_changes WHERE companion_id=companion_memory_lifecycle_state.companion_id)
          WHERE companion_id IN(SELECT companion_id FROM conversation_members WHERE conversation_id=NEW.id);
      END;
    `);
    initializeCompanionMemoryHistory(this.db);
  }
  stamp(note: CompanionMemory, previous?: CompanionMemory, dependencies?: StoredRevision['dependencies']): CompanionMemoryLifecycleChange['kind'] | undefined {
    if (!previous) { note.contentRevision = 1; note.annotationRevision = 1; note.semanticRevision = 1; return 'create'; }
    const previousDependencies = (this.db.prepare('SELECT source_note_id AS id,version AS contentRevision FROM vcp_note_dependencies WHERE note_id=?')
      .all(note.id) as StoredRevision['dependencies']);
    const bodyChanged = digest(contentValue(note, dependencies ?? previousDependencies)) !== digest(contentValue(previous, previousDependencies));
    const annotationChanged = digest(annotations(note)) !== digest(annotations(previous));
    note.contentRevision = previous.contentRevision! + Number(bodyChanged);
    note.annotationRevision = previous.annotationRevision! + Number(annotationChanged);
    note.semanticRevision = previous.semanticRevision! + Number(bodyChanged);
    if (bodyChanged) return 'content';
    if (annotationChanged) return 'annotation';
    if (note.archivedAt !== previous.archivedAt || note.supersededBy !== previous.supersededBy) return 'archive';
    return undefined;
  }
  change(owner: string, kind: CompanionMemoryLifecycleChange['kind'], note?: CompanionMemory, previous?: CompanionMemory,
    dependencies?: StoredRevision['dependencies'], cause?: CompanionMemoryWriteCause): number {
    const reference = (value: CompanionMemory['sources'][number]) => ({ messageId: value.messageId, revision: value.revision, checksum: value.checksum });
    const before = new Map((previous?.sources ?? []).map(source => [source.messageId, reference(source)]));
    const after = new Map((note?.sources ?? []).map(source => [source.messageId, reference(source)]));
    const newSourceVersions = [...after.values()].filter(source => !this.db.prepare('SELECT 1 FROM companion_memory_evidence_versions WHERE companion_id=? AND message_id=? AND source_revision=? AND source_checksum=?')
      .get(owner, source.messageId, source.revision, source.checksum));
    for (const source of after.values()) this.db.prepare('INSERT OR IGNORE INTO companion_memory_evidence_versions VALUES(?,?,?,?,?)')
      .run(owner, source.messageId, source.revision, source.checksum, note!.id);
    const evidenceDelta = { added: [...after.values()].filter(source => !before.has(source.messageId)),
      removed: [...before.values()].filter(source => !after.has(source.messageId)),
      revised: [...after.values()].flatMap(source => { const old = before.get(source.messageId);
        return old && (old.revision !== source.revision || old.checksum !== source.checksum) ? [{ before: old, after: source }] : []; }), newSourceVersions };
    const lineageRootIds = new Set([...(note?.sources.length ? note.sources : previous?.sources ?? []).map(source => source.messageId), ...cause?.sourceMessageIds ?? []]);
    const pending = [...(dependencies ?? (note ? this.db.prepare('SELECT source_note_id AS id,version AS contentRevision FROM vcp_note_dependencies WHERE note_id=?').all(note.id) as StoredRevision['dependencies'] : []))], visited = new Set<string>();
    const revocation = kind === 'revoke' || !!note && ['forgotten', 'invalid'].includes(note.status);
    if (revocation && pending.length) {
      // The body may already have been erased by source withdrawal. Exact
      // lineage IDs live in the host dependency index and need no old prose.
      const roots = this.db.prepare(`WITH RECURSIVE inputs(note_id,content_revision) AS (
        SELECT json_extract(value,'$.id'),json_extract(value,'$.contentRevision') FROM json_each(?)
        UNION SELECT d.parent_id,d.parent_revision FROM companion_memory_history_dependencies d JOIN inputs i
          ON d.note_id=i.note_id AND d.content_revision=i.content_revision WHERE d.companion_id=?)
        SELECT DISTINCT s.source_id FROM companion_memory_history_sources s JOIN inputs i USING(note_id,content_revision) WHERE s.companion_id=? LIMIT 10001`)
        .all(JSON.stringify(pending), owner, owner) as Array<{ source_id: string }>;
      for (const root of roots) lineageRootIds.add(root.source_id);
      if (lineageRootIds.size > 10000) throw new Error('记忆原始来源谱系超过本次完整核验上限。');
      pending.length = 0;
    }
    while (pending.length) {
      const input = pending.pop()!, key = `${input.id}:${input.contentRevision}`;
      if (visited.has(key)) continue; visited.add(key);
      if (visited.size > 10000) throw new Error('记忆来源谱系超过本次完整核验上限。');
      const revision = this.readBody(owner, input.id, input.contentRevision);
      if (!revision) throw new Error('记忆来源谱系缺少宿主已固定的不可变修订。');
      for (const source of revision.memory.sources) lineageRootIds.add(source.messageId);
      if (lineageRootIds.size > 10000) throw new Error('记忆原始来源谱系超过本次完整核验上限。');
      pending.push(...revision.dependencies);
    }
    const changeKind: CompanionMemoryLifecycleChange['changeKind'] = kind === 'revoke' || note && ['forgotten', 'invalid'].includes(note.status) ? 'revocation'
      : kind === 'annotation' ? 'annotation' : kind === 'archive' ? 'archive' : cause?.operation === 'reflection' ? 'reflection' : cause?.operation === 'simulation' ? 'simulation'
        : cause?.operation === 'consolidate' ? 'representation'
          : newSourceVersions.length ? previous && ['revise', 'correct'].includes(cause?.operation ?? '') ? 'correction' : 'external_evidence' : 'representation';
    const causeDetails = cause ? { ...cause } : undefined;
    if (causeDetails) delete causeDetails.eventId;
    const change = { companionId: owner, kind, ...(note ? { noteId: note.id, contentRevision: note.contentRevision,
      annotationRevision: note.annotationRevision, semanticRevision: note.semanticRevision } : {}),
      causeEventId: cause?.eventId ?? `host-memory/${randomUUID()}`, changeKind, evidenceDelta, lineageRootIds: [...lineageRootIds].sort(),
      cause: { operation: cause?.operation ?? (kind === 'revoke' ? 'source_revoke' : kind === 'create' ? 'record' : kind === 'content' ? 'revise' : kind),
        ...(note ? { noteIds: [note.id], conversationId: note.sourceConversationId } : {}),
        ...(note || previous ? { sourceMessageIds: [...new Set([...(note?.sources ?? []), ...(previous?.sources ?? [])].map(source => source.messageId))] } : {}),
        ...causeDetails },
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
    if (!saved) return;
    const value = JSON.parse(saved.annotations); return value.withdrawn ? undefined : value;
  }
  recordBody(note: CompanionMemory, dependencies: StoredRevision['dependencies']): void {
    if (note.contentRevision === undefined) throw new Error('记忆正文缺少内容修订。');
    const bodyHash = digest(contentValue(note, dependencies));
    const saved = this.db.prepare('SELECT body_hash FROM companion_memory_content_revisions WHERE note_id=? AND content_revision=?')
      .get(note.id, note.contentRevision) as { body_hash: string } | undefined;
    if (saved && saved.body_hash !== bodyHash) throw new Error('不可变的记忆正文修订不能被覆盖。');
    const created = this.db.prepare('INSERT OR IGNORE INTO companion_memory_content_revisions VALUES(?,?,?,?,?)')
      .run(note.id, note.contentRevision, note.companionId, bodyHash, JSON.stringify({ memory: note, dependencies }));
    if (created.changes) enqueueCompanionMemoryHistory(this.db, note, dependencies, bodyHash);
  }
  readBody(owner: string, id: string, contentRevision: number): StoredRevision | undefined {
    const value = this.db.prepare('SELECT data FROM companion_memory_content_revisions WHERE companion_id=? AND note_id=? AND content_revision=?')
      .get(owner, id, contentRevision) as { data: string } | undefined;
    if (!value) return;
    const payload = JSON.parse(value.data);
    return payload.withdrawn ? undefined : payload as StoredRevision;
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
