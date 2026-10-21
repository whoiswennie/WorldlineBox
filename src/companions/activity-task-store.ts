import type { ActivityMemoryOperation } from '../shared/companion-activity-task';
import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionMessage } from '../shared/companions';
import { activityTaskSchema, type ActivityDecision, type CompanionActivityTask } from '../shared/companion-activity-task';
import type { CompanionWorldStore } from './world-store';
import type { CompanionSocialStore } from './social-store';
import { companionTimeInZone } from '../shared/companion-schedule-time';
import { companionPlayerPhoneBusy } from './social-continuity-store';
import type { CompanionWorldSnapshot } from '../shared/companion-world';
type Row = { data: string };
type Stored = CompanionActivityTask & { clientId: string; sourceChecksum?: string; nextAt: number; leaseUntil?: number;
  planningMs?: number; planningStartedAt?: number; reportVersion?: number;
  reportPending?: boolean;
  peerConversationId?: string;
  worldDay?: string; createdVirtualAt?: number;
  evidence?: Array<{ id: string; conversationId: string; checksum: string }>;
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
    private readonly memory: (scope: { companionId: string; conversationId: string }, operation: ActivityMemoryOperation) => CompanionStorageResponse) {}
  initialize(): void {
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
    if (this.valid(task)) return parsed;
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
    task.status = status; task.stage = summary; delete task.wait; delete task.condition; delete task.leaseToken; delete task.leaseUntil;
    task.reportPending = !!task.sourceMessageId && this.valid(task); task.nextAt = Date.now();
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
    const ids = (this.db.prepare('SELECT id FROM messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 20').all(conversationId) as { id: string }[]).map(row => row.id);
    return this.visible({ companionId: task.companionId, conversationId }, ids).reverse();
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
        wait: { kind: 'arrival' }, summary: '实际到达后继续原请求，重新观察并反馈结果。' });
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
        created.step++; created.history.push({ step: created.step, at: iso(), action: 'message', arguments: { action: 'message', recipientIds: [input.targetId], text: input.initialMessage.text },
          ok: true, result: '必要问候已进入真实手机发件队列，待对方回应后继续拜访；排队不代表已送达、获准或抵达。' });
        created.stage = '已联系对方，持续核对回复、拜访许可与实际到达。';
      }
      this.save(created); return { ...sent, activityTask: this.public(created) };
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
      ready = !!permission && permission.status !== 'requested' || this.peerMessages(task).some(message => message.authorId === wait.targetCompanionId && message.sequence > condition.afterSequence);
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
        if (task.status === 'waiting' && !this.wake(task)) { task.nextAt = Date.now() + 1500; this.save(task); continue; }
        const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId);
        if (world.backlog || this.peerBusy(task.companionId) || !self || ['sleeping','eating'].includes(self.routinePhase) || ['working','eating','sleeping','lyingDown','waking'].includes(self.activity) || world.works.some(work => work.companionId === task.companionId && work.kind !== 'chat' && work.status !== 'ended')) { task.nextAt = Date.now() + 5000; this.save(task); continue; }
        if ((task.planningMs ?? 0) >= PLANNING_BUDGET_MS || task.step >= 32) {
          this.noteArrival(task, world);
          this.finish(task, 'failed', '这次安排多次尝试后仍未完成，已停止继续尝试。' + (task.visitTargetId
            ? task.visitInteractionAt ? '已经与对方当面交流，后续安排尚未完成。' : task.visitArrivedAt ? '已经抵达，但尚未完成当面交流。' : '尚未抵达对方的小屋。'
            : '目标尚未完成，已发生的行为保留。')); continue;
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
  private commit(id: string, token: string, decision: ActivityDecision): CompanionActivityTask {
    return this.db.transaction(() => {
      const task = this.leased(id, token);
      this.chargePlanning(task);
      const present = this.world.snapshot(task), self = present.actors.find(actor => actor.companionId === task.companionId);
      if (present.backlog || this.peerBusy(task.companionId) || !self || ['sleeping','eating'].includes(self.routinePhase) || ['working','eating','sleeping','lyingDown','waking'].includes(self.activity) || present.works.some(work => work.companionId === task.companionId && work.kind !== 'chat' && work.status !== 'ended')) {
        task.status = 'queued'; task.stage = '实际状态已变化，等待工作、用餐或睡眠结束后重新规划。'; task.nextAt = Date.now() + 5000; task.attempts = 0; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
      }
      this.noteArrival(task, present);
      if (decision.status === 'complete' && task.visitTargetId && (!task.visitArrivedAt || !task.visitInteractionAt)) {
        task.stage = !task.visitArrivedAt ? '尚未实际抵达拜访对象的场景，不能完成。请继续核实回复与许可，再 travel 并等待真实到达；若不方便则等待或如实受阻。' : '已到场，但还没有与拜访对象实际当面交流。请依据本地感知寻找并走近对方，用 social 打招呼并等待真实回应；不方便时如实受阻。';
        task.step++; task.history.push({ step: task.step, at: iso(), action: 'complete', result: task.stage, ok: false });
        task.status = 'queued'; task.nextAt = Date.now() + 1500; task.attempts = 0; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
      }
      if (decision.status !== 'continue') { this.finish(task, decision.status === 'complete' ? 'succeeded' : 'failed', decision.summary); return this.public(task); }
      const action = decision.action;
      if (action && 'targetCompanionId' in action) task.targetId = action.targetCompanionId;
      if (action?.action === 'message') task.targetId = action.recipientIds[0];
      if (decision.wait && 'targetCompanionId' in decision.wait) task.targetId = decision.wait.targetCompanionId;
      if (action?.action === 'message' || action?.action === 'social') {
        const recipients = action.action === 'message' ? action.recipientIds : action.recipientIds ?? [action.targetCompanionId!];
        task.peerConversationId = this.social.ensure(task.companionId, [task.companionId, ...recipients]).id;
      }
      const afterSequence = this.peerMessages(task).at(-1)?.sequence ?? 0;
      let result = decision.summary, ok = true;
      // Nested savepoint keeps a rejected world action from leaking partial physics changes.
      try { if (decision.memory) {
        const response = this.memory(task, decision.memory);
        if (!response) throw new Error('记忆操作没有返回有效结果。');
        const memories = [...(response.memories ?? []), ...(response.memoryPage?.items.map(item => item.memory) ?? []),
          ...(response.memoryRead?.memory ? [response.memoryRead.memory] : [])];
        const sources = [...(response.memorySources ?? []), ...(response.memoryRead?.sources ?? [])];
        for (const memory of memories) for (const reference of memory.sources ?? []) {
          const source = this.visible({ companionId: task.companionId, conversationId: reference.conversationId }, [reference.messageId])[0];
          if (!source || checksum(source) !== reference.checksum) throw new Error('记忆操作读到的来源已变化，请重新读取。');
          sources.push(source);
        }
        for (const source of sources) if (!task.evidence?.some(item => item.id === source.id)) (task.evidence ??= []).push({ id: source.id, conversationId: source.conversationId, checksum: checksum(source) });
        result = JSON.stringify(response);
      }
      if (action) {
        this.db.transaction(() => {
          if (task.sourceMessageId && (action.action === 'message' || action.action === 'social')) {
            const recipients = action.action === 'message' ? action.recipientIds : action.recipientIds ?? [action.targetCompanionId!];
            const room = this.social.ensure(task.companionId, [task.companionId, ...recipients]);
            this.social.send({ companionId: task.companionId, conversationId: room.id, content: action.text,
              channel: action.action === 'social' ? 'face_to_face' : 'phone', ...(action.action === 'message' ? { urgent: action.urgent } : {}), clientId: `activity_${task.id}_${task.step}`,
              authorizationMessageId: task.sourceMessageId });
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
        if (action.action !== 'query') result = `宿主已接纳 ${action.action} 原子行为；异步行为以实际世界状态为准，尚不代表任务完成。`;
      } }
      catch (error) { ok = false; result = error instanceof Error ? error.message.slice(0, 2000) : '原子行为失败。'; }
      const boundedResult = result.length <= 16000 ? result : JSON.stringify({ truncated: true, originalChars: result.length,
        excerpt: result.slice(0, 14000), hint: '这里只是截取的外部回执；缩小查询范围或结果数量后重新读取，不得把截取内容当作完整记录。' });
      task.step++; task.attempts = 0; task.history.push({ step: task.step, at: iso(), action: decision.memory ? 'memory.' + decision.memory.operation : action?.action ?? 'observe', ...(action ? { arguments: action } : {}), result: boundedResult, ok });
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
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'activity.motion.ensure': return this.ensureMotion(command);
      case 'activity.get': { const task = this.get(command.id); if (task.companionId !== command.companionId || task.conversationId !== command.conversationId) throw new Error('行动任务范围不可访问。'); return { ok: true, activityTask: this.public(task) }; }
      case 'activity.recover': {
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
        const evidence = new Map((task.evidence ?? []).map(item => [item.id, item]));
        for (const message of messages) evidence.set(message.id, { id: message.id, conversationId: message.conversationId, checksum: checksum(message) });
        task.evidence = [...evidence.values()]; const world = this.world.snapshot(task); this.noteArrival(task, world); this.save(task);
        return { ok: true, activityTask: this.public(task), world, activityMessages: messages };
      }
      case 'activity.commit': return { ok: true, activityTask: this.commit(command.id, command.leaseToken, command.decision) };
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
