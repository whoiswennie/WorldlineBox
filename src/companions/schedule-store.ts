import { createHash, randomUUID } from 'node:crypto';
import { companionScheduleEntrySchema, type CompanionSchedule, type CompanionScheduleEntry, type CompanionScheduleOccurrence, type CompanionSchedulePatch } from '../shared/companion-schedule';
import { nextCompanionScheduleRun, resolveCompanionScheduleTimeZone } from '../shared/companion-schedule-time';
import type { CompanionAction, CompanionMessage } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionConnection } from './store';

type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const rows = (values: unknown[]) => values.map(row);
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const iso = (value = Date.now()) => new Date(value).toISOString();
type Scope = { companionId: string; conversationId: string };

/** One persisted occurrence identity spans claims, dispatch and execution recovery. */
export class CompanionScheduleStore {
  constructor(private readonly db: CompanionConnection,
    private readonly visibleSources: (scope: Scope, ids: string[]) => CompanionMessage[],
    private readonly humanSource: (scope: Scope, content: string, clientId?: string) => CompanionMessage,
    private readonly energy: (companionId: string, now: number) => number,
    private readonly deferredUntil: (companionId: string, now: number, energy: number) => string | undefined,
    private readonly wakeForCommitment: (companionId: string, now: number) => void) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_schedules (
        id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
        source_message_id TEXT NOT NULL REFERENCES messages(id), status TEXT NOT NULL, next_run_at TEXT, deferred_until TEXT,
        identity_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(companion_id,source_message_id,identity_key)
      );
      CREATE INDEX IF NOT EXISTS companion_schedules_due ON companion_schedules(status,next_run_at,deferred_until);
      CREATE INDEX IF NOT EXISTS companion_schedules_scope ON companion_schedules(companion_id,conversation_id,status);
      CREATE TABLE IF NOT EXISTS companion_schedule_occurrences (
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES companion_schedules(id), scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL, lease_until TEXT, action_id TEXT REFERENCES actions(id), message_id TEXT REFERENCES messages(id), data TEXT NOT NULL,
        UNIQUE(schedule_id,scheduled_at)
      );
      CREATE INDEX IF NOT EXISTS companion_schedule_occurrences_claim ON companion_schedule_occurrences(status,lease_until,scheduled_at);
      CREATE UNIQUE INDEX IF NOT EXISTS companion_schedule_action ON actions(json_extract(data,'$.scheduleOccurrenceId')) WHERE json_extract(data,'$.scheduleOccurrenceId') IS NOT NULL;
    `);
  }
  private requireScope(scope: Scope): Row {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(scope.companionId)) throw new Error('伙伴不存在或已移除。');
    const conversation = this.db.prepare('SELECT * FROM conversations WHERE id=? AND dissolved_at IS NULL').get(scope.conversationId);
    if (!conversation || !this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(scope.conversationId, scope.companionId)) throw new Error('待办不属于当前聊天范围。');
    return row(conversation);
  }
  private load(id: string): CompanionSchedule {
    const found = this.db.prepare('SELECT data FROM companion_schedules WHERE id=?').get(id);
    if (!found) throw new Error('待办不存在。');
    return decode<CompanionSchedule>(row(found).data);
  }
  private owned(scope: Scope, id: string, expectedRevision?: number): CompanionSchedule {
    const conversation = this.requireScope(scope), schedule = this.load(id);
    if (schedule.companionId !== scope.companionId || (conversation.kind === 'group' && schedule.conversationId !== scope.conversationId)) throw new Error('不能修改另一个伙伴或聊天的待办。');
    if (expectedRevision !== undefined && schedule.revision !== expectedRevision) throw new Error('待办已更新，请重新读取后再修改。');
    return schedule;
  }
  private save(schedule: CompanionSchedule): void {
    this.db.prepare('UPDATE companion_schedules SET status=?,next_run_at=?,deferred_until=?,data=? WHERE id=?').run(schedule.status, schedule.nextRunAt ?? null, schedule.deferredUntil ?? null, JSON.stringify(schedule), schedule.id);
  }
  private occurrence(id: string): CompanionScheduleOccurrence {
    const found = this.db.prepare('SELECT data FROM companion_schedule_occurrences WHERE id=?').get(id);
    if (!found) throw new Error('待办发生记录不存在。');
    return decode<CompanionScheduleOccurrence>(row(found).data);
  }
  private saveOccurrence(occurrence: CompanionScheduleOccurrence): void {
    this.db.prepare('INSERT INTO companion_schedule_occurrences(id,schedule_id,scheduled_at,status,lease_until,action_id,message_id,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,lease_until=excluded.lease_until,action_id=excluded.action_id,message_id=excluded.message_id,data=excluded.data')
      .run(occurrence.id, occurrence.scheduleId, occurrence.scheduledAt, occurrence.status, occurrence.leaseUntil ?? null, occurrence.actionId ?? null, occurrence.messageId ?? null, JSON.stringify(occurrence));
  }
  private touch(schedule: CompanionSchedule): void { schedule.revision++; schedule.updatedAt = iso(); this.save(schedule); }
  private source(scope: Scope, id: string, updating = false): CompanionMessage {
    const source = this.visibleSources(scope, [id])[0];
    if (!source || source.authorId !== 'user' || source.conversationId !== scope.conversationId || source.status !== 'sent') throw new Error('定时安排需要当前聊天中的真实用户来源。');
    const content = source.content.trim();
    const withdrawn = /(?:不要|别|不必|不用|无需|取消|停止|撤销).{0,16}(?:提醒|定时|安排|待办|叫我)|(?:don't|do not|cancel|stop).{0,20}(?:remind|schedule|task)/iu.test(content);
    const question = /(?:以前|过去|之前|上次).*(?:提醒|安排).*(?:吗|过)|(?:怎么|如何|能否|可以).*(?:提醒|定时|安排).*[?？吗]|(?:did|have) you.*(?:remind|schedule)/iu.test(content);
    const quotation = /^(?:引用|台词|例子|他说|她说|原话|假如|假设|“.*”\s*$|「.*」\s*$)/u.test(content);
    const requested = /提醒|定时|安排|待办|每(?:天|周|月|\d+\s*(?:分钟|小时))|(?:今天|明天|后天|\d+\s*(?:点|时)).*叫我|schedule|remind|every\s+/iu.test(content)
      || updating && /修改|编辑|改为|改成|改到|改一下|更改|改时间|change|reschedule|update/iu.test(content);
    if (withdrawn || question || quotation || !requested) throw new Error('用户没有明确要求建立提醒或定时安排。');
    return source;
  }
  create(scope: Scope, entries: CompanionScheduleEntry[], sourceMessageId?: string, clientId?: string): CompanionSchedule[] {
    return this.db.transaction(() => {
      this.requireScope(scope);
      if (sourceMessageId) this.source(scope, sourceMessageId);
      return entries.map((input, index) => {
        const entry = companionScheduleEntrySchema.parse(input), timeZone = resolveCompanionScheduleTimeZone(entry.timeZone);
        const runAt = new Date(entry.runAt).toISOString();
        // Validate the full recurrence even when its first due time is in the past.
        nextCompanionScheduleRun({ ...entry, timeZone, runAt }, runAt);
        const source = sourceMessageId ? this.source(scope, sourceMessageId) : this.humanSource(scope,
          `安排${entry.kind === 'reminder' ? '提醒' : '执行待办'}：${entry.title}\n${entry.kind === 'reminder' ? '提醒内容' : '完整任务目标'}：${entry.prompt}\n首次时间：${runAt}\n时区：${timeZone}\n重复：${entry.recurrence}${entry.intervalMinutes ? `（每 ${entry.intervalMinutes} 分钟）` : ''}${entry.weekDays ? `（星期 ${entry.weekDays.join('、')}）` : ''}\n精力不足时${entry.flexible ? '可以延后' : '仍按固定时间执行'}。`,
          clientId ? 'schedule-source-' + createHash('sha256').update(clientId + '/' + index).digest('hex').slice(0, 60) : undefined);
        const identity = createHash('sha256').update(JSON.stringify({ ...entry, runAt, timeZone })).digest('hex');
        const existing = this.db.prepare('SELECT data FROM companion_schedules WHERE companion_id=? AND source_message_id=? AND identity_key=?').get(scope.companionId, source.id, identity);
        if (existing) return decode<CompanionSchedule>(row(existing).data);
        const schedule: CompanionSchedule = { ...entry, runAt, timeZone, id: randomUUID(), ...scope, sourceMessageId: source.id, authorizationSourceMessageIds: [source.id], status: 'active', revision: 1, createdAt: iso(), updatedAt: iso(), nextRunAt: runAt };
        this.db.prepare('INSERT INTO companion_schedules(id,companion_id,conversation_id,source_message_id,status,next_run_at,identity_key,data) VALUES(?,?,?,?,?,?,?,?)')
          .run(schedule.id, scope.companionId, scope.conversationId, source.id, schedule.status, schedule.nextRunAt, identity, JSON.stringify(schedule));
        return schedule;
      });
    }).immediate();
  }
  update(scope: Scope, id: string, expectedRevision: number, patch: CompanionSchedulePatch, sourceMessageId?: string): CompanionSchedule {
    return this.db.transaction(() => {
      const schedule = this.owned(scope, id, expectedRevision);
      const entry = companionScheduleEntrySchema.parse({ title: patch.title ?? schedule.title, prompt: patch.prompt ?? schedule.prompt,
        kind: patch.kind ?? schedule.kind, runAt: patch.runAt ?? schedule.runAt, timeZone: patch.timeZone ?? schedule.timeZone,
        recurrence: patch.recurrence ?? schedule.recurrence, flexible: patch.flexible ?? schedule.flexible,
        intervalMinutes: patch.intervalMinutes === null ? undefined : patch.intervalMinutes ?? ((patch.recurrence && patch.recurrence !== 'interval') ? undefined : schedule.intervalMinutes),
        weekDays: patch.weekDays === null ? undefined : patch.weekDays ?? ((patch.recurrence && patch.recurrence !== 'weekly') ? undefined : schedule.weekDays) });
      const timingChanged = patch.runAt !== undefined || patch.timeZone !== undefined || patch.recurrence !== undefined || patch.intervalMinutes !== undefined || patch.weekDays !== undefined;
      const source = sourceMessageId ? this.source(schedule, sourceMessageId, true) : this.humanSource(schedule,
        `修改待办安排：${entry.title}\n完整${entry.kind === 'reminder' ? '提醒内容' : '任务目标'}：${entry.prompt}\n首次时间：${entry.runAt}\n时区：${entry.timeZone}\n重复：${entry.recurrence}${entry.intervalMinutes ? `（每 ${entry.intervalMinutes} 分钟）` : ''}${entry.weekDays ? `（星期 ${entry.weekDays.join('、')}）` : ''}\n精力不足时${entry.flexible ? '可以延后' : '仍按固定时间执行'}。`);
      schedule.sourceMessageId = source.id; schedule.authorizationSourceMessageIds = [...new Set([...schedule.authorizationSourceMessageIds, source.id])];
      Object.assign(schedule, entry, { runAt: new Date(entry.runAt).toISOString(), timeZone: resolveCompanionScheduleTimeZone(entry.timeZone) });
      nextCompanionScheduleRun(schedule, schedule.runAt);
      if (timingChanged) {
        const now = Date.now();
        schedule.nextRunAt = new Date(schedule.runAt).getTime() > now ? schedule.runAt : schedule.recurrence === 'once' ? iso(now) : nextCompanionScheduleRun(schedule, iso(now));
        for (const item of rows(this.db.prepare("SELECT data FROM companion_schedule_occurrences WHERE schedule_id=? AND status IN ('pending','dispatching') AND action_id IS NULL AND message_id IS NULL").all(id))) { const occurrence = decode<CompanionScheduleOccurrence>(item.data); occurrence.status = 'cancelled'; occurrence.finishedAt = iso(); occurrence.leaseToken = undefined; occurrence.leaseUntil = undefined; this.saveOccurrence(occurrence); }
      }
      schedule.blockedReason = undefined; schedule.deferredUntil = undefined; this.touch(schedule); return schedule;
    }).immediate();
  }
  pause(scope: Scope, id: string, expectedRevision: number, paused: boolean): CompanionSchedule {
    return this.db.transaction(() => {
      const schedule = this.owned(scope, id, expectedRevision);
      if (schedule.status === 'cancelled') throw new Error('已取消的待办不能恢复，请新建安排。');
      if (!paused) this.requireScope(schedule);
      schedule.status = paused ? 'paused' : 'active'; schedule.blockedReason = undefined; schedule.deferredUntil = undefined;
      this.touch(schedule); return schedule;
    }).immediate();
  }
  cancel(scope: Scope, id: string, expectedRevision: number): { schedule: CompanionSchedule; scheduleOccurrences: CompanionScheduleOccurrence[] } {
    return this.db.transaction(() => {
      const schedule = this.owned(scope, id, expectedRevision);
      schedule.status = 'cancelled'; schedule.nextRunAt = undefined; schedule.blockedReason = undefined; schedule.deferredUntil = undefined;
      const scheduleOccurrences = rows(this.db.prepare("SELECT data FROM companion_schedule_occurrences WHERE schedule_id=? AND status IN ('pending','dispatching','running')").all(id)).map(item => decode<CompanionScheduleOccurrence>(item.data));
      for (const occurrence of scheduleOccurrences) if (!occurrence.actionId && !occurrence.messageId) { occurrence.status = 'cancelled'; occurrence.finishedAt = iso(); occurrence.leaseToken = undefined; occurrence.leaseUntil = undefined; this.saveOccurrence(occurrence); }
      this.touch(schedule); return { schedule, scheduleOccurrences };
    }).immediate();
  }
  private newOccurrence(schedule: CompanionSchedule, scheduledAt: string, forced = false): CompanionScheduleOccurrence {
    const existing = this.db.prepare('SELECT data FROM companion_schedule_occurrences WHERE schedule_id=? AND scheduled_at=?').get(schedule.id, scheduledAt);
    if (existing) return decode<CompanionScheduleOccurrence>(row(existing).data);
    const occurrence: CompanionScheduleOccurrence = { id: randomUUID(), scheduleId: schedule.id, companionId: schedule.companionId, conversationId: schedule.conversationId,
      scheduledAt, status: 'pending', attempts: 0, createdAt: iso(), updatedAt: iso(), forced };
    this.saveOccurrence(occurrence); return occurrence;
  }
  runNow(scope: Scope, id: string, expectedRevision: number): { schedule: CompanionSchedule; scheduleOccurrence: CompanionScheduleOccurrence } {
    return this.db.transaction(() => {
      const schedule = this.owned(scope, id, expectedRevision); this.requireScope(schedule);
      if (schedule.status !== 'active') throw new Error('请先恢复待办，再立即执行。');
      let scheduledAt = Date.now();
      while (this.db.prepare('SELECT 1 FROM companion_schedule_occurrences WHERE schedule_id=? AND scheduled_at=?').get(id, iso(scheduledAt))) scheduledAt++;
      const scheduleOccurrence = this.newOccurrence(schedule, iso(scheduledAt), true);
      schedule.blockedReason = undefined; schedule.deferredUntil = undefined; this.touch(schedule);
      return { schedule, scheduleOccurrence };
    }).immediate();
  }
  list(scope: Scope, includeHistory = false, limit = 100): { schedules: CompanionSchedule[]; scheduleOccurrences: CompanionScheduleOccurrence[] } {
    const conversation = this.requireScope(scope), values: unknown[] = [scope.companionId];
    const filters = ['companion_id=?'];
    if (conversation.kind === 'group') { filters.push('conversation_id=?'); values.push(scope.conversationId); }
    if (!includeHistory) { filters.push("(status!='cancelled' OR json_extract(data,'$.updatedAt')>=?)"); values.push(iso(Date.now() - 7 * 86400000)); }
    const schedules = rows(this.db.prepare(`SELECT data FROM companion_schedules WHERE ${filters.join(' AND ')} ORDER BY COALESCE(next_run_at,json_extract(data,'$.updatedAt')) DESC,id LIMIT ?`).all(...values, limit)).map(item => decode<CompanionSchedule>(item.data));
    const ids = schedules.map(schedule => schedule.id);
    const scheduleOccurrences = ids.length ? rows(this.db.prepare(`SELECT data FROM companion_schedule_occurrences WHERE schedule_id IN (${ids.map(() => '?').join(',')}) ORDER BY scheduled_at DESC LIMIT 200`).all(...ids)).map(item => decode<CompanionScheduleOccurrence>(item.data)) : [];
    return { schedules, scheduleOccurrences };
  }
  private valid(schedule: CompanionSchedule): boolean {
    try {
      this.requireScope(schedule);
      const ids = [...new Set(schedule.authorizationSourceMessageIds)];
      const sources = this.visibleSources(schedule, ids);
      return sources.length === ids.length && sources.every(source => source.authorId === 'user' && source.conversationId === schedule.conversationId);
    }
    catch { return false; }
  }
  stopUnavailable(): void {
    for (const item of rows(this.db.prepare(`SELECT s.data FROM companion_schedules s JOIN companions p ON p.id=s.companion_id JOIN conversations c ON c.id=s.conversation_id
      WHERE s.status!='cancelled' AND (p.deleted_at IS NOT NULL OR c.dissolved_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=s.conversation_id AND m.companion_id=s.companion_id))`).all())) {
      const schedule = decode<CompanionSchedule>(item.data);
      if (this.valid(schedule)) continue;
      schedule.status = 'cancelled'; schedule.nextRunAt = undefined; schedule.blockedReason = 'unavailable'; schedule.lastError = '伙伴、聊天或授权来源已经不可用。'; this.touch(schedule);
      for (const pending of rows(this.db.prepare("SELECT data FROM companion_schedule_occurrences WHERE schedule_id=? AND status IN ('pending','dispatching')").all(schedule.id))) { const occurrence = decode<CompanionScheduleOccurrence>(pending.data); occurrence.status = 'cancelled'; occurrence.leaseToken = undefined; occurrence.leaseUntil = undefined; this.saveOccurrence(occurrence); }
    }
  }
  claim(now = iso(), leaseMs = 30000): { schedule: CompanionSchedule; scheduleOccurrence: CompanionScheduleOccurrence } | undefined {
    return this.db.transaction(() => {
      this.stopUnavailable();
      const time = new Date(now).getTime();
      for (const item of rows(this.db.prepare(`SELECT o.id,o.action_id,a.status FROM companion_schedule_occurrences o JOIN actions a ON a.id=o.action_id WHERE o.status IN ('dispatching','running') AND a.status IN ('succeeded','failed','cancelled')`).all())) {
        this.updateOccurrence({ type: 'schedule.occurrence.update', id: String(item.id), actionId: String(item.action_id), status: item.status === 'succeeded' ? 'done' : item.status === 'failed' ? 'failed' : 'cancelled' });
      }
      // Reuse interrupted executions and expired dispatches; a live action never gets a competing lease.
      const resumable = rows(this.db.prepare(`SELECT o.data FROM companion_schedule_occurrences o JOIN companion_schedules s ON s.id=o.schedule_id
        LEFT JOIN actions a ON a.id=o.action_id WHERE s.status='active' AND o.scheduled_at<=? AND
        NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=s.companion_id AND r.status!='completed') AND
        (o.status='pending' OR (o.status='dispatching' AND o.lease_until<=?) OR (o.status='running' AND a.status='interrupted')) ORDER BY o.scheduled_at,o.id LIMIT 20`).all(now, now));
      let occurrence: CompanionScheduleOccurrence | undefined, schedule: CompanionSchedule | undefined;
      for (const item of resumable) {
        const candidate = decode<CompanionScheduleOccurrence>(item.data), owner = this.load(candidate.scheduleId);
        if (!candidate.forced && owner.deferredUntil && owner.deferredUntil > now) continue;
        occurrence = candidate; schedule = owner; break;
      }
      if (!occurrence) {
        const due = rows(this.db.prepare(`SELECT s.data FROM companion_schedules s WHERE s.status='active' AND s.next_run_at<=? AND (s.deferred_until IS NULL OR s.deferred_until<=?)
          AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=s.companion_id AND r.status!='completed')
          AND NOT EXISTS(SELECT 1 FROM companion_schedule_occurrences o WHERE o.schedule_id=s.id AND o.status IN ('pending','dispatching','running')) ORDER BY s.next_run_at,s.id LIMIT 20`).all(now, now));
        for (const item of due) {
          const candidate = decode<CompanionSchedule>(item.data);
          if (!this.valid(candidate)) { candidate.status = 'cancelled'; candidate.nextRunAt = undefined; candidate.lastError = '授权来源或执行范围已经不可用。'; this.touch(candidate); continue; }
          const energy = this.energy(candidate.companionId, time);
          const deferred = candidate.kind === 'task' && candidate.flexible ? this.deferredUntil(candidate.companionId, time, energy) : undefined;
          if (deferred) {
            candidate.blockedReason = 'resting'; candidate.deferredUntil = deferred; this.touch(candidate); continue;
          }
          schedule = candidate; occurrence = this.newOccurrence(candidate, candidate.nextRunAt!);
          candidate.nextRunAt = nextCompanionScheduleRun(candidate, now); candidate.blockedReason = undefined; candidate.deferredUntil = undefined; this.touch(candidate); break;
        }
      }
      if (!occurrence || !schedule) return;
      const energy = this.energy(schedule.companionId, time);
      const deferred = schedule.kind === 'task' && schedule.flexible && !occurrence.forced ? this.deferredUntil(schedule.companionId, time, energy) : undefined;
      if (deferred) { schedule.blockedReason = 'resting'; schedule.deferredUntil = deferred; this.touch(schedule); return; }
      if (!schedule.flexible || occurrence.forced || schedule.kind === 'reminder') this.wakeForCommitment(schedule.companionId, time);
      occurrence.status = 'dispatching'; occurrence.attempts++; occurrence.leaseToken = randomUUID(); occurrence.leaseUntil = iso(time + leaseMs); occurrence.updatedAt = now;
      this.saveOccurrence(occurrence); return { schedule, scheduleOccurrence: occurrence };
    }).immediate();
  }
  bindAction(action: CompanionAction): CompanionAction | undefined {
    if (!action.scheduleOccurrenceId) return;
    const occurrence = this.occurrence(action.scheduleOccurrenceId), schedule = this.load(occurrence.scheduleId);
    if (schedule.kind !== 'task' || schedule.status !== 'active' || occurrence.status === 'cancelled' || !this.valid(schedule)
      || action.companionId !== schedule.companionId || action.conversationId !== schedule.conversationId || action.sourceMessageId !== schedule.sourceMessageId) throw new Error('行动不属于这个已授权的定时任务。');
    if (occurrence.actionId) return decode<CompanionAction>(row(this.db.prepare('SELECT data FROM actions WHERE id=?').get(occurrence.actionId)).data);
    const existing = this.db.prepare("SELECT data FROM actions WHERE json_extract(data,'$.scheduleOccurrenceId')=?").get(occurrence.id);
    if (existing) { const saved = decode<CompanionAction>(row(existing).data); occurrence.actionId = saved.id; this.saveOccurrence(occurrence); return saved; }
    return;
  }
  actionCreated(action: CompanionAction): void {
    if (!action.scheduleOccurrenceId) return;
    const occurrence = this.occurrence(action.scheduleOccurrenceId); occurrence.actionId = action.id; occurrence.updatedAt = iso(); this.saveOccurrence(occurrence);
  }
  updateOccurrence(input: Extract<CompanionStorageCommand, { type: 'schedule.occurrence.update' }>): CompanionScheduleOccurrence {
    return this.db.transaction(() => {
      const occurrence = this.occurrence(input.id), schedule = this.load(occurrence.scheduleId);
      if (['done', 'failed', 'cancelled'].includes(occurrence.status) && input.status === occurrence.status && (!input.actionId || occurrence.actionId === input.actionId) && (!input.messageId || occurrence.messageId === input.messageId)) return occurrence;
      if (input.leaseToken && input.leaseToken !== occurrence.leaseToken) throw new Error('定时任务租约已失效。');
      if (input.actionId) {
        const action = this.db.prepare('SELECT data FROM actions WHERE id=?').get(input.actionId);
        if (!action) throw new Error('定时执行行动不存在。');
        const value = decode<CompanionAction>(row(action).data);
        if (value.scheduleOccurrenceId !== occurrence.id || value.companionId !== schedule.companionId || value.conversationId !== schedule.conversationId) throw new Error('行动不属于当前定时执行。');
        if (occurrence.actionId && occurrence.actionId !== input.actionId) throw new Error('发生期已经绑定另一项行动。');
        occurrence.actionId = input.actionId;
        if (['done', 'failed', 'cancelled'].includes(input.status)) {
          const expected = value.status === 'succeeded' ? 'done' : value.status === 'failed' ? 'failed' : value.status === 'cancelled' ? 'cancelled' : undefined;
          if (input.status !== expected) throw new Error('行动的实际状态不支持这个完成结果。');
          occurrence.result = value.result?.slice(0, 4000); occurrence.error = value.error;
        }
      }
      if (input.messageId) {
        const message = this.db.prepare('SELECT * FROM messages WHERE id=?').get(input.messageId);
        if (!message || row(message).conversation_id !== schedule.conversationId || row(message).author_id !== schedule.companionId || row(message).status !== 'sent') throw new Error('提醒消息来源无效。');
        if (schedule.kind !== 'reminder') throw new Error('执行任务不能用提醒消息冒充完成。');
        occurrence.messageId = input.messageId; occurrence.result = String(row(message).content).slice(0, 4000);
      }
      if (input.status === 'done' && !occurrence.actionId && !occurrence.messageId) throw new Error('完成状态需要实际行动或已发送提醒证据。');
      occurrence.status = input.status; occurrence.updatedAt = iso(); occurrence.startedAt ??= ['running', 'done'].includes(input.status) ? iso() : undefined;
      if (input.result && !occurrence.result) occurrence.result = input.result;
      if (input.error) occurrence.error = input.error;
      if (['done', 'failed', 'cancelled'].includes(input.status)) {
        occurrence.finishedAt = iso(); occurrence.leaseToken = undefined; occurrence.leaseUntil = undefined;
        schedule.lastRunAt = occurrence.startedAt ?? occurrence.finishedAt; schedule.lastResult = occurrence.result; schedule.lastError = occurrence.error; schedule.lastOccurrenceStatus = input.status; this.touch(schedule);
      }
      this.saveOccurrence(occurrence); return occurrence;
    }).immediate();
  }
  rehomeConversation(oldId: string, newId: string): void {
    for (const item of rows(this.db.prepare('SELECT data FROM companion_schedules WHERE conversation_id=?').all(oldId))) { const schedule = decode<CompanionSchedule>(item.data); schedule.conversationId = newId; this.db.prepare('UPDATE companion_schedules SET conversation_id=?,data=? WHERE id=?').run(newId, JSON.stringify(schedule), schedule.id); }
    for (const item of rows(this.db.prepare('SELECT o.data FROM companion_schedule_occurrences o JOIN companion_schedules s ON s.id=o.schedule_id WHERE s.conversation_id=?').all(newId))) { const occurrence = decode<CompanionScheduleOccurrence>(item.data); if (occurrence.conversationId === oldId) { occurrence.conversationId = newId; this.saveOccurrence(occurrence); } }
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'schedule.list': return { ok: true, ...this.list(command, command.includeHistory, command.limit) };
      case 'schedule.create': return { ok: true, schedules: this.create(command, command.entries, command.sourceMessageId, command.clientId) };
      case 'schedule.update': return { ok: true, schedule: this.update(command, command.id, command.expectedRevision, command.patch, command.sourceMessageId) };
      case 'schedule.pause': return { ok: true, schedule: this.pause(command, command.id, command.expectedRevision, command.paused) };
      case 'schedule.cancel': return { ok: true, ...this.cancel(command, command.id, command.expectedRevision) };
      case 'schedule.run-now': return { ok: true, ...this.runNow(command, command.id, command.expectedRevision) };
      case 'schedule.due.claim': { const due = this.claim(command.now, command.leaseMs); return { ok: true, ...due }; }
      case 'schedule.occurrence.update': return { ok: true, scheduleOccurrence: this.updateOccurrence(command) };
      default: return undefined;
    }
  }
}
