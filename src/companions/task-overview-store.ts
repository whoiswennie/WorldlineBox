import type { CompanionConnection } from './store';
import { COMPANION_TASK_KIND_LABELS, companionTaskItemSchema, companionTaskPageStorageCommand, companionTaskResolveStorageCommand,
  type CompanionTaskItem, type CompanionTaskKind, type CompanionTaskPage } from '../shared/companion-task-overview';
import type { z } from 'zod';

type Row = Record<string, string | number | null>;
interface Source {
  kind: CompanionTaskKind; table: string; from: string; id?: string; owner?: string; room?: string;
  status?: string; current: string; title: string; stage?: string; created?: string; updated?: string; started?: string; finished?: string;
  scheduled?: string; revision?: string; action?: string; source?: string; message?: string; parent?: string; stop?: string;
  stopLabel?: string; stoppable?: boolean; stopReason?: string;
}
const json = (field: string, alias = 't') => `json_extract(${alias}.data,'$.${field}')`;
const stopJson = (field: string) => json(`stop.${field}`);
const replyTitle = `CASE WHEN COALESCE(${json('proactive')},0)=1 THEN '主动交流' WHEN EXISTS(SELECT 1 FROM messages source
  WHERE source.id=${json('sourceMessageId')} AND source.author_id='user' AND source.status='sent' AND source.conversation_id=${json('conversationId')}
    AND NOT EXISTS(SELECT 1 FROM vcp_source_blocks b WHERE b.message_id=source.id AND b.companion_id=t.companion_id)
    AND NOT EXISTS(SELECT 1 FROM metadata x WHERE x.key='execution-source-invalid/message/'||source.id)
    AND NOT EXISTS(SELECT 1 FROM companion_reset_messages r WHERE r.message_id=source.id)
    AND NOT EXISTS(SELECT 1 FROM companion_reset_boundaries r WHERE r.companion_id=t.companion_id AND source.sequence<=r.through_sequence)
  ) THEN '回复 · '||(SELECT SUBSTR(REPLACE(REPLACE(source.content,char(10),' '),char(13),' '),1,120) FROM messages source WHERE source.id=${json('sourceMessageId')})
  ELSE '聊天回复（来源已不可用）' END`;
const sourceDefinitions = (): Source[] => [
  { kind: 'reply', table: 'companion_work_queue', from: `companion_work_queue t LEFT JOIN metadata cp ON cp.key=COALESCE('message-loop/'||${json('messageId')},'loop/'||${json('sourceMessageId')}||'/'||t.companion_id)`,
    room: json('conversationId'), current: "t.status IN('queued','running','interrupted')", title: replyTitle,
    stage: "json_extract(cp.value,'$.progress.detail')", created: json('createdAt'), updated: json('updatedAt'),
    started: json('startedAt'), finished: "CASE WHEN t.status IN('done','cancelled') THEN " + json('updatedAt') + ' END',
    source: json('sourceMessageId'), message: json('messageId'), stop: `COALESCE(${stopJson('actor')},json_extract(cp.value,'$.progress.stop.actor'))`, stopLabel: '停止回复' },
  { kind: 'action', table: 'actions', from: 'actions t', room: 't.conversation_id', current: "t.status IN('queued','running','interrupted')",
    title: `CASE WHEN EXISTS(SELECT 1 FROM metadata x WHERE x.key='execution-source-invalid/action/'||t.id) THEN '引用资料已变化的工具任务' ELSE ${json('title')} END`,
    stage: `CASE WHEN EXISTS(SELECT 1 FROM metadata x WHERE x.key='execution-source-invalid/action/'||t.id) THEN '旧执行正文不可引用' ELSE ${json('stage')} END`,
    created: json('createdAt'), updated: json('updatedAt'), started: json('startedAt'), finished: json('finishedAt'), source: json('sourceMessageId'), action: 't.id', stopLabel: '停止工具任务' },
  { kind: 'activity', table: 'companion_activity_tasks', from: 'companion_activity_tasks t', room: 't.conversation_id',
    current: "t.status IN('queued','running','waiting')", title: json('title'), stage: json('stage'), created: json('createdAt'), updated: json('updatedAt'), source: 't.source_message_id', stopLabel: '停止活动' },
  { kind: 'work_order', table: 'companion_work_orders', from: 'companion_work_orders t', room: 't.conversation_id',
    current: "t.status IN('offered','accepted','running','paused')", title: json('title'), stage: "CASE t.status WHEN 'offered' THEN '等待伙伴受理' WHEN 'accepted' THEN '已受理，等待执行' WHEN 'paused' THEN '委托已暂停' ELSE '工作委托' END",
    created: json('createdAt'), updated: json('updatedAt'), revision: json('revision'), source: json('sourceMessageId'), action: 't.action_id', stopLabel: '取消委托' },
  { kind: 'schedule', table: 'companion_schedules', from: 'companion_schedules t', room: 't.conversation_id', current: "t.status IN('active','paused')",
    title: json('title'), stage: "CASE t.status WHEN 'paused' THEN '定时计划已暂停' WHEN 'active' THEN '等待下一次计划时间' ELSE '定时计划已取消' END",
    created: json('createdAt'), updated: json('updatedAt'), scheduled: 't.next_run_at', revision: json('revision'), source: 't.source_message_id', stopLabel: '取消整个计划' },
  { kind: 'schedule_occurrence', table: 'companion_schedule_occurrences', from: 'companion_schedule_occurrences t JOIN companion_schedules p ON p.id=t.schedule_id',
    owner: 'p.companion_id', room: 'p.conversation_id', current: "t.status IN('pending','dispatching','running')", title: json('title', 'p'),
    stage: "CASE t.status WHEN 'pending' THEN '定时执行等待中' WHEN 'dispatching' THEN '正在分派本次定时执行' WHEN 'running' THEN '本次定时执行进行中' ELSE '本次定时执行已结束' END",
    created: json('createdAt'), updated: json('updatedAt'), started: json('startedAt'), finished: json('finishedAt'), scheduled: 't.scheduled_at',
    action: 't.action_id', parent: 't.schedule_id', stopLabel: '停止本次执行' },
  { kind: 'social', table: 'companion_social_jobs', from: 'companion_social_jobs t LEFT JOIN companion_social_reply_progress sp ON sp.job_id=t.id',
    room: 't.conversation_id', current: `t.status IN('pending','running') OR t.status='failed' AND COALESCE(${json('terminal')},0)=0`,
    title: "'伙伴之间的交流'", stage: "json_extract(sp.data,'$.detail')", created: 't.created_at', updated: `COALESCE(${json('updatedAt')},json_extract(sp.data,'$.updatedAt'),t.created_at)`, started: "json_extract(sp.data,'$.startedAt')", finished: json('finishedAt'),
    source: json('sourceMessageId'), message: json('resultMessageId'), stopLabel: '停止本次交流' },
  { kind: 'world', table: 'companion_world_jobs', from: 'companion_world_jobs t', room: json('conversationId'),
    current: `t.status IN('pending','running') OR t.status='failed' AND COALESCE(${json('terminal')},0)=0`,
    title: "CASE t.kind WHEN 'dream' THEN '梦境与记忆维护' ELSE '世界活动决策' END", stage: `CASE t.status WHEN 'pending' THEN '等待生活调度' WHEN 'running' THEN '正在处理世界活动' WHEN 'failed' THEN CASE WHEN COALESCE(${json('terminal')},0)=0 THEN '本轮未完成，等待重试' ELSE '世界活动未完成' END ELSE '世界活动已结束' END`,
    created: json('createdAt'), updated: `COALESCE(${json('updatedAt')},${json('createdAt')})`, finished: json('finishedAt'), stopLabel: '停止本次世界任务' },
  { kind: 'world_action', table: 'companion_world_events', from: 'companion_world_events t', owner: json('actorId'), room: json('conversationId'),
    current: '0', status: "'recorded'", title: `COALESCE(${json('text')},'世界行动')`, stage: "'已记录实际世界事件'",
    created: json('realAt'), updated: json('realAt'), finished: json('realAt'), stoppable: false, stopReason: '这是已发生的世界事件。' },
  { kind: 'memory_timeline', table: 'companion_task_timeline_jobs', from: 'companion_task_timeline_jobs t', room: json('conversationId'),
    current: "t.status IN('pending','running','waiting_model')", title: json('title'), stage: json('stage'),
    created: json('createdAt'), updated: json('updatedAt'), started: json('startedAt'),
    finished: `CASE WHEN t.status IN('completed','failed','cancelled','stale') THEN ${json('updatedAt')} END`,
    stoppable: false, stopReason: '时间线由记忆后台管理，输入、处理阶段和实际产出保存在下方。' },
  { kind: 'social_notification', table: 'companion_social_notifications', from: 'companion_social_notifications t', room: json('conversationId'),
    current: `t.status IN('pending','running') OR t.status='failed' AND COALESCE(${json('terminal')},0)=0`, title: "'向用户回报后续进展'",
    stage: "CASE t.status WHEN 'pending' THEN '等待后续回报' WHEN 'running' THEN '正在准备后续回报' ELSE '后续回报已结束' END",
    created: 't.created_at', updated: `COALESCE(${json('updatedAt')},t.created_at)`, finished: json('finishedAt'), source: json('sourceMessageId'), message: json('resultMessageId'), parent: 't.origin_id', stopLabel: '停止本次回报' },
  { kind: 'life_occurrence', table: 'companion_life_occurrences', from: 'companion_life_occurrences t', room: json('conversationId'),
    current: "t.status IN('observing','pending','running','active')", title: `COALESCE(${json('rule.title')},'自主生活行动')`,
    stage: `COALESCE(${json('result')},${json('reason')},CASE t.status WHEN 'observing' THEN '等待生活规则条件' WHEN 'running' THEN '正在进行生活行动' WHEN 'active' THEN '生活行动持续中' ELSE '自主生活行动' END)`,
    scheduled: 't.window_start', updated: `COALESCE(${json('settledAt')},${json('lastEvaluatedAt')},${json('lastRealAt')},t.window_start)`, finished: json('settledAt'), parent: 't.rule_id',
    stoppable: false, stopReason: '此项由自主生活规则管理；请在生活规则中暂停或修改对应规则。' },
  { kind: 'learning', table: 'companion_learning_grants', from: 'companion_learning_grants t', status: `CASE WHEN t.enabled=0 THEN 'cancelled' WHEN t.autonomous=0 AND t.lease_token IS NULL THEN 'paused' ELSE COALESCE(${json('status')},'waiting') END`,
    current: 't.enabled=1', title: "'资料学习 · '||COALESCE(" + json('libraryName') + ",'资料库')", stage: "CASE WHEN t.enabled=0 THEN '资料学习授权已撤回' WHEN t.autonomous=0 AND t.lease_token IS NULL THEN '自动学习已暂停' WHEN t.lease_token IS NOT NULL THEN '正在读取获权资料' ELSE '等待下次学习' END",
    created: json('createdAt'), updated: json('updatedAt'), scheduled: "strftime('%Y-%m-%dT%H:%M:%fZ',t.next_at/1000.0,'unixepoch')", revision: 't.revision', stopLabel: '暂停资料学习' },
  { kind: 'learning_goal', table: 'companion_learning_goals', from: 'companion_learning_goals t', status: "CASE WHEN t.state='stopped' THEN 'cancelled' WHEN t.state='paused' THEN 'paused' WHEN t.lease_token IS NOT NULL THEN 'running' ELSE 'waiting' END",
    current: "t.state!='stopped'", title: "'学习目标'", stage: json('phase'), created: json('createdAt'), updated: json('updatedAt'),
    scheduled: "strftime('%Y-%m-%dT%H:%M:%fZ',t.next_at/1000.0,'unixepoch')", revision: 't.revision', stopLabel: '停止学习目标' },
  { kind: 'memory_capture', table: 'vcp_capture_jobs', from: 'vcp_capture_jobs t', room: 't.conversation_id',
    current: "t.status IN('pending','running') OR t.status='failed' AND t.attempts<8", title: "'整理聊天与经历来源'",
    stage: "CASE WHEN t.status='failed' AND t.attempts<8 THEN '等待重试来源整理' WHEN t.status='running' THEN '正在整理聊天与经历来源' ELSE '来源整理' END", created: 't.created_at', updated: 'COALESCE(t.updated_at,t.created_at)',
    source: 't.message_id', stoppable: false, stopReason: '来源整理保留已收录队列；可在记忆规则中管理后续收录。' },
  { kind: 'memory_index', table: 'vcp_memory_outbox', from: 'vcp_memory_outbox t LEFT JOIN vcp_memory_scopes s ON s.scope_id=t.scope_id', room: 's.conversation_id', parent: 't.note_id',
    current: "t.status IN('pending','running') OR t.status='failed' AND t.attempts<8", title: "CASE WHEN t.operation='forget' THEN '移除过期记忆索引' ELSE '建立记忆索引' END",
    stage: "CASE WHEN t.status='failed' AND t.attempts<8 THEN '等待重试记忆索引' WHEN t.status='running' THEN '正在同步记忆索引' ELSE '记忆索引' END", created: 't.created_at', updated: 'COALESCE(t.updated_at,t.created_at)',
    stoppable: false, stopReason: '索引维护需要完成版本同步，请在记忆界面管理来源和文档。' },
  { kind: 'memory_tags', table: 'companion_memory_tag_jobs', from: 'companion_memory_tag_jobs t',
    current: "t.status IN('pending','running','waiting_model') OR t.status='failed' AND t.attempts<8", title: "'整理资料自动标签'",
    stage: "CASE WHEN t.status='waiting_model' THEN '等待标签模型' WHEN t.status='running' THEN '正在整理自动标签' ELSE '自动标签' END", created: 't.created_at', updated: 'COALESCE(t.updated_at,t.created_at)', parent: 't.note_id', stopLabel: '停止自动标签' },
];
const optional = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;
function normalized(status: string, current: boolean): CompanionTaskItem['status'] {
  if (status === 'paused') return 'paused';
  if (status === 'running' || status === 'reading') return 'running';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'cancelled' || status === 'stopped') return 'cancelled';
  if (status === 'failed') return current ? 'waiting' : 'failed';
  if (['done', 'succeeded', 'completed', 'stale', 'discarded', 'recorded'].includes(status)) return 'completed';
  if (['queued', 'pending', 'dispatching', 'accepted', 'offered'].includes(status)) return 'queued';
  return 'waiting';
}
const compare = (a: CompanionTaskItem, b: CompanionTaskItem) => b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
const isCurrent = (item: CompanionTaskItem) => ['queued', 'running', 'waiting', 'paused', 'interrupted'].includes(item.status);

/** Small metadata projections only: no model contexts, instruction bodies,
 * returned tool records, memory text, or historical dialogue enter this port. */
export class CompanionTaskOverviewStore {
  private sources: Source[] = [];
  constructor(private readonly db: CompanionConnection) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_task_timeline_jobs(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),status TEXT NOT NULL,data TEXT NOT NULL,input TEXT,output TEXT);
      CREATE INDEX IF NOT EXISTS task_timeline_state ON companion_task_timeline_jobs(status,id);
      CREATE TABLE IF NOT EXISTS companion_task_observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,task_id TEXT NOT NULL,companion_id TEXT NOT NULL,phase TEXT NOT NULL,title TEXT NOT NULL,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_observations_lookup ON companion_task_observations(kind,task_id,companion_id,sequence);
      CREATE TABLE IF NOT EXISTS companion_task_counts(kind TEXT NOT NULL,companion_id TEXT NOT NULL,total INTEGER NOT NULL,live INTEGER NOT NULL,PRIMARY KEY(kind,companion_id));
      CREATE TABLE IF NOT EXISTS companion_task_payloads(kind TEXT NOT NULL,task_id TEXT NOT NULL,companion_id TEXT NOT NULL,section TEXT NOT NULL,record_key TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(kind,task_id,companion_id,record_key));
      CREATE INDEX IF NOT EXISTS task_journal_invocation ON metadata(json_extract(value,'$.companionId'),json_extract(value,'$.invocationId')) WHERE key GLOB 'agent-run/*';`);
    this.db.exec(`UPDATE companion_task_timeline_jobs SET status='pending',data=json_set(data,'$.status','pending','$.stage','上次运行已中断，等待后台重新检查','$.updatedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE status='running'`);
    this.sources = sourceDefinitions().filter(source => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(source.table));
    // Per-table reads limit before merging. These indexes let current and
    // historical pages seek metadata without parsing full archived payloads.
    for (const source of this.sources) {
      const columns = this.db.prepare(`PRAGMA table_info(${source.table})`).all() as Array<{ name: string }>;
      const names = new Set(columns.map(column => column.name));
      const at = this.at(source).replaceAll('t.', '');
      // An all-owner page also needs a global timestamp index. Leading every
      // index with owner would otherwise sort/parse every archived task first.
      if (!/[a-z]+\./u.test(at) && at !== "COALESCE('','','')") {
        const live = `CASE WHEN (${source.current.replaceAll('t.', '')}) THEN 1 ELSE 0 END`;
        this.db.exec(`CREATE INDEX IF NOT EXISTS task_overview_${source.kind}_global_v2 ON ${source.table}(${at} DESC,id ASC);
          CREATE INDEX IF NOT EXISTS task_overview_${source.kind}_live_v2 ON ${source.table}(${live},${at} DESC,id ASC)`);
        if (source.kind !== 'schedule_occurrence') this.db.exec(`CREATE INDEX IF NOT EXISTS task_overview_${source.kind}_owner_v2 ON ${source.table}(${(source.owner ?? 't.companion_id').replaceAll('t.', '')},${live},${at} DESC,id ASC)`);
      }
      // Superseded ASC/ASC and scan-count indexes add write amplification
      // without serving this reader. Retain only the three seek shapes above.
      for (const suffix of ['updated', 'global', 'status', 'counts']) this.db.exec(`DROP INDEX IF EXISTS task_overview_${source.kind}_${suffix}`);
      if (source.kind === 'schedule_occurrence') continue;
      const owner = (alias: string) => (source.owner ?? 't.companion_id').replaceAll('t.', alias + '.');
      const live = (alias: string) => `CASE WHEN (${source.current.replaceAll('t.', alias + '.')}) THEN 1 ELSE 0 END`;
      const increment = `INSERT INTO companion_task_counts(kind,companion_id,total,live) SELECT '${source.kind}',${owner('NEW')},1,${live('NEW')} WHERE ${owner('NEW')} IS NOT NULL
        ON CONFLICT(kind,companion_id) DO UPDATE SET total=total+1,live=live+excluded.live;`;
      const decrement = `UPDATE companion_task_counts SET total=total-1,live=live-${live('OLD')} WHERE kind='${source.kind}' AND companion_id=${owner('OLD')};`;
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS task_counts_${source.kind}_insert AFTER INSERT ON ${source.table} BEGIN ${increment} END;
        CREATE TRIGGER IF NOT EXISTS task_counts_${source.kind}_delete AFTER DELETE ON ${source.table} BEGIN ${decrement} END;
        CREATE TRIGGER IF NOT EXISTS task_counts_${source.kind}_update AFTER UPDATE ON ${source.table}
        WHEN ${owner('NEW')} IS NOT ${owner('OLD')} OR ${live('NEW')}!=${live('OLD')} BEGIN ${decrement} ${increment} END;`);
      const ready = 'task-counts-ready/v1/' + source.kind;
      if (!this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(ready)) this.db.transaction(() => {
        this.db.prepare('DELETE FROM companion_task_counts WHERE kind=?').run(source.kind);
        this.db.exec(`INSERT INTO companion_task_counts(kind,companion_id,total,live) SELECT '${source.kind}',${owner('t')},COUNT(*),SUM(${live('t')}) FROM ${source.table} t WHERE ${owner('t')} IS NOT NULL GROUP BY ${owner('t')}`);
        this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(ready, '1');
      }).immediate();
      if (source.kind !== 'world_action' && names.has('companion_id') && names.has('status')) {
        // Metadata-only milestones, written atomically with the actual domain
        // transition. Bodies stay in their existing cold source tables.
        const stage = source.kind === 'reply' ? "''" : source.stage?.includes('p.') || source.stage?.includes('sp.') ? "''" : (source.stage ?? "''").replaceAll('t.', 'NEW.');
        const snapshot = source.source && source.room && !/[ps]\./u.test(source.room) ? `INSERT OR IGNORE INTO companion_task_payloads(kind,task_id,companion_id,section,record_key,title,body,at)
          SELECT '${source.kind}',NEW.id,NEW.companion_id,'input','trigger','开始处理时的来源消息',m.content,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM messages m
          WHERE NEW.status IN('running','reading','dispatching') AND m.id=${source.source.replaceAll('t.', 'NEW.')} AND m.conversation_id=${source.room.replaceAll('t.', 'NEW.')} AND m.status='sent'
          AND NOT EXISTS(SELECT 1 FROM companion_task_payloads saved WHERE saved.kind='${source.kind}' AND saved.task_id=NEW.id AND saved.companion_id=NEW.companion_id AND saved.record_key='trigger');` : '';
        for (const operation of ['INSERT', 'UPDATE'] as const) this.db.exec(`CREATE TRIGGER IF NOT EXISTS task_observe_${source.kind}_${operation.toLowerCase()} AFTER ${operation} ON ${source.table}
          ${operation === 'UPDATE' ? 'WHEN NEW.status IS NOT OLD.status' : ''} BEGIN
          INSERT INTO companion_task_observations(kind,task_id,companion_id,phase,title,at) VALUES('${source.kind}',NEW.id,NEW.companion_id,NEW.status,SUBSTR(COALESCE(${stage},''),1,500),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;`);
        if (snapshot) for (const operation of ['INSERT', 'UPDATE'] as const) this.db.exec(`DROP TRIGGER IF EXISTS task_input_${source.kind}_${operation.toLowerCase()}; CREATE TRIGGER task_input_${source.kind}_${operation.toLowerCase()} AFTER ${operation} ON ${source.table}
          ${operation === 'UPDATE' ? 'WHEN NEW.status IS NOT OLD.status' : ''} BEGIN ${snapshot} END;`);
      }
    }
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS task_reply_progress_observe AFTER UPDATE OF value ON metadata
      WHEN NEW.key GLOB 'message-loop/*' AND json_extract(NEW.value,'$.progress.workId') IS NOT NULL AND
        (json_extract(NEW.value,'$.progress.phase') IS NOT json_extract(OLD.value,'$.progress.phase') OR json_extract(NEW.value,'$.progress.detail') IS NOT json_extract(OLD.value,'$.progress.detail'))
      BEGIN INSERT INTO companion_task_observations(kind,task_id,companion_id,phase,title,at)
        VALUES('reply',json_extract(NEW.value,'$.progress.workId'),json_extract(NEW.value,'$.companionId'),json_extract(NEW.value,'$.progress.phase'),SUBSTR(COALESCE(json_extract(NEW.value,'$.progress.detail'),''),1,500),json_extract(NEW.value,'$.progress.updatedAt')); END;`);
    this.db.exec('DROP TRIGGER IF EXISTS task_world_transition_time');
    // An outer UPSERT can override a trigger's OR IGNORE conflict policy.
    // Avoid the duplicate row explicitly and preserve the first captured input.
    this.db.exec(`DROP TRIGGER IF EXISTS task_input_occurrence; CREATE TRIGGER task_input_occurrence AFTER UPDATE OF status ON companion_schedule_occurrences WHEN NEW.status IN('dispatching','running') AND NEW.status IS NOT OLD.status BEGIN
      INSERT OR IGNORE INTO companion_task_payloads(kind,task_id,companion_id,section,record_key,title,body,at)
      SELECT 'schedule_occurrence',NEW.id,p.companion_id,'input','schedule_prompt','本次执行的计划要求',json_extract(p.data,'$.prompt'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM companion_schedules p WHERE p.id=NEW.schedule_id AND json_extract(p.data,'$.prompt') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM companion_task_payloads saved WHERE saved.kind='schedule_occurrence' AND saved.task_id=NEW.id AND saved.companion_id=p.companion_id AND saved.record_key='schedule_prompt'); END;`);
  }
  private at(source: Source): string { return `COALESCE(${source.updated ?? source.created ?? "''"},${source.created ?? "''"},'')`; }
  private columns(source: Source): string {
    const field = (expression: string | undefined, name: string) => `${expression ?? 'NULL'} AS ${name}`;
    const observed = (phases: string[]) => `(SELECT ${phases.includes('running') ? 'MIN' : 'MAX'}(o.at) FROM companion_task_observations o WHERE o.kind='${source.kind}' AND o.task_id=${source.id ?? 't.id'} AND o.companion_id=${source.owner ?? 't.companion_id'} AND o.phase IN(${phases.map(phase => "'" + phase + "'").join(',')}))`;
    return [field(source.id ?? 't.id', 'id'), field(source.owner ?? 't.companion_id', 'owner'), field(source.room, 'room'),
      field(source.status ?? 't.status', 'status'), `CASE WHEN (${source.current}) THEN 1 ELSE 0 END AS current`,
      `${source.room ? `(SELECT SUBSTR(c.title,1,100) FROM conversations c WHERE c.id=${source.room})` : 'NULL'} AS conversation_title`,
      `SUBSTR(COALESCE(${source.title},'${COMPANION_TASK_KIND_LABELS[source.kind]}'),1,200) AS title`,
      `SUBSTR(COALESCE(${source.stage ?? "''"},''),1,500) AS stage`, field(source.created, 'created'), `${this.at(source)} AS updated`,
      `COALESCE(${source.started ?? 'NULL'},${observed(['running', 'reading'])}) AS started`,
      `COALESCE(${source.finished ?? 'NULL'},CASE WHEN NOT (${source.current}) THEN ${observed(['done', 'completed', 'succeeded', 'failed', 'cancelled', 'stale'])} END) AS finished`, field(source.scheduled, 'scheduled'), field(source.revision, 'revision'),
      field(source.action, 'action'), field(source.source, 'source'), field(source.message, 'message'), field(source.parent, 'parent'),
      field(source.stop ?? (source.kind.startsWith('memory_') ? 'NULL' : stopJson('actor')), 'stop_actor'),
      field(source.kind.startsWith('memory_') ? 'NULL' : stopJson('requestedAt'), 'stop_at')].join(',');
  }
  private project(source: Source, row: Row): CompanionTaskItem {
    const current = row.current === 1, stoppedByUser = row.stop_actor === 'user';
    const status = stoppedByUser && !current ? 'cancelled' : normalized(String(row.status), current);
    return companionTaskItemSchema.parse({ id: row.id, kind: source.kind, companionId: row.owner, title: row.title, stage: row.stage, rawStatus: row.status,
      status, updatedAt: String(row.updated ?? ''), canStop: current && source.stoppable !== false,
      ...(current && source.stoppable !== false ? { stopLabel: source.stopLabel ?? '停止任务' } : { stopReason: current ? source.stopReason ?? '此后台状态不支持直接停止。' : '任务已结束' }), stoppedByUser,
      ...(optional(row.room) ? { conversationId: row.room } : {}), ...(optional(row.created) ? { createdAt: row.created } : {}),
      ...(optional(row.conversation_title) ? { conversationTitle: row.conversation_title } : {}),
      ...(optional(row.started) ? { startedAt: row.started } : {}), ...(optional(row.finished) ? { finishedAt: row.finished } : {}),
      ...(optional(row.scheduled) ? { scheduledAt: row.scheduled } : {}), ...(typeof row.revision === 'number' ? { revision: row.revision } : {}),
      ...(optional(row.action) ? { relatedActionId: row.action } : {}), ...(optional(row.source) ? { sourceMessageId: row.source } : {}),
      ...(optional(row.message) ? { messageId: row.message } : {}), ...(optional(row.parent) ? { parentId: row.parent } : {}),
      ...(optional(row.stop_at) ? { stopRequestedAt: row.stop_at } : {}) });
  }
  page(input: z.input<typeof companionTaskPageStorageCommand>): CompanionTaskPage {
    const query = companionTaskPageStorageCommand.parse(input), candidates: CompanionTaskItem[] = [];
    const owners = new Map((this.db.prepare("SELECT id,COALESCE(json_extract(data,'$.name'),id) AS name FROM companions WHERE deleted_at IS NULL").all() as Array<{ id: string; name: string }>).map(owner => [owner.id, { companionId: owner.id, name: owner.name.slice(0, 60), current: 0, history: 0 }]));
    if (query.companionId && !owners.has(query.companionId)) throw new Error('伙伴不存在或已移除。');
    for (const source of this.sources) {
      const owner = source.owner ?? 't.companion_id', identifier = source.id ?? 't.id', at = this.at(source);
      const scope = `EXISTS(SELECT 1 FROM companions c WHERE c.id=${owner} AND c.deleted_at IS NULL)${query.companionId ? ` AND ${owner}=@owner` : ''}`;
      const params: Record<string, unknown> = query.companionId ? { owner: query.companionId } : {};
      if (source.kind === 'schedule_occurrence') {
        for (const row of this.db.prepare(`SELECT ${owner} AS owner,CASE WHEN (${source.current}) THEN 1 ELSE 0 END AS current,COUNT(*) AS count FROM ${source.from} WHERE ${scope} GROUP BY ${owner},current`).all(params) as Row[]) {
          const record = owners.get(String(row.owner)); if (record) record[row.current === 1 ? 'current' : 'history'] += Number(row.count);
        }
      } else for (const row of this.db.prepare(`SELECT companion_id AS owner,total,live FROM companion_task_counts WHERE kind=@kind${query.companionId ? ' AND companion_id=@owner' : ''}`).all({ ...params, kind: source.kind }) as Row[]) {
        const record = owners.get(String(row.owner)); if (record) { record.current += Number(row.live); record.history += Number(row.total) - Number(row.live); }
      }
      const view = query.view === 'all' ? '' : ` AND CASE WHEN (${source.current}) THEN 1 ELSE 0 END=${query.view === 'current' ? 1 : 0}`;
      let after = '';
      if (query.cursor) {
        params.at = query.cursor.at;
        const order = source.kind.localeCompare(query.cursor.kind);
        if (order > 0) after = ` AND ${at}<=@at`;
        else if (order < 0) after = ` AND ${at}<@at`;
        else { params.id = query.cursor.id; after = ` AND (${at}<@at OR ${at}=@at AND ${identifier}>@id)`; }
      }
      params.limit = query.limit + 1;
      const found = this.db.prepare(`SELECT ${this.columns(source)} FROM ${source.from} WHERE ${scope}${view}${after} ORDER BY ${at} DESC,${identifier} LIMIT @limit`).all(params) as Row[];
      candidates.push(...found.map(row => this.project(source, row)));
    }
    for (const item of query.runtimeItems ?? []) {
      if (!owners.has(item.companionId) || query.companionId && query.companionId !== item.companionId) continue;
      const owner = owners.get(item.companionId)!; owner[isCurrent(item) ? 'current' : 'history']++;
      if (query.view !== 'all' && (query.view === 'current') !== isCurrent(item)) continue;
      if (query.cursor && compare(item, { ...item, updatedAt: query.cursor.at, kind: query.cursor.kind, id: query.cursor.id }) <= 0) continue;
      candidates.push(item);
    }
    candidates.sort(compare);
    const hasMore = candidates.length > query.limit, items = candidates.slice(0, query.limit), last = items.at(-1);
    const ownerValues = [...owners.values()], selected = ownerValues.filter(owner => !query.companionId || owner.companionId === query.companionId);
    const current = selected.reduce((sum, owner) => sum + owner.current, 0), history = selected.reduce((sum, owner) => sum + owner.history, 0);
    return { items, hasMore, ...(hasMore && last ? { nextCursor: { at: last.updatedAt, kind: last.kind, id: last.id } } : {}),
      total: query.view === 'current' ? current : query.view === 'history' ? history : current + history, current, history, owners: ownerValues,
      observedAt: new Date().toISOString(), coverage: [...this.sources.map(source => source.kind), ...((query.runtimeItems ?? []).some(item => item.kind === 'memory_timeline') ? ['memory_timeline' as const] : [])] };
  }
  resolve(input: z.input<typeof companionTaskResolveStorageCommand>): CompanionTaskItem | undefined {
    const query = companionTaskResolveStorageCommand.parse(input), source = this.sources.find(source => source.kind === query.kind);
    if (!source) return;
    const found = this.db.prepare(`SELECT ${this.columns(source)} FROM ${source.from} WHERE ${source.id ?? 't.id'}=? AND ${source.owner ?? 't.companion_id'}=?
      AND EXISTS(SELECT 1 FROM companions c WHERE c.id=? AND c.deleted_at IS NULL)`).get(query.id, query.companionId, query.companionId) as Row | undefined;
    return found ? this.project(source, found) : undefined;
  }
}
