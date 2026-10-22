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
        json_extract(data,'$.metadata.characterDevelopment.topic'),json_extract(data,'$.sourceSequence'));
      CREATE TABLE IF NOT EXISTS companion_character_retirement_watermarks(
        companion_id TEXT NOT NULL,topic_key TEXT NOT NULL,source_sequence INTEGER NOT NULL,
        note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,PRIMARY KEY(companion_id,topic_key));
    `);
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM metadata WHERE key='character-retirement-watermarks/v1'").get()) return;
      // Bootstrap only already-verified host metadata. A watermark preserves no
      // statement or private topic text, and never makes a retired note readable.
      const verified = this.db.prepare("SELECT data FROM vcp_memory_notes WHERE json_extract(data,'$.metadata.characterDevelopment.topic') IS NOT NULL") as unknown as { iterate(): Iterable<{ data: string }> };
      for (const entry of verified.iterate()) {
        const note = JSON.parse(entry.data) as CompanionMemory, parsed = companionCharacterDevelopmentDraftSchema.safeParse(note.metadata?.characterDevelopment);
        if (parsed.success) this.remember(note, parsed.data.topic);
      }
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('character-retirement-watermarks/v1','done')").run();
    }).immediate();
  }
  private topicKey(topic: string): string { return createHash('sha256').update(companionCharacterTopic(topic)).digest('hex'); }
  private remember(note: CompanionMemory, topic: string): void {
    this.db.prepare(`INSERT INTO companion_character_retirement_watermarks(companion_id,topic_key,source_sequence,note_id) VALUES(?,?,?,?)
      ON CONFLICT(companion_id,topic_key) DO UPDATE SET source_sequence=excluded.source_sequence,note_id=excluded.note_id
      WHERE excluded.source_sequence>companion_character_retirement_watermarks.source_sequence`).run(note.companionId, this.topicKey(topic), note.sourceSequence, note.id);
  }
  validate(scope: CompanionSourceScope, draft: CompanionMemoryCandidate, sources: CompanionMessage[], dependencies: CompanionMemory[], previousId?: string): void {
    if (draft.metadata?.characterDevelopment !== undefined) throw new Error('成长档案元数据由宿主从可核验的 selfDevelopment 提议保存。');
    if (!draft.selfDevelopment) return;
    const development = companionCharacterDevelopmentDraftSchema.parse(draft.selfDevelopment);
    if (draft.metadata?.dream || draft.metadata?.simulation) throw new Error('梦中虚构内容不能成为当前成长档案。');
    validateCompanionCharacterDevelopment({ owner: scope.companionId, diaryName: draft.diaryName, content: draft.content,
      development, sources, evidence: draft.evidence, dependencies });
    for (const id of development.supersedesMemoryIds) {
      const found = this.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(id) as { data: string } | undefined;
      const old = found ? JSON.parse(found.data) as CompanionMemory : undefined;
      const prior = companionCharacterDevelopmentDraftSchema.safeParse(old?.metadata?.characterDevelopment);
      if (!old || id === previousId || !this.visible(scope, old) || !prior.success
        || companionCharacterTopic(prior.data.topic) !== companionCharacterTopic(development.topic)) throw new Error('只能替代当前可核验、同一主题的本人旧认识。');
    }
  }
  saved(note: CompanionMemory): void {
    const parsed = companionCharacterDevelopmentDraftSchema.safeParse(note.metadata?.characterDevelopment);
    if (!parsed.success) return;
    this.remember(note, parsed.data.topic);
    const newer = this.db.prepare('SELECT source_sequence,note_id FROM companion_character_retirement_watermarks WHERE companion_id=? AND topic_key=?')
      .get(note.companionId, this.topicKey(parsed.data.topic)) as { source_sequence: number; note_id: string };
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
      return previous.success && companionCharacterTopic(previous.data.topic) === companionCharacterTopic(parsed.data.topic)
        && this.visible({ companionId: note.companionId, conversationId: note.sourceConversationId }, old) ? [old.id] : [];
    });
    for (const id of new Set([...parsed.data.supersedesMemoryIds, ...priorIds])) {
      if (id === note.id) throw new Error('成长档案不能替代自身。');
      this.db.prepare('INSERT OR IGNORE INTO companion_character_supersessions VALUES(?,?,?)').run(note.companionId, id, note.id);
    }
  }
  read(scope: CompanionSourceScope, limit: number): CompanionCharacterDevelopment {
    const conversation = this.db.prepare('SELECT kind FROM conversations WHERE id=? AND dissolved_at IS NULL').get(scope.conversationId) as { kind: string } | undefined;
    if (!conversation || !this.db.prepare('SELECT 1 FROM conversation_members WHERE companion_id=? AND conversation_id=?').get(scope.companionId, scope.conversationId)) throw new Error('成长档案不属于当前伙伴或会话。');
    const entries = this.db.prepare(`SELECT data FROM vcp_memory_notes n WHERE companion_id=?
      AND json_extract(data,'$.status') IN('queued','indexed') AND json_extract(data,'$.metadata.characterDevelopment.topic') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM companion_character_supersessions s WHERE s.companion_id=n.companion_id AND s.old_note_id=n.id)
      ORDER BY json_extract(data,'$.sourceSequence') DESC,json_extract(data,'$.updatedAt') DESC,id DESC LIMIT 257`).all(scope.companionId) as Array<{ data: string }>;
    const items: CompanionCharacterDevelopment['items'] = [], topics = new Set<string>();
    for (const entry of entries.slice(0, 256)) {
      const note = JSON.parse(entry.data) as CompanionMemory, parsed = companionCharacterDevelopmentDraftSchema.safeParse(note.metadata?.characterDevelopment);
      if (!parsed.success || !this.visible(scope, note) || note.metadata?.dream || note.metadata?.simulation
        || conversation.kind === 'group' && note.sourceConversationId !== scope.conversationId) continue;
      const topic = companionCharacterTopic(parsed.data.topic);
      const newer = this.db.prepare('SELECT source_sequence FROM companion_character_retirement_watermarks WHERE companion_id=? AND topic_key=?')
        .get(scope.companionId, this.topicKey(topic)) as { source_sequence: number } | undefined;
      if (newer && newer.source_sequence > note.sourceSequence) continue;
      if (topics.has(topic)) continue;
      topics.add(topic);
      const { kind, statement, basis, qualification } = parsed.data;
      items.push({ memoryId: note.id, memoryVersion: note.version, kind, topic: parsed.data.topic, statement, basis,
        ...(qualification ? { qualification } : {}), updatedAt: note.updatedAt, sourceMessageIds: note.sources.map(source => source.messageId) });
      if (items.length > limit) break;
    }
    return { companionId: scope.companionId, conversationId: scope.conversationId, observedAt: new Date().toISOString(),
      items: items.slice(0, limit), truncated: items.length > limit || entries.length > 256 };
  }
}
