import type { CompanionConnection } from './store';
import { createHash } from 'node:crypto';
import type { CompanionMemory, CompanionMessage } from '../shared/companions';
import type { CompanionMemoryCandidate } from '../shared/companion-memory';
import type { CompanionSourceScope } from './source-access';
import { companionCharacterDevelopmentDraftSchema, companionCharacterTopic, validateCompanionCharacterDevelopment,
  type CompanionCharacterDevelopment } from '../shared/companion-character-development';

/** Metadata and a replacement ledger over VCP diaries; never another knowledge or vector database. */
export class CompanionCharacterDevelopmentStore {
  constructor(private readonly db: CompanionConnection,
    private readonly visible: (scope: CompanionSourceScope, note: CompanionMemory) => boolean) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_character_supersessions(
      companion_id TEXT NOT NULL,old_note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,
      new_note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,PRIMARY KEY(companion_id,old_note_id,new_note_id));
      CREATE INDEX IF NOT EXISTS companion_character_current ON vcp_memory_notes(companion_id,
        json_extract(data,'$.metadata.characterDevelopment.kind'),json_extract(data,'$.metadata.characterDevelopment.topic'),json_extract(data,'$.sourceSequence'));
      CREATE INDEX IF NOT EXISTS companion_character_candidates ON vcp_memory_notes(companion_id,
        json_extract(data,'$.sourceSequence') DESC,json_extract(data,'$.updatedAt') DESC,id DESC)
        WHERE json_extract(data,'$.metadata.characterDevelopment.topic') IS NOT NULL AND json_extract(data,'$.artifactKind')='self_understanding';
      CREATE TABLE IF NOT EXISTS companion_character_retirement_watermarks(
        companion_id TEXT NOT NULL,topic_key TEXT NOT NULL,source_sequence INTEGER NOT NULL,
        note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,PRIMARY KEY(companion_id,topic_key));
      CREATE TABLE IF NOT EXISTS companion_growth_input_scopes(owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,processed_generation INTEGER NOT NULL DEFAULT 0,cursor_note_id TEXT,
        PRIMARY KEY(owner_id,conversation_id));
      CREATE INDEX IF NOT EXISTS companion_growth_pending_scopes ON companion_growth_input_scopes(owner_id,conversation_id)
        WHERE generation>processed_generation;
    `);
  }
  private topicKey(topic: string, kind: string): string { return createHash('sha256').update(JSON.stringify([kind, companionCharacterTopic(topic)])).digest('hex'); }
  private remember(note: CompanionMemory, topic: string, kind: string): void {
    this.db.prepare(`INSERT INTO companion_character_retirement_watermarks(companion_id,topic_key,source_sequence,note_id) VALUES(?,?,?,?)
      ON CONFLICT(companion_id,topic_key) DO UPDATE SET source_sequence=excluded.source_sequence,note_id=excluded.note_id
      WHERE excluded.source_sequence>companion_character_retirement_watermarks.source_sequence`).run(note.companionId, this.topicKey(topic, kind), note.sourceSequence, note.id);
  }
  validate(scope: CompanionSourceScope, draft: CompanionMemoryCandidate, sources: CompanionMessage[], dependencies: CompanionMemory[], previousId?: string): void {
    if (draft.metadata?.characterDevelopment !== undefined) throw new Error('成长档案元数据由宿主从可核验的 selfDevelopment 提议保存。');
    if (!draft.selfDevelopment) return;
    if (draft.artifactKind !== 'self_understanding') throw new Error('本人认识必须保存在明确的主观认识类型中。');
    const development = companionCharacterDevelopmentDraftSchema.parse(draft.selfDevelopment);
    if (draft.metadata?.dream || draft.metadata?.simulation) throw new Error('梦中虚构内容不能成为当前成长档案。');
    validateCompanionCharacterDevelopment({ owner: scope.companionId, diaryName: draft.diaryName, content: draft.content,
      development, sources, evidence: draft.evidence, dependencies });
    for (const id of development.supersedesMemoryIds) {
      const found = this.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(id) as { data: string } | undefined;
      const old = found ? JSON.parse(found.data) as CompanionMemory : undefined;
      const prior = companionCharacterDevelopmentDraftSchema.safeParse(old?.metadata?.characterDevelopment);
      if (!old || id === previousId || !this.visible(scope, old) || !prior.success
        || prior.data.kind !== development.kind || companionCharacterTopic(prior.data.topic) !== companionCharacterTopic(development.topic)) throw new Error('只能替代当前可核验、同一类别与主题的本人旧认识。');
    }
  }
  saved(note: CompanionMemory): void {
    const parsed = companionCharacterDevelopmentDraftSchema.safeParse(note.metadata?.characterDevelopment);
    if (!parsed.success) return;
    this.db.prepare(`INSERT INTO companion_growth_input_scopes(owner_id,conversation_id,generation,processed_generation,cursor_note_id) VALUES(?,?,1,0,NULL)
      ON CONFLICT(owner_id,conversation_id) DO UPDATE SET generation=generation+1,cursor_note_id=NULL`).run(note.companionId, note.sourceConversationId);
    this.remember(note, parsed.data.topic, parsed.data.kind);
    const newer = this.db.prepare('SELECT source_sequence,note_id FROM companion_character_retirement_watermarks WHERE companion_id=? AND topic_key=?')
      .get(note.companionId, this.topicKey(parsed.data.topic, parsed.data.kind)) as { source_sequence: number; note_id: string };
    if (newer.source_sequence > note.sourceSequence) {
      // The newer formal note may already be forgotten. Its ID-only receipt
      // still retires a late older stance; forgetting is not an undo operation.
      this.db.prepare('INSERT OR IGNORE INTO companion_character_supersessions VALUES(?,?,?)').run(note.companionId, note.id, newer.note_id);
      return;
    }
    // A late capture of an old source must not replace a later self-expression.
    // Retiring an older version is durable: forgetting the correction must not
    // silently revive a superseded position as this person's current belief.
    const older = this.db.prepare(`SELECT data FROM vcp_memory_notes WHERE companion_id=? AND id<>?
      AND json_extract(data,'$.metadata.characterDevelopment.topic') IS NOT NULL
      AND json_extract(data,'$.sourceSequence')<=? ORDER BY json_extract(data,'$.sourceSequence') DESC LIMIT 256`).all(note.companionId, note.id, note.sourceSequence) as Array<{ data: string }>;
    const priorIds = older.flatMap(entry => { const old = JSON.parse(entry.data) as CompanionMemory;
      const previous = companionCharacterDevelopmentDraftSchema.safeParse(old.metadata?.characterDevelopment);
      return previous.success && previous.data.kind === parsed.data.kind && companionCharacterTopic(previous.data.topic) === companionCharacterTopic(parsed.data.topic)
        && this.visible({ companionId: note.companionId, conversationId: note.sourceConversationId }, old) ? [old.id] : [];
    });
    for (const id of new Set([...parsed.data.supersedesMemoryIds, ...priorIds])) {
      if (id === note.id) throw new Error('成长档案不能替代自身。');
      this.db.prepare('INSERT OR IGNORE INTO companion_character_supersessions VALUES(?,?,?)').run(note.companionId, id, note.id);
    }
  }
  scopes(input: { companionId?: string; conversationId?: string; afterCompanionId?: string; afterConversationId?: string; limit?: number }) {
    const conditions = ['s.generation>s.processed_generation', 'p.deleted_at IS NULL', "COALESCE(json_extract(p.data,'$.active'),1)=1", 'c.dissolved_at IS NULL'];
    const values: Array<string | number> = [];
    if (input.companionId) { conditions.push('s.owner_id=?'); values.push(input.companionId); }
    if (input.conversationId) { conditions.push('s.conversation_id=?'); values.push(input.conversationId); }
    if (input.afterCompanionId) { conditions.push('(s.owner_id>? OR s.owner_id=? AND s.conversation_id>?)'); values.push(input.afterCompanionId, input.afterCompanionId, input.afterConversationId ?? ''); }
    const limit = input.limit ?? 16;
    const rows = this.db.prepare(`SELECT s.* FROM companion_growth_input_scopes s JOIN companions p ON p.id=s.owner_id
      JOIN conversations c ON c.id=s.conversation_id JOIN conversation_members m ON m.conversation_id=s.conversation_id AND m.companion_id=s.owner_id
      WHERE ${conditions.join(' AND ')} ORDER BY s.owner_id,s.conversation_id LIMIT ?`).all(...values, limit + 1) as Array<{ owner_id: string; conversation_id: string; generation: number; cursor_note_id: string | null }>;
    const items = rows.slice(0, limit).map(row => ({ companionId: row.owner_id, conversationId: row.conversation_id, generation: row.generation,
      ...(row.cursor_note_id ? { cursor: row.cursor_note_id } : {}) }));
    return { items, hasMore: rows.length > limit, ...(rows.length > limit ? { nextCursor: { companionId: items.at(-1)!.companionId, conversationId: items.at(-1)!.conversationId } } : {}) };
  }
  acknowledge(scope: { companionId: string; conversationId: string; expectedGeneration: number; nextCursor?: string }): boolean {
    return this.db.prepare(`UPDATE companion_growth_input_scopes SET cursor_note_id=?,processed_generation=? WHERE owner_id=? AND conversation_id=? AND generation=?`)
      .run(scope.nextCursor ?? null, scope.nextCursor ? 0 : scope.expectedGeneration, scope.companionId, scope.conversationId, scope.expectedGeneration).changes === 1;
  }
  read(scope: CompanionSourceScope & { cursor?: string }, limit: number): CompanionCharacterDevelopment {
    const conversation = this.db.prepare('SELECT kind FROM conversations WHERE id=? AND dissolved_at IS NULL').get(scope.conversationId) as { kind: string } | undefined;
    if (!conversation || !this.db.prepare('SELECT 1 FROM conversation_members WHERE companion_id=? AND conversation_id=?').get(scope.companionId, scope.conversationId)) throw new Error('成长档案不属于当前伙伴或会话。');
    const cursor = scope.cursor && this.db.prepare('SELECT data FROM vcp_memory_notes WHERE companion_id=? AND id=?').get(scope.companionId, scope.cursor) as { data: string } | undefined;
    const cursorNote = cursor && JSON.parse(cursor.data) as CompanionMemory | undefined;
    if (scope.cursor && !cursorNote) throw new Error('本人认识分页游标已失效。');
    const entries = this.db.prepare(`SELECT data FROM vcp_memory_notes n WHERE companion_id=?
      AND json_extract(data,'$.artifactKind')='self_understanding'
      AND json_extract(data,'$.status') IN('queued','indexed') AND json_extract(data,'$.metadata.characterDevelopment.topic') IS NOT NULL
      ${cursorNote ? "AND (json_extract(data,'$.sourceSequence')<? OR json_extract(data,'$.sourceSequence')=? AND (json_extract(data,'$.updatedAt')<? OR json_extract(data,'$.updatedAt')=? AND id<?))" : ''}
      AND NOT EXISTS(SELECT 1 FROM companion_character_supersessions s WHERE s.companion_id=n.companion_id AND s.old_note_id=n.id)
      ORDER BY json_extract(data,'$.sourceSequence') DESC,json_extract(data,'$.updatedAt') DESC,id DESC LIMIT 257`).all(scope.companionId,
        ...cursorNote ? [cursorNote.sourceSequence, cursorNote.sourceSequence, cursorNote.updatedAt, cursorNote.updatedAt, cursorNote.id] : []) as Array<{ data: string }>;
    const items: CompanionCharacterDevelopment['items'] = [], topics = new Set<string>();
    for (const entry of entries.slice(0, 256)) {
      const note = JSON.parse(entry.data) as CompanionMemory, parsed = companionCharacterDevelopmentDraftSchema.safeParse(note.metadata?.characterDevelopment);
      if (!parsed.success || note.artifactKind !== 'self_understanding' || !this.visible(scope, note) || note.metadata?.dream || note.metadata?.simulation
        || conversation.kind === 'group' && note.sourceConversationId !== scope.conversationId) continue;
      const topic = companionCharacterTopic(parsed.data.topic), key = JSON.stringify([parsed.data.kind, topic]);
      const newer = this.db.prepare('SELECT source_sequence FROM companion_character_retirement_watermarks WHERE companion_id=? AND topic_key=?')
        .get(scope.companionId, this.topicKey(topic, parsed.data.kind)) as { source_sequence: number } | undefined;
      if (newer && newer.source_sequence > note.sourceSequence) continue;
      if (topics.has(key)) continue;
      topics.add(key);
      const { kind, statement, basis, qualification } = parsed.data;
      items.push({ memoryId: note.id, memoryVersion: note.version, kind, topic: parsed.data.topic, statement, basis,
        ...(qualification ? { qualification } : {}), updatedAt: note.updatedAt, sourceMessageIds: note.sources.map(source => source.messageId) });
      if (items.length > limit) break;
    }
    const hasMore = items.length > limit || entries.length > 256;
    const nextCursor = items.length > limit ? items[limit - 1]!.memoryId : entries.length > 256 ? (JSON.parse(entries[255]!.data) as CompanionMemory).id : undefined;
    return { companionId: scope.companionId, conversationId: scope.conversationId, observedAt: new Date().toISOString(),
      items: items.slice(0, limit), truncated: hasMore, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  }
}
