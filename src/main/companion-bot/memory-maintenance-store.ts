import { VCP_DREAM_SCHEDULE } from '../../shared/companion-bot-maintenance';
import { createHash } from 'node:crypto';
import type { BotMaintenanceJob, MaintenanceBrief, MaintenanceBriefInput, MemoMasterMode, BotMaintenanceSettings, BotMaintenanceCandidateDetail, BotMaintenanceCandidateSummary, BotMaintenanceStatus, BotMaintenanceCandidateStatus, BotMaintenanceReviewRecord } from '../../shared/companion-bot-maintenance';
import { freezeMaintenanceBrief } from './memory-maintenance-brief';
import type { BotMemoryScope } from './memory-service';
import type { BotMemoryMaintenancePlan, BotMemoryMaintenanceSnapshot } from './memory-maintenance';
import type { BotStore, BotTaskSql } from './store';

type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
export const maintenanceOwner = (scope: BotMemoryScope) => hash([scope.companionId, scope.securityDomainId, scope.conversationId]);
export const maintenanceDomain = (scope: BotMemoryScope) => hash([scope.companionId, scope.securityDomainId]);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const optional = (value: unknown) => value == null ? undefined : String(value);
function inDreamWindow(date: Date, start: number = VCP_DREAM_SCHEDULE.windowStart, end: number = VCP_DREAM_SCHEDULE.windowEnd) {
  const hour = date.getHours();
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}
const terminal = new Set<BotMaintenanceStatus>(['completed', 'cancelled', 'failed', 'blocked']);
const runningDream = `SELECT 1 FROM bot_memory_jobs m JOIN bot_maintenance_jobs j ON j.id=json_extract(m.payload_json,'$.jobId')
  WHERE m.kind='maintenance' AND m.status='running' AND m.lease_until>? AND json_extract(m.payload_json,'$.operation')='plan'
  AND j.automatic=1 AND (j.kind='dream' OR j.trigger_kind='idle') AND j.status='running' AND j.plan_json IS NULL LIMIT 1`;
const companionDreamPending = `SELECT 1 FROM bot_maintenance_jobs WHERE json_extract(scope_json,'$.companionId')=?
  AND automatic=1 AND (kind='dream' OR trigger_kind='idle') AND plan_json IS NULL AND status IN('queued','running') LIMIT 1`;
export interface MaintenanceRecord { job: BotMaintenanceJob; scope: BotMemoryScope; snapshot?: BotMemoryMaintenanceSnapshot; plan?: BotMemoryMaintenancePlan; epoch: number; cursor?: string }

/** Operational review journal only. Source notes remain in VCP; proposals and
 * diagnostic text are never indexed as companion memory. */
export class BotMaintenanceStore {
  private lastReviewOwner = '';
  constructor(readonly store: BotStore) {
    store.taskTransaction(sql => { for (const statement of [
      `CREATE TABLE IF NOT EXISTS bot_maintenance_dream_clock(companion_id TEXT PRIMARY KEY,success_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_settings(owner_key TEXT PRIMARY KEY,domain_key TEXT NOT NULL,scope_json TEXT NOT NULL,settings_json TEXT NOT NULL,next_due INTEGER NOT NULL,last_activity INTEGER NOT NULL,dirty INTEGER NOT NULL DEFAULT 0,planned INTEGER NOT NULL DEFAULT 0)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_dream_selection ON bot_maintenance_settings(json_extract(scope_json,'$.companionId'),last_activity DESC,owner_key DESC) WHERE json_extract(settings_json,'$.enabled')=1`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_review_enabled ON bot_maintenance_settings(owner_key) WHERE json_extract(settings_json,'$.autoReview')=1`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_jobs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_key TEXT NOT NULL,domain_key TEXT NOT NULL,scope_json TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,automatic INTEGER NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,source_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,error TEXT,snapshot_json TEXT,plan_json TEXT,metrics_json TEXT NOT NULL,narrative TEXT,next_cursor TEXT)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_jobs_owner ON bot_maintenance_jobs(owner_key,sequence DESC)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_jobs_domain ON bot_maintenance_jobs(domain_key,status)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_active_dream ON bot_maintenance_jobs(sequence) WHERE automatic=1 AND kind='dream' AND status IN('queued','running')`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_candidates(job_id TEXT NOT NULL REFERENCES bot_maintenance_jobs(id),id TEXT NOT NULL,position INTEGER NOT NULL,status TEXT NOT NULL,revision TEXT NOT NULL,candidate_json TEXT NOT NULL,receipt_json TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(job_id,id))`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_pending_review ON bot_maintenance_candidates(job_id,position) WHERE status='pending'`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_queued_review ON bot_memory_jobs(json_extract(payload_json,'$.jobId'),json_extract(payload_json,'$.candidateId')) WHERE kind='maintenance' AND status IN('queued','running') AND json_extract(payload_json,'$.operation')='review'`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_diagnostics(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES bot_maintenance_jobs(id),phase TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_diagnostics_job ON bot_maintenance_diagnostics(job_id,sequence)`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_requests(owner_key TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(owner_key,request_id))`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_tool_receipts(owner_key TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(owner_key,request_id))`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_maturity(owner_key TEXT NOT NULL,due_at INTEGER NOT NULL,ready_at INTEGER NOT NULL,PRIMARY KEY(owner_key,due_at))`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_maturity_ready ON bot_maintenance_maturity(ready_at,owner_key)`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_changes(owner_key TEXT NOT NULL,change_id TEXT NOT NULL,PRIMARY KEY(owner_key,change_id))`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_reviews(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,job_id TEXT NOT NULL,candidate_id TEXT NOT NULL,revision TEXT NOT NULL,actor TEXT NOT NULL,record_json TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_reviews_candidate ON bot_maintenance_reviews(job_id,candidate_id,sequence DESC)`,
    ]) sql.prepare(statement).run();
      const settingsColumns = sql.prepare('PRAGMA table_info(bot_maintenance_settings)').all().map(value => row(value).name);
      if (!settingsColumns.includes('dream_planned')) sql.prepare('ALTER TABLE bot_maintenance_settings ADD COLUMN dream_planned INTEGER NOT NULL DEFAULT -1').run();
      if (!settingsColumns.includes('dream_ready_at')) sql.prepare('ALTER TABLE bot_maintenance_settings ADD COLUMN dream_ready_at INTEGER NOT NULL DEFAULT 0').run();
      if (!settingsColumns.includes('idle_organize_version')) sql.prepare('ALTER TABLE bot_maintenance_settings ADD COLUMN idle_organize_version INTEGER NOT NULL DEFAULT 0').run();
      const jobColumns = sql.prepare('PRAGMA table_info(bot_maintenance_jobs)').all().map(value => row(value).name);
      if (!jobColumns.includes('trigger_kind')) sql.prepare('ALTER TABLE bot_maintenance_jobs ADD COLUMN trigger_kind TEXT').run();
      if (!jobColumns.includes('memo_mode')) sql.prepare('ALTER TABLE bot_maintenance_jobs ADD COLUMN memo_mode TEXT').run();
      if (!jobColumns.includes('survey_json')) sql.prepare('ALTER TABLE bot_maintenance_jobs ADD COLUMN survey_json TEXT').run();
      if (!jobColumns.includes('brief_json')) sql.prepare('ALTER TABLE bot_maintenance_jobs ADD COLUMN brief_json TEXT').run();
      sql.prepare(`CREATE INDEX IF NOT EXISTS bot_maintenance_idle_pending ON bot_maintenance_settings(dream_ready_at,owner_key)
        WHERE dirty>0 AND dirty>dream_planned AND json_extract(settings_json,'$.enabled')=1`).run();
      sql.prepare(`CREATE INDEX IF NOT EXISTS bot_maintenance_saved_dream ON bot_maintenance_jobs(owner_key,source_version DESC)
        WHERE automatic=1 AND kind='dream' AND plan_json IS NOT NULL`).run();
      sql.prepare(`CREATE INDEX IF NOT EXISTS bot_maintenance_auto_companion ON bot_maintenance_jobs(json_extract(scope_json,'$.companionId'))
        WHERE automatic=1 AND (kind='dream' OR trigger_kind='idle') AND plan_json IS NULL AND status IN('queued','running')`).run();
      sql.prepare(`CREATE INDEX IF NOT EXISTS bot_maintenance_running_plan ON bot_memory_jobs(lease_until,json_extract(payload_json,'$.jobId'))
        WHERE kind='maintenance' AND status='running' AND json_extract(payload_json,'$.operation')='plan'`).run();
      this.retirePreviousPlanner(sql);
    });
  }
  private retirePreviousPlanner(sql: BotTaskSql): void {
    const marker = 'maintenance-native-submission-v2';
    if (sql.prepare('SELECT 1 FROM bot_metadata WHERE key=?').get(marker)) return;
    // A previously frozen DSH turn can already contain the old planning role,
    // including when its vector retrieval used the current native engine.
    const previous = sql.prepare(`WITH frozen AS (
      SELECT id FROM bot_maintenance_jobs WHERE
        (snapshot_json IS NOT NULL AND CASE WHEN json_valid(snapshot_json) THEN json_extract(snapshot_json,'$.format') END IS NOT 'worldlinebox-memory-maintenance-snapshot-v2')
        OR (plan_json IS NOT NULL AND CASE WHEN json_valid(plan_json) THEN json_extract(plan_json,'$.format') END IS NOT 'worldlinebox-memory-maintenance-v2')
    ) SELECT id,domain_key,owner_key,kind,status,automatic,source_version FROM bot_maintenance_jobs j WHERE phase<>'source_withdrawn'
      AND (id IN frozen OR json_extract(survey_json,'$.rootId') IN frozen)`).all().map(row);
    const reason = '旧版维护方案已停止。可基于当前日记创建新的任务。';
    const now = stamp();
    const dreamOwners = new Map<string, number>();
    for (const job of previous) {
      if (job.automatic && job.kind === 'dream') {
        const owner = String(job.owner_key);
        const pending = job.status === 'completed' || job.status === 'cancelled' ? -1 : Number(job.source_version);
        dreamOwners.set(owner, Math.max(dreamOwners.get(owner) ?? -1, pending));
      }
      sql.prepare(`UPDATE bot_maintenance_jobs SET phase='planner_retired',status=CASE WHEN status='completed' THEN status ELSE 'cancelled' END,
        next_cursor=NULL,error=?,finished_at=COALESCE(finished_at,?),updated_at=? WHERE id=?`).run(reason, now, now, job.id);
      sql.prepare(`UPDATE bot_memory_jobs SET status='done',error=?,lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE kind='maintenance' AND status IN ('queued','running') AND json_extract(payload_json,'$.jobId')=?`).run(reason, now, job.id);
      if (job.kind === 'organize' && job.status !== 'completed') {
        const key = `maintenance-work-release:${job.domain_key}:${job.id}`;
        sql.prepare('INSERT OR REPLACE INTO bot_metadata(key,value) VALUES(?,?)').run(key, JSON.stringify({ jobId: job.id, kind: job.kind, retired: true, reason }));
      }
    }
    // Saving the old dream had advanced its watermark before the proposals
    // were reviewed. Reopen only that scope/version unless a completed dream
    // (or a separately frozen current plan) already covers it.
    for (const [owner, pending] of dreamOwners) {
      const covered = row(sql.prepare(`SELECT MAX(source_version) AS version FROM bot_maintenance_jobs
        WHERE owner_key=? AND kind='dream' AND automatic=1 AND plan_json IS NOT NULL
          AND (status='completed' OR (phase<>'planner_retired' AND status<>'cancelled'))
          AND EXISTS(SELECT 1 FROM json_each(plan_json,'$.sources') s WHERE json_extract(s.value,'$.role')='seed')`).get(owner)).version;
      if (covered !== null) sql.prepare('UPDATE bot_maintenance_settings SET dream_planned=? WHERE owner_key=? AND dream_planned<0').run(covered, owner);
      if (pending < 0 || (covered !== null && Number(covered) >= pending)) continue;
      sql.prepare(`UPDATE bot_maintenance_settings SET dream_planned=MAX(0,dirty-1),dirty=MAX(1,dirty),
        idle_organize_version=CASE WHEN idle_organize_version<=? THEN 0 ELSE idle_organize_version END
        WHERE owner_key=? AND dirty<=? AND (dream_planned<0 OR dream_planned>=dirty)`).run(pending, owner, pending);
    }
    sql.prepare('INSERT INTO bot_metadata(key,value) VALUES(?,?)').run(marker, now);
  }
  private ensureCurrent(job: BotMaintenanceJob): void {
    if (job.phase === 'planner_retired') throw new Error('旧版维护方案已停止，请基于当前日记创建新的任务。');
  }
  assertScope(scope: BotMemoryScope): void {
    const room = this.store.getConversation(scope.conversationId);
    if (!room || room.securityDomainId !== scope.securityDomainId || !room.memberIds.includes(scope.companionId)) throw new Error('维护记录不属于当前伙伴受众。');
  }
  settings(scope: BotMemoryScope, now = Date.now()): BotMaintenanceSettings {
    this.assertScope(scope);
    return this.store.taskTransaction(sql => {
      const owner = maintenanceOwner(scope), found = sql.prepare('SELECT settings_json FROM bot_maintenance_settings WHERE owner_key=?').get(owner);
      const clock = Number(this.store.getMetadata('vcp-dream-next-check'));
      const nextDue = clock || now + VCP_DREAM_SCHEDULE.checkMinutes * 60000;
      if (!clock) this.store.setMetadata('vcp-dream-next-check', String(nextDue));
      const nextEligibleAt = new Date(nextDue).toISOString();
      if (found) return { ...parse<BotMaintenanceSettings>(row(found).settings_json), nextEligibleAt };
      const settings: BotMaintenanceSettings = { enabled: true, autoReview: true, nextEligibleAt, lastActivityAt: new Date(now).toISOString() };
      sql.prepare('INSERT INTO bot_maintenance_settings(owner_key,domain_key,scope_json,settings_json,next_due,last_activity,dream_planned) VALUES(?,?,?,?,?,?,0)').run(owner, maintenanceDomain(scope), JSON.stringify(scope), JSON.stringify(settings), nextDue, now);
      return settings;
    });
  }
  hasSettings(scope: BotMemoryScope): boolean {
    return this.store.taskTransaction(sql => !!sql.prepare('SELECT 1 FROM bot_maintenance_settings WHERE owner_key=?').get(maintenanceOwner(scope)));
  }
  updateSettings(scope: BotMemoryScope, patch: Partial<Pick<BotMaintenanceSettings, 'enabled' | 'autoReview'>>): BotMaintenanceSettings {
    const current = this.settings(scope), settings = { ...current, ...patch };
    this.store.taskTransaction(sql => sql.prepare('UPDATE bot_maintenance_settings SET settings_json=? WHERE owner_key=?').run(JSON.stringify(settings), maintenanceOwner(scope)));
    return settings;
  }
  activity(scope: BotMemoryScope, changeId?: string, options?: { preserveIdle?: boolean }): void {
    const current = this.settings(scope), now = Date.now();
    this.store.taskTransaction(sql => {
      let increment = 0;
      if (changeId) increment = sql.prepare('INSERT OR IGNORE INTO bot_maintenance_changes VALUES(?,?)').run(maintenanceOwner(scope), changeId).changes;
      if (increment) this.scheduleMaturity(scope, now + 30 * 86400000);
      const lastActivityAt = options?.preserveIdle ? current.lastActivityAt : new Date(now).toISOString();
      sql.prepare(`UPDATE bot_maintenance_settings SET last_activity=?,settings_json=?,dirty=dirty+?,
        dream_ready_at=CASE WHEN ?>0 AND dirty<=MAX(0,dream_planned) THEN ? ELSE dream_ready_at END WHERE owner_key=?`)
        .run(Date.parse(lastActivityAt), JSON.stringify({ ...current, lastActivityAt }), increment, increment, now, maintenanceOwner(scope));
    });
  }
  scheduleMaturity(scope: BotMemoryScope, dueAt: number): void {
    if (!Number.isFinite(dueAt)) return;
    // Coalesce writes made during the same hour. Always run after the last
    // possible maturation in that hour, including after a long offline period.
    const due = Math.ceil(dueAt / 3600000) * 3600000;
    this.store.taskTransaction(sql => sql.prepare('INSERT OR IGNORE INTO bot_maintenance_maturity(owner_key,due_at,ready_at) VALUES(?,?,?)').run(maintenanceOwner(scope), due, due));
  }
  private scheduleMatureOrganization(sql: BotTaskSql, now: number, isIdle: (id: string) => boolean): BotMemoryScope | undefined {
    const due = sql.prepare(`SELECT m.owner_key,m.due_at,s.scope_json FROM bot_maintenance_maturity m
      JOIN bot_maintenance_settings s ON s.owner_key=m.owner_key WHERE m.ready_at<=? AND json_extract(s.settings_json,'$.enabled')=1
      ORDER BY m.ready_at,m.owner_key LIMIT 8`).all(now).map(row);
    for (const item of due) {
      const scope = parse<BotMemoryScope>(item.scope_json), room = this.store.getConversation(scope.conversationId);
      if (!room || room.securityDomainId !== scope.securityDomainId || !room.memberIds.includes(scope.companionId) || this.store.getMetadata('conversation-dissolved:' + scope.conversationId)) {
        sql.prepare('DELETE FROM bot_maintenance_maturity WHERE owner_key=?').run(item.owner_key); continue;
      }
      sql.prepare('UPDATE bot_maintenance_maturity SET ready_at=? WHERE owner_key=? AND due_at<=?').run(now + 60000, item.owner_key, now);
      if (!isIdle(scope.companionId) || this.store.getMetadata('companion-enabled:' + scope.companionId) === '0' || sql.prepare(companionDreamPending).get(scope.companionId)) continue;
      const job = this.enqueue(scope, 'organize', 'mature-diaries:' + now, true, undefined, 'idle');
      this.store.setMetadata('maintenance-maturity:' + job.id, String(now));
      this.diagnostic(scope, job.id, 'scheduled', { trigger: 'idle', reason: 'diary-maturity', through: new Date(now).toISOString() });
      return scope;
    }
  }
  recordForeground(companionId: string, now = Date.now()): void {
    this.store.taskTransaction(sql => sql.prepare(`INSERT INTO bot_metadata(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<CAST(excluded.value AS INTEGER)`).run('vcp-dream-foreground:' + companionId, String(now)));
  }
  lastForegroundAt(companionId: string): number {
    return Number(this.store.getMetadata('vcp-dream-foreground:' + companionId) || 0);
  }
  /** Daytime catch-up coalesces all outstanding versions per audience. Move
   * temporarily ineligible owners behind the other due owners in the index. */
  async scheduleIdleDream({ now = Date.now(), isIdle, onScheduled, stopped }: {
    now?: number; isIdle: (companionId: string) => boolean; onScheduled: (scope: BotMemoryScope) => void; stopped?: () => boolean;
  }): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (stopped?.()) return;
    const scheduled = this.store.taskTransaction(sql => {
      if (sql.prepare(runningDream).get(now)) return;
      if (Number(this.store.getMetadata('vcp-dream-last-attempt') || 0) + VCP_DREAM_SCHEDULE.agentGapSeconds * 1000 > now) return;
      const mature = this.scheduleMatureOrganization(sql, now, isIdle);
      if (mature || inDreamWindow(new Date(now))) return mature;
      const due = sql.prepare(`SELECT owner_key,scope_json,dirty,dream_planned,idle_organize_version FROM bot_maintenance_settings
        WHERE dirty>0 AND dirty>dream_planned AND json_extract(settings_json,'$.enabled')=1 AND dream_ready_at<=?
        ORDER BY dream_ready_at,owner_key LIMIT 8`).all(now).map(row);
      const postpone = sql.prepare('UPDATE bot_maintenance_settings SET dream_ready_at=? WHERE owner_key=?');
      for (const candidate of due) {
        const owner = String(candidate.owner_key), scope = parse<BotMemoryScope>(candidate.scope_json);
        if (Number(candidate.dream_planned) < 0) {
          // Older builds shared 'planned' with manual organization. Only a
          // successfully stored automatic dream covers this owner's versions.
          const last = sql.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(plan_json,'$.sources') s
            WHERE json_extract(s.value,'$.role')='seed') THEN source_version ELSE 0 END AS source_version
            FROM bot_maintenance_jobs WHERE owner_key=? AND automatic=1
            AND kind='dream' AND phase<>'planner_retired' AND plan_json IS NOT NULL ORDER BY source_version DESC LIMIT 1`).get(owner);
          const previous = last ? Number(row(last).source_version) : 0;
          sql.prepare('UPDATE bot_maintenance_settings SET dream_planned=? WHERE owner_key=?').run(previous, owner);
          if (previous >= Number(candidate.dirty)) continue;
        }
        const valid = sql.prepare(`SELECT 1 FROM bot_members m JOIN bot_conversations c ON c.id=m.conversation_id
          JOIN bot_companions a ON a.id=m.member_id WHERE m.member_id=? AND m.conversation_id=? AND c.domain_id=?`)
          .get(scope.companionId, scope.conversationId, scope.securityDomainId);
        const cooldown = this.cooldownRemaining(scope, now);
        if (!valid || this.store.getMetadata('conversation-dissolved:' + scope.conversationId)
          || this.store.getMetadata('companion-enabled:' + scope.companionId) === '0' || cooldown
          || sql.prepare(companionDreamPending).get(scope.companionId) || !isIdle(scope.companionId)) {
          postpone.run(now + Math.max(60000, cooldown), owner);
          continue;
        }
        // A failed/cancelled attempt retains the version but yields the next
        // check to older outstanding owners, including after app restart.
        postpone.run(now + VCP_DREAM_SCHEDULE.checkMinutes * 60000, owner);
        const remaining = Number(candidate.idle_organize_version), organizing = remaining > Math.max(0, Number(candidate.dream_planned));
        const job = organizing ? this.enqueue(scope, 'organize', 'idle-organization:' + now, true, undefined, 'idle', remaining)
          : this.enqueue(scope, 'dream', 'idle-dream:' + now, true, undefined, 'idle');
        this.diagnostic(scope, job.id, 'scheduled', { trigger: 'idle', sourceVersion: candidate.dirty, checkedAt: new Date(now).toISOString() });
        return scope;
      }
    });
    if (scheduled) onScheduled(scheduled);
  }
  /** All audience scopes share one clock and one probability roll per companion.
   * The most recently active enabled audience supplies that companion's diary. */
  async scheduleDreams({ now = Date.now(), random = Math.random, onScheduled, stopped }: {
    now?: number; random?: () => number; onScheduled: (scope: BotMemoryScope) => void; stopped?: () => boolean;
  }): Promise<void> {
    const lastId = this.store.taskTransaction(sql => {
      const nextCheck = Number(this.store.getMetadata('vcp-dream-next-check'));
      if (now < nextCheck) return;
      this.store.setMetadata('vcp-dream-next-check', String(now + VCP_DREAM_SCHEDULE.checkMinutes * 60000));
      if (!nextCheck || !inDreamWindow(new Date(now))) return;
      if (sql.prepare(runningDream).get(now)) return;
      const last = sql.prepare('SELECT id FROM bot_companions ORDER BY id DESC LIMIT 1').get();
      return last ? String(row(last).id) : undefined;
    });
    if (!lastId) return;
    let cursor = '';
    let afterAudience: { companion: string; activity: number; owner: string } | undefined;
    while (cursor !== lastId) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (stopped?.()) return;
      const scheduled: BotMemoryScope[] = [];
      this.store.taskTransaction(sql => {
        const companions = sql.prepare('SELECT id FROM bot_companions WHERE id>? AND id<=? ORDER BY id LIMIT 16').all(cursor, lastId);
        if (!companions.length) { cursor = lastId; return; }
        const audience = sql.prepare(`SELECT s.scope_json,s.last_activity,s.owner_key,c.id AS room FROM bot_maintenance_settings s
          LEFT JOIN bot_members m ON m.conversation_id=json_extract(s.scope_json,'$.conversationId') AND m.member_id=json_extract(s.scope_json,'$.companionId')
          LEFT JOIN bot_conversations c ON c.id=m.conversation_id AND c.domain_id=json_extract(s.scope_json,'$.securityDomainId')
            AND NOT EXISTS(SELECT 1 FROM bot_metadata d WHERE d.key='conversation-dissolved:'||c.id AND d.value<>'')
          WHERE json_extract(s.scope_json,'$.companionId')=? AND json_extract(s.settings_json,'$.enabled')=1
          AND (s.last_activity,s.owner_key)<(?,?) ORDER BY s.last_activity DESC,s.owner_key DESC LIMIT 16`);
        const started = performance.now();
        for (const item of companions) {
          const companion = String(row(item).id), previous = afterAudience?.companion === companion ? afterAudience : undefined;
          const items = audience.all(companion, previous?.activity ?? Number.MAX_SAFE_INTEGER, previous?.owner ?? '').map(row);
          const found = items.find(item => item.room);
          if (!found && items.length === 16) {
            // A companion can retain many departed group audiences. Cap this
            // lookup as well, then resume from the last indexed timestamp/key.
            const last = items[items.length - 1]!;
            afterAudience = { companion, activity: Number(last.last_activity), owner: String(last.owner_key) };
            break;
          }
          afterAudience = undefined;
          cursor = companion;
          if (found && this.store.getMetadata('companion-enabled:' + cursor) !== '0') {
            const scope = parse<BotMemoryScope>(found.scope_json);
            if (!this.cooldownRemaining(scope, now) && !sql.prepare(companionDreamPending).get(scope.companionId) && random() < VCP_DREAM_SCHEDULE.probability) {
              const job = this.enqueue(scope, 'dream', 'scheduled-dream:' + now, true);
              this.diagnostic(scope, job.id, 'scheduled', { ...VCP_DREAM_SCHEDULE, checkedAt: new Date(now).toISOString() });
              scheduled.push(scope);
            }
          }
          if (performance.now() - started >= 4) break;
        }
      });
      scheduled.forEach(onScheduled);
    }
  }
  private cooldownRemaining(scope: BotMemoryScope, now: number): number {
    return this.store.taskTransaction(sql => {
      const success = sql.prepare('SELECT success_at FROM bot_maintenance_dream_clock WHERE companion_id=?').get(scope.companionId);
      return success ? Math.max(0, Number(row(success).success_at) + VCP_DREAM_SCHEDULE.frequencyHours * 3600000 - now) : 0;
    });
  }
  dreamExecutionDelay(scope: BotMemoryScope, now = Date.now(), { allowDaytime = false, trigger = 'night' }: { allowDaytime?: boolean; trigger?: 'night' | 'idle' } = {}): number {
    const last = Number(this.store.getMetadata('vcp-dream-last-attempt') || 0);
    const waiting = !allowDaytime && (trigger === 'idle' || !inDreamWindow(new Date(now)));
    return Math.max(this.cooldownRemaining(scope, now), last + VCP_DREAM_SCHEDULE.agentGapSeconds * 1000 - now, waiting ? 60000 : 0);
  }
  recordDreamAttemptFinished(now = Date.now()): void {
    this.store.setMetadata('vcp-dream-last-attempt', String(now));
  }
  recordDreamSuccess(scope: BotMemoryScope, now = Date.now()): void {
    this.store.taskTransaction(sql => {
      this.recordDreamAttemptFinished(now);
      sql.prepare('INSERT INTO bot_maintenance_dream_clock(companion_id,success_at) VALUES(?,?) ON CONFLICT(companion_id) DO UPDATE SET success_at=MAX(success_at,excluded.success_at)').run(scope.companionId, now);
      sql.prepare("UPDATE bot_maintenance_settings SET settings_json=json_set(settings_json,'$.lastRunAt',?) WHERE owner_key=?").run(new Date(now).toISOString(), maintenanceOwner(scope));
    });
  }
  enqueue(scope: BotMemoryScope, kind: 'organize' | 'dream', requestId: string, automatic = false, cursor?: string, trigger: 'night' | 'idle' = 'night', capturedVersion?: number, mode?: MemoMasterMode, survey?: BotMaintenanceJob['survey'], brief?: MaintenanceBriefInput, requestedBy: MaintenanceBrief['requestedBy'] = 'user'): BotMaintenanceJob {
    if ((mode || brief) && kind !== 'organize') throw new Error('MemoMaster 模式仅可用于日记维护。');
    this.settings(scope);
    return this.store.taskTransaction(sql => {
      this.command(sql, scope, requestId, ['run', kind, automatic, cursor, ...(mode && mode !== 'organize' ? [mode, survey] : []), ...(brief ? [brief, requestedBy] : [])]);
      const id = `maintenance-${hash([maintenanceOwner(scope), requestId])}`, existing = sql.prepare('SELECT id FROM bot_maintenance_jobs WHERE id=?').get(id);
      if (existing) return this.get(scope, id).job;
      const at = stamp(), version = capturedVersion ?? row(sql.prepare('SELECT dirty FROM bot_maintenance_settings WHERE owner_key=?').get(maintenanceOwner(scope))).dirty;
      sql.prepare(`INSERT INTO bot_maintenance_jobs(id,owner_key,domain_key,scope_json,kind,status,phase,automatic,source_version,created_at,updated_at,metrics_json,trigger_kind) VALUES(?,?,?,?,?,'queued','queued',?,?,?,?,?,?)`)
        .run(id, maintenanceOwner(scope), maintenanceDomain(scope), JSON.stringify(scope), kind, automatic ? 1 : 0, version, at, at, JSON.stringify({ examined: 0, selected: 0, deferred: 0, candidates: 0, applied: 0, rejected: 0 }), automatic ? trigger : null);
      const isSurvey = !!brief || mode && mode !== 'organize';
      if (mode || brief) sql.prepare('UPDATE bot_maintenance_jobs SET memo_mode=?,survey_json=?,brief_json=? WHERE id=?').run(mode ?? 'organize',
        isSurvey ? JSON.stringify(survey ?? { rootId: id, page: 1 }) : null, brief ? JSON.stringify(freezeMaintenanceBrief(brief, requestedBy)) : null, id);
      const next = isSurvey ? cursor : undefined;
      this.store.setMetadata(`maintenance-input:${id}`, JSON.stringify({ cursor: next || undefined }));
      this.queue(scope, id, 'plan', requestId);
      return this.get(scope, id).job;
    });
  }
  planTool(scope: BotMemoryScope, kind: 'organize' | 'dream', requestId: string, mode?: MemoMasterMode, brief?: MaintenanceBriefInput): unknown {
    this.assertScope(scope);
    if ((mode || brief) && kind !== 'organize') throw new Error('MemoMaster 模式仅可用于日记维护。');
    return this.store.taskTransaction(sql => {
      const previous = this.toolReceipt(scope, kind, requestId, mode, brief); if (previous.found) return previous.result;
      const requested = brief ? freezeMaintenanceBrief(brief, 'companion') : undefined;
      const existing = this.list(scope).items.find(job => ['queued', 'running', 'applying'].includes(job.status)
        && (!mode && !brief || job.kind === kind && (job.mode ?? 'organize') === (mode ?? 'organize'))
        && (requested ? job.brief?.topic === requested.topic && job.brief?.period === requested.period && job.brief?.fromDate === requested.fromDate && job.brief?.toDate === requested.toDate : !job.brief));
      const result = mode === 'deepclean' ? { accepted: false, approvalRequired: true, mode, ...(requested && { brief: requested }), reason: '深度清理由用户在当前会话的记忆工作台明确发起。' }
        : existing ? { accepted: false, job: existing, reason: '当前受众已有未完成维护，请先查看进展或审阅候选。' }
        : { accepted: true, job: this.enqueue(scope, kind, requestId, false, undefined, undefined, undefined, mode, undefined, brief, 'companion') };
      sql.prepare('INSERT INTO bot_maintenance_tool_receipts VALUES(?,?,?,?)').run(maintenanceOwner(scope), requestId, hash(['plan', kind, ...(mode && mode !== 'organize' ? [mode] : []), ...(brief ? [brief] : [])]), JSON.stringify(result));
      return result;
    });
  }
  toolReceipt(scope: BotMemoryScope, kind: 'organize' | 'dream', requestId: string, mode?: MemoMasterMode, brief?: MaintenanceBriefInput): { found: boolean; result?: unknown } {
    this.assertScope(scope);
    return this.store.taskTransaction(sql => {
      const value = sql.prepare('SELECT fingerprint,result_json FROM bot_maintenance_tool_receipts WHERE owner_key=? AND request_id=?').get(maintenanceOwner(scope), requestId);
      if (!value) return { found: false };
      const r = row(value); if (r.fingerprint !== hash(['plan', kind, ...(mode && mode !== 'organize' ? [mode] : []), ...(brief ? [brief] : [])])) throw new Error('维护工具回执参数不匹配。');
      return { found: true, result: parse(r.result_json) };
    });
  }
  private command(sql: BotTaskSql, scope: BotMemoryScope, requestId: string, payload: unknown): void {
    const fingerprint = hash(payload), previous = sql.prepare('SELECT fingerprint FROM bot_maintenance_requests WHERE owner_key=? AND request_id=?').get(maintenanceOwner(scope), requestId);
    if (previous && row(previous).fingerprint !== fingerprint) throw new Error('维护请求标识已用于其他参数。');
    sql.prepare('INSERT OR IGNORE INTO bot_maintenance_requests VALUES(?,?,?)').run(maintenanceOwner(scope), requestId, fingerprint);
  }
  private queue(scope: BotMemoryScope, jobId: string, operation: 'plan' | 'apply' | 'review' | 'reconcile', key: string, candidateId?: string, approval: 'review' | 'model' = 'review'): void {
    this.store.enqueueMemoryJob({ kind: 'maintenance', key: `${jobId}:${operation}:${key}`, payload: { scope, jobId, operation, ...(candidateId ? { candidateId, approval } : {}) } });
  }
  get(scope: BotMemoryScope, id: string): MaintenanceRecord {
    this.assertScope(scope);
    return this.store.taskTransaction(sql => {
      const value = sql.prepare('SELECT * FROM bot_maintenance_jobs WHERE id=? AND owner_key=?').get(id, maintenanceOwner(scope));
      if (!value) throw new Error('当前受众中没有这项维护任务。');
      const r = row(value);
      return { job: this.summary(r), scope: parse<BotMemoryScope>(r.scope_json), epoch: Number(r.epoch),
        cursor: parse<{ cursor?: string }>(this.store.getMetadata(`maintenance-input:${id}`) ?? '{}').cursor,
        snapshot: r.snapshot_json ? parse<BotMemoryMaintenanceSnapshot>(r.snapshot_json) : undefined, plan: r.plan_json ? parse<BotMemoryMaintenancePlan>(r.plan_json) : undefined };
    });
  }
  private summary(r: Row): BotMaintenanceJob {
    const survey = r.survey_json ? parse<NonNullable<BotMaintenanceJob['survey']>>(r.survey_json) : undefined;
    if (survey) {
      const progress = this.store.getMetadata('maintenance-survey-progress:' + survey.rootId);
      if (progress) survey.progress = parse(progress);
    }
    return { id: String(r.id), kind: String(r.kind) as BotMaintenanceJob['kind'], status: String(r.status) as BotMaintenanceStatus, phase: String(r.phase), automatic: !!r.automatic,
      ...(r.memo_mode ? { mode: r.memo_mode as MemoMasterMode } : {}), ...(survey && { survey }),
      ...(r.brief_json ? { brief: parse<MaintenanceBrief>(r.brief_json) } : {}),
      ...(r.automatic && (r.kind === 'dream' || r.trigger_kind === 'idle') ? { trigger: r.trigger_kind === 'idle' ? 'idle' : 'night' } : {}),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at), startedAt: optional(r.started_at), finishedAt: optional(r.finished_at),
      elapsedMs: r.started_at ? Math.max(0, Date.parse(String(r.finished_at ?? stamp())) - Date.parse(String(r.started_at))) : 0,
      attempts: Number(r.attempts), error: optional(r.error), metrics: parse(r.metrics_json), narrative: optional(r.narrative), nextCursor: optional(r.next_cursor), autoReview: this.automaticReviewProgress(r) };
  }
  private automaticReviewProgress(job: Row): BotMaintenanceJob['autoReview'] {
    return this.store.taskTransaction(sql => {
      if (job.kind === 'dream' || job.memo_mode && job.memo_mode !== 'organize' || job.status === 'cancelled' || job.phase === 'source_withdrawn') return;
      const setting = sql.prepare("SELECT 1 FROM bot_maintenance_settings WHERE owner_key=? AND json_extract(settings_json,'$.autoReview')=1").get(job.owner_key);
      if (!setting) return;
      const cycle = Number(this.store.getMetadata(`maintenance-review-cycle:${job.owner_key}`) || '0');
      const candidates = sql.prepare('SELECT id,status,position,revision FROM bot_maintenance_candidates WHERE job_id=? ORDER BY position').all(job.id).map(row);
      if (!candidates.length) return;
      const reviews = sql.prepare("SELECT candidate_id,revision,json_extract(record_json,'$.decision') AS decision FROM bot_maintenance_reviews WHERE job_id=? AND actor='model' AND COALESCE(json_extract(record_json,'$.cycle'),0)=? AND json_extract(record_json,'$.decision')<>'retry'").all(job.id, cycle).map(row);
      const reviewed = candidates.filter(candidate => reviews.some(review => review.candidate_id === candidate.id && review.revision === candidate.revision)).length;
      const manual = candidates.filter(candidate => candidate.status === 'pending' && reviews.some(review => review.candidate_id === candidate.id && review.revision === candidate.revision && review.decision === 'manual')).length;
      const remaining = candidates.filter(candidate => candidate.status === 'pending' && !reviews.some(review => review.candidate_id === candidate.id && review.revision === candidate.revision)).length;
      const active = sql.prepare("SELECT payload_json,updated_at,kind FROM bot_memory_jobs WHERE domain_key=? AND status='running' AND lease_until>? ORDER BY sequence LIMIT 1").get(job.domain_key, Date.now());
      const queued = sql.prepare("SELECT payload_json,available_at,error FROM bot_memory_jobs WHERE kind='maintenance' AND status='queued' AND json_extract(payload_json,'$.jobId')=? AND json_extract(payload_json,'$.operation')='review' ORDER BY available_at,sequence LIMIT 1").get(job.id);
      const payload = active ? parse<Record<string, string>>(row(active).payload_json) : undefined;
      const running = payload?.operation === 'review' && payload.jobId === job.id;
      const wait = queued && Number(row(queued).available_at) > Date.now();
      return { state: running ? 'running' : wait ? 'waiting' : remaining ? 'queued' : manual ? 'manual' : 'done',
        total: candidates.length, reviewed, manual, currentPosition: running ? Number(candidates.find(candidate => candidate.id === payload?.candidateId)?.position ?? 0) + 1 : undefined,
        busyJobId: active && !running ? payload?.jobId ?? 'memory' : undefined, startedAt: running ? String(row(active).updated_at) : undefined,
        retryAt: wait ? new Date(Number(row(queued).available_at)).toISOString() : undefined, error: wait ? optional(row(queued).error) : undefined };
    });
  }
  list(scope: BotMemoryScope, cursor?: string, limit = 20) {
    this.assertScope(scope); const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1) throw new Error('维护分页游标无效。');
    return this.store.taskTransaction(sql => {
      const rows = sql.prepare(`SELECT sequence,id,owner_key,domain_key,kind,status,phase,automatic,trigger_kind,memo_mode,survey_json,brief_json,created_at,updated_at,started_at,finished_at,attempts,error,metrics_json,narrative,next_cursor FROM bot_maintenance_jobs WHERE owner_key=? AND sequence<? ORDER BY sequence DESC LIMIT ?`).all(maintenanceOwner(scope), before, limit + 1).map(row);
      return { items: rows.slice(0, limit).map(r => this.summary(r)), nextCursor: rows.length > limit ? String(rows[limit - 1]!.sequence) : undefined };
    });
  }
  progress(scope: BotMemoryScope, id: string, phase: string, status?: BotMaintenanceStatus, error?: string): void {
    this.get(scope, id);
    this.store.taskTransaction(sql => sql.prepare(`UPDATE bot_maintenance_jobs SET phase=?,status=COALESCE(?,status),error=?,updated_at=?,started_at=CASE WHEN ? IN('running','applying') THEN COALESCE(started_at,?) ELSE started_at END,finished_at=CASE WHEN ? IN('completed','cancelled','failed','blocked') THEN ? ELSE NULL END WHERE id=?`).run(phase, status ?? null, error ?? null, stamp(), status ?? null, stamp(), status ?? null, stamp(), id));
  }
  start(scope: BotMemoryScope, id: string, apply: boolean): MaintenanceRecord {
    const record = this.get(scope, id);
    this.store.taskTransaction(sql => sql.prepare('UPDATE bot_maintenance_jobs SET attempts=attempts+1 WHERE id=?').run(id));
    this.progress(scope, id, apply ? 'applying' : 'scanning', apply ? 'applying' : 'running'); return record;
  }
  snapshot(scope: BotMemoryScope, id: string, snapshot: BotMemoryMaintenanceSnapshot): void {
    this.get(scope, id); const json = JSON.stringify(snapshot);
    this.store.taskTransaction(sql => sql.prepare('UPDATE bot_maintenance_jobs SET snapshot_json=?,updated_at=? WHERE id=?').run(json, stamp(), id));
    this.diagnostic(scope, id, 'snapshot', snapshot);
  }
  savePlan(scope: BotMemoryScope, id: string, plan: BotMemoryMaintenancePlan): void {
    const { job } = this.get(scope, id); if (plan.sources.length > 48) throw new Error('维护来源不属于当前扫描批次。');
    if (job.mode && job.mode !== plan.mode || job.mode === 'scan' && plan.candidates.length || hash(job.brief ?? null) !== hash(plan.brief ?? null)) throw new Error('维护任务的委托、模式或只读约束与报告不符。');
    const json = JSON.stringify(plan);
    this.store.taskTransaction(sql => {
      sql.prepare('UPDATE bot_maintenance_jobs SET plan_json=?,status=?,phase=?,narrative=?,next_cursor=?,metrics_json=?,updated_at=?,finished_at=?,error=? WHERE id=?').run(json, plan.candidates.length ? 'review' : 'completed', plan.candidates.length ? 'pending_review' : plan.scan.incremental && !plan.scan.examined ? 'no_new_versions' : 'completed', plan.narrative, plan.scan.nextCursor ?? null,
        JSON.stringify({ examined: plan.scan.examined, selected: plan.scan.selected, deferred: plan.scan.deferred.length, candidates: plan.candidates.length, applied: 0, rejected: 0, ...(plan.scan.incremental ? { incremental: true, context: plan.scan.context ?? 0 } : {}) }), stamp(), plan.candidates.length ? null : stamp(),
        plan.validationIssues?.length ? `${plan.validationIssues.length} 项候选的原文证据未通过核对，已隔离；其余 ${plan.candidates.length} 项继续审阅，相关原件未改动。` : null, id);
      for (let index = 0; index < plan.candidates.length; index++) { const candidate = plan.candidates[index]!; const revision = hash([plan.id, candidate]);
        sql.prepare("INSERT OR IGNORE INTO bot_maintenance_candidates VALUES(?,?,?,'pending',?,?,NULL,?)").run(id, candidate.id, index, revision, JSON.stringify(candidate), stamp()); }
      if (job.survey) {
        const { rootId, page, progress } = job.survey;
        if (!progress || progress.pages < page) this.store.setMetadata('maintenance-survey-progress:' + rootId, JSON.stringify({
          pages: page, examined: (progress?.examined ?? 0) + plan.scan.examined, deferred: (progress?.deferred ?? 0) + plan.scan.deferred.length, complete: !plan.scan.nextCursor,
        }));
        if (plan.scan.nextCursor) {
          if (plan.scan.nextCursor === plan.scan.cursor) throw new Error('维护扫描分页游标未前进。');
          const brief = job.brief && { topic: job.brief.topic, period: job.brief.period, fromDate: job.brief.fromDate, toDate: job.brief.toDate };
          const nextJob = this.enqueue(scope, 'organize', rootId + ':page:' + (page + 1), false, plan.scan.nextCursor, undefined, undefined, job.mode, { rootId, page: page + 1 }, brief, job.brief?.requestedBy);
          sql.prepare('UPDATE bot_maintenance_jobs SET survey_json=? WHERE id=?').run(JSON.stringify({ rootId, page, nextJobId: nextJob.id }), id);
        }
        return;
      }
      const sourceVersion = Number(row(sql.prepare('SELECT source_version FROM bot_maintenance_jobs WHERE id=?').get(id)).source_version);
      if (job.automatic && job.kind === 'dream' && !plan.scan.deferred.some(item => item.retryable !== false)
        && plan.sources.some(source => source.role === 'seed')) {
        sql.prepare('UPDATE bot_maintenance_settings SET dream_planned=MAX(dream_planned,?) WHERE owner_key=?')
          .run(sourceVersion, maintenanceOwner(scope));
      }
      const deferred = plan.scan.deferred.some(item => !('retryable' in item) || item.retryable !== false);
      if (!deferred && !plan.scan.nextCursor) sql.prepare('UPDATE bot_maintenance_settings SET planned=MAX(planned,?) WHERE owner_key=?').run(sourceVersion, maintenanceOwner(scope));
    });
    this.diagnostic(scope, id, 'plan', plan);
  }
  enqueueIdleOrganization(scope: BotMemoryScope, dreamJobId: string): BotMaintenanceJob | undefined {
    return this.store.taskTransaction(sql => {
      const { job, plan } = this.get(scope, dreamJobId);
      if (job.trigger !== 'idle' || job.kind !== 'dream' || !plan || plan.sources.some(source => source.role === 'seed')
        || plan.scan.deferred.some(item => item.retryable !== false)) return;
      const version = Number(row(sql.prepare('SELECT source_version FROM bot_maintenance_jobs WHERE id=?').get(dreamJobId)).source_version);
      if (!version) return;
      const owner = maintenanceOwner(scope), request = 'idle-organization:' + dreamJobId, id = 'maintenance-' + hash([owner, request]);
      if (sql.prepare('SELECT 1 FROM bot_maintenance_jobs WHERE id=?').get(id)) return this.get(scope, id).job;
      const pending = sql.prepare('UPDATE bot_maintenance_settings SET idle_organize_version=MAX(idle_organize_version,?) WHERE owner_key=? AND dream_planned<?').run(version, owner, version);
      if (pending.changes) return this.enqueue(scope, 'organize', request, true, undefined, 'idle', version);
    });
  }
  finishIdleOrganization(scope: BotMemoryScope, jobId: string, { hasMore, retryAt }: { hasMore: boolean; retryAt?: number }): void {
    this.store.taskTransaction(sql => {
      const job = sql.prepare(`SELECT source_version FROM bot_maintenance_jobs WHERE id=? AND owner_key=? AND kind='organize'
        AND automatic=1 AND trigger_kind='idle' AND plan_json IS NOT NULL`).get(jobId, maintenanceOwner(scope));
      if (!job) return;
      const owner = maintenanceOwner(scope), version = Number(row(job).source_version);
      const through = Number(this.store.getMetadata('maintenance-maturity:' + jobId));
      if (through > 0) {
        if (hasMore) sql.prepare('UPDATE bot_maintenance_maturity SET ready_at=? WHERE owner_key=? AND due_at<=?').run(Math.max(Date.now() + 60000, retryAt || 0), owner, through);
        else sql.prepare('DELETE FROM bot_maintenance_maturity WHERE owner_key=? AND due_at<=?').run(owner, through);
        return;
      }
      if (hasMore) {
        sql.prepare(`UPDATE bot_maintenance_settings SET idle_organize_version=MAX(idle_organize_version,?),dream_ready_at=?
          WHERE owner_key=? AND dream_planned<?`).run(version, Math.max(Date.now() + 60000, retryAt || 0), owner, version);
      } else {
        sql.prepare(`UPDATE bot_maintenance_settings SET dream_planned=MAX(dream_planned,?),
          idle_organize_version=CASE WHEN idle_organize_version<=? THEN 0 ELSE idle_organize_version END WHERE owner_key=?`).run(version, version, owner);
      }
    });
  }
  historicalVersions(scope: BotMemoryScope, after = 0) {
    this.assertScope(scope);
    return this.store.taskTransaction(sql => {
      const values = sql.prepare(`SELECT id,sequence,kind,plan_json FROM bot_maintenance_jobs
        WHERE domain_key=? AND sequence>? AND phase<>'planner_retired' AND kind='organize' AND survey_json IS NULL
          AND json_extract(plan_json,'$.format')='worldlinebox-memory-maintenance-v2' AND json_extract(plan_json,'$.scan.incremental')=1
        ORDER BY sequence LIMIT 21`).all(maintenanceDomain(scope), after).map(row);
      const selected = values.slice(0, 20);
      return { records: selected.map(value => {
        const plan = parse<BotMemoryMaintenancePlan>(value.plan_json), deferred = new Set(plan.scan.deferred.map(source => source.id));
        const proposed = new Set(plan.candidates.flatMap(candidate => candidate.sourceIds));
        const sources = plan.sources.filter(source => !deferred.has(source.id)).map(({ id, checksum, role }) => ({
          id, checksum, ...(role === 'context' ? { contextOnly: true } : {}), ...(proposed.has(id) ? { fromCandidate: true } : {}),
        }));
        return { jobId: String(value.id), kind: value.kind as 'organize' | 'dream', analyzedAt: plan.createdAt, sources, reserved: this.reservedSources(scope, String(value.id)) };
      }), after: selected.length ? Number(selected.at(-1)!.sequence) : after, more: values.length > 20 };
    });
  }
  reservedSources(scope: BotMemoryScope, jobId: string): string[] {
    this.assertScope(scope);
    return this.store.taskTransaction(sql => sql.prepare("SELECT DISTINCT s.value AS id FROM bot_maintenance_candidates c,json_each(c.candidate_json,'$.sourceIds') s WHERE c.job_id=? AND c.status NOT IN('applied','rejected','superseded') AND EXISTS(SELECT 1 FROM bot_maintenance_jobs j WHERE j.id=c.job_id AND j.status<>'cancelled')").all(jobId).map(value => String(row(value).id)));
  }
  refreshPlanState(scope: BotMemoryScope, jobId: string): void {
    this.get(scope, jobId); this.store.taskTransaction(sql => { this.refreshCounts(sql, jobId); sql.prepare('UPDATE bot_maintenance_jobs SET error=NULL WHERE id=?').run(jobId); });
  }
  candidates(scope: BotMemoryScope, jobId: string, cursor?: string, limit = 12) {
    this.get(scope, jobId); const after = cursor ? Number(cursor) : -1; if (!Number.isSafeInteger(after) || after < -1) throw new Error('候选分页游标无效。');
    return this.store.taskTransaction(sql => {
      const rows = sql.prepare('SELECT * FROM bot_maintenance_candidates WHERE job_id=? AND position>? ORDER BY position LIMIT ?').all(jobId, after, limit + 1).map(row);
      return { items: rows.slice(0, limit).map(r => this.candidateSummary(r)), nextCursor: rows.length > limit ? String(rows[limit - 1]!.position) : undefined };
    });
  }
  private candidateSummary(r: Row): BotMaintenanceCandidateSummary {
    const candidate = parse<BotMemoryMaintenancePlan['candidates'][number]>(r.candidate_json);
    const autoReview = this.store.taskTransaction(sql => {
      const audit = sql.prepare("SELECT record_json FROM bot_maintenance_reviews WHERE job_id=? AND candidate_id=? AND revision=? AND actor='model' ORDER BY sequence DESC LIMIT 1").get(r.job_id, r.id, r.revision);
      const pending = sql.prepare("SELECT status,available_at FROM bot_memory_jobs WHERE kind='maintenance' AND status IN('queued','running') AND json_extract(payload_json,'$.jobId')=? AND json_extract(payload_json,'$.candidateId')=? AND json_extract(payload_json,'$.operation')='review' ORDER BY sequence DESC LIMIT 1").get(r.job_id, r.id);
      const review = audit ? parse<BotMaintenanceReviewRecord>(row(audit).record_json) : undefined;
      if (pending && r.status === 'pending') return { state: row(pending).status === 'running' ? 'running' : Number(row(pending).available_at) > Date.now() ? 'waiting' : 'queued', reason: review?.decision === 'retry' ? review.reason : undefined } as const;
      if (review) return { state: review.decision === 'manual' || review.decision === 'retry' ? 'manual' : 'reviewed', reason: review.reason } as const;
      return undefined;
    });
    return { id: String(r.id), jobId: String(r.job_id), type: candidate.type, title: candidate.content.slice(0, 100) || candidate.reason.slice(0, 100), status: String(r.status) as BotMaintenanceCandidateStatus,
      revision: String(r.revision), sourceCount: candidate.sourceIds.length, uncertaintyCount: candidate.uncertainties.length, updatedAt: String(r.updated_at), autoReview };
  }
  candidate(scope: BotMemoryScope, jobId: string, id: string): BotMaintenanceCandidateDetail {
    const { plan } = this.get(scope, jobId);
    return this.store.taskTransaction(sql => {
      const value = sql.prepare('SELECT * FROM bot_maintenance_candidates WHERE job_id=? AND id=?').get(jobId, id); if (!value || !plan) throw new Error('当前任务中没有这项候选。');
      const r = row(value), candidate = parse<BotMemoryMaintenancePlan['candidates'][number]>(r.candidate_json);
      const audit = sql.prepare("SELECT record_json FROM bot_maintenance_reviews WHERE job_id=? AND candidate_id=? AND revision=? AND json_extract(record_json,'$.decision')='approve' ORDER BY sequence DESC LIMIT 1").get(jobId, id, r.revision);
      const approved = audit ? parse<BotMaintenanceReviewRecord>(row(audit).record_json) : undefined;
      const task = sql.prepare("SELECT status,json_extract(payload_json,'$.operation') AS operation FROM bot_memory_jobs WHERE kind='maintenance' AND status IN('queued','running') AND json_extract(payload_json,'$.jobId')=? AND json_extract(payload_json,'$.candidateId')=? AND json_extract(payload_json,'$.operation') IN('apply','reconcile') ORDER BY sequence DESC LIMIT 1").get(jobId, id);
      return { ...this.candidateSummary(r), content: candidate.content, tags: candidate.tags, ...(candidate.crystal && { crystal: candidate.crystal }), reason: candidate.reason, uncertainties: candidate.uncertainties, quotes: candidate.quotes,
        approval: approved ? { actor: approved.actor, approvedAt: approved.createdAt } : undefined,
        execution: task ? { operation: row(task).operation as 'apply' | 'reconcile', state: row(task).status as 'queued' | 'running' } : undefined,
        sources: plan.sources.filter(source => candidate.sourceIds.includes(source.id)).map(({ id, checksum, createdAt, tags }) => ({ id, checksum, createdAt, tags })), receipt: r.receipt_json ? parse(r.receipt_json) : undefined };
    });
  }
  review(scope: BotMemoryScope, jobId: string, id: string, revision: string, decision: 'approve' | 'reject', requestId: string, approval: 'review' | 'model' = 'review', audit?: Partial<BotMaintenanceReviewRecord>): BotMaintenanceCandidateDetail {
    return this.store.taskTransaction(sql => {
      this.command(sql, scope, requestId, ['review', jobId, id, revision, decision, approval]);
      const { job } = this.get(scope, jobId);
      this.ensureCurrent(job);
      if (job.status === 'cancelled') throw new Error('维护任务已停止，请先恢复再审阅。');
      if (job.mode === 'scan' || job.mode && job.mode !== 'organize' && approval !== 'review') throw new Error('此维护模式只接受用户逐项审阅。');
      const candidate = this.candidate(scope, jobId, id);
      if (candidate.revision !== revision) throw new Error('候选版本已改变，请重新读取后审阅。');
      if (candidate.status !== 'pending') { if (decision === 'approve' && ['approved', 'applying', 'applied', 'superseded', 'unknown', 'conflict'].includes(candidate.status) || decision === 'reject' && candidate.status === 'rejected') return candidate; throw new Error('这项候选已经作出其他决定。'); }
      sql.prepare('UPDATE bot_maintenance_candidates SET status=?,updated_at=? WHERE job_id=? AND id=?').run(decision === 'approve' ? 'approved' : 'rejected', stamp(), jobId, id);
      this.recordReview(scope, jobId, id, requestId, { sources: candidate.sources.map(({ id, checksum }) => ({ id, checksum })), ...audit, decision, candidateRevision: revision, actor: approval === 'model' ? 'model' : 'user', reason: audit?.reason || (decision === 'approve' ? '用户逐项核对后批准。' : '用户驳回此项候选。') });
      if (decision === 'approve') { this.store.setMetadata(`maintenance-approval:${jobId}:${id}`, approval); this.queue(scope, jobId, 'apply', requestId + ':' + id, id, approval); this.progress(scope, jobId, 'queued', 'queued'); }
      this.refreshCounts(sql, jobId); return this.candidate(scope, jobId, id);
    });
  }
  recordReview(scope: BotMemoryScope, jobId: string, candidateId: string, requestId: string, review: Pick<BotMaintenanceReviewRecord, 'actor' | 'decision' | 'reason' | 'candidateRevision'> & Partial<BotMaintenanceReviewRecord>): BotMaintenanceReviewRecord {
    this.get(scope, jobId); this.candidate(scope, jobId, candidateId);
    const id = hash([jobId, candidateId, requestId]), record = { ...review, id, jobId, candidateId, createdAt: stamp() } as BotMaintenanceReviewRecord;
    this.store.taskTransaction(sql => {
      const inserted = sql.prepare('INSERT OR IGNORE INTO bot_maintenance_reviews(id,job_id,candidate_id,revision,actor,record_json) VALUES(?,?,?,?,?,?)').run(id, jobId, candidateId, review.candidateRevision, review.actor, JSON.stringify(record));
      if (inserted.changes) {
        sql.prepare('UPDATE bot_maintenance_candidates SET updated_at=? WHERE job_id=? AND id=?').run(record.createdAt, jobId, candidateId);
        sql.prepare('UPDATE bot_maintenance_jobs SET updated_at=? WHERE id=?').run(record.createdAt, jobId);
      }
    });
    return record;
  }
  reviews(scope: BotMemoryScope, jobId: string, candidateId?: string, cursor?: string, limit = 20) {
    this.get(scope, jobId); if (candidateId) this.candidate(scope, jobId, candidateId);
    const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1) throw new Error('审阅记录分页无效。');
    return this.store.taskTransaction(sql => {
      const values = sql.prepare('SELECT sequence,record_json FROM bot_maintenance_reviews WHERE job_id=? AND (? IS NULL OR candidate_id=?) AND sequence<? ORDER BY sequence DESC LIMIT ?').all(jobId, candidateId ?? null, candidateId ?? null, before, limit + 1).map(row);
      return { items: values.slice(0, limit).map(value => parse<BotMaintenanceReviewRecord>(value.record_json)), nextCursor: values.length > limit ? String(values[limit - 1]!.sequence) : undefined };
    });
  }
  queueAutomaticReview(scope?: BotMemoryScope): BotMemoryScope | undefined {
    return this.store.taskTransaction(sql => {
      let reviewOwner: string;
      if (scope) reviewOwner = maintenanceOwner(scope);
      else {
        // New plans and review receipts wake their own owner directly. The idle
        // recovery poll checks one opted-in owner per turn, including after restart.
        const next = sql.prepare(`SELECT owner_key FROM bot_maintenance_settings
          WHERE owner_key>? AND json_extract(settings_json,'$.autoReview')=1 ORDER BY owner_key LIMIT 1`);
        const value = next.get(this.lastReviewOwner) || (this.lastReviewOwner && next.get(''));
        if (!value) return;
        reviewOwner = this.lastReviewOwner = String(row(value).owner_key);
      }
      const found = sql.prepare(`SELECT j.id,j.scope_json,c.id AS candidate_id,c.revision FROM bot_maintenance_candidates c JOIN bot_maintenance_jobs j ON j.id=c.job_id
        JOIN bot_maintenance_settings s ON s.owner_key=j.owner_key WHERE c.status='pending' AND j.kind='organize' AND COALESCE(j.memo_mode,'organize')='organize' AND j.status<>'cancelled' AND j.phase<>'source_withdrawn'
        AND json_extract(s.settings_json,'$.autoReview')=1 AND j.owner_key=?
        AND NOT EXISTS(SELECT 1 FROM bot_memory_jobs m WHERE m.kind='maintenance' AND m.status IN('queued','running') AND json_extract(m.payload_json,'$.jobId')=j.id AND json_extract(m.payload_json,'$.candidateId')=c.id AND json_extract(m.payload_json,'$.operation')='review')
        AND NOT EXISTS(SELECT 1 FROM bot_maintenance_reviews r WHERE r.job_id=j.id AND r.candidate_id=c.id AND r.revision=c.revision AND r.actor='model'
          AND json_extract(r.record_json,'$.decision')<>'retry'
          AND COALESCE(json_extract(r.record_json,'$.cycle'),0)=CAST(COALESCE((SELECT value FROM bot_metadata WHERE key='maintenance-review-cycle:'||j.owner_key),'0') AS INTEGER))
        ORDER BY j.sequence,c.position LIMIT 1`).get(reviewOwner);
      if (!found) return;
      const value = row(found), owner = parse<BotMemoryScope>(value.scope_json);
      const cycle = this.store.getMetadata(`maintenance-review-cycle:${maintenanceOwner(owner)}`) || '0';
      this.queue(owner, String(value.id), 'review', `model-review:${cycle}:${value.candidate_id}:${value.revision}`, String(value.candidate_id));
      return owner;
    });
  }
  candidateResult(scope: BotMemoryScope, jobId: string, id: string, status: BotMaintenanceCandidateStatus, receipt?: unknown): void {
    this.candidate(scope, jobId, id);
    this.store.taskTransaction(sql => { sql.prepare('UPDATE bot_maintenance_candidates SET status=?,receipt_json=?,updated_at=? WHERE job_id=? AND id=?').run(status, receipt ? JSON.stringify(receipt) : null, stamp(), jobId, id); this.refreshCounts(sql, jobId); });
    if (receipt) this.diagnostic(scope, jobId, 'receipt', receipt);
  }
  resumeCandidate(scope: BotMemoryScope, jobId: string, id: string, revision: string, requestId: string): BotMaintenanceCandidateDetail {
    return this.store.taskTransaction(sql => {
      this.ensureCurrent(this.get(scope, jobId).job);
      this.command(sql, scope, requestId, ['resume', jobId, id, revision]);
      const candidate = this.candidate(scope, jobId, id);
      if (candidate.revision !== revision) throw new Error('候选版本已改变，请重新读取。');
      if (!candidate.approval || !['approved', 'applying', 'unknown', 'conflict', 'superseded', 'applied'].includes(candidate.status)) throw new Error('这项候选尚未批准，不能继续执行。');
      if (candidate.execution || candidate.status === 'applied' || candidate.status === 'superseded') return candidate;
      this.queue(scope, jobId, 'reconcile', requestId + ':' + id, id, 'review');
      sql.prepare('UPDATE bot_maintenance_candidates SET updated_at=? WHERE job_id=? AND id=?').run(stamp(), jobId, id);
      this.progress(scope, jobId, 'checking_receipt', 'queued'); return this.candidate(scope, jobId, id);
    });
  }
  continueCandidate(scope: BotMemoryScope, jobId: string, id: string, key: string): void {
    const mode = this.store.getMetadata(`maintenance-approval:${jobId}:${id}`);
    this.queue(scope, jobId, 'apply', key + ':' + id, id, mode === 'model' ? mode : 'review');
    this.candidateResult(scope, jobId, id, 'approved');
  }
  coveringCandidates(scope: BotMemoryScope, jobId: string, id: string) {
    const candidate = this.candidate(scope, jobId, id);
    return this.store.taskTransaction(sql => sql.prepare("SELECT c.job_id,c.id,j.plan_json,c.receipt_json FROM bot_maintenance_candidates c JOIN bot_maintenance_jobs j ON j.id=c.job_id WHERE j.owner_key=? AND j.phase<>'planner_retired' AND c.status='applied' AND NOT(c.job_id=? AND c.id=?) AND json_extract(c.candidate_json,'$.type')='organize' ORDER BY j.sequence DESC").all(maintenanceOwner(scope), jobId, id).map(row).flatMap(r => {
      const plan = parse<BotMemoryMaintenancePlan>(r.plan_json), prior = plan.candidates.find(item => item.id === r.id);
      if (!prior || !candidate.sources.every(source => prior.sourceIds.includes(source.id) && plan.sources.some(expected => expected.id === source.id && expected.checksum === source.checksum))) return [];
      return [{ jobId: String(r.job_id), candidateId: String(r.id), plan, approval: 'review' as const }];
    }));
  }
  private refreshCounts(sql: BotTaskSql, jobId: string): void {
    const counts = row(sql.prepare("SELECT COUNT(*) AS total,SUM(status='applied') AS applied,SUM(status='superseded') AS superseded,SUM(status='rejected') AS rejected,SUM(status IN('unknown','conflict')) AS blocked,SUM(status='applying') AS applying,SUM(status='approved') AS approved FROM bot_maintenance_candidates WHERE job_id=?").get(jobId));
    const r = row(sql.prepare('SELECT metrics_json FROM bot_maintenance_jobs WHERE id=?').get(jobId)), done = Number(counts.total) === Number(counts.applied) + Number(counts.rejected) + Number(counts.superseded);
    const state = done ? 'completed' : counts.applying ? 'applying' : counts.approved ? 'queued' : counts.blocked ? 'blocked' : 'review';
    sql.prepare('UPDATE bot_maintenance_jobs SET metrics_json=?,status=?,phase=?,updated_at=?,finished_at=? WHERE id=?').run(JSON.stringify({ ...parse<object>(r.metrics_json), applied: Number(counts.applied), rejected: Number(counts.rejected), ...(Number(counts.superseded) ? { superseded: Number(counts.superseded) } : {}) }), state, state === 'review' ? 'pending_review' : state, stamp(), done ? stamp() : null, jobId);
  }
  control(scope: BotMemoryScope, id: string, operation: 'cancel' | 'retry', requestId: string): BotMaintenanceJob {
    return this.store.taskTransaction(sql => {
      this.command(sql, scope, requestId, [operation, id]); const record = this.get(scope, id);
      this.ensureCurrent(record.job);
      if (operation === 'cancel') { if (record.job.status !== 'completed') this.progress(scope, id, 'cancelled', 'cancelled'); return this.get(scope, id).job; }
      if (!terminal.has(record.job.status)) return record.job;
      if (record.job.phase === 'source_withdrawn') throw new Error('来源已撤回，旧计划不可恢复；请依据当前资料创建新的计划。');
      if (record.job.status === 'completed') throw new Error('已完成的维护不需要重新执行。');
      this.consumeAdmission(scope, id);
      if (record.plan) {
        const selected = sql.prepare("SELECT id FROM bot_maintenance_candidates WHERE job_id=? AND status IN('approved','applying','unknown','conflict') ORDER BY position").all(id).map(row);
        for (const candidate of selected) {
          const approval = this.store.getMetadata(`maintenance-approval:${id}:${candidate.id}`);
          this.queue(scope, id, 'apply', requestId + ':' + candidate.id, String(candidate.id), approval === 'model' ? approval : 'review');
        }
        if (!selected.length) { this.progress(scope, id, 'pending_review', 'review'); return this.get(scope, id).job; }
      } else this.queue(scope, id, 'plan', requestId);
      this.progress(scope, id, 'queued', 'queued'); return this.get(scope, id).job;
    });
  }
  consumeAdmission(scope: BotMemoryScope, id: string): void {
    const key = `maintenance-new-admission:${id}`;
    if (this.store.getMetadata(key) !== '1') return;
    this.get(scope, id);
    this.store.taskTransaction(sql => { sql.prepare('UPDATE bot_maintenance_jobs SET epoch=epoch+1 WHERE id=?').run(id); this.store.setMetadata(key, ''); });
  }
  diagnostic(scope: BotMemoryScope, jobId: string, phase: string, value: unknown): void {
    this.get(scope, jobId); const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.store.taskTransaction(sql => sql.prepare('INSERT INTO bot_maintenance_diagnostics(job_id,phase,text,created_at) VALUES(?,?,?,?)').run(jobId, phase, text, stamp()));
  }
  invalidate(scope: BotMemoryScope): void {
    this.assertScope(scope);
    this.store.taskTransaction(sql => {
      const jobs = sql.prepare('SELECT id FROM bot_maintenance_jobs WHERE domain_key=?').all(maintenanceDomain(scope));
      sql.prepare("UPDATE bot_maintenance_tool_receipts SET result_json=? WHERE owner_key=? OR owner_key IN (SELECT owner_key FROM bot_maintenance_settings WHERE domain_key=?)").run(JSON.stringify({ accepted: false, withdrawn: true }), maintenanceOwner(scope), maintenanceDomain(scope));
      for (const raw of jobs) {
        const id = String(row(raw).id);
        sql.prepare("DELETE FROM bot_metadata WHERE key LIKE ?").run(`maintenance-output:${id}:%`);
        for (const rawReview of sql.prepare('SELECT id,record_json FROM bot_maintenance_reviews WHERE job_id=?').all(id)) {
          const saved = row(rawReview), review = parse<BotMaintenanceReviewRecord>(saved.record_json);
          sql.prepare('UPDATE bot_maintenance_reviews SET record_json=? WHERE id=?').run(JSON.stringify({ ...review, reason: '来源资料已撤回，审阅正文与引用已清除；决定及版本证明保留。', checks: undefined, evidence: undefined }), saved.id);
        }
        for (const value of sql.prepare('SELECT id,candidate_json,receipt_json FROM bot_maintenance_candidates WHERE job_id=?').all(id)) {
          const r = row(value), candidate = parse<BotMemoryMaintenancePlan['candidates'][number]>(r.candidate_json);
          const receipt = r.receipt_json ? parse<Record<string, unknown>>(r.receipt_json) : undefined;
          const proof = receipt ? Object.fromEntries(['actionId', 'operationId', 'status'].filter(key => receipt[key] !== undefined).map(key => [key, receipt[key]])) : null;
          sql.prepare("UPDATE bot_maintenance_candidates SET candidate_json=?,receipt_json=?,status=CASE WHEN status IN('applied','rejected') THEN status ELSE 'conflict' END,updated_at=? WHERE job_id=? AND id=?")
            .run(JSON.stringify({ ...candidate, content: '来源资料已撤回。', tags: [], crystal: undefined, reason: '旧候选不再可用，请依据当前日记创建新的计划。', sourceIds: [], quotes: [], uncertainties: [] }), proof ? JSON.stringify(proof) : null, stamp(), id, r.id);
        }
        sql.prepare("UPDATE bot_maintenance_jobs SET brief_json=NULL,snapshot_json=NULL,plan_json=NULL,narrative=NULL,error='来源资料已撤回，旧候选已停止。',status=CASE WHEN status IN('completed','cancelled') THEN status ELSE 'blocked' END,phase='source_withdrawn',updated_at=? WHERE id=?").run(stamp(), id);
        sql.prepare("UPDATE bot_maintenance_diagnostics SET text='来源资料已撤回；诊断正文已清除，操作证明保留在任务状态。' WHERE job_id=?").run(id);
      }
    });
  }
  diagnostics(scope: BotMemoryScope, jobId: string, input: { after?: number; limit?: number; entryId?: number; offset?: number }) {
    this.get(scope, jobId);
    return this.store.taskTransaction(sql => {
      const limit = input.limit ?? 20, rows = sql.prepare('SELECT sequence,phase,substr(text,1,160) AS preview,length(text) AS chars,created_at FROM bot_maintenance_diagnostics WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(jobId, input.after ?? 0, limit + 1).map(row);
      const items = rows.slice(0, limit).map(r => ({ id: Number(r.sequence), phase: String(r.phase), createdAt: String(r.created_at), preview: String(r.preview), chars: Number(r.chars) }));
      let entry: { id: number; text: string; offset: number; nextOffset?: number; total: number } | undefined;
      if (input.entryId) { const value = sql.prepare('SELECT substr(text,?,4000) AS page,length(text) AS chars FROM bot_maintenance_diagnostics WHERE job_id=? AND sequence=?').get((input.offset ?? 0) + 1, jobId, input.entryId); if (!value) throw new Error('当前任务中没有这条诊断。');
        const r = row(value), offset = input.offset ?? 0, next = offset + Array.from(String(r.page)).length; entry = { id: input.entryId, text: String(r.page), offset, nextOffset: next < Number(r.chars) ? next : undefined, total: Number(r.chars) }; }
      return { items, nextAfter: rows.length > limit ? items.at(-1)?.id : undefined, entry };
    });
  }
}
