import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import {
  companionDraftSchema, companionIdSchema, companionActionPageQuerySchema, type CompanionActionPageQuery, type CompanionActionPage, type Companion,
  type CompanionAction, type CompanionConversation, type CompanionDraft,
  type CompanionMemory, type CompanionMessage, type CompanionState,
  companionReplyRecoverySchema, type CompanionReplyRecovery, type CompanionSearchQuery, type CompanionSearchPage,
} from '../shared/companions';
import {
  appendCompanionMessageSchema, companionStorageCommandSchema,
  createCompanionActionSchema, saveCompanionMemorySchema,
  storedCompanionAttachmentSchema, updateCompanionActionSchema,
  type AppendCompanionMessage, type CompanionStorageCommand,
  type CompanionStorageResponse, type CreateCompanionAction,
  type SaveCompanionMemory, type StoredCompanionAttachment, type UpdateCompanionAction, type CompanionProactiveState,
  companionTaskCheckpointSchema, type CompanionTaskCheckpoint,
} from '../shared/companion-storage';
import { BUILTIN_COMPANIONS, BUILTIN_WELCOMES, LEGACY_BUILTIN_PERSONAS } from '../shared/companion-personas';
import { companionGroupTitle } from '../shared/companion-titles';
import { companionLoopCheckpointSchema, companionWorkSchema, type CompanionWork, type CompanionLoopCheckpoint } from '../shared/companion-loop';
import { companionSearchTokens, companionSearchMatch, companionSearchExcerpt, companionSearchFacet } from '../shared/companion-search';

interface Statement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface Connection {
  function(name: string, options: { deterministic: boolean }, fn: (text: string) => string): void;
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): (() => T) & { immediate(): T };
  close(): void;
}
const Database = BetterSqlite3 as { new(filename: string): Connection };
export const COMPANION_SCHEMA_VERSION = 2;
export type CompanionSeed = CompanionDraft & { id: string };
type Row = Record<string, string | number | null>;
const row = (value: unknown): Row => value as Row;
const rows = (value: unknown[]): Row[] => value.map(row);
const stamp = () => new Date().toISOString();
const decode = <T>(value: string | number | null | undefined): T => JSON.parse(String(value)) as T;

/** The UtilityProcess is the sole owner of this database. There are no session rows. */
export class CompanionsStore {
  readonly #db: Connection;
  readonly #seeds: readonly CompanionSeed[];

  constructor(databasePath: string, seeds: readonly CompanionSeed[] = BUILTIN_COMPANIONS,
    welcomes: Readonly<Record<string, string>> = BUILTIN_WELCOMES) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#db = new Database(databasePath);
    this.#seeds = seeds;
    void welcomes; // Legacy constructor compatibility; contacts no longer seed chats.
    try {
      // Inspect before changing journal mode or touching schema. A newer original
      // remains intact and can be opened by the version that created it.
      const version = Number(this.#db.pragma('user_version', { simple: true }));
      if (version > COMPANION_SCHEMA_VERSION || version < 0) {
        throw new Error('伙伴数据库由更新版本创建，请升级应用后再打开。原文件已保留。');
      }
      if (version === 0) {
        const existing = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (existing.length) throw new Error('无法识别伙伴数据库格式，原文件已保留。');
      }
      this.#db.pragma('foreign_keys = ON');
      this.#db.pragma('busy_timeout = 5000');
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = FULL');
      this.#db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
      this.#db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
      if (version === 0) this.#migrate();
      if (version < 2) this.#migrateHistory();
      this.#db.exec("CREATE INDEX IF NOT EXISTS actions_chronology ON actions(conversation_id,json_extract(data,'$.createdAt') DESC,id DESC)");
      this.#db.exec("CREATE INDEX IF NOT EXISTS actions_live_status ON actions(status,conversation_id)");
      this.#db.exec("CREATE INDEX IF NOT EXISTS actions_parent_message ON actions(json_extract(data,'$.parentMessageId'))");
      this.#db.exec("CREATE TABLE IF NOT EXISTS companion_work_queue(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,companion_id TEXT NOT NULL,data TEXT NOT NULL)");
      this.#db.exec("CREATE INDEX IF NOT EXISTS companion_work_status ON companion_work_queue(status,ordinal)");
      this.#db.exec("CREATE INDEX IF NOT EXISTS companion_work_source ON companion_work_queue(json_extract(data,'$.sourceMessageId'))");
      this.#db.exec("CREATE INDEX IF NOT EXISTS companion_work_conversation ON companion_work_queue(json_extract(data,'$.conversationId'),status)");
      this.#db.exec("CREATE INDEX IF NOT EXISTS companion_work_role_status ON companion_work_queue(companion_id,status)");
      this.#db.exec("CREATE INDEX IF NOT EXISTS companion_reply_pending ON metadata(json_extract(value,'$.status')) WHERE key GLOB 'reply-source/*' OR key GLOB 'reply-checkpoint/*'");
      this.#seed();
      for (const seed of this.#seeds) {
        const found = this.#db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(seed.id);
        if (!found) continue;
        const saved = decode<Companion>(row(found).data);
        if (saved.builtin && LEGACY_BUILTIN_PERSONAS[seed.id] === saved.persona) this.#db.prepare('UPDATE companions SET data=? WHERE id=?').run(JSON.stringify({ ...saved, persona: seed.persona }), seed.id);
      }
      this.#coalesceGroups();
      this.backfillSearchIndex();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#db.transaction(() => {
      this.#db.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE proactive_state (companion_id TEXT PRIMARY KEY REFERENCES companions(id), data TEXT NOT NULL);
        CREATE TABLE companions (id TEXT PRIMARY KEY, data TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('private','group')),
          title TEXT NOT NULL, private_companion_id TEXT UNIQUE REFERENCES companions(id),
          pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
          read_sequence INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
          CHECK((kind='private' AND private_companion_id IS NOT NULL) OR (kind='group' AND private_companion_id IS NULL))
        );
        CREATE TABLE conversation_members (
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          companion_id TEXT NOT NULL REFERENCES companions(id), PRIMARY KEY(conversation_id, companion_id)
        );
        CREATE TABLE attachments (id TEXT PRIMARY KEY, data TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE);
        CREATE TABLE actions (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          companion_id TEXT NOT NULL REFERENCES companions(id), status TEXT NOT NULL, data TEXT NOT NULL
        );
        CREATE TABLE messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id), author_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('text','notice','action')), content TEXT NOT NULL,
          created_at TEXT NOT NULL, reply_to_id TEXT REFERENCES messages(id),
          status TEXT NOT NULL CHECK(status IN ('sent','failed')), action_id TEXT REFERENCES actions(id),
          client_id TEXT UNIQUE, request_fingerprint TEXT
        );
        CREATE INDEX messages_conversation_sequence ON messages(conversation_id, sequence DESC);
        CREATE TABLE message_attachments (
          message_id TEXT NOT NULL REFERENCES messages(id), attachment_id TEXT NOT NULL REFERENCES attachments(id),
          ordinal INTEGER NOT NULL, PRIMARY KEY(message_id, attachment_id)
        );
        CREATE TABLE memories (
          id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id), data TEXT NOT NULL
        );
        CREATE INDEX memories_companion ON memories(companion_id);
        CREATE INDEX actions_conversation ON actions(conversation_id);
        CREATE VIRTUAL TABLE message_search USING fts5(content, content='messages', content_rowid='sequence', tokenize='trigram');
        CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN
          INSERT INTO message_search(rowid, content) VALUES (new.sequence, new.content);
        END;
        CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN
          INSERT INTO message_search(message_search,rowid,content) VALUES('delete',old.sequence,old.content);
        END;
        CREATE TRIGGER message_search_update AFTER UPDATE OF content ON messages BEGIN
          INSERT INTO message_search(message_search,rowid,content) VALUES('delete',old.sequence,old.content);
          INSERT INTO message_search(rowid,content) VALUES(new.sequence,new.content);
        END;
        PRAGMA user_version = 1;
      `);
    }).immediate();
  }

  #migrateHistory(): void {
    this.#db.transaction(() => {
      this.#db.exec(`
        ALTER TABLE conversations ADD COLUMN hidden_at TEXT;
        ALTER TABLE conversations ADD COLUMN dissolved_at TEXT;
        UPDATE conversations SET hidden_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='private'
          AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=conversations.id)
          AND NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=conversations.id AND (client_id IS NULL OR client_id NOT LIKE 'builtin-welcome-%'))
          AND NOT EXISTS(SELECT 1 FROM actions WHERE conversation_id=conversations.id);
        CREATE INDEX messages_author_sequence ON messages(author_id,sequence DESC);
        CREATE INDEX messages_conversation_time ON messages(conversation_id,created_at,sequence);
        CREATE INDEX messages_time_sequence ON messages(created_at,sequence);
        CREATE INDEX message_attachments_attachment ON message_attachments(attachment_id,message_id);
        DROP TRIGGER message_search_insert;
        DROP TRIGGER message_search_update;
        DROP TRIGGER message_search_delete;
        DROP TABLE message_search;
        CREATE VIRTUAL TABLE message_search USING fts5(tokens, scope, content='', contentless_delete=1);
        CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN
          INSERT INTO message_search(rowid,tokens,scope) VALUES(new.sequence,companion_search_tokens(new.content),'c'||companion_search_facet(new.conversation_id)||' a'||companion_search_facet(new.author_id)||' d'||replace(substr(new.created_at,1,10),'-','')||CASE WHEN instr(lower(new.content),'https://')>0 OR instr(lower(new.content),'http://')>0 THEN ' weblink' ELSE '' END||CASE WHEN EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=new.id AND json_extract(a.data,'$.mime') LIKE 'image/%') THEN ' picture' ELSE '' END||CASE WHEN EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=new.id AND json_extract(a.data,'$.mime') NOT LIKE 'image/%') THEN ' document' ELSE '' END);
        END;
        CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN
          DELETE FROM message_search WHERE rowid=old.sequence;
        END;
        CREATE TRIGGER message_search_update AFTER UPDATE OF content,conversation_id,author_id ON messages WHEN old.content!=new.content OR old.conversation_id!=new.conversation_id OR old.author_id!=new.author_id BEGIN
          DELETE FROM message_search WHERE rowid=old.sequence;
          INSERT INTO message_search(rowid,tokens,scope) SELECT new.sequence,companion_search_tokens(new.content || char(10) || COALESCE((
            SELECT group_concat(json_extract(a.data,'$.name'),char(10)) FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=new.id),'')),'c'||companion_search_facet(new.conversation_id)||' a'||companion_search_facet(new.author_id)||' d'||replace(substr(new.created_at,1,10),'-','')||CASE WHEN instr(lower(new.content),'https://')>0 OR instr(lower(new.content),'http://')>0 THEN ' weblink' ELSE '' END||CASE WHEN EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=new.id AND json_extract(a.data,'$.mime') LIKE 'image/%') THEN ' picture' ELSE '' END||CASE WHEN EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=new.id AND json_extract(a.data,'$.mime') NOT LIKE 'image/%') THEN ' document' ELSE '' END;
        END;
        CREATE TRIGGER message_search_attachment_insert AFTER INSERT ON message_attachments BEGIN
          DELETE FROM message_search WHERE rowid=(SELECT sequence FROM messages WHERE id=new.message_id);
          INSERT INTO message_search(rowid,tokens,scope) SELECT m.sequence,companion_search_tokens(m.content || char(10) || COALESCE((
            SELECT group_concat(json_extract(a.data,'$.name'),char(10)) FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id),'')),'c'||companion_search_facet(m.conversation_id)||' a'||companion_search_facet(m.author_id)||' d'||replace(substr(m.created_at,1,10),'-','')||CASE WHEN instr(lower(m.content),'https://')>0 OR instr(lower(m.content),'http://')>0 THEN ' weblink' ELSE '' END||CASE WHEN EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id AND json_extract(a.data,'$.mime') LIKE 'image/%') THEN ' picture' ELSE '' END||CASE WHEN EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id AND json_extract(a.data,'$.mime') NOT LIKE 'image/%') THEN ' document' ELSE '' END FROM messages m WHERE m.id=new.message_id;
        END;
        CREATE TRIGGER message_search_attachment_delete AFTER DELETE ON message_attachments BEGIN
          DELETE FROM message_search WHERE rowid=(SELECT sequence FROM messages WHERE id=old.message_id);
          INSERT INTO message_search(rowid,tokens,scope) SELECT m.sequence,companion_search_tokens(m.content || char(10) || COALESCE((
            SELECT group_concat(json_extract(a.data,'$.name'),char(10)) FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id),'')),'c'||companion_search_facet(m.conversation_id)||' a'||companion_search_facet(m.author_id)||' d'||replace(substr(m.created_at,1,10),'-','')||CASE WHEN instr(lower(m.content),'https://')>0 OR instr(lower(m.content),'http://')>0 THEN ' weblink' ELSE '' END||CASE WHEN EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id AND json_extract(a.data,'$.mime') LIKE 'image/%') THEN ' picture' ELSE '' END||CASE WHEN EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id AND json_extract(a.data,'$.mime') NOT LIKE 'image/%') THEN ' document' ELSE '' END FROM messages m WHERE m.id=old.message_id;
        END;
        INSERT INTO metadata(key,value) SELECT 'message-index-target',CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM messages;
        INSERT INTO metadata(key,value) VALUES('message-index-through','0');
        PRAGMA user_version = 2;
      `);
    }).immediate();
  }

  /** Bounded, crash-safe upgrade batches; the worker yields between batches. */
  backfillSearchIndex(): boolean {
    return this.#db.transaction(() => {
      const target = Number(row(this.#db.prepare("SELECT value FROM metadata WHERE key='message-index-target'").get()).value);
      const through = Number(row(this.#db.prepare("SELECT value FROM metadata WHERE key='message-index-through'").get()).value);
      if (through >= target) return true;
      const batch = rows(this.#db.prepare(`SELECT m.sequence,m.content,m.conversation_id,m.author_id,m.created_at,COALESCE((SELECT group_concat(json_extract(a.data,'$.name'),char(10))
        FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id),'') AS filenames
        ,EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id AND json_extract(a.data,'$.mime') LIKE 'image/%') AS has_images
        ,EXISTS(SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id AND json_extract(a.data,'$.mime') NOT LIKE 'image/%') AS has_files
        FROM messages m WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT 500`).all(through, target));
      const remove = this.#db.prepare('DELETE FROM message_search WHERE rowid=?');
      const insert = this.#db.prepare('INSERT INTO message_search(rowid,tokens,scope) VALUES(?,?,?)');
      for (const item of batch) { remove.run(item.sequence); insert.run(item.sequence, companionSearchTokens(String(item.content) + '\n' + item.filenames), 'c' + companionSearchFacet(String(item.conversation_id)) + ' a' + companionSearchFacet(String(item.author_id)) + ' d' + String(item.created_at).slice(0,10).replaceAll('-','')
        + (item.has_images ? ' picture' : '') + (item.has_files ? ' document' : '') + (/https?:\/\//iu.test(String(item.content)) ? ' weblink' : '')); }
      const next = batch.length === 500 ? Number(batch.at(-1)!.sequence) : target;
      this.#db.prepare("UPDATE metadata SET value=? WHERE key='message-index-through'").run(String(next));
      return next >= target;
    }).immediate();
  }

  #seed(): void {
    this.#db.transaction(() => {
      for (const seed of this.#seeds) {
        // Missing catalogue additions are installed once; tombstones and all
        // saved profile edits keep precedence over bundled authoring defaults.
        if (this.#db.prepare('SELECT 1 FROM companions WHERE id=?').get(seed.id)) continue;
        const companion: Companion = { ...companionDraftSchema.parse(seed), id: companionIdSchema.parse(seed.id), builtin: true, createdAt: stamp() };
        this.#db.prepare('INSERT INTO companions(id,data) VALUES(?,?)').run(companion.id, JSON.stringify(companion));
      }
      this.#db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('builtin-seeded','1')").run();
    }).immediate();
  }

  close(): void { this.#db.close(); }

  #requireCompanion(id: string): Companion {
    companionIdSchema.parse(id);
    const found = this.#db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(id);
    if (!found) throw new Error('伙伴不存在或已移除。');
    return decode<Companion>(row(found).data);
  }

  #requireConversation(id: string): Row {
    companionIdSchema.parse(id);
    id = this.#conversationId(id);
    const found = this.#db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    if (!found) throw new Error('聊天不存在。');
    return row(found);
  }
  #conversationId(id: string): string {
    for (let depth = 0; depth < 32; depth++) {
      const alias = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get(`group-alias/${id}`);
      if (!alias) return id;
      id = String(row(alias).value);
    }
    throw new Error('群聊引用无法解析，原有记录已保留。');
  }
  /** Same membership means the same durable room; merge legacy copies atomically. */
  #coalesceGroups(): void {
    this.#db.transaction(() => {
      const known = new Map<string, string>();
      for (const group of rows(this.#db.prepare("SELECT * FROM conversations WHERE kind='group' AND dissolved_at IS NULL ORDER BY rowid").all())) {
        const id = String(group.id), key = JSON.stringify(this.#memberIds(id).sort());
        const canonical = known.get(key);
        if (!canonical) { known.set(key, id); continue; }
        const target = this.#requireConversation(canonical);
        for (const message of rows(this.#db.prepare('SELECT id,request_fingerprint FROM messages WHERE conversation_id=?').all(id))) {
          if (!message.request_fingerprint) continue;
          const fingerprint = decode<Record<string, unknown>>(message.request_fingerprint);
          fingerprint.conversationId = canonical;
          this.#db.prepare('UPDATE messages SET request_fingerprint=? WHERE id=?').run(JSON.stringify(fingerprint), message.id);
        }
        this.#db.prepare('UPDATE messages SET conversation_id=? WHERE conversation_id=?').run(canonical, id);
        for (const item of rows(this.#db.prepare('SELECT id,data FROM actions WHERE conversation_id=?').all(id))) {
          const action = decode<CompanionAction>(item.data);
          this.#db.prepare('UPDATE actions SET conversation_id=?,data=? WHERE id=?').run(canonical, JSON.stringify({ ...action, conversationId: canonical }), item.id);
        }
        this.#db.prepare('UPDATE conversations SET pinned=?,muted=?,read_sequence=?,updated_at=? WHERE id=?').run(
          Math.max(Number(target.pinned), Number(group.pinned)), Math.max(Number(target.muted), Number(group.muted)),
          Math.min(Number(target.read_sequence), Number(group.read_sequence)),
          String(target.updated_at) > String(group.updated_at) ? target.updated_at : group.updated_at, canonical);
        const previousReply = this.replyCheckpoint(id), targetReply = this.replyCheckpoint(canonical);
        if (previousReply) {
          const oldSequence = this.getMessage(previousReply.sourceMessageId).sequence;
          const targetSequence = targetReply ? this.getMessage(targetReply.sourceMessageId).sequence : -1;
          const selected = oldSequence > targetSequence ? previousReply : targetReply!;
          this.#setMetadata('reply-checkpoint/' + canonical, { ...selected, conversationId: canonical });
          this.#db.prepare('DELETE FROM metadata WHERE key=?').run('reply-checkpoint/' + id);
        }
        this.#db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(`group-alias/${id}`, canonical);
        this.#db.prepare('DELETE FROM conversation_members WHERE conversation_id=?').run(id);
        this.#db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      }
    }).immediate();
  }

  #memberIds(id: string): string[] {
    return rows(this.#db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY rowid').all(id)).map((item) => String(item.companion_id));
  }

  #requireMember(conversationId: string, companionId: string): void {
    if (this.#requireConversation(conversationId).dissolved_at) throw new Error('这个群聊已经解散。');
    this.#requireCompanion(companionId);
    if (!this.#db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(conversationId, companionId)) {
      throw new Error('这个伙伴不是聊天成员。');
    }
  }

  #conversation(found: Row): CompanionConversation {
    const id = String(found.id);
    const latest = this.#db.prepare('SELECT content FROM messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1').get(id);
    const unread = row(this.#db.prepare("SELECT count(*) AS total FROM messages WHERE conversation_id=? AND sequence>? AND author_id!='user'").get(id, found.read_sequence)).total;
    return { id, kind: found.kind as CompanionConversation['kind'], title: found.kind === 'group' && this.#automaticGroupTitle(found) ? this.#groupTitle(id) : String(found.title),
      memberIds: this.#memberIds(id), pinned: Boolean(found.pinned), muted: Boolean(found.muted),
      unread: Number(unread), updatedAt: String(found.updated_at), lastMessage: latest ? String(row(latest).content).slice(0, 500) : '' };
  }
  #automaticGroupTitle(group: Row): boolean {
    const flag = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get(`group-title/${group.id}`);
    return flag ? row(flag).value === 'auto' : group.title === '我们的群聊' || group.title === '新群聊';
  }
  #groupTitle(id: string): string {
    return companionGroupTitle(this.#memberIds(id).map(member => {
      const data = this.#db.prepare('SELECT data FROM companions WHERE id=?').get(member);
      return data ? decode<Companion>(row(data).data).name : '伙伴';
    }));
  }

  state(includeHidden = false): CompanionState {
    return { companions: rows(this.#db.prepare('SELECT data FROM companions WHERE deleted_at IS NULL ORDER BY rowid').all()).map((item) => decode<Companion>(item.data)),
      conversations: rows(this.#db.prepare(`SELECT * FROM conversations WHERE dissolved_at IS NULL ${includeHidden ? '' : 'AND hidden_at IS NULL'} ORDER BY pinned DESC,updated_at DESC,rowid DESC`).all()).map((item) => this.#conversation(item)),
      activities: [], configured: false, recoveries: this.replyRecoveries() };
  }
  private replyRecoveries(): CompanionReplyRecovery[] {
    const found = rows(this.#db.prepare("SELECT value FROM metadata WHERE (key GLOB 'reply-source/*' OR key GLOB 'reply-checkpoint/*') AND json_extract(value,'$.status') IN ('pending','interrupted')").all()).map(item => companionReplyRecoverySchema.parse(decode(item.value)));
    return [...new Map(found.map(item => [item.sourceMessageId, item])).values()].filter(item => item.status === 'interrupted' || item.status === 'pending')
      .sort((a, b) => this.getMessage(a.sourceMessageId).sequence - this.getMessage(b.sourceMessageId).sequence);
  }

  createCompanion(draft: CompanionDraft): Companion {
    const parsed = companionDraftSchema.parse(draft);
    this.#requireAvatar(parsed.avatarAttachmentId);
    const companion: Companion = { ...parsed, id: randomUUID(), builtin: false, createdAt: stamp() };
    this.#db.prepare('INSERT INTO companions(id,data) VALUES(?,?)').run(companion.id, JSON.stringify(companion));
    return companion;
  }

  updateCompanion(id: string, draft: CompanionDraft): Companion {
    return this.#db.transaction(() => {
      const existing = this.#requireCompanion(id);
      const parsed = companionDraftSchema.parse(draft);
      this.#requireAvatar(parsed.avatarAttachmentId);
      // An omitted connection override selects the global connection again.
      // Explicitly assign undefined so the old JSON field is not retained.
      const companion: Companion = { ...existing, ...parsed, llm: parsed.llm, avatarAttachmentId: parsed.avatarAttachmentId };
      this.#db.prepare('UPDATE companions SET data=? WHERE id=?').run(JSON.stringify(companion), id);
      this.#db.prepare("UPDATE conversations SET title=? WHERE private_companion_id=?").run(companion.name, id);
      return companion;
    }).immediate();
  }

  #requireAvatar(attachmentId: string | undefined): void {
    if (!attachmentId) return;
    const stored = this.getAttachment(attachmentId);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(stored.attachment.mime)) {
      throw new Error('伙伴头像必须是已登记的 PNG、JPEG、WebP 或 GIF 图片。');
    }
  }

  deleteCompanion(id: string): void {
    this.#requireCompanion(id);
    // Tombstones preserve messages, memory and action provenance, and prevent
    // application restart from recreating a removed built-in contact.
    this.#db.prepare('UPDATE companions SET deleted_at=? WHERE id=?').run(stamp(), id);
  }

  restoreBuiltin(id: string): Companion {
    const seed = this.#seeds.find((item) => item.id === id);
    if (!seed) throw new Error('没有这个内置伙伴。');
    return this.#db.transaction(() => {
      const found = this.#db.prepare('SELECT data FROM companions WHERE id=?').get(id);
      let companion: Companion;
      if (found) {
        companion = decode<Companion>(row(found).data);
        this.#db.prepare('UPDATE companions SET deleted_at=NULL WHERE id=?').run(id);
      } else {
        companion = { ...companionDraftSchema.parse(seed), id, builtin: true, createdAt: stamp() };
        this.#db.prepare('INSERT INTO companions(id,data) VALUES(?,?)').run(id, JSON.stringify(companion));
      }
      return companion;
    }).immediate();
  }

  openPrivate(companionId: string): CompanionConversation {
    return this.#db.transaction(() => {
      const companion = this.#requireCompanion(companionId);
      const existing = this.#db.prepare('SELECT * FROM conversations WHERE private_companion_id=?').get(companionId);
      if (existing) {
        this.#db.prepare('UPDATE conversations SET hidden_at=NULL WHERE id=?').run(row(existing).id);
        return this.#conversation(row(existing));
      }
      const id = `private-${companionId}`;
      this.#db.prepare("INSERT INTO conversations(id,kind,title,private_companion_id,updated_at) VALUES(?,'private',?,?,?)").run(id, companion.name, companionId, stamp());
      this.#db.prepare('INSERT INTO conversation_members(conversation_id,companion_id) VALUES(?,?)').run(id, companionId);
      return this.#conversation(this.#requireConversation(id));
    }).immediate();
  }

  createConversation(title: string, memberIds: string[]): CompanionConversation {
    const input = companionStorageCommandSchema.parse({ type: 'conversation.create-group', title, memberIds });
    if (input.type !== 'conversation.create-group') throw new Error('Invalid group request.');
    return this.#db.transaction(() => {
      const members = [...new Set(input.memberIds)];
      members.forEach((id) => this.#requireCompanion(id));
      const key = JSON.stringify([...members].sort());
      const existing = rows(this.#db.prepare("SELECT * FROM conversations WHERE kind='group' AND dissolved_at IS NULL ORDER BY rowid").all())
        .find(group => JSON.stringify(this.#memberIds(String(group.id)).sort()) === key);
      if (existing) {
        this.#db.prepare('UPDATE conversations SET hidden_at=NULL WHERE id=?').run(existing.id);
        return this.#conversation(existing);
      }
      const id = randomUUID();
      this.#db.prepare("INSERT INTO conversations(id,kind,title,updated_at) VALUES(?,'group',?,?)").run(id, input.title, stamp());
      for (const member of members) this.#db.prepare('INSERT INTO conversation_members(conversation_id,companion_id) VALUES(?,?)').run(id, member);
      this.#db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(`group-title/${id}`, input.title ? 'custom' : 'auto');
      return this.#conversation(this.#requireConversation(id));
    }).immediate();
  }

  updateConversation(id: string, patch: { title?: string; memberIds?: string[]; pinned?: boolean; muted?: boolean }): CompanionConversation {
    id = this.#conversationId(id);
    const input = companionStorageCommandSchema.parse({ type: 'conversation.update', id, ...patch });
    if (input.type !== 'conversation.update') throw new Error('Invalid conversation request.');
    return this.#db.transaction(() => {
      const existing = this.#requireConversation(id);
      if (existing.dissolved_at) throw new Error('这个群聊已经解散。');
      const keepAutomatic = existing.kind === 'group' && this.#automaticGroupTitle(existing) && input.title === this.#groupTitle(id);
      if (input.memberIds) {
        if (existing.kind !== 'group') throw new Error('私聊的伙伴不能替换。');
        const members = [...new Set(input.memberIds)];
        members.forEach((member) => this.#requireCompanion(member));
        this.#db.prepare('DELETE FROM conversation_members WHERE conversation_id=?').run(id);
        for (const member of members) this.#db.prepare('INSERT INTO conversation_members(conversation_id,companion_id) VALUES(?,?)').run(id, member);
      }
      this.#db.prepare('UPDATE conversations SET title=?,pinned=?,muted=? WHERE id=?').run(
        input.title ?? existing.title, input.pinned === undefined ? existing.pinned : Number(input.pinned),
        input.muted === undefined ? existing.muted : Number(input.muted), id);
      if (existing.kind === 'group' && input.title !== undefined) this.#db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(`group-title/${id}`, !input.title || keepAutomatic ? 'auto' : 'custom');
      if (input.memberIds) this.#coalesceGroups();
      return this.#conversation(this.#requireConversation(id));
    }).immediate();
  }

  deleteConversation(id: string, mode: 'hide' | 'dissolve'): void {
    id = this.#conversationId(companionIdSchema.parse(id));
    this.#db.transaction(() => {
      const conversation = this.#requireConversation(id);
      if (mode === 'dissolve' && conversation.kind !== 'group') throw new Error('只能解散群聊。');
      this.#db.prepare(`UPDATE conversations SET hidden_at=?,pinned=0 ${mode === 'dissolve' ? ',dissolved_at=?' : ''} WHERE id=?`)
        .run(...(mode === 'dissolve' ? [stamp(), stamp(), id] : [stamp(), id]));
      if (mode === 'dissolve') {
        for (const work of this.workList(undefined, true, id)) this.workStatus(work.id, 'cancelled');
        for (const reply of this.replyRecoveries()) if (reply.conversationId === id) this.setReplyStatus(id, reply.sourceMessageId, 'cancelled');
      }
    }).immediate();
  }

  markRead(id: string, sequence?: number): CompanionConversation {
    id = this.#conversationId(id);
    return this.#db.transaction(() => {
      const existing = this.#requireConversation(id);
      const max = Number(row(this.#db.prepare('SELECT COALESCE(MAX(sequence),0) AS maximum FROM messages WHERE conversation_id=?').get(id)).maximum);
      if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) throw new Error('Invalid read position.');
      this.#db.prepare('UPDATE conversations SET read_sequence=? WHERE id=?').run(Math.max(Number(existing.read_sequence), Math.min(sequence ?? max, max)), id);
      return this.#conversation(this.#requireConversation(id));
    }).immediate();
  }

  #message(found: Row, includeSegments = true): CompanionMessage {
    const attachments = rows(this.#db.prepare('SELECT a.data FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=? ORDER BY ma.ordinal').all(found.id)).map((item) => decode<StoredCompanionAttachment['attachment']>(item.data));
    return { id: String(found.id), sequence: Number(found.sequence), conversationId: String(found.conversation_id),
      authorId: String(found.author_id), kind: found.kind as CompanionMessage['kind'], content: String(found.content),
      createdAt: String(found.created_at), status: found.status as CompanionMessage['status'], attachments,
      segments: includeSegments ? this.messageSegments(String(found.id)) : undefined,
      ...(found.reply_to_id ? { replyToId: String(found.reply_to_id) } : {}), ...(found.action_id ? { actionId: String(found.action_id) } : {}) };
  }

  private messageSegments(id: string): CompanionMessage['segments'] {
    const found = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get('message-loop/' + id);
    if (!found) return undefined;
    const turns = decode<CompanionLoopCheckpoint>(row(found).value).turns;
    const actions = rows(this.#db.prepare("SELECT id,data FROM actions WHERE json_extract(data,'$.parentMessageId')=? ORDER BY rowid").all(id));
    return turns.map((turn, index) => ({ text: turn.text, actionIds: actions.filter(item => decode<CompanionAction>(item.data).loopStep === index).map(item => String(item.id)) }));
  }
  private workList(sourceMessageId?: string, unfinishedOnly = false, conversationId?: string): CompanionWork[] {
    const clauses: string[] = []; const args: unknown[] = [];
    if (sourceMessageId) { clauses.push("json_extract(data,'$.sourceMessageId')=?"); args.push(sourceMessageId); }
    if (conversationId) { clauses.push("json_extract(data,'$.conversationId')=?"); args.push(conversationId); }
    if (unfinishedOnly) clauses.push("status IN ('queued','running','interrupted')");
    return rows(this.#db.prepare(`SELECT ordinal,data FROM companion_work_queue ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY ordinal`).all(...args)).map(found => ({ ...companionWorkSchema.parse(decode(found.data)), ordinal: Number(found.ordinal) }));
  }
  private enqueueWork(input: CompanionWork, resume = false): void {
    const work = companionWorkSchema.parse(input);
    if (this.getMessage(work.sourceMessageId).conversationId !== work.conversationId) throw new Error('队列消息不属于这个聊天。');
    this.#requireMember(work.conversationId, work.companionId);
    const found = this.#db.prepare('SELECT data FROM companion_work_queue WHERE id=?').get(work.id);
    if (found) {
      if (resume && ['interrupted', 'cancelled'].includes(decode<CompanionWork>(row(found).data).status)) this.workStatus(work.id, 'queued');
      return;
    }
    this.#db.prepare('INSERT INTO companion_work_queue(id,status,companion_id,data) VALUES(?,?,?,?)').run(work.id, 'queued', work.companionId, JSON.stringify({ ...work, status: 'queued' }));
  }
  private workStatus(id: string, status: CompanionWork['status']): void {
    const found = this.#db.prepare('SELECT data FROM companion_work_queue WHERE id=?').get(id);
    if (!found) throw new Error('队列任务不存在。');
    const previous = decode<CompanionWork>(row(found).data);
    if (previous.status === 'cancelled' && status !== 'queued') return;
    const work = { ...previous, status, updatedAt: stamp() };
    this.#db.prepare('UPDATE companion_work_queue SET status=?,data=? WHERE id=?').run(status, JSON.stringify(work), id);
  }
  private claimWork(): CompanionWork | undefined {
    return this.#db.transaction(() => {
      if (Number(row(this.#db.prepare("SELECT count(*) AS total FROM companion_work_queue WHERE status='running'").get()).total) >= 20) return;
      const found = this.#db.prepare(`SELECT data,ordinal FROM companion_work_queue queued WHERE status='queued' AND
        (SELECT count(*) FROM companion_work_queue running WHERE running.companion_id=queued.companion_id AND running.status='running')<5 ORDER BY ordinal LIMIT 1`).get();
      if (!found) return;
      const next = { ...companionWorkSchema.parse(decode(row(found).data)), ordinal: Number(row(found).ordinal) };
      this.workStatus(next.id, 'running');
      return { ...next, status: 'running' as const };
    }).immediate();
  }
  private loopCheckpoint(sourceMessageId: string, companionId: string): CompanionLoopCheckpoint | undefined {
    const found = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get(`loop/${sourceMessageId}/${companionId}`);
    return found ? companionLoopCheckpointSchema.parse(decode(row(found).value)) : undefined;
  }
  private saveLoop(input: CompanionLoopCheckpoint): void {
    const checkpoint = companionLoopCheckpointSchema.parse(input);
    this.#db.transaction(() => {
      if (this.getMessage(checkpoint.sourceMessageId).conversationId !== this.#conversationId(checkpoint.conversationId)) throw new Error('循环来源不属于这个聊天。');
      this.#requireMember(checkpoint.conversationId, checkpoint.companionId);
      this.#setMetadata(`loop/${checkpoint.sourceMessageId}/${checkpoint.companionId}`, checkpoint);
      if (checkpoint.messageId) {
        const message = this.getMessage(checkpoint.messageId);
        if (message.authorId !== checkpoint.companionId || message.conversationId !== checkpoint.conversationId) throw new Error('循环消息不属于当前伙伴。');
        this.#setMetadata('message-loop/' + checkpoint.messageId, checkpoint);
        const content = checkpoint.turns.map(turn => turn.text).filter(Boolean).join('\n\n').slice(0, 65536);
        this.#db.prepare('UPDATE messages SET content=? WHERE id=?').run(content, checkpoint.messageId);
        this.#db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(stamp(), checkpoint.conversationId);
      }
    }).immediate();
  }

  getMessage(id: string): CompanionMessage {
    companionIdSchema.parse(id);
    const found = this.#db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (!found) throw new Error('消息不存在。');
    this.#requireConversation(String(row(found).conversation_id));
    return this.#message(row(found));
  }

  messages(input: { conversationId: string; before?: number; after?: number; around?: string; limit?: number }): { messages: CompanionMessage[]; hasMore: boolean; hasNewer: boolean } {
    input = { ...input, conversationId: this.#conversationId(input.conversationId) };
    const request = companionStorageCommandSchema.parse({ type: 'messages', ...input });
    if (request.type !== 'messages') throw new Error('Invalid message request.');
    this.#requireConversation(request.conversationId);
    const limit = request.limit ?? 50;
    if ([request.before !== undefined, request.after !== undefined, !!request.around].filter(Boolean).length > 1) throw new Error('只能选择一种历史翻页方向。');
    let found: Row[];
    if (request.around) {
      const anchor = this.getMessage(request.around);
      if (anchor.conversationId !== request.conversationId) throw new Error('定位消息不属于这个聊天。');
      found = [...rows(this.#db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sequence<=? ORDER BY sequence DESC LIMIT ?').all(request.conversationId, anchor.sequence, Math.ceil(limit / 2))).reverse(),
        ...rows(this.#db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(request.conversationId, anchor.sequence, Math.floor(limit / 2)))];
    } else if (request.after !== undefined) {
      found = rows(this.#db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(request.conversationId, request.after, limit));
    } else {
      found = rows(this.#db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(request.conversationId, request.before ?? Number.MAX_SAFE_INTEGER, limit)).reverse();
    }
    const hasMore = !!found.length && !!this.#db.prepare('SELECT 1 FROM messages WHERE conversation_id=? AND sequence<? LIMIT 1').get(request.conversationId, found[0]!.sequence);
    const hasNewer = !!found.length && !!this.#db.prepare('SELECT 1 FROM messages WHERE conversation_id=? AND sequence>? LIMIT 1').get(request.conversationId, found.at(-1)!.sequence);
    return { messages: found.map((item) => this.#message(item)), hasMore, hasNewer };
  }

  search(input: CompanionSearchQuery): { messages: CompanionMessage[]; hasMore: boolean; searchPage: CompanionSearchPage } {
    if (input.conversationId) input = { ...input, conversationId: this.#conversationId(input.conversationId) };
    const request = companionStorageCommandSchema.parse({ type: 'message.search', ...input });
    if (request.type !== 'message.search') throw new Error('Invalid search request.');
    if (request.conversationId) this.#requireConversation(request.conversationId);
    if (request.from && request.to && request.from >= request.to) throw new Error('结束时间需要晚于开始时间。');
    const limit = request.limit;
    const snapshot = request.snapshot ?? Number(row(this.#db.prepare('SELECT COALESCE(MAX(sequence),0) AS total FROM messages').get()).total);
    const args: unknown[] = [];
    const conditions = ['c.dissolved_at IS NULL', 'm.sequence<=?', 'm.sequence<?'];
    args.push(snapshot, request.before ?? Number.MAX_SAFE_INTEGER);
    const indexed = !!request.query || request.category !== 'all';
    const facets = [request.query ? 'tokens : (' + companionSearchMatch(request.query) + ')' : '',
      indexed && request.conversationId ? 'scope : "c' + companionSearchFacet(request.conversationId) + '"' : '',
      indexed && request.authorId ? 'scope : "a' + companionSearchFacet(request.authorId) + '"' : '',
      request.category !== 'all' ? 'scope : "' + ({ images: 'picture', files: 'document', links: 'weblink' }[request.category]) + '"' : ''].filter(Boolean);
    if (indexed && request.from && request.to) {
      const first = new Date(request.from); first.setUTCHours(0, 0, 0, 0);
      const last = new Date(request.to).getTime();
      if ((last - first.getTime()) / 86400_000 <= 366) {
        const days: string[] = [];
        for (let time = first.getTime(); time < last; time += 86400_000) days.push('"d' + new Date(time).toISOString().slice(0, 10).replaceAll('-', '') + '"');
        if (days.length) facets.push('scope : (' + days.join(' OR ') + ')');
      }
    }
    const match = facets.join(' AND ');
    if (match) { conditions.unshift('message_search MATCH ?'); args.unshift(match); }
    if (!indexed && request.conversationId) { conditions.push('m.conversation_id=?'); args.push(request.conversationId); }
    if (!indexed && request.authorId) { conditions.push('m.author_id=?'); args.push(request.authorId); }
    if (request.from) { conditions.push('m.created_at>=?'); args.push(request.from); }
    if (request.to) { conditions.push('m.created_at<?'); args.push(request.to); }
    args.push(limit + 1);
    const found = rows(this.#db.prepare(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id ${indexed ? 'JOIN message_search ON message_search.rowid=m.sequence' : ''} WHERE ${conditions.join(' AND ')} ORDER BY ${indexed ? 'message_search.rowid' : 'm.sequence'} DESC LIMIT ?`).all(...args));
    const messages = found.slice(0, limit).map((item) => this.#message(item, !request.compact));
    const hasMore = found.length > limit;
    const indexReady = row(this.#db.prepare("SELECT value FROM metadata WHERE key='message-index-through'").get()).value === row(this.#db.prepare("SELECT value FROM metadata WHERE key='message-index-target'").get()).value;
    return { messages: request.compact ? [] : messages, hasMore, searchPage: { items: messages.map(message => ({ id: message.id, sequence: message.sequence, conversationId: message.conversationId,
      authorId: message.authorId, createdAt: message.createdAt, attachments: message.attachments,
      excerpt: companionSearchExcerpt(message.content + (message.attachments.length ? '\n' + message.attachments.map(file => file.name).join('\n') : ''), request.query) })),
      hasMore, ...(hasMore && messages.length ? { nextBefore: messages.at(-1)!.sequence } : {}), snapshot, indexReady } };
  }

  appendMessage(input: AppendCompanionMessage): CompanionMessage {
    return this.appendMessageResult(input).message;
  }

  appendMessageResult(input: AppendCompanionMessage): { message: CompanionMessage; inserted: boolean } {
    const message = appendCompanionMessageSchema.parse(input);
    message.conversationId = this.#conversationId(message.conversationId);
    // Keep an exact normalized fingerprint so accidental reuse cannot attach
    // an old message to a different chat or execute a changed instruction.
    const fingerprint = JSON.stringify(message);
    return this.#db.transaction(() => {
      if (message.clientId) {
        const found = this.#db.prepare('SELECT * FROM messages WHERE client_id=?').get(message.clientId);
        if (found) {
          if (row(found).request_fingerprint !== fingerprint) throw new Error('这条消息的重试标识已被其他内容使用。');
          return { message: this.#message(row(found)), inserted: false };
        }
      }
      if (this.#requireConversation(message.conversationId).dissolved_at) throw new Error('这个群聊已经解散。');
      if (message.authorId !== 'user' && message.authorId !== 'system') this.#requireMember(message.conversationId, message.authorId);
      if (!message.content.trim() && !message.attachmentIds.length && !(message.loopStep !== undefined && message.authorId !== 'user' && message.authorId !== 'system')) throw new Error('消息不能为空。');
      if (message.replyToId) {
        const replied = this.#db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(message.replyToId);
        if (!replied || row(replied).conversation_id !== message.conversationId) throw new Error('引用的消息不属于这个聊天。');
      }
      if (message.replyCompletion && message.replyCompletion.companionId !== message.authorId) throw new Error('回复完成标记必须来自实际发言伙伴。');
      if (message.actionId) {
        const action = this.#db.prepare('SELECT conversation_id FROM actions WHERE id=?').get(message.actionId);
        if (!action || row(action).conversation_id !== message.conversationId) throw new Error('行动不属于这个聊天。');
      }
      const attachmentIds = [...new Set(message.attachmentIds)];
      attachmentIds.forEach((id) => this.getAttachment(id));
      const id = randomUUID();
      const createdAt = stamp();
      this.#db.prepare('INSERT INTO messages(id,conversation_id,author_id,kind,content,created_at,reply_to_id,status,action_id,client_id,request_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        id, message.conversationId, message.authorId, message.kind, message.content, createdAt, message.replyToId ?? null,
        message.status, message.actionId ?? null, message.clientId ?? null, fingerprint);
      attachmentIds.forEach((attachmentId, ordinal) => this.#db.prepare('INSERT INTO message_attachments(message_id,attachment_id,ordinal) VALUES(?,?,?)').run(id, attachmentId, ordinal));
      this.#db.prepare('UPDATE conversations SET updated_at=?,hidden_at=NULL WHERE id=?').run(createdAt, message.conversationId);
      const stored = this.#message(row(this.#db.prepare('SELECT * FROM messages WHERE id=?').get(id)));
      if (message.authorId === 'user' && message.replyDirective) {
        this.saveReplyCheckpoint({ conversationId: message.conversationId, sourceMessageId: id,
          dispatcher: 'queue-v1',
          status: message.replyDirective === 'none' ? 'done' : 'pending', delivery: message.replyDirective === 'none' ? 'chat' : message.replyDirective, completedIds: [], updatedAt: createdAt });
      }
      if (message.replyCompletion) this.completeReply(message.conversationId, message.replyCompletion.sourceMessageId, message.replyCompletion.companionId);
      return { message: stored, inserted: true };
    }).immediate();
  }

  listMemory(companionId: string): CompanionMemory[] {
    this.#requireCompanion(companionId);
    return rows(this.#db.prepare(`SELECT memory.data,source.conversation_id AS source_conversation_id FROM memories memory
      LEFT JOIN messages source ON source.id=json_extract(memory.data,'$.sourceMessageId')
      WHERE memory.companion_id=? ORDER BY memory.rowid DESC LIMIT 500`).all(companionId)).map((item) => {
      const memory = decode<CompanionMemory>(item.data);
      return memory.sourceConversationId || !item.source_conversation_id ? memory
        : { ...memory, sourceConversationId: String(item.source_conversation_id) };
    });
  }

  saveMemory(input: SaveCompanionMemory): CompanionMemory {
    const memory = saveCompanionMemorySchema.parse(input);
    return this.#db.transaction(() => {
      this.#requireCompanion(memory.companionId);
      let sourceConversationId: string | undefined;
      if (memory.sourceMessageId) {
        const source = this.#db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(memory.sourceMessageId);
        if (!source) throw new Error('记忆来源消息不存在。');
        sourceConversationId = String(row(source).conversation_id);
        this.#requireMember(sourceConversationId, memory.companionId);
      }
      const previous = memory.id ? this.#db.prepare('SELECT companion_id,data FROM memories WHERE id=?').get(memory.id) : undefined;
      if (previous && row(previous).companion_id !== memory.companionId) throw new Error('不能修改另一个伙伴的记忆。');
      if (memory.id && !previous) throw new Error('记忆不存在。');
      const value: CompanionMemory = { ...memory, id: memory.id ?? randomUUID(), sourceConversationId,
        createdAt: previous ? decode<CompanionMemory>(row(previous).data).createdAt : stamp(), updatedAt: stamp() };
      this.#db.prepare('INSERT INTO memories(id,companion_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, value.companionId, JSON.stringify(value));
      return value;
    }).immediate();
  }

  deleteMemory(id: string): void {
    companionIdSchema.parse(id);
    this.#db.prepare('DELETE FROM memories WHERE id=?').run(id);
  }

  listAction(conversationId?: string): CompanionAction[] {
    if (conversationId) conversationId = this.#conversationId(conversationId);
    if (conversationId) this.#requireConversation(conversationId);
    const found = conversationId ? this.#db.prepare("SELECT data FROM actions WHERE conversation_id=? AND (status IN ('running','queued') OR id IN (SELECT id FROM actions WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100)) ORDER BY rowid DESC").all(conversationId, conversationId)
      : this.#db.prepare("SELECT data FROM actions WHERE status IN ('running','queued') OR id IN (SELECT id FROM actions ORDER BY rowid DESC LIMIT 500) ORDER BY rowid DESC").all();
    return rows(found).map((item) => this.#recoverableAction(decode<CompanionAction>(item.data)));
  }
  #setMetadata(key: string, value: unknown): void { this.#db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify(value)); }
  #recoverableAction(action: CompanionAction): CompanionAction {
    return { ...action, canResume: ['interrupted', 'cancelled', 'failed'].includes(action.status) && !!(this.#db.prepare('SELECT 1 FROM metadata WHERE key=?').get('task-checkpoint/' + action.id) || action.sessionId || action.taskId) };
  }
  checkpoint(id: string): CompanionTaskCheckpoint | undefined {
    this.getAction(id);
    const found = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get('task-checkpoint/' + id);
    return found ? companionTaskCheckpointSchema.parse(decode(row(found).value)) : undefined;
  }
  saveCheckpoint(id: string, checkpoint: CompanionTaskCheckpoint): void {
    this.getAction(id);
    this.#setMetadata('task-checkpoint/' + id, companionTaskCheckpointSchema.parse(checkpoint));
  }
  updateCheckpoint(id: string, update: { execution?: CompanionTaskCheckpoint['execution']; input?: CompanionTaskCheckpoint['supplements'][number] }): void {
    this.#db.transaction(() => {
      const checkpoint = this.checkpoint(id);
      if (!checkpoint) throw new Error('任务恢复记录不存在。');
      if (update.execution) checkpoint.execution = update.execution;
      if (update.input && !checkpoint.supplements.some(item => item.id === update.input!.id)) {
        if (checkpoint.supplements.length >= 100) throw new Error('任务补充恢复队列已满。');
        checkpoint.supplements.push(update.input);
      }
      this.saveCheckpoint(id, checkpoint);
    }).immediate();
  }
  private saveReplyCheckpoint(checkpoint: CompanionReplyRecovery): void {
    this.#setMetadata('reply-source/' + checkpoint.sourceMessageId, checkpoint);
    this.#setMetadata('reply-checkpoint/' + checkpoint.conversationId, checkpoint);
  }
  replyCheckpoint(conversationId: string, sourceMessageId?: string): CompanionReplyRecovery | undefined {
    conversationId = this.#conversationId(conversationId);
    if (sourceMessageId) {
      const stored = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get('reply-source/' + sourceMessageId);
      if (stored) { const result = companionReplyRecoverySchema.parse(decode(row(stored).value)); if (result.conversationId === conversationId) return result; }
    }
    if (!sourceMessageId) {
      const oldest = this.replyRecoveries().find(item => item.conversationId === conversationId);
      if (oldest) return oldest;
    }
    const found = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get('reply-checkpoint/' + conversationId);
    return found ? companionReplyRecoverySchema.parse(decode(row(found).value)) : undefined;
  }
  setReplyStatus(conversationId: string, sourceMessageId: string, status: CompanionReplyRecovery['status']): void {
    if (this.#requireConversation(conversationId).dissolved_at) status = 'cancelled';
    const checkpoint = this.replyCheckpoint(conversationId, sourceMessageId);
    if (checkpoint?.sourceMessageId === sourceMessageId) this.saveReplyCheckpoint({ ...checkpoint, status, updatedAt: stamp() });
  }
  resetReply(conversationId: string, sourceMessageId: string, delivery: CompanionReplyRecovery['delivery']): void {
    conversationId = this.#conversationId(conversationId);
    if (this.getMessage(sourceMessageId).conversationId !== conversationId) throw new Error('回复恢复来源不属于当前聊天。');
    this.saveReplyCheckpoint({ conversationId, sourceMessageId, delivery, status: 'pending', completedIds: [], updatedAt: stamp() });
  }
  completeReply(conversationId: string, sourceMessageId: string, companionId: string): void {
    this.#requireMember(this.#conversationId(conversationId), companionId);
    const checkpoint = this.replyCheckpoint(conversationId, sourceMessageId);
    if (checkpoint?.sourceMessageId === sourceMessageId) this.saveReplyCheckpoint({ ...checkpoint, completedIds: [...new Set([...checkpoint.completedIds, companionId])], updatedAt: stamp() });
  }
  resumeAction(id: string): CompanionAction {
    return this.#db.transaction(() => {
      const action = this.getAction(id);
      this.#requireMember(action.conversationId, action.companionId);
      if (!['interrupted', 'cancelled', 'failed'].includes(action.status) || !this.checkpoint(id)) throw new Error('这条任务没有可用的恢复记录。');
      this.#setMetadata('task-attempt/' + id + '/' + (action.attempt ?? 1), action);
      const resumed: CompanionAction = { ...action, attempt: (action.attempt ?? 1) + 1, attemptCreatedAt: stamp(), status: 'queued', events: [], stage: '正在恢复原任务', updatedAt: stamp() };
      delete resumed.finishedAt; delete resumed.startedAt; delete resumed.result; delete resumed.error; delete resumed.taskId; delete resumed.pid;
      this.#db.prepare("UPDATE actions SET status='queued',data=? WHERE id=?").run(JSON.stringify(resumed), id);
      return resumed;
    }).immediate();
  }

  getAction(id: string): CompanionAction {
    companionIdSchema.parse(id);
    const found = this.#db.prepare('SELECT data FROM actions WHERE id=?').get(id);
    if (!found) throw new Error('行动不存在。');
    return this.#recoverableAction(decode<CompanionAction>(row(found).data));
  }

  /** Keyset pagination keeps older pages stable when new tasks arrive. */
  actionPage(query: CompanionActionPageQuery): CompanionActionPage {
    const input = companionActionPageQuerySchema.parse(query);
    const conversationId = this.#conversationId(input.conversationId);
    this.#requireConversation(conversationId);
    const filters = ['conversation_id=?'], values: unknown[] = [conversationId];
    if (input.companionId) { filters.push('companion_id=?'); values.push(input.companionId); }
    const where = filters.join(' AND ');
    const total = Number(row(this.#db.prepare('SELECT count(*) AS total FROM actions WHERE ' + where).get(...values)).total);
    const timestamp = "json_extract(data,'$.createdAt')";
    if (input.before) {
      filters.push('(' + timestamp + '<? OR (' + timestamp + '=? AND id<?))');
      values.push(input.before.createdAt, input.before.createdAt, input.before.id);
    }
    const found = rows(this.#db.prepare('SELECT data FROM actions WHERE ' + filters.join(' AND ') + ' ORDER BY ' + timestamp + ' DESC,id DESC LIMIT ?').all(...values, input.limit + 1));
    const hasMore = found.length > input.limit;
    const items = found.slice(0, input.limit).map(item => {
      const action = this.#recoverableAction(decode<CompanionAction>(item.data));
      // History lists fetch detail only for the selected task, keeping IPC bounded.
      const summary = { ...action };
      delete summary.events; delete summary.result; delete summary.error;
      return summary;
    });
    const last = items.at(-1);
    const owners = rows(this.#db.prepare('SELECT companion_id,count(*) AS total FROM actions WHERE conversation_id=? GROUP BY companion_id').all(conversationId)).map(item => {
      const id = String(item.companion_id), found = this.#db.prepare('SELECT data FROM companions WHERE id=?').get(id);
      return { companionId: id, name: found ? decode<Companion>(row(found).data).name : '已移除的伙伴', count: Number(item.total) };
    });
    return { items, hasMore, ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}), total, owners };
  }

  createAction(input: CreateCompanionAction, checkpoint?: CompanionTaskCheckpoint): CompanionAction {
    const action = createCompanionActionSchema.parse(input);
    action.conversationId = this.#conversationId(action.conversationId);
    return this.#db.transaction(() => {
      this.#requireConversation(action.conversationId);
      this.#requireMember(action.conversationId, action.companionId);
      const source = this.#db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(action.sourceMessageId);
      if (!source || row(source).conversation_id !== action.conversationId) throw new Error('行动来源不属于这个聊天。');
      const value: CompanionAction = { ...action, id: randomUUID(), createdAt: stamp(), updatedAt: stamp() };
      this.#db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)').run(value.id, value.conversationId, value.companionId, value.status, JSON.stringify(value));
      if (checkpoint) this.saveCheckpoint(value.id, checkpoint);
      return value;
    }).immediate();
  }

  updateAction(id: string, input: UpdateCompanionAction): CompanionAction {
    companionIdSchema.parse(id);
    const patch = updateCompanionActionSchema.parse(input);
    return this.#db.transaction(() => {
      const found = this.#db.prepare('SELECT data FROM actions WHERE id=?').get(id);
      if (!found) throw new Error('行动不存在。');
      const previous = decode<CompanionAction>(row(found).data);
      const updatedAt = stamp();
      const value: CompanionAction = { ...previous, ...patch, updatedAt,
        ...(!['queued', 'running'].includes(patch.status ?? previous.status) && !previous.finishedAt ? { finishedAt: updatedAt } : {}) };
      this.#db.prepare('UPDATE actions SET data=?,status=? WHERE id=?').run(JSON.stringify(value), value.status, id);
      return value;
    }).immediate();
  }

  interruptPendingActions(): void {
    this.#db.transaction(() => {
      const pending = rows(this.#db.prepare("SELECT id,data FROM actions WHERE status IN ('queued','running')").all());
      for (const found of pending) {
        const updatedAt = stamp();
        const value: CompanionAction = { ...decode<CompanionAction>(found.data), status: 'interrupted', error: '应用上次退出时行动尚未完成，请重新发起。', updatedAt, finishedAt: updatedAt };
        this.#db.prepare("UPDATE actions SET data=?,status='interrupted' WHERE id=?").run(JSON.stringify(value), found.id);
      }
      for (const found of rows(this.#db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'reply-checkpoint/%' OR key LIKE 'reply-source/%'").all())) {
        const checkpoint = companionReplyRecoverySchema.parse(decode(found.value));
        if (checkpoint.status === 'pending') this.#setMetadata(String(found.key), { ...checkpoint, status: 'interrupted', updatedAt: stamp() });
      }
    }).immediate();
  }

  registerAttachment(input: StoredCompanionAttachment): StoredCompanionAttachment {
    const value = storedCompanionAttachmentSchema.parse(input);
    const basename = path.posix.basename(value.relativePath);
    if (basename.split('.')[0] !== value.attachment.id) throw new Error('附件文件名必须与文件标识一致。');
    this.#db.prepare('INSERT INTO attachments(id,data,relative_path) VALUES(?,?,?)').run(value.attachment.id, JSON.stringify({ ...value.attachment, ...(value.sourcePath ? { path: value.sourcePath } : {}) }), value.relativePath);
    return value;
  }

  getAttachment(id: string): StoredCompanionAttachment {
    companionIdSchema.parse(id);
    const found = this.#db.prepare('SELECT data,relative_path FROM attachments WHERE id=?').get(id);
    if (!found) throw new Error('附件不存在。');
    const attachment = decode<StoredCompanionAttachment['attachment']>(row(found).data);
    return { attachment, relativePath: String(row(found).relative_path), ...(attachment.path ? { sourcePath: attachment.path } : {}) };
  }

  getProactive(companionId: string): CompanionProactiveState {
    this.#requireCompanion(companionId);
    const found = this.#db.prepare('SELECT data FROM proactive_state WHERE companion_id=?').get(companionId);
    return found ? decode<CompanionProactiveState>(row(found).data) : { count: 0 };
  }

  recordProactiveAttempt(companionId: string, at: string): CompanionProactiveState {
    const input = companionStorageCommandSchema.parse({ type: 'proactive.attempt', companionId, at });
    if (input.type !== 'proactive.attempt') throw new Error('Invalid proactive attempt.');
    return this.#db.transaction(() => {
      const previous = this.getProactive(companionId);
      const lastAttemptAt = previous.lastAttemptAt && Date.parse(previous.lastAttemptAt) > Date.parse(at) ? previous.lastAttemptAt : at;
      const value: CompanionProactiveState = { ...previous, lastAttemptAt };
      this.#db.prepare('INSERT INTO proactive_state(companion_id,data) VALUES(?,?) ON CONFLICT(companion_id) DO UPDATE SET data=excluded.data').run(companionId, JSON.stringify(value));
      return value;
    }).immediate();
  }

  recordProactive(companionId: string, lastUserMessageId: string, sentAt: string, date: string): CompanionProactiveState {
    const input = companionStorageCommandSchema.parse({ type: 'proactive.record', companionId, lastUserMessageId, sentAt, date });
    if (input.type !== 'proactive.record') throw new Error('Invalid proactive record.');
    return this.#db.transaction(() => {
      const previous = this.getProactive(companionId);
      const source = this.#db.prepare('SELECT conversation_id,author_id FROM messages WHERE id=?').get(lastUserMessageId);
      if (!source || row(source).author_id !== 'user') throw new Error('主动联系的来源消息无效。');
      this.#requireMember(String(row(source).conversation_id), companionId);
      if (previous.lastUserMessageId === lastUserMessageId) return previous;
      const value: CompanionProactiveState = { ...previous, lastSentAt: sentAt, lastUserMessageId, date, count: previous.date === date ? previous.count + 1 : 1 };
      this.#db.prepare('INSERT INTO proactive_state(companion_id,data) VALUES(?,?) ON CONFLICT(companion_id) DO UPDATE SET data=excluded.data').run(companionId, JSON.stringify(value));
      return value;
    }).immediate();
  }

  request(input: CompanionStorageCommand): CompanionStorageResponse {
    const command = companionStorageCommandSchema.parse(input);
    if ('conversationId' in command && command.conversationId) command.conversationId = this.#conversationId(command.conversationId);
    if (command.type === 'message.append') command.message.conversationId = this.#conversationId(command.message.conversationId);
    if (command.type === 'action.create') command.action.conversationId = this.#conversationId(command.action.conversationId);
    if (command.type === 'conversation.update' || command.type === 'conversation.read') command.id = this.#conversationId(command.id);
    switch (command.type) {
      case 'state': return { ok: true, state: this.state(command.includeHidden) };
      case 'companion.create': return { ok: true, companion: this.createCompanion(command.companion) };
      case 'companion.update': return { ok: true, companion: this.updateCompanion(command.id, command.companion) };
      case 'companion.delete': this.deleteCompanion(command.id); return { ok: true };
      case 'companion.restore-builtin': return { ok: true, companion: this.restoreBuiltin(command.id) };
      case 'conversation.open': return { ok: true, conversation: this.openPrivate(command.companionId) };
      case 'conversation.create-group': return { ok: true, conversation: this.createConversation(command.title, command.memberIds) };
      case 'conversation.update': return { ok: true, conversation: this.updateConversation(command.id, command) };
      case 'conversation.read': return { ok: true, conversation: this.markRead(command.id, command.sequence) };
      case 'conversation.delete': this.deleteConversation(command.id, command.mode); return { ok: true };
      case 'conversation.reopen': {
        const conversation = this.#requireConversation(command.id);
        if (conversation.dissolved_at) throw new Error('这个群聊已经解散。');
        this.#db.prepare('UPDATE conversations SET hidden_at=NULL WHERE id=?').run(conversation.id);
        return { ok: true, conversation: this.#conversation(conversation) };
      }
      case 'messages': return { ok: true, ...this.messages(command) };
      case 'message.get': return { ok: true, message: this.getMessage(command.id) };
      case 'message.search': return { ok: true, ...this.search(command) };
      case 'message.append': return { ok: true, ...this.appendMessageResult(command.message) };
      case 'memory.list': return { ok: true, memories: this.listMemory(command.companionId) };
      case 'memory.save': return { ok: true, memories: [this.saveMemory(command.memory)] };
      case 'memory.delete': this.deleteMemory(command.id); return { ok: true };
      case 'actions': return { ok: true, actions: this.listAction(command.conversationId) };
      case 'actions.page': return { ok: true, actionPage: this.actionPage(command) };
      case 'action.get': return { ok: true, action: this.getAction(command.id) };
      case 'action.create': return { ok: true, action: this.createAction(command.action, command.checkpoint) };
      case 'checkpoint.get': return { ok: true, checkpoint: this.checkpoint(command.id) };
      case 'checkpoint.save': this.saveCheckpoint(command.id, command.checkpoint); return { ok: true };
      case 'checkpoint.execution': this.updateCheckpoint(command.id, { execution: command.execution }); return { ok: true };
      case 'checkpoint.input': this.updateCheckpoint(command.id, { input: command.input }); return { ok: true };
      case 'action.resume': return { ok: true, action: this.resumeAction(command.id) };
      case 'reply.checkpoint.get': return { ok: true, replyRecovery: this.replyCheckpoint(command.conversationId, command.sourceMessageId) };
      case 'loop.get': return { ok: true, loop: this.loopCheckpoint(command.sourceMessageId, command.companionId) };
      case 'loop.save': this.saveLoop(command.checkpoint); return { ok: true };
      case 'work.enqueue': this.enqueueWork(command.work, command.resume); return { ok: true };
      case 'work.claim': return { ok: true, work: this.claimWork() };
      case 'work.list': return { ok: true, works: this.workList(command.sourceMessageId, command.unfinishedOnly) };
      case 'work.status': this.workStatus(command.id, command.status); return { ok: true };
      case 'work.promote': {
        this.#db.transaction(() => {
          const works = this.workList(command.sourceMessageId);
          if (works.some(work => work.status === 'running' || work.status === 'done')) throw new Error('这条消息已经开始处理，不能再从队列转为引导。');
          for (const work of works) if (work.status === 'queued') this.workStatus(work.id, 'cancelled');
        }).immediate();
        return { ok: true };
      }
      case 'work.interrupt-running': {
        for (const work of this.workList(undefined, true)) if (work.status === 'running') this.workStatus(work.id, 'interrupted');
        return { ok: true };
      }
      case 'reply.checkpoint.status': this.setReplyStatus(command.conversationId, command.sourceMessageId, command.status); return { ok: true };
      case 'reply.checkpoint.complete': this.completeReply(command.conversationId, command.sourceMessageId, command.companionId); return { ok: true };
      case 'reply.checkpoint.reset': this.resetReply(command.conversationId, command.sourceMessageId, command.delivery); return { ok: true };
      case 'action.update': return { ok: true, action: this.updateAction(command.id, command.patch) };
      case 'action.interrupt-pending': this.interruptPendingActions(); return { ok: true };
      case 'attachment.register': return { ok: true, storedAttachment: this.registerAttachment(command.stored), attachments: [command.stored.attachment] };
      case 'attachment.get': return { ok: true, storedAttachment: this.getAttachment(command.id) };
      case 'proactive.get': return { ok: true, proactive: this.getProactive(command.companionId) };
      case 'proactive.attempt': return { ok: true, proactive: this.recordProactiveAttempt(command.companionId, command.at) };
      case 'proactive.record': return { ok: true, proactive: this.recordProactive(command.companionId, command.lastUserMessageId, command.sentAt, command.date) };
    }
  }
}
