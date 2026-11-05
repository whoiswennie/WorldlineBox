import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { BotDshHandoff } from './dsh-brain';
import { botTaskRemovalFingerprint } from './task-history';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import { BOT_PERSONA_TEMPLATE_LIMIT, type BotConversationActivity, type BotHistoryFilter, type BotReplyTiming, type BotCompanionPresence, type BotCompanionPresenceEvent, type BotPersonaTemplate, type BotPersonaTemplateList, type BotPersonaTemplateSummary } from '../../shared/companion-bot';
import { builtinBotPersonaTemplates } from '../../shared/builtin-bot-personas';
import type { BotMemoryActivity, BotMemoryRecallReport } from '../../shared/companion-bot-memory';
import { botMessageEvidence } from '../../shared/bot-message-content';
import { BotActivityBudget, BotActivityLimitError, BotBackpressureError, isInteractiveBotSource, type BotActivityBudgetPolicy } from './activity-budget';
import { routeGroupAttention, GROUP_CANDIDATE_LIMIT, GROUP_REPLY_LIMIT, GROUP_DISCUSSION_MS, isGroupStop, type GroupRouting } from './group-attention';
import { botBrainRequestMetricsSchema, type BotBrainContextSummary, type BotBrainRequestMetrics } from '../../shared/companion-bot-context';
import type { BotClaim, BotCompanion, BotConversation, BotConversationKind, BotEnqueueInput, BotEvent,
  BotEventStatus, BotLane, BotMemoryJob, BotMemoryJobClaim, BotMemoryJobInput, BotMessage, BotMessagePage, BotSenderType, BotTask, BotTaskStatus, BotAttachmentGrant } from './types';

interface Statement {
  all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown;
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface Connection {
  prepare(sql: string): Statement; exec(sql: string): void;
  function(name: string, options: { deterministic: boolean }, callback: (value: unknown) => number): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): (() => T) & { immediate(): T }; close(): void;
}
export type BotTaskSql = Pick<Connection, 'prepare'>;
type Row = Record<string, string | number | null>;
const asRow = (raw: unknown): Row => raw as Row;
const hash = (parts: readonly string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const nowIso = () => new Date().toISOString();
const memoryBlockedCte = `WITH audience(domain_key,companion_id) AS(VALUES(?,?)),blocked(id) AS(
  SELECT w.source_id FROM bot_withdrawn_sources w,audience a WHERE w.domain_key=a.domain_key
  UNION SELECT p.message_id FROM bot_publications p JOIN bot_withdrawn_sources w ON w.source_id=p.event_id,audience a WHERE w.domain_key=a.domain_key
  UNION SELECT i.source_record_id FROM bot_inbox i JOIN bot_withdrawn_sources w ON w.source_id=i.id,audience a WHERE w.domain_key=a.domain_key AND i.companion_id=a.companion_id
  UNION SELECT i.reply_message_id FROM bot_inbox i JOIN bot_withdrawn_sources w ON w.source_id=i.id,audience a WHERE w.domain_key=a.domain_key AND i.companion_id=a.companion_id
  UNION SELECT s.message_id FROM bot_message_sources s JOIN bot_withdrawn_sources w ON w.source_id=s.source_id,audience a WHERE w.domain_key=a.domain_key)`;
const optional = (value: string | number | null | undefined) => value == null ? undefined : String(value);
const text = (value: string, label: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}无效或超过${max}字符。`);
  return value.trim();
};
const personaPrompt = (value: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 24000 || value.includes('\0')) throw new Error('人格提示词需要 1 至 24000 个字符。');
  return value;
};
const bounded = (value: number | undefined, fallback: number, max: number) => Math.min(max, Math.max(1, Number.isSafeInteger(value) ? value! : fallback));
const taskStatuses = new Set<BotTaskStatus>(['queued', 'running', 'waiting', 'paused', 'succeeded', 'failed', 'cancelled', 'unknown']);
const timingFields = ['elapsedMs', 'queueMs', 'prepareMs', 'firstTextMs', 'modelMs', 'finishMs'] as const;
const validMilliseconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const turnTiming = (json: unknown): Partial<BotReplyTiming> => {
  try {
    const parsed = JSON.parse(String(json ?? '{}')) as Record<string, unknown>, result: Partial<BotReplyTiming> = {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    for (const field of timingFields) if (validMilliseconds(parsed[field])) result[field] = parsed[field];
    return result;
  } catch { return {}; }
};
export interface BotTurnTimingUpdate { prepareMs?: number; modelMs?: number; firstTextAt?: number; finishMs?: number }
const historyHasLink = (value: unknown): number => {
  if (typeof value !== 'string') return 0;
  for (const match of value.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/giu)) {
    const candidate = match[0].replace(/[.,!?;:，。！？；：、）)\]}]+$/u, '');
    try { const url = new URL(/^www\./i.test(candidate) ? `https://${candidate}` : candidate); if (['http:', 'https:'].includes(url.protocol) && url.hostname) return 1; } catch { /* Not a usable HTTP address. */ }
  }
  return 0;
};
export const botLaneRetentionKey = (laneId: string) => `lane-retention:${laneId}`;
export interface BotLaneRetentionState {
  epoch: number; turns: number; bytes: number;
  last?: { eventId: string; system: string; cwd: string; nativeLaneId: string };
  handoff?: BotDshHandoff; handoffEventId?: string;
}
export interface BotNativeAdmission {
  eventId: string; epoch: number; nativeLaneId: string; system: string; cwd: string; inputBytes: number;
}
export interface BotHistoryProjectionRow { projectionSequence: number; timestamp: number; message: BotMessage }
export interface BotGroupAdminChange { conversation:BotConversation; eventIds:string[]; taskIds:string[] }
export interface BotDevelopmentDefaultCleanup {
  phase: 'retiring' | 'sql-deleted' | 'complete'; conversationIds: string[]; laneIds: string[];
  scopes: Array<{ companionId: string; conversationId: string; securityDomainId: string }>;
  taskWorkspaces: Array<{ taskId: string; securityDomainId: string }>;
}
const developmentDefault = 'default-companion', defaultCleanupKey = 'development-default-cleanup';

/** One small SQLite database owns bot ingress and UI projections; no legacy registry reads. */
export class BotStore {
  private readonly db: Connection;
  private readonly activityBudget: BotActivityBudget;
  private taskBudgetAuthority?: (taskId: string) => boolean;
  setTaskBudgetAuthority(authorize: (taskId: string) => boolean): void { this.taskBudgetAuthority = authorize; }
  constructor(readonly filename: string, options: { activityBudget?: Partial<BotActivityBudgetPolicy> } = {}) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    const Database = BetterSqlite3 as { new(filename: string): Connection };
    this.db = new Database(filename);
    this.db.function('bot_history_has_link', { deterministic: true }, historyHasLink);
    try { this.activityBudget = new BotActivityBudget(this, options.activityBudget); } catch (error) { this.db.close(); throw error; }
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > 18) { this.db.close(); throw new Error('伙伴数据库来自更高版本，拒绝降级打开。'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_companions(id TEXT PRIMARY KEY,name TEXT NOT NULL,persona TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,scope_id TEXT NOT NULL,domain_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,direct_key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS bot_members(conversation_id TEXT NOT NULL REFERENCES bot_conversations(id) ON DELETE CASCADE,member_id TEXT NOT NULL,PRIMARY KEY(conversation_id,member_id));
      CREATE TABLE IF NOT EXISTS bot_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,event_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES bot_conversations(id),sender_id TEXT NOT NULL,sender_name TEXT NOT NULL,sender_type TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,kind TEXT NOT NULL,correlation_id TEXT NOT NULL,created_at TEXT NOT NULL,error TEXT);
      CREATE INDEX IF NOT EXISTS bot_messages_page ON bot_messages(conversation_id,sequence DESC);
      CREATE TABLE IF NOT EXISTS bot_origins(origin_key TEXT PRIMARY KEY,content_hash TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES bot_messages(id));
      CREATE TABLE IF NOT EXISTS bot_lanes(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES bot_conversations(id),companion_id TEXT NOT NULL REFERENCES bot_companions(id),session_id TEXT,acl_revision INTEGER NOT NULL,epoch INTEGER NOT NULL DEFAULT 1,last_claimed_at INTEGER NOT NULL DEFAULT 0,UNIQUE(conversation_id,companion_id));
      CREATE TABLE IF NOT EXISTS bot_inbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,lane_id TEXT NOT NULL REFERENCES bot_lanes(id),conversation_id TEXT NOT NULL,companion_id TEXT NOT NULL,source TEXT NOT NULL,source_instance_id TEXT NOT NULL,source_message_id TEXT NOT NULL,sender_id TEXT NOT NULL,sender_type TEXT NOT NULL,sender_name TEXT NOT NULL,scope_id TEXT NOT NULL,domain_id TEXT NOT NULL,acl_revision INTEGER NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,payload_json TEXT NOT NULL,correlation_id TEXT NOT NULL,causation_id TEXT,source_record_id TEXT NOT NULL,reply_message_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,lease_token TEXT,lease_until INTEGER,available_at INTEGER NOT NULL DEFAULT 0,dsh_event_id TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS bot_inbox_claim ON bot_inbox(status,available_at,sequence);
      CREATE INDEX IF NOT EXISTS bot_inbox_lane ON bot_inbox(lane_id,status,sequence);
      CREATE INDEX IF NOT EXISTS bot_inbox_conversation_status ON bot_inbox(conversation_id,status);
      CREATE INDEX IF NOT EXISTS bot_inbox_conversation_correlation ON bot_inbox(conversation_id,correlation_id,status);
      CREATE TABLE IF NOT EXISTS bot_outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES bot_messages(id),status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,delivered_at TEXT);
      CREATE INDEX IF NOT EXISTS bot_outbox_pending ON bot_outbox(status,created_at);
      CREATE TABLE IF NOT EXISTS bot_tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES bot_conversations(id),companion_id TEXT NOT NULL REFERENCES bot_companions(id),source_event_id TEXT NOT NULL,goal TEXT NOT NULL,status TEXT NOT NULL,attempt_id TEXT NOT NULL,dsh_task_id TEXT,session_id TEXT,summary TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,extra_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_tasks_scope ON bot_tasks(conversation_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS bot_peer_bridges(source_owner TEXT NOT NULL,source_domain TEXT NOT NULL,source_id TEXT NOT NULL,target_conversation_id TEXT NOT NULL REFERENCES bot_conversations(id) ON DELETE CASCADE,target_message_id TEXT NOT NULL REFERENCES bot_messages(id) ON DELETE CASCADE,PRIMARY KEY(source_owner,source_domain,source_id,target_message_id));
      CREATE INDEX IF NOT EXISTS bot_peer_bridge_source ON bot_peer_bridges(source_owner,source_domain,source_id);
      CREATE TABLE IF NOT EXISTS bot_deferred_task_notices(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_memory_jobs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,domain_key TEXT NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS bot_memory_inspections(owner_key TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,report_json TEXT NOT NULL,PRIMARY KEY(owner_key,id));
      CREATE INDEX IF NOT EXISTS bot_memory_inspections_recent ON bot_memory_inspections(owner_key,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS bot_memory_jobs_claim ON bot_memory_jobs(status,available_at,sequence);
      CREATE INDEX IF NOT EXISTS bot_memory_jobs_domain ON bot_memory_jobs(domain_key,status);
      CREATE TABLE IF NOT EXISTS bot_withdrawn_sources(domain_key TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(domain_key,source_id));
      CREATE TABLE IF NOT EXISTS bot_history_projection(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE REFERENCES bot_messages(id),conversation_id TEXT NOT NULL REFERENCES bot_conversations(id),timestamp INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_history_projection_cursor ON bot_history_projection(conversation_id,sequence);
      CREATE TABLE IF NOT EXISTS bot_native_retirements(event_id TEXT PRIMARY KEY REFERENCES bot_inbox(id),lane_id TEXT NOT NULL,admission_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,source_sequence INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_native_retirements_lane ON bot_native_retirements(lane_id,source_sequence);
      CREATE INDEX IF NOT EXISTS bot_native_retirements_ready ON bot_native_retirements(retry_at,lane_id);
      CREATE TABLE IF NOT EXISTS bot_task_questions(task_id TEXT NOT NULL REFERENCES bot_tasks(id),question_id TEXT NOT NULL,call_id TEXT NOT NULL,questions_json TEXT NOT NULL,answers_json TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(task_id,question_id));
      CREATE INDEX IF NOT EXISTS bot_task_questions_state ON bot_task_questions(task_id,state,created_at);
      CREATE TABLE IF NOT EXISTS bot_task_answer_receipts(task_id TEXT NOT NULL REFERENCES bot_tasks(id),question_id TEXT NOT NULL,answers_hash TEXT NOT NULL,PRIMARY KEY(task_id,question_id));
      CREATE TABLE IF NOT EXISTS bot_task_effects(task_id TEXT NOT NULL REFERENCES bot_tasks(id),call_id TEXT NOT NULL,tool_name TEXT NOT NULL,args_hash TEXT NOT NULL,preview TEXT NOT NULL,state TEXT NOT NULL,provenance TEXT NOT NULL,retry_budget INTEGER NOT NULL DEFAULT 0,is_error INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(task_id,call_id));
      CREATE INDEX IF NOT EXISTS bot_task_effects_pending ON bot_task_effects(task_id,state);
      CREATE INDEX IF NOT EXISTS bot_task_effects_signature ON bot_task_effects(task_id,tool_name,args_hash,state);
      CREATE TABLE IF NOT EXISTS bot_task_controls(task_id TEXT NOT NULL REFERENCES bot_tasks(id),request_id TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(task_id,request_id));
      CREATE TABLE IF NOT EXISTS bot_publications(event_id TEXT NOT NULL REFERENCES bot_inbox(id),call_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES bot_messages(id),fingerprint TEXT NOT NULL,PRIMARY KEY(event_id,call_id));
      CREATE TABLE IF NOT EXISTS bot_media_grants(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,media_id TEXT NOT NULL,origin_message_id TEXT NOT NULL REFERENCES bot_messages(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS bot_media_grant_sources(grant_id TEXT NOT NULL REFERENCES bot_media_grants(id) ON DELETE CASCADE,source_id TEXT NOT NULL,PRIMARY KEY(grant_id,source_id));
      CREATE INDEX IF NOT EXISTS bot_media_grant_source_lookup ON bot_media_grant_sources(source_id,grant_id);
      CREATE TABLE IF NOT EXISTS bot_message_media_grants(message_id TEXT NOT NULL REFERENCES bot_messages(id) ON DELETE CASCADE,media_id TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES bot_media_grants(id) ON DELETE CASCADE,PRIMARY KEY(message_id,media_id));
      CREATE TABLE IF NOT EXISTS bot_task_media_grants(task_id TEXT NOT NULL REFERENCES bot_tasks(id) ON DELETE CASCADE,media_id TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES bot_media_grants(id) ON DELETE CASCADE,PRIMARY KEY(task_id,media_id));
      CREATE INDEX IF NOT EXISTS bot_task_grant_lookup ON bot_task_media_grants(grant_id,task_id);
      CREATE TABLE IF NOT EXISTS bot_message_sources(message_id TEXT NOT NULL REFERENCES bot_messages(id) ON DELETE CASCADE,source_id TEXT NOT NULL,PRIMARY KEY(message_id,source_id));
      CREATE INDEX IF NOT EXISTS bot_message_source_lookup ON bot_message_sources(source_id,message_id);
      CREATE TABLE IF NOT EXISTS bot_source_withdraw_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,domain_key TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES bot_messages(id) ON DELETE CASCADE,UNIQUE(domain_key,message_id));
      CREATE INDEX IF NOT EXISTS bot_source_withdraw_cursor ON bot_source_withdraw_outbox(domain_key,sequence);
    `);
    if (version < 3) this.db.transaction(() => {
      // One-time v2 development-state upgrade. Older reply jobs used their
      // publication timestamp rather than the placeholder creation time; keep
      // those exact bytes so VCP's existing idempotency receipts still match.
      const timestamps = new Map<string, number>();
      for (const raw of this.db.prepare("SELECT payload_json FROM bot_memory_jobs WHERE kind='projection' ORDER BY sequence").all()) {
        const payload = JSON.parse(String(asRow(raw).payload_json)) as { messages?: Array<{ id?: string; timestamp?: number }> };
        for (const message of payload.messages ?? []) if (message.id && Number.isFinite(message.timestamp) && !timestamps.has(message.id)) timestamps.set(message.id, message.timestamp!);
      }
      for (const raw of this.db.prepare("SELECT * FROM bot_messages WHERE status='sent' ORDER BY sequence").all()) {
        const message = this.message(raw); this.recordHistoryProjection(message.id, timestamps.get(message.id));
      }
      this.db.pragma('user_version = 3');
    }).immediate();
    if (version < 4) this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO bot_native_retirements(event_id,lane_id,admission_json,source_sequence)
        SELECT i.id,i.lane_id,m.value,i.sequence FROM bot_inbox i JOIN bot_metadata m ON m.key='native-admission:'||i.id
        WHERE i.status='cancelled' AND m.value<>'' AND NOT EXISTS(SELECT 1 FROM bot_metadata done WHERE done.key='native-terminal-counted:'||i.id)`).run();
      this.db.pragma('user_version = 4');
    }).immediate();
    if (version < 5) this.db.pragma('user_version = 5');
    if (version < 6) this.db.pragma('user_version = 6');
    if (version < 8) this.db.transaction(() => {
      for (const table of ['bot_task_questions', 'bot_task_effects']) for (const column of ['native_session_id', 'native_call_id']) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(raw => asRow(raw).name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
      this.db.pragma('user_version = 8');
    }).immediate();
    if (version < 9) this.db.transaction(() => {
      // The two character appearances are static persona materials, never a
      // functional setting. Remove the brief development-only state column.
      if (this.db.prepare('PRAGMA table_info(bot_companions)').all().some(raw => asRow(raw).name === 'appearance_mode')) this.db.exec('ALTER TABLE bot_companions DROP COLUMN appearance_mode');
      this.db.pragma('user_version = 9');
    }).immediate();
    if (version < 10) this.db.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(bot_messages)').all().some(raw => asRow(raw).name === 'attachments_json')) this.db.exec("ALTER TABLE bot_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
      this.db.pragma('user_version = 10');
    }).immediate();
    if (version < 11) this.db.transaction(() => {
      for (const column of ['task_id', 'relative_path']) if (!this.db.prepare('PRAGMA table_info(bot_publications)').all().some(raw => asRow(raw).name === column)) this.db.exec(`ALTER TABLE bot_publications ADD COLUMN ${column} TEXT`);
      this.db.exec('CREATE INDEX IF NOT EXISTS bot_publications_task ON bot_publications(task_id)'); this.db.pragma('user_version = 11');
    }).immediate();
    this.db.exec(`CREATE INDEX IF NOT EXISTS bot_messages_media ON bot_messages(conversation_id,sequence DESC) WHERE attachments_json<>'[]';
      CREATE INDEX IF NOT EXISTS bot_inbox_source_record ON bot_inbox(source_record_id,companion_id);
      CREATE INDEX IF NOT EXISTS bot_inbox_reply_record ON bot_inbox(reply_message_id,companion_id);
      CREATE INDEX IF NOT EXISTS bot_inbox_peer_cause ON bot_inbox(causation_id,source);
      CREATE INDEX IF NOT EXISTS bot_tasks_source_event ON bot_tasks(source_event_id);
      CREATE INDEX IF NOT EXISTS bot_publications_message ON bot_publications(message_id);`);
    this.db.exec('CREATE INDEX IF NOT EXISTS bot_publications_task_path ON bot_publications(task_id,relative_path)');
    if (version < 12) this.db.transaction(() => {
      // Only explicit user attachments are independently provable in older
      // development records. Do not invent grants for untracked derived media.
      for (const raw of this.db.prepare("SELECT * FROM bot_messages WHERE sender_type='user' AND status='sent' AND attachments_json<>'[]'").all()) {
        const message = this.message(raw), events = this.db.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').all(message.id).map(value => String(asRow(value).id));
        this.bindMessageAttachments(message, true, undefined, events);
      }
      for (const raw of this.db.prepare("SELECT * FROM bot_tasks WHERE json_array_length(extra_json,'$.attachmentIds')>0").all()) {
        const task = this.task(raw), source = this.getEvent(task.sourceEventId); if (!source) continue;
        if (['queued', 'running', 'waiting', 'paused', 'unknown'].includes(task.status)) this.updateTask(task.id, { extra: { ...task.extra, cancelRequested: true, retryAt: 0 } });
        for (const notice of this.db.prepare("SELECT DISTINCT source_record_id FROM bot_inbox WHERE companion_id=? AND domain_id=? AND source='task' AND json_extract(payload_json,'$.taskId')=?").all(task.companionId, source.securityDomainId, task.id)) this.bindMessageSources(String(asRow(notice).source_record_id), [task.id]);
        this.withdrawSources(task.companionId, source.securityDomainId, [task.id]);
      }
      // Unknown v11 derived attachments remain visible to the local user as
      // historical records, but gain no model/history authority by inference.
      for (const raw of this.db.prepare("SELECT * FROM bot_messages m WHERE m.sender_type<>'user' AND m.attachments_json<>'[]' AND NOT EXISTS(SELECT 1 FROM bot_message_media_grants g WHERE g.message_id=m.id)").all()) {
        const message = this.message(raw), conversation = this.getConversation(message.conversationId)!;
        for (const member of conversation.memberIds.filter(id => id !== 'user')) this.db.prepare('INSERT OR IGNORE INTO bot_withdrawn_sources VALUES(?,?)').run(hash([member, conversation.securityDomainId]), message.id);
      }
      this.db.pragma('user_version = 12');
    }).immediate();
    if (version < 13) this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO bot_source_withdraw_outbox(domain_key,message_id) SELECT w.domain_key,m.id FROM bot_withdrawn_sources w JOIN bot_messages m ON m.id=w.source_id ORDER BY m.sequence').run();
      this.db.prepare("DELETE FROM bot_metadata WHERE key LIKE 'native-withdrawal-cursor:%'").run();
      this.db.pragma('user_version = 13');
    }).immediate();
    if (version < 14) {
      try { this.db.transaction(() => {
        if (!this.db.prepare('PRAGMA table_info(bot_messages)').all().some(raw => asRow(raw).name === 'timing_json')) this.db.exec("ALTER TABLE bot_messages ADD COLUMN timing_json TEXT NOT NULL DEFAULT '{}'");
        // Trigram postings index literal Chinese substrings and punctuation.
        // Keep SQL triggers so non-Service writes and legacy cleanup stay atomic.
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS bot_message_search USING fts5(content,attachment_names,tokenize='trigram');
          DELETE FROM bot_message_search;
          INSERT INTO bot_message_search(rowid,content,attachment_names)
            SELECT m.sequence,m.content,COALESCE((SELECT group_concat(json_extract(a.value,'$.name'),char(10)) FROM json_each(m.attachments_json) a),'')
            FROM bot_messages m WHERE length(trim(m.content))>0 OR json_array_length(m.attachments_json)>0;
          DROP TRIGGER IF EXISTS bot_messages_search_insert;
          DROP TRIGGER IF EXISTS bot_messages_search_update;
          DROP TRIGGER IF EXISTS bot_messages_search_delete;
          CREATE TRIGGER bot_messages_search_insert AFTER INSERT ON bot_messages
            WHEN length(trim(new.content))>0 OR json_array_length(new.attachments_json)>0
            BEGIN INSERT INTO bot_message_search(rowid,content,attachment_names) VALUES(new.sequence,new.content,
              COALESCE((SELECT group_concat(json_extract(a.value,'$.name'),char(10)) FROM json_each(new.attachments_json) a),'')); END;
          CREATE TRIGGER bot_messages_search_update AFTER UPDATE OF content,attachments_json ON bot_messages BEGIN
            DELETE FROM bot_message_search WHERE rowid=old.sequence;
            INSERT INTO bot_message_search(rowid,content,attachment_names) SELECT new.sequence,new.content,
              COALESCE((SELECT group_concat(json_extract(a.value,'$.name'),char(10)) FROM json_each(new.attachments_json) a),'')
              WHERE length(trim(new.content))>0 OR json_array_length(new.attachments_json)>0; END;
          CREATE TRIGGER bot_messages_search_delete AFTER DELETE ON bot_messages BEGIN DELETE FROM bot_message_search WHERE rowid=old.sequence; END;
          UPDATE bot_messages AS m SET timing_json=(SELECT json_object('elapsedMs',CAST(round((julianday(o.created_at)-julianday(i.received_at))*86400000) AS INTEGER))
            FROM bot_inbox i JOIN bot_outbox o ON o.id=m.id AND o.message_id=m.id AND o.event_id=i.id
            WHERE (i.status='done' OR m.id<>i.reply_message_id) AND julianday(o.created_at)>=julianday(i.received_at))
          WHERE m.status='sent' AND m.sender_type='companion' AND EXISTS(SELECT 1 FROM bot_inbox i JOIN bot_outbox o ON o.id=m.id AND o.message_id=m.id AND o.event_id=i.id
            WHERE (i.status='done' OR m.id<>i.reply_message_id) AND julianday(o.created_at)>=julianday(i.received_at));`);
        // Only successful old replies have a trustworthy terminal timestamp in
        // Outbox. Never invent elapsed time for old failed/cancelled records.
        this.db.pragma('user_version = 14');
      }).immediate(); } catch (error) { this.db.close(); throw error; }
    }
    if (version < 15) {
      try { this.db.transaction(() => {
        // Paused work and removed-history tombstones require new readers.
        // Advance the compatibility boundary atomically, so older runtimes
        // refuse to reopen data whose admission/lifecycle rules they lack.
        this.db.exec(`CREATE INDEX IF NOT EXISTS bot_tasks_visible_scope_status ON bot_tasks(conversation_id,status) WHERE json_extract(extra_json,'$.removedAt') IS NULL;
          CREATE INDEX IF NOT EXISTS bot_tasks_visible_created ON bot_tasks(conversation_id,CASE WHEN status IN ('queued','running','waiting','paused','unknown') THEN 0 ELSE 1 END,created_at DESC,id DESC) WHERE json_extract(extra_json,'$.removedAt') IS NULL;
          CREATE INDEX IF NOT EXISTS bot_tasks_visible_activity ON bot_tasks(conversation_id,CASE WHEN status IN ('queued','running','waiting','paused','unknown') THEN 0 ELSE 1 END,updated_at DESC,id) WHERE json_extract(extra_json,'$.removedAt') IS NULL;
          CREATE INDEX IF NOT EXISTS bot_tasks_visible_global_activity ON bot_tasks(CASE WHEN status IN ('queued','running','waiting','paused','unknown') THEN 0 ELSE 1 END,updated_at DESC,id) WHERE json_extract(extra_json,'$.removedAt') IS NULL;
          CREATE INDEX IF NOT EXISTS bot_tasks_presence_active_v2 ON bot_tasks(companion_id,status,updated_at DESC) WHERE status IN ('queued','running','waiting','paused','unknown');
          CREATE INDEX IF NOT EXISTS bot_inbox_presence_active ON bot_inbox(companion_id,status,received_at DESC) WHERE status IN ('queued','running');
          CREATE TABLE IF NOT EXISTS bot_task_presence_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL REFERENCES bot_tasks(id) ON DELETE CASCADE,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,occurred_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS bot_task_presence_recent ON bot_task_presence_events(companion_id,sequence DESC);
          CREATE TABLE IF NOT EXISTS bot_task_history_clear_targets(request_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES bot_tasks(id) ON DELETE CASCADE,PRIMARY KEY(request_key,task_id));`);
        this.db.pragma('user_version = 15');
      }).immediate(); } catch (error) { this.db.close(); throw error; }
    }
    if (version < 16) {
      try { this.db.transaction(() => {
        // Every visible group includes its owner. Reopening an older peer room
        // does not grant access to another audience or merge its history.
        this.db.exec(`INSERT OR IGNORE INTO bot_members(conversation_id,member_id)
          SELECT c.id,'user' FROM bot_conversations c WHERE c.kind='group'
          AND NOT EXISTS(SELECT 1 FROM bot_metadata d WHERE d.key='conversation-dissolved:'||c.id AND d.value<>'');`);
        this.db.pragma('user_version = 16');
      }).immediate(); } catch (error) { this.db.close(); throw error; }
    }
    if (version < 17) this.db.pragma('user_version = 17');
    try { this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS bot_persona_templates(
        companion_id TEXT NOT NULL REFERENCES bot_companions(id) ON DELETE CASCADE,id TEXT NOT NULL,
        name TEXT NOT NULL,prompt TEXT NOT NULL,builtin INTEGER NOT NULL,original_name TEXT NOT NULL,original_prompt TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(companion_id,id));
        CREATE TABLE IF NOT EXISTS bot_persona_settings(companion_id TEXT PRIMARY KEY REFERENCES bot_companions(id) ON DELETE CASCADE,active_id TEXT NOT NULL);`);
      // Original prompt bytes and a user's edited current persona both survive
      // migration. Tombstones prevent deleted built-ins reappearing on restart.
      for (const raw of this.db.prepare('SELECT id,persona FROM bot_companions').all()) {
        const row = asRow(raw); this.seedPersonaTemplates(String(row.id), String(row.persona));
      }
      this.db.pragma('user_version = 18');
    }).immediate(); } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }
  /** Internal task domain transactions; callbacks must be synchronous and do no native/network I/O. */
  taskTransaction<T>(operation: (sql: BotTaskSql) => T): T { return this.db.transaction(() => operation(this.db)).immediate(); }
  private bindMessageSources(messageId: string, sourceIds: readonly string[]): void {
    for (const id of new Set(sourceIds)) this.db.prepare('INSERT OR IGNORE INTO bot_message_sources VALUES(?,?)').run(messageId, id);
  }
  private messageSources(messageId: string): string[] { return this.db.prepare('SELECT source_id FROM bot_message_sources WHERE message_id=?').all(messageId).map(raw => String(asRow(raw).source_id)); }
  messageSourceIds(messageId: string): string[] { return [...new Set([messageId, ...this.messageSources(messageId)])]; }
  eventSourceIds(eventId: string): string[] {
    const event = this.getEvent(eventId); if (!event) return [];
    const taskSources = this.db.prepare('SELECT DISTINCT s.source_id FROM bot_tasks t JOIN bot_task_media_grants g ON g.task_id=t.id JOIN bot_media_grant_sources s ON s.grant_id=g.grant_id WHERE t.source_event_id=?').all(eventId).map(raw => String(asRow(raw).source_id));
    const mediaSources = this.db.prepare('SELECT DISTINCT s.source_id FROM bot_publications p JOIN bot_message_sources s ON s.message_id=p.message_id WHERE p.event_id=?').all(eventId).map(raw => String(asRow(raw).source_id));
    const peerSources = this.db.prepare('SELECT DISTINCT s.source_id FROM bot_inbox peer JOIN bot_message_sources s ON s.message_id=peer.source_record_id WHERE peer.causation_id=? AND peer.source=\'companion\'').all(eventId).map(raw => String(asRow(raw).source_id));
    return [...new Set([event.id, event.sourceMessageRecordId, ...this.messageSources(event.sourceMessageRecordId), ...taskSources, ...mediaSources, ...peerSources])];
  }
  private grantSources(grantId: string): string[] { return this.db.prepare('SELECT source_id FROM bot_media_grant_sources WHERE grant_id=?').all(grantId).map(raw => String(asRow(raw).source_id)); }
  private grantValid(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, grant: BotAttachmentGrant): boolean {
    return !!this.db.prepare(`SELECT 1 FROM bot_media_grants g WHERE g.id=? AND g.media_id=? AND g.conversation_id=?
      AND NOT EXISTS(SELECT 1 FROM bot_media_grant_sources s JOIN bot_withdrawn_sources w ON w.source_id=s.source_id AND w.domain_key=? WHERE s.grant_id=g.id)`)
      .get(grant.grantId, grant.mediaId, scope.conversationId, hash([scope.companionId, scope.securityDomainId]));
  }
  private bindMessageAttachments(message: BotMessage, explicitUser: boolean, selected?: BotAttachmentGrant[], sourceIds: string[] = []): void {
    const conversation = this.getConversation(message.conversationId)!;
    const allSources = new Set(sourceIds);
    for (const ref of message.attachments ?? []) {
      const chosen = explicitUser ? undefined : selected?.find(grant => grant.mediaId === ref.id);
      let grantId = chosen?.grantId;
      if (chosen && !this.grantValid({ companionId: message.senderId, conversationId: message.conversationId, securityDomainId: conversation.securityDomainId }, chosen)) throw new Error('附件的原授权来源已经撤回。');
      if (!grantId) {
        if (!explicitUser && ref.kind !== 'sticker' && !sourceIds.length) throw new Error('派生附件缺少真实授权来源。');
        grantId = `grant-${hash([message.id, ref.id])}`;
        this.db.prepare('INSERT OR IGNORE INTO bot_media_grants VALUES(?,?,?,?)').run(grantId, message.conversationId, ref.id, message.id);
        for (const sourceId of new Set([message.id, ...sourceIds])) this.db.prepare('INSERT OR IGNORE INTO bot_media_grant_sources VALUES(?,?)').run(grantId, sourceId);
      }
      this.db.prepare('INSERT OR IGNORE INTO bot_message_media_grants VALUES(?,?,?)').run(message.id, ref.id, grantId);
      for (const id of this.grantSources(grantId)) allSources.add(id);
    }
    this.bindMessageSources(message.id, [...allSources]);
  }
  private taskSourceScope(taskId: string): { companionId: string; conversationId: string; securityDomainId: string; sourceEventId: string; sourceMessageRecordId: string; attachmentIds: string[];aclRevision:number } | undefined {
    // Source authorization does not require a task's report or frozen prompt.
    const raw = this.db.prepare(`SELECT t.companion_id,t.conversation_id,t.source_event_id,i.domain_id,i.source_record_id,i.acl_revision,
      CASE WHEN json_type(t.extra_json,'$.attachmentIds')='array' THEN json_extract(t.extra_json,'$.attachmentIds') ELSE '[]' END AS attachment_ids
      FROM bot_tasks t JOIN bot_inbox i ON i.id=t.source_event_id AND i.companion_id=t.companion_id AND i.conversation_id=t.conversation_id WHERE t.id=?`).get(taskId);
    if (!raw) return;
    const value = asRow(raw), attachments: unknown = value.attachment_ids ? JSON.parse(String(value.attachment_ids)) : [];
    return { companionId: String(value.companion_id), conversationId: String(value.conversation_id), securityDomainId: String(value.domain_id),
      sourceEventId: String(value.source_event_id), sourceMessageRecordId: String(value.source_record_id), attachmentIds: Array.isArray(attachments) ? attachments as string[] : [],aclRevision:Number(value.acl_revision) };
  }
  taskSourceIds(taskId: string): string[] {
    const source = this.taskSourceScope(taskId); if (!source) return [];
    const pinned = this.db.prepare('SELECT DISTINCT s.source_id FROM bot_task_media_grants t JOIN bot_media_grant_sources s ON s.grant_id=t.grant_id WHERE t.task_id=?').all(taskId).map(raw => String(asRow(raw).source_id));
    const raw = asRow(this.db.prepare("SELECT json_extract(extra_json,'$.handoffSourceIds') AS ids FROM bot_tasks WHERE id=?").get(taskId));
    const saved: unknown = raw.ids ? JSON.parse(String(raw.ids)) : [];
    const context = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
    return [...new Set([source.sourceEventId, source.sourceMessageRecordId, ...this.messageSources(source.sourceMessageRecordId), ...pinned, ...context,
      ...context.flatMap(id => this.messageSources(id))])];
  }
  taskSourcesWithdrawn(taskId: string): boolean {
    const source = this.taskSourceScope(taskId); if (!source) return true;
    const room=this.getConversation(source.conversationId);
    if(!room||room.dissolvedAt||room.revision!==source.aclRevision||!room.memberIds.includes(source.companionId))return true;
    const expected = new Set(source.attachmentIds);
    const pins = this.db.prepare('SELECT media_id,grant_id FROM bot_task_media_grants WHERE task_id=?').all(taskId).map(raw => ({ mediaId: String(asRow(raw).media_id), grantId: String(asRow(raw).grant_id) }));
    if (pins.length !== expected.size || pins.some(pin => !expected.has(pin.mediaId) || !this.grantValid(source, pin))) return true;
    return this.withdrawnIn(source.companionId, source.securityDomainId, this.taskSourceIds(taskId)).size > 0;
  }
  createCompanion(input: { id?: string; name: string; persona: string }): BotCompanion {
    const id = input.id ? text(input.id, '伙伴标识', 200) : randomUUID(), stamp = nowIso();
    const name = text(input.name, '伙伴名称', 100), persona = personaPrompt(input.persona);
    return this.db.transaction(() => {
      this.db.prepare('INSERT INTO bot_companions(id,name,persona,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, name, persona, stamp, stamp);
      this.seedPersonaTemplates(id, persona); return this.getCompanion(id)!;
    }).immediate();
  }
  getCompanion(id: string): BotCompanion | undefined {
    const raw = this.db.prepare('SELECT c.*,p.active_id FROM bot_companions c LEFT JOIN bot_persona_settings p ON p.companion_id=c.id WHERE c.id=?').get(id); if (!raw) return;
    const r = asRow(raw); return { id: String(r.id), name: String(r.name), persona: String(r.persona), createdAt: String(r.created_at), updatedAt: String(r.updated_at), activePersonaId: optional(r.active_id) };
  }
  listCompanions(): BotCompanion[] { return this.db.prepare('SELECT id FROM bot_companions ORDER BY created_at,id').all().map(raw => this.getCompanion(String(asRow(raw).id))!).filter(companion => !this.isRetiredDevelopmentDefault(companion.id)); }
  isRetiredDevelopmentDefault(id: string): boolean { return id === developmentDefault && !!this.getMetadata(defaultCleanupKey); }
  developmentDefaultCleanup(): BotDevelopmentDefaultCleanup | undefined {
    const saved = this.getMetadata(defaultCleanupKey); return saved ? JSON.parse(saved) as BotDevelopmentDefaultCleanup : undefined;
  }
  /** A one-time development identity replacement, never a general-purpose
   * account deletion API. Fence dispatch before touching native/filesystem I/O. */
  beginDevelopmentDefaultCleanup(): BotDevelopmentDefaultCleanup | undefined {
    return this.db.transaction(() => {
      let plan = this.developmentDefaultCleanup();
      if (!plan) {
        if (!this.getCompanion(developmentDefault)) return;
        const scopes = this.db.prepare(`SELECT DISTINCT c.id,c.domain_id FROM bot_conversations c WHERE
          EXISTS(SELECT 1 FROM bot_members m WHERE m.conversation_id=c.id AND m.member_id=?)
          OR EXISTS(SELECT 1 FROM bot_lanes l WHERE l.conversation_id=c.id AND l.companion_id=?)`).all(developmentDefault, developmentDefault)
          .map(raw => ({ companionId: developmentDefault, conversationId: String(asRow(raw).id), securityDomainId: String(asRow(raw).domain_id) }));
        const conversationIds = this.db.prepare(`SELECT c.id FROM bot_conversations c WHERE EXISTS(SELECT 1 FROM bot_members m WHERE m.conversation_id=c.id AND m.member_id=?)
          AND NOT EXISTS(SELECT 1 FROM bot_members m WHERE m.conversation_id=c.id AND m.member_id NOT IN ('user',?))`).all(developmentDefault, developmentDefault).map(raw => String(asRow(raw).id));
        plan = { phase: 'retiring', scopes, conversationIds,
          laneIds: this.db.prepare('SELECT id FROM bot_lanes WHERE companion_id=?').all(developmentDefault).map(raw => String(asRow(raw).id)),
          taskWorkspaces: this.db.prepare('SELECT t.id,i.domain_id FROM bot_tasks t JOIN bot_inbox i ON i.id=t.source_event_id WHERE t.companion_id=?').all(developmentDefault)
            .map(raw => ({ taskId: String(asRow(raw).id), securityDomainId: String(asRow(raw).domain_id) })) };
        this.setMetadata(defaultCleanupKey, JSON.stringify(plan));
      }
      if (plan.phase !== 'retiring') return plan;
      for (const raw of this.db.prepare("SELECT id FROM bot_inbox WHERE companion_id=? AND status IN ('queued','running','cancelled')").all(developmentDefault)) this.cancelEvent(String(asRow(raw).id), true);
      for (const raw of this.db.prepare("SELECT * FROM bot_tasks WHERE companion_id=? AND status IN ('queued','running','waiting','paused','unknown')").all(developmentDefault)) {
        const task = this.task(raw); this.updateTask(task.id, { extra: { ...task.extra, cancelRequested: true, retryAt: 0 } });
      }
      // Removing only the retired actor preserves remaining group task ACLs.
      this.db.prepare('DELETE FROM bot_members WHERE member_id=?').run(developmentDefault);
      this.db.prepare("DELETE FROM bot_memory_jobs WHERE json_extract(payload_json,'$.scope.companionId')=?").run(developmentDefault);
      this.db.prepare("DELETE FROM bot_deferred_task_notices WHERE json_extract(payload_json,'$.recipientIds[0]')=?").run(developmentDefault);
      return plan;
    }).immediate();
  }
  commitDevelopmentDefaultCleanup(): BotDevelopmentDefaultCleanup | undefined {
    return this.db.transaction(() => {
      const plan = this.developmentDefaultCleanup(); if (!plan || plan.phase !== 'retiring') return plan;
      const activeTask = this.db.prepare("SELECT 1 FROM bot_tasks WHERE companion_id=? AND status IN ('queued','running','waiting','paused','unknown') LIMIT 1").get(developmentDefault);
      const retiring = this.db.prepare('SELECT 1 FROM bot_native_retirements r JOIN bot_inbox i ON i.id=r.event_id WHERE i.companion_id=? LIMIT 1').get(developmentDefault);
      if (activeTask || retiring) return plan;
      for (const laneId of plan.laneIds) for (const key of [botLaneRetentionKey(laneId), `delivered:${laneId}`]) this.db.prepare('DELETE FROM bot_metadata WHERE key=?').run(key);
      for (const raw of this.db.prepare('SELECT id FROM bot_inbox WHERE companion_id=?').all(developmentDefault)) {
        const eventId = String(asRow(raw).id);
        for (const key of [`native-input:${eventId}`, `native-admission:${eventId}`, `native-terminal-counted:${eventId}`, `event-native-epoch:${eventId}`, `skipCapture:${eventId}`]) this.db.prepare('DELETE FROM bot_metadata WHERE key=?').run(key);
        this.db.prepare("DELETE FROM bot_metadata WHERE key LIKE ? OR key LIKE ?").run(`effect:${eventId}:%`, `memory-forget-receipt:${eventId}:%`);
      }
      for (const workspace of plan.taskWorkspaces) {
        this.db.prepare('DELETE FROM bot_metadata WHERE key=? OR key LIKE ? OR key LIKE ?').run(`task-answer-cursor:${workspace.taskId}`, `task-answer-cursor:${workspace.taskId}:%`, `task-control:${workspace.taskId}:%`);
      }
      for (const scope of plan.scopes) this.db.prepare('DELETE FROM bot_withdrawn_sources WHERE domain_key=?').run(hash([developmentDefault, scope.securityDomainId]));
      this.db.prepare(`DELETE FROM bot_deferred_task_notices WHERE json_extract(payload_json,'$.recipientIds[0]')=?`).run(developmentDefault);
      this.db.prepare('DELETE FROM bot_outbox WHERE event_id IN(SELECT id FROM bot_inbox WHERE companion_id=?)').run(developmentDefault);
      for (const table of ['bot_task_answer_receipts', 'bot_task_questions', 'bot_task_effects', 'bot_task_controls']) this.db.prepare(`DELETE FROM ${table} WHERE task_id IN(SELECT id FROM bot_tasks WHERE companion_id=?)`).run(developmentDefault);
      this.db.prepare('DELETE FROM bot_tasks WHERE companion_id=?').run(developmentDefault);
      this.db.prepare('DELETE FROM bot_publications WHERE event_id IN(SELECT id FROM bot_inbox WHERE companion_id=?)').run(developmentDefault);
      this.db.prepare('DELETE FROM bot_inbox WHERE companion_id=?').run(developmentDefault);
      this.db.prepare('DELETE FROM bot_lanes WHERE companion_id=?').run(developmentDefault);
      for (const id of plan.conversationIds) {
        this.db.prepare('DELETE FROM bot_outbox WHERE conversation_id=?').run(id);
        this.db.prepare('DELETE FROM bot_origins WHERE message_id IN(SELECT id FROM bot_messages WHERE conversation_id=?)').run(id);
        this.db.prepare('DELETE FROM bot_history_projection WHERE conversation_id=?').run(id);
        this.db.prepare('DELETE FROM bot_messages WHERE conversation_id=?').run(id);
        this.db.prepare('DELETE FROM bot_conversations WHERE id=?').run(id);
        this.db.prepare('DELETE FROM bot_metadata WHERE key=?').run(`conversation-participation:${id}`);
      }
      this.db.prepare('DELETE FROM bot_companions WHERE id=?').run(developmentDefault);
      this.db.prepare('DELETE FROM bot_metadata WHERE key=? OR key=?').run(`world:private-lane:${developmentDefault}`, `world:causal-actor:${developmentDefault}`);
      plan.phase = 'sql-deleted'; this.setMetadata(defaultCleanupKey, JSON.stringify(plan)); return plan;
    }).immediate();
  }
  completeDevelopmentDefaultCleanup(): void {
    const plan = this.developmentDefaultCleanup(); if (plan?.phase !== 'sql-deleted') throw new Error('开发伙伴清理尚未确认退休。');
    this.setMetadata(defaultCleanupKey, JSON.stringify({ ...plan, phase: 'complete' }));
  }
  updateCompanion(id: string, input: { name: string; persona?: string }): BotCompanion {
    if (this.isRetiredDevelopmentDefault(id)) throw new Error('旧开发伙伴已退休。');
    const name = text(input.name, '伙伴名称', 100), prompt = input.persona === undefined ? undefined : personaPrompt(input.persona);
    return this.db.transaction(() => {
      const companion = this.requirePersonaCompanion(id), stamp = nowIso();
      if (prompt !== undefined) {
        this.db.prepare('UPDATE bot_persona_templates SET prompt=?,updated_at=? WHERE companion_id=? AND id=? AND deleted=0').run(prompt, stamp, id, companion.activePersonaId!);
        this.db.prepare('UPDATE bot_companions SET name=?,persona=?,updated_at=? WHERE id=?').run(name, prompt, stamp, id);
      } else this.db.prepare('UPDATE bot_companions SET name=?,updated_at=? WHERE id=?').run(name, stamp, id);
      return this.getCompanion(id)!;
    }).immediate();
  }
  private seedPersonaTemplates(companionId: string, currentPrompt: string): void {
    const stamp = nowIso(), builtins = builtinBotPersonaTemplates(companionId);
    const defaults = builtins.length ? builtins : [{ id: 'default', name: '默认人格', prompt: currentPrompt }];
    for (const item of defaults) {
      this.db.prepare(`INSERT OR IGNORE INTO bot_persona_templates(companion_id,id,name,prompt,builtin,original_name,original_prompt,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(companionId, item.id, item.name, item.prompt, Number(!!builtins.length), item.name, item.prompt, stamp, stamp);
      if (builtins.length) this.db.prepare('UPDATE bot_persona_templates SET original_name=?,original_prompt=? WHERE companion_id=? AND id=? AND builtin=1')
        .run(item.name, item.prompt, companionId, item.id);
    }
    if (this.db.prepare('SELECT 1 FROM bot_persona_settings WHERE companion_id=?').get(companionId)) return;
    let activeId = defaults.find(item => item.prompt === currentPrompt)?.id ?? 'default';
    if (!defaults.some(item => item.prompt === currentPrompt)) {
      activeId = 'custom-current';
      this.db.prepare(`INSERT INTO bot_persona_templates(companion_id,id,name,prompt,builtin,original_name,original_prompt,created_at,updated_at)
        VALUES(?,?,?,?,0,?,?,?,?)`).run(companionId, activeId, '原有自定义人格', currentPrompt, '原有自定义人格', currentPrompt, stamp, stamp);
    }
    this.db.prepare('INSERT INTO bot_persona_settings(companion_id,active_id) VALUES(?,?)').run(companionId, activeId);
  }
  private requirePersonaCompanion(companionId: string): BotCompanion {
    const companion = this.getCompanion(companionId);
    if (!companion || this.isRetiredDevelopmentDefault(companionId)) throw new Error('伙伴不存在。');
    return companion;
  }
  private personaSummary(row: Row): BotPersonaTemplateSummary {
    return { id: String(row.id), name: String(row.name), builtin: !!row.builtin, isDefault: row.id === 'default',
      modified: row.name !== row.original_name || !!row.prompt_modified,
      charCount: Number(row.char_count), updatedAt: String(row.updated_at) };
  }
  listPersonaTemplates(companionId: string): BotPersonaTemplateList {
    const companion = this.requirePersonaCompanion(companionId);
    // SQL returns metadata only: large prompts never travel with list/snapshot.
    const rows = this.db.prepare(`SELECT id,name,builtin,original_name,updated_at,length(prompt) AS char_count,
      CASE WHEN prompt=original_prompt THEN 0 ELSE 1 END AS prompt_modified
      FROM bot_persona_templates WHERE companion_id=? AND deleted=0 ORDER BY CASE WHEN id='default' THEN 0 ELSE 1 END,builtin DESC,created_at,id LIMIT ?`)
      .all(companionId, BOT_PERSONA_TEMPLATE_LIMIT);
    return { items: rows.map(raw => this.personaSummary(asRow(raw))),
      activeId: companion.activePersonaId!, limit: BOT_PERSONA_TEMPLATE_LIMIT };
  }
  getPersonaTemplate(companionId: string, id: string): BotPersonaTemplate {
    this.requirePersonaCompanion(companionId);
    const raw = this.db.prepare('SELECT *,length(prompt) AS char_count,prompt<>original_prompt AS prompt_modified FROM bot_persona_templates WHERE companion_id=? AND id=? AND deleted=0').get(companionId, id);
    if (!raw) throw new Error('人格模板不存在或已删除。');
    const row = asRow(raw); return { ...this.personaSummary(row), prompt: String(row.prompt) };
  }
  savePersonaTemplate(companionId: string, input: { id?: string; name: string; prompt: string; activate?: boolean }): BotPersonaTemplate {
    const name = text(input.name, '模板名称', 80), prompt = personaPrompt(input.prompt), id = input.id ?? `persona-${randomUUID()}`;
    return this.db.transaction(() => {
      const companion = this.requirePersonaCompanion(companionId), stamp = nowIso();
      if (input.id) {
        this.getPersonaTemplate(companionId, id);
        this.db.prepare('UPDATE bot_persona_templates SET name=?,prompt=?,updated_at=? WHERE companion_id=? AND id=?').run(name, prompt, stamp, companionId, id);
      } else {
        // Deleted built-ins reserve their slot so restoring the entire built-in
        // collection never deletes custom templates or exceeds the list bound.
        const count = Number(asRow(this.db.prepare('SELECT count(*) AS count FROM bot_persona_templates WHERE companion_id=?').get(companionId)).count);
        if (count >= BOT_PERSONA_TEMPLATE_LIMIT) throw new Error(`每位伙伴最多保存 ${BOT_PERSONA_TEMPLATE_LIMIT} 套人格模板（包含可恢复的内置模板）。`);
        this.db.prepare(`INSERT INTO bot_persona_templates(companion_id,id,name,prompt,builtin,original_name,original_prompt,created_at,updated_at)
          VALUES(?,?,?,?,0,?,?,?,?)`).run(companionId, id, name, prompt, name, prompt, stamp, stamp);
      }
      if (input.activate || companion.activePersonaId === id) this.activatePersonaTemplate(companionId, id);
      return this.getPersonaTemplate(companionId, id);
    }).immediate();
  }
  activatePersonaTemplate(companionId: string, id: string): BotPersonaTemplate {
    return this.db.transaction(() => {
      const persona = this.getPersonaTemplate(companionId, id), stamp = nowIso();
      this.db.prepare('UPDATE bot_companions SET persona=?,updated_at=? WHERE id=?').run(persona.prompt, stamp, companionId);
      this.db.prepare('UPDATE bot_persona_settings SET active_id=? WHERE companion_id=?').run(id, companionId);
      return persona;
    }).immediate();
  }
  deletePersonaTemplate(companionId: string, id: string): void {
    this.db.transaction(() => {
      const companion = this.requirePersonaCompanion(companionId), persona = this.getPersonaTemplate(companionId, id);
      if (persona.isDefault) throw new Error('默认人格不能删除，可以编辑或恢复默认原稿。');
      if (companion.activePersonaId === id) this.activatePersonaTemplate(companionId, 'default');
      if (persona.builtin) this.db.prepare('UPDATE bot_persona_templates SET deleted=1,updated_at=? WHERE companion_id=? AND id=?').run(nowIso(), companionId, id);
      else this.db.prepare('DELETE FROM bot_persona_templates WHERE companion_id=? AND id=?').run(companionId, id);
    }).immediate();
  }
  restorePersonaTemplates(companionId: string, id?: string): BotPersonaTemplate {
    return this.db.transaction(() => {
      this.requirePersonaCompanion(companionId);
      if (id) {
        const raw = this.db.prepare('SELECT builtin FROM bot_persona_templates WHERE companion_id=? AND id=?').get(companionId, id);
        if (!raw || (!asRow(raw).builtin && id !== 'default')) throw new Error('只能恢复默认或内置人格模板。');
        this.db.prepare('UPDATE bot_persona_templates SET name=original_name,prompt=original_prompt,deleted=0,updated_at=? WHERE companion_id=? AND id=?').run(nowIso(), companionId, id);
      } else this.db.prepare("UPDATE bot_persona_templates SET name=original_name,prompt=original_prompt,deleted=0,updated_at=? WHERE companion_id=? AND (builtin=1 OR id='default')").run(nowIso(), companionId);
      return this.activatePersonaTemplate(companionId, id ?? 'default');
    }).immediate();
  }
  openDirect(companionId: string): BotConversation {
    if (this.isRetiredDevelopmentDefault(companionId)) throw new Error('旧开发伙伴已退休。');
    const c = this.getCompanion(companionId); if (!c) throw new Error('伙伴不存在。');
    return this.db.transaction(() => {
      const found = this.db.prepare('SELECT id FROM bot_conversations WHERE direct_key=?').get(companionId);
      if (found) return this.getConversation(String(asRow(found).id))!;
      return this.insertConversation(c.name, 'direct', ['user', companionId], companionId);
    }).immediate();
  }
  createGroup(input: { title: string; memberIds: string[]; kind?: BotConversationKind; includeUser?: boolean; participationMode?: 'automatic' | 'all' | 'mentions' }): BotConversation {
    const kind = input.kind ?? 'group';
    if (kind === 'peer') throw new Error('伙伴私聊必须由固定双方入口创建。');
    const members = [...new Set([...(kind === 'group' || input.includeUser !== false ? ['user'] : []), ...input.memberIds])].sort();
    if (!members.some(id => id !== 'user')) throw new Error('会话至少需要一位伙伴。');
    for (const id of members) if (id !== 'user' && (!this.getCompanion(id) || this.isRetiredDevelopmentDefault(id))) throw new Error('会话成员不存在。');
    return this.db.transaction(() => {
      if (kind === 'group') {
        // Reuse the full participant set. Titles and user-chosen policies of
        // existing rooms survive; history from different audiences is not merged.
        const prior = this.db.prepare(`SELECT c.id FROM bot_conversations c WHERE c.kind='group'
          AND NOT EXISTS(SELECT 1 FROM bot_metadata d WHERE d.key='conversation-dissolved:'||c.id AND d.value<>'')
          AND (SELECT COUNT(*) FROM bot_members m WHERE m.conversation_id=c.id)=?
          AND NOT EXISTS(SELECT 1 FROM bot_members m WHERE m.conversation_id=c.id AND m.member_id NOT IN (${members.map(() => '?').join(',')}))
          ORDER BY c.created_at,c.id LIMIT 1`).get(members.length, ...members);
        if (prior) return this.getConversation(String(asRow(prior).id))!;
      }
      const conversation = this.insertConversation(text(input.title, '会话名称', 200), kind, members);
      if (conversation.kind === 'group') return this.setConversationPolicy(conversation.id, input.participationMode ?? 'automatic');
      return conversation;
    }).immediate();
  }
  openPeer(firstId: string, secondId: string): BotConversation {
    const ids = [...new Set([firstId, secondId])].sort();
    if (ids.length !== 2 || ids.includes('user') || ids.some(id => !this.getCompanion(id) || this.isRetiredDevelopmentDefault(id))) throw new Error('伙伴私聊需要两位不同的有效伙伴。');
    return this.db.transaction(() => {
      const key = 'peer-private-room:' + hash(ids), prior = this.getMetadata(key), room = prior ? this.getConversation(prior) : undefined;
      if (room) { if (room.kind !== 'peer' || JSON.stringify(room.memberIds) !== JSON.stringify(ids)) throw new Error('伙伴私聊的固定双方发生变化。'); return room; }
      const created = this.insertConversation(ids.map(id => this.getCompanion(id)!.name).join(' × '), 'peer', ids);
      this.setMetadata(key, created.id); return created;
    }).immediate();
  }
  /** Communication always belongs to the pair's own channel. A request for a
   * user-facing answer grants the recipient one separate publication, never
   * membership of (or an incoming message in) its user-private channel. */
  contactPeer(source: BotEvent, targetId: string, callId: string, content: string, destination: 'user' | 'peer' = 'peer') {
    if (!['user', 'peer'].includes(destination)) throw new Error('转达目的地必须为 user 或 peer。');
    if (source.source !== 'user' || source.senderId !== 'user') throw new Error('联系其他聊天中的伙伴需要当前用户明确请求。');
    if (targetId === source.companionId || this.isRetiredDevelopmentDefault(targetId)) throw new Error('请选择另一位可用伙伴。');
    const sender = this.getCompanion(source.companionId), target = this.getCompanion(targetId);
    if (!sender || !target) throw new Error('伙伴不存在。');
    if (this.withdrawnIn(source.companionId, source.securityDomainId, this.eventSourceIds(source.id)).size) throw new Error('转达来源已撤回。');
    return this.db.transaction(() => {
      const receiptKey = `peer-contact-receipt:${source.id}:${callId}`, priorReceipt = this.getMetadata(receiptKey);
      if (priorReceipt) {
        const receipt = JSON.parse(priorReceipt) as { recipientId: string; conversationId: string; messageId: string; fingerprint?: string };
        if (receipt.recipientId !== targetId || receipt.fingerprint && receipt.fingerprint !== hash([targetId, destination, content])) throw new Error('同一转达标识对应不同伙伴、目的地或内容。');
        return { accepted: true as const, conversationId: receipt.conversationId, message: this.getMessage(receipt.messageId)!, events: [] as BotEvent[] };
      }
      const sourceRoom = this.getConversation(source.conversationId);
      if (!sourceRoom || sourceRoom.dissolvedAt || sourceRoom.revision !== source.aclRevision || !sourceRoom.memberIds.includes(source.companionId)) throw new Error('转达来源权限已经变化。');
      const room = this.openPeer(sender.id, target.id);
      const result = this.tryEnqueueAutomatic({ conversationId: room.id, source: 'companion', senderId: sender.id, recipientIds: [targetId],
        content: text(content, '转达内容', 8000), sourceMessageId: `peer-contact:${source.id}:${callId}`, correlationId: source.correlationId, causationId: source.id,
        payload: { hop: 1, userRequestedContact: true, originalSenderName: source.senderName, responseDestination: destination === 'user' ? 'user-direct' : 'peer' }, sourceIds: [source.id, source.sourceMessageRecordId] });
      if (result.accepted && destination === 'user') for (const event of result.events) this.setMetadata(`peer-user-reply-grant:${event.id}`,
        JSON.stringify({ sourceEventId: source.id, relayMessageId: result.message.id, peerConversationId: room.id, recipientId: target.id,
          requesterId: sender.id, correlationId: source.correlationId, sourceAclRevision: source.aclRevision }));
      if (result.accepted) for (const sourceId of this.eventSourceIds(source.id)) this.db.prepare('INSERT OR IGNORE INTO bot_peer_bridges VALUES(?,?,?,?,?)')
        .run(source.companionId, source.securityDomainId, sourceId, room.id, result.message.id);
      if (result.accepted) this.setMetadata(receiptKey, JSON.stringify({ recipientId: targetId, conversationId: room.id, messageId: result.message.id, destination, fingerprint: hash([targetId, destination, content]) }));
      return { ...result, conversationId: room.id };
    }).immediate();
  }
  /** Returns an already committed reply without sending or guessing absence. */
  peerReplyReceipt(eventId: string, callId: string, content: string): { sent: true; conversationId: string; messageId: string; senderId: string; recipientId: 'user' } | undefined {
    const saved = this.getMetadata(`peer-user-reply-receipt:${eventId}:${callId}`);
    if (!saved) return;
    const receipt = JSON.parse(saved) as { fingerprint: string; result: { sent: true; conversationId: string; messageId: string; senderId: string; recipientId: 'user' } };
    if (receipt.fingerprint !== hash([text(content, '回复内容', 24000)])) throw new Error('向用户回复的回执内容不匹配。');
    return receipt.result;
  }
  replyPeerToUser(source: BotEvent, callId: string, content: string) {
    const reply = text(content, '回复内容', 24000), fingerprint = hash([reply]);
    return this.db.transaction(() => {
      const prior = this.peerReplyReceipt(source.id, callId, reply); if (prior) return prior;
      const event = this.getEvent(source.id), savedGrant = event && this.getMetadata(`peer-user-reply-grant:${event.id}`);
      if (!event || event.status !== 'running' || event.source !== 'companion' || !savedGrant) throw new Error('当前伙伴私聊没有向用户回复的有效授权。');
      const grant = JSON.parse(savedGrant) as { sourceEventId: string; relayMessageId: string; peerConversationId: string; recipientId: string;
        requesterId: string; correlationId: string; sourceAclRevision: number; reply?: { fingerprint: string; result: NonNullable<ReturnType<BotStore['peerReplyReceipt']>> } };
      const origin = this.getEvent(grant.sourceEventId), originRoom = origin && this.getConversation(origin.conversationId), peer = this.getConversation(event.conversationId);
      if (!origin || origin.source !== 'user' || origin.senderId !== 'user' || !originRoom || originRoom.dissolvedAt || originRoom.revision !== grant.sourceAclRevision
        || !originRoom.memberIds.includes(grant.requesterId) || peer?.kind !== 'peer' || peer.revision !== event.aclRevision || peer.id !== grant.peerConversationId
        || JSON.stringify([...peer.memberIds].sort()) !== JSON.stringify([grant.requesterId, grant.recipientId].sort())
        || event.companionId !== grant.recipientId || event.senderId !== grant.requesterId || event.sourceMessageRecordId !== grant.relayMessageId
        || event.correlationId !== grant.correlationId || origin.correlationId !== grant.correlationId
        || this.withdrawnIn(origin.companionId, origin.securityDomainId, this.eventSourceIds(origin.id)).size
        || this.withdrawnIn(event.companionId, event.securityDomainId, this.eventSourceIds(event.id)).size) throw new Error('向用户回复的原始授权已经失效。');
      if (grant.reply && grant.reply.fingerprint !== fingerprint) throw new Error('本次授权回复已经发送，不能再次发布不同内容。');
      let result = grant.reply?.result;
      if (!result) {
        const room = this.openDirect(event.companionId);
        const { message } = this.enqueue({ conversationId: room.id, senderId: event.companionId, source: 'companion', recipientIds: [], content: reply,
          sourceInstanceId: 'peer-user-reply', sourceMessageId: event.id, correlationId: event.correlationId, causationId: event.id,
          sourceIds: [...new Set([...this.eventSourceIds(event.id), ...this.eventSourceIds(origin.id)])] });
        for (const sourceId of this.eventSourceIds(origin.id)) this.db.prepare('INSERT OR IGNORE INTO bot_peer_bridges VALUES(?,?,?,?,?)')
          .run(origin.companionId, origin.securityDomainId, sourceId, room.id, message.id);
        this.db.prepare('INSERT OR IGNORE INTO bot_outbox(id,event_id,conversation_id,message_id,created_at) VALUES(?,?,?,?,?)')
          .run(message.id, event.id, room.id, message.id, message.createdAt);
        this.enqueueMemoryJob({ key: `peer-user-reply-history:${event.id}`, kind: 'projection', payload: { scope: { companionId: event.companionId, conversationId: room.id, securityDomainId: room.securityDomainId } } });
        result = { sent: true, conversationId: room.id, messageId: message.id, senderId: event.companionId, recipientId: 'user' };
        this.setMetadata(`peer-user-reply-grant:${event.id}`, JSON.stringify({ ...grant, reply: { fingerprint, result } }));
      }
      this.setMetadata(`peer-user-reply-receipt:${event.id}:${callId}`, JSON.stringify({ fingerprint, result }));
      return result;
    }).immediate();
  }
  peerWithdrawalTargets(companionId: string, securityDomainId: string) {
    const key = hash([companionId, securityDomainId]);
    return this.db.prepare(`SELECT DISTINCT b.target_conversation_id AS conversationId,b.target_message_id AS messageId FROM bot_peer_bridges b
      JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=b.source_id WHERE b.source_owner=? AND b.source_domain=?`)
      .all(key, companionId, securityDomainId).map(raw => ({ conversationId: String(asRow(raw).conversationId), messageId: String(asRow(raw).messageId) }));
  }
  setConversationPolicy(conversationId: string, participationMode: 'automatic' | 'all' | 'mentions'): BotConversation {
    const conversation = this.getConversation(conversationId);
    if (!conversation || conversation.dissolvedAt || conversation.kind !== 'group' || !['automatic','all','mentions'].includes(participationMode)) throw Error('仅群聊可设置有效参与方式。');
    this.setMetadata(`conversation-participation:${conversationId}`, participationMode);
    return this.getConversation(conversationId)!;
  }
  /** User-owned group edits revoke every in-flight old-ACL capability. */
  updateMembers(conversationId:string,memberIds:string[]):BotGroupAdminChange{
    return this.db.transaction(()=>{
      const room=this.getConversation(conversationId);
      if(!room||room.kind!=='group'||room.ownerId!=='user'||room.dissolvedAt)throw new Error('仅群主可以管理未解散群聊的成员。');
      const companions=[...new Set(memberIds.filter(id=>id!=='user'))];
      if(!companions.length||companions.length>16||companions.some(id=>!this.getCompanion(id)||this.isRetiredDevelopmentDefault(id)))throw new Error('群聊需要 1 至 16 位有效伙伴，用户群主不能移除。');
      const next=['user',...companions].sort();
      if(JSON.stringify([...room.memberIds].sort())===JSON.stringify(next))return{conversation:room,eventIds:[],taskIds:[]};
      const revoked=this.revokeGroupCapabilities(room);
      this.db.prepare('DELETE FROM bot_members WHERE conversation_id=?').run(room.id);
      for(const id of next)this.db.prepare('INSERT INTO bot_members VALUES(?,?)').run(room.id,id);
      return{conversation:this.getConversation(room.id)!,...revoked};
    }).immediate();
  }
  dissolveConversation(conversationId:string):BotGroupAdminChange{
    return this.db.transaction(()=>{
      const room=this.getConversation(conversationId);
      if(!room||room.kind!=='group'||room.ownerId!=='user')throw new Error('仅群主可以解散群聊。');
      if(room.dissolvedAt)return{conversation:room,eventIds:[],taskIds:[]};
      const revoked=this.revokeGroupCapabilities(room);
      this.setMetadata(`conversation-dissolved:${room.id}`,nowIso());
      this.db.prepare('DELETE FROM bot_members WHERE conversation_id=?').run(room.id);
      return{conversation:this.getConversation(room.id)!,...revoked};
    }).immediate();
  }
  setGroupAnnouncement(input: { conversationId: string; content: string; actorId: string; expectedUpdatedAt?: string | null }): BotConversation {
    if (typeof input.content !== 'string' || input.content.length > 4000 || input.content.includes('\0')) throw new Error('群公告最多 4000 字，且不能包含空字符。');
    return this.db.transaction(() => {
      const room = this.getConversation(input.conversationId);
      if (input.actorId !== 'user' || !room || room.kind !== 'group' || room.ownerId !== 'user' || !room.memberIds.includes('user') || room.dissolvedAt) throw new Error('仅仍在群中的用户群主可以修改未解散群聊的公告。');
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== (room.announcement?.updatedAt ?? null)) throw Object.assign(new Error('群公告已经更新，请重新读取后再修改。'), { code: 'BOT_ANNOUNCEMENT_CONFLICT' });
      const content = input.content.trim();
      if (content === (room.announcement?.text ?? '')) return room;
      const key = `conversation-announcement:${room.id}`, prior = this.getMetadata(key);
      const previousTime = prior ? Date.parse((JSON.parse(prior) as { updatedAt: string }).updatedAt) : 0;
      const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
      // Empty text is a small timestamp tombstone, not an announcement. Keeping
      // its clock avoids reusing the same timestamp during a fast clear/rewrite.
      this.setMetadata(key, JSON.stringify({ text: content, updatedAt }));
      return this.getConversation(room.id)!;
    }).immediate();
  }
  private groupAnnouncement(id: string): BotConversation['announcement'] {
    const value = this.getMetadata(`conversation-announcement:${id}`); if (!value) return;
    const parsed = JSON.parse(value) as { text?: unknown; updatedAt?: unknown };
    if (typeof parsed.text === 'string' && parsed.text.trim() && parsed.text.length <= 4000 && typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))) return { text: parsed.text, updatedAt: parsed.updatedAt };
  }
  private revokeGroupCapabilities(room:BotConversation):Pick<BotGroupAdminChange,'eventIds'|'taskIds'>{
    const revision=room.revision+1;if(!Number.isSafeInteger(revision))throw new Error('会话权限版本超出范围。');
    this.db.prepare('UPDATE bot_conversations SET revision=? WHERE id=?').run(revision,room.id);
    this.db.prepare('UPDATE bot_lanes SET acl_revision=? WHERE conversation_id=?').run(revision,room.id);
    const eventIds=this.db.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND status IN ('queued','running')").all(room.id).map(raw=>String(asRow(raw).id));
    for(const id of eventIds)this.cancelEvent(id);
    const taskIds=this.db.prepare("SELECT id FROM bot_tasks WHERE conversation_id=? AND status IN ('queued','running','waiting','paused','unknown')").all(room.id).map(raw=>String(asRow(raw).id));
    const stamp=nowIso();
    for(const id of taskIds){const task=this.getTask(id)!;this.updateTask(id,{extra:{...task.extra,cancelRequested:true,cancelRequestedAt:task.extra.cancelRequestedAt??stamp,
      cancelRecoveryPaused:false,cancelRecoveryAttempts:0,pauseRequested:false,pauseRecoveryPaused:false,retryAt:0,
      progress:{phase:'stopping',detail:'群聊成员或权限已变化，正在核实停止旧任务。',updatedAt:stamp}}});}
    return{eventIds,taskIds};
  }
  private insertConversation(title: string, kind: BotConversationKind, members: string[], directKey?: string): BotConversation {
    const id = randomUUID(), stamp = nowIso();
    this.db.prepare('INSERT INTO bot_conversations(id,title,kind,scope_id,domain_id,created_at,direct_key) VALUES(?,?,?,?,?,?,?)').run(id, title, kind, id, id, stamp, directKey ?? null);
    for (const member of members) this.db.prepare('INSERT INTO bot_members VALUES(?,?)').run(id, member);
    return this.getConversation(id)!;
  }
  getConversation(id: string): BotConversation | undefined {
    const raw = this.db.prepare('SELECT * FROM bot_conversations WHERE id=?').get(id); if (!raw) return;
    const r = asRow(raw), memberIds = this.db.prepare('SELECT member_id FROM bot_members WHERE conversation_id=? ORDER BY member_id').all(id).map(raw => String(asRow(raw).member_id));
    return { id, title: String(r.title), kind: String(r.kind) as BotConversationKind, memberIds,
      audienceScopeId: String(r.scope_id), securityDomainId: String(r.domain_id), revision: Number(r.revision), createdAt: String(r.created_at),
      ...(this.getMetadata(`peer-conversation:${id}`) === '1' ? { peerConversation: true } : {}),
      ...(r.kind === 'peer' && memberIds.length === 2 && !memberIds.includes('user') ? { userRole: 'observer' as const, participationMode: 'automatic' as const } : {}),
      ...(r.kind==='group'?{ownerId:'user' as const,...(this.getMetadata(`conversation-dissolved:${id}`)?{dissolvedAt:this.getMetadata(`conversation-dissolved:${id}`)}:{})}:{}),
      ...(r.kind === 'group' ? { participationMode: (this.getMetadata(`conversation-participation:${id}`) || 'all') as 'automatic' | 'all' | 'mentions', announcement: this.groupAnnouncement(id) } : {}) };
  }
  private routeGroup(conversation: BotConversation, senderId: string, content: string): GroupRouting {
    const actors = conversation.memberIds.filter(id => id !== 'user' && id !== senderId).map(id => this.getCompanion(id)!).filter(Boolean);
    const key = `group-candidate-offset:${conversation.id}`, offset = Number(this.getMetadata(key) ?? 0) % Math.max(1, actors.length);
    const result = routeGroupAttention([...actors.slice(offset), ...actors.slice(0, offset)], content, conversation.participationMode ?? 'automatic');
    if (result.candidate) this.setMetadata(key, String((offset + GROUP_CANDIDATE_LIMIT) % Math.max(1, actors.length)));
    return result;
  }
  groupCandidates(sourceMessageId: string): string[] {
    return this.db.prepare('SELECT companion_id FROM bot_inbox WHERE source_record_id=? ORDER BY sequence LIMIT ?')
      .all(sourceMessageId, GROUP_CANDIDATE_LIMIT).map(raw => String(asRow(raw).companion_id));
  }
  hasPendingSource(sourceMessageId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM bot_inbox WHERE source_record_id=? AND status IN ('queued','running') LIMIT 1").get(sourceMessageId);
  }
  ingressExists(conversationId: string, sourceMessageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bot_origins WHERE origin_key=?').get(hash(['worldlinebox', sourceMessageId, conversationId]));
  }
  resolveGroupCandidates(sourceMessageId: string, recipients: string[]): void {
    this.db.transaction(() => {
      const selected = new Set(recipients);
      const candidates = this.db.prepare("SELECT id,companion_id,reply_message_id FROM bot_inbox WHERE source_record_id=? AND status='queued' AND json_extract(payload_json,'$.groupAttention')=1").all(sourceMessageId).map(asRow);
      for (const candidate of candidates) if (!selected.has(String(candidate.companion_id))) {
        this.db.prepare("UPDATE bot_inbox SET status='done' WHERE id=? AND status='queued'").run(candidate.id);
        this.db.prepare("UPDATE bot_messages SET status='sent' WHERE id=? AND kind='attention'").run(candidate.reply_message_id);
      }
    }).immediate();
  }
  publishedWatermark(conversationId: string): number {
    return Number(asRow(this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM bot_messages WHERE conversation_id=? AND status='sent'").get(conversationId)).n);
  }
  /** New user input ends the old automatic discussion; direct assignments keep
   * their original event IDs. An explicit stop also cancels those assignments. */
  interruptGroup(conversationId: string, stop = false): string[] {
    const room = this.getConversation(conversationId); if (room?.kind !== 'group') return [];
    const ids = this.db.prepare(`SELECT id FROM bot_inbox WHERE conversation_id=? AND status IN ('queued','running')
      AND (source='group' OR ?)` ).all(conversationId, stop ? 1 : 0).map(raw => String(asRow(raw).id));
    for (const id of ids) this.cancelEvent(id);
    return ids;
  }
  conversations(): BotConversation[] {
    const hidden = new Set(this.developmentDefaultCleanup()?.conversationIds ?? []);
    return this.db.prepare(`SELECT c.id FROM bot_conversations c WHERE c.kind<>'peer' OR EXISTS(
      SELECT 1 FROM bot_messages m WHERE m.conversation_id=c.id AND m.status='sent' AND m.kind='message' AND (length(m.content)>0 OR m.attachments_json<>'[]'))
      ORDER BY c.created_at DESC,c.id`).all().map(raw => this.getConversation(String(asRow(raw).id))!).filter(conversation => !hidden.has(conversation.id)&&!conversation.dissolvedAt);
  }
  /** One short published-message projection per visible channel. Correlated
   * lookups use bot_messages_page; no transcript or attachment body is read. */
  conversationActivity(): Record<string, BotConversationActivity> {
    const hidden = new Set(this.developmentDefaultCleanup()?.conversationIds ?? []);
    const found = this.db.prepare(`SELECT c.id AS conversation_id,m.id,m.sequence,m.sender_name,substr(m.content,1,240) AS preview,m.created_at
      FROM bot_conversations c JOIN bot_messages m ON m.sequence=(
        SELECT latest.sequence FROM bot_messages latest WHERE latest.conversation_id=c.id AND latest.status='sent'
          AND latest.kind='message' AND (length(latest.content)>0 OR latest.attachments_json<>'[]') ORDER BY latest.sequence DESC LIMIT 1)
      WHERE c.kind<>'world' AND (EXISTS(SELECT 1 FROM bot_members member WHERE member.conversation_id=c.id AND member.member_id='user')
        OR c.kind='peer' AND (SELECT COUNT(*) FROM bot_members member WHERE member.conversation_id=c.id)=2)
        AND NOT EXISTS(SELECT 1 FROM bot_metadata d WHERE d.key='conversation-dissolved:'||c.id AND d.value<>'')
      ORDER BY m.sequence DESC LIMIT 256`).all().map(asRow);
    return Object.fromEntries(found.filter(value => !hidden.has(String(value.conversation_id))).map(value => [String(value.conversation_id), {
      messageId: String(value.id), sequence: Number(value.sequence), senderName: String(value.sender_name), preview: String(value.preview) || '[附件]', updatedAt: String(value.created_at),
    }]));
  }
  getLane(id: string): BotLane | undefined {
    const raw = this.db.prepare('SELECT * FROM bot_lanes WHERE id=?').get(id); if (!raw) return;
    const r = asRow(raw); return { id, conversationId: String(r.conversation_id), companionId: String(r.companion_id), sessionId: optional(r.session_id),
      aclRevision: Number(r.acl_revision), epoch: Number(r.epoch), lastClaimedAt: Number(r.last_claimed_at) };
  }
  withdrawSources(companionId: string, securityDomainId: string, sourceIds: readonly string[]): number {
    const key = hash([companionId, securityDomainId]);
    return this.db.transaction(() => {
      let changes = 0;
      const normalized = new Set(sourceIds.filter(id => !this.db.prepare('SELECT 1 FROM bot_withdrawn_sources WHERE domain_key=? AND source_id=?').get(key, id))), pending = [...normalized];
      const add = (value: string) => { if (!normalized.has(value)) { normalized.add(value); pending.push(value); } };
      while (pending.length) {
        const id = pending.pop()!;
        const related = this.db.prepare(`SELECT id,source_record_id,reply_message_id FROM bot_inbox WHERE companion_id=? AND domain_id=? AND id=?
          UNION SELECT id,source_record_id,reply_message_id FROM bot_inbox WHERE companion_id=? AND domain_id=? AND source_record_id=?
          UNION SELECT id,source_record_id,reply_message_id FROM bot_inbox WHERE companion_id=? AND domain_id=? AND reply_message_id=?
          UNION SELECT i.id,i.source_record_id,i.reply_message_id FROM bot_publications p JOIN bot_inbox i ON i.id=p.event_id WHERE i.companion_id=? AND i.domain_id=? AND p.message_id=?`)
          .all(companionId, securityDomainId, id, companionId, securityDomainId, id, companionId, securityDomainId, id, companionId, securityDomainId, id);
        for (const raw of related) { add(String(asRow(raw).id)); add(String(asRow(raw).source_record_id)); add(String(asRow(raw).reply_message_id)); }
        for (const raw of this.db.prepare(`SELECT s.message_id FROM bot_message_sources s JOIN bot_messages m ON m.id=s.message_id JOIN bot_conversations c ON c.id=m.conversation_id WHERE s.source_id=? AND c.domain_id=?`).all(id, securityDomainId)) add(String(asRow(raw).message_id));
      }
      for (const id of normalized) {
        changes += this.db.prepare('INSERT OR IGNORE INTO bot_withdrawn_sources VALUES(?,?)').run(key, text(id, '撤回来源', 500)).changes;
        this.db.prepare('INSERT OR IGNORE INTO bot_source_withdraw_outbox(domain_key,message_id) SELECT ?,id FROM bot_messages WHERE id=?').run(key, id);
      }
      if (changes) this.rotateDomainState(companionId, securityDomainId);
      return changes;
    }).immediate();
  }
  withdrawnIn(companionId: string, securityDomainId: string, ids: readonly string[]): Set<string> {
    if (!ids.length) return new Set();
    const key = hash([companionId, securityDomainId]);
    return new Set(this.db.prepare(`WITH requested(id) AS(VALUES ${ids.map(() => '(?)').join(',')}) SELECT r.id FROM requested r
      WHERE EXISTS(SELECT 1 FROM bot_withdrawn_sources w WHERE w.domain_key=? AND w.source_id=r.id)
      OR EXISTS(SELECT 1 FROM bot_publications p JOIN bot_withdrawn_sources w ON w.source_id=p.event_id AND w.domain_key=? WHERE p.message_id=r.id)
      OR EXISTS(SELECT 1 FROM bot_inbox i JOIN bot_withdrawn_sources w ON w.source_id=i.id AND w.domain_key=? WHERE i.companion_id=? AND (i.source_record_id=r.id OR i.reply_message_id=r.id))
      OR EXISTS(SELECT 1 FROM bot_message_sources s JOIN bot_withdrawn_sources w ON w.source_id=s.source_id AND w.domain_key=? WHERE s.message_id=r.id)`)
      .all(...ids, key, key, key, companionId, key).map(raw => String(asRow(raw).id)));
  }
  withdrawnMessagesPage(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, options: { after?: number; limit?: number } = {}): { items: Array<{ messageId: string; eventIds: string[]; sequence: number }>; hasMore: boolean; nextAfter?: number } {
    const key = hash([scope.companionId, scope.securityDomainId]), limit = bounded(options.limit, 100, 200);
    const found = this.db.prepare(`SELECT m.id,w.sequence FROM bot_source_withdraw_outbox w JOIN bot_messages m ON m.id=w.message_id WHERE w.domain_key=? AND m.conversation_id=? AND w.sequence>? ORDER BY w.sequence LIMIT ?`)
      .all(key, scope.conversationId, options.after ?? 0, limit + 1);
    const items = found.slice(0, limit).map(raw => ({ messageId: String(asRow(raw).id), sequence: Number(asRow(raw).sequence),
      eventIds: this.db.prepare('SELECT id FROM bot_inbox WHERE companion_id=? AND domain_id=? AND (source_record_id=? OR reply_message_id=?)').all(scope.companionId, scope.securityDomainId, asRow(raw).id, asRow(raw).id).map(value => String(asRow(value).id)) }));
    return { items, hasMore: found.length > limit, nextAfter: found.length > limit ? items.at(-1)?.sequence : undefined };
  }
  activeDomainEvents(companionId: string, securityDomainId: string): BotEvent[] {
    return this.db.prepare(`SELECT i.* FROM bot_inbox i WHERE i.companion_id=? AND i.domain_id=?
      AND (i.status='running' OR (i.status='queued' AND EXISTS(SELECT 1 FROM bot_metadata m WHERE m.key='native-admission:'||i.id AND m.value<>'')))`)
      .all(companionId, securityDomainId).map(raw => this.event(raw));
  }
  rotateDomain(companionId: string, securityDomainId: string): void {
    this.db.transaction(() => this.rotateDomainState(companionId, securityDomainId)).immediate();
  }
  private rotateDomainState(companionId: string, securityDomainId: string): void {
    const lanes = this.db.prepare('SELECT id FROM bot_lanes WHERE companion_id=? AND conversation_id IN(SELECT id FROM bot_conversations WHERE domain_id=?)').all(companionId, securityDomainId);
    for (const raw of lanes) {
      const lane = this.getLane(String(asRow(raw).id))!;
      this.db.prepare('DELETE FROM bot_metadata WHERE key=?').run(botLaneRetentionKey(lane.id));
      this.setMetadata(`native-recovery-floor:${lane.id}`, String(lane.epoch + 1));
    }
    this.db.prepare('UPDATE bot_lanes SET epoch=epoch+1,session_id=NULL WHERE companion_id=? AND conversation_id IN(SELECT id FROM bot_conversations WHERE domain_id=?)').run(companionId, securityDomainId);
  }
  getLaneRetention(laneId: string): BotLaneRetentionState {
    const lane = this.getLane(laneId); if (!lane) throw new Error('主脑通道不存在。');
    const value = this.getMetadata(botLaneRetentionKey(laneId));
    if (!value) return { epoch: lane.epoch, turns: 0, bytes: 0 };
    const state = JSON.parse(value) as BotLaneRetentionState;
    if (state.epoch !== lane.epoch || !Number.isSafeInteger(state.turns) || state.turns < 0 || !Number.isSafeInteger(state.bytes) || state.bytes < 0) throw new Error('主脑保留状态损坏。');
    return state;
  }
  /** Latest numeric request evidence, fenced by the current event, ACL and lane epoch. */
  recordBrainContext(eventId: string, epoch: number, value: BotBrainRequestMetrics): boolean {
    const checked = botBrainRequestMetricsSchema.safeParse(value); if (!checked.success) return false;
    const event = asRow(this.db.prepare(`SELECT i.lane_id FROM bot_inbox i JOIN bot_lanes l ON l.id=i.lane_id
      JOIN bot_conversations c ON c.id=i.conversation_id WHERE i.id=? AND i.status='running' AND l.epoch=?
      AND i.acl_revision=c.revision AND EXISTS(SELECT 1 FROM bot_members m WHERE m.conversation_id=c.id AND m.member_id=i.companion_id)
      AND NOT EXISTS(SELECT 1 FROM bot_metadata d WHERE d.key='conversation-dissolved:'||c.id AND d.value<>'')`).get(eventId, epoch) ?? {});
    if (!event.lane_id) return false;
    const key = `brain-context:${event.lane_id}`, saved = this.getMetadata(key);
    const previous = saved ? JSON.parse(saved) as { epoch: number; compactionRequests?: number; latestCompactionAt?: string; lastRequest?: BotBrainRequestMetrics } : undefined;
    const sameEpoch = previous?.epoch === epoch, metric = checked.data;
    // One HTTP request may report multiple usage frames; it is still one request.
    const compactionRequests = (sameEpoch ? previous.compactionRequests ?? 0 : 0)
      + (metric.purpose === 'compaction' && (!sameEpoch || previous.lastRequest?.requestId !== metric.requestId) ? 1 : 0);
    this.setMetadata(key, JSON.stringify({ epoch, eventId, compactionRequests,
      latestCompactionAt: metric.purpose === 'compaction' ? metric.measuredAt : sameEpoch ? previous.latestCompactionAt : undefined, lastRequest: metric }));
    return true;
  }
  /** Indexed current-room projections only: no transcript, prompt, handoff or report is loaded. */
  brainContextSummaries(conversationId: string, phaseForReply?: (replyId: string) => string | undefined): Record<string, BotBrainContextSummary> {
    const room = this.getConversation(conversationId);
    if (!room || room.dissolvedAt || !room.memberIds.includes('user')) return {};
    const rows = this.db.prepare(`SELECT l.id,l.companion_id,l.epoch,
      (SELECT COUNT(*) FROM bot_inbox i WHERE i.lane_id=l.id AND i.status='queued') AS queued,
      (SELECT COUNT(*) FROM bot_inbox i WHERE i.lane_id=l.id AND i.status='running') AS running,
      (SELECT reply_message_id FROM bot_inbox i WHERE i.lane_id=l.id AND i.status='running' ORDER BY sequence DESC LIMIT 1) AS reply_id,
      COALESCE(json_extract(r.value,'$.turns'),0) AS turns,
      CASE WHEN json_extract(m.value,'$.epoch')=l.epoch THEN json_extract(m.value,'$.lastRequest') ELSE NULL END AS request_json,
      CASE WHEN json_extract(m.value,'$.epoch')=l.epoch THEN COALESCE(json_extract(m.value,'$.compactionRequests'),0) ELSE 0 END AS compactions,
      CASE WHEN json_extract(m.value,'$.epoch')=l.epoch THEN json_extract(m.value,'$.latestCompactionAt') ELSE NULL END AS compacted_at
      FROM bot_lanes l JOIN bot_members member ON member.conversation_id=l.conversation_id AND member.member_id=l.companion_id
      LEFT JOIN bot_metadata r ON r.key='lane-retention:'||l.id AND json_extract(r.value,'$.epoch')=l.epoch
      LEFT JOIN bot_metadata m ON m.key='brain-context:'||l.id WHERE l.conversation_id=? LIMIT 16`).all(conversationId).map(asRow);
    return Object.fromEntries(rows.map(value => {
      const lastRequest = value.request_json ? botBrainRequestMetricsSchema.safeParse(JSON.parse(String(value.request_json))) : undefined;
      const summary: BotBrainContextSummary = { conversationId, companionId: String(value.companion_id), epoch: Number(value.epoch),
        queuedMessages: Number(value.queued), runningMessages: Number(value.running), retention: { completedTurns: Number(value.turns) },
        compactionRequests: Number(value.compactions), ...(value.compacted_at ? { latestCompactionAt: String(value.compacted_at) } : {}),
        ...(lastRequest?.success ? { lastRequest: lastRequest.data } : {}),
        phase: value.reply_id ? phaseForReply?.(String(value.reply_id)) ?? 'preparing-context' : Number(value.queued) ? 'queued' : undefined };
      return [summary.companionId, summary];
    }));
  }
  getEventNativeEpoch(eventId: string): number | undefined {
    const value = this.getMetadata(`event-native-epoch:${eventId}`); if (value === undefined) return;
    const epoch = Number(value); if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('事件原生通道绑定损坏。');
    return epoch;
  }
  trackNativeAdmission(input: BotNativeAdmission): void {
    const event = this.getEvent(input.eventId), epoch = this.getEventNativeEpoch(input.eventId);
    if (!event || event.status !== 'running' || epoch !== input.epoch || this.getLane(event.laneId)?.epoch !== epoch) throw new Error('原生投递上下文不属于当前事件通道。');
    if (!input.system || input.system.length > 64000 || !path.isAbsolute(input.cwd) || !Number.isSafeInteger(input.inputBytes) || input.inputBytes < 0) throw new Error('原生投递上下文无效。');
    const key = `native-admission:${input.eventId}`, value = JSON.stringify(input), prior = this.getMetadata(key);
    if (Buffer.byteLength(value) > 131072 || prior && prior !== value) throw new Error('原生事件投递上下文已改变或过大。');
    this.setMetadata(key, value);
  }
  pendingCancelledNativeAdmissions(laneId: string): BotNativeAdmission[] {
    return this.db.prepare('SELECT admission_json FROM bot_native_retirements WHERE lane_id=? ORDER BY source_sequence')
      .all(laneId).map(raw => JSON.parse(String(asRow(raw).admission_json)) as BotNativeAdmission);
  }
  readyNativeRetirementLanes(limit = 2): string[] {
    return this.db.prepare('SELECT lane_id FROM bot_native_retirements GROUP BY lane_id HAVING MIN(retry_at)<=? ORDER BY MIN(retry_at),MIN(source_sequence) LIMIT ?')
      .all(Date.now(), bounded(limit, 2, 8)).map(raw => String(asRow(raw).lane_id));
  }
  beginNativeRetirement(laneId: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT MAX(attempts) AS attempts,MIN(retry_at) AS retry_at FROM bot_native_retirements WHERE lane_id=?').get(laneId);
      if (!row || asRow(row).retry_at === null || Number(asRow(row).retry_at) > Date.now()) return false;
      const attempts = Number(asRow(row).attempts) + 1;
      this.db.prepare('UPDATE bot_native_retirements SET attempts=?,retry_at=? WHERE lane_id=?').run(attempts, Date.now() + Math.min(30000, 1000 * 2 ** Math.min(attempts, 5)), laneId);
      return true;
    }).immediate();
  }
  /** A UI cancel fences publication before native I/O finishes. Only this
   * separately reconciled receipt can amend retention after that lease ends. */
  resolveCancelledNativeAdmission(input: { eventId: string; epoch: number; metadata?: { key: string; value: string }; absent?: boolean }): boolean {
    return this.db.transaction(() => {
      const event = this.getEvent(input.eventId), lane = event && this.getLane(event.laneId);
      if (!event || event.status !== 'cancelled' || !lane || this.getEventNativeEpoch(event.id) !== input.epoch
        || this.getMetadata(`native-terminal-counted:${event.id}`) !== undefined || !this.getMetadata(`native-admission:${event.id}`)) return false;
      if (input.metadata && lane.epoch === input.epoch) {
        const value = JSON.parse(input.metadata.value) as BotLaneRetentionState;
        const previous = this.getLaneRetention(lane.id).last, previousEvent = previous && this.getEvent(previous.eventId);
        if (input.metadata.key !== botLaneRetentionKey(lane.id) || value.epoch !== lane.epoch || value.last?.eventId !== event.id
          || previousEvent && previousEvent.sequence > event.sequence || Buffer.byteLength(input.metadata.value) > 131072) return false;
        this.setMetadata(input.metadata.key, input.metadata.value);
      }
      this.setMetadata(`native-terminal-counted:${event.id}`, input.absent ? 'absent' : '1');
      this.db.prepare('DELETE FROM bot_native_retirements WHERE event_id=?').run(event.id);
      this.db.prepare('DELETE FROM bot_metadata WHERE key=?').run(`native-admission:${event.id}`);
      this.db.prepare('DELETE FROM bot_metadata WHERE key=?').run(`native-input:${event.id}`);
      return true;
    }).immediate();
  }
  /** Binding precedes native admission, so a crash never replays one event into another epoch. */
  bindEventNativeEpoch(eventId: string, expectedEpoch: number): number {
    return this.db.transaction(() => {
      const event = this.getEvent(eventId), lane = event && this.getLane(event.laneId), prior = this.getEventNativeEpoch(eventId);
      if (!event || event.status !== 'running' || !lane || lane.epoch !== expectedEpoch || prior !== undefined && prior !== expectedEpoch) {
        throw Object.assign(new Error('事件所属主脑通道已变化。'), { code: 'BOT_RETENTION_STALE' });
      }
      this.setMetadata(`event-native-epoch:${eventId}`, String(expectedEpoch));
      const state = this.getLaneRetention(event.laneId);
      const owner = state.handoffEventId ? this.getEvent(state.handoffEventId) : undefined;
      const unadmittedOwnerStopped = owner && ['failed', 'cancelled'].includes(owner.status) && !owner.dshEventId;
      if (state.handoff && (!state.handoffEventId || unadmittedOwnerStopped)) this.setMetadata(botLaneRetentionKey(event.laneId), JSON.stringify({ ...state, handoffEventId: eventId }));
      return expectedEpoch;
    }).immediate();
  }
  /** The source native session remains cold on disk; only the active pointer moves. */
  commitLaneHandoff(laneId: string, expectedEpoch: number, handoff: BotDshHandoff): boolean {
    const serialized = JSON.stringify(handoff); if (Buffer.byteLength(serialized) > 65536) throw new Error('原生主脑交接材料过大。');
    return this.db.transaction(() => {
      const lane = this.getLane(laneId); if (!lane || lane.epoch !== expectedEpoch) return false;
      const state = this.getLaneRetention(laneId);
      if (!state.last || state.last.eventId !== handoff.throughEventId || state.last.nativeLaneId !== handoff.laneId) return false;
      const previous = this.getEvent(handoff.throughEventId);
      if (!previous || previous.laneId !== laneId || !['done', 'failed', 'cancelled'].includes(previous.status)) return false;
      const accepted = this.db.prepare('UPDATE bot_lanes SET epoch=epoch+1,session_id=NULL WHERE id=? AND epoch=?').run(laneId, expectedEpoch);
      if (!accepted.changes) return false;
      // Retention preserves receipt authority; withdrawal rotations raise this
      // floor. Legacy epochs without that evidence remain conservatively fenced.
      if (this.getMetadata(`native-recovery-floor:${laneId}`) === undefined) this.setMetadata(`native-recovery-floor:${laneId}`, String(expectedEpoch));
      this.setMetadata(botLaneRetentionKey(laneId), JSON.stringify({ epoch: expectedEpoch + 1, turns: 0, bytes: 0, handoff } satisfies BotLaneRetentionState));
      return true;
    }).immediate();
  }
  saveSession(laneId: string, sessionId: string): BotLane {
    const lane = this.getLane(laneId); if (!lane) throw new Error('主脑通道不存在。');
    if (lane.sessionId && lane.sessionId !== sessionId) throw new Error('主脑通道已绑定其他DSH会话。');
    this.db.prepare('UPDATE bot_lanes SET session_id=? WHERE id=?').run(text(sessionId, 'DSH会话', 300), laneId); return this.getLane(laneId)!;
  }

  /** Only trusted host gateways call this method; UI requests cannot select their sender or domain. */
  enqueue(input: BotEnqueueInput): { message: BotMessage; events: BotEvent[] } {
    const attachments = input.attachments ?? [], attachmentsJson = JSON.stringify(attachments);
    if (attachments.length > 16 || attachmentsJson.length > 96000) throw new Error('每条消息最多16个附件；请拆分发送。');
    const content = attachments.length ? (typeof input.content === 'string' && input.content.length <= 128000 ? input.content.trim() : text(input.content, '消息', 128000)) : text(input.content, '消息', 128000);
    const evidence = botMessageEvidence({ content, attachments }); if (evidence.length > 128000) throw new Error('消息和附件元数据超过单条容量。');
    const source = input.source ?? (input.senderId === 'user' ? 'user' : 'companion');
    const sourceInstanceId = input.sourceInstanceId ?? 'worldlinebox', sourceMessageId = input.sourceMessageId ?? randomUUID();
    const kind = input.kind ?? 'message', payloadJson = JSON.stringify(attachments.length ? { ...input.payload, attachments } : input.payload ?? {});
    if (payloadJson.length > 128000) throw new Error('事件附加数据过大。');
    const originKey = hash([sourceInstanceId, sourceMessageId, input.conversationId]);
    return this.db.transaction(() => {
      const conversation = this.getConversation(input.conversationId); if (!conversation||conversation.dissolvedAt) throw new Error('会话不存在或已经解散。');
      const serviceSource = source === 'task' || source === 'world';
      if (!serviceSource && !conversation.memberIds.includes(input.senderId)) throw new Error('消息发送者不属于该会话。');
      if (source === 'world' && conversation.kind !== 'world') throw new Error('世界事件必须进入世界会话。');
      const sender = this.getCompanion(input.senderId);
      if (source === 'user' && input.senderId !== 'user' || source === 'companion' && !sender) throw new Error('事件来源与真实发送者不匹配。');
      const senderType: BotSenderType = sender ? 'companion' : input.senderId === 'user' ? 'user' : source === 'world' ? 'world' : 'service';
      const senderName = sender?.name ?? input.senderName ?? (input.senderId === 'user' ? '我' : source === 'world' ? '世界' : '任务');
      const prior = this.db.prepare('SELECT * FROM bot_origins WHERE origin_key=?').get(originKey);
      const priorMessage = prior ? this.getMessage(String(asRow(prior).message_id))! : undefined;
      const priorEvents = priorMessage ? this.db.prepare('SELECT * FROM bot_inbox WHERE source_record_id=? ORDER BY sequence').all(priorMessage.id).map(raw => this.event(raw)) : undefined;
      const routing = !priorEvents && conversation.kind === 'group' && source !== 'task' && source !== 'world'
        ? this.routeGroup(conversation, input.senderId, content) : undefined;
      const defaultRecipients = priorEvents ? priorEvents.map(event => event.companionId)
        : routing?.targets ?? conversation.memberIds.filter(id => id !== 'user' && id !== input.senderId);
      const recipients = [...new Set(input.recipientIds ?? defaultRecipients)];
      const attention = input.recipientIds === undefined && routing?.candidate === true;
      const eventPayloadJson = attention ? JSON.stringify({ ...JSON.parse(payloadJson), groupAttention: true }) : payloadJson;
      for (const id of recipients) if (!conversation.memberIds.includes(id) || !this.getCompanion(id) || id === input.senderId) throw new Error('事件目标不是合法会话伙伴。');
      const fingerprint = hash([input.senderId, content, source, kind, payloadJson, JSON.stringify([...recipients].sort())]);
      if (prior) {
        const r = asRow(prior); if (r.content_hash !== fingerprint) throw new Error('同一来源消息标识对应不同内容，拒绝重复投递。');
        return { message: priorMessage!, events: priorEvents! };
      }
      if (source === 'user' && conversation.kind === 'group') this.interruptGroup(conversation.id, isGroupStop(content));
      this.assertInboxCapacity(source, recipients.length);
      const stamp = nowIso(), correlationId = input.correlationId ?? randomUUID(), messageId = `message-${originKey}`;
      this.activityBudget.start(correlationId);
      if (!isInteractiveBotSource(source) && recipients.length) this.activityBudget.reserve(correlationId, 'events', originKey, recipients.length);
      this.db.prepare('INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at,attachments_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(messageId, originKey, conversation.id, input.senderId, senderName, senderType, content, 'sent', kind, correlationId, stamp, attachmentsJson);
      const sourceIds = [...new Set([...(input.sourceIds ?? []), ...(source === 'task' && typeof input.payload?.taskId === 'string' ? this.taskSourceIds(input.payload.taskId) : [])])];
      this.bindMessageAttachments(this.getMessage(messageId)!, source === 'user' || source === 'gateway', input.attachmentGrants, sourceIds);
      this.recordHistoryProjection(messageId);
      this.db.prepare('INSERT INTO bot_origins VALUES(?,?,?)').run(originKey, fingerprint, messageId);
      const events: BotEvent[] = [];
      for (const companionId of recipients) {
        const eventId = `event-${hash([originKey, companionId, kind])}`, laneId = `lane-${hash([conversation.id, companionId])}`, replyMessageId = `reply-${eventId}`;
        this.db.prepare('INSERT OR IGNORE INTO bot_lanes(id,conversation_id,companion_id,acl_revision) VALUES(?,?,?,?)').run(laneId, conversation.id, companionId, conversation.revision);
        this.db.prepare('INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(replyMessageId, eventId, conversation.id, companionId, this.getCompanion(companionId)!.name, 'companion', '', 'queued', attention ? 'attention' : 'message', correlationId, stamp);
        this.db.prepare(`INSERT INTO bot_inbox(id,lane_id,conversation_id,companion_id,source,source_instance_id,source_message_id,sender_id,sender_type,sender_name,scope_id,domain_id,acl_revision,kind,content,payload_json,correlation_id,causation_id,source_record_id,reply_message_id,status,occurred_at,received_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, laneId, conversation.id, companionId, source, sourceInstanceId, sourceMessageId,
            input.senderId, senderType, senderName, conversation.audienceScopeId, conversation.securityDomainId, conversation.revision, kind, evidence, eventPayloadJson, correlationId,
            input.causationId ?? null, messageId, replyMessageId, 'queued', input.occurredAt ?? stamp, stamp);
        events.push(this.getEvent(eventId)!);
      }
      if (source === 'user' || source === 'gateway') for (const event of events) for (const ref of attachments) this.db.prepare('INSERT OR IGNORE INTO bot_media_grant_sources VALUES(?,?)').run(`grant-${hash([messageId, ref.id])}`, event.id);
      if (senderType === 'companion' && input.causationId) {
        const cause = this.getEvent(input.causationId); if (cause) this.recordEmissionTiming(messageId, cause);
      }
      return { message: this.getMessage(messageId)!, events };
    }).immediate();
  }
  /** A completed public reply can be observed by its actual group peers. The
   * original message is referenced, never copied as another chat message. */
  observeGroupReply(eventId: string): BotEvent[] {
    return this.db.transaction(() => {
      const cause = this.getEvent(eventId); if (!cause || cause.status !== 'done') return [];
      const room = this.getConversation(cause.conversationId), message = this.getMessage(cause.replyMessageId);
      if (!room || room.dissolvedAt || !['group', 'peer'].includes(room.kind) || room.participationMode !== 'automatic'
        || room.revision !== cause.aclRevision || !room.memberIds.includes(cause.companionId)
        || !message || message.kind !== 'message' || message.status !== 'sent' || !message.content.trim() && !message.attachments?.length) return [];
      // Auto-discussion is an explicit, bounded root decision. Completing an
      // assignment does not authorize a fresh chain of mutual reviews.
      if (room.kind === 'group' && this.getMetadata(`group-discussion:${room.id}:${cause.correlationId}`) !== '1') return [];
      const root = this.db.prepare('SELECT source_record_id,received_at FROM bot_inbox WHERE conversation_id=? AND correlation_id=? ORDER BY sequence LIMIT 1')
        .get(room.id, cause.correlationId) as Record<string, unknown> | undefined;
      if (!root || Date.now() - Date.parse(String(root.received_at)) > GROUP_DISCUSSION_MS) return [];
      const replied = this.db.prepare(`SELECT i.companion_id,m.content FROM bot_inbox i JOIN bot_messages m ON m.id=i.reply_message_id
        WHERE i.conversation_id=? AND i.correlation_id=? AND i.status='done' AND m.status='sent' AND length(m.content)>0`)
        .all(room.id, cause.correlationId).map(asRow);
      if (replied.length >= GROUP_REPLY_LIMIT) return [];
      if (replied.some(row => row.content === message.content && row.companion_id !== cause.companionId)) return [];
      const newerUser = this.db.prepare("SELECT 1 FROM bot_messages WHERE conversation_id=? AND sender_id='user' AND sequence>? LIMIT 1")
        .get(room.id, this.getMessage(String(root.source_record_id))?.sequence ?? cause.sourceMessageSequence);
      if (newerUser) return [];
      const hop = cause.source === 'user' || cause.payload.hop === undefined ? 1 : Number(cause.payload.hop) + 1;
      if (!Number.isSafeInteger(hop) || hop > 6 || this.withdrawnIn(cause.companionId, cause.securityDomainId, this.eventSourceIds(cause.id)).size) return [];
      const originKey = hash(['group-observer', message.id, room.id]);
      if (this.db.prepare('SELECT 1 FROM bot_origins WHERE origin_key=?').get(originKey)) return [];
      const routing = this.routeGroup(room, cause.companionId, message.content);
      const reserved = Number(asRow(this.db.prepare("SELECT COUNT(*) AS n FROM bot_inbox WHERE conversation_id=? AND correlation_id=? AND status IN ('queued','running')").get(room.id, cause.correlationId)).n);
      const recipients = routing.targets.filter(id => replied.filter(row => row.companion_id === id).length < 2
        && !this.db.prepare("SELECT 1 FROM bot_inbox WHERE conversation_id=? AND correlation_id=? AND companion_id=? AND status IN ('queued','running')").get(room.id, cause.correlationId, id))
        .slice(0, Math.max(0, GROUP_REPLY_LIMIT - replied.length - reserved));
      if (!recipients.length) return [];
      this.assertInboxCapacity('group', recipients.length);
      this.activityBudget.reserve(cause.correlationId, 'events', originKey, recipients.length);
      const evidence = botMessageEvidence(message), content = evidence.length > 24000 ? evidence.slice(0, 24000) + '\n[消息较长，使用chat_read_message按原消息ID回查其余内容]' : evidence;
      const payload = JSON.stringify({ groupAttention: routing.candidate, hop, sourceMessageId: message.id, contentIsExcerpt: evidence.length > 24000 });
      const stamp = nowIso(), events: BotEvent[] = [];
      this.db.prepare('INSERT INTO bot_origins VALUES(?,?,?)').run(originKey, hash([message.id, content]), message.id);
      for (const companionId of recipients) {
        const id = `event-${hash([originKey, companionId, 'message'])}`, laneId = `lane-${hash([room.id, companionId])}`, replyId = `reply-${id}`;
        this.db.prepare('INSERT OR IGNORE INTO bot_lanes(id,conversation_id,companion_id,acl_revision) VALUES(?,?,?,?)').run(laneId, room.id, companionId, room.revision);
        this.db.prepare('INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(replyId, id, room.id, companionId, this.getCompanion(companionId)!.name, 'companion', '', 'queued', routing.candidate ? 'attention' : 'message', cause.correlationId, stamp);
        this.db.prepare(`INSERT INTO bot_inbox(id,lane_id,conversation_id,companion_id,source,source_instance_id,source_message_id,sender_id,sender_type,sender_name,scope_id,domain_id,acl_revision,kind,content,payload_json,correlation_id,causation_id,source_record_id,reply_message_id,status,occurred_at,received_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, laneId, room.id, companionId, 'group', 'group-observer', message.id, message.senderId, 'companion', message.senderName,
            room.audienceScopeId, room.securityDomainId, room.revision, 'message', content, payload, cause.correlationId, cause.id, message.id, replyId, 'queued', message.createdAt, stamp);
        events.push(this.getEvent(id)!);
      }
      return events;
    }).immediate();
  }
  /** An assessment has no visible bubble until this recipient accepts it. */
  promoteGroupReply(eventId: string, leaseToken: string): boolean {
    return !!this.db.prepare(`UPDATE bot_messages SET kind='message' WHERE kind IN ('attention','message') AND id=(
      SELECT reply_message_id FROM bot_inbox WHERE id=? AND lease_token=? AND status='running')`).run(eventId, leaseToken).changes;
  }
  private assertInboxCapacity(source: string, amount: number): void {
    if (!amount) return;
    const total = Number(asRow(this.db.prepare("SELECT COUNT(*) AS count FROM bot_inbox WHERE status IN ('queued','running')").get()).count);
    const policy = this.activityBudget.policy;
    if (total + amount > policy.maxPendingInbox) throw new BotBackpressureError('伙伴消息队列已满，请等待已接收的消息处理后再发送；本条尚未接收。');
    if (!isInteractiveBotSource(source)) {
      const automatic = Number(asRow(this.db.prepare("SELECT COUNT(*) AS count FROM bot_inbox WHERE status IN ('queued','running') AND source NOT IN ('user','task','gateway')").get()).count);
      if (automatic + amount > policy.maxPendingInbox - policy.reservedInteractiveInbox) throw new BotBackpressureError('自动活动容量已满，已保留用户与任务回执容量。');
    }
  }
  reserveAutomaticAction(eventId: string, callId: string, kind: string): void {
    this.db.transaction(() => {
      const event = this.getEvent(eventId); if (!event || event.status !== 'running') throw Error('活动预算没有有效运行事件。');
      const taskId = typeof event.payload.taskId === 'string' ? event.payload.taskId : undefined;
      const authorizedWork = !!taskId && event.source === 'task' && this.getMetadata(`task-notice-authority:${event.id}`) === taskId
        && this.taskBudgetAuthority?.(taskId) === true;
      this.activityBudget.reserve(event.correlationId, 'actions', `${eventId}:${callId}:${kind}`, 1, Date.now(), { authorizedWork });
    }).immediate();
  }
  reserveTaskAction(taskId: string, callId: string, kind: string): void {
    this.db.transaction(() => {
      const task = this.getTask(taskId), source = task && this.getEvent(task.sourceEventId);
      if (!task || task.status !== 'running' || task.extra.cancelRequested || !source) throw new Error('活动预算没有有效运行任务。');
      this.activityBudget.reserve(source.correlationId, 'actions', `task:${taskId}:${callId}:${kind}`, 1, Date.now(), { authorizedWork: this.taskBudgetAuthority?.(taskId) === true });
    }).immediate();
  }
  tryEnqueueAutomatic(input: BotEnqueueInput): { accepted: true; message: BotMessage; events: BotEvent[] } | { accepted: false; reason: string } {
    if (!['world', 'companion', 'group'].includes(input.source ?? '')) throw Error('只有自动事件使用此投递接口。');
    try { return { accepted: true, ...this.enqueue(input) }; }
    catch (error) { if (error instanceof BotActivityLimitError || error instanceof BotBackpressureError) return { accepted: false, reason: error.message }; throw error; }
  }
  /** Lifecycle facts commit even when Inbox is full. Their exact source ID
   * is admitted later; backpressure never discards a terminal/question notice. */
  enqueueTaskNotice(input: BotEnqueueInput): { deferred: boolean } {
    if (input.source !== 'task' || !input.sourceMessageId) throw Error('任务回执必须有稳定来源标识。');
    return this.db.transaction(() => {
      const id = hash([input.sourceInstanceId ?? 'worldlinebox', input.sourceMessageId!, input.conversationId]);
      const room=this.getConversation(input.conversationId);
      if(!room||room.dissolvedAt||(input.recipientIds??[]).some(member=>!room.memberIds.includes(member))){this.db.prepare('DELETE FROM bot_deferred_task_notices WHERE id=?').run(id);return{deferred:false};}
      const fingerprint = hash([input.senderId, input.content, input.kind ?? 'message', JSON.stringify(input.payload ?? {}), JSON.stringify([...(input.recipientIds ?? [])].sort())]);
      const prior = this.db.prepare('SELECT * FROM bot_deferred_task_notices WHERE id=?').get(id);
      if (prior && asRow(prior).fingerprint !== fingerprint) throw Error('同一任务回执标识对应不同内容。');
      const payload = prior ? JSON.parse(String(asRow(prior).payload_json)) as BotEnqueueInput : input;
      try {
        const delivered = this.enqueue(payload), task = typeof payload.payload?.taskId === 'string' ? this.getTask(payload.payload.taskId) : undefined;
        const source = task && this.getEvent(task.sourceEventId);
        if (task && source && payload.senderId === 'task-service' && payload.conversationId === task.conversationId
          && payload.causationId === source.id && payload.correlationId === source.correlationId) for (const event of delivered.events) {
          if (event.companionId === task.companionId) this.setMetadata(`task-notice-authority:${event.id}`, task.id);
        }
        this.db.prepare('DELETE FROM bot_deferred_task_notices WHERE id=?').run(id); return { deferred: false };
      }
      catch (error) {
        if (!(error instanceof BotBackpressureError)) throw error;
        this.db.prepare('INSERT OR IGNORE INTO bot_deferred_task_notices VALUES(?,?,?,?)').run(id, JSON.stringify(payload), fingerprint, nowIso());
        return { deferred: true };
      }
    }).immediate();
  }
  private flushDeferredTaskNotices(): void {
    for (const raw of this.db.prepare('SELECT * FROM bot_deferred_task_notices ORDER BY created_at,id LIMIT 32').all()) {
      const row = asRow(raw), input = JSON.parse(String(row.payload_json)) as BotEnqueueInput;
      const source = input.causationId ? this.getEvent(input.causationId) : undefined;
      if (typeof input.payload?.taskId === 'string' && this.taskSourcesWithdrawn(input.payload.taskId)) { this.db.prepare('DELETE FROM bot_deferred_task_notices WHERE id=?').run(String(row.id)); continue; }
      const recipients = input.recipientIds ?? this.getConversation(input.conversationId)?.memberIds.filter(id => id !== 'user' && id !== input.senderId) ?? [];
      if (source && recipients.every(id => this.withdrawnIn(id, source.securityDomainId, [source.id]).has(source.id))) {
        this.db.prepare('DELETE FROM bot_deferred_task_notices WHERE id=?').run(String(row.id)); continue;
      }
      if (this.enqueueTaskNotice(input).deferred) break;
    }
  }
  getEvent(id: string): BotEvent | undefined { const raw = this.db.prepare('SELECT * FROM bot_inbox WHERE id=?').get(id); return raw ? this.event(raw) : undefined; }
  eventForReply(replyMessageId: string): BotEvent | undefined { const raw = this.db.prepare('SELECT * FROM bot_inbox WHERE reply_message_id=?').get(replyMessageId); return raw ? this.event(raw) : undefined; }
  private event(raw: unknown): BotEvent {
    const r = asRow(raw); return { id: String(r.id), eventId: String(r.id), laneId: String(r.lane_id), conversationId: String(r.conversation_id), companionId: String(r.companion_id),
      source: String(r.source) as BotEvent['source'], sourceInstanceId: String(r.source_instance_id), sourceMessageId: String(r.source_message_id), senderId: String(r.sender_id),
      senderType: String(r.sender_type) as BotSenderType, senderName: String(r.sender_name), audienceScopeId: String(r.scope_id), securityDomainId: String(r.domain_id),
      aclRevision: Number(r.acl_revision), sequence: Number(r.sequence), kind: String(r.kind) as BotMessage['kind'], content: String(r.content), payload: JSON.parse(String(r.payload_json)),
      correlationId: String(r.correlation_id), causationId: optional(r.causation_id), sourceMessageRecordId: String(r.source_record_id),
      sourceMessageSequence: this.getMessage(String(r.source_record_id))!.sequence, replyMessageId: String(r.reply_message_id),
      status: String(r.status) as BotEventStatus, attempts: Number(r.attempts), occurredAt: String(r.occurred_at), receivedAt: String(r.received_at), dshEventId: optional(r.dsh_event_id), error: optional(r.error) };
  }
  /** Lease recovery preserves event and reply IDs; a stale worker cannot later publish. */
  claim(input: { workerId: string; leaseMs?: number; excludeLaneIds?: readonly string[]; now?: number; interactiveOnly?: boolean; preferInteractive?: boolean; serialCompanions?: boolean }): BotClaim | undefined {
    const now = input.now ?? Date.now(), leaseMs = bounded(input.leaseMs, 60000, 300000);
    return this.db.transaction(() => {
      this.flushDeferredTaskNotices();
      this.db.prepare("UPDATE bot_messages SET status='queued' WHERE id IN(SELECT reply_message_id FROM bot_inbox WHERE status='running' AND lease_until<=?)").run(now);
      this.db.prepare("UPDATE bot_inbox SET status='queued',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
      const excluded = input.excludeLaneIds ?? [];
      const skip = (excluded.length ? ` AND i.lane_id NOT IN (${excluded.map(() => '?').join(',')})` : '')
        + (input.interactiveOnly ? " AND i.source IN ('user','task','gateway')" : '');
      const raw = this.db.prepare(`SELECT i.* FROM bot_inbox i JOIN bot_lanes l ON l.id=i.lane_id
        WHERE i.status='queued' AND i.available_at<=?${skip}
        AND NOT EXISTS(SELECT 1 FROM bot_inbox older WHERE older.lane_id=i.lane_id AND older.sequence<i.sequence AND older.status IN ('queued','running'))
        AND NOT EXISTS(SELECT 1 FROM bot_inbox active WHERE active.lane_id=i.lane_id AND active.status='running')
        AND NOT EXISTS(SELECT 1 FROM bot_inbox room_active JOIN bot_conversations room ON room.id=room_active.conversation_id
          WHERE room_active.conversation_id=i.conversation_id AND room.kind IN ('group','peer') AND room_active.status='running')
        ${input.serialCompanions ? "AND NOT EXISTS(SELECT 1 FROM bot_inbox actor WHERE actor.companion_id=i.companion_id AND actor.status='running')" : ''}
        ORDER BY ${input.preferInteractive ? "CASE WHEN i.source IN ('user','task','gateway') THEN 0 ELSE 1 END," : ''}l.last_claimed_at,i.sequence LIMIT 1`).get(now, ...excluded);
      if (!raw) return;
      const event = this.event(raw), token = `${input.workerId}:${randomUUID()}`, leaseUntil = now + leaseMs;
      const timing = turnTiming(asRow(this.db.prepare('SELECT timing_json FROM bot_messages WHERE id=?').get(event.replyMessageId)).timing_json);
      if (timing.queueMs === undefined && Number.isFinite(Date.parse(event.receivedAt))) {
        timing.queueMs = Math.max(0, now - Date.parse(event.receivedAt));
        this.db.prepare('UPDATE bot_messages SET timing_json=? WHERE id=?').run(JSON.stringify(timing), event.replyMessageId);
      }
      this.db.prepare("UPDATE bot_inbox SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,error=NULL WHERE id=?").run(token, leaseUntil, event.id);
      this.db.prepare("UPDATE bot_messages SET status='running',error=NULL WHERE id=?").run(event.replyMessageId);
      // A monotonic logical clock avoids ties starving a lane when many fast turns finish in one millisecond.
      const order = Math.max(now, Number(this.getMetadata('claim-order') ?? '0') + 1);
      this.setMetadata('claim-order', String(order));
      this.db.prepare('UPDATE bot_lanes SET last_claimed_at=? WHERE id=?').run(order, event.laneId);
      return { event: this.getEvent(event.id)!, leaseToken: token, leaseUntil };
    }).immediate();
  }
  heartbeat(eventId: string, leaseToken: string, leaseMs = 60000): boolean {
    return !!this.db.prepare("UPDATE bot_inbox SET lease_until=? WHERE id=? AND lease_token=? AND status='running'").run(Date.now() + bounded(leaseMs, 60000, 300000), eventId, leaseToken).changes;
  }
  /** Accumulates actual phase work across retries. Only the current running
   * lease may write; wall-clock first text is measured from original ingress. */
  recordTurnTiming(eventId: string, leaseToken: string, update: BotTurnTimingUpdate): boolean {
    for (const value of Object.values(update)) if (value !== undefined && !validMilliseconds(value)) throw new Error('回复耗时必须是有限的非负毫秒数。');
    return this.db.transaction(() => {
      const raw = this.db.prepare(`SELECT i.received_at,m.id,m.timing_json FROM bot_inbox i JOIN bot_messages m ON m.id=i.reply_message_id
        WHERE i.id=? AND i.lease_token=? AND i.status='running'`).get(eventId, leaseToken);
      if (!raw) return false;
      const row = asRow(raw), timing = turnTiming(row.timing_json);
      for (const field of ['prepareMs', 'modelMs', 'finishMs'] as const) if (update[field] !== undefined) timing[field] = Math.min(Number.MAX_SAFE_INTEGER, (timing[field] ?? 0) + update[field]);
      if (update.firstTextAt !== undefined && Number.isFinite(Date.parse(String(row.received_at)))) {
        const firstTextMs = Math.max(0, update.firstTextAt - Date.parse(String(row.received_at)));
        timing.firstTextMs = timing.firstTextMs === undefined ? firstTextMs : Math.min(timing.firstTextMs, firstTextMs);
      }
      this.db.prepare('UPDATE bot_messages SET timing_json=? WHERE id=?').run(JSON.stringify(timing), row.id);
      return true;
    }).immediate();
  }
  private finishReplyTiming(event: Pick<BotEvent, 'replyMessageId' | 'receivedAt'>): void {
    const received = Date.parse(event.receivedAt); if (!Number.isFinite(received)) return;
    const raw = this.db.prepare('SELECT timing_json FROM bot_messages WHERE id=?').get(event.replyMessageId); if (!raw) return;
    const timing = turnTiming(asRow(raw).timing_json); timing.elapsedMs = Math.max(0, Date.now() - received);
    this.db.prepare('UPDATE bot_messages SET timing_json=? WHERE id=?').run(JSON.stringify(timing), event.replyMessageId);
  }
  private recordEmissionTiming(messageId: string, cause: Pick<BotEvent, 'replyMessageId' | 'receivedAt'>): void {
    const received = Date.parse(cause.receivedAt); if (!Number.isFinite(received)) return;
    const raw = this.db.prepare('SELECT timing_json FROM bot_messages WHERE id=?').get(cause.replyMessageId);
    const timing = turnTiming(raw && asRow(raw).timing_json);
    timing.elapsedMs = Math.max(0, Date.now() - received);
    this.db.prepare('UPDATE bot_messages SET timing_json=? WHERE id=?').run(JSON.stringify(timing), messageId);
  }
  updateDraft(eventId: string, leaseToken: string, content: string): boolean {
    if (content.length > 512000) throw new Error('回复草稿过大。');
    return !!this.db.prepare("UPDATE bot_messages SET content=? WHERE id=(SELECT reply_message_id FROM bot_inbox WHERE id=? AND lease_token=? AND status='running')").run(content, eventId, leaseToken).changes;
  }
  markDispatched(eventId: string, leaseToken: string, dshEventId: string): boolean {
    return !!this.db.prepare("UPDATE bot_inbox SET dsh_event_id=? WHERE id=? AND lease_token=? AND status='running'").run(dshEventId, eventId, leaseToken).changes;
  }
  settle(input: { eventId: string; leaseToken: string; status: 'done' | 'failed' | 'cancelled'; content?: string; error?: string; dshEventId?: string; memoryJobs?: BotMemoryJobInput[]; metadata?: Array<{ key: string; value: string }> }): boolean {
    if (input.content && input.content.length > 512000) throw new Error('回复过大。');
    return this.db.transaction(() => {
      const event = this.getEvent(input.eventId); if (!event) return false;
      if ((input.metadata?.length ?? 0) > 64) throw new Error('原子回复元数据过多。');
      for (const entry of input.metadata ?? []) {
        if (!entry.key || entry.key.length > 500 || Buffer.byteLength(entry.value) > 131072) throw new Error('原子回复元数据过大。');
        if (entry.key === botLaneRetentionKey(event.laneId) && (JSON.parse(entry.value) as BotLaneRetentionState).epoch !== this.getLane(event.laneId)?.epoch) return false;
      }
      const accepted = this.db.prepare("UPDATE bot_inbox SET status=?,error=?,dsh_event_id=COALESCE(?,dsh_event_id),lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='running'")
        .run(input.status, input.error ?? null, input.dshEventId ?? null, input.eventId, input.leaseToken);
      if (!accepted.changes) return false;
      this.finishReplyTiming(event);
      this.db.prepare('UPDATE bot_messages SET status=?,content=COALESCE(?,content),error=? WHERE id=?')
        .run(input.status === 'done' ? 'sent' : input.status, input.content ?? null, input.error ?? null, event.replyMessageId);
      const visibleReply = !!this.getMessage(event.replyMessageId)?.content.trim();
      this.bindMessageSources(event.replyMessageId, this.eventSourceIds(event.id));
      if (input.status === 'done' && visibleReply) {
        const messages = input.memoryJobs?.filter(job => job.kind === 'projection').flatMap(job => Array.isArray(job.payload.messages) ? job.payload.messages : []) as Array<{ id?: string; timestamp?: number }> | undefined;
        this.recordHistoryProjection(event.replyMessageId, messages?.find(message => message.id === event.replyMessageId)?.timestamp);
      }
      if (input.status === 'done' && visibleReply) this.db.prepare('INSERT OR IGNORE INTO bot_outbox(id,event_id,conversation_id,message_id,created_at) VALUES(?,?,?,?,?)')
        .run(event.replyMessageId, event.id, event.conversationId, event.replyMessageId, nowIso());
      for (const job of input.memoryJobs ?? []) this.enqueueMemoryJob(job);
      for (const entry of input.metadata ?? []) this.setMetadata(entry.key, entry.value);
      return true;
    }).immediate();
  }
  cancelEvent(eventId: string, clearContent = false): boolean {
    return this.db.transaction(() => {
      const event = this.getEvent(eventId); if (!event) return false;
      const result = this.db.prepare("UPDATE bot_inbox SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE id=? AND status IN ('queued','running')").run(eventId);
      if (result.changes) {
        this.finishReplyTiming(event);
        this.db.prepare("UPDATE bot_messages SET status='cancelled',content=CASE WHEN ? THEN '' ELSE content END WHERE id=?").run(clearContent ? 1 : 0, event.replyMessageId);
      }
      const admission = this.getMetadata(`native-admission:${eventId}`);
      if (admission && this.getEvent(eventId)?.status === 'cancelled' && this.getMetadata(`native-terminal-counted:${eventId}`) === undefined) {
        this.db.prepare('INSERT OR IGNORE INTO bot_native_retirements(event_id,lane_id,admission_json,source_sequence) VALUES(?,?,?,?)').run(eventId, event.laneId, admission, event.sequence);
      }
      return !!result.changes;
    }).immediate();
  }
  confirmMemoryForget(eventId: string, callId: string, receipt: { forgotten: true; id: string; revision: string; physicalSourceErasure: false }): BotMessage {
    if (receipt.forgotten !== true || receipt.physicalSourceErasure !== false || !receipt.id || !receipt.revision) throw new Error('遗忘没有有效的真实回执。');
    return this.db.transaction(() => {
      const event = this.getEvent(eventId); if (!event) throw new Error('遗忘来源事件不存在。');
      const key = `memory-forget-receipt:${eventId}:${callId}`, prior = this.getMetadata(key);
      if (prior && (JSON.parse(prior) as { id: string }).id !== receipt.id) throw new Error('遗忘回执标识已用于其他记忆。');
      if (!prior) this.setMetadata(key, JSON.stringify({ forgotten: true, id: receipt.id, revision: receipt.revision, physicalSourceErasure: false }));
      this.cancelEvent(eventId, true);
      const confirmed = this.enqueue({ conversationId: event.conversationId, senderId: event.companionId, source: 'companion', recipientIds: [],
        sourceInstanceId: 'memory-host-confirmation', sourceMessageId: `${eventId}:${callId}`, content: '已撤回这条记忆的使用。', correlationId: event.correlationId,
        causationId: event.id, payload: { hostConfirmation: 'memory_forget', eventId } }).message;
      this.db.prepare('INSERT OR IGNORE INTO bot_outbox(id,event_id,conversation_id,message_id,created_at) VALUES(?,?,?,?,?)')
        .run(confirmed.id, event.id, event.conversationId, confirmed.id, nowIso());
      return confirmed;
    }).immediate();
  }
  requeue(eventId: string, leaseToken: string, delayMs = 0): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare("UPDATE bot_inbox SET status='queued',lease_token=NULL,lease_until=NULL,available_at=? WHERE id=? AND lease_token=? AND status='running'").run(Date.now() + Math.max(0, delayMs), eventId, leaseToken);
      if (result.changes) this.db.prepare("UPDATE bot_messages SET status='queued' WHERE id=(SELECT reply_message_id FROM bot_inbox WHERE id=?)").run(eventId);
      return !!result.changes;
    }).immediate();
  }
  private message(raw: unknown): BotMessage {
    const r = asRow(raw), attachments = JSON.parse(String(r.attachments_json ?? '[]')) as BotMediaRef[], timing = turnTiming(r.timing_json);
    const taskSource = r.sender_id === 'task-service' && ['task_done', 'task_progress'].includes(String(r.kind))
      ? this.db.prepare("SELECT payload_json,reply_message_id FROM bot_inbox WHERE source_record_id=? AND source='task' LIMIT 1").get(r.id) : undefined;
    const taskId = taskSource ? JSON.parse(String(asRow(taskSource).payload_json)).taskId : undefined;
    const owner = typeof taskId === 'string' ? this.db.prepare(`SELECT t.companion_id,c.name,substr(json_extract(t.extra_json,'$.title'),1,120) AS title,t.status
      FROM bot_tasks t LEFT JOIN bot_companions c ON c.id=t.companion_id WHERE t.id=? AND t.conversation_id=?`).get(taskId, r.conversation_id) : undefined;
    return { id: String(r.id), eventId: String(r.event_id), conversationId: String(r.conversation_id), senderId: String(r.sender_id),
      senderName: String(r.sender_name), senderType: String(r.sender_type) as BotSenderType, content: String(r.content), status: String(r.status) as BotMessage['status'],
      sequence: Number(r.sequence), kind: String(r.kind) as BotMessage['kind'], correlationId: String(r.correlation_id), createdAt: String(r.created_at), error: optional(r.error), ...(attachments.length ? { attachments } : {}),
      ...(timing.elapsedMs !== undefined ? { timing: timing as BotReplyTiming } : {}),
      ...(typeof taskId === 'string' ? { taskNotice: { taskId, kind: String(r.kind) as 'task_done' | 'task_progress', replyMessageId: String(asRow(taskSource).reply_message_id),
        ...(owner ? { companionId: String(asRow(owner).companion_id), companionName: optional(asRow(owner).name), title: optional(asRow(owner).title), status: String(asRow(owner).status) } : {}) } } : {}) };
  }
  publishForEvent(eventId: string, callId: string, input: { content?: string; attachments: BotMediaRef[]; relativePath?: string; outputTaskId?: string; attachmentGrants?: BotAttachmentGrant[]; sourceIds?: string[] }): BotMessage {
    return this.publishMedia(eventId, callId, input);
  }
  publishForTask(taskId: string, callId: string, input: { content?: string; attachments: BotMediaRef[]; relativePath?: string; outputTaskId?: string; attachmentGrants?: BotAttachmentGrant[]; sourceIds?: string[] }): BotMessage {
    const task = this.getTask(taskId); if (!task) throw new Error('媒体产物任务不存在。');
    return this.publishMedia(task.sourceEventId, `task-${hash([taskId, callId])}`, input, task);
  }
  private publishMedia(eventId: string, callId: string, input: { content?: string; attachments: BotMediaRef[]; relativePath?: string; outputTaskId?: string; attachmentGrants?: BotAttachmentGrant[]; sourceIds?: string[] }, task?: BotTask): BotMessage {
    const fingerprint = hash([input.content ?? '', JSON.stringify(input.attachments), input.relativePath ?? '', ...(!task && input.outputTaskId ? [input.outputTaskId] : [])]);
    return this.db.transaction(() => {
      const event = this.getEvent(eventId), lane = event && this.getLane(event.laneId), conversation = event && this.getConversation(event.conversationId);
      const activeTask = task && this.getTask(task.id);
      const authorizedTask = activeTask && activeTask.status === 'running' && activeTask.extra.nativeAttempted === true && !activeTask.extra.cancelRequested
        && activeTask.companionId === event?.companionId && activeTask.conversationId === event?.conversationId && !this.taskSourcesWithdrawn(activeTask.id);
      if (!event || !lane || !conversation || conversation.revision !== event.aclRevision || !conversation.memberIds.includes(event.companionId)
        || this.withdrawnIn(event.companionId, event.securityDomainId, [event.id]).has(event.id)
        || (task ? !authorizedTask : event.status !== 'running' || this.getEventNativeEpoch(eventId) !== undefined && this.getEventNativeEpoch(eventId) !== lane.epoch)) throw new Error('发送媒体没有当前有效的主脑事件或任务。');
      const outputTaskId = task?.id ?? input.outputTaskId, outputTask = outputTaskId ? this.getTask(outputTaskId) : undefined;
      if (outputTaskId && (!outputTask || outputTask.companionId !== event.companionId || outputTask.conversationId !== event.conversationId
        || outputTask.extra.cancelRequested || this.taskSourcesWithdrawn(outputTaskId) || task && input.outputTaskId && input.outputTaskId !== task.id)) throw new Error('文件产物任务不属于当前受众或其来源已撤回。');
      if (!callId || callId.length > 300 || !input.attachments.length) throw new Error('媒体发送回执无效。');
      const previous = this.db.prepare('SELECT * FROM bot_publications WHERE event_id=? AND call_id=?').get(eventId, callId);
      if (previous) { if (asRow(previous).fingerprint !== fingerprint) throw new Error('同一媒体发送标识对应其他内容。'); return this.getMessage(String(asRow(previous).message_id))!; }
      const { message } = this.enqueue({ conversationId: event.conversationId, senderId: event.companionId, source: 'companion', sourceInstanceId: 'bot-publication-v1',
        sourceMessageId: `${eventId}:${callId}`, content: input.content ?? '', attachments: input.attachments, attachmentGrants: input.attachmentGrants,
        sourceIds: [...new Set([...this.eventSourceIds(event.id), ...(task ? this.taskSourceIds(task.id) : []), ...(input.sourceIds ?? [])])], recipientIds: [], correlationId: event.correlationId, causationId: event.id });
      this.db.prepare('INSERT INTO bot_publications(event_id,call_id,message_id,fingerprint,task_id,relative_path) VALUES(?,?,?,?,?,?)').run(eventId, callId, message.id, fingerprint, outputTaskId ?? null, input.relativePath ?? null);
      this.enqueueMemoryJob({ key: `history-publication:${eventId}:${callId}`, kind: 'projection', payload: { scope: { companionId: event.companionId, conversationId: event.conversationId, securityDomainId: event.securityDomainId } } });
      this.db.prepare('INSERT OR IGNORE INTO bot_outbox(id,event_id,conversation_id,message_id,created_at) VALUES(?,?,?,?,?)').run(message.id, event.id, event.conversationId, message.id, message.createdAt);
      this.recordEmissionTiming(message.id, event);
      return this.getMessage(message.id)!;
    }).immediate();
  }
  publicationsForEvent(eventId: string): BotMessage[] {
    return this.db.prepare('SELECT m.* FROM bot_publications p JOIN bot_messages m ON m.id=p.message_id WHERE p.event_id=? ORDER BY m.sequence').all(eventId).map(raw => this.message(raw));
  }
  publicationsForTask(taskId: string): Array<{ messageId: string; attachmentIds: string[]; relativePath?: string }> {
    const source = this.taskSourceScope(taskId); if (!source) return [];
    const key = hash([source.companionId, source.securityDomainId]);
    return this.db.prepare(`SELECT p.relative_path,m.id,m.attachments_json FROM bot_publications p JOIN bot_messages m ON m.id=p.message_id WHERE p.task_id=?
      AND NOT EXISTS(SELECT 1 FROM bot_withdrawn_sources w WHERE w.domain_key=? AND (w.source_id=m.id OR w.source_id=p.event_id))
      AND NOT EXISTS(SELECT 1 FROM bot_message_sources s JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=s.source_id WHERE s.message_id=m.id)
      ORDER BY m.sequence DESC LIMIT 16`).all(taskId, key, key)
      .map(raw => { const value = asRow(raw), attachments = JSON.parse(String(value.attachments_json ?? '[]')) as Array<{ id: string }>;
        return { messageId: String(value.id), attachmentIds: attachments.map(ref => ref.id), relativePath: optional(value.relative_path) }; }).reverse();
  }
  deliveredTaskOutput(event: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, taskId: string, relativePath: string, ref: BotMediaRef): BotMessage | undefined {
    const task = this.getTask(taskId);
    if (!task || task.companionId !== event.companionId || task.conversationId !== event.conversationId || task.extra.cancelRequested || this.taskSourcesWithdrawn(taskId)) throw new Error('不能核对其他任务或已撤回来源的文件回执。');
    const key = hash([event.companionId, event.securityDomainId]);
    const row = this.db.prepare(`SELECT m.* FROM bot_publications p JOIN bot_messages m ON m.id=p.message_id
      WHERE p.task_id=? AND p.relative_path=? AND m.conversation_id=? AND m.status='sent' AND json_array_length(m.attachments_json)=1
      AND json_extract(m.attachments_json,'$[0].id')=? AND json_extract(m.attachments_json,'$[0].sha256') IS ? AND json_extract(m.attachments_json,'$[0].size')=?
      AND NOT EXISTS(SELECT 1 FROM bot_withdrawn_sources w WHERE w.domain_key=? AND (w.source_id=m.id OR w.source_id=p.event_id))
      AND NOT EXISTS(SELECT 1 FROM bot_message_sources s JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=s.source_id WHERE s.message_id=m.id)
      ORDER BY m.sequence DESC LIMIT 1`).get(taskId, relativePath, event.conversationId, ref.id, ref.sha256 ?? null, ref.size, key, key);
    return row ? this.message(row) : undefined;
  }
  modelAttachments(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, options: { query?: string; ids?: string[] } = {}): BotMediaRef[] { return this.modelAttachmentGrants(scope, options).map(entry => entry.ref); }
  modelAttachmentGrants(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, options: { query?: string; ids?: string[]; throughSourceSequence?: number; all?: boolean } = {}): Array<{ ref: BotMediaRef; grantId: string }> {
    const conversation = this.getConversation(scope.conversationId);
    if (!conversation?.memberIds.includes(scope.companionId) || conversation.securityDomainId !== scope.securityDomainId) throw new Error('附件查询没有当前主脑受众权限。');
    const key = hash([scope.companionId, scope.securityDomainId]), query = (options.query ?? '').slice(0, 200).replace(/[\\%_]/g, char => `\\${char}`);
    const ids = options.ids ? [...new Set(options.ids)] : undefined;
    if (ids && (!ids.length || ids.length > 16)) return [];
    return this.db.prepare(`SELECT a.value AS ref_json,mg.grant_id,MAX(m.sequence) AS latest FROM bot_messages m,json_each(m.attachments_json) a
      JOIN bot_message_media_grants mg ON mg.message_id=m.id AND mg.media_id=json_extract(a.value,'$.id')
      WHERE m.conversation_id=? AND m.status='sent' AND m.attachments_json<>'[]'
      AND m.sequence<=?
      ${ids ? `AND json_extract(a.value,'$.id') IN(${ids.map(() => '?').join(',')})` : ''}
      AND (?='' OR json_extract(a.value,'$.name') LIKE ? ESCAPE '\\')
      AND NOT EXISTS(SELECT 1 FROM bot_withdrawn_sources w WHERE w.domain_key=? AND w.source_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM bot_publications p JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=p.event_id WHERE p.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM bot_inbox i JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=i.id
        WHERE i.companion_id=? AND (i.source_record_id=m.id OR i.reply_message_id=m.id))
      AND NOT EXISTS(SELECT 1 FROM bot_media_grant_sources s JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=s.source_id WHERE s.grant_id=mg.grant_id)
      AND NOT EXISTS(SELECT 1 FROM bot_message_sources s JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=s.source_id WHERE s.message_id=m.id)
      GROUP BY json_extract(a.value,'$.id') ORDER BY latest DESC ${options.all ? '' : 'LIMIT 80'}`).all(scope.conversationId, options.throughSourceSequence ?? Number.MAX_SAFE_INTEGER, ...(ids ?? []), query, `%${query}%`, key, key, key, scope.companionId, key, key)
      .map(raw => ({ ref: JSON.parse(String(asRow(raw).ref_json)) as BotMediaRef, grantId: String(asRow(raw).grant_id) }));
  }
  getMessage(id: string): BotMessage | undefined { const raw = this.db.prepare('SELECT * FROM bot_messages WHERE id=?').get(id); return raw ? this.message(raw) : undefined; }
  private recordHistoryProjection(messageId: string, timestamp?: number): void {
    const message = this.getMessage(messageId); if (!message || message.status !== 'sent') return;
    this.db.prepare('INSERT OR IGNORE INTO bot_history_projection(message_id,conversation_id,timestamp) VALUES(?,?,?)')
      .run(message.id, message.conversationId, Number.isFinite(timestamp) ? timestamp! : Date.parse(message.createdAt));
  }
  historyProjectionHead(conversationId: string): number {
    return Number(asRow(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS head FROM bot_history_projection WHERE conversation_id=?').get(conversationId)).head);
  }
  /** UI placeholders receive their sequence before completion. Hot model
   * history follows actual publication, while the trigger bounds future input. */
  recentPublishedMessages(conversationId: string, options: { throughSourceSequence: number; limit?: number; maxChars?: number }): BotMessage[] {
    const rows = this.db.prepare(`SELECT m.* FROM bot_history_projection p JOIN bot_messages m ON m.id=p.message_id
      WHERE p.conversation_id=? AND m.sequence<=? AND m.status='sent' AND (length(m.content)>0 OR m.attachments_json<>'[]') ORDER BY p.sequence DESC LIMIT ?`)
      .all(conversationId, options.throughSourceSequence, bounded(options.limit, 80, 200)).map(raw => this.message(raw));
    const selected: BotMessage[] = [], maxChars = bounded(options.maxChars, 24000, 256000); let size = 0;
    for (const message of rows) { const chars = botMessageEvidence(message).length; if (selected.length && size + chars > maxChars) break; selected.push(message); size += chars; }
    return selected.reverse();
  }
  historyProjectionPage(conversationId: string, options: { after: number; through: number; limit?: number }): BotHistoryProjectionRow[] {
    return this.db.prepare(`SELECT m.*,p.sequence AS projection_sequence,p.timestamp AS projection_timestamp FROM bot_history_projection p
      JOIN bot_messages m ON m.id=p.message_id WHERE p.conversation_id=? AND p.sequence>? AND p.sequence<=? ORDER BY p.sequence LIMIT ?`)
      .all(conversationId, options.after, options.through, bounded(options.limit, 32, 100)).map(raw => ({ projectionSequence: Number(asRow(raw).projection_sequence),
        timestamp: Number(asRow(raw).projection_timestamp), message: this.message(raw) }));
  }
  messagesPage(conversationId: string, options: { limit?: number; before?: number } = {}): BotMessagePage {
    const limit = bounded(options.limit, 100, 200);
    const found = this.db.prepare("SELECT * FROM bot_messages WHERE conversation_id=? AND sequence<? AND kind<>'attention' ORDER BY sequence DESC LIMIT ?")
      .all(conversationId, options.before ?? Number.MAX_SAFE_INTEGER, limit + 1).map(raw => this.message(raw));
    const hasMore = found.length > limit, items = found.slice(0, limit).reverse();
    return { items, hasMore, nextBefore: hasMore ? items[0]?.sequence : undefined };
  }
  /** Explicit scoped original-history search. Trigram FTS handles >=3 Unicode
   * code points; shorter literals use LIKE within this one authorized chat.
   * MATCH receives a quoted literal, never user-supplied FTS operators. */
  searchMessages(conversationId: string, options: { query?: string; before?: number; limit?: number; filter?: BotHistoryFilter } = {}): BotMessagePage {
    const conversation = this.getConversation(conversationId);
    if (!conversation || !conversation.memberIds.includes('user') && conversation.userRole !== 'observer' || this.developmentDefaultCleanup()?.conversationIds.includes(conversationId)) throw new Error('当前用户不能查询这个会话的聊天记录。');
    const query = options.query ?? '';
    if (typeof query !== 'string' || query.length > 200 || query.includes('\0')) throw new Error('聊天记录关键词超过200字符或无效。');
    if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 1)) throw new Error('聊天记录游标无效。');
    const filter = options.filter ?? 'all';
    if (!['all', 'media', 'stickers', 'files', 'links'].includes(filter)) throw new Error('聊天记录分类无效。');
    const literal = query.trim(), escaped = literal.replace(/[\\%_]/g, character => `\\${character}`), limit = bounded(options.limit, 80, 80);
    const indexed = Array.from(literal).length >= 3;
    const mediaType = `(json_extract(a.value,'$.mimeType') LIKE 'image/%' OR json_extract(a.value,'$.mimeType') LIKE 'video/%' OR json_extract(a.value,'$.mimeType') LIKE 'audio/%'
      OR (json_extract(a.value,'$.mimeType')='application/mp4' AND (lower(json_extract(a.value,'$.name')) GLOB '*.mp4' OR lower(json_extract(a.value,'$.name')) GLOB '*.m4v' OR lower(json_extract(a.value,'$.name')) GLOB '*.m4a')))`;
    const category = filter === 'all' ? '' : filter === 'links' ? ' AND bot_history_has_link(m.content)=1'
      : ` AND EXISTS(SELECT 1 FROM json_each(m.attachments_json) a WHERE ${filter === 'stickers' ? "json_extract(a.value,'$.kind')='sticker'"
        : `COALESCE(json_extract(a.value,'$.kind'),'file')='file' AND ${filter === 'files' ? 'NOT ' : ''}${mediaType}`})`;
    const found = this.db.prepare(`SELECT m.* FROM bot_messages m ${indexed ? 'JOIN bot_message_search ON bot_message_search.rowid=m.sequence' : ''}
      WHERE m.conversation_id=? AND m.sequence<? ${indexed ? 'AND bot_message_search MATCH ?' : ''}
      AND m.kind<>'attention' AND m.status IN ('queued','running','sent','failed','cancelled') AND (length(trim(m.content))>0 OR json_array_length(m.attachments_json)>0)
      AND (?='' OR m.content LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(m.attachments_json) a WHERE json_extract(a.value,'$.name') LIKE ? ESCAPE '\\'))${category} ORDER BY m.sequence DESC LIMIT ?`)
      .all(conversationId, options.before ?? Number.MAX_SAFE_INTEGER, ...(indexed ? [`"${literal.replaceAll('"', '""')}"`] : []), literal, `%${escaped}%`, `%${escaped}%`, limit + 1).map(raw => this.message(raw));
    const items = found.slice(0, limit), hasMore = found.length > limit;
    return { items, hasMore, nextBefore: hasMore ? items.at(-1)?.sequence : undefined };
  }
  /** Model context excludes placeholders and future input; passing through the trigger avoids parallel-lane contamination. */
  recentMessages(conversationId: string, options: { limit?: number; before?: number; throughSequence?: number; maxChars?: number } = {}): BotMessage[] {
    const found = this.db.prepare("SELECT * FROM bot_messages WHERE conversation_id=? AND sequence<? AND sequence<=? AND status='sent' AND (length(content)>0 OR attachments_json<>'[]') ORDER BY sequence DESC LIMIT ?")
      .all(conversationId, options.before ?? Number.MAX_SAFE_INTEGER, options.throughSequence ?? Number.MAX_SAFE_INTEGER, bounded(options.limit, 40, 200)).map(raw => this.message(raw));
    const selected: BotMessage[] = [], maxChars = bounded(options.maxChars, 32000, 256000); let size = 0;
    for (const item of found) { const chars = botMessageEvidence(item).length; if (selected.length && size + chars > maxChars) break; selected.push(item); size += chars; }
    return selected.reverse();
  }
  pendingOutbox(limit = 100): Array<{ id: string; eventId: string; conversationId: string; messageId: string }> {
    return this.db.prepare("SELECT * FROM bot_outbox WHERE status='pending' ORDER BY created_at,id LIMIT ?").all(bounded(limit, 100, 500))
      .map(raw => { const r = asRow(raw); return { id: String(r.id), eventId: String(r.event_id), conversationId: String(r.conversation_id), messageId: String(r.message_id) }; });
  }
  acknowledgeOutbox(id: string): void { this.db.prepare("UPDATE bot_outbox SET status='delivered',delivered_at=? WHERE id=? AND status='pending'").run(nowIso(), id); }
  createTask(input: { id?: string; conversationId: string; companionId: string; sourceEventId: string; goal: string; attemptId?: string; dshTaskId?: string; sessionId?: string; extra?: Record<string, unknown>; attachmentGrants?: BotAttachmentGrant[] }): BotTask {
    if (this.isRetiredDevelopmentDefault(input.companionId)) throw new Error('旧开发伙伴已退休。');
    return this.db.transaction(() => {
    const source = this.getEvent(input.sourceEventId);
    if (!source || source.conversationId !== input.conversationId || source.companionId !== input.companionId) throw new Error('任务来源不属于当前主脑通道。');
    const room=this.getConversation(source.conversationId);if(!room||room.dissolvedAt||room.revision!==source.aclRevision||!room.memberIds.includes(source.companionId))throw new Error('任务来源的会话权限已变化。');
    const id = input.id ?? randomUUID(), prior = this.getTask(id), goal = text(input.goal, '任务目标', 32000);
    if (prior) {
      if (typeof prior.extra.removedAt === 'string') {
        if (prior.sourceEventId !== input.sourceEventId || prior.extra.removedFingerprint !== botTaskRemovalFingerprint({ sourceEventId: input.sourceEventId, goal, attachmentIds: input.extra?.attachmentIds, title: input.extra?.title })) throw new Error('已移除任务的标识不能用于不同请求。');
        if (this.taskSourcesWithdrawn(prior.id)) throw new Error('任务输入的原授权来源已撤回。');
        return prior;
      }
      const ids = (extra: Record<string, unknown> | undefined) => [...new Set(Array.isArray(extra?.attachmentIds) ? extra.attachmentIds as string[] : [])].sort();
      if (prior.sourceEventId !== input.sourceEventId || prior.goal !== goal || JSON.stringify(ids(prior.extra)) !== JSON.stringify(ids(input.extra))
        || input.extra?.title !== undefined && input.extra.title !== prior.extra.title) throw new Error('任务标识已被其他目标或附件使用。');
      if (this.taskSourcesWithdrawn(prior.id)) throw new Error('任务输入的原授权来源已撤回。'); return prior;
    }
    const policy = this.activityBudget.policy;
    const total = Number(asRow(this.db.prepare("SELECT COUNT(*) AS count FROM bot_tasks WHERE status IN ('queued','running','waiting','paused','unknown')").get()).count);
    if (total >= policy.maxPendingTasks) throw new BotBackpressureError('执行任务队列已满，请等待已有任务结束。');
    if (!['user', 'gateway'].includes(source.source)) {
      const automatic = Number(asRow(this.db.prepare(`SELECT COUNT(*) AS count FROM bot_tasks t JOIN bot_inbox i ON i.id=t.source_event_id
        WHERE t.status IN ('queued','running','waiting','paused','unknown') AND i.source NOT IN ('user','gateway')`).get()).count);
      if (automatic >= policy.maxPendingTasks - policy.reservedInteractiveTasks) throw new BotBackpressureError('自动任务容量已满，已为用户委派保留容量。');
    }
    this.activityBudget.reserve(source.correlationId, 'tasks', id);
    const stamp = nowIso(); this.db.prepare('INSERT INTO bot_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.conversationId, input.companionId, input.sourceEventId, goal,
      'queued', input.attemptId ?? randomUUID(), input.dshTaskId ?? null, input.sessionId ?? null, null, null, stamp, stamp, JSON.stringify(input.extra ?? {}));
    const contextIds = Array.isArray(input.extra?.handoffSourceIds) ? input.extra.handoffSourceIds : [];
    if (contextIds.some(id => typeof id !== 'string' || !(() => { const message = this.getMessage(id); return message?.conversationId === source.conversationId
      && message.status === 'sent' && message.sequence <= Number(input.extra?.handoffThroughSequence ?? source.sourceMessageSequence); })())
      || this.withdrawnIn(source.companionId, source.securityDomainId, contextIds as string[]).size) throw new Error('任务交接上下文来源无效或已经撤回。');
    const requested = new Set(Array.isArray(input.extra?.attachmentIds) ? input.extra.attachmentIds as string[] : []), selected = input.attachmentGrants ?? [];
    if (selected.length !== requested.size || selected.some(grant => !requested.has(grant.mediaId) || !this.grantValid(source, grant))) throw new Error('任务附件缺少有效的已固定授权来源。');
    for (const grant of selected) this.db.prepare('INSERT INTO bot_task_media_grants VALUES(?,?,?)').run(id, grant.mediaId, grant.grantId);
    return this.getTask(id)!;
    }).immediate();
  }
  private task(raw: unknown): BotTask {
    const r = asRow(raw); return { id: String(r.id), conversationId: String(r.conversation_id), companionId: String(r.companion_id), companionName: optional(r.companion_name), sourceEventId: String(r.source_event_id),
      goal: String(r.goal), status: String(r.status) as BotTaskStatus, attemptId: String(r.attempt_id), dshTaskId: optional(r.dsh_task_id), sessionId: optional(r.session_id),
      summary: optional(r.summary), summaryIsPreview: r.summary_is_preview === undefined || r.summary_is_preview === null ? undefined : Number(r.summary_is_preview) === 1,
      error: optional(r.error), createdAt: String(r.created_at), updatedAt: String(r.updated_at), extra: JSON.parse(String(r.extra_json)) };
  }
  getTask(id: string): BotTask | undefined { const raw = this.db.prepare('SELECT * FROM bot_tasks WHERE id=?').get(id); return raw ? this.task(raw) : undefined; }
  getTaskStatus(id:string):BotTask|undefined{
    const raw=this.db.prepare(`SELECT id,conversation_id,companion_id,source_event_id,'' AS goal,status,attempt_id,dsh_task_id,session_id,NULL AS summary,NULL AS error,created_at,updated_at,
      json_object('removedAt',json_extract(extra_json,'$.removedAt'),
        'cancelRequested',json(CASE WHEN json_type(extra_json,'$.cancelRequested')='true' THEN 'true' ELSE 'false' END),
        'cancelRequestedAt',json_extract(extra_json,'$.cancelRequestedAt'),
        'progress',json_object('phase',substr(json_extract(extra_json,'$.progress.phase'),1,100),'updatedAt',substr(json_extract(extra_json,'$.progress.updatedAt'),1,100))) AS extra_json
      FROM bot_tasks WHERE id=?`).get(id);return raw?this.task(raw):undefined;
  }
  /** Bounded SQL projection for chat state, router context and directory pages.
   * Full reports and frozen worker inputs stay in SQLite until explicitly read. */
  listTaskCatalog(input: { conversationId?: string; companionId?: string; filter?: 'all' | 'active' | 'done' | 'issues'; query?: string;
    view: 'context' | 'directory'; order?: 'activity' | 'created' | 'summary'; limit?: number; offset?: number }): BotTask[] {
    const predicates: string[] = ["json_extract(extra_json,'$.removedAt') IS NULL"], args: Array<string | number> = [];
    if (input.conversationId) { predicates.push('conversation_id=?'); args.push(input.conversationId); }
    if (input.companionId) { predicates.push('companion_id=?'); args.push(input.companionId); }
    if (input.filter === 'active') predicates.push("status IN ('queued','running','waiting','paused','unknown')");
    if (input.filter === 'done') predicates.push("status IN ('succeeded','failed','cancelled')");
    if (input.filter === 'issues') predicates.push("status IN ('waiting','unknown','failed')");
    if (input.query?.trim()) { predicates.push("instr(lower(goal||' '||COALESCE(json_extract(extra_json,'$.title'),'')),lower(?))>0"); args.push(input.query.trim()); }
    const goalChars = input.view === 'context' ? 2000 : 200, summary = input.view === 'context' ? 'substr(summary,1,2000)' : 'NULL';
    const limit = bounded(input.limit, input.view === 'context' ? 100 : 6, input.view === 'context' ? 100 : 30);
    const offset = Number.isSafeInteger(input.offset) ? Math.min(30000000, Math.max(0, input.offset!)) : 0;
    const plainQueued = "status='queued' AND COALESCE(json_extract(extra_json,'$.cancelRequested'),0)<>1 AND COALESCE(json_extract(extra_json,'$.pauseRequested'),0)<>1";
    const order = input.order === 'summary'
      ? `CASE WHEN status IN ('running','waiting','paused','unknown') OR status='queued' AND NOT (${plainQueued}) THEN 0 WHEN status='queued' THEN 1 ELSE 2 END,CASE WHEN ${plainQueued} THEN created_at END ASC,CASE WHEN NOT (${plainQueued}) THEN updated_at END DESC,id`
      : input.order === 'created' ? 'created_at DESC,id DESC' : 'updated_at DESC,id';
    const rows = this.db.prepare(`SELECT id,conversation_id,companion_id,(SELECT name FROM bot_companions WHERE bot_companions.id=bot_tasks.companion_id) AS companion_name,source_event_id,substr(goal,1,${goalChars}) AS goal,status,attempt_id,dsh_task_id,session_id,
      ${summary} AS summary,${input.view === 'context' ? 'length(summary)>2000' : 'NULL'} AS summary_is_preview,${input.order === 'summary' ? 'NULL' : 'substr(error,1,2000)'} AS error,created_at,updated_at,
      json_object('title',substr(json_extract(extra_json,'$.title'),1,120),
        'humanStopped',json(CASE WHEN json_type(extra_json,'$.humanStopped')='true' THEN 'true' ELSE 'false' END),
        'cancelRequested',json(CASE WHEN json_type(extra_json,'$.cancelRequested')='true' THEN 'true' ELSE 'false' END),
        'cancelRequestedAt',json_extract(extra_json,'$.cancelRequestedAt'),'presenceStartedAt',json_extract(extra_json,'$.presenceStartedAt'),
        'cancelRecoveryPaused',json(CASE WHEN json_type(extra_json,'$.cancelRecoveryPaused')='true' THEN 'true' ELSE 'false' END),
        'pauseRequested',json(CASE WHEN json_type(extra_json,'$.pauseRequested')='true' THEN 'true' ELSE 'false' END),
        'pauseRequestedAt',json_extract(extra_json,'$.pauseRequestedAt'),'pausedAt',json_extract(extra_json,'$.pausedAt'),
        'outputCheckpoint',json_extract(extra_json,'$.outputCheckpoint'),
        'progress',json(CASE WHEN json_type(extra_json,'$.progress')='object' THEN
          json_object('phase',substr(json_extract(extra_json,'$.progress.phase'),1,100),
            'detail',substr(json_extract(extra_json,'$.progress.detail'),1,1000),
            'toolName',substr(json_extract(extra_json,'$.progress.toolName'),1,160),
            'updatedAt',substr(json_extract(extra_json,'$.progress.updatedAt'),1,100)) ELSE 'null' END)) AS extra_json
      FROM bot_tasks ${predicates.length ? 'WHERE ' + predicates.join(' AND ') : ''}
      ORDER BY CASE WHEN status IN ('queued','running','waiting','paused','unknown') THEN 0 ELSE 1 END,${order} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    return rows.map(raw => this.task(raw));
  }
  pendingTasks(limit = 10): BotTask[] {
    return this.db.prepare(`SELECT * FROM bot_tasks WHERE (status IN ('queued','running','unknown')
        OR (status IN ('waiting','paused') AND (json_extract(extra_json,'$.cancelRequested')=1 OR json_extract(extra_json,'$.pauseRequested')=1 OR status='waiting' AND EXISTS(SELECT 1 FROM bot_task_questions q WHERE q.task_id=bot_tasks.id AND q.state='answered'))))
      AND COALESCE(json_extract(extra_json,'$.cancelRecoveryPaused'),0)<>1
      AND (COALESCE(json_extract(extra_json,'$.pauseRecoveryPaused'),0)<>1 OR json_extract(extra_json,'$.cancelRequested')=1)
      AND (COALESCE(json_extract(extra_json,'$.retryAt'),0)<=?
        OR (json_extract(extra_json,'$.cancelRequested')=1 AND COALESCE(json_extract(extra_json,'$.nativeAttempted'),0)<>1))
      ORDER BY CASE WHEN json_extract(extra_json,'$.cancelRequested')=1 THEN 0 ELSE 1 END,created_at,id LIMIT ?`)
      .all(Date.now(), bounded(limit, 10, 100)).map(raw => this.task(raw));
  }
  activeDomainTasks(companionId: string, securityDomainId: string): BotTask[] {
    return this.db.prepare(`SELECT t.* FROM bot_tasks t JOIN bot_inbox source ON source.id=t.source_event_id
      WHERE t.companion_id=? AND source.domain_id=? AND t.status IN ('queued','running','waiting','paused','unknown') ORDER BY t.created_at,t.id`)
      .all(companionId, securityDomainId).map(raw => this.task(raw));
  }
  /** A terminal task and its source-bound notification commit together. */
  finishTask(id: string, patch: { status: BotTaskStatus; summary?: string; error?: string; sessionId?: string }, notice: BotEnqueueInput): void {
    this.db.transaction(() => { if (this.getTask(id)?.extra.removedAt) return; this.updateTask(id, patch); this.enqueueTaskNotice(notice); }).immediate();
  }
  updateTask(id: string, patch: { status?: BotTaskStatus; summary?: string; error?: string; dshTaskId?: string; sessionId?: string; extra?: Record<string, unknown>; attemptId?: string }): BotTask {
    const task = this.getTask(id); if (!task) throw new Error('任务不存在。');
    if (patch.attemptId && patch.attemptId !== task.attemptId) throw new Error('任务回执来自过期执行轮次。');
    const status = patch.status ?? task.status; if (!taskStatuses.has(status)) throw new Error('任务状态无效。');
    if (['succeeded', 'failed', 'cancelled'].includes(task.status) && status !== task.status) throw new Error('任务已结束，不能被迟到回执重新启动。');
    if (typeof task.extra.removedAt === 'string') return task;
    const extra = { ...(patch.extra ?? task.extra) }, updatedAt = nowIso();
    if (task.extra.presenceStartedAt && !extra.presenceStartedAt) extra.presenceStartedAt = task.extra.presenceStartedAt;
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
    const waiting = status === 'waiting' || status === 'unknown' || extra.progress && typeof extra.progress === 'object' && (extra.progress as Record<string, unknown>).phase === 'waiting-approval';
    const wasWaiting = task.status === 'waiting' || task.status === 'unknown' || task.extra.progress && typeof task.extra.progress === 'object' && (task.extra.progress as Record<string, unknown>).phase === 'waiting-approval';
    let kind: BotCompanionPresenceEvent['kind'] | undefined;
    if (terminal && status !== task.status) kind = status === 'failed' ? 'task-failed' : 'task-completed';
    else if (waiting && (!wasWaiting || extra.cancelRecoveryPaused === true && task.extra.cancelRecoveryPaused !== true)) kind = 'task-needs-attention';
    else if (status === 'running' && !extra.cancelRequested && !extra.presenceStartedAt) { kind = 'task-started'; extra.presenceStartedAt = updatedAt; }
    this.db.transaction(() => {
      this.db.prepare('UPDATE bot_tasks SET status=?,summary=?,error=?,dsh_task_id=?,session_id=?,extra_json=?,updated_at=? WHERE id=?')
      .run(status, patch.summary ?? task.summary ?? null, patch.error ?? task.error ?? null, patch.dshTaskId ?? task.dshTaskId ?? null, patch.sessionId ?? task.sessionId ?? null,
        JSON.stringify(extra), updatedAt, id);
      if (kind) this.db.prepare('INSERT INTO bot_task_presence_events(id,task_id,companion_id,conversation_id,kind,title,status,occurred_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(randomUUID(), id, task.companionId, task.conversationId, kind, String(typeof extra.title === 'string' ? extra.title : '任务').slice(0, 120), status, updatedAt);
    }).immediate();
    return this.getTask(id)!;
  }
  /** Host-only continuation after an explicit human request and mandate
   * validation. Generic late worker updates still cannot reopen a terminal. */
  reopenTask(id: string, continuation: { id: string; text: string }): BotTask {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task || !['succeeded', 'failed'].includes(task.status) || task.extra.cancelRequested || task.extra.humanStopped || task.extra.removedAt
        || this.taskSourcesWithdrawn(id)) throw new Error('任务不能由后续指导重新启动。');
      const grant = this.db.prepare("SELECT 1 FROM bot_task_mandates WHERE task_id=? AND state='active'").get(id);
      if (!grant) throw new Error('任务缺少仍有效的原始授权。');
      const extra = { ...task.extra, taskContinuation: continuation, taskContinuationId: continuation.id,
        reportBaseline: (task.extra.workerReport as { callId?: string } | undefined)?.callId ?? task.extra.reportBaseline ?? null,
        retryAt: 0, progress: { phase: 'queued', detail: '用户的后续指导已保存，沿原任务和会话继续。', updatedAt: nowIso() } };
      this.db.prepare("UPDATE bot_tasks SET status='queued',error=NULL,extra_json=?,updated_at=? WHERE id=? AND status=?")
        .run(JSON.stringify(extra), nowIso(), id, task.status);
      return this.getTask(id)!;
    }).immediate();
  }
  /** Runtime presence is a metadata projection, never a Host health request or
   * a scan of task reports, private message bodies or frozen worker inputs. */
  companionPresence(companions: readonly Pick<BotCompanion, 'id' | 'updatedAt'>[], modelConfigured: boolean, now = Date.now()): Record<string, BotCompanionPresence> {
    const tasks = this.db.prepare(`SELECT companion_id,COUNT(*) AS active_tasks,SUM(status='queued') AS queued,SUM(status='running') AS running,
      SUM(status IN ('waiting','paused') OR json_extract(extra_json,'$.progress.phase')='waiting-approval') AS waiting,
      SUM(COALESCE(json_extract(extra_json,'$.cancelRequested'),0)=1 AND COALESCE(json_extract(extra_json,'$.cancelRecoveryPaused'),0)<>1) AS stopping,
      SUM(status='paused' AND COALESCE(json_extract(extra_json,'$.cancelRequested'),0)<>1 AND COALESCE(json_extract(extra_json,'$.pauseRequested'),0)<>1) AS paused,
      SUM(status='unknown' OR COALESCE(json_extract(extra_json,'$.cancelRecoveryPaused'),0)=1 OR COALESCE(json_extract(extra_json,'$.pauseRecoveryPaused'),0)=1) AS blocked,MAX(updated_at) AS updated_at
      FROM bot_tasks WHERE status IN ('queued','running','waiting','paused','unknown') GROUP BY companion_id`).all().map(asRow);
    const inbox = this.db.prepare(`SELECT companion_id,SUM(status='running') AS replying,SUM(status='queued') AS pending_messages,MAX(received_at) AS updated_at
      FROM bot_inbox WHERE status IN ('queued','running') GROUP BY companion_id`).all().map(asRow);
    const result: Record<string, BotCompanionPresence> = {};
    for (const companion of companions) {
      const task = tasks.find(value => value.companion_id === companion.id), message = inbox.find(value => value.companion_id === companion.id);
      const counts = { activeTasks: Number(task?.active_tasks ?? 0), queued: Number(task?.queued ?? 0), running: Number(task?.running ?? 0), waiting: Number(task?.waiting ?? 0),
        stopping: Number(task?.stopping ?? 0), blocked: Number(task?.blocked ?? 0), paused: Number(task?.paused ?? 0), replying: Number(message?.replying ?? 0), pendingMessages: Number(message?.pending_messages ?? 0) };
      const events = this.db.prepare(`SELECT e.sequence,e.id,e.kind,e.task_id,e.conversation_id,e.title,e.status,e.occurred_at FROM bot_task_presence_events e
        WHERE e.companion_id=? AND EXISTS(SELECT 1 FROM bot_members m WHERE m.conversation_id=e.conversation_id AND m.member_id='user') ORDER BY e.sequence DESC LIMIT 8`).all(companion.id)
        .map(value => { const e = asRow(value); return { id: String(e.id), sequence: Number(e.sequence), kind: String(e.kind) as BotCompanionPresenceEvent['kind'], taskId: String(e.task_id), conversationId: String(e.conversation_id),
          title: String(e.title), status: String(e.status), occurredAt: String(e.occurred_at) }; });
      const lastEvent = events[0], failureExpiry = lastEvent?.kind === 'task-failed' ? Date.parse(lastEvent.occurredAt) + 600000 : 0;
      const status: BotCompanionPresence['status'] = counts.blocked ? 'needs-attention' : failureExpiry > now ? 'error' : counts.waiting ? 'waiting'
        : counts.replying ? 'replying' : counts.activeTasks ? 'working' : counts.pendingMessages ? 'waiting' : modelConfigured ? 'idle' : 'unconfigured';
      const active = this.db.prepare(`SELECT t.id,t.conversation_id,substr(json_extract(t.extra_json,'$.title'),1,120) AS title,
        substr(COALESCE(json_extract(t.extra_json,'$.progress.phase'),t.status),1,100) AS phase,t.updated_at FROM bot_tasks t
        WHERE t.companion_id=? AND t.status IN ('queued','running','waiting','paused','unknown') AND EXISTS(SELECT 1 FROM bot_members m WHERE m.conversation_id=t.conversation_id AND m.member_id='user')
      ORDER BY CASE WHEN t.status='unknown' OR json_extract(t.extra_json,'$.cancelRecoveryPaused')=1 OR json_extract(t.extra_json,'$.pauseRecoveryPaused')=1 THEN 0 WHEN t.status IN ('waiting','paused') THEN 1
          WHEN json_extract(t.extra_json,'$.cancelRequested')=1 THEN 2 WHEN t.status='running' THEN 3 ELSE 4 END,t.updated_at DESC,t.id LIMIT 1`).get(companion.id);
      const activity = active ? asRow(active) : undefined;
      result[companion.id] = { status, counts, updatedAt: [companion.updatedAt, task?.updated_at, message?.updated_at, lastEvent?.occurredAt].filter((value): value is string => typeof value === 'string').sort().at(-1)!,
        ...(status === 'error' ? { expiresAt: new Date(failureExpiry).toISOString() } : {}),
        ...(activity ? { activity: { taskId: String(activity.id), conversationId: String(activity.conversation_id), title: String(activity.title ?? '任务'), phase: String(activity.phase), updatedAt: String(activity.updated_at) } } : {}),
        ...(lastEvent ? { lastEvent, events } : {}) };
    }
    return result;
  }
  listTasks(conversationId?: string, limit = 100): BotTask[] {
    const count = bounded(limit, 100, 200);
    return (conversationId ? this.db.prepare("SELECT * FROM bot_tasks WHERE conversation_id=? AND json_extract(extra_json,'$.removedAt') IS NULL ORDER BY created_at DESC,id LIMIT ?").all(conversationId, count)
      : this.db.prepare("SELECT * FROM bot_tasks WHERE json_extract(extra_json,'$.removedAt') IS NULL ORDER BY created_at DESC,id LIMIT ?").all(count)).map(raw => this.task(raw));
  }
  getMetadata(key: string): string | undefined { const raw = this.db.prepare('SELECT value FROM bot_metadata WHERE key=?').get(key); return raw ? String(asRow(raw).value) : undefined; }
  setMetadata(key: string, value: string): void { this.db.prepare('INSERT INTO bot_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  setMetadataBatch(entries: ReadonlyArray<{ key: string; value: string }>): void {
    this.db.transaction(() => { for (const entry of entries) this.setMetadata(entry.key, entry.value); }).immediate();
  }

  /** Bounded operational diagnostics, not another long-term semantic store. */
  recordMemoryInspection(companionId: string, securityDomainId: string, report: BotMemoryRecallReport): void {
    const key = hash([companionId, securityDomainId]), serialized = JSON.stringify(report);
    if (Buffer.byteLength(serialized, 'utf8') > 512 * 1024) throw new Error('召回诊断记录超过512KiB。');
    this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO bot_memory_inspections VALUES(?,?,?,?)').run(key, report.requestId, report.createdAt, serialized);
      this.db.prepare('DELETE FROM bot_memory_inspections WHERE owner_key=? AND id NOT IN (SELECT id FROM bot_memory_inspections WHERE owner_key=? ORDER BY created_at DESC,id DESC LIMIT 20)').run(key, key);
      this.db.prepare('DELETE FROM bot_memory_inspections WHERE rowid NOT IN (SELECT rowid FROM bot_memory_inspections ORDER BY created_at DESC,id DESC LIMIT 200)').run();
    }).immediate();
  }
  memoryInspections(companionId: string, securityDomainId: string, limit = 5): BotMemoryRecallReport[] {
    return this.db.prepare('SELECT report_json FROM bot_memory_inspections WHERE owner_key=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(hash([companionId, securityDomainId]), bounded(limit, 5, 20)).map(value => JSON.parse(String(asRow(value).report_json)) as BotMemoryRecallReport);
  }
  clearMemoryInspections(companionId: string, securityDomainId: string): void {
    const key = hash([companionId, securityDomainId]);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM bot_memory_inspections WHERE owner_key=?').run(key);
      this.setMetadata(`memory-inspection-revision:${key}`, String(Number(this.memoryInspectionRevision(companionId, securityDomainId)) + 1));
    }).immediate();
  }
  memoryInspectionRevision(companionId: string, securityDomainId: string): string { return this.getMetadata(`memory-inspection-revision:${hash([companionId, securityDomainId])}`) ?? '0'; }

  memoryActivity(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>): BotMemoryActivity {
    const conversation = this.getConversation(scope.conversationId);
    if (!conversation || conversation.securityDomainId !== scope.securityDomainId || !conversation.memberIds.includes(scope.companionId)) throw new Error('记忆统计不属于当前伙伴受众。');
    const domainKey = hash([scope.companionId, scope.securityDomainId]);
    const cursor = Number(this.getMetadata('history-projection:' + hash([scope.companionId, scope.conversationId, scope.securityDomainId])) ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.historyProjectionHead(scope.conversationId)) throw new Error('原话保留游标无效。');
    const originals = asRow(this.db.prepare(`${memoryBlockedCte} SELECT
      COALESCE(SUM(CASE WHEN p.sequence<=? THEN 1 ELSE 0 END),0) AS archived,
      COALESCE(SUM(CASE WHEN p.sequence>? THEN 1 ELSE 0 END),0) AS pending
      FROM bot_history_projection p JOIN bot_messages m ON m.id=p.message_id WHERE p.conversation_id=? AND m.status='sent'
      AND NOT EXISTS(SELECT 1 FROM blocked b WHERE b.id=m.id)`).get(domainKey, scope.companionId, cursor, cursor, scope.conversationId));
    const capture = asRow(this.db.prepare(`${memoryBlockedCte} SELECT
      COALESCE(SUM(j.status='queued'),0) AS queued,COALESCE(SUM(j.status='running'),0) AS running,COALESCE(SUM(j.status='failed'),0) AS failed,
      COALESCE(SUM(j.status='done' AND json_type(r.value,'$.notes')='integer' AND json_extract(r.value,'$.notes')=0),0) AS empty,
      COALESCE(SUM(j.status='done' AND json_type(r.value,'$.notes')='integer' AND json_extract(r.value,'$.notes')>0),0) AS with_notes,
      COALESCE(SUM(j.status='done' AND (r.value IS NULL OR json_type(r.value,'$.notes') IS NOT 'integer' OR json_extract(r.value,'$.notes')<0)),0) AS unknown_done
      FROM bot_memory_jobs j JOIN bot_inbox e ON e.id=json_extract(j.payload_json,'$.sourceEventId')
      LEFT JOIN bot_metadata r ON r.key='memory-capture-result:'||j.id AND json_valid(r.value)
      WHERE j.domain_key=? AND j.kind='capture' AND e.companion_id=? AND e.conversation_id=? AND e.domain_id=? AND e.source='user' AND e.status='done'
      AND (COALESCE(json_extract(j.payload_json,'$.policyVersion'),1)>=2 OR NOT EXISTS(
        SELECT 1 FROM bot_memory_jobs upgraded WHERE upgraded.domain_key=j.domain_key AND upgraded.kind='capture'
        AND json_extract(upgraded.payload_json,'$.sourceEventId')=e.id AND json_extract(upgraded.payload_json,'$.policyVersion')=2))
      AND NOT EXISTS(SELECT 1 FROM blocked b WHERE b.id IN(e.id,e.source_record_id,e.reply_message_id))`)
      .get(domainKey, scope.companionId, domainKey, scope.companionId, scope.conversationId, scope.securityDomainId));
    return { originals: { archived: Number(originals.archived), pending: Number(originals.pending) }, capture: { queued: Number(capture.queued), running: Number(capture.running),
      failed: Number(capture.failed), empty: Number(capture.empty), withNotes: Number(capture.with_notes), unknownDone: Number(capture.unknown_done) } };
  }
  /** A bounded policy upgrade, never replay of the original chat or DSH work.
   * Progress and new idempotent jobs commit together. Existing v2 jobs remain
   * terminal/failed when appropriate; opening the page never resets attempts. */
  enqueueLegacyCaptureBackfill(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, policyVersion: 2): { scanned: number; queued: number } {
    const conversation = this.getConversation(scope.conversationId);
    if (!conversation || conversation.securityDomainId !== scope.securityDomainId || !conversation.memberIds.includes(scope.companionId)) throw new Error('记忆补充范围无效。');
    const domainKey = hash([scope.companionId, scope.securityDomainId]), cursorKey = `memory-capture-backfill:v${policyVersion}:` + hash([scope.companionId, scope.conversationId, scope.securityDomainId]);
    return this.db.transaction(() => {
      if (this.getMetadata(`memory-capture-backfill-v2-suppressed:${domainKey}`)) return { scanned: 0, queued: 0 };
      if (this.db.prepare("SELECT 1 FROM bot_memory_jobs WHERE domain_key=? AND kind='capture' AND status IN ('queued','running') LIMIT 1").get(domainKey)) return { scanned: 0, queued: 0 };
      const cursor = Number(this.getMetadata(cursorKey) ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('记忆提炼升级游标无效。');
      const rows = this.db.prepare("SELECT * FROM bot_memory_jobs WHERE domain_key=? AND kind='capture' AND status='done' AND sequence>? AND COALESCE(json_extract(payload_json,'$.policyVersion'),1)=1 ORDER BY sequence LIMIT 24").all(domainKey, cursor);
      let queued = 0;
      for (const raw of rows) {
        const job = this.memoryJob(raw), payload = job.payload, source = typeof payload.sourceEventId === 'string' ? this.getEvent(payload.sourceEventId) : undefined;
        const messages = Array.isArray(payload.messages) ? payload.messages : undefined;
        if (source?.source === 'user' && source.status === 'done' && source.companionId === scope.companionId && source.conversationId === scope.conversationId
          && source.securityDomainId === scope.securityDomainId && source.aclRevision === conversation.revision && messages && typeof payload.answer === 'string') {
          const sourceIds = [source.id, source.sourceMessageRecordId, source.replyMessageId, ...messages.flatMap(message => message && typeof message === 'object' && 'id' in message && typeof message.id === 'string' ? [message.id] : [])];
          if (!this.withdrawnIn(scope.companionId, scope.securityDomainId, sourceIds).size) {
            const key = `capture:v${policyVersion}:${source.id}`, id = `memory-${hash(['capture', key])}`;
            if (!this.getMemoryJob(id)) { this.enqueueMemoryJob({ key, kind: 'capture', payload: { ...payload, scope, policyVersion } }); queued++; }
          }
        }
        this.setMetadata(cursorKey, String(asRow(raw).sequence));
      }
      return { scanned: rows.length, queued };
    }).immediate();
  }

  /** Jobs retain exact per-request preprocessing metadata, independently of chat completion. */
  enqueueMemoryJob(input: BotMemoryJobInput): BotMemoryJob {
    const wire = JSON.stringify(input.payload);
    if (Buffer.byteLength(wire, 'utf8') > 2 * 1024 * 1024) throw new Error('记忆作业载荷超过2MB。');
    const id = input.id ?? (input.key ? `memory-${hash([input.kind, input.key])}` : randomUUID()), payloadHash = hash([wire]);
    const scope = input.payload.scope && typeof input.payload.scope === 'object' && !Array.isArray(input.payload.scope)
      ? input.payload.scope as Record<string, unknown> : {};
    const domainKey = hash([String(scope.companionId ?? ''), String(scope.securityDomainId ?? scope.conversationId ?? '')]);
    const previous = this.db.prepare('SELECT * FROM bot_memory_jobs WHERE id=?').get(id);
    if (previous) {
      const row = asRow(previous);
      if (row.payload_hash !== payloadHash || row.kind !== input.kind) throw new Error('同一记忆作业标识对应不同载荷。');
      return this.memoryJob(row);
    }
    const stamp = nowIso();
    this.db.prepare('INSERT INTO bot_memory_jobs(id,kind,domain_key,payload_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, input.kind, domainKey, wire, payloadHash, 'queued', stamp, stamp);
    return this.getMemoryJob(id)!;
  }
  getMemoryJob(id: string): BotMemoryJob | undefined {
    const raw = this.db.prepare('SELECT * FROM bot_memory_jobs WHERE id=?').get(id); return raw ? this.memoryJob(raw) : undefined;
  }
  private memoryJob(raw: unknown): BotMemoryJob {
    const r = asRow(raw); return { id: String(r.id), kind: String(r.kind) as BotMemoryJob['kind'], domainKey: String(r.domain_key),
      payload: JSON.parse(String(r.payload_json)), status: String(r.status) as BotMemoryJob['status'], attempts: Number(r.attempts),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at), error: optional(r.error) };
  }
  listPendingMemory(limit = 50): BotMemoryJob[] {
    return this.db.prepare("SELECT * FROM bot_memory_jobs WHERE status IN ('queued','running','failed') ORDER BY sequence LIMIT ?")
      .all(bounded(limit, 50, 200)).map(raw => this.memoryJob(raw));
  }
  claimMemoryJob(input: { workerId: string; leaseMs?: number; now?: number }): BotMemoryJobClaim | undefined {
    const now = input.now ?? Date.now(), leaseUntil = now + bounded(input.leaseMs, 120000, 600000);
    return this.db.transaction(() => {
      this.db.prepare("UPDATE bot_memory_jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
      const slot = Number(this.getMetadata('memory-job-fair-slot') ?? 0) % 4;
      const preferred = ['response', 'projection', 'response', 'capture'][slot]!;
      const raw = this.db.prepare(`SELECT j.* FROM bot_memory_jobs j WHERE j.status='queued' AND j.available_at<=?
        AND NOT EXISTS(SELECT 1 FROM bot_memory_jobs active WHERE active.domain_key=j.domain_key AND active.status='running')
        ORDER BY CASE WHEN j.kind=? OR (?='response' AND j.kind='prepare') THEN 0 ELSE 1 END,j.sequence LIMIT 1`).get(now, preferred, preferred);
      if (!raw) return;
      const job = this.memoryJob(raw), leaseToken = `${input.workerId}:${randomUUID()}`;
      this.db.prepare("UPDATE bot_memory_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?")
        .run(leaseToken, leaseUntil, nowIso(), job.id);
      this.setMetadata('memory-job-fair-slot', String((slot + 1) % 4));
      return { job: this.getMemoryJob(job.id)!, leaseToken, leaseUntil };
    }).immediate();
  }
  heartbeatMemoryJob(id: string, leaseToken: string, leaseMs = 120000): boolean {
    return !!this.db.prepare("UPDATE bot_memory_jobs SET lease_until=? WHERE id=? AND lease_token=? AND status='running'")
      .run(Date.now() + bounded(leaseMs, 120000, 600000), id, leaseToken).changes;
  }
  settleMemoryJob(input: { id: string; leaseToken: string; status: 'done' | 'failed' | 'retry'; error?: string; retryDelayMs?: number; metadata?: ReadonlyArray<{ key: string; value: string }> }): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE bot_memory_jobs SET status=?,error=?,available_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'")
        .run(input.status === 'retry' ? 'queued' : input.status, input.error?.slice(0, 4000) ?? null, Date.now() + Math.max(0, input.retryDelayMs ?? 1000), nowIso(), input.id, input.leaseToken).changes;
      if (!changed) return false;
      for (const entry of input.metadata ?? []) this.setMetadata(entry.key, entry.value);
      return true;
    }).immediate();
  }
}
