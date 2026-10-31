import { createHash, randomUUID } from 'node:crypto';
import { companionAgendaCommandSchema, companionAgendaRuleDraftSchema, companionAgendaRuleSchema, companionAgendaRunSchema,
  companionAgendaGoalSchema, companionAgendaGrantSchema, type CompanionAgendaAuthority, type CompanionAgendaCommand,
  type CompanionAgendaResponse, type CompanionAgendaRule, type CompanionAgendaOccurrence, type CompanionAgendaRun,
  type CompanionAgendaGoal, type CompanionAgendaGrant, type CompanionAgendaStep, type CompanionAgendaClaim } from '../shared/companion-agenda';
import { companionCivilInstantInZone, companionTimeInZone, nextCompanionScheduleRun, resolveCompanionScheduleTimeZone } from '../shared/companion-schedule-time';
import type { CompanionConnection } from './store';
import { companionTaskLegacyActiveCount } from './task-concurrency-store';
import { classifyCompanionAgendaRule } from './agenda-classification';
import { companionAgendaActivityPresentation } from '../shared/companion-agenda-presentation';
import { companionAgendaExecution } from '../shared/companion-agenda-execution';
import type { CompanionAction } from '../shared/companions';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: number | string | Date = new Date()) => new Date(value).toISOString();
const decode = <T>(row: unknown): T | undefined => row ? JSON.parse((row as { data: string }).data) as T : undefined;
const terminal = new Set(['completed', 'silent', 'cancelled', 'abandoned', 'expired']);
type Facts = Record<string, boolean | string | number>;
type StoredOccurrence = CompanionAgendaOccurrence;
type Table = 'companion_agenda_rules' | 'companion_agenda_runs' | 'companion_agenda_occurrences' | 'companion_agenda_goals' | 'companion_agenda_grants';

/** The only owner of logical agenda eligibility, leases and occurrence identity.
 * Read projections never advance opportunity clocks or start executions. */
export class CompanionAgendaStore {
  private beforeRoutineChange?: (companionId: string) => void;
  constructor(private readonly db: CompanionConnection) {}
  connectRoutineChanges(before: (companionId: string) => void): void { this.beforeRoutineChange = before; }
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_agenda_rules(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,next_at TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_agenda_rule_owner ON companion_agenda_rules(companion_id,id);
      CREATE INDEX IF NOT EXISTS companion_agenda_rule_due ON companion_agenda_rules(companion_id,status,next_at,id);
      CREATE TABLE IF NOT EXISTS companion_agenda_occurrences(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,rule_id TEXT NOT NULL,scheduled_at TEXT NOT NULL,state TEXT NOT NULL,rule_data TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(rule_id,scheduled_at));
      CREATE INDEX IF NOT EXISTS companion_agenda_occ_owner ON companion_agenda_occurrences(companion_id,scheduled_at,id);
      CREATE INDEX IF NOT EXISTS companion_agenda_occ_rule ON companion_agenda_occurrences(rule_id,scheduled_at DESC,id);
      CREATE TABLE IF NOT EXISTS companion_agenda_runs(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,rule_id TEXT NOT NULL,occurrence_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,status TEXT NOT NULL,not_before TEXT NOT NULL,lease_until TEXT,created_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_agenda_run_due ON companion_agenda_runs(status,not_before,created_at,id);
      CREATE INDEX IF NOT EXISTS companion_agenda_run_owner ON companion_agenda_runs(companion_id,status,not_before,id);
      CREATE INDEX IF NOT EXISTS companion_agenda_run_rule ON companion_agenda_runs(rule_id,created_at DESC,id);
      CREATE TABLE IF NOT EXISTS companion_agenda_steps(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,run_id TEXT NOT NULL,effect_key TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(run_id,effect_key));
      CREATE INDEX IF NOT EXISTS companion_agenda_step_run ON companion_agenda_steps(companion_id,run_id,id);
      CREATE TABLE IF NOT EXISTS companion_agenda_goals(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_agenda_goal_owner ON companion_agenda_goals(companion_id,id);
      CREATE TABLE IF NOT EXISTS companion_agenda_grants(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_agenda_grant_owner ON companion_agenda_grants(companion_id,id);
      CREATE TABLE IF NOT EXISTS companion_agenda_receipts(operation_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_agenda_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,companion_id TEXT NOT NULL,entity_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_agenda_audit_owner ON companion_agenda_audit(companion_id,sequence);
      CREATE TABLE IF NOT EXISTS companion_agenda_emissions(companion_id TEXT NOT NULL,event_key TEXT NOT NULL,topic TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(companion_id,event_key));`);
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_agenda_rule_category ON companion_agenda_rules(companion_id,json_extract(data,'$.category'),id)");
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='actions'").get())
      this.db.exec("CREATE INDEX IF NOT EXISTS actions_agenda_owner_status ON actions(companion_id,status,id) WHERE json_type(data,'$.capability') IS NULL AND json_type(data,'$.thought') IS NULL");
    // Host metadata backfill preserves all original definitions, occurrences
    // and raw evidence. It never starts a model or schedules an extra run.
    for (const row of this.db.prepare("SELECT companion_id,id,data FROM companion_agenda_rules WHERE json_extract(data,'$.classification') IS NULL OR json_extract(data,'$.category') IS NULL").all() as Array<{ companion_id: string; id: string; data: string }>) {
      const rule = JSON.parse(row.data) as CompanionAgendaRule;
      this.db.prepare('UPDATE companion_agenda_rules SET data=? WHERE id=?').run(JSON.stringify({ ...rule, ...classifyCompanionAgendaRule(this.db, row.companion_id, rule) }), row.id);
    }
    for (const row of this.db.prepare("SELECT companion_id,id,rule_data FROM companion_agenda_occurrences WHERE json_extract(rule_data,'$.classification') IS NULL OR json_extract(rule_data,'$.category') IS NULL").all() as Array<{ companion_id: string; id: string; rule_data: string }>) {
      const rule = JSON.parse(row.rule_data) as CompanionAgendaRule;
      this.db.prepare('UPDATE companion_agenda_occurrences SET rule_data=? WHERE id=?').run(JSON.stringify({ ...rule, ...classifyCompanionAgendaRule(this.db, row.companion_id, rule) }), row.id);
    }
    // Correct current display metadata only. Previously sealed executions keep
    // their exact rule bytes, identity, timing, revision and actual outcomes.
    for (const row of this.db.prepare(`SELECT companion_id,id,data FROM companion_agenda_rules
      WHERE json_extract(data,'$.category')!='daily' AND (json_extract(data,'$.executor') IN('routine','chat')
        OR (json_extract(data,'$.executor')='brain' AND json_extract(data,'$.origin')='system' AND json_extract(data,'$.referenceId')='system_self_wake_v1'))`)
      .all() as Array<{ companion_id: string; id: string; data: string }>) {
      const rule = JSON.parse(row.data) as CompanionAgendaRule;
      this.db.prepare('UPDATE companion_agenda_rules SET data=? WHERE id=?').run(JSON.stringify({ ...rule, ...classifyCompanionAgendaRule(this.db, row.companion_id, rule) }), row.id);
    }
    const nativeTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN('companion_activity_tasks','companion_world_jobs')").all();
    if (nativeTables.length === 2) {
      // Correct only the former derived world-child label. The original
      // definition, revision, sealed occurrence and execution stay unchanged.
      const rows = this.db.prepare(`SELECT r.id,r.companion_id,r.data FROM companion_agenda_rules r
        JOIN companion_activity_tasks a ON a.id=json_extract(r.data,'$.referenceId') AND a.companion_id=r.companion_id
        JOIN companion_world_jobs w ON json_extract(a.data,'$.clientId')='world_activity_'||w.id AND w.companion_id=r.companion_id
        WHERE json_extract(r.data,'$.executor')='activity' AND json_extract(a.data,'$.companionId')=r.companion_id
        AND (json_extract(r.data,'$.conversationId') IS NULL OR json_extract(r.data,'$.conversationId')=json_extract(a.data,'$.conversationId'))
        AND (json_extract(r.data,'$.category')!='task' OR json_extract(r.data,'$.classification.basis')='system_maintenance')`).all() as Array<{ id: string; companion_id: string; data: string }>;
      for (const row of rows) {
        const rule = JSON.parse(row.data) as CompanionAgendaRule;
        this.db.prepare('UPDATE companion_agenda_rules SET data=? WHERE id=?').run(JSON.stringify({ ...rule, ...classifyCompanionAgendaRule(this.db, row.companion_id, rule) }), row.id);
      }
    }
  }
  private owner(owner: string, active = false): void {
    const value = this.db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(owner) as { data: string } | undefined;
    if (!value) throw new Error('AGENDA_NOT_AUTHORIZED: 伙伴不存在或已经退役。');
    if (active && this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('recovery-review-required/' + owner)) throw new Error('AGENDA_WAITING: 恢复后的伙伴资料等待用户复核，后台行为未恢复。');
    if (active && (JSON.parse(value.data) as { active?: boolean }).active === false) throw new Error('AGENDA_WAITING: 伙伴生活已暂停。');
  }
  private read<T>(table: Table, owner: string, id: string): T | undefined {
    return decode<T>(this.db.prepare(`SELECT data FROM ${table} WHERE companion_id=? AND id=?`).get(owner, id));
  }
  private audit(owner: string, id: string, kind: string, data: unknown, at = iso()): void {
    this.db.prepare('INSERT INTO companion_agenda_audit(companion_id,entity_id,kind,data,at) VALUES(?,?,?,?,?)').run(owner, id, kind, JSON.stringify(data), at);
  }
  private saveRule(rule: CompanionAgendaRule): void {
    const value = companionAgendaRuleSchema.parse(rule);
    this.db.prepare('INSERT INTO companion_agenda_rules(id,companion_id,revision,status,next_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,next_at=excluded.next_at,data=excluded.data')
      .run(value.id, value.companionId, value.revision, value.status, value.nextAt ?? null, JSON.stringify(value));
  }
  private saveOccurrence(occurrence: StoredOccurrence, rule?: CompanionAgendaRule): void {
    const snapshot = rule ?? this.read<CompanionAgendaRule>('companion_agenda_rules', occurrence.companionId, occurrence.ruleId);
    if (!snapshot) throw new Error('日程规则不存在。');
    this.db.prepare('INSERT INTO companion_agenda_occurrences(id,companion_id,rule_id,scheduled_at,state,rule_data,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data')
      .run(occurrence.id, occurrence.companionId, occurrence.ruleId, occurrence.scheduledAt, occurrence.state, JSON.stringify(snapshot), JSON.stringify(occurrence));
  }
  private saveRun(run: CompanionAgendaRun): void {
    const value = companionAgendaRunSchema.parse(run);
    this.db.prepare('INSERT INTO companion_agenda_runs(id,companion_id,rule_id,occurrence_id,revision,status,not_before,lease_until,created_at,data) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,not_before=excluded.not_before,lease_until=excluded.lease_until,data=excluded.data')
      .run(value.id, value.companionId, value.ruleId, value.occurrenceId, value.revision, value.status, value.notBefore, value.leaseUntil ?? null, value.createdAt, JSON.stringify(value));
  }
  private cas<T extends { revision: number }>(value: T | undefined, expectedRevision: number): T {
    if (!value) throw new Error('日程记录不存在或不属于当前伙伴。');
    if (value.revision !== expectedRevision) throw new Error('AGENDA_CONFLICT: 日程版本已经变化，请重新读取。');
    return value;
  }
  private authority(owner: string, authority: CompanionAgendaAuthority): void {
    this.owner(owner);
    // User authority may originate in the trusted manual UI; when a message
    // is supplied it must be an actual user source, never model prose.
    if (authority.kind === 'user' && authority.sourceMessageId) {
      const source = this.db.prepare(`SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
        WHERE m.id=? AND cm.companion_id=? AND m.author_id='user' AND m.status='sent' AND m.kind='text'
          AND NOT EXISTS(SELECT 1 FROM metadata l WHERE l.key='message-loop/'||m.id AND json_extract(l.value,'$.status')!='done')
          AND (json_extract(m.request_fingerprint,'$.loopStep') IS NULL OR EXISTS(SELECT 1 FROM metadata l WHERE l.key='message-loop/'||m.id AND json_extract(l.value,'$.status')='done'))`)
        .get(authority.sourceMessageId, owner);
      if (!source) throw new Error('AGENDA_NOT_AUTHORIZED: 本次用户来源不存在。');
    }
  }
  private mutable(rule: CompanionAgendaRule, authority: CompanionAgendaAuthority, control = false): void {
    if (authority.kind === 'self' && rule.category === 'event') throw new Error('AGENDA_NOT_AUTHORIZED: 系统处理事件由宿主管理，伙伴不能关闭、恢复或改写。');
    if (rule.protected && authority.kind !== 'system' && !(control && rule.category === 'task')) throw new Error('AGENDA_NOT_AUTHORIZED: 系统完整性职责不能由用户或主脑关闭。');
    if (authority.kind === 'self' && !rule.flexible && !control) throw new Error('AGENDA_NOT_AUTHORIZED: 伙伴不能自行修改固定约定；可以暂停或提出协商。');
    if (authority.kind === 'self' && !control && rule.grantId && rule.grantId !== authority.grantId) throw new Error('AGENDA_NOT_AUTHORIZED: 本次自主调用不属于该持续授权。');
  }
  private effectiveGrant(owner: string, grantId: string, now: string, goalId?: string): CompanionAgendaGrant {
    const grant = this.read<CompanionAgendaGrant>('companion_agenda_grants', owner, grantId);
    if (!grant || grant.status !== 'active' || grant.expiresAt && grant.expiresAt <= now || grant.goalId && grant.goalId !== goalId)
      throw new Error('AGENDA_NOT_AUTHORIZED: 持续授权不可用或不属于当前目标。');
    return grant;
  }
  private authorizeRoutine(rule: Pick<CompanionAgendaRule, 'executor' | 'routine'>, owner: string, exceptId = ''): void {
    if (rule.executor !== 'routine' || !rule.routine) return;
    const count = this.db.prepare(`SELECT count(*) AS n FROM companion_agenda_rules WHERE companion_id=? AND status='active' AND id!=?
      AND json_extract(data,'$.executor')='routine' AND json_extract(data,'$.routine.kind')=?`).get(owner, exceptId, rule.routine.kind) as { n: number };
    const limit = rule.routine.kind === 'sleep' ? 1 : rule.routine.kind === 'meal' ? 8 : 20;
    if (count.n >= limit) throw new Error(rule.routine.kind === 'sleep' ? '已有生效的每日睡眠窗口，请调整现有规则或先暂停它。' : '同类虚拟作息过多，请先整理现有规则。');
  }
  private authorizeRule(rule: Pick<CompanionAgendaRule, 'executor' | 'grantId' | 'goalId' | 'flexible' | 'routine'>, owner: string, authority: CompanionAgendaAuthority, now: string, exceptId = ''): void {
    this.authorizeRoutine(rule, owner, exceptId);
    if ('protected' in rule && rule.protected === true && authority.kind !== 'system') throw new Error('只有宿主能建立受保护的完整性职责。');
    if (authority.kind === 'self' && !rule.flexible) throw new Error('伙伴只能自行建立可调整的安排。');
    if (!exceptId && authority.kind !== 'system' && ['chat', 'activity'].includes(rule.executor)) throw new Error('原生聊天与持续任务只能由宿主依据真实任务记录登记，不能手工冒造绑定。');
    if (rule.goalId && !this.read('companion_agenda_goals', owner, rule.goalId)) throw new Error('长期方向不属于当前伙伴。');
    const required: Partial<Record<CompanionAgendaRule['executor'], CompanionAgendaGrant['capabilities'][number]>> = { observation: 'observe', dsh: 'dsh', learning: 'learning' };
    const capability = required[rule.executor];
    if (rule.grantId) {
      const grant = this.effectiveGrant(owner, rule.grantId, now, rule.goalId);
      if (capability && !grant.capabilities.includes(capability)) throw new Error('持续授权没有覆盖此能力。');
      if (authority.kind === 'self' && authority.grantId !== grant.id) throw new Error('不能从其他自主事件借用持续授权。');
    } else if (capability && authority.kind === 'self') throw new Error('自主外部观察、学习或执行需要有效持续授权。');
  }
  private nextAt(rule: CompanionAgendaRule, now: string): string | undefined {
    // World-body windows are read by the deterministic physical engine. They
    // do not enter the real-time semantic queue or consume an LLM permit.
    if (rule.executor === 'routine') return undefined;
    const trigger = rule.trigger;
    if (trigger.kind === 'event') return undefined;
    if (trigger.kind === 'at' && trigger.repeat === 'once') return trigger.at;
    if (trigger.kind === 'window') return this.window(rule, now)?.start;
    return nextCompanionScheduleRun(trigger.kind === 'interval'
      ? { runAt: trigger.anchorAt, timeZone: trigger.timeZone, recurrence: 'interval', intervalMinutes: trigger.everyMinutes }
      : { runAt: trigger.at, timeZone: trigger.timeZone, recurrence: trigger.repeat, weekDays: trigger.weekDays }, new Date(Date.parse(now) - 1));
  }
  private window(rule: CompanionAgendaRule, now: string): { start: string; end: string } | undefined {
    const trigger = rule.trigger;
    if (trigger.kind !== 'window') return undefined;
    const zone = resolveCompanionScheduleTimeZone(trigger.timeZone), epoch = Date.parse(now), civil = companionTimeInZone(epoch, zone);
    const anchor = new Date(0); anchor.setUTCFullYear(civil.year, civil.month - 1, civil.day); anchor.setUTCHours(0, 0, 0, 0);
    for (let day = -1; day < 9; day++) {
      const date = new Date(anchor.getTime() + day * 86400000);
      if (trigger.weekDays && !trigger.weekDays.includes(date.getUTCDay())) continue;
      const atMinute = (minute: number, addDay = 0) => {
        const target = new Date(date.getTime() + addDay * 86400000); target.setUTCMinutes(minute);
        return companionCivilInstantInZone({ year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate(),
          hour: target.getUTCHours(), minute: target.getUTCMinutes(), second: 0, millisecond: 0 }, zone, 'next_valid');
      };
      const start = atMinute(trigger.startMinute), end = atMinute(trigger.endMinute, trigger.endMinute < trigger.startMinute ? 1 : 0);
      if (start !== undefined && end !== undefined && end > epoch && end > start) return { start: iso(start), end: iso(end) };
    }
    return undefined;
  }
  private createRun(occurrence: CompanionAgendaOccurrence, now: string): CompanionAgendaRun {
    const prior = decode<CompanionAgendaRun>(this.db.prepare('SELECT data FROM companion_agenda_runs WHERE occurrence_id=?').get(occurrence.id));
    if (prior) return prior;
    const run: CompanionAgendaRun = { id: 'run_' + sha(occurrence.id).slice(0, 64), companionId: occurrence.companionId, ruleId: occurrence.ruleId, occurrenceId: occurrence.id,
      revision: 1, status: 'queued', stage: '条件已就绪，等待执行', createdAt: now, updatedAt: now, notBefore: now,
      failureCount: 0, cycleFailureCount: 0, retryCycle: 0, attemptCount: 0 };
    this.saveRun(run); this.audit(run.companionId, run.id, 'run.created', run, now); return run;
  }
  private sealedRule(occurrenceId: string): CompanionAgendaRule | undefined {
    const value = this.db.prepare('SELECT rule_data FROM companion_agenda_occurrences WHERE id=?').get(occurrenceId) as { rule_data: string } | undefined;
    return value ? JSON.parse(value.rule_data) as CompanionAgendaRule : undefined;
  }
  private tick(owner: string, now: string, facts: Facts): void {
    this.owner(owner);
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('agenda-facts/' + owner, JSON.stringify({ at: now, facts }));
    // Rules at an event trigger have no timer. Due time rules are visited in
    // bounded fair pages; each visitation advances next_at out of this batch.
    const rules = this.db.prepare("SELECT data FROM companion_agenda_rules WHERE companion_id=? AND status='active' AND next_at<=? AND json_extract(data,'$.executor')!='routine' ORDER BY next_at,id LIMIT 128")
      .all(owner, now).map(row => decode<CompanionAgendaRule>(row)!);
    for (const rule of rules) {
      const trigger = rule.trigger;
      if (trigger.kind === 'event') continue;
      const period = trigger.kind === 'window' ? this.window(rule, now) : undefined;
      if (period && period.start > now) { rule.nextAt = period.start; this.saveRule(rule); continue; }
      const waiting = trigger.kind !== 'window' ? decode<CompanionAgendaOccurrence>(this.db.prepare("SELECT data FROM companion_agenda_occurrences WHERE rule_id=? AND state='waiting' ORDER BY scheduled_at,id LIMIT 1").get(rule.id)) : undefined;
      const scheduledAt = period?.start ?? waiting?.scheduledAt ?? rule.nextAt!;
      if (!period && trigger.kind === 'window') { rule.nextAt = iso(Date.parse(now) + 3600000); this.saveRule(rule); continue; }
      const occurrenceId = 'occ_' + sha([owner, rule.id, scheduledAt]).slice(0, 64);
      let occurrence = waiting ?? this.read<CompanionAgendaOccurrence>('companion_agenda_occurrences', owner, occurrenceId);
      if (!occurrence) {
        const uniform = (Number.parseInt(sha([rule.id, scheduledAt]).slice(0, 13), 16) + .5) / 4503599627370496;
        occurrence = { id: occurrenceId, companionId: owner, ruleId: rule.id, ruleRevision: rule.revision, scheduledAt, windowEnd: period?.end,
          lastEvaluatedAt: now, state: 'observing', accumulatedHazard: 0, conditionResults: [], reason: '等待条件与本次机会',
          probabilityThreshold: -Math.log(uniform) };
        this.saveOccurrence(occurrence, rule);
      }
      if (!terminal.has(occurrence.state) && !['running', 'parked', 'unknown'].includes(occurrence.state)) {
        const sealed = this.sealedRule(occurrence.id) ?? rule;
        const results = sealed.conditions.map(condition => ({ key: condition.key, label: condition.label, satisfied: facts[condition.key] === condition.equals }));
        let eligible = results.every(value => value.satisfied), reason = eligible ? '当前条件已满足' : results.filter(value => !value.satisfied).map(value => value.label).join('；');
        try { if (sealed.grantId) this.effectiveGrant(owner, sealed.grantId, now, sealed.goalId); }
        catch { eligible = false; reason = '等待有效持续授权'; }
        if (sealed.goalId) {
          const goal = this.read<CompanionAgendaGoal>('companion_agenda_goals', owner, sealed.goalId);
          if (!goal || goal.status !== 'active') { eligible = false; reason = '长期方向尚未启用'; }
        }
        if (trigger.kind === 'window' && eligible && occurrence.conditionResults.every(value => value.satisfied)) {
          const elapsed = Math.max(0, Math.min(Date.parse(now) - Date.parse(occurrence.lastEvaluatedAt), trigger.checkIntervalMinutes * 60000));
          occurrence.accumulatedHazard += -Math.log1p(-Math.min(1 - 1e-12, trigger.probability)) * elapsed / (Date.parse(period!.end) - Date.parse(period!.start));
        }
        const pointProbability = sealed.trigger.kind === 'at' || sealed.trigger.kind === 'interval' ? sealed.trigger.probability ?? 1 : 1;
        const pointOpportunity = pointProbability === 1 || occurrence.probabilityThreshold !== undefined && occurrence.probabilityThreshold <= -Math.log1p(-pointProbability);
        const opportunity = trigger.kind === 'window' ? trigger.probability === 1 || occurrence.accumulatedHazard >= (occurrence.probabilityThreshold ?? Infinity) : pointOpportunity;
        occurrence.conditionResults = results; occurrence.lastEvaluatedAt = now; occurrence.reason = reason;
        occurrence.state = trigger.kind !== 'window' && !pointOpportunity ? 'silent' : eligible && opportunity ? 'ready' : eligible ? 'observing' : 'waiting';
        if (occurrence.state === 'silent') occurrence.reason = '本次周期机会未触发；同一时点不重新抽取，等待下一次计划机会。';
        occurrence.nextCheckAt = iso(Date.parse(now) + (trigger.kind === 'window' ? trigger.checkIntervalMinutes * 60000 : 60000));
        if (occurrence.state === 'ready') this.createRun(occurrence, now);
        this.saveOccurrence(occurrence);
        this.audit(owner, occurrence.id, 'occurrence.evaluated', { state: occurrence.state, reason: occurrence.reason, nextCheckAt: occurrence.nextCheckAt, conditionResults: occurrence.conditionResults }, now);
      }
      if (trigger.kind === 'window') rule.nextAt = terminal.has(occurrence.state) || ['running', 'ready', 'parked', 'unknown'].includes(occurrence.state)
        ? period!.end : occurrence.nextCheckAt;
      else if (occurrence.state === 'waiting') rule.nextAt = occurrence.nextCheckAt;
      else rule.nextAt = nextCompanionScheduleRun(trigger.kind === 'interval'
        ? { runAt: trigger.anchorAt, timeZone: trigger.timeZone, recurrence: 'interval', intervalMinutes: trigger.everyMinutes }
        : { runAt: trigger.at, timeZone: trigger.timeZone, recurrence: trigger.repeat, weekDays: trigger.weekDays }, now);
      this.saveRule(rule);
    }
    // A chance that did not occur expires honestly, rather than becoming an
    // overdue spontaneous message after offline time.
    for (const row of this.db.prepare("SELECT data FROM companion_agenda_occurrences WHERE companion_id=? AND state IN('observing','waiting','ready') AND json_extract(data,'$.windowEnd')<=? ORDER BY scheduled_at LIMIT 128").all(owner, now)) {
      const occurrence = decode<CompanionAgendaOccurrence>(row)!;
      occurrence.state = 'expired'; occurrence.reason = '本次机会窗口已结束'; this.saveOccurrence(occurrence);
      const run = decode<CompanionAgendaRun>(this.db.prepare('SELECT data FROM companion_agenda_runs WHERE occurrence_id=?').get(occurrence.id));
      if (run && ['queued', 'waiting'].includes(run.status)) this.stopRun(run, 'cancelled', now, '机会窗口已结束');
    }
  }
  private stopRun(run: CompanionAgendaRun, status: CompanionAgendaRun['status'], now: string, reason: string): void {
    run.status = status; run.updatedAt = now; run.stage = reason; run.revision++; delete run.leaseToken; delete run.leaseUntil;
    if (terminal.has(status)) run.finishedAt = now;
    this.saveRun(run);
    const occurrence = this.read<CompanionAgendaOccurrence>('companion_agenda_occurrences', run.companionId, run.occurrenceId);
    if (occurrence) { occurrence.state = status === 'queued' ? 'ready' : status; occurrence.reason = reason; this.saveOccurrence(occurrence); }
    this.audit(run.companionId, run.id, 'run.' + status, run, now);
  }
  private liveRun(owner: string, id: string, leaseToken: string, now: string): CompanionAgendaRun {
    const run = this.read<CompanionAgendaRun>('companion_agenda_runs', owner, id);
    if (!run || run.status !== 'running' || run.leaseToken !== leaseToken || !run.leaseUntil || run.leaseUntil <= now)
      throw new Error('AGENDA_LEASE_LOST: 日程执行租约已失效。');
    return run;
  }
  private deferRun(run: CompanionAgendaRun, occurrence: CompanionAgendaOccurrence, now: string, reason: string, delayMs = 60000): void {
    run.status = 'waiting'; run.notBefore = iso(Date.parse(now) + delayMs); run.nextCondition = reason; run.stage = reason; run.updatedAt = now; run.revision++;
    occurrence.state = 'waiting'; occurrence.reason = reason; occurrence.nextCheckAt = run.notBefore;
    this.saveRun(run); this.saveOccurrence(occurrence); this.audit(run.companionId, run.id, 'run.waiting', { nextCheckAt: run.notBefore, reason }, now);
  }
  private claim(command: Extract<CompanionAgendaCommand, { type: 'agenda.claim' }>): CompanionAgendaResponse {
    const { now } = command;
    // A lost process cannot prove that an external side effect did not happen.
    for (const row of this.db.prepare("SELECT data FROM companion_agenda_runs WHERE status='running' AND lease_until<=? ORDER BY lease_until LIMIT 128").all(now)) {
      const run = decode<CompanionAgendaRun>(row)!; this.stopRun(run, 'unknown', now, '执行租约中断；先核对已发生的作用，禁止自动重放');
    }
    const candidates = this.db.prepare(`SELECT data FROM companion_agenda_runs WHERE status IN('queued','waiting') AND not_before<=? ${command.companionId ? 'AND companion_id=?' : ''} ORDER BY created_at,id LIMIT 128`)
      .all(now, ...(command.companionId ? [command.companionId] : [])).map(row => decode<CompanionAgendaRun>(row)!);
    const claims: CompanionAgendaClaim[] = [];
    for (const run of candidates) {
      if (claims.length >= command.limit) break;
      if (command.excludedOwners.includes(run.companionId)) continue;
      try { this.owner(run.companionId, true); } catch { continue; }
      const current = this.read<CompanionAgendaRule>('companion_agenda_rules', run.companionId, run.ruleId), rule = this.sealedRule(run.occurrenceId);
      const occurrence = this.read<CompanionAgendaOccurrence>('companion_agenda_occurrences', run.companionId, run.occurrenceId);
      if (!current || current.status !== 'active' || !rule || !occurrence || terminal.has(occurrence.state)) continue;
      if (occurrence.windowEnd && occurrence.windowEnd <= now) { this.stopRun(run, 'cancelled', now, '本次机会窗口已结束'); continue; }
      try { if (rule.grantId) this.effectiveGrant(run.companionId, rule.grantId, now, rule.goalId); }
      catch { this.deferRun(run, occurrence, now, '等待当前事件范围内的有效持续授权'); continue; }
      const factRow = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('agenda-facts/' + run.companionId) as { value: string } | undefined;
      const facts = factRow ? (JSON.parse(factRow.value) as { facts: Facts }).facts : {};
      const conditionResults = rule.conditions.map(condition => ({ key: condition.key, label: condition.label, satisfied: facts[condition.key] === condition.equals }));
      occurrence.conditionResults = conditionResults;
      if (conditionResults.some(condition => !condition.satisfied)) { this.deferRun(run, occurrence, now, conditionResults.filter(value => !value.satisfied).map(value => value.label).join('；')); continue; }
      if (rule.goalId && this.read<CompanionAgendaGoal>('companion_agenda_goals', run.companionId, rule.goalId)?.status !== 'active') { this.deferRun(run, occurrence, now, '等待长期方向恢复'); continue; }
      const live = this.db.prepare("SELECT data FROM companion_agenda_runs WHERE companion_id=? AND status='running' AND lease_until>?").all(run.companionId, now).map(row => decode<CompanionAgendaRun>(row)!);
      const limitRow = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('task-concurrency/' + run.companionId) as { value: string } | undefined;
      const limit = limitRow && Number.isInteger(Number(limitRow.value)) ? Math.max(1, Math.min(10, Number(limitRow.value))) : 3;
      if (live.length + companionTaskLegacyActiveCount(this.db, run.companionId) >= limit) continue;
      if (rule.overlapPolicy !== 'parallel' && live.some(value => value.ruleId === rule.id)) {
        if (rule.overlapPolicy === 'skip') this.stopRun(run, 'silent', now, '上次同类事项仍在进行，本次按规则跳过');
        else this.deferRun(run, occurrence, now, '等待上次同类事项的实际结果', 5000);
        continue;
      }
      const locks = new Set(live.flatMap(value => this.sealedRule(value.occurrenceId)?.resourceKeys ?? []));
      if (rule.resourceKeys.some(key => locks.has(key))) { this.deferRun(run, occurrence, now, '等待本事项需要的资源可用', 5000); continue; }
      run.status = 'running'; run.revision++; run.attemptCount++; run.updatedAt = now; run.startedAt ??= now;
      run.leaseToken = randomUUID(); run.leaseUntil = iso(Date.parse(now) + command.leaseMs); run.stage = '正在执行'; delete run.nextCondition;
      occurrence.state = 'running'; occurrence.reason = '已取得本次执行资格'; this.saveRun(run); this.saveOccurrence(occurrence);
      this.audit(run.companionId, run.id, 'run.claimed', { attempt: run.attemptCount, leaseToken: run.leaseToken }, now);
      claims.push({ rule, occurrence, run, leaseToken: run.leaseToken });
    }
    return { ok: true, agendaClaims: claims, ...(claims[0] ? { agendaClaim: claims[0] } : {}) };
  }
  execute(input: CompanionAgendaCommand | { type: string }): CompanionAgendaResponse | undefined {
    if (!input.type.startsWith('agenda.')) return undefined;
    const command = companionAgendaCommandSchema.parse(input);
    const response = this.db.transaction((): CompanionAgendaResponse => {
      if ('companionId' in command && command.companionId) this.owner(command.companionId);
      if ('authority' in command) this.authority(command.companionId, command.authority);
      if ('operationId' in command) {
        const prior = this.db.prepare('SELECT companion_id,fingerprint,data FROM companion_agenda_receipts WHERE operation_id=?').get(command.operationId) as { companion_id: string; fingerprint: string; data: string } | undefined;
        if (prior) {
          if (prior.companion_id !== command.companionId || prior.fingerprint !== sha(command)) throw new Error('AGENDA_CONFLICT: 操作标识已用于其他日程内容。');
          return JSON.parse(prior.data) as CompanionAgendaResponse;
        }
      }
      const response = this.dispatch(command);
      if ('operationId' in command) this.db.prepare('INSERT INTO companion_agenda_receipts(operation_id,companion_id,fingerprint,data) VALUES(?,?,?,?)')
        .run(command.operationId, command.companionId, sha(command), JSON.stringify(response));
      return response;
    }).immediate();
    return this.present(response);
  }
  private present(response: CompanionAgendaResponse): CompanionAgendaResponse {
    const rules = [response.agendaRule, response.agendaEvent?.rule, ...response.agenda?.rules ?? [],
      ...response.agendaTasks?.flatMap(task => task.form === 'scheduled' ? [task.rule] : []) ?? []].filter((rule): rule is CompanionAgendaRule => !!rule);
    const ids = [...new Set(rules.filter(rule => rule.executor === 'activity' && rule.referenceId && rule.referenceVersion !== undefined).map(rule => rule.referenceId!))];
    if (!ids.length || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_activity_tasks'").get()) return response;
    const rows = this.db.prepare(`SELECT id,companion_id,data FROM companion_activity_tasks WHERE id IN(${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; companion_id: string; data: string }>;
    const natives = new Map(rows.map(row => [row.id, row]));
    const project = (rule: CompanionAgendaRule): CompanionAgendaRule => {
      const plain = { ...rule }; delete plain.presentation;
      const row = rule.executor === 'activity' && rule.referenceId ? natives.get(rule.referenceId) : undefined;
      if (!row || row.companion_id !== rule.companionId) return plain;
      let task: { companionId?: string; conversationId?: string; sourceMessageId?: string; agendaAttempt?: number; title?: string; goal?: string; historyAvailable?: boolean };
      try { task = JSON.parse(row.data) as typeof task; } catch { return plain; }
      if (task.companionId !== rule.companionId || task.conversationId !== rule.conversationId || String(task.agendaAttempt ?? 0) !== rule.referenceVersion
        || rule.sourceMessageId && rule.sourceMessageId !== task.sourceMessageId || task.historyAvailable === false || typeof task.title !== 'string' || typeof task.goal !== 'string') return plain;
      return { ...plain, presentation: companionAgendaActivityPresentation({ title: task.title, goal: task.goal }) };
    };
    return { ...response, ...(response.agendaRule ? { agendaRule: project(response.agendaRule) } : {}),
      ...(response.agendaEvent ? { agendaEvent: { ...response.agendaEvent, rule: project(response.agendaEvent.rule) } } : {}),
      ...(response.agenda ? { agenda: { ...response.agenda, rules: response.agenda.rules.map(project) } } : {}),
      ...(response.agendaTasks ? { agendaTasks: response.agendaTasks.map(task => task.form === 'scheduled' ? { ...task, rule: project(task.rule) } : task) } : {}) };
  }
  private dispatch(command: CompanionAgendaCommand): CompanionAgendaResponse {
    const now = 'now' in command ? command.now : iso();
    switch (command.type) {
      case 'agenda.rule.create': {
        const draft = companionAgendaRuleDraftSchema.parse(command.rule); this.authorizeRule(draft, command.companionId, command.authority, now);
        const classification = classifyCompanionAgendaRule(this.db, command.companionId, draft, command.authority, true);
        if (classification.category === 'event' && command.authority.kind === 'self') throw new Error('AGENDA_NOT_AUTHORIZED: 伙伴可以创建自己的任务，不能自行建立系统维护职责。');
        if (draft.executor === 'routine') this.beforeRoutineChange?.(command.companionId);
        const rule: CompanionAgendaRule = { ...draft, ...classification, id: randomUUID(), companionId: command.companionId, revision: 1, origin: command.authority.kind,
          status: 'active', createdAt: now, updatedAt: now, sourceMessageId: command.authority.sourceMessageId };
        rule.nextAt = this.nextAt(rule, now); this.saveRule(rule); this.audit(rule.companionId, rule.id, 'rule.created', rule); return { ok: true, agendaRule: rule };
      }
      case 'agenda.rule.update': {
        const previous = this.cas(this.read<CompanionAgendaRule>('companion_agenda_rules', command.companionId, command.id), command.expectedRevision);
        this.mutable(previous, command.authority); this.authorizeRule(command.rule, command.companionId, command.authority, now, previous.id);
        if (command.authority.kind === 'self' && previous.classification?.sourceAuthorId && previous.classification.sourceAuthorId !== command.companionId) {
          const contract = (rule: typeof command.rule) => JSON.stringify([
            rule.title, rule.intent, rule.kind, rule.executor, rule.goalId, rule.grantId, rule.conversationId, rule.referenceId, rule.referenceVersion, rule.clock, rule.routine]);
          if (contract(previous) !== contract(command.rule)) throw new Error('AGENDA_NOT_AUTHORIZED: 外来任务的原始目标不能自行改写，请通过任务回应提出协商或拒绝。');
        }
        if (previous.executor === 'routine' || command.rule.executor === 'routine') this.beforeRoutineChange?.(command.companionId);
        const rule = { ...previous, ...command.rule, revision: previous.revision + 1, updatedAt: now };
        rule.nextAt = this.nextAt(rule, now); this.saveRule(rule); this.audit(rule.companionId, rule.id, 'rule.revised', { previous, rule }); return { ok: true, agendaRule: rule };
      }
      case 'agenda.rule.control': {
        const previous = this.cas(this.read<CompanionAgendaRule>('companion_agenda_rules', command.companionId, command.id), command.expectedRevision); this.mutable(previous, command.authority, true);
        if (command.taskResponse) {
          if (previous.category !== 'task') throw new Error('系统事件不是可接受或协商的伙伴任务。');
          const expected = { accept: 'resume', negotiate: 'pause', decline: 'retire' } as const;
          if (command.action !== expected[command.taskResponse.decision]) throw new Error('任务回应与暂停、恢复或拒绝动作不一致。');
        }
        if (previous.status === 'retired') throw new Error('已结束的日程不能恢复；需要建立新的安排。');
        const rule: CompanionAgendaRule = { ...previous, revision: previous.revision + 1, updatedAt: now, status: command.action === 'pause' ? 'paused' : command.action === 'retire' ? 'retired' : 'active',
          ...(command.taskResponse ? { taskResponse: { ...command.taskResponse, by: command.authority.kind, at: now } } : {}) };
        if (rule.status === 'active') this.authorizeRoutine(rule, command.companionId, previous.id);
        if (previous.executor === 'routine') this.beforeRoutineChange?.(command.companionId);
        if (rule.status === 'active') rule.nextAt = this.nextAt(rule, now);
        this.saveRule(rule);
        if (command.action === 'pause') for (const row of this.db.prepare(`SELECT data FROM companion_agenda_runs WHERE companion_id=? AND rule_id=?
          AND (status IN('queued','running','waiting') OR status='parked' AND json_extract(data,'$.pausedByGoalId') IS NOT NULL)`).all(rule.companionId, rule.id)) {
          const run = decode<CompanionAgendaRun>(row)!;
          run.pausedByRuleId = rule.id;
          this.stopRun(run, 'parked', now, '日程规则已暂停');
        }
        else if (command.action === 'resume') for (const row of this.db.prepare(`SELECT data FROM companion_agenda_runs WHERE companion_id=? AND rule_id=?
          AND status='parked' AND json_extract(data,'$.pausedByRuleId')=?`).all(rule.companionId, rule.id, rule.id)) {
          const run = decode<CompanionAgendaRun>(row)!;
          delete run.pausedByRuleId;
          if (run.pausedByGoalId) this.stopRun(run, 'parked', now, '所属长期方向仍在暂停');
          else { run.notBefore = now; this.stopRun(run, 'queued', now, '日程规则已恢复，继续原执行'); }
        }
        else if (command.action === 'retire') for (const row of this.db.prepare("SELECT data FROM companion_agenda_runs WHERE companion_id=? AND rule_id=? AND status IN('queued','running','waiting','parked')").all(rule.companionId, rule.id)) {
          const run = decode<CompanionAgendaRun>(row)!;
          delete run.pausedByRuleId; delete run.pausedByGoalId;
          this.stopRun(run, 'cancelled', now, '日程规则已结束，原始记录保留');
        }
        this.audit(rule.companionId, rule.id, 'rule.' + rule.status, { previous, rule }); return { ok: true, agendaRule: rule };
      }
      case 'agenda.tick': {
        this.tick(command.companionId, now, command.facts);
        const value = this.db.prepare('SELECT max(sequence) AS revision FROM companion_agenda_audit WHERE companion_id=?').get(command.companionId) as { revision: number | null };
        return { ok: true, agendaRevision: value.revision ?? 0 };
      }
      case 'agenda.claim': return this.claim(command);
      case 'agenda.emit': return this.emit(command);
      case 'agenda.run.heartbeat': {
        const run = this.liveRun(command.companionId, command.id, command.leaseToken, now);
        run.leaseUntil = iso(Date.parse(now) + command.leaseMs); run.updatedAt = now; this.saveRun(run); return { ok: true, agendaRun: run };
      }
      case 'agenda.run.bindGrant': {
        const run = this.liveRun(command.companionId, command.id, command.leaseToken, now), rule = this.sealedRule(run.occurrenceId);
        if (!rule) throw new Error('原始日程规则不可读取。');
        const grant = this.effectiveGrant(command.companionId, command.grantId, now, rule.goalId);
        if (grant.revision !== command.grantRevision || rule.grantId && rule.grantId !== grant.id
          || !rule.grantId && (grant.goalId || grant.conversationId)
          || run.activeGrantId && (run.activeGrantId !== grant.id || run.activeGrantRevision !== grant.revision))
          throw new Error('持续范围与本次日程的准确授权不一致，未扩大或替换执行范围。');
        if (run.activeGrantId) return { ok: true, agendaRun: run };
        run.activeGrantId = grant.id; run.activeGrantRevision = grant.revision; run.revision++; this.saveRun(run);
        this.audit(run.companionId, run.id, 'run.scope.bound', { grantId: grant.id, grantRevision: grant.revision }, now);
        return { ok: true, agendaRun: run };
      }
      case 'agenda.run.checkpoint': {
        const run = this.liveRun(command.companionId, command.id, command.leaseToken, now);
        run.checkpoint = command.checkpoint; run.stage = command.stage; run.updatedAt = now; run.revision++; this.saveRun(run);
        this.audit(run.companionId, run.id, 'run.checkpoint', { revision: run.revision, stage: run.stage, checksum: sha(run.checkpoint) }, now); return { ok: true, agendaRun: run };
      }
      case 'agenda.run.settle': return this.settle(command);
      case 'agenda.run.control': return this.controlRun(command);
      case 'agenda.run.reconcile': {
        const run = this.cas(this.read<CompanionAgendaRun>('companion_agenda_runs', command.companionId, command.id), command.expectedRevision);
        if (run.status !== 'unknown') throw new Error('只有结果待核对的执行可以核对结算。');
        this.stopRun(run, command.outcome === 'resume' ? 'queued' : command.outcome, now, command.evidence); run.notBefore = now; this.saveRun(run);
        this.audit(run.companionId, run.id, 'run.reconciled', { outcome: command.outcome, evidence: command.evidence }, now); return { ok: true, agendaRun: run };
      }
      case 'agenda.run.read': {
        const run = this.read<CompanionAgendaRun>('companion_agenda_runs', command.companionId, command.id);
        if (!run) throw new Error('日程执行不存在或已不可访问。');
        return { ok: true, agendaRun: run, agendaSteps: this.steps(command.companionId, command.id) };
      }
      case 'agenda.step.read': return { ok: true, agendaStep: decode<CompanionAgendaStep>(this.db.prepare('SELECT data FROM companion_agenda_steps WHERE companion_id=? AND run_id=? AND effect_key=?').get(command.companionId, command.runId, command.effectKey)) };
      case 'agenda.step.reconcile': {
        const run = this.cas(this.read<CompanionAgendaRun>('companion_agenda_runs', command.companionId, command.runId), command.expectedRunRevision);
        if (run.status !== 'unknown') throw new Error('步骤核对只能属于待核对的执行。');
        const step = decode<CompanionAgendaStep>(this.db.prepare('SELECT data FROM companion_agenda_steps WHERE companion_id=? AND run_id=? AND effect_key=?').get(command.companionId, command.runId, command.effectKey));
        if (!step || !['unknown', 'dispatched'].includes(step.status)) throw new Error('这个步骤没有待核对的外部作用。');
        step.status = command.outcome === 'succeeded' ? 'succeeded' : 'prepared'; step.result = command.result; step.updatedAt = now;
        this.db.prepare('UPDATE companion_agenda_steps SET status=?,data=? WHERE id=? AND companion_id=?').run(step.status, JSON.stringify(step), step.id, step.companionId);
        this.audit(step.companionId, step.id, 'step.reconciled', { outcome: command.outcome, evidence: command.evidence, step }, now);
        return { ok: true, agendaStep: step };
      }
      case 'agenda.step.record': return this.recordStep(command);
      case 'agenda.goal.create': {
        if (command.goal.grantId) this.effectiveGrant(command.companionId, command.goal.grantId, now);
        const goal = companionAgendaGoalSchema.parse({ ...command.goal, id: randomUUID(), companionId: command.companionId, origin: command.authority.kind, revision: 1, status: 'active', createdAt: now, updatedAt: now });
        this.saveGoal(goal); this.audit(goal.companionId, goal.id, 'goal.created', goal); return { ok: true, agendaGoal: goal };
      }
      case 'agenda.goal.update': {
        const previous = this.cas(this.read<CompanionAgendaGoal>('companion_agenda_goals', command.companionId, command.id), command.expectedRevision);
        if (previous.status === 'retired' || previous.status === 'completed') throw new Error('已经结束的长期方向不能继续改写。');
        if (command.authority.kind === 'self' && previous.origin !== 'self' && sha({ ...previous, nextQuestions: [], progress: '', revision: 0, updatedAt: '' }) !== sha({ ...previous, ...command.goal, nextQuestions: [], progress: '', revision: 0, updatedAt: '' }))
          throw new Error('主脑可以调整练习路线，不能自行改写用户提出的长期方向和验收要求。');
        if (command.authority.kind === 'self' && previous.grantId !== command.goal.grantId) throw new Error('不能自行更换长期方向的持续授权。');
        if (command.goal.grantId) this.effectiveGrant(command.companionId, command.goal.grantId, now, previous.id);
        const goal = { ...previous, ...command.goal, progress: command.progress ?? previous.progress, revision: previous.revision + 1, updatedAt: now };
        this.saveGoal(goal); this.audit(goal.companionId, goal.id, 'goal.revised', { previous, goal }); return { ok: true, agendaGoal: goal };
      }
      case 'agenda.goal.control': {
        const previous = this.cas(this.read<CompanionAgendaGoal>('companion_agenda_goals', command.companionId, command.id), command.expectedRevision);
        if (previous.status === 'retired' || previous.status === 'completed') throw new Error('已经结束的长期方向不能通过普通操作重开。');
        if (command.taskResponse && command.action !== ({ accept: 'resume', negotiate: 'pause', decline: 'retire' } as const)[command.taskResponse.decision]) throw new Error('长期任务的回应与暂停、恢复或拒绝动作不一致。');
        if (command.action === 'complete' && !command.evidence) throw new Error('结束长期方向需要实际依据，不能无凭证宣称学会。');
        if (command.action === 'complete' && command.authority.kind === 'self') throw new Error('主脑只能提议完成；实际完成由宿主核验依据。');
        const goal: CompanionAgendaGoal = { ...previous, status: command.action === 'pause' ? 'paused' : command.action === 'retire' ? 'retired' : command.action === 'complete' ? 'completed' : 'active', revision: previous.revision + 1, updatedAt: now, ...(command.taskResponse ? { taskResponse: { ...command.taskResponse, by: command.authority.kind, at: now } } : {}) };
        this.saveGoal(goal);
        const linked = this.db.prepare('SELECT r.data FROM companion_agenda_runs r JOIN companion_agenda_occurrences o ON o.id=r.occurrence_id WHERE r.companion_id=? AND json_extract(o.rule_data,\'$.goalId\')=? AND r.status IN(\'queued\',\'waiting\',\'running\',\'parked\')')
          .all(goal.companionId, goal.id).map(row => decode<CompanionAgendaRun>(row)!);
        for (const run of linked) {
          if (goal.status === 'active') {
            if (run.status === 'parked' && run.pausedByGoalId === goal.id) {
              delete run.pausedByGoalId;
              const rule = this.read<CompanionAgendaRule>('companion_agenda_rules', run.companionId, run.ruleId);
              if (!run.pausedByRuleId && rule?.status === 'active') { run.notBefore = now; this.stopRun(run, 'queued', now, '长期方向已恢复，保留原阶段继续'); }
              else { run.revision++; run.updatedAt = now; this.saveRun(run); }
            }
          } else if (run.status !== 'parked' || goal.status !== 'paused' || run.pausedByRuleId) {
            const unresolved = run.status === 'running' && this.db.prepare("SELECT 1 FROM companion_agenda_steps WHERE run_id=? AND status IN('dispatched','unknown') LIMIT 1").get(run.id);
            if (goal.status === 'paused' && !unresolved) run.pausedByGoalId = goal.id;
            else { delete run.pausedByGoalId; delete run.pausedByRuleId; }
            this.stopRun(run, unresolved ? 'unknown' : goal.status === 'paused' ? 'parked' : 'cancelled', now,
              unresolved ? '长期方向已暂停或结束，正在核对已派发的实际作用' : goal.status === 'paused' ? '长期方向已暂停' : '长期方向已经结束，未完成的执行已停止');
          }
        }
        this.audit(goal.companionId, goal.id, 'goal.' + goal.status, { previous, goal, evidence: command.evidence }); return { ok: true, agendaGoal: goal };
      }
      case 'agenda.grant.configure': {
        if (command.authority.kind !== 'user') throw new Error('AGENDA_NOT_AUTHORIZED: 只有用户可以签发或扩大持续授权。');
        if (command.grant.goalId && !this.read('companion_agenda_goals', command.companionId, command.grant.goalId)) throw new Error('持续授权的目标不属于当前伙伴。');
        const previous = command.id ? this.cas(this.read<CompanionAgendaGrant>('companion_agenda_grants', command.companionId, command.id), command.expectedRevision ?? 0) : undefined;
        const grant = companionAgendaGrantSchema.parse({ ...command.grant, id: previous?.id ?? randomUUID(), companionId: command.companionId,
          revision: (previous?.revision ?? 0) + 1, status: 'active', createdAt: previous?.createdAt ?? now, updatedAt: now });
        this.saveGrant(grant); this.audit(grant.companionId, grant.id, 'grant.configured', { previous, grant }); return { ok: true, agendaGrant: grant };
      }
      case 'agenda.grant.revoke': {
        if (command.authority.kind !== 'user') throw new Error('AGENDA_NOT_AUTHORIZED: 只有用户可以修改持续授权。');
        const previous = this.cas(this.read<CompanionAgendaGrant>('companion_agenda_grants', command.companionId, command.id), command.expectedRevision);
        const grant: CompanionAgendaGrant = { ...previous, revision: previous.revision + 1, status: 'revoked', updatedAt: now };
        this.saveGrant(grant); this.audit(grant.companionId, grant.id, 'grant.revoked', { previous, grant });
        for (const row of this.db.prepare("SELECT data FROM companion_agenda_runs WHERE companion_id=? AND status IN('queued','waiting','running')").all(command.companionId)) {
          const run = decode<CompanionAgendaRun>(row)!;
          if (this.sealedRule(run.occurrenceId)?.grantId === grant.id || run.activeGrantId === grant.id) this.stopRun(run, run.status === 'running' ? 'unknown' : 'cancelled', now, '持续授权已撤销，原始记录保留');
        }
        return { ok: true, agendaGrant: grant };
      }
      case 'agenda.goals.read': {
        const items = this.db.prepare('SELECT data FROM companion_agenda_goals WHERE companion_id=? AND id>? ORDER BY id LIMIT ?').all(command.companionId, command.afterId ?? '', command.limit + 1).map(row => decode<CompanionAgendaGoal>(row)!);
        const goals = items.slice(0, command.limit); return { ok: true, agendaGoals: goals, agendaHasMore: items.length > command.limit, ...(items.length > command.limit ? { agendaNextId: goals.at(-1)?.id } : {}) };
      }
      case 'agenda.tasks.read': {
        const executionState = command.executionStatus === 'all' ? '' : command.executionStatus === 'ended'
          ? "AND a.status IN('succeeded','cancelled')" : "AND a.status IN('queued','running','interrupted','failed')";
        // Existing actions remain the execution authority. This projection
        // neither inserts an agenda rule nor dispatches a second executor.
        const executions = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='actions'").get()
          ? `UNION ALL SELECT 'action_'||a.id AS key,'execution' AS form,a.data FROM actions a
              WHERE a.companion_id=@owner ${executionState}
              AND json_type(a.data,'$.capability') IS NULL AND json_type(a.data,'$.thought') IS NULL` : '';
        const rows = this.db.prepare(`SELECT key,form,data FROM (
          SELECT 'goal_'||id AS key,'longterm' AS form,data FROM companion_agenda_goals WHERE companion_id=@owner
          ${executions}
          UNION ALL SELECT 'rule_'||r.id AS key,'scheduled' AS form,r.data FROM companion_agenda_rules r
            WHERE r.companion_id=@owner AND json_extract(r.data,'$.category')='task'
            AND NOT EXISTS(SELECT 1 FROM companion_agenda_goals g WHERE g.companion_id=r.companion_id AND g.id=json_extract(r.data,'$.goalId'))
          ) WHERE key>@after ORDER BY key LIMIT @limit`).all({ owner: command.companionId, after: command.afterId ?? '', limit: command.limit + 1 }) as Array<{ key: string; form: 'scheduled' | 'longterm' | 'execution'; data: string }>;
        const selected = rows.slice(0, command.limit);
        return { ok: true, agendaTasks: selected.map(row => row.form === 'execution' ? { form: 'execution' as const, execution: companionAgendaExecution(JSON.parse(row.data) as CompanionAction) }
          : row.form === 'scheduled' ? { form: 'scheduled' as const, rule: companionAgendaRuleSchema.parse(JSON.parse(row.data)) }
          : { form: 'longterm' as const, goal: companionAgendaGoalSchema.parse(JSON.parse(row.data)) }), agendaHasMore: rows.length > command.limit,
        ...(rows.length > command.limit ? { agendaNextId: selected.at(-1)?.key } : {}) };
      }
      case 'agenda.goal.read': {
        const goal = this.read<CompanionAgendaGoal>('companion_agenda_goals', command.companionId, command.id);
        if (!goal) throw new Error('长期方向不存在或不属于当前伙伴。'); return { ok: true, agendaGoal: goal };
      }
      case 'agenda.grants.read': return { ok: true, agendaGrants: this.grants(command.companionId) };
      case 'agenda.read': return this.view(command);
      case 'agenda.event.read': {
        const rule = this.read<CompanionAgendaRule>('companion_agenda_rules', command.companionId, command.id);
        if (!rule) throw new Error('日程事件不存在或已不可访问。');
        const occurrences = this.db.prepare('SELECT data FROM companion_agenda_occurrences WHERE companion_id=? AND rule_id=? ORDER BY scheduled_at DESC LIMIT 50').all(command.companionId, command.id).map(row => decode<CompanionAgendaOccurrence>(row)!);
        const runs = this.db.prepare('SELECT data FROM companion_agenda_runs WHERE companion_id=? AND rule_id=? ORDER BY created_at DESC LIMIT 50').all(command.companionId, command.id).map(row => decode<CompanionAgendaRun>(row)!);
        return { ok: true, agendaEvent: { rule, occurrences, runs, steps: runs.flatMap(run => this.steps(command.companionId, run.id)) } };
      }
    }
  }
  private steps(owner: string, runId: string): CompanionAgendaStep[] {
    return this.db.prepare('SELECT data FROM companion_agenda_steps WHERE companion_id=? AND run_id=? ORDER BY id LIMIT 200').all(owner, runId).map(row => decode<CompanionAgendaStep>(row)!);
  }
  private saveGoal(goal: CompanionAgendaGoal): void {
    const value = companionAgendaGoalSchema.parse(goal);
    this.db.prepare('INSERT INTO companion_agenda_goals(id,companion_id,revision,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,data=excluded.data')
      .run(value.id, value.companionId, value.revision, value.status, JSON.stringify(value));
  }
  private saveGrant(grant: CompanionAgendaGrant): void {
    const value = companionAgendaGrantSchema.parse(grant);
    this.db.prepare('INSERT INTO companion_agenda_grants(id,companion_id,revision,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,data=excluded.data')
      .run(value.id, value.companionId, value.revision, value.status, JSON.stringify(value));
  }
  private grants(owner: string): CompanionAgendaGrant[] {
    return this.db.prepare('SELECT data FROM companion_agenda_grants WHERE companion_id=? ORDER BY id LIMIT 100').all(owner).map(row => decode<CompanionAgendaGrant>(row)!);
  }
  private emit(command: Extract<CompanionAgendaCommand, { type: 'agenda.emit' }>): CompanionAgendaResponse {
    const prior = this.db.prepare('SELECT topic,data FROM companion_agenda_emissions WHERE companion_id=? AND event_key=?').get(command.companionId, command.eventKey) as { topic: string; data: string } | undefined;
    if (prior) {
      if (prior.topic !== command.topic || prior.data !== command.input) throw new Error('真实事件标识已用于不同内容。');
      return { ok: true };
    }
    this.db.prepare('INSERT INTO companion_agenda_emissions(companion_id,event_key,topic,at,data) VALUES(?,?,?,?,?)').run(command.companionId, command.eventKey, command.topic, command.at, command.input);
    const rules = this.db.prepare("SELECT data FROM companion_agenda_rules WHERE companion_id=? AND status='active' AND json_extract(data,'$.trigger.kind')='event' AND json_extract(data,'$.trigger.topic')=? ORDER BY id")
      .all(command.companionId, command.topic).map(row => decode<CompanionAgendaRule>(row)!);
    for (const rule of rules) {
      if (rule.trigger.kind !== 'event') continue;
      const existing = rule.overlapPolicy === 'merge' ? decode<CompanionAgendaRun>(this.db.prepare("SELECT data FROM companion_agenda_runs WHERE rule_id=? AND status IN('queued','waiting') ORDER BY created_at,id LIMIT 1").get(rule.id)) : undefined;
      if (existing) {
        existing.notBefore = iso(Date.parse(command.at) + rule.trigger.quietSeconds * 1000); existing.updatedAt = command.at; existing.revision++;
        const occurrence = this.read<CompanionAgendaOccurrence>('companion_agenda_occurrences', command.companionId, existing.occurrenceId)!;
        // The event ledger retains every raw emission. The coalesced summary
        // stays finite; processors use source identities rather than this prose.
        occurrence.input = [occurrence.input, command.input].filter(Boolean).join('\n').slice(-16000); occurrence.reason = '合并了新的同类来源，等待安静窗口';
        this.saveOccurrence(occurrence); this.saveRun(existing); continue;
      }
      const occurrence: CompanionAgendaOccurrence = { id: 'occ_' + sha([rule.id, command.eventKey]).slice(0, 64), companionId: command.companionId,
        ruleId: rule.id, ruleRevision: rule.revision, scheduledAt: command.at, lastEvaluatedAt: command.at, state: 'ready', accumulatedHazard: 0, conditionResults: [],
        reason: '真实事件：' + command.topic, eventKey: command.eventKey, input: command.input };
      // Events sharing an instant still have distinct keys. The indexed SQL
      // key has a stable identity suffix, while serialized scheduledAt retains
      // the exact real instant and never invents a different timestamp.
      this.db.prepare('INSERT OR IGNORE INTO companion_agenda_occurrences(id,companion_id,rule_id,scheduled_at,state,rule_data,data) VALUES(?,?,?,?,?,?,?)')
        .run(occurrence.id, occurrence.companionId, rule.id, command.at + '/' + sha(command.eventKey), occurrence.state, JSON.stringify(rule), JSON.stringify(occurrence));
      const run = this.createRun(occurrence, command.at); run.notBefore = iso(Date.parse(command.at) + rule.trigger.quietSeconds * 1000); this.saveRun(run);
    }
    return { ok: true };
  }
  private settle(command: Extract<CompanionAgendaCommand, { type: 'agenda.run.settle' }>): CompanionAgendaResponse {
    const run = this.liveRun(command.companionId, command.id, command.leaseToken, command.now);
    if (command.result !== undefined) run.result = command.result;
    if (command.error !== undefined) run.error = command.error;
    if (command.nextCondition !== undefined) run.nextCondition = command.nextCondition;
    if (command.outcome === 'failed') {
      run.failureCount++; run.cycleFailureCount++;
      run.notBefore = command.notBefore ?? iso(Date.parse(command.now) + 30000 * run.cycleFailureCount);
      this.stopRun(run, run.cycleFailureCount >= 3 ? 'parked' : 'waiting', command.now, command.stage ?? (run.cycleFailureCount >= 3 ? '反复处理失败，已搁置；原始记录保留' : '处理失败，等待再次尝试'));
    } else {
      run.notBefore = command.notBefore ?? iso(Date.parse(command.now) + (command.outcome === 'waiting' ? 30000 : 0));
      this.stopRun(run, command.outcome, command.now, command.stage ?? command.nextCondition ?? command.outcome);
    }
    return { ok: true, agendaRun: run };
  }
  private controlRun(command: Extract<CompanionAgendaCommand, { type: 'agenda.run.control' }>): CompanionAgendaResponse {
    const run = this.cas(this.read<CompanionAgendaRun>('companion_agenda_runs', command.companionId, command.id), command.expectedRevision);
    const rule = this.sealedRule(run.occurrenceId); if (!rule) throw new Error('日程执行缺少原始规则。');
    // Protection keeps the system duty enabled; it must not prevent the human
    // from managing one retained semantic batch or recovering a held failure.
    if (!rule.protected || command.authority.kind !== 'user') this.mutable(rule, command.authority, true);
    if (terminal.has(run.status)) throw new Error('已结束的执行不能通过普通操作重建。');
    if (run.status === 'unknown') throw new Error('结果待核对，不能盲目重启或丢弃未知作用。');
    const now = iso();
    // An explicit operation on this run supersedes automatic rule/goal holds.
    // Ordinary rule resume must never revive a manually or quality-parked run.
    delete run.pausedByRuleId; delete run.pausedByGoalId;
    if (command.action === 'resume') {
      if (!['parked', 'waiting'].includes(run.status)) throw new Error('只有暂停或等待中的执行可以恢复。');
      run.cycleFailureCount = 0; run.retryCycle++; run.notBefore = now;
    }
    this.stopRun(run, command.action === 'resume' ? 'queued' : command.action === 'pause' ? 'parked' : command.action === 'abandon' ? 'abandoned' : 'cancelled', now,
      command.action === 'resume' ? '已明确恢复，保留成功步骤和累计错误' : command.action === 'pause' ? '已暂停本次执行' : command.action === 'abandon' ? '已明确放弃本次执行，原始依据保留' : '已停止本次执行');
    return { ok: true, agendaRun: run };
  }
  private recordStep(command: Extract<CompanionAgendaCommand, { type: 'agenda.step.record' }>): CompanionAgendaResponse {
    this.liveRun(command.companionId, command.runId, command.leaseToken, command.now);
    const previous = decode<CompanionAgendaStep>(this.db.prepare('SELECT data FROM companion_agenda_steps WHERE companion_id=? AND run_id=? AND effect_key=?').get(command.companionId, command.runId, command.effectKey));
    if (previous?.status === 'succeeded') {
      if (command.status !== 'succeeded' || command.result !== previous.result) throw new Error('已成功步骤的真实回执不可改写或重放。');
      return { ok: true, agendaStep: previous };
    }
    if (!previous && command.status !== 'prepared') throw new Error('新步骤必须先登记准备，不能补造已经派发或成功的作用。');
    const transitions: Record<CompanionAgendaStep['status'], readonly CompanionAgendaStep['status'][]> = { prepared: ['prepared', 'dispatched', 'failed'], dispatched: ['dispatched', 'succeeded', 'failed', 'unknown'], failed: ['failed', 'prepared'], unknown: ['unknown'], succeeded: ['succeeded'] };
    if (previous && !transitions[previous.status].includes(command.status)) throw new Error('步骤状态不能跨过实际派发或未知结果核对。');
    const step: CompanionAgendaStep = { id: previous?.id ?? 'step_' + sha([command.runId, command.effectKey]).slice(0, 64), companionId: command.companionId, runId: command.runId,
      effectKey: command.effectKey, title: command.title, status: command.status, result: command.result, createdAt: previous?.createdAt ?? command.now, updatedAt: command.now };
    this.db.prepare('INSERT INTO companion_agenda_steps(id,companion_id,run_id,effect_key,status,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data')
      .run(step.id, step.companionId, step.runId, step.effectKey, step.status, JSON.stringify(step));
    this.audit(step.companionId, step.id, 'step.' + step.status, step, command.now); return { ok: true, agendaStep: step };
  }
  private view(command: Extract<CompanionAgendaCommand, { type: 'agenda.read' }>): CompanionAgendaResponse {
    const owner = command.companionId;
    const rows = this.db.prepare(`SELECT data FROM companion_agenda_rules WHERE companion_id=? AND id>? ${command.category ? "AND json_extract(data,'$.category')=?" : ''} ORDER BY id LIMIT ?`)
      .all(owner, command.afterId ?? '', ...(command.category ? [command.category] : []), command.limit + 1);
    const rules = rows.slice(0, command.limit).map(row => decode<CompanionAgendaRule>(row)!);
    const occurrences: CompanionAgendaOccurrence[] = [], runs: CompanionAgendaRun[] = [];
    if (rules.length) {
      // One indexed bounded probe per rule/range, one worker statement and one
      // joined result stream. Avoid parsing/transferring full 256KiB checkpoints
      // or issuing a separate run query for every calendar occurrence.
      const args: string[] = [], probes = rules.flatMap(rule => {
        args.push(owner, rule.id, ...(command.from ? [command.from] : []), ...(command.to ? [command.to] : []), owner, rule.id);
        return [`SELECT id FROM (SELECT id FROM companion_agenda_occurrences WHERE companion_id=? AND rule_id=?
          ${command.from ? 'AND scheduled_at>=?' : ''} ${command.to ? 'AND scheduled_at<?' : ''} ORDER BY scheduled_at DESC,id DESC LIMIT 20)`,
        `SELECT occurrence_id AS id FROM (SELECT occurrence_id FROM companion_agenda_runs WHERE companion_id=? AND rule_id=?
          AND status IN('queued','running','waiting','parked','unknown') ORDER BY created_at DESC,id DESC LIMIT 20)`];
      });
      // Runs begun outside the date range remain visible as current activity.
      // UNION de-duplicates them with the ordinary dated history before join.
      const values = this.db.prepare(`WITH selected AS (${probes.join(' UNION ')})
        SELECT json_remove(o.data,'$.input','$.eventKey') AS occurrence_data,
          json_remove(r.data,'$.checkpoint','$.result','$.error','$.leaseToken','$.leaseUntil','$.activeGrantId','$.activeGrantRevision') AS run_data
        FROM selected s JOIN companion_agenda_occurrences o ON o.id=s.id AND o.companion_id=?
        LEFT JOIN companion_agenda_runs r ON r.occurrence_id=o.id AND r.companion_id=o.companion_id
        ORDER BY o.rule_id,o.scheduled_at DESC,o.id DESC`).all(...args, owner) as Array<{ occurrence_data: string; run_data: string | null }>;
      for (const value of values) {
        occurrences.push(JSON.parse(value.occurrence_data) as CompanionAgendaOccurrence);
        if (value.run_data) runs.push(JSON.parse(value.run_data) as CompanionAgendaRun);
      }
    }
    if (command.compactRecurring) {
      const keep = new Set<string>();
      for (const rule of rules) {
        const values = occurrences.filter(value => value.ruleId === rule.id);
        if (rule.trigger.kind === 'at' && rule.trigger.repeat === 'once') for (const value of values) keep.add(value.id);
        else if (values[0]) keep.add(values[0].id);
      }
      for (const run of runs) if (run.status === 'running') keep.add(run.occurrenceId);
      occurrences.splice(0, occurrences.length, ...occurrences.filter(value => keep.has(value.id)));
      runs.splice(0, runs.length, ...runs.filter(value => keep.has(value.occurrenceId)));
    }
    const audit = this.db.prepare('SELECT max(sequence) AS revision FROM companion_agenda_audit WHERE companion_id=?').get(owner) as { revision: number | null };
    const goals = this.db.prepare('SELECT data FROM companion_agenda_goals WHERE companion_id=? ORDER BY id LIMIT 50').all(owner).map(row => decode<CompanionAgendaGoal>(row)!);
    return { ok: true, agenda: { companionId: owner, rules, occurrences, runs, goals, grants: this.grants(owner), hasMore: rows.length > command.limit,
      ...(rows.length > command.limit ? { nextId: rules.at(-1)?.id } : {}), observedAt: iso(), revision: audit.revision ?? 0 } };
  }
}
