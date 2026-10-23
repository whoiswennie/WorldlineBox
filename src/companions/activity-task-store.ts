import type { ActivityMemoryOperation } from '../shared/companion-activity-task';
import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionMessage } from '../shared/companions';
import { activityTaskSchema, activityMemorySchema, type ActivityDecision, type CompanionActivityTask } from '../shared/companion-activity-task';
import type { CompanionWorldStore } from './world-store';
import type { CompanionSocialStore } from './social-store';
import { companionTimeInZone } from '../shared/companion-schedule-time';
import { companionPlayerPhoneBusy } from './social-continuity-store';
import type { CompanionWorldSnapshot } from '../shared/companion-world';
type Row = { data: string };
type GoalSocialOrigin = { messageId: string; sourceMessageId: string; deliveryClientId: string; conversationId: string; topicId?: string; chainId: string };
type Stored = CompanionActivityTask & { clientId: string; sourceChecksum?: string; nextAt: number; leaseUntil?: number;
  planningMs?: number; planningStartedAt?: number; reportVersion?: number;
  reportPending?: boolean; memoryIntentId?: string;
  peerConversationId?: string;
  peerTopicId?: string | null;
  seededSocialClientIds?: string[];
  deferredDecision?: { step: number; decision: ActivityDecision; socialEvidence: Array<{ id: string; checksum: string }> };
  observedSocialEvidence?: { leaseToken: string; messages: Array<{ id: string; checksum: string }> };
  worldDay?: string; createdVirtualAt?: number;
  evidence?: Array<{ id: string; conversationId: string; checksum: string }>;
  memoryVersions?: Array<{ id: string; version: number }>;
  condition?: { visitId?: string; until: number; afterSequence: number; sceneId?: string; x?: number; y?: number; virtualAt?: number } };
const iso = (at = Date.now()) => new Date(at).toISOString();
const terminal = (task: CompanionActivityTask) => ['succeeded', 'failed', 'cancelled'].includes(task.status);
const checksum = (source: CompanionMessage) => createHash('sha256').update(source.content).digest('hex');
const PLANNING_BUDGET_MS = 3600000;
const PLANNING_LEASE_MS = 120000;
const LEGACY_WAIT_TIMEOUT = '行动达到一小时或32步安全上限，已停止；已发生的行为保留。';
const LEGACY_CONTACT_REJECTION = '拟发内容或收件人超出了原委托的分享范围，已停止发送。';

/** Durable agent goals and atomic world effects share the existing SQLite transaction. */
export class CompanionActivityTaskStore {
  constructor(private readonly db: CompanionConnection, private readonly world: CompanionWorldStore, private readonly social: CompanionSocialStore,
    private readonly visible: (scope: { companionId: string; conversationId: string }, ids: string[]) => CompanionMessage[],
    private readonly append: (input: { conversationId: string; authorId: string; content: string; clientId: string; replyToId?: string; replyDirective: 'none' }) => unknown,
    private readonly experienced: (task: CompanionActivityTask, sourceMessageId: string) => void) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_activity_memory_intents(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES companion_activity_tasks(id) ON DELETE CASCADE,
      companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,lease_token TEXT,lease_until INTEGER);
      CREATE INDEX IF NOT EXISTS companion_activity_memory_pending ON companion_activity_memory_intents(status,lease_until)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_activity_tasks(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),source_message_id TEXT REFERENCES messages(id),status TEXT NOT NULL,next_at INTEGER NOT NULL,client_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_activity_due ON companion_activity_tasks(status,next_at);
      CREATE INDEX IF NOT EXISTS companion_activity_owner ON companion_activity_tasks(companion_id,status);
      CREATE INDEX IF NOT EXISTS companion_activity_room ON companion_activity_tasks(conversation_id,next_at);`);
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_activity_day ON companion_activity_tasks(companion_id,json_extract(data,'$.worldDay'))");
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_activity_source ON companion_activity_tasks(companion_id,source_message_id,conversation_id)');
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_activity_recovery ON companion_activity_tasks(status,json_extract(data,'$.createdAt'))");
    if (!(this.db.prepare('PRAGMA table_info(companion_activity_tasks)').all() as { name: string }[]).some(column => column.name === 'report_pending')) this.db.exec('ALTER TABLE companion_activity_tasks ADD COLUMN report_pending INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_activity_reports ON companion_activity_tasks(report_pending,next_at)');
  }
  private save(task: Stored): void { task.updatedAt = iso(); this.db.prepare('UPDATE companion_activity_tasks SET status=?,next_at=?,report_pending=?,data=? WHERE id=?').run(task.status, task.nextAt, Number(!!task.reportPending), JSON.stringify(task), task.id); }
  /** Only leased planning consumes the budget. Offline time and durable waits do not. */
  private chargePlanning(task: Stored): void {
    if (task.planningStartedAt !== undefined) task.planningMs = (task.planningMs ?? 0)
      + Math.max(0, Math.min(PLANNING_LEASE_MS, Date.now() - task.planningStartedAt));
    delete task.planningStartedAt;
  }
  private get(id: string): Stored {
    const row = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('行动任务不存在。'); return JSON.parse(row.data) as Stored;
  }
  private public(task: Stored): CompanionActivityTask {
    const parsed = activityTaskSchema.parse(task);
    if (this.valid(task)) {
      if (task.seededSocialClientIds?.length && !terminal(task)) {
        const authors = [...new Set(this.goalSocialMessages(task).messages.map(message => message.authorId))];
        const progress = authors.length
          ? `本目标已收到${authors.length}位伙伴的真实回信（${authors.slice(0, 6).join('、')}${authors.length > 6 ? '等' : ''}）。回信不等于报名；本轮未读正文时应说仍在确认，不能断言无人回复、报名0人或全员同意。`
          : '本目标当前尚无可见的真实回信凭证；这不是“无人报名”的证明，不能替未读的对方作判断。';
        // Read-only progress derived solely from this goal's actual invitation
        // chains. Other rooms' message bodies never become chat's recent flow.
        return { ...parsed, stage: `${progress}\n${parsed.stage}`.slice(0, 2000) };
      }
      return parsed;
    }
    return { ...parsed, title: '来源不可访问的行动', goal: '[来源已撤回，任务内容已隐藏]', stage: '来源已撤回、更新或主体不可访问，不能读取旧目标和过程。', history: [], targetId: undefined, wait: undefined };
  }
  private valid(task: Stored): boolean {
    try { return this.validScope(task); } catch { return false; }
  }
  private validScope(task: Stored): boolean {
    if (this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status<>'completed')").get(task.companionId, task.companionId) === undefined) return false;
    if (task.targetId && !this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(task.targetId)) return false;
    if (task.clientId.startsWith('schedule_activity_')) {
      const occurrenceId = task.clientId.slice('schedule_activity_'.length);
      const found = this.db.prepare("SELECT s.data FROM companion_schedule_occurrences o JOIN companion_schedules s ON s.id=o.schedule_id WHERE o.id=? AND s.status='active' AND o.status<>'cancelled'").get(occurrenceId) as Row | undefined;
      if (!found || (JSON.parse(found.data) as { prompt: string }).prompt !== task.goal) return false;
    }
    for (const item of task.evidence ?? []) {
      const message = this.visible({ companionId: task.companionId, conversationId: item.conversationId }, [item.id])[0];
      if (!message || checksum(message) !== item.checksum) return false;
    }
    for (const note of task.memoryVersions ?? []) if (!this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status') IN('queued','indexed')")
      .get(note.id, task.companionId, note.version)) return false;
    if (!task.sourceMessageId) return true;
    const source = this.visible(task, [task.sourceMessageId])[0];
    return !!source && source.authorId === 'user' && checksum(source) === task.sourceChecksum;
  }
  private finish(task: Stored, status: 'succeeded' | 'failed' | 'cancelled', summary: string): void {
    this.chargePlanning(task);
    if (status !== 'succeeded' && task.wait?.kind === 'arrival' && task.condition) this.world.stopTaskMovement(task, task.condition, task.id);
    if (status === 'succeeded' && task.visitTargetId && task.visitArrivedAt && task.visitInteractionAt) {
      const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId);
      const target = this.db.prepare("SELECT json_extract(data,'$.name') AS name FROM companions WHERE id=?").get(task.visitTargetId) as { name: string } | undefined;
      summary = `已经到过${target?.name ?? '对方'}的小屋，并完成了双方当面交流。`;
      if (self && self.sceneId === self.homeSceneId) summary += '现在已经回到自己的小屋。';
      else if (world.scenes.some(scene => scene.id === self?.sceneId && scene.ownerId === task.visitTargetId)) summary += '现在仍在对方的小屋。';
    }
    task.status = status; task.stage = summary; delete task.wait; delete task.condition; delete task.leaseToken; delete task.leaseUntil; delete task.deferredDecision;
    task.reportPending = !!task.sourceMessageId && this.valid(task); task.nextAt = Date.now();
    if (status !== 'cancelled' && task.sourceMessageId && this.valid(task)
      && task.history.some(item => item.ok && !item.action.startsWith('memory.') && item.action !== 'observe')) this.experienced(task, task.sourceMessageId);
    this.save(task); this.flushReports();
  }
  private flushReports(): void {
    const rows = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE report_pending=1 AND next_at<=? ORDER BY next_at,id LIMIT 16').all(Date.now()) as Row[];
    for (const row of rows) {
      const task = JSON.parse(row.data) as Stored;
      if (!this.valid(task)) { task.reportPending = false; this.save(task); continue; }
      this.world.snapshot(task);
      if (!this.world.socialAvailable(task.companionId, 'phone', []) || companionPlayerPhoneBusy(this.db, task.companionId)) { task.nextAt = Date.now() + 5000; this.save(task); continue; }
      this.append({ conversationId: task.conversationId, authorId: task.companionId,
        content: `${task.title} · ${task.status === 'succeeded' ? '已完成' : task.status === 'cancelled' ? '已取消' : '暂时受阻'}\n\n${task.stage}`,
        clientId: 'activity_result_' + task.id + (task.reportVersion ? '_resumed_' + task.reportVersion : ''), replyToId: task.sourceMessageId, replyDirective: 'none' });
      task.reportPending = false; this.save(task);
    }
  }
  start(input: Extract<CompanionStorageCommand, { type: 'activity.start' }>): CompanionActivityTask {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE client_id=?').get(input.clientId) as Row | undefined;
      if (existing) { const task = JSON.parse(existing.data) as Stored; if (task.companionId !== input.companionId || task.conversationId !== input.conversationId || task.goal !== input.goal || task.title !== input.title || task.sourceMessageId !== input.sourceMessageId) throw new Error('行动任务幂等标识冲突。'); return this.public(task); }
      const source = input.sourceMessageId ? this.visible(input, [input.sourceMessageId])[0] : undefined;
      if (input.sourceMessageId && (!source || source.authorId !== 'user')) throw new Error('行动委托来源不可访问。');
      if (source) {
        const visit = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE companion_id=? AND source_message_id=? AND json_extract(data,'$.visitTargetId') IS NOT NULL ORDER BY rowid LIMIT 1").get(input.companionId, source.id) as Row | undefined;
        if (visit) return this.public(JSON.parse(visit.data) as Stored);
      }
      if (!input.sourceMessageId && input.conversationId !== 'world_' + input.companionId) throw new Error('自主行动只能属于自己的世界认知会话。');
      if (Number((this.db.prepare("SELECT count(*) AS n FROM companion_activity_tasks WHERE companion_id=? AND status IN('queued','running','waiting')").get(input.companionId) as { n: number }).n) >= 3) throw new Error('已有三份未完成行动任务，请先完成或取消。');
      const world = this.world.snapshot(input);
      const day = companionTimeInZone(Date.parse(world.clock.virtualNow), world.settings.timeZone), worldDay = `${day.year}-${day.month}-${day.day}`;
      if (!input.sourceMessageId) {
        const count = this.db.prepare("SELECT count(*) AS n FROM companion_activity_tasks WHERE companion_id=? AND source_message_id IS NULL AND json_extract(data,'$.worldDay')=?").get(input.companionId, worldDay) as { n: number };
        const last = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND source_message_id IS NULL ORDER BY rowid DESC LIMIT 1').get(input.companionId) as Row | undefined;
        const previous = last ? JSON.parse(last.data) as Stored : undefined;
        if (count.n >= 2 || previous && (Date.now() - Date.parse(previous.createdAt) < 120_000 || Date.parse(world.clock.virtualNow) - (previous.createdVirtualAt ?? 0) < 6 * 3600_000)) throw new Error('主动行动已达到每日两次或六世界小时/120现实秒冷却上限。');
      }
      const task: Stored = { id: randomUUID(), ...input, status: 'queued', step: 0, attempts: 0, createdAt: iso(), updatedAt: iso(),
        deadline: iso(Date.now() + 3600_000), stage: '等待行动规划', history: [], nextAt: Date.now(), worldDay, createdVirtualAt: Date.parse(world.clock.virtualNow), ...(source ? { sourceChecksum: checksum(source) } : {}) };
      this.db.prepare('INSERT INTO companion_activity_tasks(id,companion_id,conversation_id,source_message_id,status,next_at,client_id,data) VALUES(?,?,?,?,?,?,?,?)').run(task.id, task.companionId, task.conversationId, task.sourceMessageId ?? null, task.status, task.nextAt, task.clientId, JSON.stringify(task));
      return this.public(task);
    }).immediate();
  }
  private peerMessages(task: Stored): CompanionMessage[] {
    if (!task.targetId) return [];
    const group = task.peerConversationId && this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(task.peerConversationId, task.targetId);
    const conversationId = group ? task.peerConversationId! : this.social.ensure(task.companionId, [task.companionId, task.targetId]).id;
    const ids = (this.db.prepare(`SELECT id FROM messages WHERE conversation_id=?${task.peerTopicId === undefined ? '' : task.peerTopicId === null
      ? ' AND NOT EXISTS(SELECT 1 FROM companion_message_topics WHERE message_id=messages.id)'
      : ' AND EXISTS(SELECT 1 FROM companion_message_topics WHERE message_id=messages.id AND topic_id=?)'} ORDER BY sequence DESC LIMIT 20`)
      .all(conversationId, ...(task.peerTopicId ? [task.peerTopicId] : [])) as { id: string }[]).map(row => row.id);
    // A dedicated game/story port may carry that topic's live flow. An ordinary
    // private room is reusable: only this goal's anchored job chains may cross
    // into task cognition, never that room's unrelated earlier conversation.
    const current = (task.sourceMessageId || task.seededSocialClientIds?.length) && !task.peerTopicId ? []
      : this.visible({ companionId: task.companionId, conversationId }, ids).reverse();
    return [...new Map([...this.goalSocialMessages(task).messages, ...current].map(message => [message.id, message])).values()]
      .sort((a, b) => a.sequence - b.sequence).slice(-100);
  }
  private goalSocialMessages(task: Stored): { messages: CompanionMessage[]; origins: GoalSocialOrigin[] } {
    const messages = new Map<string, CompanionMessage>(), origins = new Map<string, GoalSocialOrigin>();
    for (const clientId of task.seededSocialClientIds ?? []) {
      const value = this.db.prepare("SELECT message_id,data FROM companion_social_outbox WHERE client_id=? AND companion_id=? AND status='sent'").get(clientId, task.companionId) as { message_id: string; data: string } | undefined;
      if (!value) continue;
      const sent = JSON.parse(value.data) as { conversationId: string; authorizationMessageId?: string; agentSource?: { messageId: string; conversationId: string }; topicId?: string | null };
      if (task.sourceMessageId ? !(sent.authorizationMessageId === task.sourceMessageId || sent.agentSource?.messageId === task.sourceMessageId && sent.agentSource.conversationId === task.conversationId)
        : !clientId.startsWith(`activity_${task.id}_`)) continue;
      const source = this.visible({ companionId: task.companionId, conversationId: sent.conversationId }, [value.message_id])[0];
      if (!source || source.authorId !== task.companionId || (source.topicId ?? null) !== (sent.topicId ?? null)) continue;
      const chains = (this.db.prepare("SELECT DISTINCT json_extract(data,'$.chainId') AS id FROM companion_social_jobs WHERE conversation_id=? AND json_extract(data,'$.sourceMessageId')=?").all(sent.conversationId, source.id) as Array<{ id: string }>).map(row => row.id);
      if (!chains.length) continue;
      const replies = this.db.prepare(`SELECT json_extract(data,'$.resultMessageId') AS id,json_extract(data,'$.chainId') AS chain_id FROM companion_social_jobs WHERE conversation_id=? AND companion_id!=? AND status='done' AND json_extract(data,'$.chainId') IN(${chains.map(() => '?').join(',')}) AND json_extract(data,'$.resultMessageId') IS NOT NULL ORDER BY created_at,id LIMIT 80`)
        .all(sent.conversationId, task.companionId, ...chains) as Array<{ id: string; chain_id: string }>;
      const visible = this.visible({ companionId: task.companionId, conversationId: sent.conversationId }, replies.map(row => row.id))
        .filter(message => message.status === 'sent' && !message.isReplyDraft && message.authorId !== task.companionId && message.sequence > source.sequence && (message.topicId ?? null) === (sent.topicId ?? null));
      const byAuthor = new Map<string, CompanionMessage[]>();
      for (const reply of visible) { const own = byAuthor.get(reply.authorId) ?? []; own.push(reply); byAuthor.set(reply.authorId, own); }
      for (const own of byAuthor.values()) for (const reply of [own[0]!, own.at(-1)!]) {
        messages.set(reply.id, reply); origins.set(reply.id, { messageId: reply.id, sourceMessageId: source.id, deliveryClientId: clientId,
          conversationId: sent.conversationId, ...(reply.topicId ? { topicId: reply.topicId } : {}), chainId: replies.find(row => row.id === reply.id)!.chain_id });
      }
    }
    return { messages: [...messages.values()], origins: [...origins.values()] };
  }
  private matchingPeerRoom(task: Stored, recipients: string[]): string | undefined {
    if (!task.peerConversationId || !this.db.prepare('SELECT 1 FROM companion_social_conversations s JOIN conversations c ON c.id=s.id WHERE s.id=? AND c.dissolved_at IS NULL').get(task.peerConversationId)) return;
    const members = (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id').all(task.peerConversationId) as Array<{ companion_id: string }>).map(row => row.companion_id);
    return JSON.stringify(members) === JSON.stringify([task.companionId, ...recipients].sort()) ? task.peerConversationId : undefined;
  }
  /** A chat-issued movement is the first step of the original request, not its
   * completion. Persist the effect and its arrival predicate in one transaction
   * so closing/retrying the chat cannot strand it or restart the same route. */
  private ensureMotion(input: Extract<CompanionStorageCommand, { type: 'activity.motion.ensure' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const source = this.visible(input, [input.sourceMessageId])[0];
      if (!source || source.authorId !== 'user') throw new Error('移动后继续处理需要本轮真实玩家消息。');
      const prior = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? AND source_message_id=? ORDER BY rowid LIMIT 1')
        .get(input.companionId, input.conversationId, source.id) as Row | undefined;
      if (prior) {
        const task = JSON.parse(prior.data) as Stored;
        if (!this.valid(task)) throw new Error('原行动来源已更新或撤回。');
        return { ok: true, activityTask: this.public(task), world: this.world.snapshot(task) };
      }
      const created = this.start({ type: 'activity.start', companionId: input.companionId, conversationId: input.conversationId,
        sourceMessageId: source.id, clientId: 'motion_' + createHash('sha256').update(input.companionId + ':' + source.id).digest('hex'),
        title: '虚拟世界行动', goal: source.content });
      const task = this.get(created.id);
      task.status = 'running'; task.leaseToken = randomUUID(); task.leaseUntil = Date.now() + PLANNING_LEASE_MS;
      this.save(task);
      const result = this.commit(task.id, task.leaseToken, { status: 'continue', action: input.arguments,
        wait: { kind: 'arrival' }, summary: '实际到达后继续原请求，重新观察并反馈结果。' }, true);
      return { ok: true, activityTask: result, world: this.world.snapshot(task) };
    }).immediate();
  }
  private noteArrival(task: Stored, present: CompanionWorldSnapshot): void {
    const self = present.actors.find(actor => actor.companionId === task.companionId);
    if (task.visitTargetId && self && !self.travel && !self.route.length && present.scenes.some(scene => scene.id === self.sceneId && scene.ownerId === task.visitTargetId)) task.visitArrivedAt ??= iso();
    if (task.visitArrivedAt && task.visitTargetId && task.peerConversationId && !task.visitInteractionAt) {
      const authors = this.db.prepare("SELECT DISTINCT m.author_id FROM companion_social_messages s JOIN messages m ON m.id=s.message_id WHERE s.conversation_id=? AND s.channel='face_to_face' AND m.created_at>=? AND m.status='sent'").all(task.peerConversationId, task.visitArrivedAt) as { author_id: string }[];
      if ([task.companionId, task.visitTargetId].every(id => authors.some(author => author.author_id === id))) task.visitInteractionAt = iso();
    }
  }
  private ensureVisit(input: Extract<CompanionStorageCommand, { type: 'activity.visit.ensure' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const source = this.visible(input, [input.sourceMessageId])[0];
      const target = this.db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(input.targetId) as Row | undefined;
      if (!source || source.authorId !== 'user' || source.conversationId !== input.conversationId || !target || input.targetId === input.companionId) throw new Error('拜访需要真实原委托和有效的另一位伙伴。');
      const clientId = 'visit_' + createHash('sha256').update(input.companionId + ':' + source.id + ':' + input.targetId).digest('hex');
      const existing = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE client_id=? OR (companion_id=? AND source_message_id=? AND json_extract(data,'$.visitTargetId')=?) ORDER BY rowid LIMIT 1")
        .get(clientId, input.companionId, source.id, input.targetId) as Row | undefined;
      if (existing) return { ok: true, activityTask: this.public(JSON.parse(existing.data) as Stored) };
      const prior = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE companion_id=? AND source_message_id=? AND status IN('queued','running','waiting') ORDER BY rowid LIMIT 1").get(input.companionId, source.id) as Row | undefined;
      const created = prior ? JSON.parse(prior.data) as Stored : this.get(this.start({ type: 'activity.start', companionId: input.companionId,
        conversationId: input.conversationId, sourceMessageId: source.id, clientId, title: '拜访' + (JSON.parse(target.data) as { name: string }).name, goal: source.content }).id);
      if (created.visitTargetId && created.visitTargetId !== input.targetId) throw new Error('这次委托已经绑定了另一份拜访目标。');
      created.visitTargetId = input.targetId; created.targetId = input.targetId;
      created.peerConversationId = this.social.ensure(input.companionId, [input.companionId, input.targetId]).id;
      let sent: CompanionStorageResponse = { ok: true };
      if (input.initialMessage && !prior) {
        this.social.continuity.record({ type: 'social.delegation.record', companionId: input.companionId, conversationId: input.conversationId,
          sourceMessageId: source.id, recipientIds: [input.targetId], sharedText: input.initialMessage.text, intent: 'visit' });
        sent = this.social.send({ companionId: input.companionId, conversationId: created.peerConversationId, content: input.initialMessage.text,
          channel: 'phone', urgent: input.initialMessage.urgent, authorizationMessageId: source.id, clientId: input.initialMessage.clientId });
        (created.seededSocialClientIds ??= []).push(input.initialMessage.clientId);
        created.step++; created.history.push({ step: created.step, at: iso(), action: 'message', arguments: { action: 'message', recipientIds: [input.targetId], text: input.initialMessage.text },
          ok: true, result: '必要问候已进入真实手机发件队列，待对方回应后继续拜访；排队不代表已送达、获准或抵达。' });
        created.stage = '已联系对方，持续核对回复、拜访许可与实际到达。';
      }
      this.save(created); return { ...sent, activityTask: this.public(created) };
    }).immediate();
  }
  private ensureSocial(input: Extract<CompanionStorageCommand, { type: 'activity.social.ensure' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const source = this.visible(input, [input.sourceMessageId])[0];
      if (!source || source.authorId !== 'user' || source.conversationId !== input.conversationId || source.isReplyDraft) throw new Error('持续社交需要本次真实、仍然可见的用户目标。');
      const outbox = this.db.prepare('SELECT companion_id,conversation_id,status,message_id,data FROM companion_social_outbox WHERE client_id=?').get(input.deliveryClientId) as {
        companion_id: string; conversation_id: string; status: string; message_id: string | null; data: string;
      } | undefined;
      const sent = outbox ? JSON.parse(outbox.data) as { companionId: string; conversationId: string; content: string;
        authorizationMessageId?: string; agentSource?: { conversationId: string; messageId: string }; topicId?: string | null } : undefined;
      if (!outbox || !sent || outbox.companion_id !== input.companionId || sent.companionId !== input.companionId || outbox.conversation_id !== sent.conversationId
        || !['pending', 'sent'].includes(outbox.status) || !(sent.authorizationMessageId === source.id
          || sent.agentSource?.messageId === source.id && sent.agentSource.conversationId === source.conversationId)) throw new Error('持续社交只能承接本次真实出站消息，不能伪造回执或借用别人的邀约。');
      const members = (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id').all(sent.conversationId) as Array<{ companion_id: string }>).map(value => value.companion_id);
      const recipients = members.filter(id => id !== input.companionId);
      if (!members.includes(input.companionId) || !recipients.length || input.operation === 'introduce' && recipients.length !== 1
        || input.operation === 'create_group' && recipients.length < 2) throw new Error('实际社交会话与这次行为不相符。');
      const previous = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND source_message_id=? ORDER BY rowid LIMIT 1').get(input.companionId, source.id) as Row | undefined;
      const clientId = 'social_continue_' + createHash('sha256').update(input.companionId + ':' + source.id).digest('hex');
      const task = previous ? JSON.parse(previous.data) as Stored : this.get(this.start({ type: 'activity.start', companionId: input.companionId,
        conversationId: input.conversationId, sourceMessageId: source.id, clientId, title: '继续完成社交活动', goal: source.content }).id);
      // A completed/cancelled original goal never resurrects from a late reply.
      if (terminal(task) || task.seededSocialClientIds?.includes(input.deliveryClientId)) return { ok: true, activityTask: this.public(task) };
      const message = outbox.message_id ? this.visible({ companionId: input.companionId, conversationId: sent.conversationId }, [outbox.message_id])[0] : undefined;
      if (outbox.status === 'sent' && !message) throw new Error('已发送的社交来源已经撤回或不可见，不能承接旧回执。');
      if (task.step >= 31) throw new Error('该持续目标已达到安全步骤范围，不能静默丢失已执行的社交行为。');
      task.goal = source.content; task.peerConversationId = sent.conversationId; task.peerTopicId = sent.topicId ?? null; task.targetId = recipients[0];
      const result = { ok: true, socialConversation: { id: sent.conversationId, memberIds: members },
        socialPending: outbox.status === 'pending', ...(message ? { socialMessage: { messageId: message.id, authorId: message.authorId,
          sequence: message.sequence, content: message.content, ...(message.topicId ? { topicId: message.topicId } : {}) } } : {}) };
      task.step++; task.history.push({ step: task.step, at: iso(), action: input.operation, ok: true, result: JSON.stringify(result) });
      (task.seededSocialClientIds ??= []).push(input.deliveryClientId);
      task.stage = '初次社交行动已有真实回执；等待实际回复后继续完成原始完整目标，不重复邀请。';
      if (task.status !== 'running') {
        task.status = 'waiting'; task.wait = { kind: 'reply', targetCompanionId: recipients[0]! };
        task.condition = { until: Date.now() + 300_000, afterSequence: message?.sequence ?? Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM messages').get() as { n: number }).n) };
        task.nextAt = Date.now() + 1500; delete task.leaseToken; delete task.leaseUntil;
      }
      this.save(task); return { ok: true, activityTask: this.public(task) };
    }).immediate();
  }
  private wake(task: Stored): boolean {
    if (!task.wait || !task.condition) return true;
    const world = this.world.snapshot(task), actor = world.actors.find(actor => actor.companionId === task.companionId), wait = task.wait, condition = task.condition;
    let ready: boolean, reason: string;
    if (wait.kind === 'arrival') {
      ready = !!actor && !actor.route.length && !actor.travel && actor.sceneId === condition.sceneId && (condition.x === undefined || Math.hypot(actor.position.x - condition.x, actor.position.y - condition.y!) <= .3);
      reason = '实际抵达目标场景或本地目的地，继续依据当前观察行动。';
    } else if (wait.kind === 'reply') {
      const permission = task.visitTargetId === wait.targetCompanionId && !task.visitArrivedAt && world.visits.find(visit =>
        visit.guestId === task.companionId && visit.hostId === wait.targetCompanionId && visit.id === (condition.visitId ?? task.visitRequestId));
      ready = !!permission && permission.status !== 'requested' || this.peerMessages(task).some(message => (task.seededSocialClientIds?.length
        ? message.authorId !== task.companionId && message.authorId !== 'system' : message.authorId === wait.targetCompanionId) && message.sequence > condition.afterSequence);
      reason = permission && permission.status !== 'requested' ? '拜访许可已有实际结果，不再等待重复的手机确认；核对许可与当前位置后继续。' : '收到目标伙伴的真实新回复。';
    }
    else if (wait.kind === 'permission') { ready = world.visits.some(visit => visit.id === (condition.visitId ?? task.visitRequestId) && visit.guestId === task.companionId && visit.hostId === wait.targetCompanionId && visit.status !== 'requested'); reason = '拜访许可已有实际结果，请核对允许、拒绝或过期。'; }
    else { ready = Date.parse(world.clock.virtualNow) >= condition.virtualAt!; reason = '世界时间等待已结束。'; }
    if (!ready) {
      if (wait.kind === 'delay' || Date.now() < condition.until) return false;
      // A sleeping/dormant/busy peer or an unanswered formal request is an
      // external dependency, not a reason to spend another model planning step.
      if ('targetCompanionId' in wait && (!this.world.socialAvailable(wait.targetCompanionId, 'phone', [])
        || world.visits.some(visit => visit.id === (condition.visitId ?? task.visitRequestId) && visit.status === 'requested'))) {
        condition.until = Date.now() + 300000; return false;
      }
    }
    task.stage = ready ? reason : '等待超时，目标尚未实现；重新观察并决定受阻、等待或其它行动。';
    delete task.wait; delete task.condition; return true;
  }
  private peerBusy(owner: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id=? AND until_real>? AND json_extract(data,'$.phase')='typing' UNION ALL SELECT 1 FROM companion_social_notifications WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(owner, iso(), owner, iso());
  }
  private primaryChatBusy(task: Stored): boolean {
    return !!task.sourceMessageId && !!this.db.prepare("SELECT 1 FROM companion_work_queue WHERE companion_id=? AND status IN('queued','running') AND json_extract(data,'$.sourceMessageId')=? AND json_extract(data,'$.conversationId')=? LIMIT 1")
      .get(task.companionId, task.sourceMessageId, task.conversationId);
  }
  claim(excluded: string[]): CompanionActivityTask | undefined {
    return this.db.transaction(() => {
      this.flushReports();
      // Bounded indexed scan; deferred actors rotate by next_at rather than starving others.
      const candidates = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE status IN('queued','waiting','running') AND next_at<=? ORDER BY next_at,id LIMIT 32").all(Date.now()) as Row[];
      for (const row of candidates) {
        const task = JSON.parse(row.data) as Stored;
        if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND json_extract(data,'$.active')=1").get(task.companionId)) { task.nextAt = Date.now() + 5000; this.save(task); continue; }
        if (excluded.includes(task.companionId) || this.db.prepare("SELECT 1 FROM companion_activity_tasks WHERE companion_id=? AND status IN('queued','waiting','running') AND rowid<(SELECT rowid FROM companion_activity_tasks WHERE id=?) LIMIT 1").get(task.companionId, task.id)) { task.nextAt = Date.now() + 2000; this.save(task); continue; }
        if (!this.valid(task)) { this.finish(task, 'cancelled', '来源被撤回、伙伴重置或联系人已移除，停止后续行动。'); continue; }
        if (task.status === 'running' && (task.leaseUntil ?? 0) > Date.now()) continue;
        if (task.status === 'running') this.chargePlanning(task);
        if (task.memoryIntentId) { task.nextAt = Date.now() + 1500; this.save(task); continue; }
        if (task.status === 'waiting' && !this.wake(task)) { task.nextAt = Date.now() + 1500; this.save(task); continue; }
        const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId);
        if (world.backlog || this.primaryChatBusy(task) || this.peerBusy(task.companionId) || !self || ['sleeping','eating'].includes(self.routinePhase) || ['working','eating','sleeping','lyingDown','waking'].includes(self.activity) || world.works.some(work => work.companionId === task.companionId && work.kind !== 'chat' && work.status !== 'ended')) { task.nextAt = Date.now() + 5000; this.save(task); continue; }
        if ((task.planningMs ?? 0) >= PLANNING_BUDGET_MS || task.step >= 32) {
          this.noteArrival(task, world);
          this.finish(task, 'failed', '这次安排多次尝试后仍未完成，已停止继续尝试。' + (task.visitTargetId
            ? task.visitInteractionAt ? '已经与对方当面交流，后续安排尚未完成。' : task.visitArrivedAt ? '已经抵达，但尚未完成当面交流。' : '尚未抵达对方的小屋。'
            : '目标尚未完成，已发生的行为保留。')); continue;
        }
        if (task.deferredDecision) {
          const deferred = task.deferredDecision;
          const socialEvidence = this.peerMessages(task).map(message => ({ id: message.id, checksum: checksum(message) }));
          if (deferred.step !== task.step || JSON.stringify(deferred.socialEvidence) !== JSON.stringify(socialEvidence)) {
            delete task.deferredDecision; task.stage = '原目标已有新的真实进展或相关回复，重新根据最新回执判断下一步。'; this.save(task);
          }
          else {
            // The planner and Main already authorized this exact atomic step.
            // Admission waits do not discard it or ask the model to invent a
            // replacement. A fresh lease/source check still guards execution.
            task.status = 'running'; task.leaseToken = randomUUID(); task.leaseUntil = Date.now() + PLANNING_LEASE_MS;
            task.nextAt = task.leaseUntil; this.save(task);
            this.commit(task.id, task.leaseToken, deferred.decision);
            continue;
          }
        }
        if (task.attempts >= 3) { this.finish(task, 'failed', '同一步连续失败三次，已停止自动重试。'); continue; }
        task.attempts++; task.status = 'running'; task.leaseToken = randomUUID(); task.planningStartedAt = Date.now();
        task.deadline = iso(Date.now() + Math.max(0, PLANNING_BUDGET_MS - (task.planningMs ?? 0)));
        task.leaseUntil = Date.now() + PLANNING_LEASE_MS; task.nextAt = task.leaseUntil;
        this.save(task); return this.public(task);
      }
    }).immediate();
  }
  private leased(id: string, token: string): Stored { const task = this.get(id); if (task.status !== 'running' || task.leaseToken !== token || (task.leaseUntil ?? 0) < Date.now() || !this.valid(task)) throw new Error('行动任务租约或来源已失效。'); return task; }
  private commit(id: string, token: string, decision: ActivityDecision, fromPrimary = false): CompanionActivityTask {
    return this.db.transaction(() => {
      const task = this.leased(id, token);
      this.chargePlanning(task);
      const present = this.world.snapshot(task), self = present.actors.find(actor => actor.companionId === task.companionId);
      if (!fromPrimary && this.primaryChatBusy(task) || decision.status === 'continue' && decision.action && (present.backlog || this.peerBusy(task.companionId) || !self || ['sleeping','eating'].includes(self.routinePhase) || ['working','eating','sleeping','lyingDown','waking'].includes(self.activity) || present.works.some(work => work.companionId === task.companionId && work.kind !== 'chat' && work.status !== 'ended'))) {
        task.deferredDecision = { step: task.step, decision, socialEvidence: task.deferredDecision?.socialEvidence
          ?? (task.observedSocialEvidence?.leaseToken === token ? task.observedSocialEvidence.messages : []) };
        task.status = 'queued'; task.stage = '这一步已完成授权核验并保存，暂等当前通信或身体动作结束后执行；尚未执行，不需要重新规划。'; task.nextAt = Date.now() + 5000; task.attempts = 0; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
      }
      delete task.deferredDecision;
      this.noteArrival(task, present);
      if (decision.status === 'complete' && task.visitTargetId && (!task.visitArrivedAt || !task.visitInteractionAt)) {
        task.stage = !task.visitArrivedAt ? '尚未实际抵达拜访对象的场景，不能完成。请继续核实回复与许可，再 travel 并等待真实到达；若不方便则等待或如实受阻。' : '已到场，但还没有与拜访对象实际当面交流。请依据本地感知寻找并走近对方，用 social 打招呼并等待真实回应；不方便时如实受阻。';
        task.step++; task.history.push({ step: task.step, at: iso(), action: 'complete', result: task.stage, ok: false });
        task.status = 'queued'; task.nextAt = Date.now() + 1500; task.attempts = 0; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
      }
      if (decision.status !== 'continue') { this.finish(task, decision.status === 'complete' ? 'succeeded' : 'failed', decision.summary); return this.public(task); }
      const action = decision.action;
      if (action && 'targetCompanionId' in action) task.targetId = action.targetCompanionId;
      if (action?.action === 'message' || action?.action === 'create_group') task.targetId = action.recipientIds[0];
      if (decision.wait && 'targetCompanionId' in decision.wait) task.targetId = decision.wait.targetCompanionId;
      const afterSequence = this.peerMessages(task).at(-1)?.sequence ?? 0;
      let result = decision.summary, ok = true;
      // Nested savepoint keeps a rejected world action from leaking partial physics changes.
      if (decision.memory) {
        const intentId = 'intent_' + createHash('sha256').update(task.id + '/' + task.step).digest('hex').slice(0, 48);
        this.db.prepare('INSERT OR IGNORE INTO companion_activity_memory_intents(id,task_id,companion_id,conversation_id,status,data) VALUES(?,?,?,?,?,?)')
          .run(intentId, task.id, task.companionId, task.conversationId, 'pending', JSON.stringify(decision.memory));
        task.memoryIntentId = intentId; task.status = 'waiting'; task.stage = '正在处理自己的 VCP 日记，等待真实回执。';
        task.nextAt = Date.now() + 1500; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
      }
      try {
      if (action) {
        this.db.transaction(() => {
          if (action.action === 'message' || action.action === 'social') {
            const recipients = action.action === 'message' ? action.recipientIds : action.recipientIds ?? [action.targetCompanionId!];
            if (action.action === 'message') this.social.requireAcquaintances(task.companionId, recipients);
            const currentRoom = this.matchingPeerRoom(task, recipients);
            const roomId = currentRoom ?? this.social.ensure(task.companionId, [task.companionId, ...recipients]).id;
            const sent = this.social.send({ companionId: task.companionId, conversationId: roomId, content: action.text,
              ...(currentRoom && task.peerTopicId !== undefined ? { topicId: task.peerTopicId } : {}),
              channel: action.action === 'social' ? 'face_to_face' : 'phone', ...(action.action === 'message' ? { urgent: action.urgent } : {}), clientId: `activity_${task.id}_${task.step}`,
              ...(task.sourceMessageId ? { agentSource: { conversationId: task.conversationId, messageId: task.sourceMessageId }, authorizationMessageId: task.sourceMessageId } : {}) });
            const queued = this.db.prepare('SELECT data FROM companion_social_outbox WHERE client_id=?').get(`activity_${task.id}_${task.step}`) as Row | undefined;
            task.peerConversationId = roomId;
            task.peerTopicId = sent.socialMessage?.message.topicId ?? (queued ? (JSON.parse(queued.data) as { topicId?: string | null }).topicId : null) ?? null;
            const clientId = `activity_${task.id}_${task.step}`;
            if (!(task.seededSocialClientIds ??= []).includes(clientId)) task.seededSocialClientIds.push(clientId);
            result = JSON.stringify(sent);
          } else if (action.action === 'introduce' || action.action === 'create_group') {
            const sent = this.world.execute({ type: 'world.tool', companionId: task.companionId, conversationId: task.conversationId,
              sourceMessageId: task.sourceMessageId, clientId: `activity_${task.id}_${task.step}`, arguments: action });
            if (!sent?.socialConversation) throw new Error('社交动作没有产生真实会话回执。');
            const queued = this.db.prepare('SELECT data FROM companion_social_outbox WHERE client_id=?').get(`activity_${task.id}_${task.step}`) as Row | undefined;
            task.peerConversationId = sent.socialConversation.id;
            task.peerTopicId = sent.topic?.id ?? sent.socialMessage?.message.topicId ?? (queued ? (JSON.parse(queued.data) as { topicId?: string | null }).topicId : null) ?? null;
            const clientId = `activity_${task.id}_${task.step}`;
            if (!(task.seededSocialClientIds ??= []).includes(clientId)) task.seededSocialClientIds.push(clientId);
            result = JSON.stringify({ ok: sent.ok, socialConversation: sent.socialConversation, socialPending: sent.socialPending,
              socialMessage: sent.socialMessage, socialRecipients: sent.socialRecipients, topic: sent.topic, topicState: sent.topicState });
          } else if (action.action === 'query') {
            const queried = this.world.queryKnowledge(task, action);
            result = JSON.stringify({ worldKnowledge: queried.worldKnowledge, memorySources: queried.memorySources });
            for (const source of queried.memorySources ?? []) (task.evidence ??= []).push({ id: source.id, conversationId: source.conversationId, checksum: checksum(source) });
          } else {
            const acted = this.world.tool(task, action, task.sourceMessageId);
            if (action.action === 'visit' && task.sourceMessageId) {
              const visit = acted.visits.find(visit => visit.guestId === task.companionId && visit.hostId === action.targetCompanionId
                && ['requested', 'allowed'].includes(visit.status));
              if (visit) task.visitRequestId = visit.id;
              this.social.continuity.record({ type: 'social.delegation.record', companionId: task.companionId, conversationId: task.conversationId,
                sourceMessageId: task.sourceMessageId, recipientIds: [action.targetCompanionId], sharedText: action.reason,
                ...(visit ? { visitId: visit.id } : {}), intent: 'visit' });
            }
          }
          if (['move','travel','leave'].includes(action.action)) this.world.tagTaskMovement(task.companionId, task.id);
        }).immediate();
        if (!['query', 'introduce', 'create_group', 'message', 'social'].includes(action.action)) result = `宿主已接纳 ${action.action} 原子行为；异步行为以实际世界状态为准，尚不代表任务完成。`;
      }
      } catch (error) { ok = false; result = error instanceof Error ? error.message.slice(0, 2000) : '原子行为失败。'; }
      const boundedResult = result.length <= 16000 ? result : JSON.stringify({ truncated: true, originalChars: result.length,
        excerpt: result.slice(0, 14000), hint: '这里只是截取的外部回执；缩小查询范围或结果数量后重新读取，不得把截取内容当作完整记录。' });
      task.step++; task.attempts = 0; task.history.push({ step: task.step, at: iso(), action: action?.action ?? 'observe', ...(action ? { arguments: action } : {}), result: boundedResult, ok });
      if (!ok && task.history.slice(-3).length === 3 && task.history.slice(-3).every(item => !item.ok && item.action === action?.action && item.result === result)) {
        this.finish(task, 'failed', '同一原子行为连续失败三次，已停止重试。最后原因：' + result); return this.public(task);
      }
      if (!action && !decision.wait && !decision.memory) { this.finish(task, 'failed', '规划没有提供可执行的动作或等待条件，已停止空循环。'); return this.public(task); }
      task.stage = decision.memory ? '已处理自己的记忆，继续判断下一步。' : action?.action === 'query' ? '已读取有来源的世界资料，继续判断下一步。' : result; delete task.leaseToken; delete task.leaseUntil; task.status = 'queued'; task.nextAt = Date.now() + 1500;
      const wait = decision.wait ?? (action && ['travel','move','leave'].includes(action.action) ? { kind: 'arrival' as const } : undefined);
      if (ok && wait) {
        const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId), point = self?.travel ? { sceneId: self.travel.targetSceneId, x: undefined, y: undefined } : self?.route.at(-1) ?? (self ? { ...self.position, sceneId: self.sceneId } : undefined);
        task.stage = wait.kind === 'permission' ? '等待房主处理拜访许可' : wait.kind === 'reply' ? '等待对方的真实回复' : wait.kind === 'arrival' ? '正在前往目的地，等待实际抵达' : '等待世界时间经过';
        task.wait = wait; task.status = 'waiting'; task.condition = { until: Date.now() + 300_000, afterSequence,
          ...(wait.kind === 'permission' || wait.kind === 'reply' && task.visitTargetId === wait.targetCompanionId ? { visitId: task.visitRequestId ?? world.visits.find(visit => visit.guestId === task.companionId && visit.hostId === wait.targetCompanionId && ['requested', 'allowed'].includes(visit.status))?.id } : {}),
          ...(wait.kind === 'arrival' && point ? { sceneId: point.sceneId, x: point.x, y: point.y } : {}),
          ...(wait.kind === 'delay' ? { virtualAt: Date.parse(world.clock.virtualNow) + wait.seconds * 1000 } : {}) };
      }
      this.save(task); return this.public(task);
    }).immediate();
  }
  private claimMemory(): CompanionStorageResponse {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE companion_activity_memory_intents SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(Date.now());
      const candidates = this.db.prepare("SELECT * FROM companion_activity_memory_intents WHERE status='pending' ORDER BY rowid LIMIT 32").all() as Array<{ id: string; task_id: string; companion_id: string; conversation_id: string; data: string }>;
      for (const entry of candidates) {
        const task = this.get(entry.task_id);
        if (terminal(task) || !this.valid(task) || task.memoryIntentId !== entry.id) {
          this.db.prepare("UPDATE companion_activity_memory_intents SET status='done',data='{}' WHERE id=?").run(entry.id); continue;
        }
        const token = randomUUID();
        this.db.prepare("UPDATE companion_activity_memory_intents SET status='running',lease_token=?,lease_until=? WHERE id=?").run(token, Date.now() + 120000, entry.id);
        return { ok: true, activityMemoryIntent: { id: entry.id, taskId: task.id, companionId: task.companionId,
          conversationId: task.conversationId, operation: activityMemorySchema.parse(JSON.parse(entry.data)), leaseToken: token } };
      }
      return { ok: true };
    }).immediate();
  }
  private completeMemory(command: Extract<CompanionStorageCommand, { type: 'activity.memory.complete' | 'activity.memory.fail' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const entry = this.db.prepare("SELECT task_id,data FROM companion_activity_memory_intents WHERE id=? AND status='running' AND lease_token=? AND lease_until>?")
        .get(command.id, command.leaseToken, Date.now()) as { task_id: string; data: string } | undefined;
      if (!entry) throw new Error('记忆操作租约已失效。');
      const task = this.get(entry.task_id);
      const operation = JSON.parse(entry.data) as ActivityMemoryOperation;
      // A successful own revise/organize is the one allowed transition from the
      // version that admitted this intent. External edits still invalidate it.
      const versions = new Map((task.memoryVersions ?? []).map(note => [note.id, note.version]));
      if (command.type === 'activity.memory.complete' && ['revise', 'organize'].includes(operation.operation)) {
        const mutableIds = operation.operation === 'revise' ? [operation.id] : operation.operation === 'organize' ? operation.ids : [];
        for (const note of command.noteVersions ?? []) if (mutableIds.includes(note.id) && versions.get(note.id) === note.version - 1) versions.set(note.id, note.version);
      }
      task.memoryVersions = [...versions].map(([id, version]) => ({ id, version }));
      if (terminal(task) || !this.valid(task) || task.memoryIntentId !== command.id) throw new Error('行动或其来源已改变，不能提交旧记忆回执。');
      if (command.type === 'activity.memory.complete') {
        const sources = this.visible(task, command.sourceMessageIds ?? []);
        if (sources.length !== (command.sourceMessageIds ?? []).length) throw new Error('记忆操作的来源已撤回。');
        for (const note of command.noteVersions ?? []) {
          const current = this.db.prepare("SELECT data FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status') IN('queued','indexed')")
            .get(note.id, task.companionId, note.version) as Row | undefined;
          if (!current) throw new Error('记忆操作的日记已修订或撤回。');
          const references = (JSON.parse(current.data) as { sources: Array<{ messageId: string; checksum: string }> }).sources;
          for (const reference of references) { const source = this.visible(task, [reference.messageId])[0];
            if (!source || checksum(source) !== reference.checksum) throw new Error('记忆操作来源已改变。'); sources.push(source); }
          versions.set(note.id, note.version);
        }
        task.memoryVersions = [...versions].map(([id, version]) => ({ id, version }));
        for (const source of sources) if (!task.evidence?.some(item => item.id === source.id)) (task.evidence ??= []).push({ id: source.id, conversationId: source.conversationId, checksum: checksum(source) });
      }
      task.step++; task.attempts = 0; task.history.push({ step: task.step, at: iso(), action: 'memory.' + operation.operation,
        result: command.type === 'activity.memory.complete' ? command.result : command.error, ok: command.type === 'activity.memory.complete' });
      delete task.memoryIntentId; task.status = 'queued'; task.nextAt = Date.now() + 1500; task.stage = '记忆操作已有真实回执，继续判断下一步。'; this.save(task);
      this.db.prepare("UPDATE companion_activity_memory_intents SET status='done',data='{}',lease_token=NULL,lease_until=NULL WHERE id=?").run(command.id);
      return { ok: true, activityTask: this.public(task) };
    }).immediate();
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'activity.memory.claim': return this.claimMemory();
      case 'activity.memory.complete': case 'activity.memory.fail': return this.completeMemory(command);
      case 'activity.motion.ensure': return this.ensureMotion(command);
      case 'activity.get': { const task = this.get(command.id); if (task.companionId !== command.companionId || task.conversationId !== command.conversationId) throw new Error('行动任务范围不可访问。'); return { ok: true, activityTask: this.public(task) }; }
      case 'activity.recover': {
        this.db.prepare("UPDATE companion_activity_memory_intents SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running'").run();
        const rows = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE status='running' OR (status='failed' AND json_extract(data,'$.stage') IN (?,?) AND json_extract(data,'$.step')<32 AND json_extract(data,'$.createdAt')>=?)").all(LEGACY_WAIT_TIMEOUT, LEGACY_CONTACT_REJECTION, iso(Date.now() - 86400000)) as Row[];
        for (const row of rows) {
          const task = JSON.parse(row.data) as Stored;
          if (task.status === 'failed') {
            // Repair only the old wall-clock/reclassification bugs on a current, unsuperseded
            // player visit. Completed/cancelled goals and real failures stay final.
            if (!task.sourceMessageId || !task.visitTargetId || !this.valid(task) || this.db.prepare("SELECT 1 FROM companion_activity_tasks WHERE companion_id=? AND rowid>(SELECT rowid FROM companion_activity_tasks WHERE id=?) AND json_extract(data,'$.visitTargetId')=? AND status<>'cancelled' LIMIT 1").get(task.companionId, task.id, task.visitTargetId)) continue;
            task.reportPending = false; task.reportVersion = (task.reportVersion ?? 0) + 1; task.attempts = 0;
            task.stage = '此前拜访因等待或重复范围判断中断，已恢复原任务；重新核对有效邀请与实际位置、交流结果。';
          }
          this.chargePlanning(task); task.status = 'queued'; task.nextAt = Date.now();
          delete task.leaseToken; delete task.leaseUntil; this.save(task);
        }
        return { ok: true };
      }
      case 'activity.start': return { ok: true, activityTask: this.start(command) };
      case 'activity.visit.ensure': return this.ensureVisit(command);
      case 'activity.list': return { ok: true, activityTasks: (this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT ?').all(command.companionId, command.conversationId, command.limit) as Row[]).map(row => this.public(JSON.parse(row.data) as Stored)) };
      case 'activity.cancel': return this.db.transaction(() => { const task = this.get(command.id); if (task.companionId !== command.companionId || task.conversationId !== command.conversationId) throw new Error('不能控制其他伙伴的任务。'); if (!terminal(task)) this.finish(task, 'cancelled', '已取消行动，停止后续计划；实际位置和已发送消息保留。'); return { ok: true, activityTask: this.public(task) }; }).immediate();
      case 'activity.claim': return { ok: true, activityTask: this.claim(command.excludedIds ?? []) };
      case 'activity.observe': {
        const task = this.leased(command.id, command.leaseToken), messages = this.peerMessages(task);
        task.observedSocialEvidence = { leaseToken: command.leaseToken, messages: messages.map(message => ({ id: message.id, checksum: checksum(message) })) };
        const evidence = new Map((task.evidence ?? []).map(item => [item.id, item]));
        for (const message of messages) evidence.set(message.id, { id: message.id, conversationId: message.conversationId, checksum: checksum(message) });
        task.evidence = [...evidence.values()]; const world = this.world.snapshot(task); this.noteArrival(task, world); this.save(task);
        const shown = new Set(messages.map(message => message.id));
        return { ok: true, activityTask: this.public(task), world, activityMessages: messages,
          activityMessageOrigins: this.goalSocialMessages(task).origins.filter(origin => shown.has(origin.messageId)) };
      }
      case 'activity.commit': return { ok: true, activityTask: this.commit(command.id, command.leaseToken, command.decision) };
      case 'activity.social.ensure': return this.ensureSocial(command);
      case 'activity.reject': {
        const task = this.leased(command.id, command.leaseToken); this.chargePlanning(task);
        task.step++; task.history.push({ step: task.step, at: iso(), action: command.action.action, arguments: command.action, result: command.reason, ok: false });
        task.stage = command.reason; task.attempts = 0; task.status = 'queued'; task.nextAt = Date.now() + 1500;
        delete task.leaseToken; delete task.leaseUntil;
        if (task.history.slice(-3).length === 3 && task.history.slice(-3).every(item => !item.ok && item.result === command.reason)) this.finish(task, 'failed', '连续三次未能形成符合本次联系范围的发言，已停止自动尝试；未发送这些内容。');
        else this.save(task);
        return { ok: true, activityTask: this.public(task) };
      }
      case 'activity.fail': { const task = this.leased(command.id, command.leaseToken); this.chargePlanning(task); task.stage = command.error; task.status = 'queued'; task.nextAt = Date.now() + Math.min(30_000, 2000 * 2 ** task.attempts); delete task.leaseToken; delete task.leaseUntil; this.save(task); return { ok: true }; }
    }
  }
}
