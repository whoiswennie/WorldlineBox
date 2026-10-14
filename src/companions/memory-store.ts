import { createHash, randomUUID } from 'node:crypto';
import {
  companionMemoryCandidateSchema, companionMemorySearchSchema, companionMemoryForgetSchema,
  type CompanionMemoryCandidate, type CompanionMemoryJob,
  type CompanionMemorySearch, type CompanionMemoryPage,
} from '../shared/companion-memory';
import type { CompanionMemory, CompanionMessage } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionStateProposal } from '../shared/companion-state';
import { companionSearchMatch, companionSearchTokens, normalizeCompanionSearch } from '../shared/companion-search';
import type { CompanionConnection } from './store';

type Row = Record<string, string | number | null>;
const asRow = (value: unknown): Row => value as Row;
const asRows = (values: unknown[]): Row[] => values.map(asRow);
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const stamp = () => new Date().toISOString();
const checksum = (content: string) => createHash('sha256').update(content).digest('hex');
const norm = (content: string) => normalizeCompanionSearch(content).trim();
type Scope = { companionId: string; conversationId: string; beforeSequence?: number };

/** Database-only memory authority. All calls run inside the existing UtilityProcess. */
export class CompanionMemoryStore {
  constructor(private readonly db: CompanionConnection, private readonly getMessage: (id: string) => CompanionMessage,
    private readonly applyState?: (scope: Scope, proposal: CompanionStateProposal) => void,
    private readonly observeEvent?: (memory: CompanionMemory) => void,
    private readonly withdrawStateSources?: (companionId: string, sourceIds: string[]) => void) {}

  initialize(): void {
    const missingIndex = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_search'").get();
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_records (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL UNIQUE REFERENCES memories(id),
          companion_id TEXT NOT NULL REFERENCES companions(id), conversation_id TEXT,
          kind TEXT NOT NULL, status TEXT NOT NULL, subject TEXT, fact_key TEXT, qualifier TEXT NOT NULL DEFAULT '',
          event_id TEXT, source_sequence INTEGER NOT NULL, identity_key TEXT NOT NULL, version INTEGER NOT NULL,
          UNIQUE(companion_id, identity_key)
        );
        CREATE INDEX IF NOT EXISTS memory_records_owner_scope ON memory_records(companion_id,conversation_id,status,source_sequence DESC);
        CREATE INDEX IF NOT EXISTS memory_records_fact ON memory_records(companion_id,conversation_id,subject,fact_key,qualifier,source_sequence DESC);
        CREATE INDEX IF NOT EXISTS memory_records_event ON memory_records(companion_id,conversation_id,event_id,source_sequence DESC);
        CREATE TABLE IF NOT EXISTS memory_sources (
          memory_id TEXT NOT NULL REFERENCES memories(id), message_id TEXT NOT NULL REFERENCES messages(id),
          revision INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(memory_id,message_id)
        );
        CREATE INDEX IF NOT EXISTS memory_sources_message ON memory_sources(message_id,memory_id);
        CREATE TABLE IF NOT EXISTS memory_observers (
          message_id TEXT NOT NULL REFERENCES messages(id), companion_id TEXT NOT NULL REFERENCES companions(id),
          PRIMARY KEY(message_id,companion_id)
        );
        CREATE TABLE IF NOT EXISTS memory_source_blocks (
          message_id TEXT NOT NULL REFERENCES messages(id), companion_id TEXT NOT NULL REFERENCES companions(id),
          created_at TEXT NOT NULL, PRIMARY KEY(message_id,companion_id)
        );
        CREATE TABLE IF NOT EXISTS memory_jobs (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          companion_id TEXT NOT NULL REFERENCES companions(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
          message_id TEXT NOT NULL REFERENCES messages(id), source_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL, source_checksum TEXT NOT NULL, source_revision INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
          lease_token TEXT, lease_until INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT,
          UNIQUE(companion_id,message_id,source_revision,source_checksum)
        );
        CREATE INDEX IF NOT EXISTS memory_jobs_claim ON memory_jobs(status,next_attempt,ordinal);
        CREATE INDEX IF NOT EXISTS memory_jobs_owner ON memory_jobs(companion_id,status,source_sequence);
        CREATE TABLE IF NOT EXISTS memory_tags (
          id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
          name TEXT NOT NULL, normalized_name TEXT NOT NULL, type TEXT NOT NULL,
          aliases TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS memory_topic_names ON memory_tags(companion_id,conversation_id,type,normalized_name) WHERE type IN ('topic','condition');
        CREATE TABLE IF NOT EXISTS memory_tag_links (
          memory_id TEXT NOT NULL REFERENCES memories(id), tag_id TEXT NOT NULL REFERENCES memory_tags(id),
          ordinal INTEGER NOT NULL, PRIMARY KEY(memory_id,tag_id)
        );
        CREATE INDEX IF NOT EXISTS memory_tag_lookup ON memory_tag_links(tag_id,memory_id);
        CREATE TABLE IF NOT EXISTS memory_relations (
          from_id TEXT NOT NULL REFERENCES memories(id), to_id TEXT NOT NULL REFERENCES memories(id),
          type TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES messages(id),
          PRIMARY KEY(from_id,to_id,type,source_message_id)
        );
        CREATE INDEX IF NOT EXISTS memory_relation_target ON memory_relations(to_id,from_id);
        CREATE TABLE IF NOT EXISTS memory_dependencies (
          memory_id TEXT NOT NULL REFERENCES memories(id), source_memory_id TEXT NOT NULL REFERENCES memories(id),
          source_version INTEGER NOT NULL, PRIMARY KEY(memory_id,source_memory_id)
        );
        CREATE INDEX IF NOT EXISTS memory_dependencies_source ON memory_dependencies(source_memory_id,memory_id);
        CREATE TABLE IF NOT EXISTS memory_forget_rules (
          id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, conversation_id TEXT,
          memory_id TEXT, source_message_ids TEXT NOT NULL, subject TEXT, fact_key TEXT, tag TEXT,
          through_sequence INTEGER NOT NULL, persistent INTEGER NOT NULL, request_message_id TEXT, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_forget_scope ON memory_forget_rules(companion_id,conversation_id);
        CREATE TABLE IF NOT EXISTS memory_operations (
          id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, type TEXT NOT NULL,
          before_data TEXT NOT NULL, after_data TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(tokens,terms,content='',contentless_delete=1);
        INSERT OR IGNORE INTO metadata(key,value) VALUES('memory-backfill-through','0');
        INSERT OR IGNORE INTO metadata(key,value) SELECT 'memory-backfill-target',CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM messages;
      `);
      if (missingIndex && this.db.prepare('SELECT 1 FROM memories LIMIT 1').get()) this.rebuildIndex();
    }).immediate();
  }

  private source(row: Row) {
    const publication = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + row.id);
    return { messageId: String(row.id), conversationId: String(row.conversation_id), sequence: Number(row.sequence),
      authorId: String(row.author_id), revision: Number(row.revision ?? 1), checksum: checksum(String(row.content)), createdAt: String(row.created_at),
      ...(publication ? { publishedAfterSequence: Number(asRow(publication).value) } : {}) };
  }

  saveManual(memory: CompanionMemory): void {
    const source = memory.sourceMessageId ? this.db.prepare('SELECT * FROM messages WHERE id=?').get(memory.sourceMessageId) : undefined;
    memory.kind = memory.kind ?? 'knowledge'; memory.status = memory.status ?? 'active';
    memory.epistemicStatus = 'unverified'; memory.version = memory.version ?? 1;
    memory.captureMethod = 'manual';
    memory.sources = source ? [this.source(asRow(source))] : [];
    memory.sourceSequence = source ? Number(asRow(source).sequence) : 0;
    memory.sourceConversationId = source ? String(asRow(source).conversation_id) : memory.sourceConversationId;
    this.persist(memory, 'manual-' + memory.id);
  }

  archiveManualRevision(previous: CompanionMemory, memory: CompanionMemory): void {
    const archive: CompanionMemory = { ...previous, id: randomUUID(), status: 'superseded' };
    this.saveManual(archive);
    archive.captureMethod = previous.captureMethod; this.persist(archive);
    memory.supersedesId = archive.id;
    this.db.prepare('INSERT INTO memory_operations(id,companion_id,type,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), memory.companionId, 'manual-revise', JSON.stringify(previous), JSON.stringify(memory), stamp());
    this.invalidateDependents(previous.id);
  }

  rehomeConversation(oldId: string, newId: string): void {
    this.db.prepare('UPDATE memory_jobs SET conversation_id=? WHERE conversation_id=?').run(newId, oldId);
    this.db.prepare('UPDATE memory_records SET conversation_id=? WHERE conversation_id=?').run(newId, oldId);
    this.db.prepare('UPDATE memory_forget_rules SET conversation_id=? WHERE conversation_id=?').run(newId, oldId);
    for (const item of asRows(this.db.prepare('SELECT * FROM memory_tags WHERE conversation_id=?').all(oldId))) {
      const target = this.db.prepare('SELECT id FROM memory_tags WHERE conversation_id=? AND companion_id=? AND type=? AND normalized_name=?').get(newId, item.companion_id, item.type, item.normalized_name);
      if (target) {
        this.db.prepare('INSERT OR IGNORE INTO memory_tag_links(memory_id,tag_id,ordinal) SELECT memory_id,?,ordinal FROM memory_tag_links WHERE tag_id=?').run(asRow(target).id, item.id);
        this.db.prepare('DELETE FROM memory_tag_links WHERE tag_id=?').run(item.id);
        this.db.prepare('DELETE FROM memory_tags WHERE id=?').run(item.id);
      } else this.db.prepare('UPDATE memory_tags SET conversation_id=? WHERE id=?').run(newId, item.id);
    }
    for (const item of asRows(this.db.prepare('SELECT data FROM memories WHERE json_extract(data,\'$.sourceConversationId\')=? OR EXISTS(SELECT 1 FROM memory_sources s JOIN messages m ON m.id=s.message_id WHERE s.memory_id=memories.id AND m.conversation_id=?)').all(oldId, newId))) {
      const memory = decode<CompanionMemory>(item.data);
      if (memory.sourceConversationId === oldId) memory.sourceConversationId = newId;
      memory.sources = memory.sources?.map(source => source.conversationId === oldId ? { ...source, conversationId: newId } : source);
      this.persist(memory);
    }
  }

  private requireScope(scope: Scope): Row {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(scope.companionId)) throw new Error('伙伴不存在。');
    const conversation = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(scope.conversationId);
    if (!conversation || !this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(scope.conversationId, scope.companionId)) throw new Error('伙伴不是聊天成员。');
    return asRow(conversation);
  }

  private isFormal(row: Row): boolean {
    if (row.status !== 'sent' || row.author_id === 'system' || row.kind === 'notice') return false;
    if (row.kind === 'action') {
      const action = row.action_id ? this.db.prepare('SELECT data,status FROM actions WHERE id=?').get(row.action_id) : undefined;
      if (!action || !['succeeded', 'failed', 'cancelled'].includes(String(asRow(action).status))) return false;
      const result = decode<{ result?: string; error?: string }>(asRow(action).data);
      return !!(result.result || result.error);
    }
    const loop = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-loop/' + row.id);
    if (loop) return decode<{ status: string }>(asRow(loop).value).status === 'done';
    const fingerprint = row.request_fingerprint ? decode<{ loopStep?: number }>(row.request_fingerprint) : undefined;
    return fingerprint?.loopStep === undefined;
  }

  /** Called by message append in its transaction; never enqueue streaming drafts. */
  enqueueMessage(messageId: string, finalizedLoop = false): void {
    const value = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    if (!value) return;
    const row = asRow(value);
    if (!finalizedLoop && !this.isFormal(row)) return;
    if (row.status !== 'sent' || !String(row.content).trim()) return;
    this.db.prepare("UPDATE memory_jobs SET status='done',error=NULL,lease_token=NULL,lease_until=NULL WHERE message_id=? AND (source_checksum!=? OR source_revision!=?)").run(messageId, checksum(String(row.content)), row.revision);
    for (const found of asRows(this.db.prepare('SELECT s.memory_id,s.checksum,s.revision FROM memory_sources s WHERE s.message_id=?').all(messageId))) {
      if (found.checksum === checksum(String(row.content)) && Number(found.revision) === Number(row.revision)) continue;
      const memory = this.load(String(found.memory_id));
      if (memory.status === 'forgotten' || memory.status === 'invalid') continue;
      memory.status = 'invalid'; memory.updatedAt = stamp(); this.persist(memory); this.invalidateDependents(memory.id);
      this.withdrawStateSources?.(memory.companionId, [messageId]);
    }
    const members = asRows(this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=?').all(row.conversation_id));
    const publication = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + row.id);
    const throughSequence = publication ? Math.max(Number(row.sequence), Number(asRow(publication).value) + 1) : Number(row.sequence);
    for (const member of members) {
      this.db.prepare('INSERT OR IGNORE INTO memory_observers(message_id,companion_id) VALUES(?,?)').run(messageId, member.companion_id);
      this.db.prepare('INSERT OR IGNORE INTO memory_jobs(id,companion_id,conversation_id,message_id,source_sequence,through_sequence,source_checksum,source_revision) VALUES(?,?,?,?,?,?,?,?)')
        .run(randomUUID(), member.companion_id, row.conversation_id, messageId, row.sequence, throughSequence, checksum(String(row.content)), row.revision);
    }
  }

  backfill(limit = 200): boolean {
    return this.db.transaction(() => {
      const through = Number(asRow(this.db.prepare("SELECT value FROM metadata WHERE key='memory-backfill-through'").get()).value);
      const target = Number(asRow(this.db.prepare("SELECT value FROM metadata WHERE key='memory-backfill-target'").get()).value);
      if (through >= target) return true;
      const batch = asRows(this.db.prepare('SELECT id,sequence FROM messages WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(through, target, limit));
      for (const item of batch) this.enqueueMessage(String(item.id));
      const next = batch.length === limit ? Number(batch.at(-1)!.sequence) : target;
      this.db.prepare("UPDATE metadata SET value=? WHERE key='memory-backfill-through'").run(String(next));
      return next >= target;
    }).immediate();
  }

  claim(companionId?: string, leaseMs = 120000): CompanionMemoryJob | undefined {
    return this.db.transaction(() => {
      const now = Date.now();
      this.db.prepare("UPDATE memory_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
      const found = this.db.prepare(`SELECT j.* FROM memory_jobs j JOIN companions c ON c.id=j.companion_id
        WHERE j.status IN ('pending','failed') AND j.next_attempt<=? AND j.attempts<8 AND c.deleted_at IS NULL
        ${companionId ? 'AND j.companion_id=?' : ''} ORDER BY j.ordinal LIMIT 1`).get(...(companionId ? [now, companionId] : [now]));
      if (!found) return;
      const row = asRow(found), token = randomUUID(), attempts = Number(row.attempts) + 1;
      const batch = asRows(this.db.prepare("SELECT * FROM memory_jobs WHERE companion_id=? AND conversation_id=? AND status IN ('pending','failed') AND next_attempt<=? AND attempts<8 ORDER BY source_sequence,ordinal LIMIT 8").all(row.companion_id, row.conversation_id, now));
      for (const item of batch) this.db.prepare("UPDATE memory_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now + leaseMs, item.id);
      return { id: String(row.id), companionId: String(row.companion_id), conversationId: String(row.conversation_id),
        sourceMessageIds: batch.map(item => String(item.message_id)), throughSequence: Math.max(...batch.map(item => Number(item.through_sequence))), leaseToken: token, attempts,
        sourceChecksums: Object.fromEntries(batch.map(item => [String(item.message_id), String(item.source_checksum)])),
        sourceRevisions: Object.fromEntries(batch.map(item => [String(item.message_id), Number(item.source_revision)])) };
    }).immediate();
  }

  private requireJob(id: string, leaseToken: string): Row {
    const found = this.db.prepare("SELECT * FROM memory_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").get(id, leaseToken, Date.now());
    if (!found) throw new Error('记忆提取租约已经失效。');
    return asRow(found);
  }

  complete(id: string, leaseToken: string, candidates: CompanionMemoryCandidate[], stateProposal?: CompanionStateProposal): CompanionMemory[] {
    return this.db.transaction(() => {
      const job = this.requireJob(id, leaseToken);
      const batch = asRows(this.db.prepare("SELECT * FROM memory_jobs WHERE status='running' AND lease_token=?").all(leaseToken));
      for (const item of batch) {
        const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(item.message_id);
        if (!source || Number(asRow(source).revision) !== Number(item.source_revision) || checksum(String(asRow(source).content)) !== item.source_checksum || !this.isFormal(asRow(source))) throw new Error('记忆来源已修订，请重新提取。');
      }
      const sourceIds = new Set(batch.map(item => String(item.message_id)));
      const scope = { companionId: String(job.companion_id), conversationId: String(job.conversation_id), beforeSequence: Math.max(...batch.map(item => Number(item.through_sequence))) };
      const memories: CompanionMemory[] = [];
      for (const candidate of candidates) {
        if (!candidate.sourceMessageIds.length || candidate.sourceMessageIds.some(id => !sourceIds.has(id))) throw new Error('提取候选必须只包含本批任务来源。');
        const memory = this.record(scope, candidate);
        if (memory) memories.push(memory);
      }
      if (stateProposal) {
        if (stateProposal.sourceMessageIds.some(id => !sourceIds.has(id))) throw new Error('状态提议必须只使用本批正式来源。');
        const available = stateProposal.sourceMessageIds.every(id => {
          const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
          return source && this.sourceVisible(scope, asRow(source));
        });
        // A human can withdraw evidence while the model is extracting it.
        // Finish that job without reviving its state or retrying it forever.
        if (available) this.applyState?.(scope, stateProposal);
      }
      this.db.prepare("UPDATE memory_jobs SET status='done',error=NULL,lease_token=NULL,lease_until=NULL WHERE lease_token=?").run(leaseToken);
      return memories;
    }).immediate();
  }

  fail(id: string, token: string, error: string, retryAfterMs = 30000): void {
    this.requireJob(id, token);
    this.db.prepare("UPDATE memory_jobs SET status='failed',error=?,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE lease_token=?").run(error, Date.now() + retryAfterMs, token);
  }

  retry(companionId?: string): void {
    this.db.prepare(`UPDATE memory_jobs SET status='pending',attempts=0,next_attempt=0,error=NULL WHERE status='failed' ${companionId ? 'AND companion_id=?' : ''}`).run(...(companionId ? [companionId] : []));
  }

  private rules(companionId: string): Row[] {
    return asRows(this.db.prepare('SELECT * FROM memory_forget_rules WHERE companion_id=?').all(companionId));
  }

  private blocked(scope: Scope, candidate: { id?: string; sourceConversationId?: string; subject?: string; factKey?: string; tags?: { name: string; aliases?: string[] }[]; sources?: { messageId: string; sequence: number; conversationId: string }[] }): boolean {
    return this.rules(scope.companionId).some(rule => {
      const sources = candidate.sources ?? [];
      const candidateConversation = candidate.sourceConversationId ?? sources[0]?.conversationId ?? scope.conversationId;
      if (rule.conversation_id && candidateConversation !== rule.conversation_id) return false;
      if (!rule.persistent && sources.length && sources.every(source => source.sequence > Number(rule.through_sequence))) return false;
      if (rule.memory_id && candidate.id === rule.memory_id) return true;
      const ids = decode<string[]>(rule.source_message_ids);
      if (ids.some(id => sources.some(source => source.messageId === id))) return true;
      if (rule.subject && norm(candidate.subject ?? '') !== norm(String(rule.subject))) return false;
      if (rule.fact_key && norm(candidate.factKey ?? '') !== norm(String(rule.fact_key))) return false;
      if (rule.tag && !candidate.tags?.some(tag => [tag.name, ...(tag.aliases ?? [])].some(name => norm(name) === norm(String(rule.tag))))) return false;
      return !!(rule.subject || rule.fact_key || rule.tag);
    });
  }

  private sourceVisible(scope: Scope, source: Row): boolean {
    const conversation = this.requireScope(scope);
    if (scope.beforeSequence !== undefined && Number(source.sequence) > scope.beforeSequence) return false;
    const publication = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + source.id);
    if (scope.beforeSequence !== undefined && publication && scope.beforeSequence <= Number(asRow(publication).value)) return false;
    if (conversation.kind === 'group' && source.conversation_id !== scope.conversationId) return false;
    if (!this.db.prepare('SELECT 1 FROM memory_observers WHERE message_id=? AND companion_id=?').get(source.id, scope.companionId)) return false;
    if (!this.isFormal(source)) return false;
    return !this.sourceForgotten(scope, source);
  }

  private sourceForgotten(scope: Scope, source: Row, visited = new Set<string>()): boolean {
    const id = String(source.id);
    if (visited.has(id)) return true;
    visited.add(id);
    if (this.db.prepare('SELECT 1 FROM memory_source_blocks WHERE message_id=? AND companion_id=?').get(source.id, scope.companionId)) return true;
    const related = asRows(this.db.prepare('SELECT m.data FROM memory_sources s JOIN memories m ON m.id=s.memory_id WHERE s.message_id=? AND m.companion_id=?').all(source.id, scope.companionId));
    if (related.some(item => this.blocked(scope, decode<CompanionMemory>(item.data)))) return true;
    if (this.rules(scope.companionId).some(rule => {
      if (rule.conversation_id && rule.conversation_id !== source.conversation_id) return false;
      if (!rule.persistent && Number(source.sequence) > Number(rule.through_sequence)) return false;
      if (decode<string[]>(rule.source_message_ids).includes(String(source.id))) return true;
      // Persistent topic prohibitions also apply before extraction and context injection.
      return !!rule.tag && norm(String(source.content)).includes(norm(String(rule.tag)));
    })) return true;
    const ancestors = new Set<string>();
    if (source.author_id !== 'user' && source.reply_to_id) ancestors.add(String(source.reply_to_id));
    if (source.author_id !== 'user') {
      const loop = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-loop/' + id);
      if (loop) ancestors.add(decode<{ sourceMessageId: string }>(asRow(loop).value).sourceMessageId);
    }
    if (source.action_id) {
      const action = this.db.prepare('SELECT data FROM actions WHERE id=?').get(source.action_id);
      if (action) ancestors.add(decode<{ sourceMessageId: string }>(asRow(action).data).sourceMessageId);
    }
    for (const ancestorId of ancestors) {
      const ancestor = this.db.prepare('SELECT * FROM messages WHERE id=?').get(ancestorId);
      if (ancestor && this.sourceForgotten(scope, asRow(ancestor), new Set(visited))) return true;
    }
    return false;
  }

  private visible(scope: Scope, memory: CompanionMemory, includeHistory = false): boolean {
    const conversation = this.requireScope(scope);
    if (memory.companionId !== scope.companionId || ['forgotten', 'invalid'].includes(memory.status ?? 'active')) return false;
    if (conversation.kind === 'group' && memory.sourceConversationId !== scope.conversationId) return false;
    if (scope.beforeSequence !== undefined && !memory.sources?.some(source => source.sequence <= scope.beforeSequence!)) return false;
    if (this.blocked(scope, memory)) return false;
    for (const dependency of asRows(this.db.prepare('SELECT source_memory_id,source_version FROM memory_dependencies WHERE memory_id=?').all(memory.id))) {
      const source = this.load(String(dependency.source_memory_id));
      if (source.status !== 'active' || source.version !== Number(dependency.source_version)) return false;
    }
    if (!memory.sources?.length || memory.epistemicStatus === 'unverified') return false;
    const observedSources = scope.beforeSequence === undefined ? memory.sources : memory.sources.filter(source => source.sequence <= scope.beforeSequence!
      && (source.publishedAfterSequence === undefined || source.publishedAfterSequence < scope.beforeSequence!));
    if (!observedSources.length || !observedSources.every(source => {
      const found = this.db.prepare('SELECT * FROM messages WHERE id=?').get(source.messageId);
      return !!found && checksum(String(asRow(found).content)) === source.checksum && Number(asRow(found).revision ?? 1) === source.revision && this.sourceVisible(scope, asRow(found));
    })) return false;
    if (!includeHistory) {
      if (memory.status === 'conflict' || (memory.status === 'superseded' && scope.beforeSequence === undefined)) return false;
      const observedSequence = Math.max(...observedSources.map(source => source.sequence));
      const identity = memory.subject && memory.factKey ? 'r.subject=? AND r.fact_key=? AND r.qualifier=?' : memory.eventId && memory.eventStatus ? 'r.event_id=?' : undefined;
      if (identity) {
        const parameters: unknown[] = memory.subject && memory.factKey ? [memory.subject, memory.factKey, memory.qualifier ?? ''] : [memory.eventId];
        const newer = this.db.prepare(`SELECT 1 FROM memory_records r JOIN memory_sources s ON s.memory_id=r.memory_id JOIN messages m ON m.id=s.message_id
          WHERE r.companion_id=? AND r.conversation_id=? AND ${identity} AND r.status!='conflict' AND m.sequence>? AND m.sequence<=?
            AND NOT EXISTS(SELECT 1 FROM metadata p WHERE p.key='message-published-after/'||m.id AND CAST(p.value AS INTEGER)>=?) LIMIT 1`)
          .get(memory.companionId, memory.sourceConversationId ?? null, ...parameters, observedSequence, scope.beforeSequence ?? Number.MAX_SAFE_INTEGER, scope.beforeSequence ?? Number.MAX_SAFE_INTEGER);
        if (newer) return false;
      } else if (memory.status === 'superseded') return false;
    }
    return true;
  }

  private load(id: string): CompanionMemory {
    const found = this.db.prepare('SELECT data FROM memories WHERE id=?').get(id);
    if (!found) throw new Error('记忆不存在。');
    return decode<CompanionMemory>(asRow(found).data);
  }

  private persist(memory: CompanionMemory, identity?: string): void {
    this.db.prepare('INSERT INTO memories(id,companion_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(memory.id, memory.companionId, JSON.stringify(memory));
    this.db.prepare(`INSERT INTO memory_records(memory_id,companion_id,conversation_id,kind,status,subject,fact_key,qualifier,event_id,source_sequence,identity_key,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET kind=excluded.kind,status=excluded.status,subject=excluded.subject,fact_key=excluded.fact_key,qualifier=excluded.qualifier,event_id=excluded.event_id,source_sequence=excluded.source_sequence,version=excluded.version`)
      .run(memory.id, memory.companionId, memory.sourceConversationId ?? null, memory.kind ?? 'knowledge', memory.status ?? 'active', memory.subject ?? null,
        memory.factKey ?? null, memory.qualifier ?? '', memory.eventId ?? null, memory.sourceSequence ?? 0, identity ?? memory.id, memory.version ?? 1);
    for (const source of memory.sources ?? []) this.db.prepare('INSERT INTO memory_sources(memory_id,message_id,revision,checksum) VALUES(?,?,?,?) ON CONFLICT(memory_id,message_id) DO UPDATE SET revision=excluded.revision,checksum=excluded.checksum').run(memory.id, source.messageId, source.revision, source.checksum);
    const ordinal = asRow(this.db.prepare('SELECT ordinal FROM memory_records WHERE memory_id=?').get(memory.id)).ordinal;
    this.db.prepare('DELETE FROM memory_search WHERE rowid=?').run(ordinal);
    if (!['forgotten', 'invalid'].includes(memory.status ?? 'active')) this.db.prepare('INSERT INTO memory_search(rowid,tokens,terms) VALUES(?,?,?)').run(ordinal,
      companionSearchTokens([memory.content, memory.subject, memory.factKey, memory.value, ...(memory.tags ?? []).flatMap(tag => [tag.name, ...tag.aliases])].filter(Boolean).join('\n')),
      this.queryTerms(memory.content).join(' '));
  }

  record(scope: Scope, input: CompanionMemoryCandidate, revision?: { id: string; expectedVersion: number }): CompanionMemory | undefined {
    return this.db.transaction(() => {
      const candidate = companionMemoryCandidateSchema.parse(input);
      this.requireScope(scope);
      const sourceRows = [...new Set(candidate.sourceMessageIds)].map(id => {
        const value = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
        if (!value) throw new Error('记忆来源消息不存在。');
        const source = asRow(value);
        if (!this.sourceVisible(scope, source)) {
          if (this.sourceForgotten(scope, source) || this.blocked(scope, { ...candidate, sources: [this.source(source)] })) return undefined;
          throw new Error('记忆来源不可见、未正式发送或已遗忘。');
        }
        if (candidate.sourceChecksums?.[id] && candidate.sourceChecksums[id] !== checksum(String(source.content))) throw new Error('记忆来源修订已改变。');
        return source;
      });
      if (sourceRows.some(source => !source)) return;
      const sources = (sourceRows as Row[]).map(source => this.source(source));
      const firstSource = sources[0];
      if (!firstSource) throw new Error('记忆缺少可用来源。');
      if (new Set(sources.map(source => source.conversationId)).size !== 1) throw new Error('多来源记忆不能混合不同聊天的可见范围。');
      for (const evidence of candidate.evidence) {
        const source = (sourceRows as Row[]).find(source => source.id === evidence.sourceMessageId);
        if (!source || !String(source.content).includes(evidence.quote)) throw new Error('记忆证据不是来源消息中的原文。');
      }
      if (sources.some(source => !candidate.evidence.some(evidence => evidence.sourceMessageId === source.messageId))) throw new Error('每个记忆来源都需要可核验的原文证据。');
      if (['fact', 'preference', 'agreement'].includes(candidate.kind) && (!candidate.subject || !candidate.factKey)) throw new Error('事实和约定需要主体与事实键。');
      if (candidate.kind === 'reflection' && candidate.epistemicStatus !== 'subjective') throw new Error('伙伴感想必须标记为主观。');
      if (candidate.kind === 'reflection' && candidate.subject !== scope.companionId) throw new Error('伙伴感想必须属于当前伙伴视角。');
      if (['fact', 'preference'].includes(candidate.kind) && ['user', '用户', '用户本人'].includes(candidate.subject ?? '') && !sources.some(source => source.authorId === 'user') && ['asserted', 'confirmed'].includes(candidate.epistemicStatus)) throw new Error('伙伴发言不能作为用户已声明事实的证据。');
      if (this.blocked(scope, { ...candidate, sources })) {
        for (const source of sources) this.db.prepare('INSERT OR IGNORE INTO memory_source_blocks(message_id,companion_id,created_at) VALUES(?,?,?)').run(source.messageId, scope.companionId, stamp());
        return;
      }
      const sourceSequence = Math.max(...sources.map(source => source.sequence));
      const distinctEventSources = !candidate.eventId && !(candidate.subject && candidate.factKey) ? sources.map(source => [source.messageId, source.revision]).sort() : undefined;
      const identity = checksum(JSON.stringify([firstSource.conversationId, candidate.kind, norm(candidate.subject ?? ''), norm(candidate.factKey ?? ''), norm(candidate.qualifier ?? ''),
        candidate.eventId ?? '', candidate.eventStatus ?? '', candidate.polarity, norm(candidate.value ?? candidate.content), candidate.epistemicStatus, distinctEventSources]));
      const existing = this.db.prepare('SELECT memory_id FROM memory_records WHERE companion_id=? AND identity_key=?').get(scope.companionId, identity);
      if (existing && !revision) {
        const memory = this.load(String(asRow(existing).memory_id));
        if (memory.status === 'forgotten') return;
        if (memory.status !== 'superseded' || sources.every(source => (memory.sources ?? []).some(old => old.messageId === source.messageId))) {
        const byId = new Map((memory.sources ?? []).map(source => [source.messageId, source]));
        sources.forEach(source => byId.set(source.messageId, source));
        if (byId.size !== memory.sources?.length) {
          memory.sources = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
          memory.sourceSequence = Math.max(...memory.sources.map(source => source.sequence));
          memory.updatedAt = stamp(); memory.version = (memory.version ?? 1) + 1;
          // Source ordering, never processing time, decides the current version.
          this.persist(memory);
          this.invalidateDependents(memory.id);
        }
        return memory;
        }
      }
      let previous: CompanionMemory | undefined;
      if (revision) {
        previous = this.load(revision.id);
        if (!this.visible(scope, previous, true) || previous.version !== revision.expectedVersion) throw new Error('记忆版本冲突，请重新读取。');
        if (sourceSequence < (previous.sourceSequence ?? 0)) throw new Error('旧来源不能修正新的记忆版本。');
      } else if (candidate.subject && candidate.factKey) {
        const found = this.db.prepare(`SELECT m.data FROM memory_records r JOIN memories m ON m.id=r.memory_id WHERE r.companion_id=? AND r.conversation_id=? AND r.subject=? AND r.fact_key=? AND r.qualifier=? AND r.status NOT IN ('forgotten','invalid') ORDER BY r.source_sequence DESC,r.ordinal DESC LIMIT 1`)
          .get(scope.companionId, firstSource.conversationId, candidate.subject, candidate.factKey, candidate.qualifier ?? '');
        if (found) previous = decode<CompanionMemory>(asRow(found).data);
      } else if (candidate.eventId && candidate.eventStatus) {
        const found = this.db.prepare(`SELECT m.data FROM memory_records r JOIN memories m ON m.id=r.memory_id WHERE r.companion_id=? AND r.conversation_id=? AND r.event_id=? AND r.status='active' ORDER BY r.source_sequence DESC LIMIT 1`).get(scope.companionId, firstSource.conversationId, candidate.eventId);
        if (found) previous = decode<CompanionMemory>(asRow(found).data);
      }
      let status: NonNullable<CompanionMemory['status']> = 'active';
      if (candidate.epistemicStatus === 'hypothesis' || candidate.epistemicStatus === 'conflict') status = 'conflict';
      if (previous) {
        const oldAuthor = previous.sources?.at(-1)?.authorId, author = sources.at(-1)?.authorId;
        if (sourceSequence < (previous.sourceSequence ?? 0)) status = 'superseded';
        else if (oldAuthor !== author && candidate.kind !== 'event' && candidate.kind !== 'task') status = 'conflict';
        else if (status === 'active') { previous.status = 'superseded'; previous.updatedAt = stamp(); this.persist(previous); this.invalidateDependents(previous.id); }
      }
      const memory: CompanionMemory = {
        id: randomUUID(), companionId: scope.companionId, content: candidate.content, kind: candidate.kind,
        sourceMessageId: firstSource.messageId, sourceConversationId: firstSource.conversationId, sources, sourceSequence,
        createdAt: stamp(), updatedAt: stamp(), origin: sources.some(source => source.authorId === 'user') ? 'user' : 'companion',
        subject: candidate.subject, factKey: candidate.factKey, value: candidate.value, qualifier: candidate.qualifier,
        polarity: candidate.polarity, epistemicStatus: candidate.epistemicStatus, status, version: 1,
        eventId: candidate.eventId, eventStatus: candidate.eventStatus, validFrom: candidate.validFrom, validTo: candidate.validTo,
        supersedesId: previous && status === 'active' ? previous.id : undefined, captureMethod: 'automatic', tags: [],
      };
      this.persist(memory, existing ? identity + '-' + memory.id : identity);
      this.applyTags(memory, candidate.tags);
      for (const relatedId of candidate.relatedMemoryIds) {
        const related = this.load(relatedId);
        if (!this.visible(scope, related, true) || related.sourceConversationId !== memory.sourceConversationId) throw new Error('关联记忆不属于同一可见范围。');
        this.db.prepare('INSERT OR IGNORE INTO memory_relations(from_id,to_id,type,source_message_id) VALUES(?,?,?,?)').run(memory.id, relatedId, candidate.relationType, firstSource.messageId);
        if (['overview', 'knowledge', 'reflection'].includes(memory.kind ?? '')) this.db.prepare('INSERT OR IGNORE INTO memory_dependencies(memory_id,source_memory_id,source_version) VALUES(?,?,?)').run(memory.id, relatedId, related.version ?? 1);
      }
      if (memory.supersedesId) this.db.prepare("INSERT OR IGNORE INTO memory_relations(from_id,to_id,type,source_message_id) VALUES(?,?,'supersedes',?)").run(memory.id, memory.supersedesId, firstSource.messageId);
      this.observeEvent?.(memory);
      return memory;
    }).immediate();
  }

  private applyTags(memory: CompanionMemory, tags: NonNullable<CompanionMemoryCandidate['tags']>): void {
    for (const input of tags) {
      const tag = { ...input, type: input.type ?? 'topic', aliases: input.aliases ?? [] };
      const found = tag.id ? this.db.prepare('SELECT * FROM memory_tags WHERE id=? AND companion_id=? AND conversation_id=?').get(tag.id, memory.companionId, memory.sourceConversationId)
        : ['topic', 'condition'].includes(tag.type) ? this.db.prepare('SELECT * FROM memory_tags WHERE companion_id=? AND conversation_id=? AND type=? AND normalized_name=?').get(memory.companionId, memory.sourceConversationId, tag.type, norm(tag.name)) : undefined;
      if (tag.id && !found) throw new Error('标签不属于当前记忆范围。');
      const id = found ? String(asRow(found).id) : randomUUID();
      const aliases = [...new Set([...(found ? decode<string[]>(asRow(found).aliases) : []), ...tag.aliases])].slice(0, 20);
      const name = found ? String(asRow(found).name) : tag.name;
      this.db.prepare('INSERT INTO memory_tags(id,companion_id,conversation_id,name,normalized_name,type,aliases) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET aliases=excluded.aliases').run(id, memory.companionId, memory.sourceConversationId, name, norm(name), tag.type, JSON.stringify(aliases));
      this.db.prepare('INSERT OR IGNORE INTO memory_tag_links(memory_id,tag_id,ordinal) VALUES(?,?,?)').run(memory.id, id, memory.tags?.length ?? 0);
      const saved = { id, name, type: tag.type, aliases };
      memory.tags = [...(memory.tags ?? []).filter(item => item.id !== id), saved];
      // Canonical alias changes immediately update every linked record's index.
      if (found && String(asRow(found).aliases) !== JSON.stringify(aliases)) for (const item of asRows(this.db.prepare('SELECT m.data FROM memory_tag_links l JOIN memories m ON m.id=l.memory_id WHERE l.tag_id=? AND m.id!=?').all(id, memory.id))) {
        const linked = decode<CompanionMemory>(item.data);
        linked.tags = linked.tags?.map(item => item.id === id ? saved : item);
        this.persist(linked);
      }
    }
    this.persist(memory);
  }

  private invalidateDependents(id: string, visited = new Set<string>(), forgotten = false): void {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dependency of asRows(this.db.prepare('SELECT memory_id FROM memory_dependencies WHERE source_memory_id=?').all(id))) {
      const memory = this.load(String(dependency.memory_id));
      if (memory.status === 'forgotten' || (!forgotten && memory.status === 'invalid')) continue;
      memory.status = forgotten ? 'forgotten' : 'invalid'; memory.updatedAt = stamp(); this.persist(memory);
      if (forgotten) for (const source of memory.sources ?? []) this.db.prepare('INSERT OR IGNORE INTO memory_source_blocks(message_id,companion_id,created_at) VALUES(?,?,?)').run(source.messageId, memory.companionId, stamp());
      this.invalidateDependents(memory.id, visited, forgotten);
    }
  }

  private observedMemory(scope: Scope, memory: CompanionMemory): CompanionMemory {
    if (scope.beforeSequence === undefined) return memory;
    const sources = memory.sources?.filter(source => source.sequence <= scope.beforeSequence!
      && (source.publishedAfterSequence === undefined || source.publishedAfterSequence < scope.beforeSequence!));
    return { ...memory, sources, sourceMessageId: sources?.[0]?.messageId, sourceSequence: sources?.length ? Math.max(...sources.map(source => source.sequence)) : memory.sourceSequence };
  }

  private queryTerms(query: string): string[] {
    const tokens = norm(query).match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
    const stop = new Set(['什么', '现在', '之前', '记得', '那个', '这个', '我们', '你还', '可以', '我的', '你的', '还是', '怎么']);
    const terms: string[] = [];
    for (const token of tokens) {
      if (token.length <= 8) terms.push(token);
      if (/\p{Script=Han}/u.test(token) && token.length > 2) for (let i = 0; i < token.length - 1; i++) if (!stop.has(token.slice(i, i + 2))) terms.push(token.slice(i, i + 2));
    }
    return [...new Set(terms)].slice(0, 40);
  }

  search(input: CompanionMemorySearch): CompanionMemoryPage {
    try { return this.searchOnce(input); }
    catch (error) {
      if (!(error instanceof Error) || !/no such table:\s*memory_search|database disk image is malformed|fts5.*(?:corrupt|error)/iu.test(error.message)) throw error;
      this.rebuildIndex();
      return this.searchOnce(input);
    }
  }

  private searchOnce(input: CompanionMemorySearch): CompanionMemoryPage {
    const query = companionMemorySearchSchema.parse(input), conversation = this.requireScope(query);
    if (query.status === 'forgotten' || query.status === 'invalid') return { items: [], hasMore: false };
    const terms = [...new Set([...query.terms, ...this.queryTerms(query.query), ...query.tags])];
    const filters = ['r.companion_id=?'], args: unknown[] = [query.companionId];
    if (conversation.kind === 'group') { filters.push('r.conversation_id=?'); args.push(query.conversationId); }
    if (query.beforeSequence !== undefined) { filters.push('(r.source_sequence<=? OR EXISTS(SELECT 1 FROM memory_sources s JOIN messages sm ON sm.id=s.message_id WHERE s.memory_id=r.memory_id AND sm.sequence<=?))'); args.push(query.beforeSequence, query.beforeSequence); }
    if (query.kind) { filters.push('r.kind=?'); args.push(query.kind); }
    if (query.status && !['forgotten', 'invalid'].includes(query.status)) { filters.push('r.status=?'); args.push(query.status); }
    else filters.push("r.status NOT IN ('forgotten','invalid')");
    const anchors: string[] = [], anchorArgs: unknown[] = [];
    if (query.subject) { anchors.push('r.subject=?'); anchorArgs.push(query.subject); }
    if (query.factKey) { anchors.push('r.fact_key=?'); anchorArgs.push(query.factKey); }
    if (query.eventId) { anchors.push('r.event_id=?'); anchorArgs.push(query.eventId); }
    const match = this.fulltextMatch(terms);
    const anchor = anchors.length ? '(' + anchors.join(' AND ') + ')' : '0';
    if (query.from) { filters.push("COALESCE(json_extract(m.data,'$.validFrom'),json_extract(m.data,'$.sources[0].createdAt'))>=?"); args.push(query.from); }
    if (query.to) { filters.push("COALESCE(json_extract(m.data,'$.validFrom'),json_extract(m.data,'$.sources[0].createdAt'))<=?"); args.push(query.to); }
    const baseScope = ['r.companion_id=?'], baseArgs: unknown[] = [query.companionId];
    if (conversation.kind === 'group') { baseScope.push('r.conversation_id=?'); baseArgs.push(query.conversationId); }
    if (query.beforeSequence !== undefined) { baseScope.push('(r.source_sequence<=? OR EXISTS(SELECT 1 FROM memory_sources s JOIN messages sm ON sm.id=s.message_id WHERE s.memory_id=r.memory_id AND sm.sequence<=?))'); baseArgs.push(query.beforeSequence, query.beforeSequence); }
    baseScope.push("r.status NOT IN ('forgotten','invalid')");
    const queryParams: unknown[] = [];
    const ranked = match ? 'SELECT rowid,bm25(memory_search,1.0,3.0) AS score FROM memory_search WHERE memory_search MATCH ?' : 'SELECT 0 AS rowid,0.0 AS score WHERE 0';
    if (match) queryParams.push(match);
    queryParams.push(...anchorArgs, ...baseArgs);
    const selection = anchors.length || match ? '(' + [anchors.length ? anchor : '', match ? 'f.rowid IS NOT NULL' : ''].filter(Boolean).join(' OR ') + ')' : '1';
    queryParams.push(...anchorArgs);
    const sql = `WITH ranked AS MATERIALIZED (${ranked}),
      direct AS MATERIALIZED (
        SELECT r.ordinal,r.memory_id,r.source_sequence,CASE WHEN ${anchor} THEN 0 ELSE 1 END AS priority,
          COALESCE(f.score,0.0) AS score,NULL AS origin_id,NULL AS evidence_id,NULL AS relation_type
        FROM memory_records r LEFT JOIN ranked f ON f.rowid=r.ordinal
        WHERE ${baseScope.join(' AND ')} AND ${selection}
      ), seed AS (SELECT * FROM direct ORDER BY priority,score,source_sequence DESC,ordinal DESC LIMIT 20),
      related AS (
        SELECT target.ordinal,target.memory_id,target.source_sequence,2 AS priority,0.0 AS score,
          seed.memory_id AS origin_id,e.source_message_id AS evidence_id,e.type AS relation_type,
          ROW_NUMBER() OVER(PARTITION BY target.ordinal ORDER BY seed.priority,seed.score,seed.ordinal) AS rn
        FROM seed JOIN memory_relations e ON e.from_id=seed.memory_id OR e.to_id=seed.memory_id
          JOIN memory_records target ON target.memory_id=CASE WHEN e.from_id=seed.memory_id THEN e.to_id ELSE e.from_id END
        WHERE target.ordinal NOT IN (SELECT ordinal FROM direct) ${query.includeHistory ? '' : "AND e.type!='supersedes'"}
          ${terms.length || anchors.length ? '' : 'AND 0'}
      ), candidates AS (
        SELECT * FROM direct UNION ALL SELECT ordinal,memory_id,source_sequence,priority,score,origin_id,evidence_id,relation_type FROM related WHERE rn=1
      )
      SELECT m.data,c.* FROM candidates c JOIN memory_records r ON r.ordinal=c.ordinal JOIN memories m ON m.id=r.memory_id
        WHERE ${filters.join(' AND ')} ORDER BY c.priority,c.score,r.source_sequence DESC,r.ordinal DESC LIMIT ? OFFSET ?`;
    queryParams.push(...args);
    let examined = query.cursor ?? 0, hasMore = false;
    const items: CompanionMemoryPage['items'] = [];
    const statement = this.db.prepare(sql);
    for (;;) {
      const batch = asRows(statement.all(...queryParams, 128, examined));
      if (!batch.length) break;
      for (const row of batch) {
        const memory = decode<CompanionMemory>(row.data);
        if (this.visible(query, memory, query.includeHistory)) {
          let validRelation = true;
          if (row.origin_id) {
            const origin = this.load(String(row.origin_id)), evidence = this.db.prepare('SELECT * FROM messages WHERE id=?').get(row.evidence_id);
            validRelation = this.visible(query, origin, query.includeHistory) && !!evidence && this.sourceVisible(query, asRow(evidence));
          }
          if (validRelation) {
            if (items.length === query.limit) { hasMore = true; break; }
            items.push({ memory: this.observedMemory(query, memory), reasons: row.origin_id ? ['relation:' + row.relation_type]
              : [query.subject && memory.subject === query.subject ? 'subject' : '', query.factKey && memory.factKey === query.factKey ? 'fact' : '', query.eventId && memory.eventId === query.eventId ? 'event' : '', terms.length ? 'fulltext/alias' : 'browse'].filter(Boolean),
              path: row.origin_id ? [String(row.origin_id), memory.id] : [memory.id] });
          }
        }
        examined++;
      }
      if (hasMore || batch.length < 128) break;
    }
    return { items, hasMore, nextCursor: hasMore ? examined : undefined };
  }

  private fulltextMatch(terms: string[]): string {
    const characters = terms.map(term => companionSearchMatch(term)).filter(Boolean).join(' OR ');
    const words = terms.flatMap(term => this.queryTerms(term)).map(term => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
    return [characters ? 'tokens: (' + characters + ')' : '', words ? 'terms: (' + words + ')' : ''].filter(Boolean).join(' OR ');
  }

  sourcesSearch(input: CompanionMemorySearch): { memorySources: CompanionMessage[]; hasMore: boolean; sourceHasMore: boolean; sourceNextCursor?: number } {
    const query = companionMemorySearchSchema.parse(input), conversation = this.requireScope(query);
    const terms = [...new Set([...query.terms, ...this.queryTerms(query.query)])];
    if (!terms.length) return { memorySources: [], hasMore: false, sourceHasMore: false };
    const match = terms.map(term => companionSearchMatch(term)).filter(Boolean).join(' OR ');
    const conditions = ['o.companion_id=?'], values: unknown[] = [match, query.companionId];
    if (conversation.kind === 'group') { conditions.push('m.conversation_id=?'); values.push(query.conversationId); }
    if (query.beforeSequence !== undefined) { conditions.push('m.sequence<=?'); values.push(query.beforeSequence); }
    if (query.from) { conditions.push('m.created_at>=?'); values.push(query.from); }
    if (query.to) { conditions.push('m.created_at<=?'); values.push(query.to); }
    const statement = this.db.prepare(`WITH ranked AS MATERIALIZED (SELECT rowid,bm25(message_search,1.0,0.0) AS score FROM message_search WHERE message_search MATCH ?)
      SELECT m.* FROM ranked f JOIN messages m ON m.sequence=f.rowid JOIN memory_observers o ON o.message_id=m.id WHERE ${conditions.join(' AND ')} ORDER BY f.score,m.sequence DESC LIMIT ? OFFSET ?`);
    const memorySources: CompanionMessage[] = []; let examined = query.sourceCursor ?? 0, hasMore = false;
    for (;;) {
      const batch = asRows(statement.all(...values, 128, examined));
      if (!batch.length) break;
      for (const row of batch) {
        if (this.sourceVisible(query, row)) {
          if (memorySources.length === query.limit) { hasMore = true; break; }
          memorySources.push(this.getMessage(String(row.id)));
        }
        examined++;
      }
      if (hasMore || batch.length < 128) break;
    }
    return { memorySources, hasMore, sourceHasMore: hasMore, sourceNextCursor: hasMore ? examined : undefined };
  }

  sourcesFilter(scope: Scope, ids: string[]): CompanionMessage[] {
    this.requireScope(scope);
    return ids.flatMap(id => { const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id); return source && this.sourceVisible(scope, asRow(source)) ? [this.getMessage(id)] : []; });
  }

  read(scope: Scope, id: string, sourceLimit = 30, sourceCursor = 0): NonNullable<CompanionStorageResponse['memoryRead']> {
    const memory = this.observedMemory(scope, this.load(id));
    if (!this.visible(scope, memory, true)) throw new Error('记忆已失效或不属于当前可见范围。');
    const sources = memory.sources ?? [], windows = new Map<string, CompanionMessage>();
    for (const source of sources.slice(sourceCursor, sourceCursor + sourceLimit)) {
      const nearby = asRows(this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sequence>=? AND sequence<=? ORDER BY sequence LIMIT 9').all(source.conversationId, Math.max(0, source.sequence - 3), source.sequence + 3));
      for (const item of nearby) if (this.sourceVisible(scope, item)) windows.set(String(item.id), this.getMessage(String(item.id)));
    }
    const related = asRows(this.db.prepare('SELECT from_id,to_id FROM memory_relations WHERE from_id=? OR to_id=? LIMIT 100').all(id, id))
      .map(edge => this.load(String(edge.from_id === id ? edge.to_id : edge.from_id))).filter(memory => this.visible(scope, memory, true)).map(memory => this.observedMemory(scope, memory));
    const next = sourceCursor + sourceLimit;
    return { memory, sources: [...windows.values()].sort((a, b) => a.sequence - b.sequence), related: [...new Map(related.map(item => [item.id, item])).values()], hasMore: next < sources.length, nextSourceCursor: next < sources.length ? next : undefined };
  }

  inspect(scope: Scope, id: string, sourceLimit = 30, sourceCursor = 0): NonNullable<CompanionStorageResponse['memoryRead']> {
    const conversation = this.requireScope(scope), memory = this.load(id);
    if (memory.companionId !== scope.companionId || (conversation.kind === 'group' && memory.sourceConversationId !== scope.conversationId)) throw new Error('记忆不属于当前管理范围。');
    if (memory.status === 'forgotten') return { memory: { ...memory, content: '已遗忘的记忆', value: undefined, subject: undefined, factKey: undefined, tags: [], sources: [], sourceMessageId: undefined }, sources: [], related: [], hasMore: false };
    const sources = memory.sources ?? [], next = sourceCursor + sourceLimit;
    const related = memory.supersedesId ? [this.load(memory.supersedesId)].filter(item => item.companionId === scope.companionId && item.status !== 'forgotten') : [];
    return { memory, sources: this.sourcesFilter(scope, sources.slice(sourceCursor, next).map(source => source.messageId)), related,
      hasMore: next < sources.length, nextSourceCursor: next < sources.length ? next : undefined };
  }

  list(companionId: string): CompanionMemory[] {
    const found = asRows(this.db.prepare('SELECT m.data FROM memories m JOIN memory_records r ON r.memory_id=m.id WHERE r.companion_id=? AND r.status NOT IN (\'forgotten\',\'invalid\',\'superseded\') ORDER BY r.ordinal DESC LIMIT 500').all(companionId));
    return found.map(item => decode<CompanionMemory>(item.data));
  }

  browse(input: CompanionMemorySearch): CompanionMemoryPage {
    const query = companionMemorySearchSchema.parse(input), conversation = this.requireScope(query);
    const filters = ['r.companion_id=?'], values: unknown[] = [query.companionId];
    if (conversation.kind === 'group') { filters.push('r.conversation_id=?'); values.push(query.conversationId); }
    if (query.status) { filters.push('r.status=?'); values.push(query.status); }
    else if (!query.includeHistory) filters.push("r.status='active'");
    if (query.kind) { filters.push('r.kind=?'); values.push(query.kind); }
    if (query.query.trim()) {
      const match = this.queryTerms(query.query).map(companionSearchMatch).filter(Boolean).join(' OR ');
      if (match) { filters.push('r.ordinal IN (SELECT rowid FROM memory_search WHERE memory_search MATCH ?)'); values.push(match); }
    }
    const found = asRows(this.db.prepare(`SELECT m.data FROM memory_records r JOIN memories m ON m.id=r.memory_id WHERE ${filters.join(' AND ')} ORDER BY r.ordinal DESC LIMIT ? OFFSET ?`).all(...values, query.limit + 1, query.cursor ?? 0));
    return { items: found.slice(0, query.limit).map(item => {
      const original = decode<CompanionMemory>(item.data);
      const memory = original.status === 'forgotten' ? { ...original, content: '已遗忘的记忆', value: undefined, subject: undefined, factKey: undefined, qualifier: undefined, tags: [], sources: [], sourceMessageId: undefined } : original;
      return { memory, reasons: ['management'], path: [memory.id] };
    }), hasMore: found.length > query.limit, nextCursor: found.length > query.limit ? (query.cursor ?? 0) + query.limit : undefined };
  }

  forget(input: Extract<CompanionStorageCommand, { type: 'memory.forget' }>): number {
    const query = companionMemoryForgetSchema.parse(input);
    return this.db.transaction(() => {
      this.requireScope(query);
      if (!query.id && !query.sourceMessageIds.length && !query.subject && !query.factKey && !query.tag) throw new Error('需要指定遗忘对象。');
      if (query.requestMessageId) {
        const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(query.requestMessageId);
        if (!source || asRow(source).author_id !== 'user' || !this.sourceVisible(query, asRow(source))) throw new Error('遗忘需要当前用户请求作为依据。');
        const content = String(asRow(source).content);
        const negated = /(?:别|不要|不许|不能)忘|do not forget|don't forget/iu.test(content);
        const question = /你(?:还|又|是不是)?忘|忘.*[吗？?]|(?:did|do|have) you forget/iu.test(content);
        const requested = /(?:请|帮我|麻烦你|把|将).*(?:忘(?:记|掉|了|却)?|删(?:掉|除).*(?:记忆|记录))|^(?:忘掉|忘记|删(?:掉|除).*(?:记忆|记录))|(?:以后|今后|不再|不要|别).*(?:记录|保存|记住)|^(?:please\s+)?forget\b|do not (?:remember|record|save)/iu.test(content);
        if (negated || question || !requested) throw new Error('用户没有明确要求遗忘，伙伴不能自行删除记忆。');
        if (query.persistent && !/以后|今后|从今|不再|不要再|再也|never|from now on|do not (?:remember|record|save)/iu.test(content)) throw new Error('持续禁止记录需要用户明确的持续要求。');
      }
      let sources = query.sourceMessageIds;
      const targetConversations = new Set<string>();
      for (const id of sources) {
        const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
        if (!source || !this.sourceVisible(query, asRow(source))) throw new Error('遗忘来源不属于当前可见范围。');
        targetConversations.add(String(asRow(source).conversation_id));
      }
      if (query.id) {
        const memory = this.load(query.id);
        const conversation = this.requireScope(query);
        if (memory.companionId !== query.companionId || (conversation.kind === 'group' && memory.sourceConversationId !== query.conversationId)) throw new Error('遗忘对象不属于当前管理范围。');
        targetConversations.add(memory.sourceConversationId ?? query.conversationId);
        sources = [...new Set([...sources, ...(memory.sources ?? []).map(source => source.messageId)])];
      }
      const through = query.beforeSequence ?? Number(asRow(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM messages').get()).seq);
      if (!targetConversations.size) targetConversations.add(query.conversationId);
      for (const targetConversationId of targetConversations) this.db.prepare('INSERT INTO memory_forget_rules(id,companion_id,conversation_id,memory_id,source_message_ids,subject,fact_key,tag,through_sequence,persistent,request_message_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), query.companionId, targetConversationId, query.id ?? null, JSON.stringify(sources), query.subject ?? null, query.factKey ?? null, query.tag ?? null, through, Number(query.persistent), query.requestMessageId ?? null, stamp());
      let count = 0;
      const withdrawnSources = new Set<string>(sources);
      for (const found of asRows(this.db.prepare('SELECT data FROM memories WHERE companion_id=?').all(query.companionId))) {
        const memory = decode<CompanionMemory>(found.data);
        if (memory.status !== 'forgotten' && this.blocked(query, memory)) { memory.status = 'forgotten'; memory.updatedAt = stamp(); memory.version = (memory.version ?? 1) + 1; this.persist(memory); this.invalidateDependents(memory.id, new Set(), true); for (const source of memory.sources ?? []) withdrawnSources.add(source.messageId); count++; }
      }
      this.withdrawStateSources?.(query.companionId, [...withdrawnSources]);
      return count;
    }).immediate();
  }

  delete(id: string): void {
    const memory = this.load(id);
    if (!memory.sourceConversationId) { memory.status = 'forgotten'; this.persist(memory); return; }
    this.forget({ type: 'memory.forget', companionId: memory.companionId, conversationId: memory.sourceConversationId, id });
  }

  organize(scope: Scope, ids: string[], tags: NonNullable<CompanionMemoryCandidate['tags']>, eventId?: string): CompanionMemory[] {
    return this.db.transaction(() => {
      const memories = ids.map(id => this.load(id));
      if (memories.some(memory => !this.visible(scope, memory, true))) throw new Error('整理包含不可见或失效的记忆。');
      const before = JSON.stringify(memories);
      for (const memory of memories) { memory.version = (memory.version ?? 1) + 1; memory.updatedAt = stamp(); if (eventId) memory.eventId = eventId; this.applyTags(memory, tags); }
      this.db.prepare('INSERT INTO memory_operations(id,companion_id,type,before_data,after_data,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), scope.companionId, 'organize', before, JSON.stringify(memories), stamp());
      return memories;
    }).immediate();
  }

  status(companionId: string, conversationId?: string): NonNullable<CompanionStorageResponse['memoryStatus']> {
    const conversation = conversationId ? this.requireScope({ companionId, conversationId }) : undefined;
    const group = conversation?.kind === 'group';
    const filter = 'companion_id=?' + (group ? ' AND conversation_id=?' : ''), values = group ? [companionId, conversationId] : [companionId];
    const counts = new Map(asRows(this.db.prepare(`SELECT status,count(*) AS n FROM memory_jobs WHERE ${filter} GROUP BY status`).all(...values)).map(row => [String(row.status), Number(row.n)]));
    const pendingSeq = this.db.prepare(`SELECT MIN(source_sequence) AS seq FROM memory_jobs WHERE ${filter} AND status!='done'`).get(...values);
    const maxSeq = Number(asRow(this.db.prepare(`SELECT COALESCE(MAX(source_sequence),0) AS seq FROM memory_jobs WHERE ${filter}`).get(...values)).seq);
    const pending = asRow(pendingSeq).seq;
    const error = this.db.prepare(`SELECT error FROM memory_jobs WHERE ${filter} AND error IS NOT NULL ORDER BY ordinal DESC LIMIT 1`).get(...values);
    return { pending: counts.get('pending') ?? 0, running: counts.get('running') ?? 0, failed: counts.get('failed') ?? 0, completed: counts.get('done') ?? 0,
      memories: Number(asRow(this.db.prepare(`SELECT count(*) AS n FROM memory_records WHERE ${filter} AND status='active'`).get(...values)).n),
      forgotten: Number(asRow(this.db.prepare(`SELECT count(*) AS n FROM memory_records WHERE ${filter} AND status='forgotten'`).get(...values)).n),
      messageWatermark: maxSeq, extractionWatermark: pending === null ? maxSeq : Math.max(0, Number(pending) - 1),
      backfillThrough: group ? maxSeq : Number(asRow(this.db.prepare("SELECT value FROM metadata WHERE key='memory-backfill-through'").get()).value),
      backfillTarget: group ? maxSeq : Number(asRow(this.db.prepare("SELECT value FROM metadata WHERE key='memory-backfill-target'").get()).value),
      lastError: error ? String(asRow(error).error) : undefined };
  }

  rebuildIndex(): number {
    return this.db.transaction(() => {
      this.db.exec("DROP TABLE IF EXISTS memory_search; CREATE VIRTUAL TABLE memory_search USING fts5(tokens,terms,content='',contentless_delete=1)");
      const memories = asRows(this.db.prepare('SELECT data FROM memories').all());
      for (const item of memories) this.persist(decode<CompanionMemory>(item.data));
      return memories.length;
    }).immediate();
  }

  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'memory.jobs.backfill': return { ok: true, backfillComplete: this.backfill(command.limit) };
      case 'memory.index.rebuild': return { ok: true, rebuiltCount: this.rebuildIndex() };
      case 'memory.jobs.claim': return { ok: true, memoryJob: this.claim(command.companionId, command.leaseMs) };
      case 'memory.jobs.complete': return { ok: true, memories: this.complete(command.id, command.leaseToken, command.candidates, command.stateProposal) };
      case 'memory.jobs.fail': this.fail(command.id, command.leaseToken, command.error, command.retryAfterMs); return { ok: true };
      case 'memory.jobs.retry': this.retry(command.companionId); return { ok: true };
      case 'memory.status': return { ok: true, memoryStatus: this.status(command.companionId, command.conversationId) };
      case 'memory.search': return { ok: true, memoryPage: this.search(command) };
      case 'memory.browse': return { ok: true, memoryPage: this.browse(command) };
      case 'memory.sources.search': return { ok: true, ...this.sourcesSearch(command) };
      case 'memory.sources.filter': return { ok: true, memorySources: this.sourcesFilter(command, command.ids) };
      case 'memory.records.filter': return { ok: true, memories: command.ids.flatMap(id => { const memory = this.load(id); return this.visible(command, memory, command.includeHistory) ? [this.observedMemory(command, memory)] : []; }) };
      case 'memory.read': return { ok: true, memoryRead: this.read(command, command.id, command.sourceLimit, command.sourceCursor) };
      case 'memory.inspect': return { ok: true, memoryRead: this.inspect(command, command.id, command.sourceLimit, command.sourceCursor) };
      case 'memory.record': { const memory = this.record(command, command.candidate); return { ok: true, memories: memory ? [memory] : [] }; }
      case 'memory.revise': { const memory = this.record(command, command.candidate, command); return { ok: true, memories: memory ? [memory] : [] }; }
      case 'memory.organize': return { ok: true, memories: this.organize(command, command.ids, command.tags ?? [], command.eventId) };
      case 'memory.forget': return { ok: true, forgottenCount: this.forget(command) };
      default: return undefined;
    }
  }
}
