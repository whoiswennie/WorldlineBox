import type { CompanionConnection } from './store';

/** Offline restore only. Old scopes and effects remain audit data, never
 * live screen/file capabilities or evidence that an uncertain send failed. */
export function holdRestoredCompanionAgenda(db: CompanionConnection): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_agenda_runs'").get()) return 0;
  let count = 0;
  count += db.prepare("UPDATE companion_agenda_steps SET status='unknown',data=json_set(data,'$.status','unknown') WHERE status='dispatched'").run().changes;
  const pending = db.prepare("SELECT id,companion_id,occurrence_id,data FROM companion_agenda_runs r WHERE status IN('queued','waiting','running') OR status='parked' AND (json_extract(data,'$.pausedByRuleId') IS NOT NULL OR json_extract(data,'$.pausedByGoalId') IS NOT NULL OR EXISTS(SELECT 1 FROM companion_agenda_steps s WHERE s.run_id=r.id AND s.status='unknown'))").all() as Array<{ id: string; companion_id: string; occurrence_id: string; data: string }>;
  const now = new Date().toISOString();
  for (const row of pending) {
    const unknown = !!db.prepare("SELECT 1 FROM companion_agenda_steps WHERE run_id=? AND status='unknown' LIMIT 1").get(row.id);
    const data = JSON.parse(row.data) as Record<string, unknown>, status = unknown ? 'unknown' : 'parked';
    delete data.leaseToken; delete data.leaseUntil; delete data.pausedByRuleId; delete data.pausedByGoalId;
    Object.assign(data, { status, revision: Number(data.revision) + 1, updatedAt: now,
      stage: unknown ? '备份恢复后存在未核实作用，等待真实回执核对。' : '备份恢复后原执行已搁置，等待明确复核。' });
    count += db.prepare('UPDATE companion_agenda_runs SET status=?,revision=?,lease_until=NULL,data=? WHERE id=?')
      .run(status, data.revision, JSON.stringify(data), row.id).changes;
    db.prepare("UPDATE companion_agenda_occurrences SET state=?,data=json_set(data,'$.state',?) WHERE id=?").run(status, status, row.occurrence_id);
    db.prepare('INSERT INTO companion_agenda_audit(companion_id,entity_id,kind,data,at) VALUES(?,?,?,?,?)')
      .run(row.companion_id, row.id, 'restore.held', JSON.stringify({ status, original: JSON.parse(row.data) }), now);
  }
  count += db.prepare("UPDATE companion_agenda_grants SET status='revoked',revision=revision+1,data=json_set(data,'$.status','revoked','$.revision',revision+1,'$.updatedAt',?) WHERE status='active'").run(now).changes;
  return count;
}

export function assertRestoredCompanionAgendaHeld(db: CompanionConnection, owner: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_agenda_runs'").get()) return;
  if (db.prepare("SELECT 1 FROM companion_agenda_runs WHERE companion_id=? AND (status IN('queued','waiting','running') OR lease_until IS NOT NULL OR json_extract(data,'$.leaseToken') IS NOT NULL) LIMIT 1").get(owner)
    || db.prepare("SELECT 1 FROM companion_agenda_grants WHERE companion_id=? AND status='active' LIMIT 1").get(owner))
    throw new Error('恢复后的原日程或持续能力尚未全部搁置，不能清除复核门。');
}
