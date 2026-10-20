import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import type { AppendCompanionMessage, CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionSocialNotification, CompanionSocialOrigin } from '../shared/companion-social';

type Row = Record<string, string | number | null>;
type Scope = { companionId: string; conversationId: string };
type Delegation = { id: string; companionId: string; conversationId: string; sourceMessageId: string; checksum: string; intent: 'visit' | 'message';
  recipientIds: string[]; sharedText: string; visitId?: string; lastVisitStatus?: string; createdAt: string };
type ResponseSource = { messageId: string; conversationId: string; checksum: string };
type Notice = CompanionSocialNotification & { sourceChecksum: string; evidenceChecksum?: string; resultMessageId?: string; responseSource?: ResponseSource;
  batchIds?: string[]; dialogueChecksum?: string; eventWatermark?: number };
type Visit = { id: string; guestId: string; hostId: string; status: string; sourceMessageId?: string; conversationId?: string; reason: string; response?: string; responseSourceMessageId?: string; responseConversationId?: string };
const row = (value: unknown) => value as Row;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const iso = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checksum = (message: CompanionMessage) => hash([message.id, message.conversationId, message.authorId, message.content, message.status, message.replyToId]);

/** Durable causal links and event continuations; never imports a player's room into a peer prompt. */
export class CompanionSocialContinuityStore {
  constructor(private readonly db: CompanionConnection, private readonly append: (message: AppendCompanionMessage) => CompanionMessage,
    private readonly message: (id: string) => CompanionMessage,
    private readonly visible: (scope: Scope, ids: string[]) => CompanionMessage[],
    private readonly ready: (owner: string) => boolean, private readonly backlog: () => boolean) {}

  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_social_delegations(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,source_message_id TEXT NOT NULL,visit_id TEXT,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_delegation_owner ON companion_social_delegations(companion_id,status);
      CREATE INDEX IF NOT EXISTS companion_social_delegation_source ON companion_social_delegations(source_message_id);
      CREATE INDEX IF NOT EXISTS companion_social_delegation_visit ON companion_social_delegations(visit_id,status);
      CREATE TABLE IF NOT EXISTS companion_social_chain_origins(chain_id TEXT PRIMARY KEY,origin_id TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_chain_origin ON companion_social_chain_origins(origin_id);
      CREATE TABLE IF NOT EXISTS companion_social_notifications(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,origin_id TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,lease_until TEXT,attempts INTEGER NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_social_notification_due ON companion_social_notifications(status,lease_until,created_at);
      CREATE INDEX IF NOT EXISTS companion_social_notification_owner ON companion_social_notifications(companion_id,status);
      CREATE INDEX IF NOT EXISTS companion_social_notification_origin ON companion_social_notifications(origin_id);
      CREATE TRIGGER IF NOT EXISTS companion_social_source_deleted BEFORE DELETE ON messages BEGIN
        DELETE FROM companion_social_notifications WHERE origin_id IN(SELECT id FROM companion_social_delegations WHERE source_message_id=old.id);
        DELETE FROM companion_social_chain_origins WHERE origin_id IN(SELECT id FROM companion_social_delegations WHERE source_message_id=old.id);
        DELETE FROM companion_social_delegations WHERE source_message_id=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS companion_social_origin_deleted BEFORE DELETE ON companion_social_delegations BEGIN
        DELETE FROM companion_social_notifications WHERE origin_id=old.id;
        DELETE FROM companion_social_chain_origins WHERE origin_id=old.id;
      END;`);
  }
  private active(owner: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM companions c WHERE c.id=? AND c.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed')").get(owner);
  }
  private valid(origin: Delegation): boolean {
    if (!this.active(origin.companionId) || origin.recipientIds.some(id => !this.active(id))) return false;
    try {
      const source = this.visible({ companionId: origin.companionId, conversationId: origin.conversationId }, [origin.sourceMessageId])[0];
      return !!source && source.authorId === 'user' && source.status === 'sent' && !source.isReplyDraft && checksum(source) === origin.checksum
        && !this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + origin.conversationId);
    } catch { return false; }
  }
  private get(id: string): Delegation | undefined {
    const found = this.db.prepare("SELECT data FROM companion_social_delegations WHERE id=? AND status='active'").get(id);
    if (!found) return undefined; const origin = parse<Delegation>(row(found).data);
    if (this.valid(origin)) return origin;
    this.db.prepare("UPDATE companion_social_delegations SET status='cancelled' WHERE id=?").run(id);
    this.db.prepare("UPDATE companion_social_notifications SET status='cancelled' WHERE origin_id=? AND status!='done'").run(id);
    return undefined;
  }
  private publicOrigin(origin: Delegation): CompanionSocialOrigin {
    return { id: origin.id, initiatorId: 'user', initiatorKind: 'human_player', ownerId: origin.companionId,
      sharedText: origin.sharedText, provenance: 'current_player_request' };
  }
  record(input: Extract<CompanionStorageCommand, { type: 'social.delegation.record' }>): string {
    return this.db.transaction(() => {
      const recipients = [...new Set(input.recipientIds)].sort();
      if (recipients.length !== input.recipientIds.length || recipients.includes(input.companionId) || !recipients.length) throw new Error('委托收件人无效。');
      const source = this.message(input.sourceMessageId);
      const origin: Delegation = { id: 'delegation_' + hash([input.companionId, source.id, recipients, input.sharedText, input.visitId]).slice(0, 48),
        companionId: input.companionId, conversationId: input.conversationId, sourceMessageId: source.id, checksum: checksum(source),
        recipientIds: recipients, sharedText: input.sharedText, visitId: input.visitId, intent: input.intent ?? 'visit', createdAt: iso() };
      if (source.conversationId !== input.conversationId || !this.valid(origin)) throw new Error('社交委托需要本次真实可见的玩家来源。');
      if (input.visitId) {
        const found = this.db.prepare('SELECT data FROM companion_world_visit_records WHERE id=?').get(input.visitId), visit = found ? parse<Visit>(row(found).data) : undefined;
        if (!visit || visit.guestId !== input.companionId || recipients.length !== 1 || visit.hostId !== recipients[0]
          || visit.sourceMessageId !== source.id || visit.conversationId !== input.conversationId || visit.reason !== input.sharedText) throw new Error('拜访委托与实际请求不一致。');
      }
      this.db.prepare("INSERT OR IGNORE INTO companion_social_delegations(id,companion_id,source_message_id,visit_id,status,data) VALUES(?,?,?,?,'active',?)")
        .run(origin.id, origin.companionId, origin.sourceMessageId, origin.visitId ?? null, JSON.stringify(origin));
      return origin.id;
    }).immediate();
  }
  matchVisit(owner: string, recipients: string[]): string | undefined {
    this.bindVisits();
    const key = [...recipients].sort().join('|');
    const values = this.db.prepare("SELECT d.data FROM companion_social_delegations d JOIN companion_world_visit_records v ON v.id=d.visit_id WHERE d.companion_id=? AND d.status='active' AND v.status IN('requested','allowed') ORDER BY d.rowid DESC LIMIT 64").all(owner) as Row[];
    for (const value of values) { const origin = parse<Delegation>(value.data); if (origin.recipientIds.join('|') === key && this.get(origin.id)) return origin.id; }
    return undefined;
  }
  hasDelegationTo(owner: string, target: string): boolean { return !!this.matchVisit(owner, [target]); }
  validOrigin(id: string): boolean { return !!this.get(id); }
  bind(chainId: string, owner: string, text: string, originId?: string): void {
    const origin = originId ? this.get(originId) : undefined;
    if (originId && !origin) throw new Error('原玩家委托已经失效。');
    const value: CompanionSocialOrigin = origin ? this.publicOrigin(origin) : { id: chainId, initiatorId: owner,
      initiatorKind: 'companion', ownerId: owner, sharedText: text, provenance: 'companion_initiative' };
    this.db.prepare('INSERT INTO companion_social_chain_origins(chain_id,origin_id,data) VALUES(?,?,?)').run(chainId, originId ?? null, JSON.stringify(value));
  }
  chainValid(chainId: string): boolean {
    const found = this.db.prepare('SELECT origin_id FROM companion_social_chain_origins WHERE chain_id=?').get(chainId);
    return !!found && (!row(found).origin_id || !!this.get(String(row(found).origin_id)));
  }
  forChain(chainId: string): CompanionSocialOrigin | undefined {
    const found = this.db.prepare('SELECT * FROM companion_social_chain_origins WHERE chain_id=?').get(chainId);
    if (!found || !this.chainValid(chainId)) return undefined; return parse<CompanionSocialOrigin>(row(found).data);
  }
  peerReply(chainId: string, message: CompanionMessage): void {
    const found = this.db.prepare('SELECT origin_id FROM companion_social_chain_origins WHERE chain_id=?').get(chainId);
    if (!found || !row(found).origin_id) return;
    const origin = this.get(String(row(found).origin_id));
    if (!origin || !origin.recipientIds.includes(message.authorId)) return;
    const members = (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id').all(message.conversationId) as Row[]).map(value => String(value.companion_id));
    if (members.join('|') !== [...origin.recipientIds, origin.companionId].sort().join('|')) return;
    this.enqueue(origin, { kind: 'peer_reply', eventId: message.id, peerConversationId: message.conversationId,
      evidence: { authorId: message.authorId, text: message.content, messageId: message.id } }, checksum(message));
  }
  private enqueue(origin: Delegation, event: Pick<Notice, 'kind' | 'eventId' | 'peerConversationId' | 'evidence'>, evidenceChecksum?: string, responseSource?: ResponseSource): void {
    const key = origin.id + ':' + event.kind + ':' + event.eventId, id = 'social_notice_' + hash(key).slice(0, 48);
    const notice: Notice = { id, companionId: origin.companionId, conversationId: origin.conversationId, sourceMessageId: origin.sourceMessageId,
      origin: this.publicOrigin(origin), ...event, status: 'pending', attempts: 0, createdAt: iso(), sourceChecksum: origin.checksum, evidenceChecksum, responseSource };
    this.db.prepare("INSERT OR IGNORE INTO companion_social_notifications(id,companion_id,origin_id,event_key,status,attempts,created_at,data) VALUES(?,?,?,?,'pending',0,?,?)")
      .run(id, origin.companionId, origin.id, key, notice.createdAt, JSON.stringify(notice));
  }
  private observeVisits(): void {
    this.bindVisits();
    const values = this.db.prepare("SELECT d.data AS origin,v.data AS visit FROM companion_social_delegations d JOIN companion_world_visit_records v ON v.id=d.visit_id WHERE d.status='active' AND v.status IN('allowed','denied','expired','left') AND COALESCE(json_extract(d.data,'$.lastVisitStatus'),'')!=v.status LIMIT 32").all() as Row[];
    for (const value of values) {
      const origin = parse<Delegation>(value.origin), visit = parse<Visit>(value.visit);
      if (!this.get(origin.id)) continue;
      origin.lastVisitStatus = visit.status;
      this.db.prepare('UPDATE companion_social_delegations SET data=? WHERE id=?').run(JSON.stringify(origin), origin.id);
      const responseSource = this.visitResponseSource(visit);
      if (responseSource === null) continue;
      this.enqueue(origin, { kind: 'visit_permission', eventId: visit.id + '_' + visit.status,
        evidence: { authorId: visit.hostId, text: visit.response ?? (visit.status === 'expired' ? '拜访请求已过期。' : visit.status === 'left' ? '拜访已经结束。' : ''),
          visitId: visit.id, visitStatus: visit.status as 'allowed' | 'denied' | 'expired' | 'left' } }, hash([visit.id, visit.guestId, visit.hostId, visit.status, visit.response]), responseSource);
    }
  }
  private bindVisits(): void {
    const values = this.db.prepare("SELECT d.data AS origin,v.data AS visit FROM companion_social_delegations d JOIN companion_world_visit_records v ON v.guest_id=d.companion_id AND json_extract(v.data,'$.sourceMessageId')=d.source_message_id WHERE d.status='active' AND d.visit_id IS NULL AND json_extract(d.data,'$.intent')='visit' AND v.status IN('requested','allowed') LIMIT 32").all() as Row[];
    for (const value of values) {
      const origin = parse<Delegation>(value.origin), visit = parse<Visit>(value.visit);
      if (origin.recipientIds.length !== 1 || visit.hostId !== origin.recipientIds[0] || visit.reason !== origin.sharedText
        || visit.conversationId !== origin.conversationId || !this.get(origin.id)) continue;
      origin.visitId = visit.id;
      this.db.prepare('UPDATE companion_social_delegations SET visit_id=?,data=? WHERE id=?').run(visit.id, JSON.stringify(origin), origin.id);
    }
  }
  private visitResponseSource(visit: Visit): ResponseSource | null | undefined {
    if (!visit.responseSourceMessageId) return undefined;
    if (!visit.responseConversationId || !this.active(visit.hostId)) return null;
    try {
      const source = this.visible({ companionId: visit.hostId, conversationId: visit.responseConversationId }, [visit.responseSourceMessageId])
        .find(message => message.id === visit.responseSourceMessageId && message.conversationId === visit.responseConversationId);
      if (!source || source.status !== 'sent' || source.isReplyDraft || source.replyDraft) return null;
      return { messageId: source.id, conversationId: source.conversationId, checksum: checksum(source) };
    } catch { return null; }
  }
  private validNotice(notice: Notice): boolean {
    const origin = this.get(notice.origin.id);
    if (!origin || origin.checksum !== notice.sourceChecksum) return false;
    if (notice.kind === 'peer_reply') {
      try {
        const source = this.visible({ companionId: notice.companionId, conversationId: notice.peerConversationId! }, [notice.evidence.messageId!])[0];
        return !!source && source.authorId === notice.evidence.authorId && source.authorId !== notice.companionId && checksum(source) === notice.evidenceChecksum;
      } catch { return false; }
    }
    const found = this.db.prepare('SELECT data FROM companion_world_visit_records WHERE id=?').get(notice.evidence.visitId!);
    if (!found) return false; const visit = parse<Visit>(row(found).data);
    const responseSource = this.visitResponseSource(visit);
    return responseSource !== null && hash(responseSource ?? null) === hash(notice.responseSource ?? null)
      && visit.guestId === notice.companionId && visit.hostId === notice.evidence.authorId && visit.status === notice.evidence.visitStatus
      && hash([visit.id, visit.guestId, visit.hostId, visit.status, visit.response]) === notice.evidenceChecksum;
  }
  private save(notice: Notice, lease?: string): void {
    this.db.prepare('UPDATE companion_social_notifications SET status=?,lease_until=?,attempts=?,data=? WHERE id=?')
      .run(notice.status, lease ?? null, notice.attempts, JSON.stringify(notice), notice.id);
  }
  private publicNotice(notice: Notice): CompanionSocialNotification {
    const { sourceChecksum: _source, evidenceChecksum: _evidence, resultMessageId: _result, responseSource: _response,
      batchIds: _batch, dialogueChecksum: _dialogue, eventWatermark: _watermark, ...result } = notice;
    void _source; void _evidence; void _result; void _response; void _batch; void _dialogue; void _watermark; return result;
  }
  private eventWatermark(originId: string): number {
    return Number(row(this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS ordinal FROM companion_social_notifications WHERE origin_id=?').get(originId)).ordinal);
  }
  /** The reporting actor's actual player room, never a peer's private transcript. */
  private dialogue(notice: Notice): CompanionMessage[] {
    const source = this.message(notice.sourceMessageId);
    // Keep causal progress even if an unrelated long conversation has pushed it
    // out of the recent page; never reconstruct it from a model's cached summary.
    const reported = (this.db.prepare("SELECT DISTINCT m.id,m.sequence FROM companion_social_notifications n JOIN messages m ON m.id=json_extract(n.data,'$.resultMessageId') WHERE n.origin_id=? AND n.status='done' AND m.conversation_id=? ORDER BY m.sequence DESC LIMIT 10")
      .all(notice.origin.id, notice.conversationId) as Row[]).map(value => String(value.id));
    const recent = (this.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence DESC LIMIT 50')
      .all(notice.conversationId, source.sequence) as Row[]).map(value => String(value.id));
    const ids = [...new Set([...reported, ...recent])].slice(0, 50);
    return this.visible({ companionId: notice.companionId, conversationId: notice.conversationId }, ids).filter(message => message.conversationId === notice.conversationId && message.status === 'sent'
      && !message.isReplyDraft && !message.replyDraft).sort((a, b) => a.sequence - b.sequence);
  }
  private batch(notice: Notice): Notice[] {
    return (notice.batchIds ?? [notice.id]).flatMap(id => {
      const found = this.db.prepare('SELECT data FROM companion_social_notifications WHERE id=?').get(id);
      return found ? [parse<Notice>(row(found).data)] : [];
    });
  }
  private defer(notices: Notice[]): CompanionStorageResponse {
    for (const notice of notices) {
      notice.status = this.validNotice(notice) ? 'pending' : 'cancelled'; delete notice.leaseToken; this.save(notice);
    }
    return { ok: true, socialPending: true };
  }
  claim(): CompanionStorageResponse {
    return this.db.transaction(() => {
      this.observeVisits(); if (this.backlog()) return { ok: true };
      const values = this.db.prepare("SELECT data FROM companion_social_notifications WHERE status='pending' OR status IN('running','failed') AND lease_until<=? ORDER BY created_at,rowid LIMIT 32").all(iso()) as Row[];
      for (const value of values) {
        const notice = parse<Notice>(value.data);
        if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND json_extract(data,'$.active')=1").get(notice.companionId)) continue;
        if (!this.validNotice(notice)) { notice.status = 'cancelled'; delete notice.leaseToken; this.save(notice); continue; }
        if (!this.ready(notice.companionId) || companionPlayerPhoneBusy(this.db, notice.companionId) || this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(notice.companionId, iso())
          || this.db.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id=? AND until_real>? AND json_extract(data,'$.phase')='typing'").get(notice.companionId, iso())
          || this.db.prepare("SELECT 1 FROM companion_social_notifications WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(notice.companionId, iso())) continue;
        // Collapse already waiting facts for the same delegation into one coherent report.
        const siblings = this.db.prepare("SELECT data FROM companion_social_notifications WHERE origin_id=? AND id!=? AND (status='pending' OR status IN('running','failed') AND lease_until<=?) ORDER BY created_at,rowid LIMIT 15")
          .all(notice.origin.id, notice.id, iso()) as Row[];
        const batch = [notice];
        for (const sibling of siblings) {
          const candidate = parse<Notice>(sibling.data);
          if (candidate.companionId === notice.companionId && candidate.conversationId === notice.conversationId && this.validNotice(candidate)) batch.push(candidate);
          else { candidate.status = 'cancelled'; delete candidate.leaseToken; this.save(candidate); }
        }
        const token = hash([notice.id, notice.attempts + 1, Date.now()]).slice(0, 48), until = new Date(Date.now() + 180000).toISOString();
        for (const item of batch) {
          item.status = 'running'; item.attempts++; item.leaseToken = token;
          delete item.batchIds; delete item.events; delete item.dialogue; delete item.dialogueChecksum; delete item.eventWatermark; this.save(item, until);
        }
        notice.batchIds = batch.map(item => item.id);
        notice.events = batch.map(({ kind, eventId, peerConversationId, evidence }) => ({ kind, eventId, peerConversationId, evidence }));
        notice.dialogue = this.dialogue(notice); notice.dialogueChecksum = hash(notice.dialogue);
        notice.eventWatermark = this.eventWatermark(notice.origin.id);
        this.save(notice, until); return { ok: true, socialNotification: this.publicNotice(notice) };
      }
      return { ok: true };
    }).immediate();
  }
  complete(input: Extract<CompanionStorageCommand, { type: 'social.notification.complete' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const found = this.db.prepare('SELECT * FROM companion_social_notifications WHERE id=?').get(input.id);
      if (!found) throw new Error('这次后续回报已经失效。'); const value = row(found), notice = parse<Notice>(value.data);
      if (notice.status === 'done') return { ok: true, ...(notice.resultMessageId ? { message: this.message(notice.resultMessageId) } : {}) };
      if (notice.status !== 'running' || notice.leaseToken !== input.leaseToken || Date.parse(String(value.lease_until)) < Date.now()
        || !this.validNotice(notice)) throw new Error('后续回报的来源或租约已经变化。');
      const batch = this.batch(notice);
      if (batch.length !== (notice.batchIds?.length ?? 1) || batch.some(item => item.status !== 'running' || item.leaseToken !== notice.leaseToken)) throw new Error('后续回报的批次租约已经变化。');
      // A player reply, activity result, withdrawal or other report may land during inference.
      // Rebuild from the new dialogue instead of committing an isolated stale answer.
      if (batch.some(item => !this.validNotice(item)) || this.backlog() || !this.ready(notice.companionId) || companionPlayerPhoneBusy(this.db, notice.companionId)
        || notice.eventWatermark !== undefined && this.eventWatermark(notice.origin.id) !== notice.eventWatermark
        || notice.dialogueChecksum !== undefined && notice.dialogueChecksum !== hash(this.dialogue(notice))) return this.defer(batch);
      const message = input.text === null ? undefined : this.append({ conversationId: notice.conversationId, authorId: notice.companionId, content: input.text,
        replyToId: notice.sourceMessageId, clientId: 'notice_' + notice.id });
      for (const item of batch) {
        item.status = 'done'; delete item.leaseToken; item.resultMessageId = message?.id;
        delete item.dialogue; delete item.dialogueChecksum; delete item.events; delete item.batchIds; delete item.eventWatermark; this.save(item);
      }
      return { ok: true, message };
    }).immediate();
  }
  fail(input: Extract<CompanionStorageCommand, { type: 'social.notification.fail' }>): void {
    this.db.transaction(() => {
      const found = this.db.prepare('SELECT data FROM companion_social_notifications WHERE id=?').get(input.id); if (!found) return;
      const notice = parse<Notice>(row(found).data); if (notice.status !== 'running' || notice.leaseToken !== input.leaseToken) return;
      for (const item of this.batch(notice)) {
        if (item.status !== 'running' || item.leaseToken !== input.leaseToken) continue;
        item.status = this.validNotice(item) ? 'failed' : 'cancelled'; delete item.leaseToken;
        this.save(item, new Date(Date.now() + Math.min(900000, 10000 * 2 ** Math.min(item.attempts, 7))).toISOString());
      }
    }).immediate();
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'social.delegation.record': this.record(command); return { ok: true };
      case 'social.notification.claim': return this.claim();
      case 'social.notification.complete': return this.complete(command);
      case 'social.notification.fail': this.fail(command); return { ok: true };
      default: return undefined;
    }
  }
}

/** Waiting player messages do not reserve the phone; an actual ready chat does. */
export function companionPlayerPhoneBusy(db: CompanionConnection, companionId: string): boolean {
  return !!db.prepare("SELECT 1 FROM companion_world_work_records WHERE companion_id=? AND status='ready' AND json_extract(data,'$.kind')='chat' LIMIT 1").get(companionId);
}
