import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CompanionConnection } from './store';
import { companionExperienceCommands, companionExperienceDetailSchema, companionExperiencePublishSchema, type CompanionExperienceCommand, type CompanionExperienceDetail, type CompanionExperienceEntry } from '../shared/companion-experience';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { removeOwnedDirectorySync } from '../main/vcp-memory/filesystem';

type Row = Record<string, string | number | null>;
type ProjectionInput = { source: CompanionExperienceEntry['source']['kind']; id: string; owner: string; status?: string; conversationId?: string; data: Record<string, unknown>; historical?: boolean; observedAt?: string };
type Snapshot = Omit<CompanionExperienceDetail, 'entry'> & { entry: CompanionExperienceEntry; fingerprint: string; report?: { path: string; recordId: string } };
const text = (value: unknown) => typeof value === 'string' ? value : '';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const localDay = (at: string, zone: string) => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)); return ['year', 'month', 'day'].map(kind => parts.find(part => part.type === kind)!.value).join('-'); };
const sources: Array<{ table: string; source: ProjectionInput['source']; owner: string; status: string; conversation: string; condition?: string; id?: string; data?: string }> = [
  { table: 'actions', source: 'action', owner: 'n.companion_id', status: 'n.status', conversation: 'n.conversation_id' },
  { table: 'companion_activity_tasks', source: 'activity', owner: 'n.companion_id', status: 'n.status', conversation: 'n.conversation_id' },
  { table: 'companion_learning_goal_rounds', source: 'learning_round', owner: 'n.companion_id', status: "json_extract(n.data,'$.status')", conversation: 'NULL' },
  { table: 'companion_learning_reads', source: 'learning_read', owner: 'n.companion_id', status: 'n.status', conversation: "(SELECT conversation_id FROM messages WHERE id=n.source_message_id)" },
  { table: 'companion_schedule_occurrences', source: 'schedule', owner: '(SELECT companion_id FROM companion_schedules WHERE id=n.schedule_id)', status: 'n.status', conversation: '(SELECT conversation_id FROM companion_schedules WHERE id=n.schedule_id)',
    data: "json_set(n.data,'$.title',COALESCE(json_extract(n.data,'$.snapshot.title'),(SELECT json_extract(data,'$.title') FROM companion_schedules WHERE id=n.schedule_id)),'$.prompt',COALESCE(json_extract(n.data,'$.snapshot.prompt'),(SELECT json_extract(data,'$.prompt') FROM companion_schedules WHERE id=n.schedule_id)))" },
  { table: 'companion_life_occurrences', source: 'life', owner: 'n.companion_id', status: 'n.status', conversation: 'NULL' },
  { table: 'vcp_memory_notes', source: 'memory', owner: 'n.companion_id', status: "json_extract(n.data,'$.status')", conversation: 'n.conversation_id' },
  { table: 'companion_world_jobs', source: 'world_job', owner: 'n.companion_id', status: 'n.status', conversation: "json_extract(n.data,'$.conversationId')", condition: "n.kind='dream'" },
  { table: 'companion_world_events', source: 'world_event', owner: "json_extract(n.data,'$.actorId')", status: "json_extract(n.data,'$.behavior.phase')", conversation: "json_extract(n.data,'$.conversationId')",
    condition: "json_extract(n.data,'$.actorId') IS NOT NULL AND json_extract(n.data,'$.kind') IN('behavior_started','behavior_completed','behavior_interrupted','scene_enter','scene_depart','arrive','life_activity','park_walk_enter','park_walk_start','visit_request','visit_response','visit_leave','work_end')" },
  ...([ ['vcp_capture_jobs', '记忆抽取'], ['vcp_memory_outbox', '记忆索引同步'], ['companion_memory_tag_jobs', '记忆标签整理'] ] as const).map(([table, title]) => ({ table, source: 'memory_processing' as const,
    owner: 'n.companion_id', status: 'n.status', conversation: 'NULL',
    data: `json_object('title','${title}','summary','实际处理状态：'||n.status||'；尝试次数：'||n.attempts,'error',n.error,'createdAt',n.created_at)` })),
  { table: 'metadata', source: 'memory_processing', id: 'n.key', owner: "json_extract(n.value,'$.companionId')", status: "json_extract(n.value,'$.state')", conversation: 'NULL',
    condition: "n.key GLOB 'memory-consolidation/*'", data: "json_object('title','记忆合并与归档','summary','实际合并状态：'||json_extract(n.value,'$.state')||'；原稿数量：'||json_array_length(n.value,'$.inputs'))" },
  { table: 'companion_experience_events', source: 'memory_processing', owner: 'n.companion_id', status: "json_extract(n.data,'$.status')", conversation: "json_extract(n.data,'$.conversationId')" },
];

/** Durable metadata and bounded detail snapshots over actual producer ledgers.
 * This is a UI archive, never a new factual memory source or an AI append tool. */
export class CompanionExperienceStore {
  private readonly root: string;
  constructor(private readonly db: CompanionConnection, dataRoot: string,
    private readonly available: (entry: CompanionExperienceEntry) => boolean,
    private readonly references: (entry: CompanionExperienceEntry) => NonNullable<CompanionStorageResponse['memorySources']>) {
    this.root = path.join(realpathSync(dataRoot), 'experiences');
  }
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_experiences(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,day TEXT NOT NULL,at TEXT NOT NULL,
      title TEXT NOT NULL,custom_title INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,fingerprint TEXT NOT NULL,entry TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_experience_owner_day ON companion_experiences(companion_id,day DESC,at DESC,id);
      CREATE TABLE IF NOT EXISTS companion_experience_events(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_experience_projection(source TEXT NOT NULL,source_id TEXT NOT NULL,companion_id TEXT NOT NULL,payload TEXT NOT NULL,
        observed_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(source,source_id));
      CREATE TABLE IF NOT EXISTS companion_experience_archive(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,revision INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS companion_experience_backfill(source TEXT PRIMARY KEY,through_rowid INTEGER NOT NULL DEFAULT 0,target_rowid INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS companion_experience_archive_insert AFTER INSERT ON companion_experiences BEGIN
        INSERT OR REPLACE INTO companion_experience_archive(id,companion_id,revision) VALUES(NEW.id,NEW.companion_id,NEW.revision); END;
      CREATE TRIGGER IF NOT EXISTS companion_experience_archive_update AFTER UPDATE ON companion_experiences BEGIN
        INSERT OR REPLACE INTO companion_experience_archive(id,companion_id,revision) VALUES(NEW.id,NEW.companion_id,NEW.revision); END;`);
    for (const source of sources) {
      this.db.prepare(`INSERT OR IGNORE INTO companion_experience_backfill(source,target_rowid) SELECT ?,COALESCE(MAX(rowid),0) FROM ${source.table}`).run(source.table);
      const replace = (value: string) => value.replaceAll('n.', 'NEW.');
      const owner = replace(source.owner), id = replace(source.id ?? 'n.id');
      const payload = `json_object('source','${source.source}','id',${id},'owner',${owner},'status',${replace(source.status)},'conversationId',${replace(source.conversation)},'data',json(${replace(source.data ?? 'n.data')}))`;
      // Producers commit only an immutable-input intent. JS/file failures are
      // diagnosed and retried separately, never thrown into an action update.
      const body = source.data ?? 'n.data', relevant = (alias: string) => `json_extract(${body.replaceAll('n.', alias + '.')},'$.title','$.status','$.version','$.result','$.summary','$.content','$.text','$.reason','$.error','$.goal','$.prompt','$.executionSummary.reportPath','$.executionSummary.recordId')`;
      for (const operation of ['INSERT', 'UPDATE']) {
        const conditions = [source.condition && replace(source.condition), operation === 'UPDATE' && `(${replace(source.status)} IS NOT ${source.status.replaceAll('n.', 'OLD.')} OR ${relevant('NEW')} IS NOT ${relevant('OLD')})`].filter(Boolean);
        this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS companion_experience_${source.table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${source.table} ${conditions.length ? 'WHEN ' + conditions.join(' AND ') : ''} BEGIN
        INSERT INTO companion_experience_projection(source,source_id,companion_id,payload,observed_at)
        SELECT '${source.table}',${id},${owner},${payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE ${owner} IN(SELECT id FROM companions WHERE deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=${owner} AND r.status!='completed')
        ON CONFLICT(source,source_id) DO UPDATE SET payload=excluded.payload,attempts=0,next_attempt=0,error=NULL; END;`);
      }
    }
  }
  private put(snapshot: Snapshot): void {
    const entry = snapshot.entry;
    this.db.prepare(`INSERT INTO companion_experiences(id,companion_id,day,at,title,fingerprint,entry,data) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=CASE WHEN custom_title=1 THEN companion_experiences.title ELSE excluded.title END,
        revision=revision+1,fingerprint=excluded.fingerprint,entry=json_set(excluded.entry,'$.timeZone',json_extract(companion_experiences.entry,'$.timeZone')),data=excluded.data
        WHERE companion_experiences.fingerprint!=excluded.fingerprint`).run(entry.id, entry.companionId, entry.day, entry.occurredAt, entry.title, snapshot.fingerprint, JSON.stringify(entry), JSON.stringify(snapshot));
  }
  private projectPending(limit = 24): void {
    for (const pending of this.db.prepare('SELECT * FROM companion_experience_projection WHERE attempts<8 AND next_attempt<=? ORDER BY rowid LIMIT ?').all(Date.now(), limit) as Row[]) {
      try {
        const input = JSON.parse(String(pending.payload)) as ProjectionInput;
        if (this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=companions.id AND r.status!='completed')").get(input.owner))
          this.put(this.project({ ...input, observedAt: String(pending.observed_at) }));
        this.db.prepare('DELETE FROM companion_experience_projection WHERE source=? AND source_id=?').run(pending.source, pending.source_id);
      } catch (error) { this.db.prepare('UPDATE companion_experience_projection SET attempts=attempts+1,next_attempt=?,error=? WHERE source=? AND source_id=?')
        .run(Date.now() + 10000, (error instanceof Error ? error.message : String(error)).slice(0, 1000), pending.source, pending.source_id); }
    }
  }

  private project(input: ProjectionInput): Snapshot {
    const data = input.data, summaryData = object(data.executionSummary), rule = object(data.rule), behavior = object(data.behavior);
    const originalStatus = input.status || text(data.status) || (input.source === 'world_event' ? 'completed' : ''), withdrawn = ['invalid', 'forgotten', 'withdrawn', 'revoked'].includes(originalStatus);
    const status: CompanionExperienceEntry['status'] = withdrawn ? 'withdrawn' : ['succeeded', 'done', 'completed', 'indexed', 'read', 'fired', 'published', 'restored'].includes(originalStatus) ? 'completed'
      : ['failed', 'interrupted'].includes(originalStatus) ? 'failed' : ['cancelled', 'canceled', 'skipped', 'expired', 'stale'].includes(originalStatus) ? 'cancelled'
        : ['paused', 'deferred', 'waiting'].includes(originalStatus) ? 'paused' : ['running', 'active', 'started'].includes(originalStatus) ? 'running' : 'queued';
    const kind: CompanionExperienceEntry['kind'] = input.source === 'action' ? 'dsh' : input.source === 'activity' ? 'activity'
      : input.source.startsWith('learning') ? 'learning' : input.source === 'schedule' ? 'schedule' : input.source === 'life' || input.source === 'world_event' ? 'life'
        : input.source === 'world_job' || object(data.metadata).dream === true ? 'dream' : 'memory';
    const fallback: Record<CompanionExperienceEntry['kind'], string> = { dsh: '执行任务', activity: '伙伴行动', learning: '资料学习', schedule: '定时安排', life: '日常生活', memory: '记忆整理', dream: '睡眠回顾与梦境' };
    const body = withdrawn ? '原资料已撤回，仅保留真实处理状态。' : text(data.result) || text(data.summary) || text(data.content) || text(data.text) || text(data.reason) || text(data.error) || text(data.goal) || text(data.prompt);
    const actionLabels: Record<string, string> = { idle: '自在休息', walking: '走动', seating: '坐下', standingUp: '起身', lyingDown: '躺下', waking: '醒来起床', turning: '转身', sitting: '坐着休息', working: '处理工作', sleeping: '睡觉', eating: '用餐', resting: '休息', habit: '日常活动' };
    const behaviorLabel = actionLabels[text(behavior.kind)];
    const behaviorPhase = ({ started: '开始', completed: '完成', interrupted: '中断' } as Record<string, string>)[text(behavior.phase)] ?? '';
    const behaviorTitle = input.source === 'world_event' && behaviorLabel ? behaviorPhase + behaviorLabel : '';
    const title = withdrawn ? '已撤回的' + fallback[kind] : (text(data.title) || text(summaryData.title) || text(rule.title) || text(data.assetName) || text(data.activityLabel) || text(data.label) || behaviorTitle
      || (kind === 'memory' || input.source === 'world_event' ? body.split(/[\r\n。！？]/u)[0] : '') || fallback[kind]).trim().slice(0, 160);
    const now = input.observedAt ?? new Date().toISOString(), timeZone = localZone();
    // Imported real-ledger timestamps are used only for sources whose contract
    // is real time. Legacy virtual timestamps are retained as source data, not
    // relabelled as actual dates in this archive.
    const historical = input.historical && ({ action: data.createdAt, activity: data.createdAt, learning_round: data.startedAt,
      learning_read: data.readAt, world_event: data.realAt, memory_processing: data.createdAt } as Record<string, unknown>)[input.source];
    const occurredAt = typeof historical === 'string' && Number.isFinite(Date.parse(historical)) ? new Date(historical).toISOString() : now;
    const day = localDay(occurredAt, timeZone), id = 'exp_' + digest([input.owner, input.source, input.id]).slice(0, 48);
    const entry: CompanionExperienceEntry = { id, companionId: input.owner, day, occurredAt, updatedAt: now, timeZone, title: title || fallback[kind], kind,
      origin: ['action', 'activity'].includes(input.source) ? 'action' : 'system', status, revision: 1, summary: body.slice(0, 1000),
      archiveRelativePath: ['experiences', input.owner, day, id].join('/'), source: { kind: input.source, id: input.id,
        ...(input.source === 'memory' && Number.isSafeInteger(data.version) && Number(data.version) > 0 ? { version: Number(data.version) } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}) } };
    const sections = [...(input.source === 'schedule' && text(data.prompt) ? [{ title: '原始日程任务', text: text(data.prompt).slice(0, 65536) }] : []), { title: '经历记录', text: body.slice(0, 1024 * 1024) || fallback[kind] },
      ...(text(data.error) && !withdrawn ? [{ title: '实际错误', text: text(data.error).slice(0, 16000) }] : []),
      ...(input.source === 'world_job' ? [{ title: '记录范围', text: '这是实际睡眠回顾任务的状态记录；完成不代表一定生成梦境或新日记。' }] : [])];
    const artifacts = [{ label: '经历索引', relativePath: entry.archiveRelativePath + '/index.json' }, { label: '经历正文', relativePath: entry.archiveRelativePath + '/detail.md' }];
    const report = input.source === 'action' && !withdrawn && typeof summaryData.reportPath === 'string' && typeof summaryData.recordId === 'string'
      ? { path: summaryData.reportPath, recordId: summaryData.recordId } : undefined;
    if (report) artifacts.push({ label: '执行会话报告', relativePath: entry.archiveRelativePath + '/dsh-report.md' });
    return { entry, sections, artifacts, ...(report ? { report } : {}), fingerprint: digest([title, status, body, sections, report, entry.source.version]) };
  }
  backfill(limit = 100): boolean {
    const state = this.db.prepare('SELECT * FROM companion_experience_backfill WHERE through_rowid<target_rowid ORDER BY source LIMIT 1').get() as Row | undefined;
    if (!state) return !this.db.prepare('SELECT 1 FROM companion_experience_projection WHERE attempts<8 UNION ALL SELECT 1 FROM companion_experience_archive WHERE attempts<8 LIMIT 1').get();
    const source = sources.find(item => item.table === state.source)!;
    const found = this.db.prepare(`SELECT n.rowid AS rowid,${source.id ?? 'n.id'} AS id,${source.owner} AS owner,${source.status} AS status,${source.conversation} AS conversation_id,${source.data ?? 'n.data'} AS data FROM ${source.table} n
      WHERE n.rowid>? AND n.rowid<=? ${source.condition ? 'AND (' + source.condition + ')' : ''} ORDER BY n.rowid LIMIT ?`).all(state.through_rowid, state.target_rowid, Math.max(1, Math.min(200, limit))) as Row[];
    this.db.transaction(() => {
      for (const row of found) {
        if (!row.owner || !this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=companions.id AND r.status!='completed')").get(row.owner)) continue;
        if (source.condition && !this.db.prepare(`SELECT 1 FROM ${source.table} n WHERE ${source.id ?? 'n.id'}=? AND ${source.condition}`).get(row.id)) continue;
        const snapshot = this.project({ source: source.source, id: String(row.id), owner: String(row.owner), status: String(row.status ?? ''), conversationId: row.conversation_id ? String(row.conversation_id) : undefined, data: JSON.parse(String(row.data)), historical: true });
        const entry = snapshot.entry;
        this.db.prepare('INSERT OR IGNORE INTO companion_experiences(id,companion_id,day,at,title,fingerprint,entry,data) VALUES(?,?,?,?,?,?,?,?)').run(entry.id, entry.companionId, entry.day, entry.occurredAt, entry.title, snapshot.fingerprint, JSON.stringify(entry), JSON.stringify(snapshot));
      }
      this.db.prepare('UPDATE companion_experience_backfill SET through_rowid=? WHERE source=?').run(found.at(-1)?.rowid ?? state.target_rowid, source.table);
    }).immediate();
    return false;
  }
  private owner(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(id)) throw Error('伙伴不存在。');
    if (this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(id)) throw Error('伙伴正在重置，暂不能读取经历。');
  }
  resetOwner(owner: string): void {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(owner)) throw Error('经历归属无效。');
    this.db.prepare('DELETE FROM companion_experience_projection WHERE companion_id=?').run(owner);
    this.db.prepare('DELETE FROM companion_experience_events WHERE companion_id=?').run(owner);
    this.db.prepare('DELETE FROM companion_experience_archive WHERE companion_id=?').run(owner);
    this.db.prepare('DELETE FROM companion_experiences WHERE companion_id=?').run(owner);
    const directory = path.join(this.root, owner);
    if (path.dirname(directory) !== this.root) throw Error('经历清理不属于此伙伴。');
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw Error('经历归档根目录不能是链接。');
    if (existsSync(directory)) removeOwnedDirectorySync(directory);
  }
  private entry(row: Row): CompanionExperienceEntry {
    const value = JSON.parse(String(row.entry)) as CompanionExperienceEntry;
    return { ...value, companionId: String(row.companion_id), id: String(row.id), title: String(row.title), day: String(row.day), occurredAt: String(row.at), revision: Number(row.revision),
      archiveRelativePath: ['experiences', row.companion_id, row.day, row.id].join('/') };
  }
  private cursor(value: string | undefined, owner: string, day?: string): { at?: string; id?: string; day?: string } | undefined {
    if (!value) return;
    let parsed: { owner?: string; at?: string; id?: string; day?: string };
    try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw Error('经历分页已失效。'); }
    if (parsed.owner !== owner || day !== undefined && parsed.day !== day) throw Error('经历游标不属于当前伙伴或日期。');
    return parsed;
  }
  private detail(row: Row): CompanionExperienceDetail {
    const saved = JSON.parse(String(row.data)) as Snapshot, entry = this.entry(row);
    if (!this.available(entry)) return { entry: { ...entry, title: '引用资料已撤回的经历', status: 'withdrawn', summary: '引用资料已撤回，保留实际处理记录。' }, sections: [{ title: '资料已撤回', text: '原经历的引用资料已不可用，不再显示旧正文或报告内容。' }], artifacts: [] };
    return companionExperienceDetailSchema.parse({ entry, sections: saved.sections, artifacts: saved.artifacts.map(artifact => ({ ...artifact,
      relativePath: artifact.relativePath.replace(saved.entry.archiveRelativePath, entry.archiveRelativePath) })) });
  }
  execute(input: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!input.type.startsWith('experience.')) return;
    if (input.type === 'experience.publish') { const receipt = companionExperiencePublishSchema.parse(input); this.owner(receipt.companionId); this.db.prepare('INSERT INTO companion_experience_events(id,companion_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE companion_id=excluded.companion_id').run(receipt.id, receipt.companionId, JSON.stringify(receipt)); return { ok: true }; }
    const command = companionExperienceCommands.find(schema => schema.shape.type.value === input.type)?.parse(input) as CompanionExperienceCommand | undefined;
    if (!command) return;
    this.owner(command.companionId);
    if (command.type === 'experience.days') {
      const after = this.cursor(command.cursor, command.companionId), found = this.db.prepare(`SELECT day,COUNT(*) AS count FROM companion_experiences INDEXED BY companion_experience_owner_day
        WHERE companion_id=? AND (?='' OR day<?) GROUP BY day ORDER BY day DESC LIMIT ?`).all(command.companionId, after?.day ?? '', after?.day ?? '', command.limit + 1) as Row[];
      const days = found.slice(0, command.limit).map(row => ({ day: String(row.day), count: Number(row.count) })), hasMore = found.length > command.limit;
      return { ok: true, experienceDays: { companionId: command.companionId, timeZone: localZone(), days, hasMore,
        ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ owner: command.companionId, day: days.at(-1)!.day })).toString('base64url') } : {}) } };
    }
    if (command.type === 'experience.list') {
      const after = this.cursor(command.cursor, command.companionId, command.day), found = this.db.prepare(`SELECT id,companion_id,day,at,title,revision,entry FROM companion_experiences INDEXED BY companion_experience_owner_day
        WHERE companion_id=? AND day=? AND (?='' OR at<? OR at=? AND id>?) ORDER BY at DESC,id LIMIT ?`).all(command.companionId, command.day, after?.at ?? '', after?.at ?? '', after?.at ?? '', after?.id ?? '', command.limit + 1) as Row[];
      const selected = found.slice(0, command.limit), items = selected.map(row => { const entry = this.entry(row); return this.available(entry) ? entry : { ...entry, title: '引用资料已撤回的经历', status: 'withdrawn' as const, summary: '引用资料已撤回，保留实际处理记录。' }; }), hasMore = found.length > command.limit, last = selected.at(-1);
      return { ok: true, actions: this.actions(items), experiencePage: { companionId: command.companionId, day: command.day, timeZone: localZone(), items, hasMore,
        ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ owner: command.companionId, day: command.day, at: last.at, id: last.id })).toString('base64url') } : {}) } };
    }
    const row = this.db.prepare('SELECT * FROM companion_experiences WHERE id=? AND companion_id=?').get(command.id, command.companionId) as Row | undefined;
    if (!row) throw Error('经历不存在或不属于当前伙伴。');
    if (command.type === 'experience.rename') {
      if (Number(row.revision) !== command.expectedRevision) throw Error('经历版本已变化，请重新读取后命名。');
      this.db.prepare("UPDATE companion_experiences SET title=?,custom_title=1,revision=revision+1,entry=json_set(entry,'$.updatedAt',?) WHERE id=? AND companion_id=?").run(command.title, new Date().toISOString(), command.id, command.companionId);
      return { ok: true, experienceEntry: this.entry(this.db.prepare('SELECT * FROM companion_experiences WHERE id=?').get(command.id) as Row) };
    }
    const detail = this.detail(row), report = path.join(this.root, detail.entry.companionId, detail.entry.day, detail.entry.id, 'dsh-report.md');
    if (detail.entry.status !== 'withdrawn' && existsSync(report) && this.regularArchive(report))
      detail.sections.push({ title: '执行会话报告', text: readFileSync(report, 'utf8').slice(0, 1024 * 1024) });
    return { ok: true, actions: this.actions([detail.entry]), memorySources: detail.entry.status === 'withdrawn' ? [] : this.references(detail.entry), experienceDetail: detail };
  }
  private actions(entries: CompanionExperienceEntry[]): NonNullable<CompanionStorageResponse['actions']> {
    return entries.filter(entry => entry.source.kind === 'action').flatMap(entry => {
      const row = this.db.prepare('SELECT data FROM actions WHERE id=? AND companion_id=?').get(entry.source.id, entry.companionId) as Row | undefined;
      return row ? [JSON.parse(String(row.data))] : [];
    });
  }
  private regularArchive(file: string): boolean {
    const relative = path.relative(this.root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    let current = this.root;
    for (const part of ['', ...relative.split(path.sep)]) {
      if (part) current = path.join(current, part);
      if (!existsSync(current) || lstatSync(current).isSymbolicLink()) return false;
    }
    return lstatSync(file).isFile();
  }
  /** A committed outbox survives restart. Files never become an alternate index. */
  flush(limit = 8): void {
    this.projectPending();
    for (const job of this.db.prepare('SELECT * FROM companion_experience_archive WHERE attempts<8 AND next_attempt<=? ORDER BY rowid LIMIT ?').all(Date.now(), limit) as Row[]) {
      const row = this.db.prepare('SELECT * FROM companion_experiences WHERE id=? AND companion_id=?').get(job.id, job.companion_id) as Row | undefined;
      if (!row) { this.db.prepare('DELETE FROM companion_experience_archive WHERE id=?').run(job.id); continue; }
      try {
        const detail = this.detail(row), entry = detail.entry;
        let directory = this.root;
        for (const component of ['', entry.companionId, entry.day, entry.id]) {
          if (component) directory = path.join(directory, component);
          if (!existsSync(directory)) mkdirSync(directory, { recursive: false });
          if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error('经历归档路径不能包含目录链接。');
        }
        const source = (JSON.parse(String(row.data)) as Snapshot).report;
        if (source && entry.status !== 'withdrawn') {
          const report = path.resolve(source.path), parts = report.split(path.sep), marker = parts.lastIndexOf('by-owner');
          if (marker < 1 || parts[marker - 1] !== 'task-records' || parts[marker + 1] !== entry.companionId
            || !path.basename(path.dirname(report)).endsWith('--' + source.recordId) || path.basename(report) !== 'report.md'
            || lstatSync(report).isSymbolicLink() || !lstatSync(report).isFile() || realpathSync(report) !== report) throw Error('执行报告不属于此伙伴的真实会话归档。');
          const target = path.join(directory, 'dsh-report.md');
          if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw Error('经历报告不能是链接。');
          copyFileSync(report, target);
        }
        this.writeArchive(directory, 'index.json', JSON.stringify(detail, null, 2));
        this.writeArchive(directory, 'detail.md', '# ' + entry.title + '\n\n' + entry.occurredAt + ' · ' + entry.status + '\n\n' + detail.sections.map(section => '## ' + section.title + '\n\n' + section.text).join('\n\n'));
        this.db.prepare('DELETE FROM companion_experience_archive WHERE id=? AND revision=?').run(job.id, row.revision);
      } catch (error) { this.db.prepare('UPDATE companion_experience_archive SET attempts=attempts+1,next_attempt=?,error=? WHERE id=?').run(Date.now() + 10000, (error instanceof Error ? error.message : String(error)).slice(0, 1000), job.id); }
    }
  }
  private writeArchive(directory: string, name: string, content: string): void {
    if (lstatSync(directory).isSymbolicLink()) throw Error('经历归档目录不能是链接。');
    const file = path.join(directory, name);
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw Error('经历归档文件不是受管普通文件。');
    const temporary = path.join(directory, name + '.' + randomUUID() + '.tmp'); writeFileSync(temporary, content, { flag: 'wx' }); renameSync(temporary, file);
  }
}
