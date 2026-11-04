import { createHash } from 'node:crypto';
import type { BotMaintenanceJob, BotMaintenanceSettings, BotMaintenanceCandidateDetail, BotMaintenanceCandidateSummary, BotMaintenanceStatus, BotMaintenanceCandidateStatus } from '../../shared/companion-bot-maintenance';
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
const terminal = new Set<BotMaintenanceStatus>(['completed', 'cancelled', 'failed', 'blocked']);
export interface MaintenanceRecord { job: BotMaintenanceJob; scope: BotMemoryScope; snapshot?: BotMemoryMaintenanceSnapshot; plan?: BotMemoryMaintenancePlan; epoch: number; cursor?: string }

/** Operational review journal only. Source notes remain in VCP; proposals and
 * diagnostic text are never indexed as companion memory. */
export class BotMaintenanceStore {
  constructor(readonly store: BotStore) {
    store.taskTransaction(sql => { for (const statement of [
      `CREATE TABLE IF NOT EXISTS bot_maintenance_settings(owner_key TEXT PRIMARY KEY,domain_key TEXT NOT NULL,scope_json TEXT NOT NULL,settings_json TEXT NOT NULL,next_due INTEGER NOT NULL,last_activity INTEGER NOT NULL,dirty INTEGER NOT NULL DEFAULT 0,planned INTEGER NOT NULL DEFAULT 0)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_settings_due ON bot_maintenance_settings(next_due,owner_key)`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_jobs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_key TEXT NOT NULL,domain_key TEXT NOT NULL,scope_json TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,automatic INTEGER NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,source_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,error TEXT,snapshot_json TEXT,plan_json TEXT,metrics_json TEXT NOT NULL,narrative TEXT,next_cursor TEXT)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_jobs_owner ON bot_maintenance_jobs(owner_key,sequence DESC)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_jobs_domain ON bot_maintenance_jobs(domain_key,status)`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_candidates(job_id TEXT NOT NULL REFERENCES bot_maintenance_jobs(id),id TEXT NOT NULL,position INTEGER NOT NULL,status TEXT NOT NULL,revision TEXT NOT NULL,candidate_json TEXT NOT NULL,receipt_json TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(job_id,id))`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_diagnostics(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES bot_maintenance_jobs(id),phase TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS bot_maintenance_diagnostics_job ON bot_maintenance_diagnostics(job_id,sequence)`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_requests(owner_key TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(owner_key,request_id))`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_tool_receipts(owner_key TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(owner_key,request_id))`,
      `CREATE TABLE IF NOT EXISTS bot_maintenance_changes(owner_key TEXT NOT NULL,change_id TEXT NOT NULL,PRIMARY KEY(owner_key,change_id))`,
    ]) sql.prepare(statement).run(); });
  }
  assertScope(scope: BotMemoryScope): void {
    const room = this.store.getConversation(scope.conversationId);
    if (!room || room.securityDomainId !== scope.securityDomainId || !room.memberIds.includes(scope.companionId)) throw new Error('维护记录不属于当前伙伴受众。');
  }
  settings(scope: BotMemoryScope, now = Date.now()): BotMaintenanceSettings {
    this.assertScope(scope);
    return this.store.taskTransaction(sql => {
      const owner = maintenanceOwner(scope), found = sql.prepare('SELECT settings_json FROM bot_maintenance_settings WHERE owner_key=?').get(owner);
      if (found) return parse<BotMaintenanceSettings>(row(found).settings_json);
      const settings: BotMaintenanceSettings = { enabled: true, kind: 'organize', intervalHours: 24, idleMinutes: 15, minNotes: 12, autoApply: 'never', nextEligibleAt: new Date(now + 86400000).toISOString(), lastActivityAt: new Date(now).toISOString() };
      sql.prepare('INSERT INTO bot_maintenance_settings(owner_key,domain_key,scope_json,settings_json,next_due,last_activity) VALUES(?,?,?,?,?,?)').run(owner, maintenanceDomain(scope), JSON.stringify(scope), JSON.stringify(settings), now + 86400000, now);
      return settings;
    });
  }
  hasSettings(scope: BotMemoryScope): boolean {
    return this.store.taskTransaction(sql => !!sql.prepare('SELECT 1 FROM bot_maintenance_settings WHERE owner_key=?').get(maintenanceOwner(scope)));
  }
  updateSettings(scope: BotMemoryScope, patch: Partial<Pick<BotMaintenanceSettings, 'enabled' | 'kind' | 'intervalHours' | 'idleMinutes' | 'minNotes' | 'autoApply'>>): BotMaintenanceSettings {
    const current = this.settings(scope), settings = { ...current, ...patch };
    this.store.taskTransaction(sql => sql.prepare('UPDATE bot_maintenance_settings SET settings_json=? WHERE owner_key=?').run(JSON.stringify(settings), maintenanceOwner(scope)));
    return settings;
  }
  activity(scope: BotMemoryScope, changeId?: string): void {
    const current = this.settings(scope), now = Date.now();
    this.store.taskTransaction(sql => {
      let increment = 0;
      if (changeId) increment = sql.prepare('INSERT OR IGNORE INTO bot_maintenance_changes VALUES(?,?)').run(maintenanceOwner(scope), changeId).changes;
      sql.prepare('UPDATE bot_maintenance_settings SET last_activity=?,settings_json=?,dirty=dirty+? WHERE owner_key=?').run(now, JSON.stringify({ ...current, lastActivityAt: new Date(now).toISOString() }), increment, maintenanceOwner(scope));
    });
  }
  due(now = Date.now()): BotMemoryScope | undefined {
    return this.store.taskTransaction(sql => {
      const found = sql.prepare(`SELECT s.scope_json FROM bot_maintenance_settings s WHERE s.next_due<=? AND s.dirty>s.planned AND json_extract(s.settings_json,'$.enabled')=1
        AND s.last_activity<=?-json_extract(s.settings_json,'$.idleMinutes')*60000
        AND NOT EXISTS(SELECT 1 FROM bot_memory_jobs m WHERE m.domain_key=s.domain_key AND m.status IN('queued','running'))
        AND NOT EXISTS(SELECT 1 FROM bot_maintenance_jobs j WHERE j.domain_key=s.domain_key AND j.status IN('queued','running','review','applying','blocked'))
        AND NOT EXISTS(SELECT 1 FROM bot_inbox i WHERE i.companion_id=json_extract(s.scope_json,'$.companionId') AND i.domain_id=json_extract(s.scope_json,'$.securityDomainId') AND i.status IN('queued','running'))
        ORDER BY s.next_due,s.owner_key LIMIT 1`).get(now, now);
      return found ? parse<BotMemoryScope>(row(found).scope_json) : undefined;
    });
  }
  defer(scope: BotMemoryScope, milliseconds: number, reason?: string, lastRun = false): void {
    const settings = this.settings(scope), next = Date.now() + milliseconds;
    this.store.taskTransaction(sql => sql.prepare('UPDATE bot_maintenance_settings SET next_due=?,settings_json=? WHERE owner_key=?').run(next,
      JSON.stringify({ ...settings, nextEligibleAt: new Date(next).toISOString(), blockedReason: reason, ...(lastRun ? { lastRunAt: stamp() } : {}) }), maintenanceOwner(scope)));
  }
  enqueue(scope: BotMemoryScope, kind: 'organize' | 'dream', requestId: string, automatic = false, cursor?: string): BotMaintenanceJob {
    this.settings(scope);
    return this.store.taskTransaction(sql => {
      this.command(sql, scope, requestId, ['run', kind, automatic, cursor]);
      const id = `maintenance-${hash([maintenanceOwner(scope), requestId])}`, existing = sql.prepare('SELECT id FROM bot_maintenance_jobs WHERE id=?').get(id);
      if (existing) return this.get(scope, id).job;
      if (Number(row(sql.prepare("SELECT COUNT(*) AS n FROM bot_maintenance_jobs WHERE domain_key=? AND status IN('queued','running','review','applying','blocked')").get(maintenanceDomain(scope))).n) >= 4) throw new Error('本域已有4个未完成维护任务，请先审阅或停止。');
      if (automatic && sql.prepare("SELECT 1 FROM bot_maintenance_jobs WHERE domain_key=? AND automatic=1 AND created_at>=? LIMIT 1").get(maintenanceDomain(scope), new Date(Date.now() - 86400000).toISOString())) throw new Error('本域24小时内已有自动计划，保留预算等待下次。');
      const at = stamp(), version = row(sql.prepare('SELECT dirty FROM bot_maintenance_settings WHERE owner_key=?').get(maintenanceOwner(scope))).dirty;
      sql.prepare(`INSERT INTO bot_maintenance_jobs(id,owner_key,domain_key,scope_json,kind,status,phase,automatic,source_version,created_at,updated_at,metrics_json) VALUES(?,?,?,?,?,'queued','queued',?,?,?,?,?)`)
        .run(id, maintenanceOwner(scope), maintenanceDomain(scope), JSON.stringify(scope), kind, automatic ? 1 : 0, version, at, at, JSON.stringify({ examined: 0, selected: 0, deferred: 0, candidates: 0, applied: 0, rejected: 0 }));
      const next = cursor !== undefined ? cursor : this.store.getMetadata(`maintenance-scan-cursor:${maintenanceOwner(scope)}:${kind}`);
      this.store.setMetadata(`maintenance-input:${id}`, JSON.stringify({ cursor: next || undefined }));
      this.queue(scope, id, 'plan', requestId);
      return this.get(scope, id).job;
    });
  }
  planTool(scope: BotMemoryScope, kind: 'organize' | 'dream', requestId: string): unknown {
    this.assertScope(scope);
    return this.store.taskTransaction(sql => {
      const previous = this.toolReceipt(scope, kind, requestId); if (previous.found) return previous.result;
      const existing = this.list(scope).items.find(job => ['queued', 'running', 'review', 'applying', 'blocked'].includes(job.status));
      const result = existing ? { accepted: false, job: existing, reason: '当前受众已有未完成维护，请先查看进展或审阅候选。' }
        : { accepted: true, job: this.enqueue(scope, kind, requestId) };
      sql.prepare('INSERT INTO bot_maintenance_tool_receipts VALUES(?,?,?,?)').run(maintenanceOwner(scope), requestId, hash(['plan', kind]), JSON.stringify(result));
      return result;
    });
  }
  toolReceipt(scope: BotMemoryScope, kind: 'organize' | 'dream', requestId: string): { found: boolean; result?: unknown } {
    this.assertScope(scope);
    return this.store.taskTransaction(sql => {
      const value = sql.prepare('SELECT fingerprint,result_json FROM bot_maintenance_tool_receipts WHERE owner_key=? AND request_id=?').get(maintenanceOwner(scope), requestId);
      if (!value) return { found: false };
      const r = row(value); if (r.fingerprint !== hash(['plan', kind])) throw new Error('维护工具回执参数不匹配。');
      return { found: true, result: parse(r.result_json) };
    });
  }
  private command(sql: BotTaskSql, scope: BotMemoryScope, requestId: string, payload: unknown): void {
    const fingerprint = hash(payload), previous = sql.prepare('SELECT fingerprint FROM bot_maintenance_requests WHERE owner_key=? AND request_id=?').get(maintenanceOwner(scope), requestId);
    if (previous && row(previous).fingerprint !== fingerprint) throw new Error('维护请求标识已用于其他参数。');
    sql.prepare('INSERT OR IGNORE INTO bot_maintenance_requests VALUES(?,?,?)').run(maintenanceOwner(scope), requestId, fingerprint);
  }
  private queue(scope: BotMemoryScope, jobId: string, operation: 'plan' | 'apply', key: string, candidateId?: string, approval: 'review' | 'lossless' = 'review'): void {
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
    return { id: String(r.id), kind: String(r.kind) as BotMaintenanceJob['kind'], status: String(r.status) as BotMaintenanceStatus, phase: String(r.phase), automatic: !!r.automatic,
      createdAt: String(r.created_at), updatedAt: String(r.updated_at), startedAt: optional(r.started_at), finishedAt: optional(r.finished_at),
      elapsedMs: r.started_at ? Math.max(0, Date.parse(String(r.finished_at ?? stamp())) - Date.parse(String(r.started_at))) : 0,
      attempts: Number(r.attempts), error: optional(r.error), metrics: parse(r.metrics_json), narrative: optional(r.narrative), nextCursor: optional(r.next_cursor) };
  }
  list(scope: BotMemoryScope, cursor?: string, limit = 20) {
    this.assertScope(scope); const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1) throw new Error('维护分页游标无效。');
    return this.store.taskTransaction(sql => {
      const rows = sql.prepare(`SELECT sequence,id,kind,status,phase,automatic,created_at,updated_at,started_at,finished_at,attempts,error,metrics_json,narrative,next_cursor FROM bot_maintenance_jobs WHERE owner_key=? AND sequence<? ORDER BY sequence DESC LIMIT ?`).all(maintenanceOwner(scope), before, limit + 1).map(row);
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
    this.get(scope, id); const json = JSON.stringify(snapshot); if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('维护原始资料超出4MB单批上限。');
    this.store.taskTransaction(sql => sql.prepare('UPDATE bot_maintenance_jobs SET snapshot_json=?,updated_at=? WHERE id=?').run(json, stamp(), id));
    this.diagnostic(scope, id, 'snapshot', snapshot);
  }
  savePlan(scope: BotMemoryScope, id: string, plan: BotMemoryMaintenancePlan): void {
    this.get(scope, id); if (plan.candidates.length > 12 || plan.sources.length > 24) throw new Error('维护计划超出本批容量。');
    const json = JSON.stringify(plan); if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('维护计划超出4MB单批上限。');
    this.store.taskTransaction(sql => {
      sql.prepare('UPDATE bot_maintenance_jobs SET plan_json=?,status=?,phase=?,narrative=?,next_cursor=?,metrics_json=?,updated_at=?,finished_at=? WHERE id=?').run(json, plan.candidates.length ? 'review' : 'completed', plan.candidates.length ? 'pending_review' : 'completed', plan.narrative.slice(0, 8000), plan.scan.nextCursor ?? null,
        JSON.stringify({ examined: plan.scan.examined, selected: plan.scan.selected, deferred: plan.scan.deferred.length, candidates: plan.candidates.length, applied: 0, rejected: 0 }), stamp(), plan.candidates.length ? null : stamp(), id);
      for (let index = 0; index < plan.candidates.length; index++) { const candidate = plan.candidates[index]!; const revision = hash([plan.id, candidate]);
        sql.prepare("INSERT OR IGNORE INTO bot_maintenance_candidates VALUES(?,?,?,'pending',?,?,NULL,?)").run(id, candidate.id, index, revision, JSON.stringify(candidate), stamp()); }
      this.store.setMetadata(`maintenance-scan-cursor:${maintenanceOwner(scope)}:${plan.kind}`, plan.scan.nextCursor ?? '');
      const cycleKey = `maintenance-scan-cycle:${maintenanceOwner(scope)}:${plan.kind}`;
      const previous = parse<{ deferred?: boolean; version?: number }>(this.store.getMetadata(cycleKey) || '{}');
      const sourceVersion = Number(row(sql.prepare('SELECT source_version FROM bot_maintenance_jobs WHERE id=?').get(id)).source_version);
      const deferred = plan.scan.deferred.some(item => !('retryable' in item) || item.retryable !== false);
      // A later page cannot erase an earlier page's deferred source. The
      // initial cycle version also keeps notes created while paging dirty.
      const cycle = { deferred: deferred || !!(plan.scan.cursor && previous.deferred), version: plan.scan.cursor && previous.version !== undefined ? previous.version : sourceVersion };
      if (plan.scan.nextCursor) this.store.setMetadata(cycleKey, JSON.stringify(cycle));
      else {
        if (!cycle.deferred) sql.prepare('UPDATE bot_maintenance_settings SET planned=MAX(planned,?) WHERE owner_key=?').run(cycle.version, maintenanceOwner(scope));
        this.store.setMetadata(cycleKey, '');
      }
    });
    this.diagnostic(scope, id, 'plan', plan);
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
    return { id: String(r.id), jobId: String(r.job_id), type: candidate.type, title: candidate.content.slice(0, 100) || candidate.reason.slice(0, 100), status: String(r.status) as BotMaintenanceCandidateStatus,
      revision: String(r.revision), sourceCount: candidate.sourceIds.length, uncertaintyCount: candidate.uncertainties.length, updatedAt: String(r.updated_at) };
  }
  candidate(scope: BotMemoryScope, jobId: string, id: string): BotMaintenanceCandidateDetail {
    const { plan } = this.get(scope, jobId);
    return this.store.taskTransaction(sql => {
      const value = sql.prepare('SELECT * FROM bot_maintenance_candidates WHERE job_id=? AND id=?').get(jobId, id); if (!value || !plan) throw new Error('当前任务中没有这项候选。');
      const r = row(value), candidate = parse<BotMemoryMaintenancePlan['candidates'][number]>(r.candidate_json);
      return { ...this.candidateSummary(r), content: candidate.content, tags: candidate.tags, reason: candidate.reason, uncertainties: candidate.uncertainties, quotes: candidate.quotes,
        sources: plan.sources.filter(source => candidate.sourceIds.includes(source.id)).map(({ id, checksum, createdAt, tags }) => ({ id, checksum, createdAt, tags })), receipt: r.receipt_json ? parse(r.receipt_json) : undefined };
    });
  }
  review(scope: BotMemoryScope, jobId: string, id: string, revision: string, decision: 'approve' | 'reject', requestId: string, approval: 'review' | 'lossless' = 'review'): BotMaintenanceCandidateDetail {
    return this.store.taskTransaction(sql => {
      this.command(sql, scope, requestId, ['review', jobId, id, revision, decision, approval]);
      if (this.get(scope, jobId).job.status === 'cancelled') throw new Error('维护任务已停止，请先恢复再审阅。');
      const candidate = this.candidate(scope, jobId, id);
      if (candidate.revision !== revision) throw new Error('候选版本已改变，请重新读取后审阅。');
      if (candidate.status !== 'pending') { if (decision === 'approve' && ['approved', 'applying', 'applied', 'unknown', 'conflict'].includes(candidate.status) || decision === 'reject' && candidate.status === 'rejected') return candidate; throw new Error('这项候选已经作出其他决定。'); }
      sql.prepare('UPDATE bot_maintenance_candidates SET status=?,updated_at=? WHERE job_id=? AND id=?').run(decision === 'approve' ? 'approved' : 'rejected', stamp(), jobId, id);
      if (decision === 'approve') { this.store.setMetadata(`maintenance-approval:${jobId}:${id}`, approval); this.queue(scope, jobId, 'apply', id, id, approval); this.progress(scope, jobId, 'queued', 'queued'); }
      this.refreshCounts(sql, jobId); return this.candidate(scope, jobId, id);
    });
  }
  candidateResult(scope: BotMemoryScope, jobId: string, id: string, status: BotMaintenanceCandidateStatus, receipt?: unknown): void {
    this.candidate(scope, jobId, id);
    this.store.taskTransaction(sql => { sql.prepare('UPDATE bot_maintenance_candidates SET status=?,receipt_json=?,updated_at=? WHERE job_id=? AND id=?').run(status, receipt ? JSON.stringify(receipt) : null, stamp(), jobId, id); this.refreshCounts(sql, jobId); });
    if (receipt) this.diagnostic(scope, jobId, 'receipt', receipt);
  }
  private refreshCounts(sql: BotTaskSql, jobId: string): void {
    const counts = row(sql.prepare("SELECT COUNT(*) AS total,SUM(status='applied') AS applied,SUM(status='rejected') AS rejected,SUM(status IN('unknown','conflict')) AS blocked,SUM(status='applying') AS applying,SUM(status='approved') AS approved FROM bot_maintenance_candidates WHERE job_id=?").get(jobId));
    const r = row(sql.prepare('SELECT metrics_json FROM bot_maintenance_jobs WHERE id=?').get(jobId)), done = Number(counts.total) === Number(counts.applied) + Number(counts.rejected);
    const state = done ? 'completed' : counts.applying ? 'applying' : counts.approved ? 'queued' : counts.blocked ? 'blocked' : 'review';
    sql.prepare('UPDATE bot_maintenance_jobs SET metrics_json=?,status=?,phase=?,updated_at=?,finished_at=? WHERE id=?').run(JSON.stringify({ ...parse<object>(r.metrics_json), applied: Number(counts.applied), rejected: Number(counts.rejected) }), state, state === 'review' ? 'pending_review' : state, stamp(), done ? stamp() : null, jobId);
  }
  control(scope: BotMemoryScope, id: string, operation: 'cancel' | 'retry', requestId: string): BotMaintenanceJob {
    return this.store.taskTransaction(sql => {
      this.command(sql, scope, requestId, [operation, id]); const record = this.get(scope, id);
      if (operation === 'cancel') { if (record.job.status !== 'completed') this.progress(scope, id, 'cancelled', 'cancelled'); return this.get(scope, id).job; }
      if (!terminal.has(record.job.status)) return record.job;
      if (record.job.phase === 'source_withdrawn') throw new Error('来源已撤回，旧计划不可恢复；请依据当前资料创建新的计划。');
      if (record.job.status === 'completed') throw new Error('已完成的维护不需要重新执行。');
      this.consumeAdmission(scope, id);
      if (record.plan) {
        const selected = this.candidates(scope, id).items.filter(item => ['approved', 'applying', 'unknown', 'conflict'].includes(item.status));
        for (const candidate of selected) this.queue(scope, id, 'apply', requestId + ':' + candidate.id, candidate.id, this.store.getMetadata(`maintenance-approval:${id}:${candidate.id}`) === 'lossless' ? 'lossless' : 'review');
        if (!selected.length) { this.progress(scope, id, 'pending_review', 'review'); return this.get(scope, id).job; }
      } else this.queue(scope, id, 'plan', requestId);
      this.progress(scope, id, 'queued', 'queued'); return this.get(scope, id).job;
    });
  }
  consumeAdmission(scope: BotMemoryScope, id: string): void {
    const key = `maintenance-new-admission:${id}`;
    if (this.store.getMetadata(key) !== '1') return;
    const record = this.get(scope, id); if (record.epoch >= 2) throw new Error('本次计划已达到3次明确模型调用上限，请保留记录并创建新的审阅计划。');
    this.store.taskTransaction(sql => { sql.prepare('UPDATE bot_maintenance_jobs SET epoch=epoch+1 WHERE id=?').run(id); this.store.setMetadata(key, ''); });
  }
  diagnostic(scope: BotMemoryScope, jobId: string, phase: string, value: unknown): void {
    this.get(scope, jobId); const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('单条维护诊断超过4MB，请缩小批次。');
    this.store.taskTransaction(sql => sql.prepare('INSERT INTO bot_maintenance_diagnostics(job_id,phase,text,created_at) VALUES(?,?,?,?)').run(jobId, phase, text, stamp()));
  }
  invalidate(scope: BotMemoryScope): void {
    this.assertScope(scope);
    this.store.taskTransaction(sql => {
      const jobs = sql.prepare('SELECT id FROM bot_maintenance_jobs WHERE domain_key=?').all(maintenanceDomain(scope));
      for (const raw of jobs) {
        const id = String(row(raw).id);
        for (const value of sql.prepare('SELECT id,candidate_json,receipt_json FROM bot_maintenance_candidates WHERE job_id=?').all(id)) {
          const r = row(value), candidate = parse<BotMemoryMaintenancePlan['candidates'][number]>(r.candidate_json);
          const receipt = r.receipt_json ? parse<Record<string, unknown>>(r.receipt_json) : undefined;
          const proof = receipt ? Object.fromEntries(['actionId', 'operationId', 'status'].filter(key => receipt[key] !== undefined).map(key => [key, receipt[key]])) : null;
          sql.prepare("UPDATE bot_maintenance_candidates SET candidate_json=?,receipt_json=?,status=CASE WHEN status IN('applied','rejected') THEN status ELSE 'conflict' END,updated_at=? WHERE job_id=? AND id=?")
            .run(JSON.stringify({ ...candidate, content: '来源资料已撤回。', tags: [], reason: '旧候选不再可用，请依据当前日记创建新的计划。', sourceIds: [], quotes: [], uncertainties: [] }), proof ? JSON.stringify(proof) : null, stamp(), id, r.id);
        }
        sql.prepare("UPDATE bot_maintenance_jobs SET snapshot_json=NULL,plan_json=NULL,narrative=NULL,error='来源资料已撤回，旧候选已停止。',status=CASE WHEN status IN('completed','cancelled') THEN status ELSE 'blocked' END,phase='source_withdrawn',updated_at=? WHERE id=?").run(stamp(), id);
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
