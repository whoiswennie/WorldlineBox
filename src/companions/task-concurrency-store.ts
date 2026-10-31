import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { COMPANION_DEFAULT_TASK_CONCURRENCY } from '../shared/companion-task-concurrency';

type Kind = 'reply' | 'action' | 'activity' | 'work-order' | 'schedule_occurrence' | 'social' | 'notification' | 'world' | 'life' | 'learning' | 'learning_goal';
type Entry = { kind: Kind; id: string };
/** Admission reads and the caller's status transition share one IMMEDIATE
 * worker transaction. Room IDs never partition a companion's budget. */
export function companionTaskConcurrencyLimit(db: CompanionConnection, owner: string): number {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get('task-concurrency/' + owner) as { value: string } | undefined;
  const value = row ? Number(row.value) : COMPANION_DEFAULT_TASK_CONCURRENCY;
  return Number.isSafeInteger(value) && value >= 1 && value <= 10 ? value : COMPANION_DEFAULT_TASK_CONCURRENCY;
}
function active(db: CompanionConnection, owner: string): Entry[] {
  const agenda = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_agenda_runs'").get();
  return db.prepare(`
    WITH live_orders AS (
      SELECT q.id FROM companion_work_orders q WHERE q.companion_id=@owner AND q.status='running'
      AND (q.lease_until>@iso OR EXISTS(SELECT 1 FROM actions a WHERE a.companion_id=q.companion_id AND a.status='running' AND json_extract(a.data,'$.workOrderId')=q.id))
    ), live_occurrences AS (
      SELECT q.id FROM companion_schedule_occurrences q JOIN companion_schedules s ON s.id=q.schedule_id WHERE s.companion_id=@owner AND q.status IN('dispatching','running')
      AND (q.lease_until>@iso OR EXISTS(SELECT 1 FROM actions a WHERE a.companion_id=s.companion_id AND a.status='running' AND json_extract(a.data,'$.scheduleOccurrenceId')=q.id)
        OR EXISTS(SELECT 1 FROM companion_activity_tasks a WHERE a.companion_id=s.companion_id AND a.status='running' AND json_extract(a.data,'$.leaseUntil')>@now AND (json_extract(q.data,'$.activityTaskId')=a.id OR json_extract(a.data,'$.clientId')='schedule_activity_'||q.id)))
    )
    SELECT 'reply' AS kind,q.id FROM companion_work_queue q WHERE q.companion_id=@owner AND q.status='running'
      ${agenda ? "AND NOT EXISTS(SELECT 1 FROM companion_agenda_runs r WHERE r.id=json_extract(q.data,'$.agendaRunId') AND r.companion_id=q.companion_id AND r.status='running' AND r.lease_until>@iso)" : ''}
    UNION ALL SELECT 'action',a.id FROM actions a WHERE a.companion_id=@owner AND a.status='running'
      AND json_extract(a.data,'$.thought') IS NULL
      AND json_type(a.data,'$.capability') IS NULL
      ${agenda ? "AND NOT EXISTS(SELECT 1 FROM companion_agenda_runs r WHERE r.id=json_extract(a.data,'$.agendaRunId') AND r.companion_id=a.companion_id AND r.status='running')" : ''}
      AND NOT EXISTS(SELECT 1 FROM companion_work_queue q WHERE q.companion_id=a.companion_id AND q.status='running' AND json_extract(q.data,'$.messageId')=json_extract(a.data,'$.parentMessageId'))
      AND NOT EXISTS(SELECT 1 FROM live_orders q WHERE q.id=json_extract(a.data,'$.workOrderId'))
      AND NOT EXISTS(SELECT 1 FROM live_occurrences q WHERE q.id=json_extract(a.data,'$.scheduleOccurrenceId'))
    UNION ALL SELECT 'activity',a.id FROM companion_activity_tasks a WHERE a.companion_id=@owner AND a.status='running' AND json_extract(a.data,'$.leaseUntil')>@now
      ${agenda ? "AND NOT EXISTS(SELECT 1 FROM companion_agenda_runs r WHERE r.id=json_extract(a.data,'$.agendaRunId') AND r.companion_id=a.companion_id AND r.status='running' AND r.lease_until>@iso AND json_extract(r.data,'$.leaseToken')=json_extract(a.data,'$.agendaLeaseToken'))" : ''}
      AND NOT EXISTS(SELECT 1 FROM live_occurrences q JOIN companion_schedule_occurrences o ON o.id=q.id WHERE json_extract(o.data,'$.activityTaskId')=a.id OR json_extract(a.data,'$.clientId')='schedule_activity_'||o.id)
    UNION ALL SELECT 'work-order',id FROM live_orders
    UNION ALL SELECT 'schedule_occurrence',id FROM live_occurrences
    UNION ALL SELECT 'social',j.id FROM companion_social_jobs j WHERE j.companion_id=@owner AND j.status='running' AND j.lease_until>@iso
      ${agenda ? "AND NOT EXISTS(SELECT 1 FROM metadata m JOIN companion_agenda_runs r ON r.id=json_extract(m.value,'$.runId') WHERE m.key='agenda-native-parent/social/'||j.id AND r.companion_id=j.companion_id AND r.status='running' AND r.lease_until>@iso AND json_extract(r.data,'$.leaseToken')=json_extract(m.value,'$.leaseToken') AND json_extract(j.data,'$.leaseToken')=json_extract(m.value,'$.nativeLeaseToken'))" : ''}
    UNION ALL SELECT 'notification',j.id FROM companion_social_notifications j WHERE j.companion_id=@owner AND j.status='running' AND j.lease_until>@iso
      ${agenda ? "AND NOT EXISTS(SELECT 1 FROM metadata m JOIN companion_agenda_runs r ON r.id=json_extract(m.value,'$.runId') WHERE m.key='agenda-native-parent/notification/'||j.id AND r.companion_id=j.companion_id AND r.status='running' AND r.lease_until>@iso AND json_extract(r.data,'$.leaseToken')=json_extract(m.value,'$.leaseToken') AND json_extract(j.data,'$.leaseToken')=json_extract(m.value,'$.nativeLeaseToken'))" : ''}
    UNION ALL SELECT 'world',j.id FROM companion_world_jobs j WHERE j.companion_id=@owner AND j.kind!='dream' AND j.status='running' AND j.lease_until>@iso
      ${agenda ? "AND NOT EXISTS(SELECT 1 FROM metadata m JOIN companion_agenda_runs r ON r.id=json_extract(m.value,'$.runId') WHERE m.key='agenda-native-parent/decision/'||j.id AND r.companion_id=j.companion_id AND r.status='running' AND r.lease_until>@iso AND json_extract(r.data,'$.leaseToken')=json_extract(m.value,'$.leaseToken') AND json_extract(j.data,'$.leaseToken')=json_extract(m.value,'$.nativeLeaseToken'))" : ''}
    UNION ALL SELECT 'life',id FROM companion_life_occurrences WHERE companion_id=@owner AND status='running' AND lease_until>@iso
    UNION ALL SELECT 'learning',id FROM companion_learning_grants WHERE companion_id=@owner AND enabled=1 AND lease_token IS NOT NULL AND lease_until>@now
    UNION ALL SELECT 'learning_goal',id FROM companion_learning_goals WHERE companion_id=@owner AND state='active' AND lease_token IS NOT NULL AND lease_until>@now
      ${agenda ? "AND NOT EXISTS(SELECT 1 FROM metadata m JOIN companion_agenda_runs r ON r.id=json_extract(m.value,'$.runId') WHERE m.key='agenda-learning-parent/'||companion_learning_goals.id AND r.companion_id=companion_learning_goals.companion_id AND r.status='running' AND r.lease_until>@iso)" : ''}
  `).all({ owner, now: Date.now(), iso: new Date().toISOString() }) as Entry[];
}
/** Cutover admission counts existing domain roots once. New agenda parents
 * own their child actions; the child does not consume another cognitive slot. */
export function companionTaskLegacyActiveCount(db: CompanionConnection, owner: string): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_work_queue'").get()) return 0;
  return active(db, owner).length;
}
export function companionTaskActiveCount(db: CompanionConnection, owner: string): number {
  const legacy = companionTaskLegacyActiveCount(db, owner);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_agenda_runs'").get()) return legacy;
  const agenda = db.prepare("SELECT count(*) AS n FROM companion_agenda_runs WHERE companion_id=? AND status='running' AND lease_until>?")
    .get(owner, new Date().toISOString()) as { n: number };
  return legacy + agenda.n;
}
export function companionTaskCanClaim(db: CompanionConnection, owner: string, current?: Entry): boolean {
  const alreadyCounted = !!current && active(db, owner).some(item => item.kind === current.kind && item.id === current.id);
  return companionTaskActiveCount(db, owner) - (alreadyCounted ? 1 : 0) < companionTaskConcurrencyLimit(db, owner);
}
export class CompanionTaskConcurrencyStore {
  constructor(private readonly db: CompanionConnection) {}
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type === 'tasks.capacity.claim-action') return this.db.transaction(() => {
      const found = this.db.prepare('SELECT data FROM actions WHERE id=?').get(command.id) as { data: string } | undefined;
      if (!found) return { ok: true, taskCapacityClaimed: false };
      const action = JSON.parse(found.data);
      if (action.capability) throw new Error('能力过程卡是原任务的子步骤，不能作为独立DSH任务认领。');
      if (action.status === 'running') return { ok: true, taskCapacityClaimed: true };
      if (action.status !== 'queued') return { ok: true, taskCapacityClaimed: false };
      const child = !!action.thought || !!(action.parentMessageId && this.db.prepare("SELECT 1 FROM companion_work_queue WHERE companion_id=? AND status='running' AND json_extract(data,'$.messageId')=?").get(action.companionId, action.parentMessageId))
        || !!(action.workOrderId && this.db.prepare("SELECT 1 FROM companion_work_orders WHERE id=? AND companion_id=? AND status='running'").get(action.workOrderId, action.companionId))
        || !!(action.scheduleOccurrenceId && this.db.prepare("SELECT 1 FROM companion_schedule_occurrences o JOIN companion_schedules s ON s.id=o.schedule_id WHERE o.id=? AND s.companion_id=? AND o.status IN('dispatching','running')").get(action.scheduleOccurrenceId, action.companionId))
        || !!(action.agendaRunId && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_agenda_runs'").get()
          && this.db.prepare("SELECT 1 FROM companion_agenda_runs WHERE id=? AND companion_id=? AND status='running' AND lease_until>?").get(action.agendaRunId, action.companionId, new Date().toISOString()));
      if (!child && !companionTaskCanClaim(this.db, action.companionId)) return { ok: true, taskCapacityClaimed: false };
      action.status = 'running'; action.updatedAt = new Date().toISOString();
      this.db.prepare("UPDATE actions SET status='running',data=? WHERE id=?").run(JSON.stringify(action), action.id);
      return { ok: true, taskCapacityClaimed: true };
    }).immediate();
    if (command.type !== 'tasks.concurrency.get' && command.type !== 'tasks.concurrency.set') return;
    return this.db.transaction(() => {
      const hasAgenda = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_agenda_runs'").get();
      const owners = this.db.prepare(`SELECT id FROM companions WHERE deleted_at IS NULL${command.companionId ? ' AND id=?' : ''} ORDER BY rowid`).all(...(command.companionId ? [command.companionId] : [])) as Array<{ id: string }>;
      if (command.companionId && !owners.length) throw new Error('伙伴不存在。');
      if (command.type === 'tasks.concurrency.set') this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('task-concurrency/' + command.companionId, String(command.limit));
      return { ok: true, taskConcurrency: { defaultLimit: 3 as const, policies: owners.map(({ id: companionId }) => {
        const waiting = this.db.prepare(`SELECT count(*) AS total FROM (
          SELECT id FROM companion_work_queue WHERE companion_id=@owner AND status IN('queued','interrupted')
          UNION ALL SELECT id FROM actions WHERE companion_id=@owner AND status='queued' AND json_extract(data,'$.parentMessageId') IS NULL AND json_extract(data,'$.workOrderId') IS NULL AND json_extract(data,'$.scheduleOccurrenceId') IS NULL AND json_extract(data,'$.thought') IS NULL AND json_type(data,'$.capability') IS NULL
          UNION ALL SELECT id FROM companion_work_orders WHERE companion_id=@owner AND status='accepted'
          UNION ALL SELECT a.id FROM companion_activity_tasks a WHERE a.companion_id=@owner AND a.status IN('queued','waiting')
            ${hasAgenda ? "AND NOT EXISTS(SELECT 1 FROM companion_agenda_runs r WHERE r.id=json_extract(a.data,'$.agendaRunId') AND r.companion_id=a.companion_id AND r.status IN('queued','running','waiting','parked'))" : ''}
          UNION ALL SELECT o.id FROM companion_schedule_occurrences o JOIN companion_schedules s ON s.id=o.schedule_id WHERE s.companion_id=@owner AND o.status='pending'
          UNION ALL SELECT id FROM companion_social_jobs WHERE companion_id=@owner AND status IN('pending','failed') AND COALESCE(json_extract(data,'$.terminal'),0)=0
          UNION ALL SELECT id FROM companion_social_notifications WHERE companion_id=@owner AND status IN('pending','failed') AND COALESCE(json_extract(data,'$.terminal'),0)=0
          UNION ALL SELECT id FROM companion_world_jobs WHERE companion_id=@owner AND kind!='dream' AND status IN('pending','failed') AND COALESCE(json_extract(data,'$.terminal'),0)=0
          UNION ALL SELECT id FROM companion_life_occurrences WHERE companion_id=@owner AND status='pending'
          UNION ALL SELECT id FROM companion_learning_grants WHERE companion_id=@owner AND enabled=1 AND (autonomous=1 OR manual=1) AND next_at<=@now AND lease_until<=@now
          UNION ALL SELECT id FROM companion_learning_goals WHERE companion_id=@owner AND state='active' AND next_at<=@now AND lease_until<=@now
        )`).get({ owner: companionId, now: Date.now() }) as { total: number };
        return { companionId, limit: companionTaskConcurrencyLimit(this.db, companionId), active: companionTaskActiveCount(this.db, companionId), queued: waiting.total };
      }) } };
    }).immediate();
  }
}
