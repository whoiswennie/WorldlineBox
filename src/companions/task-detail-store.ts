import type { z } from 'zod';
import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionTaskOverviewStore } from './task-overview-store';
import type { CompanionTaskItem, CompanionTaskKind } from '../shared/companion-task-overview';
import { COMPANION_JOB_FAILURES_PER_CYCLE, type CompanionJobDisposition } from '../shared/companion-job-control';
import { companionJobInputVersion, pageCompanionJobIds, type CompanionJobControlAdapter } from './job-control-store';
import type { CompanionMemoryProcessingJob } from '../shared/companion-memory-processing';
import { indexCompanionJobInputs } from './memory-withdrawal-store';
import { companionTaskContentCommand, companionTaskInspectCommand, companionTaskTimelineRecordCommand,
  type CompanionTaskDetail, type CompanionTaskRecord, type CompanionTaskSection } from '../shared/companion-task-detail';

type Value = string | number | null;
type RecordRow = { id: string; title: string; body: string; at: string | null; provenance: CompanionTaskRecord['provenance']; state: string | null };
type Port = { sql: string; params: Value[] };
export function readTimelineJobDisposition(db: CompanionConnection, ownerId: string, id: string): CompanionJobDisposition | undefined {
  const found = db.prepare(`SELECT status,disposition_revision,failure_count,cycle_failure_count,last_failure_at,last_failure_error,
    json_extract(data,'$.attempts') AS attempts,json_extract(data,'$.sourceRevision') AS source_revision,json_extract(data,'$.conversationId') AS room
    FROM companion_task_timeline_jobs WHERE companion_id=? AND id=?`).get(ownerId, id) as
    { status: CompanionJobDisposition['state']; disposition_revision: number; failure_count: number; cycle_failure_count: number; attempts: number; source_revision?: string; room?: string; last_failure_at?: string; last_failure_error?: string } | undefined;
  if (!found) return;
  return { ownerId, kind: 'timeline', id, processorId: id, inputVersion: companionJobInputVersion([ownerId, id, found.source_revision, found.room]), revision: found.disposition_revision,
    state: found.status, failureCount: found.failure_count, cycleFailureCount: found.cycle_failure_count, attemptCount: found.attempts,
    ...(found.room ? { conversationId: found.room } : {}), ...(found.last_failure_at ? { lastErrorAt: found.last_failure_at } : {}), ...(found.last_failure_error ? { lastError: found.last_failure_error } : {}) };
}
const purposes: Record<CompanionTaskKind, string> = {
  reply: '根据本次消息准备上下文、调用所需工具并向会话交付回复。', action: '执行伙伴发起的工具任务，记录实际调用与返回。',
  activity: '围绕一个持续目标推进世界行动、交流或记忆操作。', work_order: '处理用户交付的委托，保留目标、实际进展与交付物。',
  schedule: '按指定计划触发工作；每一次执行都有独立记录。', schedule_occurrence: '执行定时计划中的这一次工作。',
  social: '处理伙伴间的消息并记录实际交流结果。', social_notification: '根据后续进展向用户回报。',
  world: '结合当时的世界事件作出生活决策，或进行睡眠期间的记忆维护。', world_action: '记录虚拟世界中实际发生的行动或交流。',
  life_occurrence: '核对生活规则及当前条件，执行本次自主生活行动。', learning: '读取已授权的资料并保存学习进度。', learning_goal: '围绕学习目标逐轮阅读、整理和积累成果。',
  memory_capture: '评估聊天和经历是否值得保留，将有价值的来源整理为日记。未产出日记也可能是正常结果。',
  memory_index: '把指定日记版本同步到检索索引，或撤回该版本；这一步不生成新正文。',
  memory_tags: '为指定资料整理标签，保留已有的手工标签。', memory_timeline: '根据来源日记整理月度时间线与摘要，并发布通过核验的文档。',
};
const tables: Partial<Record<CompanionTaskKind, string>> = { reply: 'companion_work_queue', action: 'actions', activity: 'companion_activity_tasks',
  work_order: 'companion_work_orders', schedule: 'companion_schedules', schedule_occurrence: 'companion_schedule_occurrences', social: 'companion_social_jobs',
  social_notification: 'companion_social_notifications', world: 'companion_world_jobs', world_action: 'companion_world_events', life_occurrence: 'companion_life_occurrences',
  learning: 'companion_learning_grants', learning_goal: 'companion_learning_goals', memory_capture: 'vcp_capture_jobs', memory_index: 'vcp_memory_outbox',
  memory_tags: 'companion_memory_tag_jobs', memory_timeline: 'companion_task_timeline_jobs' };
const labels: Record<string, string> = { query: '查询内容', text: '内容', content: '正文', summary: '摘要', result: '结果', message: '消息',
  title: '标题', goal: '目标', instruction: '执行要求', prompt: '任务要求', url: '页面地址', path: '文件位置', action: '操作', operation: '操作',
  status: '返回状态', error: '问题说明', reason: '原因', ok: '是否成功', count: '数量', tags: '标签', name: '名称', targetId: '目标标识',
  recipientIds: '接收对象', seconds: '等待秒数', durationMinutes: '持续分钟数', version: '版本', noteId: '文档标识', sourceMessageId: '来源消息标识',
  sourceMemoryIds: '使用的记忆', memoryCandidates: '待保存记忆', activityTask: '后续活动', stateProposal: '状态调整提案', type: '类型',
  subject: '主题', body: '正文', output: '输出', reply: '回复', decision: '决定', tool: '工具', source: '来源', assetId: '资料标识',
  id: '标识', sources: '来源日记', sourceRevision: '来源快照', diaryName: '日记名称', month: '月份', documents: '已发布文档', maintenance: '维护决定', dream: '梦境叙述' };
function label(path: string): string {
  return path.replace(/^\$\.?/u, '').replaceAll('"', '').split('.').map(part => part.replace(/[a-zA-Z_][\w-]*/gu, key => labels[key] ?? key)).join(' / ').slice(0, 220) || '返回内容';
}

/** Read a single selected task. SQL slices cold bodies before IPC; neither the
 * list nor a heartbeat parses full model contexts, journals or tool output. */
export class CompanionTaskDetailStore {
  constructor(private readonly db: CompanionConnection, private readonly overview: CompanionTaskOverviewStore,
    private readonly visibleMessage: (owner: string, room: string, id: string) => boolean,
    private readonly visibleNote?: (owner: string, id: string) => boolean) {}

  capture(command: CompanionStorageCommand, response: CompanionStorageResponse): void {
    if (!response.ok) return;
    const kinds: Record<string, CompanionTaskKind> = { 'world.job.complete': 'world', 'world.job.fail': 'world' };
    const kind = kinds[command.type];
    if (!kind || !('id' in command) || typeof command.id !== 'string') return;
    const owner = this.db.prepare(`SELECT t.companion_id AS owner,json_extract(t.data,'$.attempts') AS attempts FROM ${tables[kind]} t WHERE t.id=? AND t.status IN(${command.type === 'world.job.fail' ? "'failed','done'" : "'done','completed','succeeded'"}) AND json_extract(t.data,'$.stop') IS NULL`).get(command.id) as { owner: string; attempts: number } | undefined;
    if (!owner) return;
    const value = command as unknown as Record<string, unknown>;
    if (command.type === 'world.job.fail') {
      this.db.prepare(`INSERT OR IGNORE INTO companion_task_payloads(kind,task_id,companion_id,section,record_key,title,body,at) VALUES('world',?,?,'process',?,'本轮未完成的原因',?,?)`)
        .run(command.id, owner.owner, 'failure:' + owner.attempts, command.error, new Date().toISOString());
      return;
    }
    const fields = kind === 'world' ? ['action', 'activityTask', 'stateProposal', 'dream', 'maintenance', 'dreamComponentFailure', 'sourceMemoryIds'] : ['text'];
    for (const key of fields) if (value[key] !== undefined && value[key] !== null && !(Array.isArray(value[key]) && !value[key].length)) {
      const body = typeof value[key] === 'string' ? value[key] as string : JSON.stringify(value[key]);
      this.db.prepare(`INSERT OR IGNORE INTO companion_task_payloads(kind,task_id,companion_id,section,record_key,title,body,at) VALUES(?,?,?,'output',?,?,?,?)`)
        .run(kind, command.id, owner.owner, key, kind === 'world' && key === 'activityTask' ? '已创建后续活动' : labels[key] ?? key, body, new Date().toISOString());
    }
  }
  captures(type: string): boolean { return ['world.job.complete', 'world.job.fail'].includes(type); }
  captureExpected(command: CompanionStorageCommand): boolean {
    if (command.type !== 'world.job.complete' && command.type !== 'world.job.fail') return false;
    return !!this.db.prepare("SELECT 1 FROM companion_world_jobs WHERE id=? AND status='running' AND json_extract(data,'$.leaseToken')=? AND json_extract(data,'$.stop') IS NULL")
      .get(command.id, command.leaseToken);
  }

  timeline(input: z.input<typeof companionTaskTimelineRecordCommand>): CompanionJobDisposition | undefined {
    const command = companionTaskTimelineRecordCommand.parse(input), job = command.job;
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(command.companionId)) return;
    return this.db.transaction(() => {
      const previous = this.db.prepare(`SELECT status,disposition_revision,failure_count,cycle_failure_count,json_extract(data,'$.stage') AS stage,json_extract(data,'$.attempts') AS attempts
        FROM companion_task_timeline_jobs WHERE id=? AND companion_id=?`).get(job.id, command.companionId) as
        { status: string; stage: string; attempts: number; disposition_revision: number; failure_count: number; cycle_failure_count: number } | undefined;
      if (previous && (command.expectedDispositionRevision === undefined || command.expectedDispositionRevision !== previous.disposition_revision)) throw new Error('时间线作业状态已变化，旧运行记录不能覆盖当前处置。');
      if (previous && this.jobControlAdapter().read(command.companionId, job.id)?.inputVersion !== companionJobInputVersion([command.companionId, job.id, job.sourceRevision, job.conversationId]))
        throw new Error('时间线固定输入已经变化，不能把另一份输入写回旧作业。');
      if (previous && ['parked', 'abandoned', 'completed', 'cancelled', 'stale'].includes(previous.status)) throw new Error('时间线处理已经搁置或终结，旧运行不能覆盖。');
      if (!previous && !['running', 'pending'].includes(job.status)) throw new Error('时间线处理必须先登记真实运行输入，不能直接制造完成或失败记录。');
      const failed = !!previous && previous.status === 'running' && job.status === 'failed' && (command.failureKind ?? 'processing') === 'processing';
      const cycle = (previous?.cycle_failure_count ?? 0) + Number(failed);
      const status = failed && cycle >= COMPANION_JOB_FAILURES_PER_CYCLE ? 'parked' : job.status === 'failed' && command.failureKind && command.failureKind !== 'processing'
        ? command.failureKind === 'waiting' ? 'pending' : command.failureKind : job.status;
      const { disposition: _disposition, ...original } = job; void _disposition;
      const actual = { ...original, status, attempts: previous ? previous.attempts + Number(job.status === 'running' && previous.status !== 'running') : Number(job.status === 'running') };
      if (command.input !== undefined) {
        let input: unknown; try { input = JSON.parse(command.input); } catch { input = undefined; }
        if (input && typeof input === 'object' && 'sources' in input && Array.isArray(input.sources)) {
          const memoryVersions = input.sources.map(source => {
            if (!source || typeof source !== 'object' || !('id' in source) || typeof source.id !== 'string'
              || !this.visibleNote?.(command.companionId, source.id)) throw new Error('时间线输入含未获准的正式记忆。');
            const contentRevision = 'contentRevision' in source && typeof source.contentRevision === 'number' && Number.isSafeInteger(source.contentRevision) && source.contentRevision > 0 ? source.contentRevision : undefined;
            return { id: source.id, contentRevision };
          });
          if (memoryVersions.length > 128) throw new Error('时间线原始输入引用超过本次核验边界。');
          indexCompanionJobInputs(this.db, { ownerId: command.companionId, kind: 'timeline', jobId: job.id, memoryVersions });
        }
      }
      this.db.prepare(`INSERT INTO companion_task_timeline_jobs(id,companion_id,status,data,input,output) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,input=COALESCE(excluded.input,input),output=COALESCE(excluded.output,output)`)
        .run(job.id, command.companionId, status, JSON.stringify(actual), command.input ?? null, command.output ?? null);
      if (failed) this.db.prepare(`UPDATE companion_task_timeline_jobs SET failure_count=failure_count+1,cycle_failure_count=?,last_failure_at=?,last_failure_error=? WHERE id=?`)
        .run(cycle, new Date().toISOString(), job.error?.slice(0, 1000) ?? '时间线处理失败。', job.id);
      if (previous?.stage !== job.stage && previous?.status === job.status) this.db.prepare(`INSERT INTO companion_task_observations(kind,task_id,companion_id,phase,title,at) VALUES('memory_timeline',?,?,?,?,?)`)
        .run(job.id, command.companionId, job.status, job.stage, job.updatedAt ?? new Date().toISOString());
      return this.jobControlAdapter().read(command.companionId, job.id);
    }).immediate();
  }
  jobControlAdapter(): CompanionJobControlAdapter {
    const read = (ownerId: string, id: string) => readTimelineJobDisposition(this.db, ownerId, id);
    return { read, page: input => {
      const rows = pageCompanionJobIds(this.db, 'companion_task_timeline_jobs', input).map(id => ({ id }));
      const page = rows.slice(0, input.limit); return { items: page.map(row => read(input.ownerId, row.id)!), hasMore: rows.length > input.limit,
        ...(rows.length > input.limit && page.length ? { nextId: page.at(-1)!.id } : {}) };
    }, transition: (current, action) => {
      const row = this.db.prepare('SELECT data FROM companion_task_timeline_jobs WHERE id=? AND companion_id=?').get(current.id, current.ownerId) as { data: string } | undefined;
      if (!row) throw new Error('时间线处理不存在。');
      const job = JSON.parse(row.data) as CompanionMemoryProcessingJob; job.status = action === 'resume' ? 'pending' : action === 'park' ? 'parked' : 'abandoned';
      job.stage = action === 'resume' ? '已明确恢复，等待有界重试' : action === 'park' ? '处理已搁置，原始依据保留' : '本次处理已明确放弃，原始依据保留'; job.updatedAt = new Date().toISOString();
      delete job.disposition;
      this.db.prepare('UPDATE companion_task_timeline_jobs SET status=?,data=?,cycle_failure_count=?,disposition_revision=disposition_revision+1 WHERE id=? AND disposition_revision=?')
        .run(job.status, JSON.stringify(job), action === 'resume' ? 0 : current.cycleFailureCount, job.id, current.revision);
      const next = read(current.ownerId, current.id); if (!next) throw new Error('时间线作业处置期间已消失。'); return next;
    } };
  }
  private task(input: { companionId: string; kind: CompanionTaskKind; id: string }): CompanionTaskItem {
    const item = this.overview.resolve({ type: 'tasks.resolve', companionId: input.companionId, kind: input.kind, id: input.id });
    if (!item) throw new Error('这项执行记录不存在，或不属于所选伙伴。');
    return item;
  }
  private unavailable(item: CompanionTaskItem): boolean {
    if (item.kind === 'world' || item.kind === 'memory_timeline') {
      const refs = this.db.prepare('SELECT input_kind,input_id,revision,checksum FROM companion_job_input_refs WHERE owner_id=? AND kind=? AND job_id=?')
        .all(item.companionId, item.kind === 'world' ? 'world' : 'timeline', item.id) as Array<{ input_kind: string; input_id: string; revision: number; checksum: string }>;
      for (const reference of refs) {
        if (reference.input_kind === 'memory' && !this.visibleNote?.(item.companionId, reference.input_id)) return true;
        if (reference.input_kind === 'source') {
          const source = this.db.prepare('SELECT conversation_id,revision,content FROM messages WHERE id=?').get(reference.input_id) as { conversation_id: string; revision: number; content: string } | undefined;
          if (!source || !this.visibleMessage(item.companionId, source.conversation_id, reference.input_id)
            || reference.revision > 0 && reference.revision !== source.revision || reference.checksum && createHash('sha256').update(source.content).digest('hex') !== reference.checksum) return true;
        }
      }
    }
    if (item.sourceMessageId && item.conversationId && !this.visibleMessage(item.companionId, item.conversationId, item.sourceMessageId)) return true;
    const invalid = item.kind === 'action' ? 'action/' + item.id : item.messageId ? 'message/' + item.messageId : undefined;
    if (invalid && this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('execution-source-invalid/' + invalid)) return true;
    if ((item.kind === 'memory_index' || item.kind === 'memory_tags') && item.parentId && this.visibleNote && !this.visibleNote(item.companionId, item.parentId)) return true;
    if (item.kind === 'learning' && this.db.prepare('SELECT 1 FROM companion_learning_grants WHERE id=? AND enabled=0').get(item.id)) return true;
    if (item.kind === 'learning_goal' && this.db.prepare(`SELECT 1 FROM companion_learning_goal_sources s LEFT JOIN companion_learning_grants g ON g.id=s.grant_id
      WHERE s.goal_id=? AND s.grant_id IS NOT NULL AND (g.id IS NULL OR g.enabled=0) LIMIT 1`).get(item.id)) return true;
    if (item.kind === 'memory_timeline' && this.db.prepare(`SELECT 1 FROM companion_task_timeline_jobs t JOIN json_each(CASE WHEN json_valid(t.input) THEN t.input ELSE '{}' END,'$.sources') s
      LEFT JOIN vcp_memory_notes n ON n.id=json_extract(s.value,'$.id') AND n.companion_id=t.companion_id
      WHERE t.id=? AND (n.id IS NULL OR json_extract(n.data,'$.status') IN('forgotten','invalid')) LIMIT 1`).get(item.id)) return true;
    return !!this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(item.companionId);
  }
  private ports(item: CompanionTaskItem, section: CompanionTaskSection): Port[] {
    const ports: Port[] = [], table = tables[item.kind]!;
    const add = (id: string, title: string, expression: string, from: string, where: string, params: Value[], provenance: RecordRow['provenance'] | { sql: string } = 'host', at = 'NULL', state = 'NULL') => {
      ports.push({ sql: `SELECT ${id} AS id,${title} AS title,CAST(${expression} AS TEXT) AS body,${at} AS at,${typeof provenance === 'string' ? "'" + provenance + "'" : provenance.sql} AS provenance,${state} AS state FROM ${from} WHERE ${where} AND ${expression} IS NOT NULL AND CAST(${expression} AS TEXT)!=''`, params });
    };
    const field = (path: string, title: string, provenance: RecordRow['provenance'] = 'source') => add(`'field:${path}'`, `'${title}'`, `json_extract(t.data,'$.${path}')`, `${table} t`, 't.id=?', [item.id], provenance);
    const literal = (id: string, title: string, body: string) => ports.push({ sql: `SELECT ? AS id,? AS title,? AS body,NULL AS at,'host' AS provenance,NULL AS state`, params: [id, title, body] });
    const message = (id: string | undefined, title: string) => {
      if (!id) return;
      const found = this.db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(id) as { conversation_id: string } | undefined;
      if (found && this.visibleMessage(item.companionId, found.conversation_id, id)) add(`'message:'||m.id`, `'${title} · '||CASE WHEN m.author_id='user' THEN '我' ELSE COALESCE((SELECT json_extract(c.data,'$.name') FROM companions c WHERE c.id=m.author_id),m.author_id) END`, 'm.content', 'messages m', 'm.id=?', [id], 'source', 'm.created_at');
    };
    const unavailable = this.unavailable(item);
    if (section === 'process') {
      add("'milestone:'||o.sequence", "COALESCE(NULLIF(o.title,''),'执行状态')", 'o.phase', 'companion_task_observations o', 'o.kind=? AND o.task_id=? AND o.companion_id=?', [item.kind, item.id, item.companionId], 'host', 'o.at', 'o.phase');
    }
    if (unavailable) return ports;
    add("'saved:'||p.record_key", 'p.title', 'p.body', 'companion_task_payloads p', 'p.kind=? AND p.task_id=? AND p.companion_id=? AND p.section=?', [item.kind, item.id, item.companionId, section], { sql: "CASE WHEN p.section='input' THEN 'source' ELSE 'host' END" }, 'p.at');
    const note = (idExpression: string, from: string, where: string, params: Value[], title = '相关记忆文档') => {
      const joined = `${from} JOIN vcp_memory_notes n ON n.id=${idExpression} AND n.companion_id=?`;
      const eligible = this.db.prepare(`SELECT n.id FROM ${joined} WHERE ${where} AND json_extract(n.data,'$.status') NOT IN('forgotten','invalid') LIMIT 100`)
        .all(item.companionId, ...params) as Array<{ id: string }>;
      const allowed = eligible.filter(note => !this.visibleNote || this.visibleNote(item.companionId, note.id)).map(note => note.id);
      if (!allowed.length) return;
      add("'note:'||n.id||':'||json_extract(n.data,'$.version')", `'${title}'`, "json_extract(n.data,'$.content')", joined, `${where} AND n.id IN(${allowed.map(() => '?').join(',')})`, [item.companionId, ...params, ...allowed], 'source', "json_extract(n.data,'$.updatedAt')");
    };
    if (section === 'input') {
      const saved = !!this.db.prepare("SELECT 1 FROM companion_task_payloads WHERE kind=? AND task_id=? AND companion_id=? AND section='input' AND record_key='trigger'").get(item.kind, item.id, item.companionId);
      if (!saved) message(item.sourceMessageId, item.kind === 'memory_capture' ? '当前仍可读取的整理来源' : '当前仍可读取的来源消息');
      if (item.kind === 'activity') field('goal', '活动目标');
      if (item.kind === 'work_order') field('instruction', '委托要求');
      if (item.kind === 'schedule') field('prompt', '计划要求');
      if (item.kind === 'schedule_occurrence' && !this.db.prepare("SELECT 1 FROM companion_task_payloads WHERE kind='schedule_occurrence' AND task_id=? AND companion_id=? AND record_key='schedule_prompt'").get(item.id, item.companionId))
        add("'schedule:prompt'", "'当前计划要求（旧执行输入未保存）'", "json_extract(p.data,'$.prompt')", 'companion_schedule_occurrences t JOIN companion_schedules p ON p.id=t.schedule_id', 't.id=?', [item.id], 'legacy');
      if (item.kind === 'action') add("'action:prompt'", "'工具任务要求'", "json_extract(c.value,'$.prompt')", "metadata c", "c.key='task-checkpoint/'||?", [item.id], 'source');
      if (item.kind === 'learning_goal') field('text', '学习目标');
      if (item.kind === 'learning') { field('libraryName', '授权资料库'); field('folderName', '学习目录'); }
      if (item.kind === 'learning_goal') field('materials', '指定学习资料');
      if (item.kind === 'social') { field('origin.sharedText', '本次交流的共享目标'); field('memberIds', '参与伙伴'); }
      if (item.kind === 'social_notification') field('evidence.text', '触发回报的后续消息');
      if (item.kind === 'life_occurrence') { field('rule.title', '生活规则'); field('rule.action', '计划行动'); field('rule.targetId', '互动对象'); field('rule.durationMinutes', '持续分钟数'); field('reason', '触发条件'); }
      if (item.kind === 'memory_timeline') add("'timeline:input'", "'参与整理的日记'", 't.input', `${table} t`, 't.id=?', [item.id], 'source');
      if (item.kind === 'memory_tags' || item.kind === 'memory_index') note('t.note_id', `${table} t`, 't.id=?', [item.id], '本次处理的文档');
      if (item.kind === 'memory_index') add("'index:version'", "'索引版本与操作'", "'文档版本 '||t.note_version||' · '||CASE t.operation WHEN 'forget' THEN '撤回索引' ELSE '同步索引' END", `${table} t`, 't.id=?', [item.id]);
      if (item.kind === 'world') {
        field('throughEventSequence', '本轮观察的事件截止序号', 'host');
        // The exact consumed decision frame is not copied into this viewer.
        literal('world:trigger', '触发方式', '由世界生活调度触发。下方过程仅展示保留下来的实际调用与宿主回执。');
      }
      if (item.kind === 'world_action') { field('sceneId', '发生地点', 'host'); field('targetId', '互动对象', 'host'); }
      if (item.kind === 'reply') {
        const loop = "r.key=COALESCE('message-loop/'||?,'loop/'||?||'/'||?)", params = [item.messageId ?? null, item.sourceMessageId ?? '', item.companionId];
        add("'loop:system'", "'本轮系统提示'", "json_extract(r.value,'$.context.system')", 'metadata r', loop, params, 'source');
        add("'loop:recall'", "'本轮注入的记忆'", "json_extract(CASE WHEN json_valid(json_extract(r.value,'$.context.user')) THEN json_extract(r.value,'$.context.user') ELSE '{}' END,'$.memoryRecall.context.text')", 'metadata r', loop, params, 'source');
      }
    }
    if (section === 'output') {
      if (item.kind === 'reply') message(item.messageId, ['completed', 'cancelled', 'failed'].includes(item.status) ? '会话中已保存的回复' : '正在生成的回复');
      if (item.kind === 'social' || item.kind === 'social_notification') {
        message(item.messageId, item.kind === 'social' ? '实际发送的伙伴回复' : '实际发送的后续回报');
        if (item.status === 'completed' && !item.messageId) literal('social:no-message', '本次回报结果', '此项没有保存已发送消息的回执。');
      }
      if (item.kind === 'action') { field('result', '工具执行结果', 'host'); field('error', '未完成的原因', 'host'); }
      if (item.kind === 'work_order') { field('result', '委托交付物', 'host'); field('summary', '交付说明', 'host'); }
      if (item.kind === 'schedule_occurrence') { field('result', '本次执行结果', 'host'); field('goalResult', '本次交付内容', 'host'); field('error', '未完成的原因', 'host'); }
      if (item.kind === 'life_occurrence') { field('result', '本次行动结果', 'host'); field('reason', '判定说明', 'host'); }
      if (item.kind === 'learning') { field('afterAssetId', '阅读进度', 'host'); field('error', '学习说明', 'host'); }
      if (item.kind === 'learning_goal') { field('summary', '学习成果', 'host'); field('error', '学习说明', 'host'); }
      if (item.kind === 'learning_goal') add("'round:'||r.id", "'学习轮次 · '||r.ordinal", "json_extract(r.data,'$.summary')", 'companion_learning_goal_rounds r', 'r.goal_id=? AND r.companion_id=?', [item.id, item.companionId], 'model_output', "json_extract(r.data,'$.endedAt')");
      if (item.kind === 'world_action') field('text', '实际发生的事件', 'host');
      if (item.kind === 'world') { field('error', '本轮说明', 'host'); field('dreamComponentFailure.message', '梦境组件说明', 'host'); }
      if (item.kind === 'memory_timeline') add("'timeline:output'", "'已发布的时间线与摘要'", 't.output', `${table} t`, 't.id=?', [item.id], 'host');
      if (item.kind === 'memory_capture') {
        add("'capture:result'", "'归档结果'", "CASE WHEN t.output_note_versions='[]' THEN '已评估来源；本次没有新增日记。' WHEN t.completed_batch_id IS NOT NULL THEN '已完成来源整理，产出文档列在下方。' END", `${table} t`, 't.id=?', [item.id]);
        note("json_extract(v.value,'$.id')", `${table} t JOIN json_each(t.output_note_versions) v`, "t.id=? AND json_extract(n.data,'$.version')=json_extract(v.value,'$.version')", [item.id], '本次归档的日记');
      }
      if (item.kind === 'memory_index') add("'index:result'", "'同步结果'", "CASE WHEN t.status='done' THEN '该索引投递项已处理。' WHEN t.status='stale' THEN '此项已过期，未用旧版本覆盖当前索引。' ELSE t.error END", `${table} t`, 't.id=?', [item.id]);
      if (item.kind === 'memory_tags') note('t.note_id', `${table} t`, 't.id=?', [item.id], '当前资料及标签');
      if (item.kind === 'memory_tags') add("'tags:current'", "'当前文档标签'", "json_extract(n.data,'$.tags')", 'companion_memory_tag_jobs t JOIN vcp_memory_notes n ON n.id=t.note_id', "t.id=? AND n.companion_id=? AND json_extract(n.data,'$.status') NOT IN('forgotten','invalid')", [item.id, item.companionId]);
      if (['memory_capture', 'memory_index', 'memory_tags'].includes(item.kind)) add("'maintenance:error'", "'处理说明'", 't.error', `${table} t`, 't.id=?', [item.id]);
    }
    if (item.kind === 'activity' && section !== 'input') {
      add("'activity:'||h.key", "json_extract(h.value,'$.action')", "json_extract(h.value,'$.result')", `${table} t JOIN json_each(t.data,'$.history') h`, 't.id=?', [item.id],
        { sql: "CASE WHEN json_extract(h.value,'$.resultProvenance')='model_summary_not_execution_fact' OR json_extract(h.value,'$.resultProvenance') IS NULL AND json_extract(h.value,'$.action')='observe' THEN 'model_output' ELSE 'host' END" },
        "json_extract(h.value,'$.at')", "CASE WHEN json_extract(h.value,'$.ok')=1 THEN 'succeeded' ELSE 'failed' END");
    }
    if (item.kind === 'learning' && section !== 'input') add("'read:'||r.id", "'已保存的阅读片段 · '||COALESCE(json_extract(r.data,'$.assetName'),'资料')", 'm.content',
      'companion_learning_reads r JOIN messages m ON m.id=r.source_message_id', `r.grant_id=? AND r.companion_id=? AND r.status='read' AND m.status='sent' AND NOT EXISTS(SELECT 1 FROM vcp_source_blocks b WHERE b.message_id=m.id AND b.companion_id=r.companion_id) AND NOT EXISTS(SELECT 1 FROM metadata x WHERE x.key='execution-source-invalid/message/'||m.id)`, [item.id, item.companionId], 'source', "json_extract(r.data,'$.readAt')");
    if (item.kind === 'learning_goal' && section === 'process') {
      add("'read:'||r.id||':'||v.key", "COALESCE(json_extract(v.value,'$.title'),'本轮阅读资料')", "json_extract(v.value,'$.excerpt')", "companion_learning_goal_rounds r JOIN json_each(r.data,'$.reads') v", 'r.goal_id=? AND r.companion_id=?', [item.id, item.companionId], 'source', "json_extract(v.value,'$.readAt')");
      add("'plan:'||r.id", "'本轮学习计划'", "json_extract(r.data,'$.plan')", 'companion_learning_goal_rounds r', 'r.goal_id=? AND r.companion_id=?', [item.id, item.companionId], 'model_output', "json_extract(r.data,'$.startedAt')");
    }
    if (item.kind === 'action' && section === 'process') add("'event:'||e.key", "json_extract(e.value,'$.summary')", "COALESCE(json_extract(e.value,'$.content'),json_extract(e.value,'$.type'))", `${table} t JOIN json_each(t.data,'$.events') e`, 't.id=?', [item.id], 'host', "json_extract(e.value,'$.receivedAt')", "json_extract(e.value,'$.outputState')");
    // Existing journals contain actual calls/receipts, never private reasoning.
    if (section === 'process') {
      const runWhere = "r.key GLOB 'agent-run/*' AND json_extract(r.value,'$.companionId')=? AND (json_extract(r.value,'$.invocationId')=? OR json_extract(r.value,'$.invocationId') GLOB ?)";
      const params: Value[] = [item.companionId, item.id, item.kind === 'activity' ? item.id + '_[0-9]*' : item.id];
      const loopWhere = "r.key=COALESCE('message-loop/'||?, 'loop/'||?||'/'||?)";
      const loopParams: Value[] = [item.messageId ?? null, item.sourceMessageId ?? '', item.companionId];
      for (const [where, values] of [[runWhere, params], ...(item.kind === 'reply' ? [[loopWhere, loopParams] as const] : [])] as const) {
        add("'call:'||r.key||':'||a.key||':'||c.key", "'调用 · '||json_extract(c.value,'$.name')", "json_extract(c.value,'$.arguments')", "metadata r JOIN json_each(r.value,'$.turns') a JOIN json_each(a.value,'$.calls') c", where, [...values], 'model_proposal');
        add("'receipt:'||r.key||':'||a.key||':'||b.key", "'工具返回'", "json_extract(b.value,'$.content')", "metadata r JOIN json_each(r.value,'$.turns') a JOIN json_each(a.value,'$.results') b", where, [...values], 'host');
      }
    }
    if (section === 'input' && !['reply', 'action', 'memory_timeline', 'memory_capture', 'memory_index', 'memory_tags', 'world_action'].includes(item.kind)) {
      const where = "r.key GLOB 'agent-run/*' AND json_extract(r.value,'$.companionId')=? AND (json_extract(r.value,'$.invocationId')=? OR json_extract(r.value,'$.invocationId') GLOB ?)";
      add("'recall:'||r.key", "'本轮注入的记忆'", "json_extract(r.value,'$.passiveRecall.context.text')", 'metadata r', where,
        [item.companionId, item.id, item.kind === 'activity' ? item.id + '_[0-9]*' : item.id], 'source');
    }
    return ports;
  }
  private query(item: CompanionTaskItem, section: CompanionTaskSection): Port {
    const ports = this.ports(item, section);
    if (!ports.length) return { sql: "SELECT '' AS id,'' AS title,'' AS body,NULL AS at,'host' AS provenance,NULL AS state WHERE 0", params: [] };
    const base = ports.map(port => port.sql).join(' UNION ALL ');
    // Structured receipts become labeled values. Never dump an opaque JSON
    // document into the UI, and never send a huge nested result over IPC.
    return { sql: `WITH source_records AS (${base}) SELECT s.id,s.title,s.body,s.at,s.provenance,s.state FROM source_records s WHERE NOT json_valid(s.body)
      UNION ALL SELECT s.id||':json:'||CASE WHEN LENGTH(j.fullkey)<3000 THEN j.fullkey ELSE SUBSTR(j.fullkey,1,2800)||':'||j.id END,s.title||' · '||j.fullkey,CASE j.type WHEN 'true' THEN '是' WHEN 'false' THEN '否' ELSE CAST(j.atom AS TEXT) END,s.at,s.provenance,s.state
      FROM source_records s JOIN json_tree(CASE WHEN json_valid(s.body) THEN s.body ELSE 'null' END) j
      WHERE j.type IN('text','integer','real','true','false') AND j.fullkey NOT LIKE '%thoughtSignature%' AND j.fullkey NOT LIKE '%apiKey%' AND j.fullkey NOT LIKE '%leaseToken%'`, params: ports.flatMap(port => port.params) };
  }
  private project(row: RecordRow & { characters: number }): CompanionTaskRecord {
    const title = row.title || '执行记录';
    return { id: row.id, title: (title.includes(' · $') ? title.split(' · $')[0] + ' · ' + label('$' + title.split(' · $').slice(1).join(' · $')) : labels[title] ?? title).slice(0, 300),
      text: row.body, totalCharacters: row.characters, provenance: row.provenance, ...(row.at ? { at: row.at } : {}), ...(row.state ? { state: row.state } : {}) };
  }
  inspect(input: z.input<typeof companionTaskInspectCommand>): CompanionTaskDetail {
    const command = companionTaskInspectCommand.parse(input), task = this.task(command), port = this.query(task, command.section);
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM (${port.sql})`).get(...port.params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT id,title,SUBSTR(body,1,4000) AS body,LENGTH(body) AS characters,at,provenance,state FROM (${port.sql}) LIMIT ? OFFSET ?`)
      .all(...port.params, command.limit, command.offset) as Array<RecordRow & { characters: number }>;
    const owner = this.db.prepare("SELECT json_extract(data,'$.name') AS name FROM companions WHERE id=?").get(task.companionId) as { name: string };
    const native = task.kind === 'action' && !this.unavailable(task) ? this.db.prepare("SELECT COALESCE(json_extract(data,'$.executionSummary.recordId'),json_extract(data,'$.taskId')) AS id FROM actions WHERE id=?").get(task.id) as { id?: string } | undefined : undefined;
    const nativeRecordId = native?.id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(native.id) ? native.id : undefined;
    return { task, purpose: purposes[task.kind], companionName: owner.name, conversationTitle: task.conversationTitle,
      section: command.section, items: rows.map(row => this.project(row)), total, offset: command.offset, hasMore: command.offset + rows.length < total,
      observedAt: new Date().toISOString(), ...(nativeRecordId ? { nativeRecordId } : {}), ...(this.unavailable(task) ? { notice: '原始来源已撤回、重置或不可访问；仅保留执行状态，不展示旧正文。' }
        : !total ? { notice: command.section === 'output' && ['queued', 'waiting', 'running', 'paused', 'interrupted'].includes(task.status) ? '这项工作尚无已保存的产出。' : '这部分没有保存可读取的内容；旧记录不会补造输入或结果。' } : {}) };
  }
  content(input: z.input<typeof companionTaskContentCommand>) {
    const command = companionTaskContentCommand.parse(input), task = this.task(command);
    for (const section of ['input', 'process', 'output'] as const) {
      const port = this.query(task, section), row = this.db.prepare(`SELECT id,title,SUBSTR(body,?,?) AS body,LENGTH(body) AS characters,at,provenance,state FROM (${port.sql}) WHERE id=? LIMIT 1`)
        .get(command.offset + 1, command.limit, ...port.params, command.recordId) as RecordRow & { characters: number } | undefined;
      if (row) return { ...this.project(row), offset: command.offset, hasMore: command.offset + command.limit < row.characters };
    }
    throw new Error('这段内容已不可读取，请刷新任务记录。');
  }
}
