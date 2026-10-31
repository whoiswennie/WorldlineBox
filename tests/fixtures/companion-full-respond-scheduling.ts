/** Read-only scheduling evidence for the isolated real-library benchmark.
 * This does not request extra worker work or change admission, quotas or clocks.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { companionTaskActiveCount, companionTaskConcurrencyLimit } from '../../src/companions/task-concurrency-store';
import type { CompanionConnection } from '../../src/companions/store';

type Command = { type: string; companionId?: string; id?: string };
type Row = Record<string, string | number | null>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

export function createFullRespondSchedulingProbe(input: {
  root: string; nowMs(): number; phase(): string; owners(): Map<string, string>; targetSources(): Set<string>;
}) {
  if (!path.basename(input.root).startsWith('wlb-full-respond-')) throw new Error('Scheduling probe requires the isolated clone.');
  const Driver = Database as { new(filename: string, options: { readonly: boolean; fileMustExist: boolean }): CompanionConnection };
  const db = new Driver(path.join(input.root, 'messages.sqlite'), { readonly: true, fileMustExist: true });
  const timeline: unknown[] = [], last = new Map<string, string>();
  function observe(command: Command, response: { ok?: boolean; agendaClaim?: { rule: { executor: string } }; socialJob?: { sourceMessageId: string } }) {
    if (!['agenda.claim', 'social.job.claim', 'agenda.run.settle', 'social.job.defer', 'social.job.control'].includes(command.type) || !command.companionId) return;
    const label = input.owners().get(command.companionId); if (!label) return;
    const now = new Date().toISOString();
    const runs = db.prepare(`SELECT r.id,r.status,r.not_before,r.lease_until,json_extract(r.data,'$.stage') AS stage,
      json_extract(r.data,'$.cycleFailureCount') AS failure_count,json_extract(o.rule_data,'$.executor') AS executor,
      json_extract(o.rule_data,'$.referenceVersion') AS reference_version,
      json_extract(o.rule_data,'$.sourceMessageId') AS source_id
      FROM companion_agenda_runs r JOIN companion_agenda_occurrences o ON o.id=r.occurrence_id
      WHERE r.companion_id=? AND (r.status IN('queued','waiting','running') OR json_extract(r.data,'$.updatedAt')>?) ORDER BY r.created_at,r.id LIMIT 40`)
      .all(command.companionId, new Date(Date.now() - 10000).toISOString()) as Row[];
    const mappedRuns = runs.map(row => ({ run: hash(String(row.id)), status: row.status, executor: row.executor,
      native: row.reference_version === 'world-native-v1', target: input.targetSources().has(String(row.source_id)),
      notBeforeInSeconds: Math.max(0, Math.ceil((Date.parse(String(row.not_before)) - Date.now()) / 1000)),
      failures: row.failure_count, stage: row.stage === '等待本事项需要的资源可用' ? 'resource_wait'
        : row.stage === '等待上次同类事项的实际结果' ? 'overlap_wait'
          : row.stage === '等待该伙伴正在进行的世界行为完成。' ? 'world_owner_wait'
            : row.stage === '等待当前事件范围内的有效持续授权' ? 'authorization_wait'
              : row.stage === '正在执行' ? 'executing' : hash(String(row.stage)) }));
    const jobs = db.prepare(`SELECT status,lease_until,json_extract(data,'$.sourceMessageId') AS source_id,
      json_extract(data,'$.attempts') AS attempts,json_extract(data,'$.agendaRetryAt') AS retry_at,
      json_extract(data,'$.agendaUncertain') AS uncertain,json_extract(data,'$.channel') AS channel
      FROM companion_social_jobs WHERE companion_id=? AND status IN('pending','running','failed','parked') ORDER BY rowid LIMIT 30`)
      .all(command.companionId) as Row[];
    const communication = db.prepare(`SELECT json_extract(data,'$.channel') AS channel,json_extract(data,'$.phase') AS phase,
      until_real FROM companion_social_communication WHERE companion_id=? AND until_real>?`).get(command.companionId, now) as Row | undefined;
    const queued = db.prepare(`SELECT status,count(*) AS count FROM companion_work_queue WHERE companion_id=?
      AND status IN('queued','running','interrupted') GROUP BY status`).all(command.companionId) as Row[];
    const world = db.prepare(`SELECT json_extract(data,'$.cursor') AS cursor FROM companion_world WHERE id=1`).get() as Row | undefined;
    const bodyWorks = db.prepare(`SELECT json_extract(w.value,'$.kind') AS kind,json_extract(w.value,'$.status') AS status,
      json_extract(w.value,'$.sourceMessageId') AS source_id FROM companion_world, json_each(data,'$.works') w
      WHERE companion_world.id=1 AND json_extract(w.value,'$.companionId')=? AND json_extract(w.value,'$.status')!='ended'`)
      .all(command.companionId) as Row[];
    const summary = { owner: label, operation: command.type, claimed: response.agendaClaim?.rule.executor ?? (response.socialJob ? 'social' : false),
      ok: response.ok, agenda: mappedRuns, social: jobs.map(row => ({ target: input.targetSources().has(String(row.source_id)),
        status: row.status, attempts: row.attempts, uncertain: row.uncertain, channel: row.channel,
        leaseInSeconds: row.lease_until ? Math.max(0, Math.ceil((Date.parse(String(row.lease_until)) - Date.now()) / 1000)) : 0,
        retryInSeconds: row.retry_at ? Math.max(0, Math.ceil((Date.parse(String(row.retry_at)) - Date.now()) / 1000)) : 0 })),
      taskCapacity: { active: companionTaskActiveCount(db, command.companionId), limit: companionTaskConcurrencyLimit(db, command.companionId) },
      queued, bodyWorks: bodyWorks.map(row => ({ kind: row.kind, status: row.status, target: input.targetSources().has(String(row.source_id)) })),
      communication: communication ? { channel: communication.channel, phase: communication.phase,
        leaseInSeconds: Math.max(0, Math.ceil((Date.parse(String(communication.until_real)) - Date.now()) / 1000)) } : undefined,
      worldLagSeconds: world ? Math.max(0, Math.ceil((Date.now() - Number(world.cursor)) / 1000)) : undefined };
    const identity = input.phase() + ':' + label + ':' + command.type, encoded = JSON.stringify(summary);
    if (last.get(identity) === encoded || timeline.length >= 600) return;
    last.set(identity, encoded); timeline.push({ phase: input.phase(), atMs: input.nowMs(), ...summary });
  }
  const transact = db.transaction.bind(db) as unknown as <Args extends unknown[], Result>(callback: (...args: Args) => Result) => { deferred(...args: Args): Result };
  const consistentObservation = transact(observe);
  const resources = transact((companionId: string, sourceMessageId: string) => {
    const body = db.prepare(`SELECT count(*) AS count FROM companion_world, json_each(data,'$.works') w
      WHERE companion_world.id=1 AND json_extract(w.value,'$.companionId')=? AND json_extract(w.value,'$.sourceMessageId')=?
      AND json_extract(w.value,'$.status')!='ended'`).get(companionId, sourceMessageId) as { count: number };
    const priority = db.prepare(`SELECT count(*) AS count FROM companion_focus_interruptions WHERE companion_id=?
      AND status='active' AND json_extract(data,'$.sourceMessageId')=?`).get(companionId, sourceMessageId) as { count: number };
    return { worldWorksActive: body.count, priorityActive: priority.count };
  });
  const progress = transact((sourceIds: string[], chainIds: string[]) => {
    const counts = (table: string, field: string, ids: string[]) => !ids.length ? {} : Object.fromEntries((db.prepare(
      `SELECT status,count(*) AS total FROM ${table} WHERE json_extract(data,'$.${field}') IN(${ids.map(() => '?').join(',')}) GROUP BY status`)
      .all(...ids) as Array<{ status: string; total: number }>).map(value => [value.status, value.total]));
    return { reply: counts('companion_work_queue', 'sourceMessageId', sourceIds),
      peer: counts('companion_social_jobs', 'sourceMessageId', sourceIds),
      chain: counts('companion_social_jobs', 'chainId', chainIds) };
  });
  const socialReceiptForJob = transact((jobId: string) => db.prepare(`
    SELECT o.client_id AS clientId,o.status,o.message_id AS messageId,
      j.id AS jobId,j.companion_id AS companionId,json_extract(j.data,'$.chainId') AS chainId
    FROM companion_social_jobs j JOIN messages m ON m.id=json_extract(j.data,'$.sourceMessageId')
    JOIN companion_social_outbox o ON o.client_id=m.client_id AND o.message_id=m.id AND o.status='sent'
    WHERE j.id=?`).get(jobId) as { clientId: string; status: string; messageId: string; jobId: string; companionId: string; chainId: string } | undefined);
  return { observe: (command: Command, response: Parameters<typeof observe>[1]) => consistentObservation.deferred(command, response),
    resources: (companionId: string, sourceMessageId: string) => resources.deferred(companionId, sourceMessageId),
    progress: (sourceIds: string[], chainIds: string[]) => progress.deferred(sourceIds, chainIds),
    socialReceiptForJob: (jobId: string) => socialReceiptForJob.deferred(jobId),
    snapshot: () => timeline, close: () => db.close() };
}
