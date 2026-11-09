import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { isBotParticipantRequest } from './participant-request';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import { BOT_PERSONA_TEMPLATE_LIMIT, BOT_WORKER_CONCURRENCY_DEFAULT, botWorkerConcurrencySchema, type BotReplyPart, type BotConversationActivity, type BotHistoryFilter, type BotReplyTiming, type BotCompanionPresence, type BotPersonaTemplate, type BotPersonaTemplateList, type BotPersonaTemplateSummary } from '../../shared/companion-bot';
import { builtinBotPersonaTemplates } from '../../shared/builtin-bot-personas';
import { originalBuiltinBotPersona } from '../../shared/builtin-bot-companions';
import type { BotMemoryActivity, BotMemoryRecallReport } from '../../shared/companion-bot-memory';
import { botMessageEvidence } from '../../shared/bot-message-content';
import { BotActivityBudget, BotActivityLimitError, BotBackpressureError, isInteractiveBotSource, type BotActivityBudgetPolicy } from './activity-budget';
import { routeGroupAttention, GROUP_CANDIDATE_LIMIT, GROUP_REPLY_LIMIT, GROUP_DISCUSSION_MS, isGroupStop, type GroupRouting } from './group-attention';
import type { BotClaim, BotCompanion, BotConversation, BotConversationKind, BotEnqueueInput, BotEvent,
  BotEventStatus, BotLane, BotMemoryJob, BotMemoryJobClaim, BotMemoryJobInput, BotMessage, BotMessagePage, BotSenderType, BotAttachmentGrant } from './types';

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
// Task-service messages remain in the UI journal, but are private machine
// delivery to the task owner, not a publication to every room participant.
// A normal companion reply/file publication uses its own message and stays
// readable by the room. Neither matching room membership nor a shared DSH
// process grants access to another actor's internal Worker receipt.
const internalTaskMessageSql = `(m.sender_id='task-service' OR m.kind IN ('task_done','task_progress')
  OR EXISTS(SELECT 1 FROM bot_inbox source WHERE source.source_record_id=m.id AND source.source='task'))`;
const companionMessageVisibilitySql = `EXISTS(SELECT 1 FROM bot_members member WHERE member.conversation_id=m.conversation_id AND member.member_id=?)
  AND (NOT ${internalTaskMessageSql} OR EXISTS(SELECT 1 FROM bot_inbox own LEFT JOIN bot_tasks task ON task.id=json_extract(own.payload_json,'$.taskId')
    WHERE own.source_record_id=m.id AND own.source='task' AND own.companion_id=?
    AND (json_type(own.payload_json,'$.taskId') IS NULL OR task.companion_id=? AND task.conversation_id=m.conversation_id)))`;
const memoryBlockedCte = `WITH audience(domain_key,companion_id) AS(VALUES(?,?)),blocked(id) AS(
  SELECT w.source_id FROM bot_withdrawn_sources w,audience a WHERE w.domain_key=a.domain_key
  UNION SELECT w.source_id FROM bot_private_notice_exclusions w,audience a WHERE w.domain_key=a.domain_key
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
export interface BotHistoryProjectionRow { projectionSequence: number; timestamp: number; message: BotMessage;suppressed?:boolean }
export interface BotGroupAdminChange { conversation:BotConversation; eventIds:string[] }
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
  constructor(readonly filename: string, options: { activityBudget?: Partial<BotActivityBudgetPolicy> } = {}) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    const Database = BetterSqlite3 as { new(filename: string): Connection };
    this.db = new Database(filename);
    this.db.function('bot_history_has_link', { deterministic: true }, historyHasLink);
    try { this.activityBudget = new BotActivityBudget(this, options.activityBudget); } catch (error) { this.db.close(); throw error; }
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > 21) { this.db.close(); throw new Error('伙伴数据库来自更高版本，拒绝降级打开。'); }
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
      CREATE TABLE IF NOT EXISTS bot_native_topics(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES bot_conversations(id),acl_revision INTEGER NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_native_topics_page ON bot_native_topics(conversation_id,updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS bot_topic_events(event_id TEXT PRIMARY KEY REFERENCES bot_inbox(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL,topic_id TEXT NOT NULL REFERENCES bot_native_topics(id));
      CREATE INDEX IF NOT EXISTS bot_topic_events_topic ON bot_topic_events(topic_id,event_id);
      CREATE TABLE IF NOT EXISTS bot_topic_bindings(topic_id TEXT NOT NULL REFERENCES bot_native_topics(id),conversation_id TEXT NOT NULL,companion_id TEXT NOT NULL,native_lane_id TEXT NOT NULL,lane_epoch INTEGER NOT NULL,PRIMARY KEY(topic_id,companion_id));
      CREATE UNIQUE INDEX IF NOT EXISTS bot_topic_bindings_native ON bot_topic_bindings(native_lane_id);
      CREATE TABLE IF NOT EXISTS bot_guidance(message_id TEXT NOT NULL,event_id TEXT NOT NULL,conversation_id TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,error TEXT,PRIMARY KEY(message_id,event_id));
      CREATE INDEX IF NOT EXISTS bot_guidance_event ON bot_guidance(event_id,status,message_id);
      CREATE TABLE IF NOT EXISTS bot_topic_title_sync(topic_id TEXT NOT NULL,conversation_id TEXT NOT NULL,native_lane_id TEXT NOT NULL,companion_id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(topic_id,native_lane_id));
      CREATE INDEX IF NOT EXISTS bot_topic_title_ready ON bot_topic_title_sync(status,retry_at);
      CREATE TABLE IF NOT EXISTS bot_reply_parts(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL,event_id TEXT NOT NULL,conversation_id TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,payload_json TEXT NOT NULL,publication_id TEXT,UNIQUE(message_id,id));
      CREATE INDEX IF NOT EXISTS bot_reply_parts_order ON bot_reply_parts(message_id,sequence,ordinal);
      CREATE UNIQUE INDEX IF NOT EXISTS bot_reply_parts_publication ON bot_reply_parts(publication_id) WHERE publication_id IS NOT NULL;
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
      CREATE TABLE IF NOT EXISTS bot_private_notice_exclusions(domain_key TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(domain_key,source_id));
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
        const row = asRow(raw), task = { id: String(row.id), companionId: String(row.companion_id) }, source = this.getEvent(String(row.source_event_id)); if (!source) continue;
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
      if (version < 18) this.db.pragma('user_version = 18');
    }).immediate(); } catch (error) { this.db.close(); throw error; }
    if (version < 19) {
      try { this.db.transaction(() => {
        if (!this.db.prepare('PRAGMA table_info(bot_companions)').all().some(raw => asRow(raw).name === 'worker_concurrency'))
          this.db.exec(`ALTER TABLE bot_companions ADD COLUMN worker_concurrency INTEGER NOT NULL DEFAULT ${BOT_WORKER_CONCURRENCY_DEFAULT}
            CHECK(worker_concurrency BETWEEN 1 AND 32 AND worker_concurrency=CAST(worker_concurrency AS INTEGER))`);
        this.db.pragma('user_version = 19');
      }).immediate(); } catch (error) { this.db.close(); throw error; }
    }
    if (version < 20) this.db.pragma('user_version = 20');
    if(version<21)this.db.transaction(()=>{
      for(const [name,definition] of [['pinned','INTEGER NOT NULL DEFAULT 0'],['favorite','INTEGER NOT NULL DEFAULT 0'],['name_revision','INTEGER NOT NULL DEFAULT 0'],['activity_at',"TEXT NOT NULL DEFAULT ''"]]){
        if(!this.db.prepare('PRAGMA table_info(bot_native_topics)').all().some(row=>asRow(row).name===name))this.db.exec(`ALTER TABLE bot_native_topics ADD COLUMN ${name} ${definition}`);
      }
      this.db.prepare("UPDATE bot_native_topics SET activity_at=updated_at WHERE activity_at=''").run();
      this.db.exec('CREATE INDEX IF NOT EXISTS bot_topics_recent ON bot_native_topics(conversation_id,acl_revision,pinned DESC,activity_at DESC,id DESC);CREATE INDEX IF NOT EXISTS bot_topics_favorites ON bot_native_topics(conversation_id,acl_revision,favorite,pinned DESC,activity_at DESC,id DESC)');
      this.db.pragma('user_version = 21');
    }).immediate();
  }

  close(): void { this.db.close(); }
  nativeLaneCompanion(nativeLaneId:string):string|undefined{
    if(nativeLaneId.startsWith('turn-'))return this.getEvent(nativeLaneId.slice(5))?.companionId;
    const binding=this.db.prepare('SELECT companion_id FROM bot_topic_bindings WHERE native_lane_id=?').get(nativeLaneId) as {companion_id:string}|undefined;
    return binding?.companion_id??this.getLane(nativeLaneId)?.companionId;
  }
  /** Shared SQL transaction; callbacks must be synchronous and perform no native/network I/O. */
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
  /** Host-only lineage projection. Looking up a grant does not create one. */
  attachmentGrantSourceIds(grantIds: string[]): string[] {
    if (!Array.isArray(grantIds) || grantIds.length > 1024 || grantIds.some(id => typeof id !== 'string' || !id || id.length > 200 || id.includes('\0'))) throw new Error('附件授权来源标识无效。');
    return [...new Set(grantIds.flatMap(id => this.grantSources(id)))];
  }
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
  createCompanion(input: { id?: string; name: string; persona: string; workerConcurrency?: number }): BotCompanion {
    const id = input.id ? text(input.id, '伙伴标识', 200) : randomUUID(), stamp = nowIso();
    const name = text(input.name, '伙伴名称', 100), persona = personaPrompt(input.persona);
    const workerConcurrency = botWorkerConcurrencySchema.parse(input.workerConcurrency ?? BOT_WORKER_CONCURRENCY_DEFAULT);
    return this.db.transaction(() => {
      this.db.prepare('INSERT INTO bot_companions(id,name,persona,created_at,updated_at,worker_concurrency) VALUES(?,?,?,?,?,?)').run(id, name, persona, stamp, stamp, workerConcurrency);
      this.seedPersonaTemplates(id, persona); return this.getCompanion(id)!;
    }).immediate();
  }
  getCompanion(id: string): BotCompanion | undefined {
    const raw = this.db.prepare('SELECT c.*,p.active_id FROM bot_companions c LEFT JOIN bot_persona_settings p ON p.companion_id=c.id WHERE c.id=?').get(id); if (!raw) return;
    const r = asRow(raw); return { id: String(r.id), name: String(r.name), persona: String(r.persona), createdAt: String(r.created_at), updatedAt: String(r.updated_at), activePersonaId: optional(r.active_id), enabled: this.getMetadata(`companion-enabled:${id}`) !== '0', workerConcurrency: Number(r.worker_concurrency) };
  }
  workerConcurrency(id: string): number {
    const record = this.db.prepare('SELECT worker_concurrency FROM bot_companions WHERE id=?').get(id);
    return record ? Number(asRow(record).worker_concurrency) : BOT_WORKER_CONCURRENCY_DEFAULT;
  }
  setCompanionEnabled(id: string, enabled: boolean): void {
    if (!this.getCompanion(id) || this.isRetiredDevelopmentDefault(id)) throw new Error('伙伴不存在。');
    this.setMetadata(`companion-enabled:${id}`, enabled ? '1' : '0');
  }
  listCompanions(): BotCompanion[] { return this.db.prepare('SELECT id FROM bot_companions ORDER BY created_at,id').all().map(raw => this.getCompanion(String(asRow(raw).id))!).filter(companion => !this.isRetiredDevelopmentDefault(companion.id)); }
  isRetiredDevelopmentDefault(id: string): boolean { return id === developmentDefault && !!this.getMetadata(defaultCleanupKey); }
  developmentDefaultCleanup(): BotDevelopmentDefaultCleanup | undefined {
    const saved = this.getMetadata(defaultCleanupKey); return saved ? JSON.parse(saved) as BotDevelopmentDefaultCleanup : undefined;
  }
  updateCompanion(id: string, input: { name: string; persona?: string; workerConcurrency?: number }): BotCompanion {
    if (this.isRetiredDevelopmentDefault(id)) throw new Error('旧开发伙伴已退休。');
    const name = text(input.name, '伙伴名称', 100), prompt = input.persona === undefined ? undefined : personaPrompt(input.persona);
    const workerConcurrency = input.workerConcurrency === undefined ? undefined : botWorkerConcurrencySchema.parse(input.workerConcurrency);
    return this.db.transaction(() => {
      const companion = this.requirePersonaCompanion(id), stamp = nowIso();
      if (prompt !== undefined) {
        this.db.prepare('UPDATE bot_persona_templates SET prompt=?,updated_at=? WHERE companion_id=? AND id=? AND deleted=0').run(prompt, stamp, id, companion.activePersonaId!);
        this.db.prepare('UPDATE bot_companions SET name=?,persona=?,updated_at=? WHERE id=?').run(name, prompt, stamp, id);
      } else this.db.prepare('UPDATE bot_companions SET name=?,updated_at=? WHERE id=?').run(name, stamp, id);
      if (workerConcurrency !== undefined) this.db.prepare('UPDATE bot_companions SET worker_concurrency=? WHERE id=?').run(workerConcurrency, id);
      return this.getCompanion(id)!;
    }).immediate();
  }
  private seedPersonaTemplates(companionId: string, currentPrompt: string): void {
    const stamp = nowIso(), builtins = builtinBotPersonaTemplates(companionId);
    const defaults = builtins.length ? builtins : [{ id: 'default', name: '默认人格', prompt: currentPrompt }];
    for (const item of defaults) {
      const previous = this.db.prepare('SELECT name,prompt,original_name,original_prompt,deleted,builtin FROM bot_persona_templates WHERE companion_id=? AND id=?').get(companionId, item.id) as Row | undefined;
      this.db.prepare(`INSERT OR IGNORE INTO bot_persona_templates(companion_id,id,name,prompt,builtin,original_name,original_prompt,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(companionId, item.id, item.name, item.prompt, Number(!!builtins.length), item.name, item.prompt, stamp, stamp);
      if (builtins.length) {
        // Refresh authored defaults only when their exact saved bytes still
        // match the previous original. Preserve edited names, prompts, active
        // custom templates and deleted-template tombstones independently.
        if (previous?.builtin && !previous.deleted) {
          const inheritPrompt = previous.prompt === previous.original_prompt && previous.prompt !== item.prompt;
          const inheritName = previous.name === previous.original_name && previous.name !== item.name;
          if (inheritPrompt || inheritName) this.db.prepare('UPDATE bot_persona_templates SET name=?,prompt=?,updated_at=? WHERE companion_id=? AND id=?')
            .run(inheritName ? item.name : previous.name, inheritPrompt ? item.prompt : previous.prompt, stamp, companionId, item.id);
          if (inheritPrompt) this.db.prepare(`UPDATE bot_companions SET persona=?,updated_at=? WHERE id=? AND persona=?
            AND EXISTS(SELECT 1 FROM bot_persona_settings WHERE companion_id=? AND active_id=?)`)
            .run(item.prompt, stamp, companionId, previous.prompt, companionId, item.id);
        }
        this.db.prepare('UPDATE bot_persona_templates SET original_name=?,original_prompt=? WHERE companion_id=? AND id=? AND builtin=1')
          .run(item.name, item.prompt, companionId, item.id);
      }
    }
    if (this.db.prepare('SELECT 1 FROM bot_persona_settings WHERE companion_id=?').get(companionId)) return;
    const exact = defaults.find(item => item.prompt === currentPrompt), historical = originalBuiltinBotPersona(companionId);
    const inherited = !exact && historical !== undefined && currentPrompt === historical ? defaults.find(item => item.id === 'default') : undefined;
    let activeId = exact?.id ?? inherited?.id ?? 'default';
    if (inherited) this.db.prepare('UPDATE bot_companions SET persona=?,updated_at=? WHERE id=? AND persona=?')
      .run(inherited.prompt, stamp, companionId, currentPrompt);
    if (!exact && !inherited) {
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
  createGroup(input: { title: string; memberIds: string[]; kind?: BotConversationKind; includeUser?: boolean; participationMode?: 'automatic' | 'all' | 'mentions'; reuseMembers?: boolean }): BotConversation {
    const kind = input.kind ?? 'group';
    if (kind === 'peer') throw new Error('伙伴私聊必须由固定双方入口创建。');
    const members = [...new Set([...(kind === 'group' || input.includeUser !== false ? ['user'] : []), ...input.memberIds])].sort();
    if (!members.some(id => id !== 'user')) throw new Error('会话至少需要一位伙伴。');
    for (const id of members) if (id !== 'user' && (!this.getCompanion(id) || this.isRetiredDevelopmentDefault(id))) throw new Error('会话成员不存在。');
    return this.db.transaction(() => {
      if (kind === 'group' && input.reuseMembers !== false) {
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
  contactPeer(source: BotEvent, targetId: string, callId: string, content: string, destination: 'user' | 'peer' = 'peer', transfer?: { attachments: BotMediaRef[]; sourceIds: string[] }) {
    if (!['user', 'peer'].includes(destination)) throw new Error('转达目的地必须为 user 或 peer。');
    const requestRoom = this.getConversation(source.conversationId);
    if (!requestRoom || !isBotParticipantRequest(source, requestRoom)) throw new Error('联系其他聊天中的伙伴需要有效的用户或伙伴请求。');
    if (targetId === source.companionId || this.isRetiredDevelopmentDefault(targetId)) throw new Error('请选择另一位可用伙伴。');
    const sender = this.getCompanion(source.companionId), target = this.getCompanion(targetId);
    if (!sender || !target) throw new Error('伙伴不存在。');
    const attachments = transfer?.attachments ?? [], additionalSources = transfer?.sourceIds ?? [];
    if (!Array.isArray(attachments) || !Array.isArray(additionalSources) || additionalSources.length > 4096 || additionalSources.some(id => typeof id !== 'string' || !id || id.length > 200 || id.includes('\0'))) throw new Error('转达附件或授权来源无效。');
    const transferSources = [...new Set([source.id, source.sourceMessageRecordId, ...additionalSources])].sort();
    const transferFingerprint = hash([JSON.stringify(attachments), JSON.stringify(transferSources)]);
    if (this.withdrawnIn(source.companionId, source.securityDomainId, [...this.eventSourceIds(source.id), ...additionalSources]).size) throw new Error('转达来源已撤回。');
    return this.db.transaction(() => {
      const receiptKey = `peer-contact-receipt:${source.id}:${callId}`, priorReceipt = this.getMetadata(receiptKey);
      if (priorReceipt) {
        const receipt = JSON.parse(priorReceipt) as { recipientId: string; conversationId: string; messageId: string; fingerprint?: string; transferFingerprint?: string };
        if (receipt.recipientId !== targetId || receipt.fingerprint && receipt.fingerprint !== hash([targetId, destination, content])) throw new Error('同一转达标识对应不同伙伴、目的地或内容。');
        if (receipt.transferFingerprint ? receipt.transferFingerprint !== transferFingerprint : attachments.length > 0 || additionalSources.length > 0) throw new Error('同一转达标识对应不同附件或授权来源。');
        return { accepted: true as const, conversationId: receipt.conversationId, message: this.getMessage(receipt.messageId)!, events: [] as BotEvent[] };
      }
      const sourceRoom = this.getConversation(source.conversationId);
      if (!sourceRoom || sourceRoom.dissolvedAt || sourceRoom.revision !== source.aclRevision || !sourceRoom.memberIds.includes(source.companionId)) throw new Error('转达来源权限已经变化。');
      const room = this.openPeer(sender.id, target.id);
      const result = this.tryEnqueueAutomatic({ conversationId: room.id, source: 'companion', senderId: sender.id, recipientIds: [targetId],
        content: text(content, '转达内容', 8000), sourceMessageId: `peer-contact:${source.id}:${callId}`, correlationId: source.correlationId, causationId: source.id,
        payload: { hop: source.source === 'user' ? 1 : Number(source.payload.hop ?? 0) + 1, userRequestedContact: true, contactRequester: source.senderType === 'companion' ? 'companion' : 'user', originalSenderName: source.senderName, responseDestination: destination === 'user' ? 'user-direct' : 'peer' }, attachments, sourceIds: transferSources });
      if (result.accepted && destination === 'user') for (const event of result.events) this.setMetadata(`peer-user-reply-grant:${event.id}`,
        JSON.stringify({ sourceEventId: source.id, relayMessageId: result.message.id, peerConversationId: room.id, recipientId: target.id,
          requesterId: sender.id, correlationId: source.correlationId, sourceAclRevision: source.aclRevision }));
      if (result.accepted) for (const sourceId of new Set([...this.eventSourceIds(source.id), ...additionalSources])) this.db.prepare('INSERT OR IGNORE INTO bot_peer_bridges VALUES(?,?,?,?,?)')
        .run(source.companionId, source.securityDomainId, sourceId, room.id, result.message.id);
      if (result.accepted) this.setMetadata(receiptKey, JSON.stringify({ recipientId: targetId, conversationId: room.id, messageId: result.message.id, destination, fingerprint: hash([targetId, destination, content]), transferFingerprint }));
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
      if (!origin || !originRoom || !isBotParticipantRequest(origin, originRoom) || originRoom.dissolvedAt || originRoom.revision !== grant.sourceAclRevision
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
      if(JSON.stringify([...room.memberIds].sort())===JSON.stringify(next))return{conversation:room,eventIds:[]};
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
      if(room.dissolvedAt)return{conversation:room,eventIds:[]};
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
  private revokeGroupCapabilities(room: BotConversation): Pick<BotGroupAdminChange, 'eventIds'> {
    const revision = room.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('会话权限版本超出范围。');
    this.db.prepare('UPDATE bot_conversations SET revision=? WHERE id=?').run(revision, room.id);
    this.db.prepare('UPDATE bot_lanes SET acl_revision=? WHERE conversation_id=?').run(revision, room.id);
    const eventIds = this.db.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND status IN ('queued','running')").all(room.id).map(raw => String(asRow(raw).id));
    for (const id of eventIds) this.cancelEvent(id);
    return { eventIds };
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
    const actors = conversation.memberIds.filter(id => id !== 'user' && id !== senderId).map(id => this.getCompanion(id)!).filter(actor => actor && actor.enabled !== false);
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
          AND NOT EXISTS(SELECT 1 FROM bot_reply_parts part WHERE part.publication_id=latest.id)
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
      // Native VCP acknowledgement can repeat exact audience exclusions. Do
      // not promote those exclusions into a normal recursive user withdrawal.
      const normalized = new Set(sourceIds.filter(id => !this.db.prepare('SELECT 1 FROM bot_withdrawn_sources WHERE domain_key=? AND source_id=?').get(key, id)
        && !this.db.prepare('SELECT 1 FROM bot_private_notice_exclusions WHERE domain_key=? AND source_id=?').get(key, id))), pending = [...normalized];
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
  /** Compatibility repair for an internal receipt copied into the wrong
   * actor's history. Exclude only that message, not the owner's later public
   * answer/files, which may legitimately cite the same machine source. This
   * uses a separate exact table so all ordinary source withdrawal joins keep
   * their existing recursive semantics. The normal VCP outbox remains durable. */
  withdrawPrivateNoticeSources(companionId: string, securityDomainId: string, sourceIds: readonly string[]): number {
    const key = hash([companionId, securityDomainId]);
    return this.db.transaction(() => {
      let changes = 0;
      for (const id of new Set(sourceIds)) {
        const privateNotice = this.db.prepare(`SELECT m.id FROM bot_messages m JOIN bot_conversations c ON c.id=m.conversation_id
          WHERE m.id=? AND c.domain_id=? AND ${internalTaskMessageSql}`).get(id, securityDomainId);
        if (!privateNotice || this.isMessageVisibleToCompanion(id, companionId)) throw new Error('定向受众隔离仅能处理本伙伴不可读的内部任务回执。');
        changes += this.db.prepare('INSERT OR IGNORE INTO bot_private_notice_exclusions VALUES(?,?)').run(key, text(id, '私有回执来源', 500)).changes;
        this.db.prepare('INSERT OR IGNORE INTO bot_source_withdraw_outbox(domain_key,message_id) VALUES(?,?)').run(key, id);
      }
      if (changes) this.rotateDomainState(companionId, securityDomainId);
      return changes;
    }).immediate();
  }
  isPrivateNoticeSourceExcluded(companionId: string, securityDomainId: string, sourceId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bot_private_notice_exclusions WHERE domain_key=? AND source_id=?')
      .get(hash([companionId, securityDomainId]), sourceId);
  }
  withdrawnIn(companionId: string, securityDomainId: string, ids: readonly string[]): Set<string> {
    if (!ids.length) return new Set();
    const key = hash([companionId, securityDomainId]);
    return new Set(this.db.prepare(`WITH requested(id) AS(VALUES ${ids.map(() => '(?)').join(',')}) SELECT r.id FROM requested r
      WHERE EXISTS(SELECT 1 FROM bot_withdrawn_sources w WHERE w.domain_key=? AND w.source_id=r.id)
      OR EXISTS(SELECT 1 FROM bot_private_notice_exclusions w WHERE w.domain_key=? AND w.source_id=r.id)
      OR EXISTS(SELECT 1 FROM bot_publications p JOIN bot_withdrawn_sources w ON w.source_id=p.event_id AND w.domain_key=? WHERE p.message_id=r.id)
      OR EXISTS(SELECT 1 FROM bot_inbox i JOIN bot_withdrawn_sources w ON w.source_id=i.id AND w.domain_key=? WHERE i.companion_id=? AND (i.source_record_id=r.id OR i.reply_message_id=r.id))
      OR EXISTS(SELECT 1 FROM bot_message_sources s JOIN bot_withdrawn_sources w ON w.source_id=s.source_id AND w.domain_key=? WHERE s.message_id=r.id)`)
      .all(...ids, key, key, key, key, companionId, key).map(raw => String(asRow(raw).id)));
  }
  withdrawnMessagesPage(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, options: { after?: number; limit?: number } = {}): { items: Array<{ messageId: string; eventIds: string[]; sequence: number; exactPrivateNotice?: true }>; hasMore: boolean; nextAfter?: number } {
    const key = hash([scope.companionId, scope.securityDomainId]), limit = bounded(options.limit, 100, 200);
    const found = this.db.prepare(`SELECT m.id,w.sequence FROM bot_source_withdraw_outbox w JOIN bot_messages m ON m.id=w.message_id WHERE w.domain_key=? AND m.conversation_id=? AND w.sequence>? ORDER BY w.sequence LIMIT ?`)
      .all(key, scope.conversationId, options.after ?? 0, limit + 1);
    const items = found.slice(0, limit).map(raw => ({ messageId: String(asRow(raw).id), sequence: Number(asRow(raw).sequence),
      ...(this.isPrivateNoticeSourceExcluded(scope.companionId, scope.securityDomainId, String(asRow(raw).id)) ? { exactPrivateNotice: true as const } : {}),
      eventIds: this.db.prepare('SELECT id FROM bot_inbox WHERE companion_id=? AND domain_id=? AND (source_record_id=? OR reply_message_id=?)').all(scope.companionId, scope.securityDomainId, asRow(raw).id, asRow(raw).id).map(value => String(asRow(value).id)) }));
    return { items, hasMore: found.length > limit, nextAfter: found.length > limit ? items.at(-1)?.sequence : undefined };
  }
  activeDomainEvents(companionId: string, securityDomainId: string): BotEvent[] {
    return this.db.prepare(`SELECT i.* FROM bot_inbox i WHERE i.companion_id=? AND i.domain_id=?
      AND (i.status='running' OR (i.status='queued' AND i.dsh_event_id IS NOT NULL))`)
      .all(companionId, securityDomainId).map(raw => this.event(raw));
  }
  rotateDomain(companionId: string, securityDomainId: string): void {
    this.db.transaction(() => this.rotateDomainState(companionId, securityDomainId)).immediate();
  }
  private rotateDomainState(companionId: string, securityDomainId: string): void {
    this.db.prepare('UPDATE bot_lanes SET epoch=epoch+1,session_id=NULL WHERE companion_id=? AND conversation_id IN(SELECT id FROM bot_conversations WHERE domain_id=?)').run(companionId, securityDomainId);
  }
  getEventNativeEpoch(eventId: string): number | undefined {
    const value = this.getMetadata(`event-native-epoch:${eventId}`); if (value === undefined) return;
    const epoch = Number(value); if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('事件原生通道绑定损坏。');
    return epoch;
  }
  /** Callbacks are fenced by the current ACL epoch; every turn owns a fresh native Session. */
  bindEventNativeEpoch(eventId: string, expectedEpoch: number): number {
    return this.db.transaction(() => {
      const event = this.getEvent(eventId), lane = event && this.getLane(event.laneId), prior = this.getEventNativeEpoch(eventId);
      if (!event || event.status !== 'running' || !lane || lane.epoch !== expectedEpoch || prior !== undefined && prior !== expectedEpoch)
        throw Object.assign(new Error('原生事件所属会话权限已变化。'), { code: 'BOT_RETENTION_STALE' });
      this.setMetadata('event-native-epoch:' + eventId, String(expectedEpoch));
      return expectedEpoch;
    }).immediate();
  }

  /** Only trusted host gateways call this method; UI requests cannot select their sender or domain. */
  enqueue(input: BotEnqueueInput): { message: BotMessage; events: BotEvent[] } {
    const attachments = input.attachments ?? [], attachmentsJson = JSON.stringify(attachments);
    if (attachments.length > 16 || attachmentsJson.length > 96000) throw new Error('每条消息最多16个附件；请拆分发送。');
    const content = attachments.length ? (typeof input.content === 'string' && input.content.length <= 128000 ? input.content.trim() : text(input.content, '消息', 128000)) : text(input.content, '消息', 128000);
    const evidence = botMessageEvidence({ content, attachments }); if (evidence.length > 128000) throw new Error('消息和附件元数据超过单条容量。');
    const source = input.source ?? (input.senderId === 'user' ? 'user' : 'companion');
    if (source === 'task') throw new Error('旧任务中心消息入口已停用。');
    const sourceInstanceId = input.sourceInstanceId ?? 'worldlinebox', sourceMessageId = input.sourceMessageId ?? randomUUID();
    const kind = input.kind ?? 'message', payloadJson = JSON.stringify(attachments.length ? { ...input.payload, attachments } : input.payload ?? {});
    if (payloadJson.length > 128000) throw new Error('事件附加数据过大。');
    const originKey = hash([sourceInstanceId, sourceMessageId, input.conversationId]);
    return this.db.transaction(() => {
      const conversation = this.getConversation(input.conversationId); if (!conversation||conversation.dissolvedAt) throw new Error('会话不存在或已经解散。');
      const serviceSource = source === 'world';
      if (!serviceSource && !conversation.memberIds.includes(input.senderId)) throw new Error('消息发送者不属于该会话。');
      if (source === 'world' && conversation.kind !== 'world') throw new Error('世界事件必须进入世界会话。');
      const sender = this.getCompanion(input.senderId);
      if (source === 'user' && input.senderId !== 'user' || source === 'companion' && !sender) throw new Error('事件来源与真实发送者不匹配。');
      const senderType: BotSenderType = sender ? 'companion' : input.senderId === 'user' ? 'user' : source === 'world' ? 'world' : 'service';
      const senderName = sender?.name ?? input.senderName ?? (input.senderId === 'user' ? '我' : source === 'world' ? '世界' : '任务');
      const prior = this.db.prepare('SELECT * FROM bot_origins WHERE origin_key=?').get(originKey);
      const priorMessage = prior ? this.getMessage(String(asRow(prior).message_id))! : undefined;
      const priorEvents = priorMessage ? this.db.prepare('SELECT * FROM bot_inbox WHERE source_record_id=? ORDER BY sequence').all(priorMessage.id).map(raw => this.event(raw)) : undefined;
      const routing = !priorEvents && conversation.kind === 'group' && source !== 'world'
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
      const sourceIds = [...new Set(input.sourceIds ?? [])];
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
      const event = this.getEvent(eventId);
      if (!event || event.status !== 'running') throw new Error('自动活动缺少有效的原生执行事件。');
      this.activityBudget.reserve(event.correlationId, 'actions', eventId + ':' + callId + ':' + kind, 1, Date.now());
    }).immediate();
  }
  tryEnqueueAutomatic(input: BotEnqueueInput): { accepted: true; message: BotMessage; events: BotEvent[] } | { accepted: false; reason: string } {
    if (!['world', 'companion', 'group'].includes(input.source ?? '')) throw Error('只有自动事件使用此投递接口。');
    try { return { accepted: true, ...this.enqueue(input) }; }
    catch (error) { if (error instanceof BotActivityLimitError || error instanceof BotBackpressureError) return { accepted: false, reason: error.message }; throw error; }
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
      this.db.prepare("UPDATE bot_messages SET status='queued' WHERE id IN(SELECT reply_message_id FROM bot_inbox WHERE status='running' AND lease_until<=?)").run(now);
      this.db.prepare("UPDATE bot_inbox SET status='queued',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
      const excluded = input.excludeLaneIds ?? [];
      const skip = (excluded.length ? ` AND i.lane_id NOT IN (${excluded.map(() => '?').join(',')})` : '')
        + (input.interactiveOnly ? " AND i.source IN ('user','task','gateway')" : '');
      // Explicit user assignments and addressed teammate work may overlap in a
      // room: a coordinator can await its worker. Autonomous discussion stays
      // serialized; lane FIFO and the per-companion guard still apply to both.
      const raw = this.db.prepare(`SELECT i.* FROM bot_inbox i JOIN bot_lanes l ON l.id=i.lane_id
        WHERE i.status='queued' AND i.available_at<=?${skip}
        AND NOT EXISTS(SELECT 1 FROM bot_metadata disabled WHERE disabled.key='companion-enabled:'||i.companion_id AND disabled.value='0')
        AND NOT EXISTS(SELECT 1 FROM bot_inbox older WHERE older.lane_id=i.lane_id AND older.sequence<i.sequence AND older.status IN ('queued','running'))
        AND NOT EXISTS(SELECT 1 FROM bot_inbox active WHERE active.lane_id=i.lane_id AND active.status='running')
        AND (i.source IN ('user','gateway') OR (i.source='companion' AND json_extract(i.payload_json,'$.directedPeer')=1) OR NOT EXISTS(SELECT 1 FROM bot_inbox room_active JOIN bot_conversations room ON room.id=room_active.conversation_id
          WHERE room_active.conversation_id=i.conversation_id AND room.kind IN ('group','peer') AND room_active.status='running'))
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
  /** Projection of verified native DSH present_files events onto the reply. */
  appendNativeArtifacts(eventId: string, leaseToken: string, attachments: BotMediaRef[]): boolean {
    return this.db.transaction(() => {
      const event = this.getEvent(eventId), room = event && this.getConversation(event.conversationId);
      if (!event || !room || event.status !== 'running' || room.revision !== event.aclRevision
        || !this.db.prepare("SELECT 1 FROM bot_inbox WHERE id=? AND lease_token=?").get(eventId, leaseToken)) return false;
      const message = this.getMessage(event.replyMessageId)!;
      const refs = [...new Map([...(message.attachments ?? []), ...attachments].map(ref => [ref.id, ref])).values()];
      this.db.prepare('UPDATE bot_messages SET attachments_json=? WHERE id=?').run(JSON.stringify(refs), message.id);
      this.bindMessageAttachments({ ...message, attachments: refs }, false, undefined, this.eventSourceIds(event.id));
      return true;
    }).immediate();
  }
  updateDraft(eventId: string, leaseToken: string, content: string): boolean {
    if (content.length > 512000) throw new Error('回复草稿过大。');
    return !!this.db.prepare("UPDATE bot_messages SET content=? WHERE id=(SELECT reply_message_id FROM bot_inbox WHERE id=? AND lease_token=? AND status='running')").run(content, eventId, leaseToken).changes;
  }
  /** Committed native text and actual media publications share one ordered
   * reply. Event/log identities make transport replay a no-op. */
  appendReplyPart(eventId:string,part:Omit<BotReplyPart,'sequence'>&{sequence?:number}):void{
    this.db.transaction(()=>{
      const event=this.getEvent(eventId),lane=event&&this.getLane(event.laneId),room=event&&this.getConversation(event.conversationId);
      if(!event||!lane||!room||event.status!=='running'||room.revision!==event.aclRevision||this.getEventNativeEpoch(eventId)!==undefined&&this.getEventNativeEpoch(eventId)!==lane.epoch)throw Error('回复片段没有当前事件授权。');
      if(!part.id||part.id.length>300||part.sequence!==undefined&&(!Number.isSafeInteger(part.sequence)||part.sequence<0))throw Error('原生回复片段身份无效。');
      const prior=this.db.prepare('SELECT payload_json FROM bot_reply_parts WHERE message_id=? AND id=?').get(event.replyMessageId,part.id) as {payload_json:string}|undefined;
      const sequence=prior?(JSON.parse(prior.payload_json) as BotReplyPart).sequence:part.sequence??Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS value FROM bot_reply_parts WHERE message_id=?').get(event.replyMessageId) as {value:number}).value);
      const value:BotReplyPart={...part,sequence},payload=JSON.stringify(value);
      if(prior){if(prior.payload_json!==payload)throw Error('同一原生片段标识对应了不同内容。');return;}
      if(part.publicationId&&!this.db.prepare('SELECT 1 FROM bot_publications WHERE event_id=? AND message_id=?').get(eventId,part.publicationId))throw Error('媒体片段缺少真实发送回执。');
      this.db.prepare('INSERT INTO bot_reply_parts(message_id,event_id,conversation_id,id,sequence,payload_json,publication_id) VALUES(?,?,?,?,?,?,?)').run(event.replyMessageId,eventId,event.conversationId,part.id,sequence,payload,part.publicationId??null);
      if(part.attachments?.length){
        const message=this.getMessage(event.replyMessageId)!,refs=[...new Map([...(message.attachments??[]),...part.attachments].map(file=>[file.id,file])).values()];
        this.db.prepare('UPDATE bot_messages SET attachments_json=? WHERE id=?').run(JSON.stringify(refs),message.id);
        this.bindMessageAttachments({...message,attachments:refs},false,undefined,this.eventSourceIds(event.id));
      }
    }).immediate();
  }
  replyParts(messageId:string):BotReplyPart[]{return this.db.prepare('SELECT payload_json FROM bot_reply_parts WHERE message_id=? ORDER BY sequence,ordinal').all(messageId).map(row=>JSON.parse(String(asRow(row).payload_json)) as BotReplyPart);}
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
      }
      const accepted = this.db.prepare("UPDATE bot_inbox SET status=?,error=?,dsh_event_id=COALESCE(?,dsh_event_id),lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='running'")
        .run(input.status, input.error ?? null, input.dshEventId ?? null, input.eventId, input.leaseToken);
      if (!accepted.changes) return false;
      this.finishReplyTiming(event);
      this.db.prepare('UPDATE bot_messages SET status=?,content=COALESCE(?,content),error=? WHERE id=?')
        .run(input.status === 'done' ? 'sent' : input.status, input.content ?? null, input.error ?? null, event.replyMessageId);
      const reply = this.getMessage(event.replyMessageId);
      const visibleReply = !!reply?.content.trim() || !!reply?.attachments?.length;
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
  continueNativeReply(messageId: string, requestId: string): string {
    return this.db.transaction(() => {
      const event=this.eventForReply(messageId),receipt='native-continue-command:'+requestId;
      if(!event)throw Error('回复不存在。');
      const previous=this.getMetadata(receipt);
      if(previous){if(previous!==event.id)throw Error('继续请求编号已被使用。');return event.conversationId;}
      const room=this.getConversation(event.conversationId),companion=this.getCompanion(event.companionId);
      if(!room||room.kind==='peer'||!room.memberIds.includes('user')||room.revision!==event.aclRevision||!companion||companion.enabled===false)throw Error('当前会话不能继续这条回复。');
      const raw=this.getMetadata('execution:'+messageId),execution=raw?JSON.parse(raw):undefined;
      if(event.status!=='failed'||!Number.isSafeInteger(execution?.continuation?.checkpoint)||execution.continuation.checkpoint<0)throw Error('这条回复没有可继续的原生进展。');
      this.setMetadata('native-output-continuation:'+event.id,JSON.stringify({checkpoint:execution.continuation.checkpoint,requestId}));
      this.db.prepare("UPDATE bot_inbox SET status='queued',lease_token=NULL,lease_until=NULL,available_at=0,error=NULL WHERE id=? AND status='failed'").run(event.id);
      this.db.prepare("UPDATE bot_messages SET status='queued',error=NULL WHERE id=?").run(messageId);
      this.setMetadata('execution:'+messageId,JSON.stringify({...execution,status:'running',continuation:undefined}));
      this.setMetadata(receipt,event.id);return event.conversationId;
    }).immediate();
  }
  private message(raw: unknown): BotMessage {
    const r = asRow(raw), attachments = JSON.parse(String(r.attachments_json ?? '[]')) as BotMediaRef[], timing = turnTiming(r.timing_json);
    const parts=this.replyParts(String(r.id));
    return { id: String(r.id), eventId: String(r.event_id), conversationId: String(r.conversation_id), senderId: String(r.sender_id),
      senderName: String(r.sender_name), senderType: String(r.sender_type) as BotSenderType, content: String(r.content), status: String(r.status) as BotMessage['status'],
      sequence: Number(r.sequence), kind: String(r.kind) as BotMessage['kind'], correlationId: String(r.correlation_id), createdAt: String(r.created_at), error: optional(r.error), ...(attachments.length ? { attachments } : {}),
      ...(timing.elapsedMs !== undefined ? { timing: timing as BotReplyTiming } : {}),
      ...(parts.length?{parts}:{}),
    };
  }
  publishForEvent(eventId: string, callId: string, input: { content?: string; attachments: BotMediaRef[]; attachmentGrants?: BotAttachmentGrant[]; sourceIds?: string[] }): BotMessage {
    return this.publishMedia(eventId, callId, input);
  }
  private publishMedia(eventId: string, callId: string, input: { content?: string; attachments: BotMediaRef[]; attachmentGrants?: BotAttachmentGrant[]; sourceIds?: string[] }): BotMessage {
    // Preserve the old non-task publication fingerprint for replay after upgrading.
    const fingerprint = hash([input.content ?? '', JSON.stringify(input.attachments), '']);
    return this.db.transaction(() => {
      const event = this.getEvent(eventId), lane = event && this.getLane(event.laneId), conversation = event && this.getConversation(event.conversationId);
      if (!event || !lane || !conversation || conversation.revision !== event.aclRevision || !conversation.memberIds.includes(event.companionId)
        || this.withdrawnIn(event.companionId, event.securityDomainId, [event.id]).has(event.id) || event.status !== 'running'
        || this.getEventNativeEpoch(eventId) !== undefined && this.getEventNativeEpoch(eventId) !== lane.epoch) throw new Error('发送媒体缺少当前有效的原生事件授权。');
      if (!callId || callId.length > 300 || !input.attachments.length) throw new Error('媒体发送回执无效。');
      const previous = this.db.prepare('SELECT * FROM bot_publications WHERE event_id=? AND call_id=?').get(eventId, callId);
      if (previous) { if (asRow(previous).fingerprint !== fingerprint) throw new Error('同一媒体发送标识对应其他内容。'); return this.getMessage(String(asRow(previous).message_id))!; }
      const { message } = this.enqueue({ conversationId: event.conversationId, senderId: event.companionId, source: 'companion', sourceInstanceId: 'bot-publication-v1',
        sourceMessageId: eventId + ':' + callId, content: input.content ?? '', attachments: input.attachments, attachmentGrants: input.attachmentGrants,
        sourceIds: [...new Set([...this.eventSourceIds(event.id), ...(input.sourceIds ?? [])])], recipientIds: [], correlationId: event.correlationId, causationId: event.id });
      this.db.prepare('INSERT INTO bot_publications(event_id,call_id,message_id,fingerprint) VALUES(?,?,?,?)').run(eventId, callId, message.id, fingerprint);
      this.enqueueMemoryJob({ key: 'history-publication:' + eventId + ':' + callId, kind: 'projection', payload: { scope: { companionId: event.companionId, conversationId: event.conversationId, securityDomainId: event.securityDomainId } } });
      this.db.prepare('INSERT OR IGNORE INTO bot_outbox(id,event_id,conversation_id,message_id,created_at) VALUES(?,?,?,?,?)').run(message.id, event.id, event.conversationId, message.id, message.createdAt);
      this.recordEmissionTiming(message.id, event);
      return this.getMessage(message.id)!;
    }).immediate();
  }
  publicationsForEvent(eventId: string): BotMessage[] {
    return this.db.prepare('SELECT m.* FROM bot_publications p JOIN bot_messages m ON m.id=p.message_id WHERE p.event_id=? ORDER BY m.sequence').all(eventId).map(raw => this.message(raw));
  }
  modelAttachments(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, options: { query?: string; ids?: string[] } = {}): BotMediaRef[] { return this.modelAttachmentGrants(scope, options).map(entry => entry.ref); }
  modelAttachmentGrants(scope: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>, options: { query?: string; ids?: string[]; throughSourceSequence?: number; all?: boolean; ownPublicationsFromEventId?:string } = {}): Array<{ ref: BotMediaRef; grantId: string }> {
    const conversation = this.getConversation(scope.conversationId);
    if (!conversation?.memberIds.includes(scope.companionId) || conversation.securityDomainId !== scope.securityDomainId) throw new Error('附件查询没有当前主脑受众权限。');
    const publishingEvent=options.ownPublicationsFromEventId?this.getEvent(options.ownPublicationsFromEventId):undefined;
    if(options.ownPublicationsFromEventId&&(!publishingEvent||publishingEvent.companionId!==scope.companionId||publishingEvent.conversationId!==scope.conversationId||publishingEvent.securityDomainId!==scope.securityDomainId))throw new Error('当前轮次的文件发布身份不匹配。');
    const key = hash([scope.companionId, scope.securityDomainId]), query = (options.query ?? '').slice(0, 200).replace(/[\\%_]/g, char => `\\${char}`);
    const ids = options.ids ? [...new Set(options.ids)] : undefined;
    if (ids && (!ids.length || ids.length > 16)) return [];
    return this.db.prepare(`SELECT a.value AS ref_json,mg.grant_id,MAX(m.sequence) AS latest FROM bot_messages m,json_each(m.attachments_json) a
      JOIN bot_message_media_grants mg ON mg.message_id=m.id AND mg.media_id=json_extract(a.value,'$.id')
      WHERE m.conversation_id=? AND m.status='sent' AND m.attachments_json<>'[]'
      AND (m.sequence<=? OR EXISTS(SELECT 1 FROM bot_publications own WHERE own.message_id=m.id AND own.event_id=? AND m.sender_id=?)
        OR EXISTS(SELECT 1 FROM bot_guidance guidance WHERE guidance.event_id=? AND guidance.message_id=m.id AND guidance.status IN ('pending','accepted')))
      AND ${companionMessageVisibilitySql}
      ${ids ? `AND json_extract(a.value,'$.id') IN(${ids.map(() => '?').join(',')})` : ''}
      AND (?='' OR json_extract(a.value,'$.name') LIKE ? ESCAPE '\\')
      AND NOT EXISTS(SELECT 1 FROM bot_withdrawn_sources w WHERE w.domain_key=? AND w.source_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM bot_publications p JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=p.event_id WHERE p.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM bot_inbox i JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=i.id
        WHERE i.companion_id=? AND (i.source_record_id=m.id OR i.reply_message_id=m.id))
      AND NOT EXISTS(SELECT 1 FROM bot_media_grant_sources s JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=s.source_id WHERE s.grant_id=mg.grant_id)
      AND NOT EXISTS(SELECT 1 FROM bot_message_sources s JOIN bot_withdrawn_sources w ON w.domain_key=? AND w.source_id=s.source_id WHERE s.message_id=m.id)
      GROUP BY json_extract(a.value,'$.id') ORDER BY latest DESC ${options.all ? '' : 'LIMIT 80'}`).all(scope.conversationId, options.throughSourceSequence ?? Number.MAX_SAFE_INTEGER, publishingEvent?.id??'',scope.companionId,publishingEvent?.id??'',
        scope.companionId, scope.companionId, scope.companionId, ...(ids ?? []), query, `%${query}%`, key, key, key, scope.companionId, key, key)
      .map(raw => ({ ref: JSON.parse(String(asRow(raw).ref_json)) as BotMediaRef, grantId: String(asRow(raw).grant_id) }));
  }
  getMessage(id: string): BotMessage | undefined { const raw = this.db.prepare('SELECT * FROM bot_messages WHERE id=?').get(id); return raw ? this.message(raw) : undefined; }
  /** Model/memory visibility only. Human UI history keeps the original task
   * record; raw receipt knowledge belongs to its actual recipient and owner. */
  isMessageVisibleToCompanion(messageId: string, companionId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM bot_messages m WHERE m.id=? AND ${companionMessageVisibilitySql}`)
      .get(messageId, companionId, companionId, companionId);
  }
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
  recentPublishedMessages(conversationId: string, options: { throughSourceSequence: number; limit?: number; maxChars?: number; companionId?: string; publicOnly?: boolean }): BotMessage[] {
    const rows = this.db.prepare(`SELECT m.* FROM bot_history_projection p JOIN bot_messages m ON m.id=p.message_id
      WHERE p.conversation_id=? AND m.sequence<=? AND m.status='sent' AND (length(m.content)>0 OR m.attachments_json<>'[]')
      AND NOT EXISTS(SELECT 1 FROM bot_reply_parts grouped WHERE grouped.publication_id=m.id)
      ${options.publicOnly ? `AND NOT ${internalTaskMessageSql}` : ''}
      ${options.companionId ? `AND ${companionMessageVisibilitySql}` : ''} ORDER BY p.sequence DESC LIMIT ?`)
      .all(conversationId, options.throughSourceSequence, ...(options.companionId ? [options.companionId, options.companionId, options.companionId] : []), bounded(options.limit, 80, 200)).map(raw => this.message(raw));
    const selected: BotMessage[] = [], maxChars = bounded(options.maxChars, 24000, 256000); let size = 0;
    for (const message of rows) { const chars = botMessageEvidence(message).length; if (selected.length && size + chars > maxChars) break; selected.push(message); size += chars; }
    return selected.reverse();
  }
  historyProjectionPage(conversationId: string, options: { after: number; through: number; limit?: number }): BotHistoryProjectionRow[] {
    return this.db.prepare(`SELECT m.*,p.sequence AS projection_sequence,p.timestamp AS projection_timestamp,EXISTS(SELECT 1 FROM bot_reply_parts grouped WHERE grouped.publication_id=m.id) AS suppressed FROM bot_history_projection p
      JOIN bot_messages m ON m.id=p.message_id WHERE p.conversation_id=? AND p.sequence>? AND p.sequence<=? ORDER BY p.sequence LIMIT ?`)
      .all(conversationId, options.after, options.through, bounded(options.limit, 32, 100)).map(raw => ({ projectionSequence: Number(asRow(raw).projection_sequence),
        timestamp: Number(asRow(raw).projection_timestamp), message: this.message(raw),suppressed:!!asRow(raw).suppressed }));
  }
  messagesPage(conversationId: string, options: { limit?: number; before?: number } = {}): BotMessagePage {
    const limit = bounded(options.limit, 100, 200);
    const found = this.db.prepare("SELECT m.* FROM bot_messages m WHERE conversation_id=? AND sequence<? AND kind<>'attention' AND NOT EXISTS(SELECT 1 FROM bot_reply_parts p WHERE p.publication_id=m.id) ORDER BY sequence DESC LIMIT ?")
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
      AND NOT EXISTS(SELECT 1 FROM bot_reply_parts grouped WHERE grouped.publication_id=m.id)
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
  /** Historical task tables are archival; presence follows pending native chat turns. */
  companionPresence(companions: readonly Pick<BotCompanion, 'id' | 'updatedAt'>[], modelConfigured: boolean, now = Date.now()): Record<string, BotCompanionPresence> {
    const inbox = this.db.prepare("SELECT companion_id,SUM(status='running') AS replying,SUM(status='queued') AS pending_messages,MAX(received_at) AS updated_at FROM bot_inbox WHERE status IN ('queued','running') GROUP BY companion_id").all().map(asRow);
    return Object.fromEntries(companions.map(companion => {
      const message = inbox.find(value => value.companion_id === companion.id);
      const replying = Number(message?.replying ?? 0), pendingMessages = Number(message?.pending_messages ?? 0);
      return [companion.id, { status: replying ? 'replying' : pendingMessages ? 'waiting' : modelConfigured ? 'idle' : 'unconfigured',
        counts: { activeTasks: 0, queued: 0, running: 0, waiting: 0, stopping: 0, blocked: 0, paused: 0, replying, pendingMessages },
        updatedAt: [companion.updatedAt, message?.updated_at].filter((value): value is string => typeof value === 'string').sort().at(-1) ?? new Date(now).toISOString() }];
    }));
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
      WHERE j.domain_key=? AND j.kind='capture' AND e.companion_id=? AND e.conversation_id=? AND e.domain_id=? AND e.source IN ('user','companion','group','gateway') AND e.status='done'
      AND (COALESCE(json_extract(j.payload_json,'$.policyVersion'),1)>=2 OR NOT EXISTS(
        SELECT 1 FROM bot_memory_jobs upgraded WHERE upgraded.domain_key=j.domain_key AND upgraded.kind='capture'
        AND json_extract(upgraded.payload_json,'$.sourceEventId')=e.id AND json_extract(upgraded.payload_json,'$.policyVersion')>=2))
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
