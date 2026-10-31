import type { CompanionConnection } from './store';
import { assertRestoredCompanionAgendaHeld, holdRestoredCompanionAgenda } from './agenda-recovery-hold';

const open = "('pending','running','failed','deferred','queued','waiting_model','interrupted')";
export function assertRestoredCompanionWorkHeld(db:CompanionConnection,ownerId:string):void{
  assertRestoredCompanionAgendaHeld(db,ownerId);
  if(db.prepare("SELECT 1 FROM companion_learning_asset_job_history WHERE companion_id=? AND (job_status!='stale' OR status!='withdrawn') LIMIT 1").get(ownerId))throw new Error('历史学习输入不是已撤回的终结元数据，不能作为恢复后自动作业。');
  for(const table of ['vcp_capture_jobs','vcp_memory_outbox','companion_memory_tag_jobs','companion_memory_source_outbox','companion_memory_history_outbox','companion_topic_compaction_jobs','companion_world_jobs','companion_task_timeline_jobs','companion_learning_goal_rounds','companion_learning_grants'])
    if(db.prepare(`SELECT 1 FROM ${table} WHERE companion_id=? AND status IN${open} LIMIT 1`).get(ownerId))throw new Error('恢复后的原作业尚未全部搁置，不能清除核对门。');
  if(db.prepare("SELECT 1 FROM companion_topic_compaction_jobs WHERE companion_id=? AND status='stale' AND reconcile_needed=1 LIMIT 1").get(ownerId))throw new Error('恢复后的话题重读欠账尚未搁置，不能清除核对门。');
  if(db.prepare(`SELECT 1 FROM companion_learning_observed_assets WHERE companion_id=? AND job_status IN${open} LIMIT 1`).get(ownerId)
    ||db.prepare("SELECT 1 FROM companion_work_queue WHERE companion_id=? AND (status IN('queued','running') OR json_extract(data,'$.resumeOnRestart')=1) LIMIT 1").get(ownerId)
    ||db.prepare("SELECT 1 FROM actions WHERE companion_id=? AND status IN('queued','running') LIMIT 1").get(ownerId))throw new Error('恢复后的原发送任务尚未核对，不能清除核对门。');
  for(const table of ['companion_world_jobs','companion_task_timeline_jobs','companion_learning_goal_rounds','companion_learning_grants'])
    if(db.prepare(`SELECT 1 FROM ${table} WHERE companion_id=? AND status='parked' AND json_extract(data,'$.status') IS NOT 'parked' LIMIT 1`).get(ownerId))throw new Error('恢复后的作业正文与正式搁置状态不一致。');
}
/** Operates only on a verified, offline current-generation restore stage.
 * A hold preserves inputs, results, grants, counters and fixed attempts. */
export function holdRestoredCompanionWork(db: CompanionConnection): { owners: number; jobs: number } {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
  let jobs = holdRestoredCompanionAgenda(db);
  const update = (table: string, assignments: string, where: string) => { if (tables.has(table)) jobs += db.prepare(`UPDATE ${table} SET ${assignments} WHERE ${where}`).run().changes; };
  for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox', 'companion_memory_tag_jobs', 'companion_memory_source_outbox', 'companion_memory_history_outbox'])
    update(table, `status=CASE WHEN status IN${open} THEN 'parked' ELSE status END,disposition_revision=disposition_revision+1,lease_token=NULL,lease_until=NULL,next_attempt=0`, '1');
  update('companion_topic_compaction_jobs', `status=CASE WHEN status IN${open} OR (status='stale' AND reconcile_needed=1) THEN 'parked' ELSE status END,disposition_revision=disposition_revision+1,lease_token=NULL,lease_until=NULL,next_attempt=0`, '1');
  const state=`status=CASE WHEN status IN${open} THEN 'parked' ELSE status END,disposition_revision=disposition_revision+1`;
  update('companion_world_jobs', `${state},data=CASE WHEN status IN${open} THEN json_remove(json_set(data,'$.status','parked'),'$.leaseToken','$.nextAttemptAt') ELSE data END,lease_until=NULL`, '1');
  update('companion_task_timeline_jobs', `${state},data=CASE WHEN status IN${open} THEN json_remove(json_set(data,'$.status','parked'),'$.leaseToken','$.nextAttemptAt') ELSE data END`, '1');
  update('companion_learning_goal_rounds', `${state},data=CASE WHEN status IN${open} THEN json_set(data,'$.status','parked') ELSE data END`, '1');
  update('companion_learning_goals', 'lease_token=NULL,lease_until=0', 'lease_token IS NOT NULL OR lease_until!=0');
  update('companion_learning_grants', `${state},data=CASE WHEN status IN${open} THEN json_remove(json_set(data,'$.status','parked'),'$.leaseToken') ELSE data END,lease_token=NULL,lease_until=0,active_job_id=NULL`, '1');
  update('companion_learning_observed_assets', `job_status=CASE WHEN job_status IN${open} THEN 'parked' ELSE job_status END,disposition_revision=disposition_revision+1,retry_requested=0,job_next_at=0`, 'job_id IS NOT NULL');
  // companion_learning_asset_job_history is immutable stale metadata, with no
  // source bytes, active grant pointer or worker consumer to revive on restore.
  // Native actions are kept as explicit interrupted work, never converted to a
  // successful result or the restart marker that automatically resends HTTP.
  update('actions', "status='interrupted',data=json_remove(json_set(data,'$.status','interrupted'),'$.resumeOnRestart')", "status IN('queued','running')");
  update('companion_work_queue', "status='interrupted',data=json_remove(json_set(data,'$.status','interrupted'),'$.resumeOnRestart')", "status IN('queued','running','interrupted')");
  if (tables.has('metadata')) {
    const rows = db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'loop/%' OR key LIKE 'message-loop/%'").all() as { key: string; value: string }[];
    for (const row of rows) {
      const data = JSON.parse(row.value) as { progress?: { phase?: string; detail?: string } };
      if (data.progress && !['completed', 'cancelled'].includes(data.progress.phase ?? '')) {
        data.progress = { ...data.progress, phase: 'interrupted', detail: '备份恢复后需核对先前发送结果；不会自动重发。' };
        db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(data), row.key);
      }
    }
  }
  const owners = db.prepare('SELECT id FROM companions WHERE deleted_at IS NULL').all() as { id: string }[];
  db.prepare("UPDATE companions SET data=json_set(data,'$.active',json('false')) WHERE deleted_at IS NULL").run();
  for (const owner of owners) db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('recovery-review-required/' + owner.id, '1');
  return { owners: owners.length, jobs };
}
