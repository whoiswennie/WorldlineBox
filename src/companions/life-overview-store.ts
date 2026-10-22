import { z } from 'zod';
import type { CompanionConnection } from './store';
import { companionLifeOverviewReadCommand, companionLifeOverviewFilterSchema, type CompanionLifeOverviewContext, type CompanionLifeOverviewItem } from '../shared/companion-life-overview';
import { companionCivilInstantInZone, companionTimeInZone } from '../shared/companion-schedule-time';

type Row = Record<string, string | number | null>;
const cursorSchema = z.strictObject({ v: z.literal(1), owner: z.string(), filter: companionLifeOverviewFilterSchema, rank: z.number().int().min(0).max(10), at: z.string().max(100), key: z.string().max(180) });
export function initializeCompanionLifeOverview(db: CompanionConnection): void {
  db.exec(`CREATE INDEX IF NOT EXISTS companion_overview_actions ON actions(companion_id,status,json_extract(data,'$.updatedAt'),id);
    CREATE INDEX IF NOT EXISTS companion_overview_activity ON companion_activity_tasks(companion_id,status,json_extract(data,'$.updatedAt'),id);
    CREATE INDEX IF NOT EXISTS companion_overview_schedules ON companion_schedules(companion_id,status,next_run_at,id);
    CREATE INDEX IF NOT EXISTS companion_overview_life ON companion_life_occurrences(companion_id,status,window_start,id);`);
}
const columns = (kind: string, alias: string, title: string, section: string, rank: string, time: string, stage: string, conversation: string,
  extras = "NULL AS at,NULL AS window_start,NULL AS window_end,NULL AS probability,NULL AS start_minute,NULL AS end_minute,NULL AS check_minutes,'real' AS clock") =>
  `'${kind}:'||${alias}.id AS uid,${alias}.id AS id,'${kind}' AS kind,SUBSTR(COALESCE(${title},''),1,160) AS title,${alias}.status AS status,${section} AS section,${rank} AS rank,COALESCE(${time},'') AS sort_at,SUBSTR(COALESCE(${stage},''),1,500) AS stage,${conversation} AS conversation_id,SUBSTR(COALESCE(json_extract(${alias}.data,'$.updatedAt'),json_extract(${alias}.data,'$.createdAt'),''),1,40) AS updated_at,${extras}`;
const liveConversation = (alias: string) => `EXISTS(SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=${alias}.conversation_id AND c.dissolved_at IS NULL AND m.companion_id=@owner)`;

/** Only small metadata columns cross SQLite; historical task bodies never enter this page. */
export function readCompanionLifeOverviewPage(db: CompanionConnection, request: z.input<typeof companionLifeOverviewReadCommand>,
  clock: CompanionLifeOverviewContext['clock']): Pick<CompanionLifeOverviewContext, 'items' | 'hasMore' | 'nextCursor'> {
  const query = companionLifeOverviewReadCommand.parse(request);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
    catch { throw new Error('生活总览分页已失效，请重新查看。'); }
    if (cursor.owner !== query.companionId || cursor.filter !== query.filter) throw new Error('生活总览分页不属于当前伙伴或筛选条件。');
  }
  const action = columns('action', 'a', "json_extract(a.data,'$.title')", "CASE WHEN a.status IN('failed','interrupted') THEN 'attention' ELSE 'current' END",
    "CASE WHEN a.status IN('failed','interrupted') THEN 0 WHEN a.status='running' THEN 1 ELSE 2 END", "json_extract(a.data,'$.updatedAt')", "json_extract(a.data,'$.stage')", 'a.conversation_id');
  const activity = columns('activity', 'a', "json_extract(a.data,'$.title')", "CASE WHEN a.status='failed' THEN 'attention' ELSE 'current' END",
    "CASE WHEN a.status='failed' THEN 0 WHEN a.status='running' THEN 1 ELSE 2 END", "json_extract(a.data,'$.updatedAt')", "json_extract(a.data,'$.stage')", 'a.conversation_id');
  const schedule = columns('schedule', 's', "json_extract(s.data,'$.title')", "CASE WHEN s.status='paused' OR json_extract(s.data,'$.blockedReason') IS NOT NULL THEN 'attention' ELSE 'upcoming' END",
    "CASE WHEN s.status='paused' OR json_extract(s.data,'$.blockedReason') IS NOT NULL THEN 0 ELSE 4 END", "COALESCE(s.next_run_at,json_extract(s.data,'$.updatedAt'))", "json_extract(s.data,'$.blockedReason')", 's.conversation_id',
    "COALESCE(s.deferred_until,s.next_run_at) AS at,NULL AS window_start,NULL AS window_end,NULL AS probability,NULL AS start_minute,NULL AS end_minute,NULL AS check_minutes,CASE WHEN s.deferred_until IS NOT NULL THEN 'real' ELSE 'world' END AS clock");
  const occurrence = columns('life_event', 'o', "json_extract(o.data,'$.rule.title')", "CASE WHEN o.status='failed' THEN 'attention' WHEN o.status='observing' THEN 'events' ELSE 'current' END",
    "CASE WHEN o.status='failed' THEN 0 WHEN o.status IN('running','active') THEN 1 WHEN o.status='pending' THEN 2 ELSE 5 END", 'o.window_start', "json_extract(o.data,'$.reason')", 'NULL',
    "json_extract(o.data,'$.nextEligibleAt') AS at,json_extract(o.data,'$.windowStart') AS window_start,json_extract(o.data,'$.windowEnd') AS window_end,json_extract(o.data,'$.rule.probability') AS probability,NULL AS start_minute,NULL AS end_minute,NULL AS check_minutes,'world' AS clock");
  // A rule is a configured opportunity, not an execution or a promise that it will fire.
  const rules = `SELECT 'life_rule:'||r.id AS uid,r.id AS id,'life_rule' AS kind,SUBSTR(COALESCE(json_extract(r.data,'$.title'),''),1,160) AS title,'enabled' AS status,'events' AS section,6 AS rank,COALESCE(json_extract(r.data,'$.createdAt'),'') AS sort_at,'' AS stage,NULL AS conversation_id,NULL AS updated_at,NULL AS at,NULL AS window_start,NULL AS window_end,json_extract(r.data,'$.probability') AS probability,json_extract(r.data,'$.startMinute') AS start_minute,json_extract(r.data,'$.endMinute') AS end_minute,COALESCE(json_extract(r.data,'$.checkIntervalMinutes'),15) AS check_minutes,'world' AS clock FROM companion_life_rules r WHERE r.companion_id=@owner AND r.enabled=1 AND NOT EXISTS(SELECT 1 FROM metadata m WHERE m.key='life-rule-removed/'||r.id)`;
  const sql = `WITH candidates AS (
    SELECT ${action} FROM actions a WHERE a.companion_id=@owner AND a.status IN('queued','running','interrupted','failed') AND ${liveConversation('a')}
    UNION ALL SELECT ${activity} FROM companion_activity_tasks a WHERE a.companion_id=@owner AND a.status IN('queued','running','waiting','failed') AND ${liveConversation('a')}
    UNION ALL SELECT ${schedule} FROM companion_schedules s WHERE s.companion_id=@owner AND s.status IN('active','paused') AND (s.next_run_at IS NOT NULL OR s.status='paused') AND ${liveConversation('s')}
    UNION ALL SELECT ${occurrence} FROM companion_life_occurrences o JOIN companion_life_rules r ON r.id=o.rule_id AND r.enabled=1 WHERE o.companion_id=@owner AND (o.status IN('observing','pending','running','active') OR o.status='failed' AND json_extract(o.data,'$.nextEligibleAt')>@world_now)
    UNION ALL ${rules}
  ) SELECT * FROM candidates WHERE (@filter='all' OR section=@filter OR @filter='events' AND kind IN('life_event','life_rule') OR @filter='upcoming' AND kind='life_rule')
    AND (@has_cursor=0 OR rank>@rank OR rank=@rank AND (sort_at>@at OR sort_at=@at AND uid>@key))
    ORDER BY rank,sort_at,uid LIMIT @limit`;
  const found = db.prepare(sql).all({ owner: query.companionId, filter: query.filter, has_cursor: cursor ? 1 : 0,
    rank: cursor?.rank ?? 0, at: cursor?.at ?? '', key: cursor?.key ?? '', limit: query.limit + 1, world_now: clock.virtualNow }) as Row[];
  const hasMore = found.length > query.limit, rows = found.slice(0, query.limit), last = rows.at(-1);
  return { items: rows.map(item => projectItem(item, clock)), hasMore,
    ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, owner: query.companionId, filter: query.filter, rank: Number(last.rank), at: last.sort_at, key: last.uid })).toString('base64url') } : {}) };
}
function instant(value: string | number | null | undefined): string | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function nextWindow(clock: CompanionLifeOverviewContext['clock'], startMinute: number, endMinute: number) {
  const now = Date.parse(clock.virtualNow), local = companionTimeInZone(now, clock.timeZone), midnight = Date.UTC(local.year, local.month - 1, local.day);
  const at = (day: number, minute: number) => { const date = new Date(day + Math.floor(minute / 1440) * 86400000); return companionCivilInstantInZone({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: Math.floor(minute % 1440 / 60), minute: minute % 60, second: 0, millisecond: 0 }, clock.timeZone, 'next_valid'); };
  for (let offset = -1; offset <= 2; offset++) {
    const day = midnight + offset * 86400000, start = at(day, startMinute), end = at(day + (endMinute <= startMinute ? 86400000 : 0), endMinute);
    if (start !== undefined && end !== undefined && end > now && end > start) return { windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString() };
  }
  return {};
}
function projectItem(row: Row, clock: CompanionLifeOverviewContext['clock']): CompanionLifeOverviewItem {
  const kind = String(row.kind) as CompanionLifeOverviewItem['kind'], status = String(row.status), at = instant(row.at), updatedAt = instant(row.updated_at);
  const destination = { kind: kind === 'action' ? 'work' : kind === 'activity' ? 'activity' : kind === 'schedule' ? 'schedules' : 'life_rules', id: String(row.id),
    ...(row.conversation_id ? { conversationId: String(row.conversation_id) } : {}) } as CompanionLifeOverviewItem['destination'];
  let condition = String(row.stage || ''), timing: CompanionLifeOverviewItem['timing'] = { kind: 'none', clock: 'real' };
  if (kind === 'schedule') {
    const deferred = row.clock === 'real';
    condition = status === 'paused' ? '这项安排已暂停，需恢复后才会执行。' : condition === 'resting' ? '伙伴正在休息；现实时间到达延期资格后再检查。'
      : condition === 'unavailable' ? '等待伙伴或模型恢复可用。' : '已有明确授权的行程时间；具体执行仍受当前工作与可用条件影响。';
    timing = { kind: status === 'paused' ? 'conditional' : deferred ? 'eligibility' : 'scheduled', clock: deferred ? 'real' : 'world', ...(!deferred ? { timeZone: clock.timeZone } : {}), ...(at ? { at } : {}) };
  } else if (kind === 'life_rule') {
    timing = { kind: 'window', clock: 'world', timeZone: clock.timeZone, ...nextWindow(clock, Number(row.start_minute), Number(row.end_minute)) };
    condition = `这是概率事件窗口，每${Number(row.check_minutes)}世界分钟判断一次；仍需伙伴状态和交流对象等条件，不保证发生。`;
  } else if (kind === 'life_event') {
    const start = instant(row.window_start), end = instant(row.window_end);
    timing = { kind: at ? 'eligibility' : 'window', clock: 'world', timeZone: clock.timeZone, ...(at ? { at } : {}), ...(start ? { windowStart: start } : {}), ...(end ? { windowEnd: end } : {}) };
    condition ||= status === 'observing' ? '正在这个概率窗口中观察条件，并非已经决定执行。' : status === 'running' || status === 'active' ? '事件已经领取或正在实际参与中。' : status === 'failed' ? '本次事件未完成，可查看规则与实际条件。' : '已达到本次窗口条件，等待后台核验与可用空位。';
  } else condition ||= status === 'failed' ? '任务失败，可打开所属工作记录查看原因。' : status === 'interrupted' ? '执行已中断，等待明确恢复。' : status === 'waiting' ? '等待实际条件或相关伙伴回应。' : status === 'queued' ? '任务已入队，等待可用执行空位。' : '正在处理当前任务，没有预设完成时间。';
  return { id: String(row.uid), kind, title: String(row.title), status, section: String(row.section) as CompanionLifeOverviewItem['section'], condition: condition.slice(0, 500), timing, destination,
    ...(updatedAt ? { updatedAt } : {}), ...(row.probability !== null && row.probability !== undefined ? { probability: Number(row.probability) } : {}) };
}
