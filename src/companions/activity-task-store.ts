import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionMessage } from '../shared/companions';
import { activityTaskSchema, type ActivityDecision, type CompanionActivityTask } from '../shared/companion-activity-task';
import type { CompanionWorldStore } from './world-store';
import type { CompanionSocialStore } from './social-store';
import { companionTimeInZone } from '../shared/companion-schedule-time';
import { companionPlayerPhoneBusy } from './social-continuity-store';
type Row = { data: string };
type Stored = CompanionActivityTask & { clientId: string; sourceChecksum?: string; nextAt: number; leaseUntil?: number;
  reportPending?: boolean;
  peerConversationId?: string;
  worldDay?: string; createdVirtualAt?: number;
  evidence?: Array<{ id: string; conversationId: string; checksum: string }>;
  condition?: { until: number; afterSequence: number; sceneId?: string; x?: number; y?: number; virtualAt?: number } };
const iso = (at = Date.now()) => new Date(at).toISOString();
const terminal = (task: CompanionActivityTask) => ['succeeded', 'failed', 'cancelled'].includes(task.status);
const checksum = (source: CompanionMessage) => createHash('sha256').update(source.content).digest('hex');

/** Durable agent goals and atomic world effects share the existing SQLite transaction. */
export class CompanionActivityTaskStore {
  constructor(private readonly db: CompanionConnection, private readonly world: CompanionWorldStore, private readonly social: CompanionSocialStore,
    private readonly visible: (scope: { companionId: string; conversationId: string }, ids: string[]) => CompanionMessage[],
    private readonly append: (input: { conversationId: string; authorId: string; content: string; clientId: string; replyToId?: string; replyDirective: 'none' }) => unknown) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_activity_tasks(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),source_message_id TEXT REFERENCES messages(id),status TEXT NOT NULL,next_at INTEGER NOT NULL,client_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_activity_due ON companion_activity_tasks(status,next_at);
      CREATE INDEX IF NOT EXISTS companion_activity_owner ON companion_activity_tasks(companion_id,status);
      CREATE INDEX IF NOT EXISTS companion_activity_room ON companion_activity_tasks(conversation_id,next_at);`);
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_activity_day ON companion_activity_tasks(companion_id,json_extract(data,'$.worldDay'))");
    if (!(this.db.prepare('PRAGMA table_info(companion_activity_tasks)').all() as { name: string }[]).some(column => column.name === 'report_pending')) this.db.exec('ALTER TABLE companion_activity_tasks ADD COLUMN report_pending INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_activity_reports ON companion_activity_tasks(report_pending,next_at)');
  }
  private save(task: Stored): void { task.updatedAt = iso(); this.db.prepare('UPDATE companion_activity_tasks SET status=?,next_at=?,report_pending=?,data=? WHERE id=?').run(task.status, task.nextAt, Number(!!task.reportPending), JSON.stringify(task), task.id); }
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
    if (status !== 'succeeded' && task.wait?.kind === 'arrival' && task.condition) this.world.stopTaskMovement(task, task.condition, task.id);
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
        clientId: 'activity_result_' + task.id, replyToId: task.sourceMessageId, replyDirective: 'none' });
      task.reportPending = false; this.save(task);
    }
  }
  start(input: Extract<CompanionStorageCommand, { type: 'activity.start' }>): CompanionActivityTask {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE client_id=?').get(input.clientId) as Row | undefined;
      if (existing) { const task = JSON.parse(existing.data) as Stored; if (task.companionId !== input.companionId || task.conversationId !== input.conversationId || task.goal !== input.goal || task.title !== input.title || task.sourceMessageId !== input.sourceMessageId) throw new Error('行动任务幂等标识冲突。'); return this.public(task); }
      const source = input.sourceMessageId ? this.visible(input, [input.sourceMessageId])[0] : undefined;
      if (input.sourceMessageId && (!source || source.authorId !== 'user')) throw new Error('行动委托来源不可访问。');
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
  private wake(task: Stored): boolean {
    if (!task.wait || !task.condition) return true;
    const world = this.world.snapshot(task), actor = world.actors.find(actor => actor.companionId === task.companionId), wait = task.wait, condition = task.condition;
    let ready: boolean, reason: string;
    if (wait.kind === 'arrival') {
      ready = !!actor && !actor.route.length && actor.sceneId === condition.sceneId && Math.hypot(actor.position.x - condition.x!, actor.position.y - condition.y!) <= .3;
      reason = '实际抵达导航终点；没有自动申请拜访或进屋。';
    } else if (wait.kind === 'reply') { ready = this.peerMessages(task).some(message => message.authorId === wait.targetCompanionId && message.sequence > condition.afterSequence); reason = '收到目标伙伴的真实新回复。'; }
    else if (wait.kind === 'permission') { ready = world.visits.some(visit => visit.guestId === task.companionId && visit.hostId === wait.targetCompanionId && visit.status !== 'requested'); reason = '拜访许可已有实际结果，请核对允许、拒绝或过期。'; }
    else { ready = Date.parse(world.clock.virtualNow) >= condition.virtualAt!; reason = '世界时间等待已结束。'; }
    if (!ready && Date.now() < condition.until) return false;
    task.stage = ready ? reason : '等待超时，目标尚未实现；重新观察并决定受阻、等待或其它行动。';
    delete task.wait; delete task.condition; return true;
  }
  claim(excluded: string[]): CompanionActivityTask | undefined {
    return this.db.transaction(() => {
      this.flushReports();
      // Bounded indexed scan; deferred actors rotate by next_at rather than starving others.
      const candidates = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE status IN('queued','waiting','running') AND next_at<=? ORDER BY next_at,id LIMIT 32").all(Date.now()) as Row[];
      for (const row of candidates) {
        const task = JSON.parse(row.data) as Stored;
        if (excluded.includes(task.companionId) || this.db.prepare("SELECT 1 FROM companion_activity_tasks WHERE companion_id=? AND status IN('queued','waiting','running') AND rowid<(SELECT rowid FROM companion_activity_tasks WHERE id=?) LIMIT 1").get(task.companionId, task.id)) { task.nextAt = Date.now() + 2000; this.save(task); continue; }
        if (!this.valid(task)) { this.finish(task, 'cancelled', '来源被撤回、伙伴重置或联系人已移除，停止后续行动。'); continue; }
        if (Date.parse(task.deadline) <= Date.now() || task.step >= 32) { this.finish(task, 'failed', '行动达到一小时或32步安全上限，已停止；已发生的行为保留。'); continue; }
        if (task.status === 'running' && (task.leaseUntil ?? 0) > Date.now()) continue;
        if (task.status === 'waiting' && !this.wake(task)) { task.nextAt = Date.now() + 1500; this.save(task); continue; }
        const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId);
        if (world.backlog || !self || ['sleeping','eating'].includes(self.routinePhase) || ['working','eating','sleeping','lyingDown','waking'].includes(self.activity) || world.works.some(work => work.companionId === task.companionId && work.kind !== 'chat' && work.status !== 'ended')) { task.nextAt = Date.now() + 5000; this.save(task); continue; }
        if (++task.attempts > 3) { this.finish(task, 'failed', '同一步连续失败三次，已停止自动重试。'); continue; }
        task.status = 'running'; task.leaseToken = randomUUID(); task.leaseUntil = Date.now() + 120_000; task.nextAt = task.leaseUntil;
        this.save(task); return this.public(task);
      }
    }).immediate();
  }
  private leased(id: string, token: string): Stored { const task = this.get(id); if (task.status !== 'running' || task.leaseToken !== token || (task.leaseUntil ?? 0) < Date.now() || !this.valid(task)) throw new Error('行动任务租约或来源已失效。'); return task; }
  private commit(id: string, token: string, decision: ActivityDecision): CompanionActivityTask {
    return this.db.transaction(() => {
      const task = this.leased(id, token);
      const present = this.world.snapshot(task), self = present.actors.find(actor => actor.companionId === task.companionId);
      if (present.backlog || !self || ['sleeping','eating'].includes(self.routinePhase) || ['working','eating','sleeping','lyingDown','waking'].includes(self.activity) || present.works.some(work => work.companionId === task.companionId && work.kind !== 'chat' && work.status !== 'ended')) {
        task.status = 'queued'; task.stage = '实际状态已变化，等待工作、用餐或睡眠结束后重新规划。'; task.nextAt = Date.now() + 5000; task.attempts = 0; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
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
      try { if (action) {
        this.db.transaction(() => {
          if (task.sourceMessageId && (action.action === 'message' || action.action === 'social')) {
            const recipients = action.action === 'message' ? action.recipientIds : action.recipientIds ?? [action.targetCompanionId!];
            const room = this.social.ensure(task.companionId, [task.companionId, ...recipients]);
            this.social.send({ companionId: task.companionId, conversationId: room.id, content: action.text,
              channel: action.action === 'social' ? 'face_to_face' : 'phone', clientId: `activity_${task.id}_${task.step}`,
              authorizationMessageId: task.sourceMessageId });
          } else this.world.tool(task, action, task.sourceMessageId);
          if (['move','navigate','enter','leave'].includes(action.action)) this.world.tagTaskMovement(task.companionId, task.id);
        }).immediate();
        result = `宿主已接纳 ${action.action} 原子行为；异步行为以实际世界状态为准，尚不代表任务完成。`;
      } }
      catch (error) { ok = false; result = error instanceof Error ? error.message.slice(0, 2000) : '原子行为失败。'; }
      task.step++; task.attempts = 0; task.history.push({ step: task.step, at: iso(), action: action?.action ?? 'observe', ...(action ? { arguments: action } : {}), result, ok });
      if (!ok && task.history.slice(-3).length === 3 && task.history.slice(-3).every(item => !item.ok && item.action === action?.action && item.result === result)) {
        this.finish(task, 'failed', '同一原子行为连续失败三次，已停止重试。最后原因：' + result); return this.public(task);
      }
      if (!action && !decision.wait) { this.finish(task, 'failed', '规划没有提供可执行的动作或等待条件，已停止空循环。'); return this.public(task); }
      task.stage = result; delete task.leaseToken; delete task.leaseUntil; task.status = 'queued'; task.nextAt = Date.now() + 1500;
      const wait = decision.wait ?? (action && ['navigate','move','enter','leave'].includes(action.action) ? { kind: 'arrival' as const } : undefined);
      if (ok && wait) {
        const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId), point = self?.route.at(-1) ?? (self ? { ...self.position, sceneId: self.sceneId } : undefined);
        task.wait = wait; task.status = 'waiting'; task.condition = { until: Date.now() + 300_000, afterSequence,
          ...(wait.kind === 'arrival' && point ? { sceneId: point.sceneId, x: point.x, y: point.y } : {}),
          ...(wait.kind === 'delay' ? { virtualAt: Date.parse(world.clock.virtualNow) + wait.seconds * 1000 } : {}) };
      }
      this.save(task); return this.public(task);
    }).immediate();
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'activity.get': { const task = this.get(command.id); if (task.companionId !== command.companionId || task.conversationId !== command.conversationId) throw new Error('行动任务范围不可访问。'); return { ok: true, activityTask: this.public(task) }; }
      case 'activity.recover': {
        this.db.prepare("UPDATE companion_activity_tasks SET status='queued',next_at=?,data=json_remove(json_set(data,'$.status','queued','$.nextAt',?),'$.leaseToken','$.leaseUntil') WHERE status='running'").run(Date.now(), Date.now()); return { ok: true };
      }
      case 'activity.start': return { ok: true, activityTask: this.start(command) };
      case 'activity.list': return { ok: true, activityTasks: (this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT ?').all(command.companionId, command.conversationId, command.limit) as Row[]).map(row => this.public(JSON.parse(row.data) as Stored)) };
      case 'activity.cancel': return this.db.transaction(() => { const task = this.get(command.id); if (task.companionId !== command.companionId || task.conversationId !== command.conversationId) throw new Error('不能控制其他伙伴的任务。'); if (!terminal(task)) this.finish(task, 'cancelled', '已取消行动，停止后续计划；实际位置和已发送消息保留。'); return { ok: true, activityTask: this.public(task) }; }).immediate();
      case 'activity.claim': return { ok: true, activityTask: this.claim(command.excludedIds ?? []) };
      case 'activity.observe': {
        const task = this.leased(command.id, command.leaseToken), messages = this.peerMessages(task);
        const evidence = new Map((task.evidence ?? []).map(item => [item.id, item]));
        for (const message of messages) evidence.set(message.id, { id: message.id, conversationId: message.conversationId, checksum: checksum(message) });
        task.evidence = [...evidence.values()]; this.save(task);
        return { ok: true, activityTask: this.public(task), world: this.world.snapshot(task), activityMessages: messages };
      }
      case 'activity.commit': return { ok: true, activityTask: this.commit(command.id, command.leaseToken, command.decision) };
      case 'activity.fail': { const task = this.leased(command.id, command.leaseToken); task.stage = command.error; task.status = 'queued'; task.nextAt = Date.now() + Math.min(30_000, 2000 * 2 ** task.attempts); delete task.leaseToken; this.save(task); return { ok: true }; }
    }
  }
}
