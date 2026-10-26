import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';

export function initializeCompanionModelResources(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_model_requests(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,connection_id TEXT NOT NULL,
    admitted_at INTEGER NOT NULL,host_pid INTEGER NOT NULL,host_instance TEXT NOT NULL,lease_until INTEGER NOT NULL,
    policy_revision TEXT NOT NULL,input_bytes INTEGER NOT NULL,reserved_output_tokens INTEGER NOT NULL,
    reserved_cost_micros INTEGER NOT NULL,cost_unit TEXT,state TEXT NOT NULL DEFAULT 'admitted',http_status INTEGER,duration_ms REAL);
    CREATE INDEX IF NOT EXISTS companion_model_requests_connection ON companion_model_requests(connection_id,admitted_at);
    CREATE INDEX IF NOT EXISTS companion_model_requests_clock ON companion_model_requests(admitted_at);
    CREATE INDEX IF NOT EXISTS companion_model_requests_owner ON companion_model_requests(companion_id,admitted_at);
    CREATE TABLE IF NOT EXISTS companion_model_request_purposes(request_id TEXT PRIMARY KEY REFERENCES companion_model_requests(id) ON DELETE CASCADE,purpose TEXT NOT NULL);`);
}
type Totals = { requests: number; inputBytes: number; reservedOutputTokens: number; reservedCostMicros: number;
  responses: number; networkErrors: number; unfinished: number; interrupted: number };
const totalsSql = `COALESCE(SUM(state!='cancelled_before_send'),0) AS requests,
  COALESCE(SUM(CASE WHEN state='cancelled_before_send' THEN 0 ELSE input_bytes END),0) AS inputBytes,
  COALESCE(SUM(CASE WHEN state='cancelled_before_send' THEN 0 ELSE reserved_output_tokens END),0) AS reservedOutputTokens,
  COALESCE(SUM(CASE WHEN state='cancelled_before_send' THEN 0 ELSE reserved_cost_micros END),0) AS reservedCostMicros,COALESCE(SUM(state='response'),0) AS responses,
  COALESCE(SUM(state='network_error'),0) AS networkErrors,COALESCE(SUM(state='admitted'),0) AS unfinished,COALESCE(SUM(state='interrupted'),0) AS interrupted`;
/** Counts are committed before each real HTTP attempt. Unknown/network outcomes
 * retain their reservations; a process restart cannot reset an account budget. */
export function executeCompanionModelResources(db: CompanionConnection, command: CompanionStorageCommand): CompanionStorageResponse | undefined {
  if (command.type === 'model.resources.config.status') return { ok: true,
    modelResourcesInitialized: !!db.prepare("SELECT 1 FROM metadata WHERE key='companion-model-resources-initialized'").get() };
  if (command.type === 'model.resources.config.initialized') {
    db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('companion-model-resources-initialized',?)").run(new Date().toISOString());
    return { ok: true, modelResourcesInitialized: true };
  }
  if (command.type === 'model.resources.finish') {
    db.prepare("UPDATE companion_model_requests SET state=?,http_status=?,duration_ms=? WHERE id=? AND state='admitted'")
      .run(command.outcome, command.httpStatus ?? null, command.durationMs, command.id); return { ok: true };
  }
  if (command.type !== 'model.resources.admit' && command.type !== 'model.resources.usage') return;
  // Clock rollback cannot reopen an earlier accounting window.
  const observed = Date.now(), latest = db.prepare('SELECT MAX(admitted_at) AS at FROM companion_model_requests').get() as { at: number | null };
  const now = Math.max(observed, latest.at ?? observed), day = Math.floor(now / 86_400_000) * 86_400_000;
  if (command.type === 'model.resources.usage') {
    const filters = ['admitted_at>=?'], values: unknown[] = [day];
    if (command.companionId) { filters.push('companion_id=?'); values.push(command.companionId); }
    if (command.connectionId) { filters.push('connection_id=?'); values.push(command.connectionId); }
    const usage = db.prepare(`SELECT ${totalsSql} FROM companion_model_requests WHERE ${filters.join(' AND ')}`).get(...values) as Totals;
    const purposes = db.prepare(`SELECT COALESCE(p.purpose,'other') AS purpose,COUNT(*) AS requests,SUM(r.input_bytes) AS inputBytes,SUM(r.reserved_output_tokens) AS reservedOutputTokens
      FROM companion_model_requests r LEFT JOIN companion_model_request_purposes p ON p.request_id=r.id
      WHERE ${filters.map(filter => 'r.' + filter).join(' AND ')} AND r.state!='cancelled_before_send' GROUP BY COALESCE(p.purpose,'other')`).all(...values) as NonNullable<NonNullable<CompanionStorageResponse['modelResourceUsage']>['purposes']>;
    return { ok: true, modelResourceUsage: { ...usage, purposes, observedAt: new Date(observed).toISOString(), windowStart: new Date(day).toISOString() } };
  }
  return db.transaction(() => {
    // Recover only a confirmed exited host or an expired request deadline.
    // Reopening a reader must never release another live host's reservation.
    const owners = db.prepare("SELECT DISTINCT host_pid,host_instance FROM companion_model_requests WHERE connection_id=? AND state='admitted'").all(command.connectionId) as Array<{ host_pid: number; host_instance: string }>;
    for (const owner of owners) {
      let alive = true;
      if (owner.host_pid !== command.hostPid) try { process.kill(owner.host_pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (!alive) db.prepare("UPDATE companion_model_requests SET state='interrupted' WHERE connection_id=? AND state='admitted' AND host_pid=? AND host_instance=?")
        .run(command.connectionId, owner.host_pid, owner.host_instance);
    }
    db.prepare("UPDATE companion_model_requests SET state='interrupted' WHERE connection_id=? AND state='admitted' AND lease_until<=?").run(command.connectionId, now);
    const previous = db.prepare('SELECT companion_id,connection_id,policy_revision,input_bytes,reserved_output_tokens FROM companion_model_requests WHERE id=?').get(command.id) as
      { companion_id: string; connection_id: string; policy_revision: string; input_bytes: number; reserved_output_tokens: number } | undefined;
    if (previous) {
      if (previous.companion_id !== command.companionId || previous.connection_id !== command.connectionId || previous.policy_revision !== command.policyRevision
        || previous.input_bytes !== command.inputBytes || previous.reserved_output_tokens !== command.reservedOutputTokens
        || (db.prepare('SELECT purpose FROM companion_model_request_purposes WHERE request_id=?').get(command.id) as { purpose?: string } | undefined)?.purpose !== (command.purpose ?? 'other')) throw new Error('模型准入请求标识已被另一组参数使用。');
      return { ok: true, modelResourceAdmission: { accepted: true, duplicate: true } };
    }
    const minute = db.prepare("SELECT COUNT(*) AS n,MIN(admitted_at) AS oldest FROM companion_model_requests WHERE connection_id=? AND admitted_at>? AND state!='cancelled_before_send'")
      .get(command.connectionId, now - 60_000) as { n: number; oldest: number | null };
    const daily = db.prepare(`SELECT ${totalsSql} FROM companion_model_requests WHERE connection_id=? AND admitted_at>=?`).get(command.connectionId, day) as Totals;
    const cost = command.policy.cost;
    const concurrent = db.prepare("SELECT COUNT(*) AS n FROM companion_model_requests WHERE connection_id=? AND state='admitted'").get(command.connectionId) as { n: number };
    // UTF-8 request bytes are a conservative text-token reservation, including
    // serialized tool/history/image payloads; this is not a provider invoice.
    const reserved = cost ? (BigInt(command.inputBytes) * BigInt(cost.inputMicrosPerMillionTokens) + 999_999n) / 1_000_000n
      + (BigInt(command.reservedOutputTokens) * BigInt(cost.outputMicrosPerMillionTokens) + 999_999n) / 1_000_000n : 0n;
    const unitChanged = !!cost && !!db.prepare("SELECT 1 FROM companion_model_requests WHERE connection_id=? AND admitted_at>=? AND cost_unit IS NOT NULL AND cost_unit!=? AND state!='cancelled_before_send' LIMIT 1").get(command.connectionId, day, cost.unit);
    const reason = concurrent.n >= command.policy.concurrency ? 'concurrency' as const
      : minute.n >= command.policy.requestsPerMinute ? 'requests_minute' as const
      : daily.requests >= command.policy.requestsPerUtcDay ? 'requests_day' as const
      : daily.inputBytes + command.inputBytes > command.policy.inputBytesPerUtcDay ? 'input_day' as const
      : daily.reservedOutputTokens + command.reservedOutputTokens > command.policy.reservedOutputTokensPerUtcDay ? 'output_day' as const
      : unitChanged ? 'cost_unit_changed' as const
      : cost && (reserved > BigInt(Number.MAX_SAFE_INTEGER) || reserved + BigInt(daily.reservedCostMicros) > BigInt(cost.maximumMicrosPerUtcDay)) ? 'cost_day' as const : undefined;
    if (reason) return { ok: true, modelResourceAdmission: { accepted: false, reason,
      retryAt: new Date(reason === 'concurrency' ? now + 1000 : reason === 'requests_minute' ? (minute.oldest ?? now) + 60_000 : day + 86_400_000).toISOString() } };
    db.prepare('INSERT INTO companion_model_requests(id,companion_id,connection_id,admitted_at,host_pid,host_instance,lease_until,policy_revision,input_bytes,reserved_output_tokens,reserved_cost_micros,cost_unit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(command.id, command.companionId, command.connectionId, now, command.hostPid, command.hostInstance, now + 900000, command.policyRevision, command.inputBytes, command.reservedOutputTokens, Number(reserved), cost?.unit ?? null);
    db.prepare('INSERT INTO companion_model_request_purposes(request_id,purpose) VALUES(?,?)').run(command.id, command.purpose ?? 'other');
    return { ok: true, modelResourceAdmission: { accepted: true } };
  }).immediate();
}
