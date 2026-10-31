import { companionAttentionCanClaim } from './attention-queue';
import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import type { AppendCompanionMessage, CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionSocialNotification, CompanionSocialOrigin } from '../shared/companion-social';
import type { CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import type { CompanionUserStop } from '../shared/companion-task-stop';
import type { CompanionTaskControlResult } from '../shared/companion-task-control';
import { assertCompanionAgendaNativeClaim, assertCompanionAgendaNativeParent, bindCompanionAgendaNative, companionAgendaNativeBound, companionAgendaNativeParentId, controlCompanionAgendaNative } from './agenda-native-parent';

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
const NOTIFICATION_BATCH_LIMIT = 4;

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
  bind(chainId: string, owner: string, text: string, originId?: string, shareCurrentTextOnly = false): void {
    const origin = originId ? this.get(originId) : undefined;
    if (originId && !origin) throw new Error('原玩家委托已经失效。');
    const value: CompanionSocialOrigin = origin ? { ...this.publicOrigin(origin), ...(shareCurrentTextOnly ? { sharedText: text } : {}) } : { id: chainId, initiatorId: owner,
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
  stopNotification(companionId: string, id: string, stop: CompanionUserStop): CompanionTaskControlResult {
    return this.db.transaction(() => {
      const found = this.db.prepare('SELECT companion_id,data FROM companion_social_notifications WHERE id=?').get(id);
      if (!found || row(found).companion_id !== companionId) throw new Error('后续回报任务不存在或不属于此伙伴。');
      const notice = parse<Notice>(row(found).data);
      if (notice.companionId !== companionId) throw new Error('后续回报任务的伙伴归属不一致。');
      const result: CompanionTaskControlResult = { companionId, kind: 'social_notification', id, conversationId: notice.conversationId,
        title: '向用户回报后续进展', sourceMessageId: notice.sourceMessageId, stopped: !!notice.stop, actionIds: [], activityTaskIds: [], runtimeTaskIds: [id] };
      if (notice.status === 'done' || notice.status === 'cancelled' || notice.terminal) return result;
      if (notice.leaseToken) {
        const related = this.db.prepare("SELECT data FROM companion_social_notifications WHERE companion_id=? AND origin_id=? AND status='running' AND json_extract(data,'$.leaseToken')=?").all(companionId, notice.origin.id, notice.leaseToken) as Row[];
        for (const value of related) {
          const sibling = parse<Notice>(value.data);
          if (sibling.id === id) continue;
          if (sibling.batchIds?.includes(id)) result.runtimeTaskIds!.push(sibling.id);
          // The stopped item invalidates the shared inference batch. Other
          // notices return to pending instead of becoming errors or user stops.
          sibling.status = 'pending'; sibling.attempts = Math.max(0, sibling.attempts - 1);
          delete sibling.leaseToken; delete sibling.batchIds; delete sibling.dialogue; delete sibling.dialogueChecksum;
          delete sibling.events; delete sibling.eventWatermark; this.save(sibling);
        }
      }
      notice.status = 'cancelled'; notice.terminal = true; notice.stop = stop; notice.updatedAt = notice.finishedAt = stop.requestedAt;
      delete notice.leaseToken; delete notice.error; this.save(notice);
      result.stopped = true; result.runtimeTaskIds = [...new Set(result.runtimeTaskIds)];
      return result;
    }).immediate();
  }
  private save(notice: Notice, lease?: string): void {
    if (notice.agendaInputVersion) notice.agendaRevision = (notice.agendaRevision ?? 0) + 1;
    notice.agendaRetryAt = ['pending', 'failed'].includes(notice.status) ? lease : undefined;
    this.db.prepare('UPDATE companion_social_notifications SET status=?,lease_until=?,attempts=?,data=? WHERE id=?')
      .run(notice.status, lease ?? null, notice.attempts, JSON.stringify(notice), notice.id);
  }
  private publicNotice(notice: Notice): CompanionSocialNotification {
    const { sourceChecksum: _source, evidenceChecksum: _evidence, resultMessageId: _result, responseSource: _response,
      batchIds: _batch, dialogueChecksum: _dialogue, eventWatermark: _watermark, ...result } = notice;
    void _source; void _evidence; void _result; void _response; void _batch; void _dialogue; void _watermark;
    return { ...result, agendaParentRunId: companionAgendaNativeParentId(this.db, 'notification', notice.id, notice.companionId) };
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
  /** Resolve sent facts only after proving the immutable human goal and real
   * outbox/job lineage. Reading metadata here grants no unrelated raw room. */
  private progress(notice: Pick<Notice, 'sourceMessageId' | 'companionId' | 'conversationId'>): NonNullable<CompanionSocialNotification['progressEvidence']> {
    const original = this.message(notice.sourceMessageId), bodyHash = (text: string) => createHash('sha256').update(text).digest('hex');
    const taskRows = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? AND source_message_id=?')
      .all(notice.companionId, notice.conversationId, original.id) as Row[];
    const tasks = taskRows.map(value => parse<{ id: string; sourceChecksum?: string; seededSocialClientIds?: string[]; status: string; step: number; history: unknown[] }>(value.data))
      .filter(task => task.sourceChecksum === bodyHash(original.content))
      .map(task => ({ id: task.id, status: ['queued', 'running', 'waiting'].includes(task.status) ? 'active' : task.status,
        step: task.step, history: task.history, seededSocialClientIds: task.seededSocialClientIds }));
    const seeded = new Set(tasks.flatMap(task => task.seededSocialClientIds ?? []));
    const sent: Array<{ message: CompanionMessage; recipientIds: string[] }> = [];
    const add = (id: string, room: string, expected?: string) => {
      const message = this.visible({ companionId: notice.companionId, conversationId: room }, [id]).find(message => message.id === id && message.conversationId === room);
      if (!message || message.authorId !== notice.companionId || message.status !== 'sent' || message.isReplyDraft || message.replyDraft
        || expected !== undefined && message.content !== expected) return;
      const indexed = this.db.prepare('SELECT recipient_ids FROM companion_social_messages WHERE message_id=? AND conversation_id=?').get(id, room);
      if (!indexed) return;
      const recipientIds = parse<string[]>(row(indexed).recipient_ids).filter(id => id !== notice.companionId);
      if (!recipientIds.length) return;
      sent.push({ message, recipientIds });
    };
    const digest = (message: CompanionMessage) => hash([message.id, message.conversationId, message.topicId, message.authorId, message.content, message.status, message.replyToId]);
    for (const value of this.db.prepare("SELECT client_id,message_id,conversation_id,data FROM companion_social_outbox WHERE companion_id=? AND status='sent' AND (json_extract(data,'$.authorizationMessageId')=? OR client_id IN(SELECT value FROM json_each(?))) ORDER BY rowid")
      .all(notice.companionId, original.id, JSON.stringify([...seeded])) as Row[]) {
      const out = parse<{ companionId: string; conversationId: string; content: string; authorizationMessageId?: string; authorizationChecksum?: string;
        sourceMessageId?: string; sourceChecksum?: string; agentSource?: { conversationId: string; messageId: string }; agentChecksum?: string }>(value.data);
      if (out.companionId !== notice.companionId || out.conversationId !== value.conversation_id
        || out.authorizationMessageId !== original.id && !seeded.has(String(value.client_id))) continue;
      const check = (room: string, id: string, expected?: string) => this.visible({ companionId: notice.companionId, conversationId: room }, [id])
        .some(message => message.id === id && message.conversationId === room && digest(message) === expected);
      if (out.authorizationMessageId && (out.authorizationMessageId !== original.id || digest(original) !== out.authorizationChecksum)
        || out.sourceMessageId && !check(out.conversationId, out.sourceMessageId, out.sourceChecksum)
        || out.agentSource && !check(out.agentSource.conversationId, out.agentSource.messageId, out.agentChecksum)) continue;
      if (!out.authorizationMessageId) {
        const causal = out.agentSource ?? (out.sourceMessageId ? { conversationId: out.conversationId, messageId: out.sourceMessageId } : undefined);
        if (!causal) continue;
        if (causal.messageId !== original.id || causal.conversationId !== original.conversationId) {
          const jobs = this.db.prepare("SELECT j.data,c.origin_id FROM companion_social_jobs j JOIN companion_social_chain_origins c ON c.chain_id=json_extract(j.data,'$.chainId') JOIN companion_social_delegations d ON d.id=c.origin_id WHERE j.companion_id=? AND j.conversation_id=? AND json_extract(j.data,'$.sourceMessageId')=? AND j.status IN('running','done') AND d.companion_id=? AND d.source_message_id=? AND json_extract(d.data,'$.conversationId')=?")
            .all(notice.companionId, causal.conversationId, causal.messageId, notice.companionId, original.id, original.conversationId) as Row[];
          if (!jobs.some(value => {
            const job = parse<{ chainId: string; readSet?: Array<{ id: string; checksum: string }> }>(value.data);
            const source = this.visible({ companionId: notice.companionId, conversationId: causal.conversationId }, [causal.messageId])[0];
            return source && this.chainValid(job.chainId) && job.readSet?.some(read => read.id === source.id && read.checksum === digest(source));
          })) continue;
        }
      }
      if (value.message_id) add(String(value.message_id), out.conversationId, out.content);
    }
    // Replies made by this owner on the same original delegation are real
    // outbound too, even though social.job.complete does not create an outbox.
    for (const value of this.db.prepare("SELECT j.data FROM companion_social_jobs j JOIN companion_social_chain_origins c ON c.chain_id=json_extract(j.data,'$.chainId') JOIN companion_social_delegations d ON d.id=c.origin_id WHERE j.companion_id=? AND j.status='done' AND d.companion_id=? AND d.source_message_id=? AND json_extract(d.data,'$.conversationId')=?").all(notice.companionId, notice.companionId, original.id, notice.conversationId) as Row[]) {
      const job = parse<{ chainId: string; conversationId: string; resultMessageId?: string }>(value.data);
      if (job.resultMessageId && this.chainValid(job.chainId)) add(job.resultMessageId, job.conversationId);
    }
    const all = [...new Map(sent.map(item => [item.message.id, item])).values()].sort((a, b) => a.message.sequence - b.message.sequence);
    return { observationChecksum: hash({ tasks, sent: all.map(item => [item.message.id, item.message.conversationId, bodyHash(item.message.content), item.recipientIds]) }),
      outbound: all.slice(-100), complete: all.length <= 100 };
  }
  /** The existing Activity observer may request the same exact goal view. It
   * is not a new model tool and never accepts a model-supplied origin/title. */
  progressForGoal(scope: { companionId: string; conversationId: string; sourceMessageId: string }): NonNullable<CompanionSocialNotification['progressEvidence']> {
    const source = this.visible(scope, [scope.sourceMessageId]).find(message => message.id === scope.sourceMessageId
      && message.conversationId === scope.conversationId && message.authorId === 'user' && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft);
    if (!source) throw new Error('实际目标来源不可访问，不能读取出站进度。');
    return this.progress(scope);
  }
  private readset(notice: Notice, provided?: CompanionExecutionReadset): CompanionExecutionReadset {
    if (provided && (!provided.complete || provided.companionId !== notice.companionId || provided.conversationId !== notice.conversationId)) throw new Error('通知执行读集归属或覆盖不完整。');
    const result: CompanionExecutionReadset = provided ?? { schema: 'worldlinebox.companion-execution-readset-v1', companionId: notice.companionId,
      conversationId: notice.conversationId, complete: true, sources: [], memories: [], contexts: [], topics: [], knowledgeReads: [] };
    const messages = [this.message(notice.sourceMessageId), ...notice.dialogue ?? [], ...notice.progressEvidence?.outbound.map(item => item.message) ?? []];
    for (const item of this.batch(notice)) {
      if (item.kind === 'peer_reply' && item.evidence.messageId) messages.push(this.message(item.evidence.messageId));
      // A host's deliberately released visit response is a public permission
      // fact, not a grant to read the host's private request. validNotice checks
      // that authority before publication; never invent a guest raw-source read.
    }
    const sources = new Map<string, CompanionExecutionReadset['sources'][number]>();
    for (const source of result.sources) {
      const previous = sources.get(source.id);
      if (previous && (previous.checksum !== source.checksum || previous.conversationId !== source.conversationId)) throw new Error('通知读集包含同一来源的冲突版本。');
      sources.set(source.id, source);
    }
    for (const message of messages) {
      const source = { id: message.id, conversationId: message.conversationId, checksum: createHash('sha256').update(message.content).digest('hex') }, previous = sources.get(message.id);
      if (previous && (previous.checksum !== source.checksum || previous.conversationId !== source.conversationId)) throw new Error('通知所读来源已变化，不能用新字节覆盖旧证明。');
      sources.set(source.id, source);
    }
    return { ...result, sources: [...sources.values()] };
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
  claim(input?: Extract<CompanionStorageCommand, { type: 'social.notification.claim' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      if (input) assertCompanionAgendaNativeClaim(this.db, input, 'notification');
      this.observeVisits(); if (this.backlog()) return { ok: true };
      const values = this.db.prepare("SELECT data FROM companion_social_notifications WHERE COALESCE(json_extract(data,'$.terminal'),0)=0 AND (? IS NULL OR companion_id=?) AND (? IS NULL OR id=?) AND (status='pending' AND (lease_until IS NULL OR lease_until<=?) OR status IN('running','failed') AND lease_until<=?) ORDER BY created_at,rowid LIMIT 32")
        .all(input?.companionId ?? null, input?.companionId ?? null, input?.id ?? null, input?.id ?? null, iso(), iso()) as Row[];
      for (const value of values) {
        const notice = parse<Notice>(value.data);
        if (input?.expectedInputVersion && notice.agendaInputVersion !== input.expectedInputVersion) throw new Error('原后续回报的固定输入已变化，未恢复其他版本。');
        if (companionAgendaNativeBound(this.db, 'notification', notice.id)) {
          if (!input?.agendaRunId) continue;
          if (notice.status === 'running') { notice.status = 'parked'; notice.agendaUncertain = true; notice.error = '先前日程回报的结果未确认，保留真实事件等待明确处置。'; delete notice.leaseToken; this.save(notice); continue; }
        }
        if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND json_extract(data,'$.active')=1").get(notice.companionId)) continue;
        if (!this.validNotice(notice)) { notice.status = 'cancelled'; delete notice.leaseToken; this.save(notice); continue; }
        if (!companionAttentionCanClaim(this.db, notice.companionId, notice.sourceMessageId, !!input?.agendaRunId) || !this.ready(notice.companionId) || companionPlayerPhoneBusy(this.db, notice.companionId) || this.db.prepare("SELECT 1 FROM companion_social_jobs WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(notice.companionId, iso())
          || this.db.prepare("SELECT 1 FROM companion_activity_tasks WHERE companion_id=? AND report_pending=1 AND json_extract(data,'$.reportLeaseUntil')>? LIMIT 1").get(notice.companionId, Date.now())
          || this.db.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id=? AND until_real>? AND json_extract(data,'$.phase')='typing'").get(notice.companionId, iso())
          || this.db.prepare("SELECT 1 FROM companion_social_notifications WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(notice.companionId, iso())) continue;
        // Collapse already waiting facts for the same delegation into one coherent report.
        const siblings = input?.id ? [] : this.db.prepare("SELECT data FROM companion_social_notifications WHERE origin_id=? AND id!=? AND COALESCE(json_extract(data,'$.terminal'),0)=0 AND (status='pending' OR status='failed' AND lease_until<=?) ORDER BY created_at,rowid LIMIT ?")
          .all(notice.origin.id, notice.id, iso(), NOTIFICATION_BATCH_LIMIT - 1) as Row[];
        const batch = [notice];
        for (const sibling of siblings) {
          const candidate = parse<Notice>(sibling.data);
          if (candidate.companionId === notice.companionId && candidate.conversationId === notice.conversationId && this.validNotice(candidate)) batch.push(candidate);
          else { candidate.status = 'cancelled'; delete candidate.leaseToken; this.save(candidate); }
        }
        const token = hash([notice.id, notice.attempts + 1, Date.now()]).slice(0, 48), until = new Date(Date.now() + 180000).toISOString();
        for (const item of batch) {
          if (input?.agendaRunId) { item.agendaInputVersion = hash([item.companionId, item.id, item.sourceChecksum, item.evidenceChecksum, item.eventId]); item.agendaFailureCount ??= 0; item.agendaCycleFailureCount ??= 0; }
          item.status = 'running'; item.attempts++; item.leaseToken = token;
          delete item.batchIds; delete item.events; delete item.dialogue; delete item.dialogueChecksum; delete item.eventWatermark; this.save(item, until);
          if (input) bindCompanionAgendaNative(this.db, input, 'notification', item.id, token);
        }
        notice.batchIds = batch.map(item => item.id);
        notice.events = batch.map(({ kind, eventId, peerConversationId, evidence }) => ({ kind, eventId, peerConversationId, evidence }));
        notice.dialogue = this.dialogue(notice); notice.dialogueChecksum = hash(notice.dialogue);
        notice.progressEvidence = this.progress(notice);
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
      assertCompanionAgendaNativeParent(this.db, 'notification', notice.id, notice.companionId, input.leaseToken);
      if (notice.status !== 'running' || notice.leaseToken !== input.leaseToken || Date.parse(String(value.lease_until)) < Date.now()
        || !this.validNotice(notice)) throw new Error('后续回报的来源或租约已经变化。');
      const batch = this.batch(notice);
      if (batch.length !== (notice.batchIds?.length ?? 1) || batch.some(item => item.status !== 'running' || item.leaseToken !== notice.leaseToken)) throw new Error('后续回报的批次租约已经变化。');
      // A player reply, activity result, withdrawal or other report may land during inference.
      // Rebuild from the new dialogue instead of committing an isolated stale answer.
      if (batch.some(item => !this.validNotice(item)) || this.backlog() || !this.ready(notice.companionId) || companionPlayerPhoneBusy(this.db, notice.companionId)
        || notice.eventWatermark !== undefined && this.eventWatermark(notice.origin.id) !== notice.eventWatermark
        || notice.dialogueChecksum !== undefined && notice.dialogueChecksum !== hash(this.dialogue(notice))
        || notice.progressEvidence?.observationChecksum !== this.progress(notice).observationChecksum) return this.defer(batch);
      const message = input.text === null ? undefined : this.append({ conversationId: notice.conversationId, authorId: notice.companionId, content: input.text,
        replyToId: notice.sourceMessageId, clientId: 'notice_' + notice.id, executionReadset: this.readset(notice, input.executionReadset) });
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
        if (item.agendaInputVersion) {
          item.agendaFailureCount = (item.agendaFailureCount ?? 0) + 1; item.agendaCycleFailureCount = (item.agendaCycleFailureCount ?? 0) + 1;
          item.status = input.terminal || item.agendaCycleFailureCount >= 3 ? 'parked' : 'failed'; item.error = input.error; delete item.leaseToken;
          this.save(item, item.status === 'failed' ? new Date(Date.now() + Math.min(900000, 10000 * 2 ** Math.min(item.agendaCycleFailureCount, 7))).toISOString() : undefined); continue;
        }
        if (input.terminal) {
          item.status = 'failed'; item.terminal = true; item.error = input.error; delete item.leaseToken;
          this.save(item); continue;
        }
        item.status = this.validNotice(item) ? 'failed' : 'cancelled'; delete item.leaseToken;
        this.save(item, new Date(Date.now() + Math.min(900000, 10000 * 2 ** Math.min(item.attempts, 7))).toISOString());
      }
    }).immediate();
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'social.delegation.record': this.record(command); return { ok: true };
      case 'social.notification.claim': return this.claim(command);
      case 'social.notification.read': {
        const found = this.db.prepare('SELECT data FROM companion_social_notifications WHERE id=? AND companion_id=?').get(command.id, command.companionId);
        return { ok: true, ...(found ? { socialNotification: this.publicNotice(parse<Notice>(row(found).data)) } : {}) };
      }
      case 'social.notification.control': return this.db.transaction(() => {
        const found = this.db.prepare('SELECT data FROM companion_social_notifications WHERE id=? AND companion_id=?').get(command.id, command.companionId);
        if (!found) throw new Error('伙伴后续回报不存在。');
        const notice = controlCompanionAgendaNative(this.db, 'notification', command, parse<Notice>(row(found).data), value => {
          for (const item of this.batch(value)) if (item.id !== value.id && item.companionId === value.companionId) {
            item.status = value.status; delete item.leaseToken; delete item.terminal;
            if (command.action === 'resume') { item.agendaCycleFailureCount = 0; delete item.agendaUncertain; delete item.error; }
            this.save(item);
          }
          this.save(value);
        });
        return { ok: true, socialNotification: this.publicNotice(notice) };
      }).immediate();
      case 'social.notification.defer': return this.db.transaction(() => {
        const found = this.db.prepare('SELECT data FROM companion_social_notifications WHERE id=? AND companion_id=?').get(command.id, command.companionId);
        if (!found) return { ok: true }; const notice = parse<Notice>(row(found).data);
        if (notice.status !== 'running' || notice.leaseToken !== command.leaseToken) return { ok: true };
        for (const item of this.batch(notice)) if (item.status === 'running' && item.leaseToken === command.leaseToken) {
          item.status = command.uncertain ? 'parked' : 'pending'; item.agendaUncertain = command.uncertain || undefined; item.error = command.error; delete item.leaseToken;
          this.save(item, command.uncertain ? undefined : new Date(Date.now() + command.retryAfterMs).toISOString());
        }
        return { ok: true };
      }).immediate();
      case 'social.notification.complete': return this.complete(command);
      case 'social.notification.fail': this.fail(command); return { ok: true };
      default: return undefined;
    }
  }
}

/** Waiting player messages do not reserve the phone; an actual ready chat does. */
export function companionPlayerPhoneBusy(db: CompanionConnection, companionId: string): boolean {
  return !!db.prepare("SELECT 1 FROM companion_work_queue WHERE companion_id=? AND status='running' LIMIT 1").get(companionId) || !!db.prepare("SELECT 1 FROM companion_world_work_records WHERE companion_id=? AND status='ready' AND json_extract(data,'$.kind')='chat' LIMIT 1").get(companionId);
}
