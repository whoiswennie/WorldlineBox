import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import type { AppendCompanionMessage, CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionWorldScope } from '../shared/companion-world';
import type { CompanionSocialConversation, CompanionSocialConversationPage, CompanionSocialMessage, CompanionSocialMessagePage, CompanionSocialDays, CompanionSocialJob } from '../shared/companion-social';
import { companionSearchTokens, companionSearchMatch } from '../shared/companion-search';
import { companionCivilInstantInZone, companionTimeInZone } from '../shared/companion-schedule-time';
import { CompanionSocialContinuityStore, companionPlayerPhoneBusy } from './social-continuity-store';

type Row = Record<string, string | number | null>;
type Calendar = { timeZone: string; virtualNow: string; observedDay: string; backlog: boolean };
type Send = { companionId: string; conversationId: string; content: string; channel: 'phone' | 'face_to_face'; sourceMessageId?: string; authorizationMessageId?: string; replyToId?: string; clientId: string };
type PendingSend = Send & { fingerprint: string; authorizationChecksum?: string; sourceChecksum?: string; typingNotBefore?: string; originId?: string };
type Read = { id: string; checksum: string };
type StoredJob = CompanionSocialJob & { readSet?: Read[]; resultMessageId?: string };
export type CompanionPeerWorkInput = { companionId: string; conversationId: string; sourceMessageId: string; title: string; instruction: string; clientId: string; accept: boolean };
const iso = (at = Date.now()) => new Date(at).toISOString();
const row = (value: unknown) => value as Row;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checksum = (message: CompanionMessage) => hash([message.id, message.conversationId, message.authorId, message.content, message.status, message.replyToId]);
const dayAt = (at: number, zone: string) => { const date = companionTimeInZone(at, zone); return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`; };

/** Peer rooms use the existing formal message authority; scheduling drafts never become evidence. */
export class CompanionSocialStore {
  readonly continuity: CompanionSocialContinuityStore;
  constructor(private readonly db: CompanionConnection,
    private readonly append: (input: AppendCompanionMessage) => CompanionMessage,
    private readonly message: (id: string) => CompanionMessage,
    private readonly visible: (scope: CompanionWorldScope, ids: string[]) => CompanionMessage[],
    private readonly calendar: () => Calendar,
    private readonly available: (owner: string, channel: Send['channel'], recipients: string[]) => boolean,
    private readonly speech: (message: CompanionSocialMessage, channel: Send['channel']) => void,
    private readonly clock: { elapsedVirtual(from: number, to: number): number } = { elapsedVirtual: (from, to) => to - from },
    private readonly options: { createPeerWork?(input: CompanionPeerWorkInput): void } = {}) {
    this.continuity = new CompanionSocialContinuityStore(db, append, message, visible,
      owner => available(owner, 'phone', []), () => calendar().backlog);
  }

  initialize(): void {
    this.continuity.initialize();
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_social_conversations(id TEXT PRIMARY KEY REFERENCES conversations(id),member_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS companion_social_messages(message_id TEXT PRIMARY KEY REFERENCES messages(id),conversation_id TEXT NOT NULL REFERENCES companion_social_conversations(id),sequence INTEGER NOT NULL UNIQUE,virtual_at TEXT NOT NULL,recipient_ids TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_message_time ON companion_social_messages(virtual_at,conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS companion_social_message_room ON companion_social_messages(conversation_id,sequence DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS companion_social_search USING fts5(content,title,tokenize='ascii');
      CREATE VIRTUAL TABLE IF NOT EXISTS companion_social_room_search USING fts5(id UNINDEXED,title,tokenize='ascii');
      CREATE TABLE IF NOT EXISTS companion_social_outbox(client_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,message_id TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_outbox_pending ON companion_social_outbox(status,created_at);
      CREATE INDEX IF NOT EXISTS companion_social_outbox_owner ON companion_social_outbox(companion_id,status);
      CREATE TABLE IF NOT EXISTS companion_social_chains(id TEXT PRIMARY KEY,used INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_social_jobs(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,status TEXT NOT NULL,lease_until TEXT,created_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_job_claim ON companion_social_jobs(status,lease_until,created_at);
      CREATE INDEX IF NOT EXISTS companion_social_job_owner ON companion_social_jobs(companion_id,status);
      CREATE TABLE IF NOT EXISTS companion_social_budget(message_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,kind TEXT NOT NULL,virtual_at TEXT NOT NULL,real_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_budget_owner ON companion_social_budget(companion_id,kind,virtual_at DESC);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS companion_social_communication(companion_id TEXT PRIMARY KEY,until_real TEXT NOT NULL,data TEXT NOT NULL)');
    this.db.function('companion_social_day', { deterministic: true }, value => { const [at, zone] = parse<[string, string]>(value); return dayAt(Date.parse(at), zone); });
    // Register authoritative peer rooms and reconstruct only their derived search/calendar index.
    for (const existing of this.db.prepare("SELECT c.id FROM conversations c JOIN metadata d ON d.key='world-room/'||c.id WHERE c.dissolved_at IS NULL AND (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id=c.id)>=2").all() as Row[]) {
      const members = this.members(String(existing.id));
      if (!members.every(id => this.active(id))) continue;
      this.db.prepare('INSERT OR IGNORE INTO companion_social_conversations(id,member_key) VALUES(?,?)').run(existing.id, members.join('|'));
    }
    this.db.transaction(() => { this.db.prepare('DELETE FROM companion_social_room_search').run(); for (const value of this.db.prepare('SELECT c.id,c.title FROM companion_social_conversations s JOIN conversations c ON c.id=s.id').all() as Row[]) this.db.prepare('INSERT INTO companion_social_room_search(id,title) VALUES(?,?)').run(value.id, companionSearchTokens(String(value.title))); }).immediate();
    for (const existing of this.db.prepare('SELECT m.id,m.created_at,m.conversation_id FROM messages m JOIN companion_social_conversations c ON c.id=m.conversation_id LEFT JOIN companion_social_messages s ON s.message_id=m.id WHERE s.message_id IS NULL ORDER BY m.sequence').all() as Row[]) {
      const evidence = this.db.prepare("SELECT json_extract(data,'$.at') AS at FROM companion_world_events WHERE json_extract(data,'$.sourceMessageId')=? LIMIT 1").get(existing.id);
      const message = this.message(String(existing.id));
      if (this.members(message.conversationId).includes(message.authorId)) this.index(message, String(evidence ? row(evidence).at : existing.created_at), this.members(message.conversationId).filter(id => id !== message.authorId));
    }
    const count = Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM companion_social_search').get()).n);
    if (count !== Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM companion_social_messages').get()).n)) {
      this.db.transaction(() => { this.db.prepare('DELETE FROM companion_social_search').run();
        for (const entry of this.db.prepare('SELECT s.sequence,m.content,c.title FROM companion_social_messages s JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=s.conversation_id').all() as Row[]) this.db.prepare('INSERT INTO companion_social_search(rowid,content,title) VALUES(?,?,?)').run(entry.sequence, companionSearchTokens(String(entry.content)), companionSearchTokens(String(entry.title)));
      }).immediate();
    }
  }
  private active(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM companions c WHERE id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed')").get(id); }
  private members(id: string): string[] { return (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id').all(id) as Row[]).map(value => String(value.companion_id)); }
  private requireRoom(id: string, owner?: string): string[] {
    const exists = this.db.prepare('SELECT 1 FROM companion_social_conversations s JOIN conversations c ON c.id=s.id WHERE s.id=? AND c.dissolved_at IS NULL').get(id);
    const members = this.members(id);
    if (!exists || members.length < 2 || !members.every(member => this.active(member)) || owner && !members.includes(owner)) throw new Error('这不是当前伙伴之间的有效社交会话。');
    return members;
  }
  ensure(owner: string, ids: string[], title = ''): CompanionSocialConversation {
    return this.db.transaction(() => {
      const members = [...new Set(ids)].sort();
      if (members.length < 2 || members.length !== ids.length || !members.includes(owner) || !members.every(id => this.active(id))) throw new Error('社交会话必须由至少两位真实伙伴组成。');
      const key = members.join('|'), existing = this.db.prepare('SELECT id FROM companion_social_conversations WHERE member_key=?').get(key);
      if (existing) return this.conversation(String(row(existing).id));
      const id = (members.length === 2 ? 'world_pair_' : 'world_group_') + createHash('sha256').update(key).digest('hex').slice(0, 24);
      const names = members.map(member => String(row(this.db.prepare("SELECT json_extract(data,'$.name') AS name FROM companions WHERE id=?").get(member)).name));
      this.db.prepare("INSERT OR IGNORE INTO conversations(id,kind,title,private_companion_id,updated_at,hidden_at) VALUES(?,'group',?,NULL,?,?)").run(id, title || names.join('、').slice(0, 100), iso(), iso());
      this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('world-room/' + id, 'true');
      for (const member of members) this.db.prepare('INSERT OR IGNORE INTO conversation_members(conversation_id,companion_id) VALUES(?,?)').run(id, member);
      this.db.prepare('INSERT INTO companion_social_conversations(id,member_key) VALUES(?,?)').run(id, key);
      this.db.prepare('INSERT INTO companion_social_room_search(id,title) VALUES(?,?)').run(id, companionSearchTokens(title || names.join('、').slice(0, 100)));
      return this.conversation(id);
    }).immediate();
  }
  private wrap(id: string): CompanionSocialMessage {
    const found = this.db.prepare('SELECT * FROM companion_social_messages WHERE message_id=?').get(id); if (!found) throw new Error('社交消息不存在。');
    const value = row(found); return { message: this.message(id), virtualCreatedAt: String(value.virtual_at), recipientIds: parse<string[]>(value.recipient_ids) };
  }
  private conversation(id: string): CompanionSocialConversation {
    const members = this.requireRoom(id), value = row(this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id));
    const latest = this.db.prepare('SELECT message_id FROM companion_social_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1').get(id);
    return { id, kind: members.length === 2 ? 'private' : 'group', title: String(value.title), memberIds: members, updatedAt: String(value.updated_at),
      messageCount: Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM companion_social_messages WHERE conversation_id=?').get(id)).n), ...(latest ? { lastMessage: this.wrap(String(row(latest).message_id)) } : {}) };
  }
  private index(message: CompanionMessage, virtualAt: string, recipients: string[]): void {
    this.db.prepare('INSERT INTO companion_message_times(message_id,world_at,time_zone) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET world_at=excluded.world_at,time_zone=excluded.time_zone')
      .run(message.id, virtualAt, this.calendar().timeZone);
    this.db.prepare('INSERT OR IGNORE INTO companion_social_messages(message_id,conversation_id,sequence,virtual_at,recipient_ids) VALUES(?,?,?,?,?)').run(message.id, message.conversationId, message.sequence, virtualAt, JSON.stringify(recipients));
    const title = String(row(this.db.prepare('SELECT title FROM conversations WHERE id=?').get(message.conversationId)).title);
    this.db.prepare('INSERT OR REPLACE INTO companion_social_search(rowid,content,title) VALUES(?,?,?)').run(message.sequence, companionSearchTokens(message.content), companionSearchTokens(title));
    this.db.prepare('UPDATE conversations SET hidden_at=? WHERE id=?').run(iso(), message.conversationId);
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
    const where = ['c.dissolved_at IS NULL', 'NOT EXISTS(SELECT 1 FROM conversation_members cm JOIN companions p ON p.id=cm.companion_id WHERE cm.conversation_id=c.id AND p.deleted_at IS NOT NULL)'], args: unknown[] = [];
    if (input.companionId) { if (!this.active(input.companionId)) throw new Error('伙伴不存在。'); where.push('EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.companion_id=?)'); args.push(input.companionId); }
    if (input.day || input.month) { const [from, to] = this.range(input.day ?? input.month!, context.timeZone, !!input.month); where.push('s.virtual_at>=? AND s.virtual_at<?'); args.push(from, to); }
    if (input.query?.trim()) { where.push('(c.id IN(SELECT id FROM companion_social_room_search WHERE companion_social_room_search MATCH ?) OR s.sequence IN(SELECT rowid FROM companion_social_search WHERE companion_social_search MATCH ?))'); const match = companionSearchMatch(input.query); args.push(match, match); }
    return { where, args };
  }
  conversations(input: Extract<CompanionStorageCommand, { type: 'social.conversations' }>): CompanionSocialConversationPage {
    const context = this.calendar(), { where, args } = this.filter(input, context);
    const from = ' FROM companion_social_conversations r JOIN conversations c ON c.id=r.id LEFT JOIN companion_social_messages s ON s.conversation_id=c.id LEFT JOIN messages m ON m.id=s.message_id';
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
  private sources(send: Send): { sourceChecksum?: string; authorizationChecksum?: string } {
    const scope = { companionId: send.companionId, conversationId: send.conversationId };
    let sourceChecksum: string | undefined, authorizationChecksum: string | undefined;
    if (send.sourceMessageId) { const source = this.visible(scope, [send.sourceMessageId])[0]; if (!source || source.authorId === 'user' || source.authorId === 'system' || source.conversationId !== send.conversationId) throw new Error('社交回复缺少同会话伙伴的真实来源。'); sourceChecksum = checksum(source); }
    if (send.replyToId) { const source = this.message(send.replyToId); if (source.conversationId !== send.conversationId || !this.visible(scope, [source.id]).length) throw new Error('不能引用其他聊天或已撤回的来源。'); }
    if (send.authorizationMessageId) { const source = this.message(send.authorizationMessageId); if (source.authorId !== 'user' || !this.visible({ companionId: send.companionId, conversationId: source.conversationId }, [source.id]).length) throw new Error('分享授权缺少真实可见的用户来源。'); authorizationChecksum = checksum(source); }
    return { sourceChecksum, authorizationChecksum };
  }
  private budget(owner: string, kind: 'initial' | 'reply', context: Calendar): boolean {
    const [from, to] = this.range(context.observedDay, context.timeZone), cap = kind === 'initial' ? 2 : 8;
    if (Number(row(this.db.prepare('SELECT COUNT(*) AS n FROM companion_social_budget WHERE companion_id=? AND kind=? AND virtual_at>=? AND virtual_at<?').get(owner, kind, from, to)).n) >= cap) return false;
    if (kind === 'initial') { const latest = this.db.prepare("SELECT virtual_at,real_at FROM companion_social_budget WHERE companion_id=? AND kind='initial' ORDER BY real_at DESC LIMIT 1").get(owner); if (latest && (this.clock.elapsedVirtual(Date.parse(String(row(latest).real_at)), Date.now()) < 21600000 || Date.now() - Date.parse(String(row(latest).real_at)) < 120000)) return false; }
    return true;
  }
  send(input: Send): CompanionStorageResponse {
    const context = this.calendar(); return this.db.transaction(() => {
      this.requireRoom(input.conversationId, input.companionId); const fingerprint = hash(input), existing = this.db.prepare('SELECT * FROM companion_social_outbox WHERE client_id=?').get(input.clientId);
      if (existing) { const value = row(existing), pending = parse<PendingSend>(value.data); if (pending.fingerprint !== fingerprint) throw new Error('社交发送的重试标识已经被其他内容使用。'); if (value.status === 'cancelled') throw new Error('这次待发消息的来源已经撤回。'); const delivered = value.message_id ? this.wrap(String(value.message_id)) : this.deliver(pending, context); return { ok: true, ...(delivered ? { socialMessage: delivered } : { socialPending: true }) }; }
      const sourceChecksums = this.sources(input), recipients = this.requireRoom(input.conversationId, input.companionId).filter(id => id !== input.companionId);
      const authorization = input.authorizationMessageId ? this.message(input.authorizationMessageId) : undefined;
      const originId = authorization ? this.continuity.record({ type: 'social.delegation.record', companionId: input.companionId,
        conversationId: authorization.conversationId, sourceMessageId: authorization.id, recipientIds: recipients, sharedText: input.content, intent: 'message' })
        : this.continuity.matchVisit(input.companionId, recipients);
      if (!originId && !input.sourceMessageId && row(this.db.prepare("SELECT json_extract(data,'$.proactive') AS enabled FROM companions WHERE id=?").get(input.companionId)).enabled === 0) throw new Error('该伙伴已关闭主动闲聊。');
      const send: PendingSend = { ...input, ...sourceChecksums, fingerprint, ...(originId ? { originId } : {}) };
      this.db.prepare("INSERT INTO companion_social_outbox(client_id,companion_id,conversation_id,status,created_at,data) VALUES(?,?,?,'pending',?,?)").run(input.clientId, input.companionId, input.conversationId, iso(), JSON.stringify(send));
      const delivered = this.deliver(send, context); return { ok: true, ...(delivered ? { socialMessage: delivered } : { socialPending: true }) };
    }).immediate();
  }
  private deliver(send: PendingSend, context: Calendar): CompanionSocialMessage | undefined {
    const members = this.requireRoom(send.conversationId, send.companionId), recipients = members.filter(id => id !== send.companionId), current = this.sources(send);
    if (current.sourceChecksum !== send.sourceChecksum || current.authorizationChecksum !== send.authorizationChecksum) throw new Error('待发送消息的来源已经修改。');
    if (send.originId && !this.continuity.validOrigin(send.originId)) throw new Error('这次社交委托已经失效。');
    if (context.backlog || this.phoneBusy(send.companionId, 'outbox:' + send.clientId) || this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(send.companionId, iso()) || !this.available(send.companionId, send.channel, recipients) || !send.originId && !send.authorizationMessageId && !this.budget(send.companionId, 'initial', context)) return undefined;
    if (send.channel === 'phone' && !send.typingNotBefore) {
      send.typingNotBefore = iso(Date.now() + 1200); this.communicate(send.companionId, send.conversationId, recipients, 'typing', 1200, 'outbox:' + send.clientId);
      this.db.prepare('UPDATE companion_social_outbox SET data=? WHERE client_id=?').run(JSON.stringify(send), send.clientId); return undefined;
    }
    if (send.typingNotBefore && Date.parse(send.typingNotBefore) > Date.now()) return undefined;
    const source = this.append({ conversationId: send.conversationId, authorId: send.companionId, content: send.content, clientId: send.clientId, replyToId: send.replyToId });
    this.index(source, context.virtualNow, recipients); const message = this.wrap(source.id), chainId = randomUUID();
    this.db.prepare("INSERT INTO companion_social_chains(id,used,status) VALUES(?,1,'active')").run(chainId);
    this.continuity.bind(chainId, send.companionId, send.content, send.originId);
    this.db.prepare("INSERT INTO companion_social_budget VALUES(?,?,'initial',?,?)").run(source.id, send.companionId, context.virtualNow, iso());
    this.db.prepare("UPDATE companion_social_outbox SET status='sent',message_id=? WHERE client_id=?").run(source.id, send.clientId);
    this.clearCommunication(send.companionId, 'outbox:' + send.clientId);
    this.speech(message, send.channel); this.queue(message, recipients[0]!, chainId, 3, send.channel);
    if (send.channel === 'phone') for (const recipient of recipients) this.communicate(recipient, send.conversationId, [send.companionId], 'notification', 5000, 'notification:' + source.id);
    return message;
  }
  private queue(source: CompanionSocialMessage, owner: string, chainId: string, remainingTurns: number, channel: Send['channel']): void {
    if (remainingTurns <= 0) { this.db.prepare("UPDATE companion_social_chains SET status='done' WHERE id=?").run(chainId); return; }
    const job: StoredJob = { id: randomUUID(), companionId: owner, conversationId: source.message.conversationId, sourceMessageId: source.message.id, throughSequence: source.message.sequence, chainId, remainingTurns, memberIds: this.members(source.message.conversationId), channel, status: 'pending', attempts: 0, typingNotBefore: iso(), createdAt: iso() };
    this.db.prepare('INSERT INTO companion_social_jobs(id,companion_id,conversation_id,status,created_at,data) VALUES(?,?,?,?,?,?)').run(job.id, owner, job.conversationId, job.status, job.createdAt, JSON.stringify(job));
  }
  private saveJob(job: StoredJob, leaseUntil?: string): void { this.db.prepare('UPDATE companion_social_jobs SET status=?,lease_until=?,data=? WHERE id=?').run(job.status, leaseUntil ?? null, JSON.stringify(job), job.id); }
  private publicJob(job: StoredJob): CompanionSocialJob {
    return { id: job.id, companionId: job.companionId, conversationId: job.conversationId, sourceMessageId: job.sourceMessageId,
      throughSequence: job.throughSequence, chainId: job.chainId, remainingTurns: job.remainingTurns, memberIds: job.memberIds,
      channel: job.channel, status: job.status, attempts: job.attempts, leaseToken: job.leaseToken, typingNotBefore: job.typingNotBefore, createdAt: job.createdAt,
      origin: this.continuity.forChain(job.chainId) };
  }
  private phoneBusy(owner: string, leaseId: string): boolean {
    return companionPlayerPhoneBusy(this.db, owner) || !!this.db.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id=? AND until_real>? AND json_extract(data,'$.phase')='typing' AND json_extract(data,'$.leaseId')!=?").get(owner, iso(), leaseId)
      || !!this.db.prepare("SELECT 1 FROM companion_social_notifications WHERE companion_id=? AND status='running' AND lease_until>?").get(owner, iso());
  }
  private clearCommunication(owner: string, leaseId: string): void { this.db.prepare("DELETE FROM companion_social_communication WHERE companion_id=? AND json_extract(data,'$.leaseId')=?").run(owner, leaseId); }
  private communicate(owner: string, conversationId: string, recipients: string[], phase: 'notification' | 'typing', duration: number, leaseId: string): void {
    if (this.phoneBusy(owner, leaseId)) return;
    const untilReal = iso(Date.now() + duration), value = { channel: 'phone', phase, conversationId, recipientIds: recipients, untilReal, leaseId };
    this.db.prepare('INSERT INTO companion_social_communication(companion_id,until_real,data) VALUES(?,?,?) ON CONFLICT(companion_id) DO UPDATE SET until_real=excluded.until_real,data=excluded.data').run(owner, untilReal, JSON.stringify(value));
  }
  private readSet(job: StoredJob): Read[] {
    const ids = (this.db.prepare('SELECT message_id FROM companion_social_messages WHERE conversation_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 50').all(job.conversationId, job.throughSequence) as Row[]).map(value => String(value.message_id));
    return this.visible({ companionId: job.companionId, conversationId: job.conversationId, beforeSequence: job.throughSequence }, ids).map(message => ({ id: message.id, checksum: checksum(message) }));
  }
  private validRead(job: StoredJob): boolean {
    const sources = this.readSet(job), present = new Map(sources.map(source => [source.id, source.checksum]));
    return !!present.get(job.sourceMessageId) && (job.readSet ?? []).every(source => present.get(source.id) === source.checksum);
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
        try { this.requireRoom(pending.conversationId, pending.companionId); const sources = this.sources(pending); if (sources.authorizationChecksum !== pending.authorizationChecksum || sources.sourceChecksum !== pending.sourceChecksum || pending.originId && !this.continuity.validOrigin(pending.originId)) throw new Error('撤回'); }
        catch { this.db.prepare("UPDATE companion_social_outbox SET status='cancelled' WHERE client_id=?").run(value.client_id); this.clearCommunication(pending.companionId, 'outbox:' + pending.clientId); continue; }
        const message = this.db.transaction(() => this.deliver(pending, context)).immediate(); dispatched ??= message;
        if (message || pending.typingNotBefore && Date.parse(pending.typingNotBefore) > Date.now()) { this.scanned('companion_social_outbox', pending.companionId, 0); break; }
      }
      const jobPredicate = "json_extract(data,'$.attempts')<8 AND (status='pending' OR status IN('running','failed') AND lease_until<=?)", now = iso();
      const jobOwners = this.db.prepare('SELECT companion_id FROM companion_social_jobs WHERE ' + jobPredicate + ' GROUP BY companion_id ORDER BY MIN(rowid)').all(now) as Row[];
      for (const owner of jobOwners) for (const value of this.candidates('companion_social_jobs', String(owner.companion_id), jobPredicate, [now])) {
        this.scanned('companion_social_jobs', String(owner.companion_id), Number(value.ordinal));
        const job = parse<StoredJob>(value.data);
        if (this.phoneBusy(job.companionId, 'job:' + job.id)) continue;
        if (this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(job.companionId, iso())) continue;
        try { this.requireRoom(job.conversationId, job.companionId); } catch { job.status = 'cancelled'; this.saveJob(job); continue; }
        const chain = this.db.prepare("SELECT used FROM companion_social_chains WHERE id=? AND status='active'").get(job.chainId);
        if (!chain || Number(row(chain).used) >= 4 || !this.continuity.chainValid(job.chainId)) { job.status = 'cancelled'; this.saveJob(job); continue; }
        job.readSet = this.readSet(job); if (!job.readSet.some(source => source.id === job.sourceMessageId)) { job.status = 'cancelled'; this.saveJob(job); continue; }
        if (context.backlog || !this.available(job.companionId, job.channel, job.memberIds.filter(id => id !== job.companionId)) || this.continuity.forChain(job.chainId)?.initiatorKind !== 'human_player' && !this.budget(job.companionId, 'reply', context)) continue;
        job.status = 'running'; job.attempts++; job.leaseToken = randomUUID(); job.typingNotBefore = iso(Date.now() + 1200); this.saveJob(job, iso(Date.now() + 180000));
        this.scanned('companion_social_jobs', job.companionId, 0);
        if (job.channel === 'phone') this.communicate(job.companionId, job.conversationId, job.memberIds.filter(id => id !== job.companionId), 'typing', 180000, 'job:' + job.id);
        return { ok: true, socialJob: this.publicJob(job), ...(dispatched ? { socialMessage: dispatched } : {}) };
      }
      return { ok: true, ...(dispatched ? { socialMessage: dispatched } : {}) };
    }).immediate();
  }
  complete(input: Extract<CompanionStorageCommand, { type: 'social.job.complete' }>): CompanionStorageResponse {
    const context = this.calendar(); return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM companion_social_jobs WHERE id=?').get(input.id); if (!existing) throw new Error('社交回复任务不存在。'); const job = parse<StoredJob>(row(existing).data);
      if (job.status !== 'running' || job.leaseToken !== input.leaseToken || Date.parse(String(row(existing).lease_until)) < Date.now()) throw new Error('这次社交回复的租约已经失效。');
      this.requireRoom(job.conversationId, job.companionId); if (!this.validRead(job) || !this.continuity.chainValid(job.chainId)) throw new Error('已观察的社交来源或原玩家委托已经撤回或修改，请重新读取。');
      if (context.backlog || this.phoneBusy(job.companionId, 'job:' + job.id) || !this.available(job.companionId, job.channel, job.memberIds.filter(id => id !== job.companionId)) || this.continuity.forChain(job.chainId)?.initiatorKind !== 'human_player' && !this.budget(job.companionId, 'reply', context)) { job.status = 'pending'; delete job.leaseToken; delete job.readSet; this.saveJob(job); this.clearCommunication(job.companionId, 'job:' + job.id); return { ok: true, socialPending: true }; }
      if (Date.parse(job.typingNotBefore) > Date.now()) throw new Error('伙伴仍在输入，尚未完成这次发言。');
      const chain = this.db.prepare("SELECT used FROM companion_social_chains WHERE id=? AND status='active'").get(job.chainId); if (!chain || Number(row(chain).used) >= 4) throw new Error('这次交谈已经结束。');
      if (input.nextRecipientId && (input.nextRecipientId === job.companionId || !job.memberIds.includes(input.nextRecipientId))) throw new Error('下一位回应者必须是同会话的其他伙伴。');
      if (input.workOffer) {
        const source = this.message(job.sourceMessageId), offer = input.workOffer;
        if (!input.text?.trim() || offer.sourceMessageId !== source.id || source.authorId === 'user' || source.authorId === job.companionId
          || !job.memberIds.includes(source.authorId) || !offer.evidence.every(quote => source.content.includes(quote))) throw new Error('伙伴工作必须来自当前真实来信的明确委托。');
        if (!this.options.createPeerWork) throw new Error('伙伴工作暂时不可用。');
        this.options.createPeerWork({ companionId: job.companionId, conversationId: job.conversationId, sourceMessageId: source.id,
          title: offer.title, instruction: offer.instruction, clientId: 'peerwork_' + job.id, accept: offer.accept });
      }
      job.status = 'done'; delete job.leaseToken;
      this.clearCommunication(job.companionId, 'job:' + job.id);
      if (!input.text?.trim()) { this.saveJob(job); this.db.prepare("UPDATE companion_social_chains SET status='done' WHERE id=?").run(job.chainId); return { ok: true }; }
      const source = this.append({ conversationId: job.conversationId, authorId: job.companionId, content: input.text, replyToId: job.sourceMessageId, clientId: 'social_' + job.id });
      const recipients = job.memberIds.filter(id => id !== job.companionId); this.index(source, context.virtualNow, recipients); const message = this.wrap(source.id);
      this.db.prepare('UPDATE companion_social_chains SET used=used+1 WHERE id=?').run(job.chainId);
      this.db.prepare("INSERT INTO companion_social_budget VALUES(?,?,'reply',?,?)").run(source.id, job.companionId, context.virtualNow, iso());
      job.resultMessageId = source.id; this.saveJob(job); this.speech(message, job.channel);
      this.continuity.peerReply(job.chainId, source);
      const next = input.nextRecipientId ?? this.message(job.sourceMessageId).authorId;
      this.queue(message, next, job.chainId, job.remainingTurns - 1, job.channel); return { ok: true, socialMessage: message };
    }).immediate();
  }
  fail(input: Extract<CompanionStorageCommand, { type: 'social.job.fail' }>): void {
    const existing = this.db.prepare('SELECT data FROM companion_social_jobs WHERE id=?').get(input.id); if (!existing) return; const job = parse<StoredJob>(row(existing).data);
    if (job.status !== 'running' || job.leaseToken !== input.leaseToken) return; job.status = 'failed'; delete job.leaseToken; this.saveJob(job, iso(Date.now() + Math.min(300000, 10000 * 2 ** Math.min(job.attempts, 5))));
    this.clearCommunication(job.companionId, 'job:' + job.id);
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    const continuity = this.continuity.execute(command); if (continuity) return continuity;
    switch (command.type) {
      case 'social.conversation.ensure': return { ok: true, socialConversation: this.ensure(command.companionId, command.memberIds, command.title) };
      case 'social.message.append': return { ok: true, socialMessage: this.appendMessage(command) };
      case 'social.conversations': return { ok: true, socialConversationPage: this.conversations(command) };
      case 'social.messages': return { ok: true, socialMessagePage: this.messages(command) };
      case 'social.days': return { ok: true, socialDays: this.days(command) };
      case 'social.send': return this.send(command);
      case 'social.job.claim': return this.claim();
      case 'social.job.complete': return this.complete(command);
      case 'social.job.fail': this.fail(command); return { ok: true };
      default: return undefined;
    }
  }
}
