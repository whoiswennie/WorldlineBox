import { assertCompanionInboxCapacity, companionAttentionCanClaim } from './attention-queue';
import { createHash, randomUUID } from 'node:crypto';
import type { CompanionContactState } from '../shared/companion-contact';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import type { AppendCompanionMessage, CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionWorldScope } from '../shared/companion-world';
import type { CompanionSocialConversation, CompanionSocialConversationPage, CompanionSocialMessage, CompanionSocialMessagePage, CompanionSocialDays, CompanionSocialJob, CompanionSocialFlowPage, CompanionSocialFlowEvent, CompanionSocialGraph } from '../shared/companion-social';
import { companionSearchTokens, companionSearchMatch } from '../shared/companion-search';
import { companionCivilInstantInZone, companionTimeInZone } from '../shared/companion-schedule-time';
import { CompanionSocialContinuityStore } from './social-continuity-store';
import { initializeSocialFlowIndex, recentSocialFacts, recentSocialMessageCounts, visibleSocialTopic } from './social-flow-index';
import { CompanionSocialReplyStore } from './social-reply-store';
import { COMPANION_CHARACTER_RELATIONS } from '../shared/companion-character-relations';
import { companionSocialGameContext } from './social-game-context';
import { companionSocialGoalOrigin, companionSocialDelegatedPortOrigin } from './social-goal-origin';
import type { CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import { companionAcceptedPeerActivitySchema, type CompanionAcceptedPeerActivity, type CompanionPeerActivityAcceptanceInput } from '../shared/companion-peer-activity';
import { companionPeerActivitySourceChecksum } from './peer-activity-source';
import type { CompanionPeerThoughtAuthorization } from '../shared/companion-activity-thought';

type Row = Record<string, string | number | null>;
type Calendar = { timeZone: string; virtualNow: string; observedDay: string; backlog: boolean };
type Send = { urgent?: boolean; companionId: string; conversationId: string; content: string; channel: 'phone' | 'face_to_face'; sourceMessageId?: string; authorizationMessageId?: string; replyToId?: string; clientId: string; shareAddress?: boolean; topicId?: string | null; agentSource?: { conversationId: string; messageId: string }; executionReadset?: CompanionExecutionReadset };
type PendingSend = Send & { fingerprint: string; authorizationChecksum?: string; sourceChecksum?: string; agentChecksum?: string; typingNotBefore?: string; originId?: string; originFromAgentSource?: boolean };
type Read = { id: string; checksum: string };
type ActivityReplyProof = { taskId: string; ownerId: string; taskConversationId: string; taskSourceMessageId?: string; taskSourceChecksum?: string;
  sourceMessageId: string; sourceChecksum: string; conversationId: string; topicId?: string; targetId: string; parentChainId?: string };
type StoredJob = CompanionSocialJob & { readSet?: Read[]; resultMessageId?: string; acceptedActivity?: CompanionAcceptedPeerActivity; replyOpportunity?: ActivityReplyProof; round: 'pair' | 'first' | 'summary' | 'followup' };
type ChainData = { kind: 'pair' | 'group'; initiatorId: string; recipientIds: string[]; phase: 'first' | 'summary' | 'followup' | 'done'; maxMessages: number; replyReservations?: Record<string, string> };
export type CompanionPeerWorkInput = CompanionPeerActivityAcceptanceInput & { accept: boolean; mode?: 'activity' };
const iso = (at = Date.now()) => new Date(at).toISOString();
const row = (value: unknown) => value as Row;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checksum = (message: CompanionMessage) => hash([message.id, message.conversationId, message.topicId, message.authorId, message.content, message.status, message.replyToId]);
const dayAt = (at: number, zone: string) => { const date = companionTimeInZone(at, zone); return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`; };
const invalidSendPort = '本次未发送：目标会话或话题端口对本人无效，请核对目标入口后重新发送。';

/** Peer rooms use the existing formal message authority; scheduling drafts never become evidence. */
export class CompanionSocialStore {
  readonly continuity: CompanionSocialContinuityStore;
  private readonly replies: CompanionSocialReplyStore;
  constructor(private readonly db: CompanionConnection,
    private readonly append: (input: AppendCompanionMessage) => CompanionMessage,
    private readonly message: (id: string) => CompanionMessage,
    private readonly visible: (scope: CompanionWorldScope, ids: string[]) => CompanionMessage[],
    private readonly calendar: () => Calendar,
    private readonly available: (owner: string, channel: Send['channel'], recipients: string[]) => boolean,
    private readonly speech: (message: CompanionSocialMessage, channel: Send['channel']) => void,
    private readonly clock: { elapsedVirtual(from: number, to: number): number } = { elapsedVirtual: (from, to) => to - from },
    private readonly options: { observationCalendar?(): Calendar; memoryRevision?(scope: { companionId: string; conversationId: string; beforeSequence: number }): string; interrupt?(owner: string, source: CompanionSocialMessage): void; endInterrupt?(owner: string, sourceId: string): void; contactState?(owner: string): CompanionContactState; createPeerWork?(input: CompanionPeerWorkInput): { activityTaskId: string } | void; addressText?(owner: string): string; shareHome?(owner: string, recipients: string[], source: CompanionMessage): void; createPlayerGroup?(title: string, members: string[]): { id: string }; topicExecute?(command: Extract<CompanionStorageCommand, { type: `topic.${string}` }>): CompanionStorageResponse | undefined; activityTaskValid?(id: string, owner: string, conversationId: string): boolean } = {}) {
    this.continuity = new CompanionSocialContinuityStore(db, append, message, visible,
      owner => available(owner, 'phone', []), () => calendar().backlog);
    this.replies = new CompanionSocialReplyStore(db);
  }
  private observationCalendar(): Calendar { return this.options.observationCalendar?.() ?? this.calendar(); }
  /** Preserve the exact host-read dependencies and add the actual causal
   * source(s). Storage's append transaction validates each source as its sender,
   * never by granting the recipient access to a human private room. */
  private executionSources(owner: string, room: string, ids: string[], provided?: CompanionExecutionReadset, beforeSequence?: number): CompanionExecutionReadset | undefined {
    if (!ids.length && !provided) return;
    if (provided && (provided.companionId !== owner || provided.conversationId !== room || !provided.complete)) throw new Error('社交发信的执行读集归属或覆盖不完整。');
    const readset: CompanionExecutionReadset = provided ?? { schema: 'worldlinebox.companion-execution-readset-v1', companionId: owner,
      conversationId: room, ...(beforeSequence !== undefined ? { beforeSequence } : {}), complete: true, sources: [], memories: [], topics: [], contexts: [], knowledgeReads: [] };
    const sources = new Map<string, CompanionExecutionReadset['sources'][number]>();
    for (const source of readset.sources) {
      const previous = sources.get(source.id);
      if (previous && (previous.checksum !== source.checksum || previous.conversationId !== source.conversationId)) throw new Error('社交发信读集含同一来源的冲突版本。');
      sources.set(source.id, source);
    }
    for (const id of new Set(ids)) {
      const message = this.message(id), ref = { id: message.id, conversationId: message.conversationId, checksum: createHash('sha256').update(message.content).digest('hex') };
      const previous = sources.get(id);
      if (previous && (previous.checksum !== ref.checksum || previous.conversationId !== ref.conversationId)) throw new Error('社交发信所读来源已经变化，不能替换旧读集。');
      sources.set(id, ref);
    }
    return { ...readset, sources: [...sources.values()] };
  }

  initialize(): void {
    this.continuity.initialize();
    this.db.exec('DROP INDEX IF EXISTS companion_world_observer_flow; DROP INDEX IF EXISTS companion_world_observer_flow_v2');
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_social_conversations(id TEXT PRIMARY KEY REFERENCES conversations(id),member_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS companion_social_messages(message_id TEXT PRIMARY KEY REFERENCES messages(id),conversation_id TEXT NOT NULL REFERENCES companion_social_conversations(id),sequence INTEGER NOT NULL UNIQUE,virtual_at TEXT NOT NULL,recipient_ids TEXT NOT NULL,channel TEXT);
      CREATE INDEX IF NOT EXISTS companion_social_message_time ON companion_social_messages(virtual_at,conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS companion_social_message_room ON companion_social_messages(conversation_id,sequence DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS companion_social_search USING fts5(content,title,tokenize='ascii');
      CREATE VIRTUAL TABLE IF NOT EXISTS companion_social_room_search USING fts5(id UNINDEXED,title,tokenize='ascii');
      CREATE TABLE IF NOT EXISTS companion_social_outbox(client_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,message_id TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_outbox_pending ON companion_social_outbox(status,created_at);
      CREATE INDEX IF NOT EXISTS companion_social_outbox_owner ON companion_social_outbox(companion_id,status);
      CREATE TABLE IF NOT EXISTS companion_social_chains(id TEXT PRIMARY KEY,used INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS companion_social_jobs(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,status TEXT NOT NULL,lease_until TEXT,created_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_job_claim ON companion_social_jobs(status,lease_until,created_at);
      CREATE INDEX IF NOT EXISTS companion_social_job_owner ON companion_social_jobs(companion_id,status);
      CREATE TABLE IF NOT EXISTS companion_social_budget(message_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,kind TEXT NOT NULL,virtual_at TEXT NOT NULL,real_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_budget_owner ON companion_social_budget(companion_id,kind,virtual_at DESC);`);
    this.replies.initialize();
    if (!(this.db.prepare('PRAGMA table_info(companion_social_chains)').all() as Row[]).some(column => column.name === 'data')) this.db.exec("ALTER TABLE companion_social_chains ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_social_job_chain_round ON companion_social_jobs(json_extract(data,'$.chainId'),json_extract(data,'$.round'),status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_social_job_source ON companion_social_jobs(conversation_id,json_extract(data,'$.sourceMessageId'),companion_id); CREATE INDEX IF NOT EXISTS companion_social_job_result ON companion_social_jobs(json_extract(data,'$.resultMessageId')); CREATE INDEX IF NOT EXISTS companion_social_job_reader_sequence ON companion_social_jobs(companion_id,conversation_id,json_extract(data,'$.throughSequence'))");
    if (!(this.db.prepare('PRAGMA table_info(companion_social_messages)').all() as Row[]).some(column => column.name === 'channel')) this.db.exec('ALTER TABLE companion_social_messages ADD COLUMN channel TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_social_member_owner ON conversation_members(companion_id,conversation_id); CREATE INDEX IF NOT EXISTS companion_social_room_virtual ON companion_social_messages(conversation_id,virtual_at DESC,message_id)');
    this.db.exec('CREATE TABLE IF NOT EXISTS companion_social_communication(companion_id TEXT PRIMARY KEY,until_real TEXT NOT NULL,data TEXT NOT NULL)');
    this.db.function('companion_social_day', { deterministic: true }, value => { const [at, zone] = parse<[string, string]>(value); return dayAt(Date.parse(at), zone); });
    // Register authoritative peer rooms and reconstruct only their derived search/calendar index.
    for (const existing of this.db.prepare("SELECT c.id FROM conversations c JOIN metadata d ON d.key='world-room/'||c.id WHERE c.dissolved_at IS NULL AND (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id=c.id)>=2").all() as Row[]) {
      const members = this.members(String(existing.id));
      if (!members.every(id => this.exists(id))) continue;
      this.db.prepare('INSERT OR IGNORE INTO companion_social_conversations(id,member_key) VALUES(?,?)').run(existing.id, members.join('|'));
    }
    this.db.transaction(() => { this.db.prepare('DELETE FROM companion_social_room_search').run(); for (const value of this.db.prepare('SELECT c.id,c.title FROM companion_social_conversations s JOIN conversations c ON c.id=s.id').all() as Row[]) this.db.prepare('INSERT INTO companion_social_room_search(id,title) VALUES(?,?)').run(value.id, companionSearchTokens(String(value.title))); }).immediate();
    for (const existing of this.db.prepare('SELECT m.id,m.created_at,m.conversation_id FROM messages m JOIN companion_social_conversations c ON c.id=m.conversation_id LEFT JOIN companion_social_messages s ON s.message_id=m.id WHERE s.message_id IS NULL ORDER BY m.sequence').all() as Row[]) {
      const evidence = this.db.prepare("SELECT json_extract(data,'$.at') AS at FROM companion_world_events WHERE json_extract(data,'$.sourceMessageId')=? LIMIT 1").get(existing.id);
      const message = this.message(String(existing.id));
      if (message.kind === 'text' && message.status === 'sent' && !message.isReplyDraft && this.members(message.conversationId).includes(message.authorId)) this.index(message, String(evidence ? row(evidence).at : existing.created_at), this.members(message.conversationId).filter(id => id !== message.authorId));
    }
    const count = Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM companion_social_search').get()).n);
    if (count !== Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM companion_social_messages').get()).n)) {
      this.db.transaction(() => { this.db.prepare('DELETE FROM companion_social_search').run();
        for (const entry of this.db.prepare('SELECT s.sequence,m.content,c.title FROM companion_social_messages s JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=s.conversation_id').all() as Row[]) this.db.prepare('INSERT INTO companion_social_search(rowid,content,title) VALUES(?,?,?)').run(entry.sequence, companionSearchTokens(String(entry.content)), companionSearchTokens(String(entry.title)));
      }).immediate();
    }
    initializeSocialFlowIndex(this.db);
  }
  private exists(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM companions c WHERE id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed')").get(id); }
  private activated(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM companions c WHERE id=? AND deleted_at IS NULL AND json_extract(data,'$.active')=1 AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed')").get(id);
  }
  private participantsActivated(members: string[]): boolean { return members.every(id => this.activated(id)); }
  /** Stop live work when a participant is manually deactivated; retain the real conversation history. */
  stopInactive(id: string): void {
    const rooms = (this.db.prepare('SELECT s.id FROM companion_social_conversations s JOIN conversation_members m ON m.conversation_id=s.id WHERE m.companion_id=?').all(id) as Row[]).map(value => String(value.id));
    for (const conversationId of rooms) {
      this.db.prepare("UPDATE companion_social_outbox SET status='cancelled' WHERE conversation_id=? AND status='pending'").run(conversationId);
      for (const value of this.db.prepare("SELECT data FROM companion_social_jobs WHERE conversation_id=? AND status IN('pending','running','failed')").all(conversationId) as Row[]) {
        const job = parse<StoredJob>(value.data); job.status = 'cancelled'; delete job.leaseToken; delete job.readSet; this.saveJob(job);
        this.db.prepare("UPDATE companion_social_chains SET status='done' WHERE id=?").run(job.chainId);
        if (job.urgent) this.options.endInterrupt?.(job.companionId, job.sourceMessageId);
      }
      this.db.prepare("DELETE FROM companion_social_communication WHERE json_extract(data,'$.conversationId')=?").run(conversationId);
    }
  }
  private members(id: string): string[] { return (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id').all(id) as Row[]).map(value => String(value.companion_id)); }
  private cancelPlayerRoomWork(id: string): void {
    this.db.prepare("UPDATE companion_social_outbox SET status='cancelled' WHERE conversation_id=? AND status='pending'").run(id);
    for (const value of this.db.prepare("SELECT data FROM companion_social_jobs WHERE conversation_id=? AND status IN('pending','running','failed')").all(id) as Row[]) {
      const job = parse<StoredJob>(value.data); job.status = 'cancelled'; delete job.leaseToken; delete job.readSet; this.saveJob(job);
      this.db.prepare("UPDATE companion_social_chains SET status='done' WHERE id=?").run(job.chainId);
      if (job.urgent) this.options.endInterrupt?.(job.companionId, job.sourceMessageId);
    }
    this.db.prepare("DELETE FROM companion_social_communication WHERE json_extract(data,'$.conversationId')=?").run(id);
  }
  /** A formal user-room greeting is indexed without changing who owns the
   * room. UI edits keep prior recipients/observers as immutable history. */
  syncPlayerRoom(id: string, audienceChanged = false): void {
    if (this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + id)) return;
    const found = this.db.prepare('SELECT c.title FROM companion_social_conversations s JOIN conversations c ON c.id=s.id WHERE s.id=?').get(id);
    if (!found) return;
    if (audienceChanged) this.cancelPlayerRoomWork(id);
    const key = 'player|' + this.members(id).join('|');
    const occupied = this.db.prepare('SELECT id FROM companion_social_conversations WHERE member_key=? AND id!=?').get(key, id);
    this.db.prepare('UPDATE companion_social_conversations SET member_key=? WHERE id=?').run(occupied ? 'player-instance|' + id : key, id);
    this.db.prepare('DELETE FROM companion_social_room_search WHERE id=?').run(id);
    const title = companionSearchTokens(String(row(found).title));
    this.db.prepare('INSERT INTO companion_social_room_search(id,title) VALUES(?,?)').run(id, title);
    this.db.prepare('UPDATE companion_social_search SET title=? WHERE rowid IN(SELECT sequence FROM companion_social_messages WHERE conversation_id=?)').run(title, id);
  }
  /** Only the existing user-room coalescer calls this, in its transaction. */
  rehomePlayerRoom(sourceId: string, targetId: string): void {
    if (this.db.prepare('SELECT 1 FROM metadata WHERE key IN(?,?)').get('world-room/' + sourceId, 'world-room/' + targetId)) throw new Error('真实伙伴社交入口不能通过用户群成员编辑合并。');
    if (!this.db.prepare('SELECT 1 FROM companion_social_conversations WHERE id=?').get(sourceId)) return;
    this.cancelPlayerRoomWork(sourceId); this.cancelPlayerRoomWork(targetId);
    this.db.prepare('INSERT OR IGNORE INTO companion_social_conversations(id,member_key) VALUES(?,?)').run(targetId, 'player-instance|' + targetId);
    this.db.prepare('UPDATE companion_social_messages SET conversation_id=? WHERE conversation_id=?').run(targetId, sourceId);
    this.db.prepare('DELETE FROM companion_social_room_search WHERE id=?').run(sourceId);
    this.db.prepare('DELETE FROM companion_social_conversations WHERE id=?').run(sourceId);
    this.syncPlayerRoom(targetId);
  }
  private requireRoom(id: string, owner?: string): string[] {
    const exists = this.db.prepare('SELECT 1 FROM companion_social_conversations s JOIN conversations c ON c.id=s.id WHERE s.id=? AND c.dissolved_at IS NULL').get(id);
    const members = this.members(id);
    if (!exists || members.length < 2 || !members.every(member => this.exists(member)) || owner && !members.includes(owner)) throw new Error('这不是当前伙伴之间的有效社交会话。');
    return members;
  }
  ensure(owner: string, ids: string[], title = ''): CompanionSocialConversation {
    return this.db.transaction(() => {
      const members = [...new Set(ids)].sort();
      if (members.length < 2 || members.length !== ids.length || !members.includes(owner) || !members.every(id => this.exists(id))) throw new Error('社交会话必须由至少两位真实伙伴组成。');
      const key = members.join('|'), existing = this.db.prepare('SELECT id FROM companion_social_conversations WHERE member_key=?').get(key);
      if (existing) return this.conversation(String(row(existing).id));
      const baseId = (members.length === 2 ? 'world_pair_' : 'world_group_') + createHash('sha256').update(key).digest('hex').slice(0, 24);
      const id = this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(baseId) ? baseId + '_' + randomUUID().slice(0, 8) : baseId;
      const names = members.map(member => String(row(this.db.prepare("SELECT json_extract(data,'$.name') AS name FROM companions WHERE id=?").get(member)).name));
      this.db.prepare("INSERT OR IGNORE INTO conversations(id,kind,title,private_companion_id,updated_at,hidden_at) VALUES(?,'group',?,NULL,?,?)").run(id, title || names.join('、').slice(0, 100), iso(), iso());
      this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('world-room/' + id, 'true');
      for (const member of members) this.db.prepare('INSERT OR IGNORE INTO conversation_members(conversation_id,companion_id) VALUES(?,?)').run(id, member);
      this.db.prepare('INSERT INTO companion_social_conversations(id,member_key) VALUES(?,?)').run(id, key);
      this.db.prepare('INSERT INTO companion_social_room_search(id,title) VALUES(?,?)').run(id, companionSearchTokens(title || names.join('、').slice(0, 100)));
      return this.conversation(id);
    }).immediate();
  }
  /** An explicit destination preserves a goal's actual audience and topic port. */
  resolveRoom(owner: string, ids: string[], roomId?: string, title = ''): CompanionSocialConversation {
    if (!roomId) return this.ensure(owner, ids, title);
    const members = this.requireRoom(roomId, owner);
    if (new Set(ids).size !== ids.length || JSON.stringify([...ids].sort()) !== JSON.stringify(members)) throw new Error('目标群的实际伙伴成员与收件人不一致，不能隐式扩大或缩小受众。');
    return this.conversation(roomId);
  }
  /** Player presence is a room property; never forge a user-authored invitation. */
  ensurePlayerGroup(owner: string, ids: string[], title: string): CompanionSocialConversation {
    return this.db.transaction(() => {
      if (!this.options.createPlayerGroup || ids.length < 3 || !ids.includes(owner) || new Set(ids).size !== ids.length || !ids.every(id => this.activated(id))) throw new Error('建群需要本人和至少两位已激活的真实伙伴。');
      const room = this.options.createPlayerGroup(title, ids);
      this.db.prepare('INSERT OR IGNORE INTO companion_social_conversations(id,member_key) VALUES(?,?)').run(room.id, 'player|' + [...ids].sort().join('|'));
      this.db.prepare('INSERT INTO companion_social_room_search(id,title) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM companion_social_room_search WHERE id=?)').run(room.id, companionSearchTokens(title), room.id);
      return this.conversation(room.id);
    }).immediate();
  }
  private acquaintanceQuery(): string {
    const family = COMPANION_CHARACTER_RELATIONS.map(relation => `(self.id='${relation.subjectId}' AND p.id='${relation.targetId}')`).join(' OR ');
    return `WITH focus AS(SELECT ? AS id), related AS(
      SELECT peer.companion_id AS id FROM focus,conversation_members own JOIN companion_social_conversations r ON r.id=own.conversation_id
      JOIN conversations c ON c.id=r.id JOIN conversation_members peer ON peer.conversation_id=c.id
      WHERE own.companion_id=focus.id AND peer.companion_id!=focus.id AND c.dissolved_at IS NULL
      AND EXISTS(SELECT 1 FROM companion_social_messages s JOIN messages m ON m.id=s.message_id WHERE s.conversation_id=c.id AND m.status='sent' AND m.kind='text'
        AND m.sequence>COALESCE((SELECT through_sequence FROM companion_reset_boundaries boundary WHERE boundary.companion_id=focus.id),0)
        AND (m.author_id=focus.id OR EXISTS(SELECT 1 FROM json_each(s.recipient_ids) audience WHERE audience.value=focus.id))
        AND (m.author_id=peer.companion_id OR EXISTS(SELECT 1 FROM json_each(s.recipient_ids) audience WHERE audience.value=peer.companion_id)))
      AND NOT EXISTS(SELECT 1 FROM conversation_members bad JOIN companions p ON p.id=bad.companion_id WHERE bad.conversation_id=c.id AND (p.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM companion_reset_jobs j WHERE j.companion_id=p.id AND j.status!='completed')))
      UNION SELECT CASE WHEN guest_id=focus.id THEN host_id ELSE guest_id END FROM focus,companion_social_visit_contacts WHERE guest_id=focus.id OR host_id=focus.id
      UNION SELECT p.id FROM focus,companions self,companions p WHERE self.id=focus.id AND json_extract(self.data,'$.builtin')=1 AND json_extract(p.data,'$.builtin')=1 AND (${family})
    ) SELECT p.id,json_extract(p.data,'$.name') AS name,json_extract(p.data,'$.active') AS active FROM related JOIN companions p ON p.id=related.id WHERE p.id!=? AND p.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs j WHERE j.companion_id=p.id AND j.status!='completed')`;
  }
  acquaintanceIds(owner: string): Set<string> {
    if (!this.exists(owner)) throw new Error('伙伴不存在。');
    return new Set((this.db.prepare(this.acquaintanceQuery()).all(owner, owner) as Row[]).map(value => String(value.id)));
  }
  requireAcquaintances(owner: string, recipients: string[]): void {
    const known = this.acquaintanceIds(owner);
    if (!recipients.length || new Set(recipients).size !== recipients.length || recipients.includes(owner)) throw new Error('请选择本人之外的不同伙伴。');
    if (recipients.some(id => !known.has(id))) throw new Error('对方还不是你认识的伙伴。先query category=people查询公开人物，再introduce发送自己的介绍；目录查询不会自动建立熟人关系。');
  }
  /** Meeting through a player-hosted group is a real introduction too. Index
   * only formal character speech, never an empty membership list or draft. */
  observePlayerMessage(message: CompanionMessage): void {
    if (['user', 'system'].includes(message.authorId) || message.kind !== 'text' || message.status !== 'sent' || message.isReplyDraft) return;
    const room = this.db.prepare("SELECT title FROM conversations WHERE id=? AND kind='group' AND dissolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM metadata WHERE key='world-room/'||conversations.id)").get(message.conversationId);
    if (!room) return;
    const members = this.members(message.conversationId);
    if (members.length < 2 || !members.every(id => this.exists(id))) return;
    if (this.db.prepare('SELECT 1 FROM companion_social_messages WHERE message_id=?').get(message.id)) return;
    this.db.prepare('INSERT OR IGNORE INTO companion_social_conversations(id,member_key) VALUES(?,?)').run(message.conversationId, 'player|' + members.join('|'));
    this.db.prepare('INSERT INTO companion_social_room_search(id,title) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM companion_social_room_search WHERE id=?)').run(message.conversationId, companionSearchTokens(String(row(room).title)), message.conversationId);
    this.index(message, message.worldCreatedAt ?? this.calendar().virtualNow, members.filter(id => id !== message.authorId), 'phone');
  }
  private wrap(id: string): CompanionSocialMessage {
    if (!this.db.prepare('SELECT 1 FROM messages WHERE id=? AND ' + visibleSocialTopic('messages.id')).get(id)) throw new Error('社交消息不存在或所属话题已删除。');
    const found = this.db.prepare('SELECT * FROM companion_social_messages WHERE message_id=?').get(id); if (!found) throw new Error('社交消息不存在。');
    const value = row(found), progress = this.replies.receipt(id)?.progress;
    return { message: { ...this.message(id), ...(progress ? { replyProgress: progress } : {}) }, virtualCreatedAt: String(value.virtual_at), recipientIds: parse<string[]>(value.recipient_ids),
      ...(value.channel === 'phone' || value.channel === 'face_to_face' ? { channel: value.channel } : {}) };
  }
  private conversation(id: string): CompanionSocialConversation {
    const members = this.requireRoom(id), value = row(this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id));
    const latest = this.db.prepare('SELECT message_id FROM companion_social_messages WHERE conversation_id=? AND ' + visibleSocialTopic('companion_social_messages.message_id') + ' ORDER BY sequence DESC LIMIT 1').get(id);
    return { id, kind: members.length === 2 ? 'private' : 'group', title: String(value.title), memberIds: members, updatedAt: String(value.updated_at),
      messageCount: Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM companion_social_messages WHERE conversation_id=? AND ' + visibleSocialTopic('companion_social_messages.message_id')).get(id)).n), ...(latest ? { lastMessage: this.wrap(String(row(latest).message_id)) } : {}) };
  }
  private index(message: CompanionMessage, virtualAt: string, recipients: string[], channel?: Send['channel']): void {
    this.db.prepare('INSERT INTO companion_message_times(message_id,world_at,time_zone) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET world_at=excluded.world_at,time_zone=excluded.time_zone')
      .run(message.id, virtualAt, this.calendar().timeZone);
    this.db.prepare('INSERT OR IGNORE INTO companion_social_messages(message_id,conversation_id,sequence,virtual_at,recipient_ids,channel) VALUES(?,?,?,?,?,?)').run(message.id, message.conversationId, message.sequence, virtualAt, JSON.stringify(recipients), channel ?? null);
    const title = String(row(this.db.prepare('SELECT title FROM conversations WHERE id=?').get(message.conversationId)).title);
    this.db.prepare('INSERT OR REPLACE INTO companion_social_search(rowid,content,title) VALUES(?,?,?)').run(message.sequence, companionSearchTokens(message.content), companionSearchTokens(title));
    if (this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + message.conversationId)) this.db.prepare('UPDATE conversations SET hidden_at=? WHERE id=?').run(iso(), message.conversationId);
  }
  appendMessage(input: Extract<CompanionStorageCommand, { type: 'social.message.append' }>): CompanionSocialMessage {
    return this.db.transaction(() => {
      const members = this.requireRoom(input.conversationId, input.authorId), recipients = input.recipientIds ?? members.filter(id => id !== input.authorId);
      if (!recipients.length || new Set(recipients).size !== recipients.length || recipients.some(id => id === input.authorId || !members.includes(id))) throw new Error('收件人必须是同一社交会话内的其他真实伙伴。');
      const previous = this.db.prepare('SELECT id FROM messages WHERE client_id=?').get(input.clientId);
      if (previous) { const result = this.wrap(String(row(previous).id)); if (result.message.content !== input.content || result.message.authorId !== input.authorId || result.message.conversationId !== input.conversationId || result.message.replyToId !== input.replyToId || result.virtualCreatedAt !== input.virtualCreatedAt || hash(result.recipientIds) !== hash(recipients)) throw new Error('重试标识对应的社交消息已经改变。'); return result; }
      const message = this.append({ conversationId: input.conversationId, authorId: input.authorId, content: input.content, clientId: input.clientId, replyToId: input.replyToId });
      this.index(message, input.virtualCreatedAt, recipients); return this.wrap(message.id);
    }).immediate();
  }
  private range(day: string, zone: string, monthly = false): [string, string] {
    const parts = day.split('-').map(Number), start = { year: parts[0]!, month: parts[1]!, day: monthly ? 1 : parts[2]!, hour: 0, minute: 0, second: 0, millisecond: 0 };
    const next = new Date(Date.UTC(start.year, start.month - 1 + (monthly ? 1 : 0), start.day + (monthly ? 0 : 1)));
    const end = { ...start, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    return [iso(companionCivilInstantInZone(start, zone, 'next_valid')!), iso(companionCivilInstantInZone(end, zone, 'next_valid')!)];
  }
  private filter(input: { companionId?: string; day?: string; month?: string; query?: string }, context: Calendar): { where: string[]; args: unknown[] } {
    const where = ['c.dissolved_at IS NULL', visibleSocialTopic('s.message_id'), 'NOT EXISTS(SELECT 1 FROM conversation_members cm JOIN companions p ON p.id=cm.companion_id WHERE cm.conversation_id=c.id AND p.deleted_at IS NOT NULL)'], args: unknown[] = [];
    if (input.companionId) { if (!this.exists(input.companionId)) throw new Error('伙伴不存在。'); where.push('EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.companion_id=?)'); args.push(input.companionId); }
    if (input.day || input.month) { const [from, to] = this.range(input.day ?? input.month!, context.timeZone, !!input.month); where.push('s.virtual_at>=? AND s.virtual_at<?'); args.push(from, to); }
    if (input.query?.trim()) { where.push('(c.id IN(SELECT id FROM companion_social_room_search WHERE companion_social_room_search MATCH ?) OR s.sequence IN(SELECT rowid FROM companion_social_search WHERE companion_social_search MATCH ?))'); const match = companionSearchMatch(input.query); args.push(match, match); }
    return { where, args };
  }
  conversations(input: Extract<CompanionStorageCommand, { type: 'social.conversations' }>): CompanionSocialConversationPage {
    const context = this.calendar(), { where, args } = this.filter(input, context);
    const from = ' FROM companion_social_conversations r JOIN conversations c ON c.id=r.id LEFT JOIN companion_social_messages s ON s.conversation_id=c.id AND ' + visibleSocialTopic('s.message_id') + ' LEFT JOIN messages m ON m.id=s.message_id';
    const base = 'SELECT c.id,COALESCE(MAX(m.created_at),c.updated_at) AS updated_at,COUNT(s.message_id) AS message_count,MAX(s.sequence) AS latest_sequence' + from + ' WHERE ' + where.join(' AND ') + ' GROUP BY c.id';
    const total = Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM (' + base + ')').get(...args)).n);
    const cursor = input.before ? ' WHERE updated_at<? OR updated_at=? AND id<?' : '';
    if (input.before) args.push(input.before.updatedAt, input.before.updatedAt, input.before.id);
    const limit = input.limit ?? 20;
    const values = this.db.prepare('SELECT * FROM (' + base + ')' + cursor + ' ORDER BY updated_at DESC,id DESC LIMIT ?').all(...args, limit + 1) as Row[];
    const hasMore = values.length > limit, items = values.slice(0, limit).map(value => {
      const conversation = this.conversation(String(value.id));
      const last = value.latest_sequence ? this.db.prepare('SELECT message_id FROM companion_social_messages WHERE sequence=?').get(value.latest_sequence) : undefined;
      return { ...conversation, updatedAt: String(value.updated_at), messageCount: Number(value.message_count), lastMessage: last ? this.wrap(String(row(last).message_id)) : undefined };
    }), last = items.at(-1);
    return { ...context, items, total, hasMore, ...(hasMore && last ? { nextCursor: { updatedAt: last.updatedAt, id: last.id } } : {}) };
  }
  messages(input: Extract<CompanionStorageCommand, { type: 'social.messages' }>): CompanionSocialMessagePage {
    this.requireRoom(input.conversationId); const context = this.calendar(), limit = input.limit ?? 50;
    const { where, args } = this.filter(input, context); where.push('c.id=?'); args.push(input.conversationId);
    const from = ' FROM companion_social_messages s JOIN conversations c ON c.id=s.conversation_id';
    const total = Number(row(this.db.prepare('SELECT COUNT(*) AS n' + from + ' WHERE ' + where.join(' AND ')).get(...args)).n);
    if (input.around) { const found = this.db.prepare('SELECT s.sequence' + from + ' WHERE ' + where.join(' AND ') + ' AND s.message_id=?').get(...args, input.around); if (!found) throw new Error('引用消息不属于这个社交会话或当前日期与搜索范围。');
      const newer = Math.floor(limit / 2), end = this.db.prepare('SELECT s.sequence' + from + ' WHERE ' + where.join(' AND ') + ' AND s.sequence>=? ORDER BY s.sequence LIMIT 1 OFFSET ?').get(...args, row(found).sequence, newer);
      where.push('s.sequence<=?'); args.push(end ? row(end).sequence : Number.MAX_SAFE_INTEGER);
    } else if (input.before) { where.push('s.sequence<?'); args.push(input.before.sequence); }
    const entries = this.db.prepare('SELECT s.message_id,s.sequence' + from + ' WHERE ' + where.join(' AND ') + ' ORDER BY s.sequence DESC LIMIT ?').all(...args, limit + 1) as Row[];
    const hasMore = entries.length > limit, items = entries.slice(0, limit).reverse().map(value => this.wrap(String(value.message_id))), first = items[0];
    return { ...context, items, total, hasMore, ...(hasMore && first ? { nextCursor: { sequence: first.message.sequence } } : {}) };
  }
  days(input: Extract<CompanionStorageCommand, { type: 'social.days' }>): CompanionSocialDays {
    const context = this.calendar(), { where, args } = this.filter(input, context);
    // Calendar scans only the requested month through the virtual-time range index.
    const month = input.month ?? context.observedDay.slice(0, 7);
    if (!input.month) { const [from, to] = this.range(month, context.timeZone, true); where.push('s.virtual_at>=? AND s.virtual_at<?'); args.push(from, to); }
    const days = this.db.prepare("SELECT companion_social_day(json_array(s.virtual_at,?)) AS day,COUNT(*) AS messages,COUNT(DISTINCT s.conversation_id) AS rooms FROM companion_social_messages s JOIN conversations c ON c.id=s.conversation_id WHERE " + where.join(' AND ') + ' GROUP BY day ORDER BY day').all(context.timeZone, ...args) as Row[];
    return { ...context, days: days.map(value => ({ day: String(value.day), messageCount: Number(value.messages), conversationCount: Number(value.rooms) })) };
  }
  /** Human observer projection: peer messages and allowlisted physical facts only. No world loading or model work. */
  private flowEvents(roomIds: string[], members: string[], input: { day?: string; before?: { at: string; id: string }; limit?: number; focusId?: string }): Pick<CompanionSocialFlowPage, 'items' | 'hasMore' | 'nextCursor'> {
    const context = this.observationCalendar(), limit = input.limit ?? 60, placeholders = (ids: string[]) => ids.map(() => '?').join(',');
    const focusRooms = `SELECT cm.conversation_id FROM conversation_members cm JOIN companion_social_conversations r ON r.id=cm.conversation_id JOIN conversations c ON c.id=r.id WHERE cm.companion_id=? AND c.dissolved_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM conversation_members bad JOIN companions p ON p.id=bad.companion_id WHERE bad.conversation_id=c.id AND (p.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM companion_reset_jobs j WHERE j.companion_id=p.id AND j.status!='completed')))`;
    const facts = `SELECT 'm' AS source,s.message_id AS id,s.virtual_at AS at FROM companion_social_messages s JOIN messages m ON m.id=s.message_id WHERE ${visibleSocialTopic('m.id')} AND s.conversation_id IN(${input.focusId ? focusRooms : placeholders(roomIds) || 'NULL'})
      ${input.focusId ? 'AND (m.author_id=? OR EXISTS(SELECT 1 FROM json_each(s.recipient_ids) WHERE value=?))' : ''}
      UNION ALL SELECT 'w' AS source,e.id,json_extract(e.data,'$.at') AS at FROM companion_world_events e
      WHERE ${input.focusId ? "(json_extract(e.data,'$.actorId')=? OR json_extract(e.data,'$.targetId')=?)" : `json_extract(e.data,'$.actorId') IN(${placeholders(members)}) AND json_extract(e.data,'$.targetId') IN(${placeholders(members)})`}
      AND json_extract(e.data,'$.kind') IN('visit_request','visit_response','scene_depart','scene_enter','travel_blocked','visit_leave','social_interrupt','social_resume')
      AND json_extract(e.data,'$.privateOwner') IS NULL AND COALESCE(json_extract(e.data,'$.withdrawn'),0)=0`;
    const args: unknown[] = input.focusId ? [input.focusId, input.focusId, input.focusId, input.focusId, input.focusId] : [...roomIds, ...members, ...members], where: string[] = [];
    if (input.focusId) { where.push('at<=?'); args.push(context.virtualNow); }
    if (input.day) { const [from, to] = this.range(input.day, context.timeZone); where.push('at>=? AND at<?'); args.push(from, to); }
    if (input.before) { where.push('(at<? OR at=? AND id<?)'); args.push(input.before.at, input.before.at, input.before.id); }
    const values = input.focusId && !input.day && !input.before ? recentSocialFacts(this.db, input.focusId, context.virtualNow, limit + 1)
      : this.db.prepare('SELECT * FROM (' + facts + ')' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY at DESC,id DESC LIMIT ?').all(...args, limit + 1) as Row[];
    const items: CompanionSocialFlowEvent[] = values.slice(0, limit).reverse().map(value => {
      if (value.source === 'm') {
        const message = this.wrap(String(value.id)), channel = message.channel ?? 'unknown';
        return { id: message.message.id, at: message.virtualCreatedAt, realAt: message.message.createdAt, actorId: message.message.authorId,
          targetIds: message.recipientIds, kind: channel, label: channel === 'face_to_face' ? '当面交流' : channel === 'phone' ? '手机消息' : '历史交流', text: message.message.content, message };
      }
      const event = parse<{ id: string; at: string; realAt: string; actorId: string; targetId: string; kind: CompanionSocialFlowEvent['kind']; sceneId?: string; visitId?: string; visitDecision?: string }>(row(this.db.prepare('SELECT data FROM companion_world_events WHERE id=?').get(value.id)).data);
      const label = event.kind === 'visit_response' ? event.visitDecision === 'allow' ? '允许拜访' : event.visitDecision === 'deny' ? '婉拒拜访' : '房主回应'
        : ({ visit_request: '申请拜访', scene_depart: '实际出发', scene_enter: '进入场景', travel_blocked: '通行受阻', visit_leave: '结束拜访', social_interrupt: '紧急打扰', social_resume: '恢复原有活动' } as Record<string, string>)[event.kind]!;
      // Do not return raw event text, player source IDs, task goals or inner-state appraisals.
      return { id: event.id, at: event.at, realAt: event.realAt, actorId: event.actorId, targetIds: [event.targetId], kind: event.kind, label, text: label,
        ...(event.sceneId ? { sceneId: event.sceneId } : {}), ...(event.visitId ? { visitId: event.visitId } : {}) };
    });
    const first = items[0], hasMore = values.length > limit;
    return { items, hasMore, ...(hasMore && first ? { nextCursor: { at: first.at, id: first.id } } : {}) };
  }
  private observedVisits(members: string[], focusId?: string): CompanionSocialFlowPage['visits'] {
    const marks = members.map(() => '?').join(','), now = this.observationCalendar().virtualNow;
    const values = focusId ? this.db.prepare(`SELECT * FROM(
      SELECT * FROM(SELECT data,json_extract(data,'$.createdAt') AS at,id FROM companion_world_visit_records WHERE guest_id=? ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 20)
      UNION SELECT * FROM(SELECT data,json_extract(data,'$.createdAt') AS at,id FROM companion_world_visit_records WHERE host_id=? ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 20)
    ) ORDER BY at DESC,id DESC LIMIT 20`).all(focusId, focusId)
      : this.db.prepare(`SELECT data FROM companion_world_visit_records WHERE guest_id IN(${marks}) AND host_id IN(${marks}) ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 20`).all(...members, ...members);
    return (values as Row[]).map(value => {
      const visit = parse<CompanionSocialFlowPage['visits'][number]>(value.data);
      return { id: visit.id, guestId: visit.guestId, hostId: visit.hostId, createdAt: visit.createdAt, expiresAt: visit.expiresAt,
        status: ['requested', 'allowed'].includes(visit.status) && visit.expiresAt <= now ? 'expired' as const : visit.status,
        hostState: this.options.contactState?.(visit.hostId) };
    });
  }
  flow(input: Extract<CompanionStorageCommand, { type: 'social.flow' }>): CompanionSocialFlowPage {
    const members = this.requireRoom(input.conversationId);
    return { ...this.observationCalendar(), ...this.flowEvents([input.conversationId], members, input), visits: this.observedVisits(members) };
  }
  graph(owner: string, input: Extract<CompanionStorageCommand, { type: 'social.graph' }>): CompanionSocialGraph {
    if (!this.exists(owner)) throw new Error('伙伴不存在。');
    // SQL counts the entire ego network; only the requested bounded neighbourhood crosses IPC.
    const relation = this.acquaintanceQuery();
    const aggregate = this.db.prepare('SELECT active,COUNT(*) AS n FROM (' + relation + ') GROUP BY active').all(owner, owner) as Row[];
    const query = input.query?.toLocaleLowerCase() ?? '', clauses: string[] = [], args: unknown[] = [owner, owner];
    if (query) { clauses.push('(instr(lower(name),?)>0 OR instr(lower(id),?)>0)'); args.push(query, query); }
    if (input.group) { clauses.push(input.group === 'player' ? '0' : 'active=?'); if (input.group !== 'player') args.push(input.group === 'active' ? 1 : 0); }
    if (input.peerId) { clauses.push('id=?'); args.push(input.peerId); }
    const filtered = 'SELECT * FROM (' + relation + ')' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '');
    const matchedPeers = Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM (' + filtered + ')').get(...args)).n);
    const limit = input.limit ?? 40;
    const page = this.db.prepare('SELECT * FROM (' + filtered + ')' + (input.afterPeerId ? ' WHERE id>?' : '') + ' ORDER BY id LIMIT ?').all(...args, ...(input.afterPeerId ? [input.afterPeerId] : []), limit + 1) as Row[];
    const peers = page.slice(0, limit).map(value => String(value.id)), peerMarks = peers.map(() => '?').join(',') || 'NULL';
    const rooms = this.db.prepare(`SELECT DISTINCT c.id,c.updated_at FROM conversation_members peer INDEXED BY companion_social_member_owner CROSS JOIN conversation_members cm ON cm.conversation_id=peer.conversation_id JOIN companion_social_conversations r ON r.id=cm.conversation_id JOIN conversations c ON c.id=r.id WHERE cm.companion_id=? AND peer.companion_id IN(${peerMarks}) AND c.dissolved_at IS NULL ORDER BY c.updated_at DESC,c.id LIMIT 800`).all(owner, ...peers) as Row[];
    const roomIds = rooms.map(room => String(room.id)).filter(id => { try { this.requireRoom(id); return true; } catch { return false; } });
    const members = [owner, ...peers], context = this.observationCalendar();
    const nodes: CompanionSocialGraph['nodes'] = members.map(id => { const value = parse<CompanionSocialGraph['nodes'][number]>(row(this.db.prepare('SELECT data FROM companions WHERE id=?').get(id)).data);
      return { id, name: value.name, active: !!value.active, avatar: value.avatar, ...(value.avatarAttachmentId ? { avatarAttachmentId: value.avatarAttachmentId } : {}), state: this.options.contactState?.(id) ?? (value.active ? 'available' : 'dormant') }; });
    const messages = recentSocialMessageCounts(this.db, owner, context.virtualNow);
    const visits = this.observedVisits(members, owner);
    const communication = (this.db.prepare('SELECT companion_id,data FROM companion_social_communication WHERE until_real>?').all(iso()) as Row[]).map(value => ({ owner: String(value.companion_id), ...parse<{ channel: string; phase: string; recipientIds: string[] }>(value.data) }));
    const scenes = this.db.prepare("SELECT json_extract(a.value,'$.companionId') AS id,json_extract(a.value,'$.sceneId') AS scene FROM companion_world w,json_each(w.data,'$.actors') a WHERE w.id=1").all() as Row[];
    const links: CompanionSocialGraph['links'] = peers.map(targetId => {
      const shared = roomIds.filter(id => this.members(id).includes(targetId)).slice(0, 20);
      const between = messages.filter(message => message.author_id === owner ? parse<string[]>(message.recipient_ids).includes(targetId) : message.author_id === targetId && parse<string[]>(message.recipient_ids).includes(owner));
      const betweenLive = communication.filter(item => item.phase !== 'notification' && (item.owner === owner && item.recipientIds.includes(targetId) || item.owner === targetId && item.recipientIds.includes(owner)));
      const active = betweenLive.find(item => ['speaking', 'typing'].includes(item.phase)) ?? betweenLive[0];
      const fromId = active && ['speaking', 'typing'].includes(active.phase) ? active.owner : undefined;
      const pending = visits.some(visit => visit.status === 'requested' && [visit.guestId, visit.hostId].includes(targetId));
      const queued = shared.some(id => this.db.prepare("SELECT 1 FROM companion_social_outbox WHERE conversation_id=? AND status='pending' LIMIT 1").get(id));
      const reply = shared.some(id => this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE conversation_id=? AND status IN('pending','running','failed') AND COALESCE(json_extract(data,'$.terminal'),0)=0 LIMIT 1").get(id));
      const together = scenes.find(value => value.id === owner)?.scene && scenes.find(value => value.id === owner)?.scene === scenes.find(value => value.id === targetId)?.scene;
      const status: CompanionSocialGraph['links'][number]['status'] = active ? active.channel === 'face_to_face' ? 'face' : 'phone' : pending ? 'permission' : queued ? 'queued' : reply ? 'reply' : together ? 'visiting' : 'idle';
      return { targetId, ...(fromId ? { fromId } : {}), kind: 'peer' as const, conversationIds: shared, status, phoneCount: between.filter(message => message.channel === 'phone').length, faceCount: between.filter(message => message.channel === 'face_to_face').length,
        ...(between[0] ? { lastAt: String(between[0].virtual_at) } : {}) };
    });
    const events = this.flowEvents(roomIds, [...members, 'user'], { limit: 60, focusId: owner });
    const playerRoom = this.db.prepare("SELECT id FROM conversations WHERE private_companion_id=? AND dissolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_social_conversations s WHERE s.id=conversations.id) AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id AND m.kind='text' AND m.status='sent') LIMIT 1").get(owner);
    let playerEvents: CompanionSocialFlowEvent[] = [];
    if (playerRoom) {
      const roomId = String(row(playerRoom).id);
      const records = this.db.prepare("SELECT id FROM messages WHERE conversation_id=? AND author_id IN('user',?) AND kind='text' AND status='sent' AND " + visibleSocialTopic('messages.id') + ' ORDER BY sequence DESC LIMIT 60').all(roomId, owner) as Row[];
      playerEvents = records.filter(value => { const message = this.message(String(value.id)); return !message.isReplyDraft && !message.memoryEvidenceOnly; }).map(value => { const message = this.message(String(value.id));
        const stamp = this.db.prepare('SELECT world_at FROM companion_message_times WHERE message_id=?').get(message.id);
        // Old unclocked records stay explicitly historical; never assign them the current world time.
        const at = stamp ? String(row(stamp).world_at) : message.createdAt;
        return { id: message.id, at, realAt: message.createdAt, actorId: message.authorId, targetIds: [message.authorId === 'user' ? owner : 'user'], kind: 'unknown', label: this.db.prepare("SELECT 1 FROM companion_world_attention WHERE source_message_id=? AND urgency='urgent' AND confidence>=.85 LIMIT 1").get(message.id) ? '玩家紧急联系' : '与玩家交流', text: message.content,
          message: { message, virtualCreatedAt: at, recipientIds: [message.authorId === 'user' ? owner : 'user'] } };
      });
      const includePlayer = (!input.group || input.group === 'player') && (!input.peerId || input.peerId === 'user') && (!query || '我 user 玩家'.includes(query)) && !input.afterPeerId;
      if (includePlayer) nodes.push({ id: 'user', name: '我', active: true, state: 'player' });
      const responding = !!this.db.prepare("SELECT 1 FROM companion_world_work_records WHERE companion_id=? AND status='ready' AND json_extract(data,'$.kind')='chat' AND json_extract(data,'$.conversationId')=? LIMIT 1").get(owner, roomId);
      const pending = !!this.db.prepare("SELECT 1 FROM companion_work_queue WHERE companion_id=? AND status IN('queued','running') AND json_extract(data,'$.conversationId')=? LIMIT 1").get(owner, roomId);
      if (includePlayer) links.push({ targetId: 'user', ...(responding ? { fromId: owner } : {}), kind: 'player', conversationIds: [roomId], status: responding ? 'phone' : pending ? 'queued' : 'idle', phoneCount: 0, faceCount: 0,
        ...(playerEvents[0] ? { lastAt: playerEvents[0].at } : {}) });
    }
    const combined = [...events.items, ...playerEvents].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const personName = (id: string) => id === 'user' ? '我' : String(row(this.db.prepare("SELECT json_extract(data,'$.name') AS name FROM companions WHERE id=?").get(id) ?? { name: '已离开的伙伴' }).name);
    const shownEvents = combined.slice(-60).map(event => {
      const source = event.message?.message;
      return { ...event, text: event.text.slice(0, 600), ...(event.text.length > 600 ? { textTruncated: true } : {}),
        ...(event.message && source ? { message: { ...event.message, message: {
          id: source.id, sequence: source.sequence, conversationId: source.conversationId, authorId: source.authorId,
          kind: source.kind, content: source.content.slice(0, 600), createdAt: source.createdAt, status: source.status, attachments: [],
          ...(source.replyToId ? { replyToId: source.replyToId } : {}), ...(source.topicId ? { topicId: source.topicId } : {}),
        } } } : {}), actorName: personName(event.actorId), targetNames: event.targetIds.map(personName) };
    });
    const groups: NonNullable<CompanionSocialGraph['groups']> = [{ id: 'active', count: aggregate.filter(value => !!value.active).reduce((sum, value) => sum + Number(value.n), 0) }, { id: 'dormant', count: aggregate.filter(value => !value.active).reduce((sum, value) => sum + Number(value.n), 0) }, { id: 'player', count: playerRoom ? 1 : 0 }];
    const playerMatch = !!playerRoom && (!input.group || input.group === 'player') && (!input.peerId || input.peerId === 'user') && (!query || '我 user 玩家'.includes(query));
    return { ...context, centerId: owner, nodes, links, total: groups.reduce((sum, group) => sum + group.count, 0), matchedTotal: matchedPeers + Number(playerMatch), groups,
      hasMorePeers: page.length > limit, ...(page.length > limit ? { nextPeerId: peers.at(-1) } : {}), events: shownEvents, visits, hasMoreEvents: events.hasMore || combined.length > 60 };
  }
  private sources(send: Send): { sourceChecksum?: string; authorizationChecksum?: string; agentChecksum?: string } {
    const scope = { companionId: send.companionId, conversationId: send.conversationId };
    let sourceChecksum: string | undefined, authorizationChecksum: string | undefined, agentChecksum: string | undefined;
    if (send.sourceMessageId) { const source = this.visible(scope, [send.sourceMessageId])[0]; if (!source || source.authorId === 'user' || source.authorId === 'system' || source.conversationId !== send.conversationId) throw new Error('社交回复缺少同会话伙伴的真实来源。'); sourceChecksum = checksum(source); }
    if (send.replyToId) { const source = this.message(send.replyToId); if (source.conversationId !== send.conversationId || !this.visible(scope, [source.id]).length) throw new Error('不能引用其他聊天或已撤回的来源。'); }
    if (send.authorizationMessageId) { const source = this.message(send.authorizationMessageId); if (source.authorId !== 'user' || !this.visible({ companionId: send.companionId, conversationId: source.conversationId }, [source.id]).length) throw new Error('分享授权缺少真实可见的用户来源。'); authorizationChecksum = checksum(source); }
    if (send.agentSource) {
      const source = this.visible({ companionId: send.companionId, conversationId: send.agentSource.conversationId }, [send.agentSource.messageId])[0];
      if (!source || source.kind !== 'text' || source.status !== 'sent' || source.isReplyDraft || source.authorId === 'system') throw new Error('本次社交行动的实际对话来源不可见或已撤回。');
      agentChecksum = checksum(source);
    }
    return { sourceChecksum, authorizationChecksum, agentChecksum };
  }
  private budget(owner: string, kind: 'initial' | 'reply', context: Calendar): boolean {
    const [from, to] = this.range(context.observedDay, context.timeZone), cap = kind === 'initial' ? 2 : 8;
    if (Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM companion_social_budget WHERE companion_id=? AND kind=? AND virtual_at>=? AND virtual_at<?').get(owner, kind, from, to)).n) >= cap) return false;
    if (kind === 'initial') { const latest = this.db.prepare("SELECT virtual_at,real_at FROM companion_social_budget WHERE companion_id=? AND kind='initial' ORDER BY real_at DESC LIMIT 1").get(owner); if (latest && (this.clock.elapsedVirtual(Date.parse(String(row(latest).real_at)), Date.now()) < 21600000 || Date.now() - Date.parse(String(row(latest).real_at)) < 120000)) return false; }
    return true;
  }
  canInitiate(owner: string, virtualNow: string, timeZone: string): boolean {
    return this.budget(owner, 'initial', { virtualNow, timeZone, observedDay: dayAt(Date.parse(virtualNow), timeZone), backlog: false });
  }
  private agentSourceOrigin(send: Send): string | undefined {
    if (!send.agentSource) return;
    const source = this.visible({ companionId: send.companionId, conversationId: send.agentSource.conversationId }, [send.agentSource.messageId])[0];
    if (!source || source.authorId === 'user' || source.authorId === send.companionId || source.authorId === 'system') return;
    const jobs = this.db.prepare("SELECT data FROM companion_social_jobs WHERE companion_id=? AND conversation_id=? AND json_extract(data,'$.sourceMessageId')=? AND status IN('running','done')")
      .all(send.companionId, send.agentSource.conversationId, source.id) as Row[];
    const origins = new Map<string, string>();
    for (const stored of jobs) {
      const job = parse<StoredJob>(stored.data);
      if (!job.readSet?.some(read => read.id === source.id && read.checksum === checksum(source))) continue;
      const origin = this.continuity.forChain(job.chainId);
      if (!origin || origin.initiatorKind !== 'human_player' || origin.initiatorId !== 'user') continue;
      const delegation = this.db.prepare("SELECT source_message_id,data FROM companion_social_delegations WHERE id=? AND status='active'").get(origin.id) as Row | undefined;
      if (!delegation) continue;
      const original = parse<{ conversationId: string }>(delegation.data);
      origins.set(original.conversationId + '/' + String(delegation.source_message_id), origin.id);
    }
    if (origins.size > 1) throw new Error('本次实际来信关联多个原目标，不能猜测或混合游戏上下文。');
    return [...origins.values()][0];
  }
  send(input: Send): CompanionStorageResponse {
    const context = this.calendar();
    const result: CompanionStorageResponse = this.db.transaction(() => {
      const members = this.requireRoom(input.conversationId, input.companionId); const fingerprint = hash(input), existing = this.db.prepare('SELECT * FROM companion_social_outbox WHERE client_id=?').get(input.clientId);
      const previous = existing ? parse<PendingSend>(row(existing).data) : undefined;
      if (previous && previous.fingerprint !== fingerprint) throw new Error('社交发送的重试标识已经被其他内容使用。');
      if (existing && row(existing).message_id) return { ok: true, socialMessage: this.wrap(String(row(existing).message_id)) };
      if (existing && previous && row(existing).status === 'cancelled') return this.sendOutcome(previous);
      if (!this.participantsActivated(members)) throw new Error('发起联系前，所有参与伙伴都需要由玩家手动激活；休眠伙伴不会收到新消息。');
      if (previous) return this.sendOutcome(previous, this.deliver(previous, context));
      if (input.urgent && this.db.prepare("SELECT 1 FROM companion_social_outbox WHERE companion_id=? AND json_extract(data,'$.urgent')=1 AND status IN('pending','sent') AND created_at>? LIMIT 1").get(input.companionId, iso(Date.now() - 120000))) throw new Error('刚刚已经发起紧急联系，请等待对方处理，不要重复打扰。');
      const sourceChecksums = this.sources(input), recipients = this.requireRoom(input.conversationId, input.companionId).filter(id => id !== input.companionId);
      const chosen = this.db.prepare('SELECT topic_id FROM companion_topic_current WHERE conversation_id=? AND reader_id=?').get(input.conversationId, input.companionId);
      // Freeze and validate the destination before creating an outbox or origin.
      // A source topic never becomes a port in a different destination room.
      const topicId = input.replyToId ? this.message(input.replyToId).topicId ?? null : input.topicId ?? (input.topicId === undefined && chosen ? String(row(chosen).topic_id) : null);
      if (this.topicAdmission(input.companionId, input.conversationId, topicId) === 'cancelled') throw new Error(invalidSendPort);
      const authorization = input.authorizationMessageId ? this.message(input.authorizationMessageId) : undefined;
      const inheritedOrigin = !authorization ? this.agentSourceOrigin(input) : undefined;
      const originId = authorization ? this.continuity.record({ type: 'social.delegation.record', companionId: input.companionId,
        conversationId: authorization.conversationId, sourceMessageId: authorization.id, recipientIds: recipients, sharedText: input.content, intent: 'message' })
        : inheritedOrigin ?? this.continuity.matchVisit(input.companionId, recipients);
      if (!originId && !input.sourceMessageId && !input.agentSource && row(this.db.prepare("SELECT json_extract(data,'$.proactive') AS enabled FROM companions WHERE id=?").get(input.companionId)).enabled === 0) throw new Error('该伙伴已关闭主动闲聊。');
      const channel = !input.sourceMessageId && !input.agentSource && this.available(input.companionId, 'face_to_face', recipients) ? 'face_to_face' : input.channel;
      if (channel === 'face_to_face' && !this.available(input.companionId, channel, recipients)) throw new Error('所有参与者需要在同一现场、彼此5格内且方便交流。');
      if (channel === 'face_to_face' && !originId && !input.authorizationMessageId && !this.budget(input.companionId, 'initial', context)) throw new Error('此刻的主动社交配额或冷却尚未恢复，本次现场机会结束。');
      const send: PendingSend = { ...input, topicId, channel, ...sourceChecksums, fingerprint, ...(originId ? { originId } : {}), ...(inheritedOrigin ? { originFromAgentSource: true } : {}) };
      this.db.prepare("INSERT INTO companion_social_outbox(client_id,companion_id,conversation_id,status,created_at,data) VALUES(?,?,?,'pending',?,?)").run(input.clientId, input.companionId, input.conversationId, iso(), JSON.stringify(send));
      return this.sendOutcome(send, this.deliver(send, context));
    }).immediate();
    result.socialRecipients = this.members(input.conversationId).filter(id => id !== input.companionId).map(companionId => ({ companionId, state: this.options.contactState?.(companionId) ?? 'available' }));
    return result;
  }
  /** Retirement must commit even when the caller receives a failed receipt. */
  private sendOutcome(send: PendingSend, delivered?: CompanionSocialMessage): CompanionStorageResponse {
    if (delivered) return { ok: true, socialMessage: delivered };
    const stored = this.db.prepare('SELECT status FROM companion_social_outbox WHERE client_id=?').get(send.clientId);
    if (stored && row(stored).status === 'cancelled') return { ok: false,
      error: this.topicAdmission(send.companionId, send.conversationId, send.topicId) === 'cancelled' ? invalidSendPort
        : '本次未发送：该待发记录已取消，不能继续复用。请核对目标会话及话题入口，确认仍需发送后重新发起。' };
    return { ok: true, socialPending: true };
  }
  private deliver(send: PendingSend, context: Calendar): CompanionSocialMessage | undefined {
    const members = this.requireRoom(send.conversationId, send.companionId), recipients = members.filter(id => id !== send.companionId);
    const admission = this.topicAdmission(send.companionId, send.conversationId, send.topicId);
    if (admission !== 'active') {
      this.holdOrCancelTopicSend(send, admission);
      return undefined;
    }
    const current = this.sources(send);
    if (!this.participantsActivated(members)) { for (const id of members.filter(id => !this.activated(id))) this.stopInactive(id); return undefined; }
    if (current.sourceChecksum !== send.sourceChecksum || current.authorizationChecksum !== send.authorizationChecksum || current.agentChecksum !== send.agentChecksum) throw new Error('待发送消息的来源已经修改。');
    if (send.originId && !this.continuity.validOrigin(send.originId)) throw new Error('这次社交委托已经失效。');
    if (send.channel === 'face_to_face' && !this.available(send.companionId, send.channel, recipients)) {
      this.db.prepare("UPDATE companion_social_outbox SET status='cancelled' WHERE client_id=?").run(send.clientId); this.clearFace(send.conversationId); return undefined;
    }
    if (send.channel === 'face_to_face' && !send.urgent && !send.originId && !send.authorizationMessageId && !this.budget(send.companionId, 'initial', context)) {
      this.db.prepare("UPDATE companion_social_outbox SET status='cancelled' WHERE client_id=?").run(send.clientId); this.clearFace(send.conversationId); return undefined;
    }
    const ownJob = send.agentSource ? this.db.prepare("SELECT id FROM companion_social_jobs WHERE companion_id=? AND conversation_id=? AND json_extract(data,'$.sourceMessageId')=? AND status='running' AND lease_until>? LIMIT 1").get(send.companionId, send.agentSource.conversationId, send.agentSource.messageId, iso()) : undefined;
    const ownJobId = ownJob ? String(row(ownJob).id) : '';
    if (context.backlog || this.phoneBusy(send.companionId, 'outbox:' + send.clientId, ownJobId ? 'job:' + ownJobId : '') || this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE companion_id=? AND status='running' AND lease_until>? AND id!=? LIMIT 1").get(send.companionId, iso(), ownJobId) || !this.available(send.companionId, send.channel, recipients) || !send.urgent && !send.originId && !send.authorizationMessageId && !send.agentSource && !this.budget(send.companionId, 'initial', context)) return undefined;
    if (send.channel === 'phone' && !send.typingNotBefore) {
      send.typingNotBefore = iso(Date.now() + 1200); this.communicate(send.companionId, send.conversationId, recipients, 'typing', 1200, 'outbox:' + send.clientId);
      this.db.prepare('UPDATE companion_social_outbox SET data=? WHERE client_id=?').run(JSON.stringify(send), send.clientId); return undefined;
    }
    if (send.typingNotBefore && Date.parse(send.typingNotBefore) > Date.now()) return undefined;
    const executionReadset = this.executionSources(send.companionId, send.conversationId,
      [send.sourceMessageId, send.authorizationMessageId, send.agentSource?.messageId, send.replyToId].filter((id): id is string => !!id), send.executionReadset);
    const source = this.append({ conversationId: send.conversationId, authorId: send.companionId, topicId: send.topicId, content: send.content, clientId: send.clientId, replyToId: send.replyToId, ...(executionReadset ? { executionReadset } : {}) });
    this.index(source, context.virtualNow, recipients, send.channel); const message = this.wrap(source.id), chainId = randomUUID();
    if (send.shareAddress) this.options.shareHome?.(send.companionId, recipients, source);
    const chain: ChainData = { kind: recipients.length === 1 ? 'pair' : 'group', initiatorId: send.companionId, recipientIds: recipients,
      phase: 'first', maxMessages: recipients.length === 1 ? 4 : recipients.length + 3 };
    this.db.prepare("INSERT INTO companion_social_chains(id,used,status,data) VALUES(?,1,'active',?)").run(chainId, JSON.stringify(chain));
    this.continuity.bind(chainId, send.companionId, send.content, send.originId, !!send.originFromAgentSource);
    this.db.prepare("INSERT INTO companion_social_budget VALUES(?,?,'initial',?,?)").run(source.id, send.companionId, context.virtualNow, iso());
    this.db.prepare("UPDATE companion_social_outbox SET status='sent',message_id=? WHERE client_id=?").run(source.id, send.clientId);
    this.clearCommunication(send.companionId, 'outbox:' + send.clientId);
    if (send.channel === 'face_to_face') this.communicateFace(send.conversationId, send.companionId, 10000);
    this.speech(message, send.channel);
    // Every real recipient gets one independent opportunity. Their silence or
    // personal pause cannot consume another member's turn or block its claim.
    for (const recipient of recipients) this.queue(message, recipient, chainId, chain.kind === 'pair' ? 3 : 1, send.channel, send.urgent, chain.kind === 'pair' ? 'pair' : 'first');
    if (send.channel === 'phone') for (const recipient of recipients) this.communicate(recipient, send.conversationId, [send.companionId], 'notification', 5000, 'notification:' + source.id);
    return message;
  }
  private queue(source: CompanionSocialMessage, owner: string, chainId: string, remainingTurns: number, channel: Send['channel'], urgent = false, round: StoredJob['round'] = 'pair', replyOpportunity?: ActivityReplyProof): void {
    if (remainingTurns <= 0) { this.db.prepare("UPDATE companion_social_chains SET status='done' WHERE id=?").run(chainId); return; }
    assertCompanionInboxCapacity(this.db, owner);
    const job: StoredJob = { urgent, round, id: randomUUID(), companionId: owner, conversationId: source.message.conversationId, sourceMessageId: source.message.id, throughSequence: source.message.sequence, chainId, remainingTurns, memberIds: this.members(source.message.conversationId), channel, status: 'pending', attempts: 0, typingNotBefore: iso(), createdAt: iso(), ...(replyOpportunity ? { replyOpportunity } : {}) };
    this.db.prepare('INSERT INTO companion_social_jobs(id,companion_id,conversation_id,status,created_at,data) VALUES(?,?,?,?,?,?)').run(job.id, owner, job.conversationId, job.status, job.createdAt, JSON.stringify(job));
  }
  private activityReplyValid(proof: ActivityReplyProof): boolean {
    if (!this.options.activityTaskValid?.(proof.taskId, proof.ownerId, proof.taskConversationId)) return false;
    const found = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=? AND companion_id=? AND conversation_id=?')
      .get(proof.taskId, proof.ownerId, proof.taskConversationId);
    if (!found) return false;
    const task = parse<{ status: string; step: number; history: Array<{ step: number; action: string; ok: boolean }>; sourceMessageId?: string; sourceChecksum?: string; peerResponsibility?: { jobId: string }; gamePort?: { conversationId: string; topicId: string };
      peerConversationId?: string; peerTopicId?: string | null }>(row(found).data);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status) || task.sourceMessageId !== proof.taskSourceMessageId || task.sourceChecksum !== proof.taskSourceChecksum
      || (task.gamePort?.conversationId ?? task.peerConversationId) !== proof.conversationId
      || (task.gamePort?.topicId ?? task.peerTopicId ?? null) !== (proof.topicId ?? null)) return false;
    try {
      if (!proof.parentChainId || !this.continuity.chainValid(proof.parentChainId)) return false;
      if (this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE json_extract(data,'$.chainId')=? AND json_extract(data,'$.replyOpportunity') IS NOT NULL LIMIT 1")
        .get(proof.parentChainId)) return false;
      const origin = this.continuity.forChain(proof.parentChainId);
      const rootSource = task.sourceMessageId ? this.visible({ companionId: proof.ownerId, conversationId: proof.taskConversationId }, [task.sourceMessageId])[0] : undefined;
      let causal = false;
      const root = rootSource?.authorId === 'user' ? { companionId: proof.ownerId, conversationId: proof.taskConversationId, sourceMessageId: rootSource.id }
        : rootSource ? companionSocialDelegatedPortOrigin(this.db, this, this.visible, proof.ownerId, rootSource)
          ?? companionSocialGoalOrigin(this.db, this, this.visible, proof.ownerId, rootSource) : undefined;
      if (root && origin?.initiatorKind === 'human_player') {
        const saved = this.db.prepare("SELECT data FROM companion_social_delegations WHERE id=? AND companion_id=? AND status='active'").get(origin.id, root.companionId);
        const delegation = saved ? parse<{ conversationId: string; sourceMessageId: string }>(row(saved).data) : undefined;
        causal = delegation?.conversationId === root.conversationId && delegation.sourceMessageId === root.sourceMessageId;
      } else if (!root && origin?.initiatorKind === 'companion') {
        const accepted = task.peerResponsibility && this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE id=? AND companion_id=? AND status='done' AND json_extract(data,'$.chainId')=? AND json_extract(data,'$.acceptedActivity.taskId')=?")
          .get(task.peerResponsibility.jobId, proof.ownerId, proof.parentChainId, proof.taskId);
        causal = !!accepted || (this.db.prepare("SELECT o.data FROM companion_social_outbox o WHERE o.companion_id=? AND o.status='sent' AND o.message_id IN(SELECT json_extract(j.data,'$.sourceMessageId') FROM companion_social_jobs j WHERE json_extract(j.data,'$.chainId')=?)")
          .all(proof.ownerId, proof.parentChainId) as Row[]).some(value => {
            const sent = parse<{ clientId: string; agentSource?: { conversationId: string; messageId: string } }>(value.data);
            if (task.sourceMessageId) return sent.agentSource?.conversationId === proof.taskConversationId && sent.agentSource.messageId === task.sourceMessageId;
            const prefix = `activity_${proof.taskId}_`, suffix = sent.clientId.startsWith(prefix) ? sent.clientId.slice(prefix.length) : '';
            const step = Number(suffix);
            return /^\d+$/u.test(suffix) && step < task.step && task.history.some(item => item.step === step + 1 && item.ok
              && ['message', 'social', 'introduce', 'create_group'].includes(item.action));
          });
      }
      if (!causal) return false;
      const source = this.wrap(proof.sourceMessageId);
      return source.message.authorId === proof.ownerId && source.message.conversationId === proof.conversationId
        && source.message.topicId === proof.topicId && source.message.status === 'sent' && !source.message.isReplyDraft && !source.message.replyDraft
        && checksum(source.message) === proof.sourceChecksum && source.recipientIds.includes(proof.targetId)
        && this.visible({ companionId: proof.ownerId, conversationId: proof.conversationId }, [proof.sourceMessageId]).length === 1
        && this.visible({ companionId: proof.targetId, conversationId: proof.conversationId }, [proof.sourceMessageId]).length === 1;
    } catch { return false; }
  }
  /** Only a persisted activity wait may authorize one independent bounded turn.
   * This schedules the recipient's own decision, never another message or reply. */
  ensureActivityReplyOpportunity(input: { taskId: string; ownerId: string; taskConversationId: string; targetId: string; sourceMessageId: string }): void {
    this.db.transaction(() => {
      // Existing opportunities, including silence and failure, are immutable.
      // This indexed no-op is not an authority cache: new work is fully checked below.
      if (this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE companion_id=? AND conversation_id=(SELECT conversation_id FROM messages WHERE id=?) AND json_extract(data,'$.sourceMessageId')=? LIMIT 1")
        .get(input.targetId, input.sourceMessageId, input.sourceMessageId)) return;
      const found = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=? AND companion_id=? AND conversation_id=?')
        .get(input.taskId, input.ownerId, input.taskConversationId);
      if (!found) return;
      const task = parse<{ status: string; sourceMessageId?: string; sourceChecksum?: string; wait?: { kind: string; targetCompanionId?: string };
        observedSocialEvidence?: { messages: Read[] } }>(row(found).data);
      if (task.status !== 'waiting' || task.wait?.kind !== 'reply' || task.wait.targetCompanionId !== input.targetId || input.ownerId === input.targetId) return;
      let source: CompanionSocialMessage;
      try { source = this.wrap(input.sourceMessageId); } catch { return; }
      const bodyHash = createHash('sha256').update(source.message.content).digest('hex');
      if (!task.observedSocialEvidence?.messages.some(ref => ref.id === source.message.id && ref.checksum === bodyHash)) return;
      const proof: ActivityReplyProof = { ...input, taskSourceMessageId: task.sourceMessageId, taskSourceChecksum: task.sourceChecksum,
        sourceChecksum: checksum(source.message), conversationId: source.message.conversationId, topicId: source.message.topicId };
      if (!source.channel) return;
      let members: string[];
      try { members = this.requireRoom(proof.conversationId, proof.ownerId); } catch { return; }
      if (!members.includes(proof.targetId) || !this.participantsActivated(members)
        || this.topicAdmission(proof.ownerId, proof.conversationId, proof.topicId) !== 'active'
        || this.topicAdmission(proof.targetId, proof.conversationId, proof.topicId, true) !== 'active') return;
      const previous = this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE companion_id=? AND conversation_id=? AND json_extract(data,'$.throughSequence')>=? AND EXISTS(SELECT 1 FROM json_each(companion_social_jobs.data,'$.readSet') r WHERE json_extract(r.value,'$.id')=? AND json_extract(r.value,'$.checksum')=?) LIMIT 1")
          .get(proof.targetId, proof.conversationId, source.message.sequence, proof.sourceMessageId, proof.sourceChecksum);
      if (previous || this.db.prepare("SELECT 1 FROM messages WHERE author_id=? AND reply_to_id=? AND status='sent' LIMIT 1").get(proof.targetId, proof.sourceMessageId)) return;
      let parents = this.db.prepare("SELECT DISTINCT c.id,c.used,c.status,c.data FROM companion_social_chains c JOIN companion_social_jobs j ON json_extract(j.data,'$.chainId')=c.id WHERE j.companion_id=? AND j.conversation_id=? AND json_extract(j.data,'$.resultMessageId')=? AND j.status='done' AND json_extract(j.data,'$.replyOpportunity') IS NULL")
        .all(proof.ownerId, proof.conversationId, proof.sourceMessageId) as Row[];
      if (!parents.length) parents = this.db.prepare("SELECT DISTINCT c.id,c.used,c.status,c.data FROM companion_social_chains c JOIN companion_social_jobs j ON json_extract(j.data,'$.chainId')=c.id WHERE j.conversation_id=? AND json_extract(j.data,'$.sourceMessageId')=? AND json_extract(j.data,'$.replyOpportunity') IS NULL")
        .all(proof.conversationId, proof.sourceMessageId) as Row[];
      if (parents.length !== 1) return;
      const parent = parents[0]!, data = parse<ChainData>(parent.data);
      proof.parentChainId = String(parent.id);
      if (!this.activityReplyValid(proof)) return;
      if (parent.status !== 'done' || !Number.isInteger(data.maxMessages) || !Number.isInteger(parent.used)
        || !this.continuity.chainValid(String(parent.id))) return;
      // The live task's explicit wait supplies this one processing opportunity;
      // the settled ordinary chain is provenance, never a budget to reopen.
      const key = hash([proof.taskId, proof.ownerId, proof.targetId, proof.sourceMessageId]), childId = 'reply_wait_' + key.slice(0, 48);
      if (this.db.prepare('SELECT 1 FROM companion_social_chains WHERE id=?').get(childId)) return;
      const child: ChainData = { kind: 'group', initiatorId: proof.ownerId, recipientIds: [proof.targetId], phase: 'followup', maxMessages: 2 };
      this.db.prepare("INSERT INTO companion_social_chains(id,used,status,data) VALUES(?,1,'active',?)").run(childId, JSON.stringify(child));
      const origin = this.continuity.forChain(String(parent.id));
      this.continuity.bind(childId, proof.ownerId, source.message.content, origin?.initiatorKind === 'human_player' ? origin.id : undefined, true);
      this.queue(source, proof.targetId, childId, 1, source.channel, false, 'followup', proof);
    }).immediate();
  }
  private saveJob(job: StoredJob, leaseUntil?: string): void {
    this.db.prepare('UPDATE companion_social_jobs SET status=?,lease_until=?,data=? WHERE id=?').run(job.status, leaseUntil ?? null, JSON.stringify(job), job.id);
    this.replies.terminal(job);
  }
  private chain(id: string): { used: number; data: ChainData } | undefined {
    const found = this.db.prepare("SELECT used,data FROM companion_social_chains WHERE id=? AND status='active'").get(id);
    if (!found) return;
    const data = parse<ChainData>(row(found).data);
    if (!['pair', 'group'].includes(data.kind) || !Number.isInteger(data.maxMessages)) return;
    return { used: Number(row(found).used), data };
  }
  private endChain(id: string): void {
    this.db.prepare("UPDATE companion_social_chains SET status='done',data=json_set(data,'$.phase','done') WHERE id=?").run(id);
  }
  private settleGroupFirstRound(job: StoredJob): void {
    const chain = this.chain(job.chainId); if (!chain || chain.data.kind !== 'group' || chain.data.phase !== 'first') return;
    const first = (this.db.prepare("SELECT data FROM companion_social_jobs WHERE json_extract(data,'$.chainId')=? AND json_extract(data,'$.round')='first'").all(job.chainId) as Row[]).map(value => parse<StoredJob>(value.data));
    if (first.some(value => !['done', 'cancelled'].includes(value.status) && !(value.status === 'failed' && (value.attempts >= 8 || value.terminal)))) return;
    const replies = first.flatMap(value => value.resultMessageId ? [this.message(value.resultMessageId)] : []).sort((a, b) => b.sequence - a.sequence);
    const latest = replies[0];
    if (!latest || this.topicAdmission(chain.data.initiatorId, job.conversationId, latest.topicId) === 'cancelled') { this.endChain(job.chainId); return; }
    chain.data.phase = 'summary'; this.db.prepare('UPDATE companion_social_chains SET data=? WHERE id=?').run(JSON.stringify(chain.data), job.chainId);
    this.queue(this.wrap(latest.id), chain.data.initiatorId, job.chainId, 2, job.channel, false, 'summary');
  }
  private continueChain(job: StoredJob, message?: CompanionSocialMessage, nextRecipientId?: string): void {
    const chain = this.chain(job.chainId); if (!chain) return;
    if (chain.data.kind === 'pair') {
      if (!message) { this.endChain(job.chainId); return; }
      const next = nextRecipientId ?? this.message(job.sourceMessageId).authorId;
      this.queue(message, next, job.chainId, job.remainingTurns - 1, job.channel); return;
    }
    if (job.round === 'first') { this.settleGroupFirstRound(job); return; }
    if (job.round === 'summary' && message && nextRecipientId && chain.used < chain.data.maxMessages) {
      chain.data.phase = 'followup'; this.db.prepare('UPDATE companion_social_chains SET data=? WHERE id=?').run(JSON.stringify(chain.data), job.chainId);
      this.queue(message, nextRecipientId, job.chainId, 1, job.channel, false, 'followup'); return;
    }
    this.endChain(job.chainId);
  }
  private publicJob(job: StoredJob): CompanionSocialJob {
    return { id: job.id, companionId: job.companionId, conversationId: job.conversationId, sourceMessageId: job.sourceMessageId,
      throughSequence: job.throughSequence, chainId: job.chainId, remainingTurns: job.remainingTurns, memberIds: job.memberIds,
      channel: job.channel, urgent: job.urgent, status: job.status, attempts: job.attempts, leaseToken: job.leaseToken, typingNotBefore: job.typingNotBefore, createdAt: job.createdAt,
      origin: this.continuity.forChain(job.chainId) };
  }
  private phoneBusy(owner: string, leaseId: string, allowedLeaseId = ''): boolean {
    // Actual reply and delivery leases reserve attention; virtual routines do not.
    return !!this.db.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id=? AND until_real>? AND json_extract(data,'$.phase')='typing' AND json_extract(data,'$.leaseId') NOT IN(?,?)").get(owner, iso(), leaseId, allowedLeaseId)
      || !!this.db.prepare("SELECT 1 FROM companion_social_notifications WHERE companion_id=? AND status='running' AND lease_until>?").get(owner, iso());
  }
  private clearCommunication(owner: string, leaseId: string): void { this.db.prepare("DELETE FROM companion_social_communication WHERE companion_id=? AND json_extract(data,'$.leaseId')=?").run(owner, leaseId); }
  private communicate(owner: string, conversationId: string, recipients: string[], phase: 'notification' | 'typing', duration: number, leaseId: string): void {
    if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND json_extract(data,'$.active')=1").get(owner) || this.phoneBusy(owner, leaseId)) return;
    const untilReal = iso(Date.now() + duration), value = { channel: 'phone', phase, conversationId, recipientIds: recipients, untilReal, leaseId };
    this.db.prepare('INSERT INTO companion_social_communication(companion_id,until_real,data) VALUES(?,?,?) ON CONFLICT(companion_id) DO UPDATE SET until_real=excluded.until_real,data=excluded.data').run(owner, untilReal, JSON.stringify(value));
  }
  private clearFace(conversationId: string): void { this.db.prepare("DELETE FROM companion_social_communication WHERE json_extract(data,'$.channel')='face_to_face' AND json_extract(data,'$.conversationId')=?").run(conversationId); }
  private communicateFace(conversationId: string, speakerId: string | undefined, duration: number): void {
    const members = this.members(conversationId), untilReal = iso(Date.now() + duration);
    for (const owner of members) {
      const value = { channel: 'face_to_face', phase: owner === speakerId ? 'speaking' : 'listening', conversationId,
        recipientIds: members.filter(member => member !== owner), untilReal, leaseId: 'face:' + conversationId };
      this.db.prepare('INSERT INTO companion_social_communication(companion_id,until_real,data) VALUES(?,?,?) ON CONFLICT(companion_id) DO UPDATE SET until_real=excluded.until_real,data=excluded.data').run(owner, untilReal, JSON.stringify(value));
    }
  }
  private readSet(job: StoredJob): Read[] {
    const source = this.message(job.sourceMessageId);
    if (this.topicAdmission(job.companionId, job.conversationId, source.topicId, true) !== 'active') return [];
    const topic = source.topicId
      ? this.db.prepare("SELECT data FROM companion_topics WHERE id=? AND json_extract(data,'$.deletedAt') IS NULL AND json_extract(data,'$.status')='active'").get(source.topicId) : undefined;
    if (source.topicId && !topic) return [];
    const joined = !source.topicId || (JSON.parse(String(row(topic!).data)) as { participantIds: string[] }).participantIds.includes(job.companionId);
    const ids = joined ? (this.db.prepare("SELECT s.id FROM messages s LEFT JOIN companion_message_topics t ON t.message_id=s.id WHERE s.conversation_id=? AND s.sequence<=? AND COALESCE(t.topic_id,'')=? ORDER BY s.sequence DESC LIMIT 256")
      .all(job.conversationId, job.throughSequence, source.topicId ?? '') as Row[]).map(value => String(value.id)) : [source.id];
    return this.visible({ companionId: job.companionId, conversationId: job.conversationId, beforeSequence: job.throughSequence }, ids).map(message => ({ id: message.id, checksum: checksum(message) }));
  }
  /** A selected port is frozen on queued work; pausing it is a wait, never a failed model attempt. */
  private topicAdmission(owner: string, conversationId: string, topicId?: string | null, allowInvitation = false): 'active' | 'paused' | 'cancelled' {
    if (!topicId) return 'active';
    const found = this.db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(topicId, conversationId);
    if (!found) return 'cancelled';
    const topic = parse<{ status: string; deletedAt?: string; participantIds: string[]; invitedIds: string[] }>(row(found).data);
    const participation = this.db.prepare('SELECT status FROM companion_topic_participation WHERE topic_id=? AND reader_id=?').get(topicId, owner);
    if (topic.deletedAt || topic.status === 'closed' || participation && row(participation).status === 'left'
      || !topic.participantIds.includes(owner) && !(allowInvitation && topic.invitedIds.includes(owner))) return 'cancelled';
    return topic.status === 'paused' || participation && row(participation).status === 'paused' ? 'paused' : 'active';
  }
  private jobTopicAdmission(job: StoredJob): 'active' | 'paused' | 'cancelled' {
    try { return this.topicAdmission(job.companionId, job.conversationId, this.message(job.sourceMessageId).topicId, true); }
    catch { return 'cancelled'; }
  }
  private holdOrCancelTopicSend(send: PendingSend, admission: 'paused' | 'cancelled'): void {
    delete send.typingNotBefore;
    this.db.prepare('UPDATE companion_social_outbox SET status=?,data=? WHERE client_id=?').run(admission === 'paused' ? 'pending' : 'cancelled', JSON.stringify(send), send.clientId);
    this.clearCommunication(send.companionId, 'outbox:' + send.clientId);
  }
  private holdOrCancelTopicJob(job: StoredJob, admission: 'paused' | 'cancelled'): void {
    job.status = admission === 'paused' ? 'pending' : 'cancelled'; delete job.leaseToken; delete job.readSet;
    this.saveJob(job); this.clearCommunication(job.companionId, 'job:' + job.id);
    if (admission === 'cancelled' && job.urgent) this.options.endInterrupt?.(job.companionId, job.sourceMessageId);
    if (admission === 'cancelled' && job.round === 'first') this.settleGroupFirstRound(job);
  }
  /** Retire exact-topic work immediately, so close→reopen cannot resurrect an old send. */
  topicChanged(conversationId: string, topicId: string, readerId?: string): void {
    for (const value of this.db.prepare("SELECT data FROM companion_social_outbox WHERE conversation_id=? AND status='pending' AND json_extract(data,'$.topicId')=? AND (? IS NULL OR companion_id=?)").all(conversationId, topicId, readerId ?? null, readerId ?? null) as Row[]) {
      const send = parse<PendingSend>(value.data), admission = this.topicAdmission(send.companionId, conversationId, topicId);
      if (admission !== 'active') this.holdOrCancelTopicSend(send, admission);
    }
    for (const value of this.db.prepare("SELECT data FROM companion_social_jobs WHERE conversation_id=? AND status IN('pending','running','failed') AND json_extract(data,'$.sourceMessageId') IN(SELECT message_id FROM companion_message_topics WHERE topic_id=?) AND (? IS NULL OR companion_id=?)").all(conversationId, topicId, readerId ?? null, readerId ?? null) as Row[]) {
      const job = parse<StoredJob>(value.data), admission = this.jobTopicAdmission(job);
      if (admission !== 'active') this.holdOrCancelTopicJob(job, admission);
    }
  }
  private validRead(job: StoredJob): boolean {
    const sources = this.readSet(job), present = new Map(sources.map(source => [source.id, source.checksum]));
    return !!present.get(job.sourceMessageId) && (job.readSet ?? []).every(source => present.get(source.id) === source.checksum);
  }
  /** A peer's own live brain may analyse its actual inbound material. The
   * sender supplies no execution grant and no synthetic activity is created. */
  prepareThought(command: Extract<CompanionStorageCommand, { type: 'peer.thought.create' }>): {
    authorization: CompanionPeerThoughtAuthorization; executionReadset: CompanionExecutionReadset; sourceMessageId: string;
  } {
    const found = this.db.prepare('SELECT data FROM companion_social_jobs WHERE id=?').get(command.jobId);
    if (!found) throw new Error('当前伙伴来信任务不存在，未委托思考。');
    const job = parse<StoredJob>(row(found).data), source = this.message(job.sourceMessageId);
    const authorization: CompanionPeerThoughtAuthorization = { kind: 'peer', jobId: job.id, effectId: command.effectId,
      companionId: command.companionId, conversationId: command.conversationId, leaseToken: command.leaseToken,
      sourceMessageId: source.id, sourceChecksum: checksum(source), throughSequence: job.throughSequence,
      observationFingerprint: hash(job.readSet ?? []) };
    if (!this.thoughtValid(authorization, 'execute')) throw new Error('伙伴来信的主体、来源、读集或实际租约已变化，未委托旧思考。');
    const executionReadset = this.executionSources(job.companionId, job.conversationId, (job.readSet ?? []).map(read => read.id),
      command.executionReadset, job.throughSequence)!;
    return { authorization, executionReadset, sourceMessageId: source.id };
  }
  thoughtValid(authorization: CompanionPeerThoughtAuthorization, mode: 'execute' | 'read', renew = false): boolean {
    try {
      const found = this.db.prepare('SELECT data,lease_until FROM companion_social_jobs WHERE id=?').get(authorization.jobId);
      if (!found) return false;
      const job = parse<StoredJob>(row(found).data), source = this.message(job.sourceMessageId);
      if (job.companionId !== authorization.companionId || job.conversationId !== authorization.conversationId
        || job.sourceMessageId !== authorization.sourceMessageId || job.throughSequence !== authorization.throughSequence
        || source.authorId === 'user' || source.authorId === job.companionId || !job.memberIds.includes(source.authorId)
        || source.conversationId !== job.conversationId || source.status !== 'sent' || source.isReplyDraft || source.replyDraft
        || checksum(source) !== authorization.sourceChecksum || hash(job.readSet ?? []) !== authorization.observationFingerprint
        || !this.validRead(job) || !this.continuity.chainValid(job.chainId)
        || job.replyOpportunity && !this.activityReplyValid(job.replyOpportunity)) return false;
      const members = this.requireRoom(job.conversationId, job.companionId);
      if (!members.includes(source.authorId)) return false;
      // Historical access preserves the real source/readset proof without
      // renewing or reviving an already settled job.
      if (mode === 'read') return true;
      const chain = this.chain(job.chainId), expires = Date.parse(String(row(found).lease_until));
      if (job.status !== 'running' || job.terminal || job.leaseToken !== authorization.leaseToken || !Number.isFinite(expires) || expires <= Date.now()
        || !chain || chain.used >= chain.data.maxMessages || !this.participantsActivated(job.memberIds)
        || this.jobTopicAdmission(job) !== 'active' || this.calendar().backlog || this.phoneBusy(job.companionId, 'job:' + job.id)
        || !this.available(job.companionId, job.channel, job.memberIds.filter(id => id !== job.companionId))) return false;
      if (renew) {
        this.saveJob(job, iso(Date.now() + 180000));
        if (job.channel === 'phone') this.communicate(job.companionId, job.conversationId, job.memberIds.filter(id => id !== job.companionId), 'typing', 180000, 'job:' + job.id);
      }
      return true;
    } catch { return false; }
  }
  private candidates(table: 'companion_social_outbox' | 'companion_social_jobs', owner: string, predicate: string, args: unknown[]): Row[] {
    const saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('social-scan/' + table + '/' + owner), after = saved ? Number(row(saved).value) : 0;
    const page = this.db.prepare(`SELECT rowid AS ordinal,* FROM ${table} WHERE companion_id=? AND (${predicate}) AND rowid>? ORDER BY rowid LIMIT 32`).all(owner, ...args, after) as Row[];
    if (after && page.length < 32) page.push(...this.db.prepare(`SELECT rowid AS ordinal,* FROM ${table} WHERE companion_id=? AND (${predicate}) AND rowid<=? ORDER BY rowid LIMIT ?`).all(owner, ...args, after, 32 - page.length) as Row[]);
    return page;
  }
  private scanned(table: 'companion_social_outbox' | 'companion_social_jobs', owner: string, ordinal: number): void {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('social-scan/' + table + '/' + owner, String(ordinal));
  }
  claim(): CompanionStorageResponse {
    const context = this.calendar(); return this.db.transaction(() => {
      let dispatched: CompanionSocialMessage | undefined;
      const outboxOwners = this.db.prepare("SELECT companion_id FROM companion_social_outbox WHERE status='pending' GROUP BY companion_id ORDER BY MIN(rowid)").all() as Row[];
      for (const owner of outboxOwners) for (const value of this.candidates('companion_social_outbox', String(owner.companion_id), "status='pending'", [])) {
        this.scanned('companion_social_outbox', String(owner.companion_id), Number(value.ordinal));
        const pending = parse<PendingSend>(value.data);
        try { this.requireRoom(pending.conversationId, pending.companionId); const sources = this.sources(pending); if (sources.authorizationChecksum !== pending.authorizationChecksum || sources.sourceChecksum !== pending.sourceChecksum || sources.agentChecksum !== pending.agentChecksum || pending.originId && !this.continuity.validOrigin(pending.originId)) throw new Error('撤回'); }
        catch { this.db.prepare("UPDATE companion_social_outbox SET status='cancelled' WHERE client_id=?").run(value.client_id); this.clearCommunication(pending.companionId, 'outbox:' + pending.clientId); continue; }
        const message = this.db.transaction(() => this.deliver(pending, context)).immediate(); dispatched ??= message;
        if (message || pending.typingNotBefore && Date.parse(pending.typingNotBefore) > Date.now()) { this.scanned('companion_social_outbox', pending.companionId, 0); break; }
      }
      const jobPredicate = "COALESCE(json_extract(data,'$.terminal'),0)=0 AND json_extract(data,'$.attempts')<8 AND (status='pending' OR status IN('running','failed') AND lease_until<=?)", now = iso();
      const jobOwners = this.db.prepare('SELECT companion_id FROM companion_social_jobs WHERE ' + jobPredicate + ' GROUP BY companion_id ORDER BY MIN(rowid)').all(now) as Row[];
      for (const owner of jobOwners) for (const value of this.candidates('companion_social_jobs', String(owner.companion_id), jobPredicate, [now])) {
        this.scanned('companion_social_jobs', String(owner.companion_id), Number(value.ordinal));
        const job = parse<StoredJob>(value.data);
        if (job.replyOpportunity && !this.activityReplyValid(job.replyOpportunity)) { job.status = 'cancelled'; this.saveJob(job); this.endChain(job.chainId); continue; }
        if (!this.participantsActivated(job.memberIds)) { for (const id of job.memberIds.filter(id => !this.activated(id))) this.stopInactive(id); continue; }
        if (!companionAttentionCanClaim(this.db, job.companionId, job.sourceMessageId)) continue;
        if (this.phoneBusy(job.companionId, 'job:' + job.id)) continue;
        if (this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(job.companionId, iso())) continue;
        try { this.requireRoom(job.conversationId, job.companionId); } catch { job.status = 'cancelled'; this.saveJob(job); continue; }
        const admission = this.jobTopicAdmission(job);
        if (admission !== 'active') { this.holdOrCancelTopicJob(job, admission); continue; }
        const chain = this.chain(job.chainId);
        if (!chain || chain.used >= chain.data.maxMessages || !this.continuity.chainValid(job.chainId)) { job.status = 'cancelled'; this.saveJob(job); continue; }
        if (job.round === 'first') {
          // Keep the original invitation as the reply/authority anchor while
          // including already published group replies in this reader's claim.
          const source = this.message(job.sourceMessageId);
          const latest = this.db.prepare("SELECT MAX(s.sequence) AS sequence FROM messages s LEFT JOIN companion_message_topics t ON t.message_id=s.id WHERE s.conversation_id=? AND s.status='sent' AND COALESCE(t.topic_id,'')=?").get(job.conversationId, source.topicId ?? '');
          job.throughSequence = Math.max(job.throughSequence, Number(row(latest).sequence ?? 0));
        }
        job.readSet = this.readSet(job); if (!job.readSet.some(source => source.id === job.sourceMessageId)) { job.status = 'cancelled'; this.saveJob(job); continue; }
        if (job.urgent) this.options.interrupt?.(job.companionId, this.wrap(job.sourceMessageId));
        const available = this.available(job.companionId, job.channel, job.memberIds.filter(id => id !== job.companionId));
        if (job.channel === 'face_to_face' && !available) { job.status = 'cancelled'; this.saveJob(job); this.clearFace(job.conversationId); continue; }
        if (context.backlog || !available || this.continuity.forChain(job.chainId)?.initiatorKind !== 'human_player' && !job.urgent && !this.budget(job.companionId, 'reply', context)) continue;
        job.status = 'running'; job.attempts++; job.leaseToken = randomUUID(); job.typingNotBefore = iso(Date.now() + 1200); this.saveJob(job, iso(Date.now() + 180000));
        this.scanned('companion_social_jobs', job.companionId, 0);
        if (job.channel === 'phone') this.communicate(job.companionId, job.conversationId, job.memberIds.filter(id => id !== job.companionId), 'typing', 180000, 'job:' + job.id);
        else this.communicateFace(job.conversationId, undefined, 60000);
        return { ok: true, socialJob: this.publicJob(job), ...(dispatched ? { socialMessage: dispatched } : {}) };
      }
      return { ok: true, ...(dispatched ? { socialMessage: dispatched } : {}) };
    }).immediate();
  }
  complete(input: Extract<CompanionStorageCommand, { type: 'social.job.complete' }>): CompanionStorageResponse {
    const context = this.calendar(); return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM companion_social_jobs WHERE id=?').get(input.id); if (!existing) throw new Error('社交回复任务不存在。'); const job = parse<StoredJob>(row(existing).data);
      if (job.status !== 'running' || job.leaseToken !== input.leaseToken || Date.parse(String(row(existing).lease_until)) < Date.now()) throw new Error('这次社交回复的租约已经失效。');
      if (job.replyOpportunity && !this.activityReplyValid(job.replyOpportunity)) throw new Error('持续任务的原始来源或本次真实回复机会已失效，未发布。');
      if (!this.participantsActivated(job.memberIds)) { for (const id of job.memberIds.filter(id => !this.activated(id))) this.stopInactive(id); return { ok: true }; }
      const admission = this.jobTopicAdmission(job);
      if (admission !== 'active') { this.holdOrCancelTopicJob(job, admission); return { ok: true, ...(admission === 'paused' ? { socialPending: true } : {}) }; }
      if (input.expectedMemoryRevision && this.options.memoryRevision?.({ companionId: job.companionId, conversationId: job.conversationId, beforeSequence: job.throughSequence }) !== input.expectedMemoryRevision) throw new Error('社交回复引用的记忆已经变化，请重新回忆后再发言。');
      this.requireRoom(job.conversationId, job.companionId); if (!this.validRead(job) || !this.continuity.chainValid(job.chainId)) throw new Error('已观察的社交来源或原玩家委托已经撤回或修改，请重新读取。');
      if (job.channel === 'face_to_face' && !this.available(job.companionId, job.channel, job.memberIds.filter(id => id !== job.companionId))) { job.status = 'cancelled'; delete job.leaseToken; this.saveJob(job); this.clearFace(job.conversationId); return { ok: true }; }
      if (context.backlog || this.phoneBusy(job.companionId, 'job:' + job.id) || !this.available(job.companionId, job.channel, job.memberIds.filter(id => id !== job.companionId)) || this.continuity.forChain(job.chainId)?.initiatorKind !== 'human_player' && !job.urgent && !this.budget(job.companionId, 'reply', context)) { job.status = 'pending'; delete job.leaseToken; delete job.readSet; this.saveJob(job); this.clearCommunication(job.companionId, 'job:' + job.id); return { ok: true, socialPending: true }; }
      if (Date.parse(job.typingNotBefore) > Date.now()) throw new Error('伙伴仍在输入，尚未完成这次发言。');
      const chain = this.chain(job.chainId); if (!chain || chain.used >= chain.data.maxMessages) throw new Error('这次交谈已经结束。');
      if (input.nextRecipientId && (input.nextRecipientId === job.companionId || !job.memberIds.includes(input.nextRecipientId))) throw new Error('下一位回应者必须是同会话的其他伙伴。');
      if (input.workOffer) {
        const source = this.message(job.sourceMessageId), offer = input.workOffer;
        if (!input.text?.trim() || offer.sourceMessageId !== source.id || source.authorId === 'user' || source.authorId === job.companionId
          || !job.memberIds.includes(source.authorId) || !offer.evidence.every(quote => source.content.includes(quote))) throw new Error('伙伴工作必须来自当前真实来信的明确委托。');
        if (!this.options.createPeerWork) throw new Error('伙伴工作暂时不可用。');
        const created = this.options.createPeerWork({ companionId: job.companionId, conversationId: job.conversationId, sourceMessageId: source.id,
          title: offer.title, instruction: offer.instruction, clientId: 'peerwork_' + job.id, accept: offer.accept, mode: offer.mode,
          jobId: job.id, publisherId: source.authorId, leaseToken: input.leaseToken });
        if (offer.mode === 'activity' && offer.accept) {
          if (!created?.activityTaskId || job.acceptedActivity) throw new Error('持续责任尚未创建真实本人任务，或已存在不可变接受凭证。');
          job.acceptedActivity = companionAcceptedPeerActivitySchema.parse({ taskId: created.activityTaskId, sourceMessageId: source.id,
            publisherId: source.authorId, title: offer.title, instruction: offer.instruction, sourceChecksum: companionPeerActivitySourceChecksum(source) });
        }
      }
      job.status = 'done'; delete job.leaseToken;
      if (job.urgent) this.options.endInterrupt?.(job.companionId, job.sourceMessageId);
      this.clearCommunication(job.companionId, 'job:' + job.id);
      if (!input.text?.trim()) { this.saveJob(job); this.replies.complete(job, undefined, this.message(job.sourceMessageId).content, input.memoryRecall); this.continueChain(job); if (job.channel === 'face_to_face') this.clearFace(job.conversationId); return { ok: true }; }
      const content = input.text + (input.shareAddress ? '\n\n' + this.options.addressText?.(job.companionId) : '');
      const executionReadset = this.executionSources(job.companionId, job.conversationId, (job.readSet ?? []).map(source => source.id), input.executionReadset, job.throughSequence);
      const source = this.append({ conversationId: job.conversationId, authorId: job.companionId, content, replyToId: job.sourceMessageId, clientId: 'social_' + job.id, ...(executionReadset ? { executionReadset } : {}) });
      this.replies.complete(job, source.id, this.message(job.sourceMessageId).content, input.memoryRecall);
      const recipients = job.memberIds.filter(id => id !== job.companionId); this.index(source, context.virtualNow, recipients, job.channel); const message = this.wrap(source.id);
      if (input.shareAddress) this.options.shareHome?.(job.companionId, recipients, source);
      this.db.prepare('UPDATE companion_social_chains SET used=used+1 WHERE id=?').run(job.chainId);
      this.db.prepare("INSERT INTO companion_social_budget VALUES(?,?,'reply',?,?)").run(source.id, job.companionId, context.virtualNow, iso());
      job.resultMessageId = source.id; this.saveJob(job); this.speech(message, job.channel);
      if (job.channel === 'face_to_face') this.communicateFace(job.conversationId, job.companionId, 10000);
      this.continuity.peerReply(job.chainId, source);
      this.continueChain(job, message, input.nextRecipientId); return { ok: true, socialMessage: message };
    }).immediate();
  }
  fail(input: Extract<CompanionStorageCommand, { type: 'social.job.fail' }>): void {
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM companion_social_jobs WHERE id=?').get(input.id); if (!existing) return; const job = parse<StoredJob>(row(existing).data);
      if (job.status !== 'running' || job.leaseToken !== input.leaseToken) return;
      if (input.terminal) {
        job.status = 'failed'; job.terminal = true; job.error = input.error; delete job.leaseToken;
        this.saveJob(job); this.clearCommunication(job.companionId, 'job:' + job.id);
        if (job.urgent) this.options.endInterrupt?.(job.companionId, job.sourceMessageId);
        if (job.round === 'first') this.settleGroupFirstRound(job);
        if (job.channel === 'face_to_face') this.clearFace(job.conversationId);
        return;
      }
      const admission = this.jobTopicAdmission(job); if (admission !== 'active') { this.holdOrCancelTopicJob(job, admission); return; }
      job.status = 'failed'; delete job.leaseToken; this.saveJob(job, iso(Date.now() + Math.min(300000, 10000 * 2 ** Math.min(job.attempts, 5))));
      this.clearCommunication(job.companionId, 'job:' + job.id);
      if (job.attempts >= 8 && job.round === 'first') this.settleGroupFirstRound(job);
      if (job.channel === 'face_to_face') this.clearFace(job.conversationId);
    }).immediate();
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    const continuity = this.continuity.execute(command); if (continuity) return continuity;
    switch (command.type) {
      case 'social.conversation.ensure': return { ok: true, socialConversation: this.resolveRoom(command.companionId, command.memberIds, command.roomId, command.title) };
      case 'social.message.append': return { ok: true, socialMessage: this.appendMessage(command) };
      case 'social.conversations': return { ok: true, socialConversationPage: this.conversations(command) };
      case 'social.messages': return { ok: true, socialMessagePage: this.messages(command) };
      case 'social.flow': return { ok: true, socialFlowPage: this.flow(command) };
      case 'social.graph': return { ok: true, socialGraph: this.graph(command.companionId, command) };
      case 'social.contact.check': this.requireAcquaintances(command.companionId, command.recipientIds); return { ok: true };
      case 'social.days': return { ok: true, socialDays: this.days(command) };
      case 'social.reply.progress': this.requireRoom(command.conversationId, command.companionId); return { ok: true, socialReplyProgress: this.replies.list(command.conversationId, command.companionId, command.limit ?? 20) };
      case 'social.reply.for-message': return { ok: true, socialReplyReceipt: this.replies.receipt(command.messageId) };
      case 'social.reply.for-job': return { ok: true, socialReplyReceipt: this.replies.pending(command.jobId) };
      case 'social.job.progress': this.replies.update(command); return { ok: true };
      case 'social.send': return this.send(command);
      case 'social.job.claim': return this.claim();
      case 'social.job.game_context': return { ok: true, socialGameContext: companionSocialGameContext(this.db, command, {
        visible: this.visible, validRead: job => this.validRead(job as StoredJob), sourceGoal: (owner, source) => companionSocialGoalOrigin(this.db, this, this.visible, owner, source), topicExecute: this.options.topicExecute, activityTaskValid: this.options.activityTaskValid }) };
      case 'social.job.complete': return this.complete(command);
      case 'social.job.fail': this.fail(command); return { ok: true };
      default: return undefined;
    }
  }
}
