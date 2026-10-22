import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionMemoryTraceListCommand, companionMemoryTraceInspectCommand, type CompanionMemoryTrace, type CompanionMemoryTraceEntry, type CompanionMemoryTracePage, type CompanionMemoryTraceRecord } from '../shared/companion-memory-trace';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';

type Row = Record<string, string | number | null>;
const sources = ['vcp_memory_notes', 'companion_learning_reads', 'companion_world_jobs'] as const;
type Source = typeof sources[number];
const text = (value: unknown) => String(value ?? '');
const live = "json_extract(n.data,'$.status') IN('queued','indexed')";
const noteKind = "CASE WHEN json_extract(n.data,'$.metadata.dream')=1 THEN 'dream' ELSE 'journal' END";
const metadataVersion = 2;
// A title may quote only this bounded opening, never index or return the complete body.
const opening = "TRIM(LTRIM(SUBSTR(COALESCE(json_extract(n.data,'$.content'),''),1,120),char(9)||char(10)||char(13)||' #>*-'))";
const firstLine = `SUBSTR(${opening},1,MIN(${[
  `COALESCE(NULLIF(INSTR(${opening},char(10)),0)-1,120)`,
  ...['。', '！', '？', '.', '!', '?'].map(mark => `COALESCE(NULLIF(INSTR(${opening},'${mark}'),0),120)`),
].join(',')}))`;
const named = ['title', 'documentName', 'documentTitle'].map(key => `NULLIF(TRIM(SUBSTR(CASE WHEN json_type(n.data,'$.metadata.${key}')='text' THEN json_extract(n.data,'$.metadata.${key}') END,1,120)),'')`);
const naturalTitle = `SUBSTR(COALESCE(${named.join(',')},NULLIF(TRIM(${firstLine}),''),NULLIF(TRIM(json_extract(n.data,'$.diaryName')),''),'记忆日记'),1,120)`;
const title = `CASE WHEN ${live} THEN ${naturalTitle} ELSE '已撤回的记忆记录' END`;
const assetProof = (alias: string) => `json_object('asset',json_object('libraryId',json_extract(${alias}.data,'$.libraryId'),'assetId',json_extract(${alias}.data,'$.assetId'),'assetRevisionId',json_extract(${alias}.data,'$.assetRevisionId'),'offset',json_extract(${alias}.data,'$.offset'),'characters',json_extract(${alias}.data,'$.characters'),'contentHash',json_extract(${alias}.data,'$.contentHash')))`;
const projection: Record<Source, string> = {
  vcp_memory_notes: `SELECT n.companion_id,${noteKind},n.id,${title},json_extract(n.data,'$.status'),COALESCE(json_extract(n.data,'$.createdAt'),''),CASE WHEN ${live} THEN n.id||' '||${naturalTitle}||' '||COALESCE(json_extract(n.data,'$.diaryName'),'') ELSE n.id END FROM vcp_memory_notes n`,
  companion_learning_reads: "SELECT n.companion_id,'learning',n.id,CASE WHEN n.status='read' THEN SUBSTR(COALESCE(json_extract(n.data,'$.assetName'),'已读资料'),1,160) ELSE '已撤回的阅读记录' END,n.status,COALESCE(json_extract(n.data,'$.readAt'),''),CASE WHEN n.status='read' THEN n.id||' '||COALESCE(json_extract(n.data,'$.assetName'),'') ELSE n.id END FROM companion_learning_reads n",
  companion_world_jobs: "SELECT n.companion_id,'sleep',n.id,'睡眠回顾',n.status,COALESCE(json_extract(n.data,'$.createdAt'),''),n.id||' 睡眠回顾' FROM companion_world_jobs n",
};
const write = (source: Source, where: string) => `INSERT INTO companion_memory_trace_catalog(companion_id,kind,entity_id,title,status,at,search) ${projection[source]} WHERE ${source === 'companion_world_jobs' ? "n.kind='dream' AND " : ''}${where} ON CONFLICT(companion_id,kind,entity_id) DO UPDATE SET title=excluded.title,status=excluded.status,at=excluded.at,search=excluded.search`;

/** Rebuildable metadata index; the journal/source ledgers remain the only evidence. */
export class CompanionMemoryTraceStore {
  constructor(private readonly db: CompanionConnection,
    private readonly noteVisible: (owner: string, noteId: string) => boolean,
    private readonly sourceVisible: (owner: string, conversationId: string, messageId: string) => boolean) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_memory_trace_catalog(row_id INTEGER PRIMARY KEY,companion_id TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,at TEXT NOT NULL,search TEXT NOT NULL,UNIQUE(companion_id,kind,entity_id));
      CREATE INDEX IF NOT EXISTS companion_trace_owner_time ON companion_memory_trace_catalog(companion_id,at DESC,kind,entity_id);
      CREATE INDEX IF NOT EXISTS companion_trace_owner_kind_time ON companion_memory_trace_catalog(companion_id,kind,at DESC,entity_id);
      CREATE TABLE IF NOT EXISTS companion_memory_trace_backfill(source TEXT PRIMARY KEY,through_rowid INTEGER NOT NULL,target_rowid INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS companion_memory_trace_search USING fts5(search,content='companion_memory_trace_catalog',content_rowid='row_id',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS companion_trace_fts_insert AFTER INSERT ON companion_memory_trace_catalog BEGIN INSERT INTO companion_memory_trace_search(rowid,search) VALUES(new.row_id,new.search); END;
      CREATE TRIGGER IF NOT EXISTS companion_trace_fts_delete AFTER DELETE ON companion_memory_trace_catalog BEGIN INSERT INTO companion_memory_trace_search(companion_memory_trace_search,rowid,search) VALUES('delete',old.row_id,old.search); END;
      CREATE TRIGGER IF NOT EXISTS companion_trace_fts_update AFTER UPDATE OF search ON companion_memory_trace_catalog BEGIN INSERT INTO companion_memory_trace_search(companion_memory_trace_search,rowid,search) VALUES('delete',old.row_id,old.search); INSERT INTO companion_memory_trace_search(rowid,search) VALUES(new.row_id,new.search); END;`);
    const version = this.db.prepare("SELECT value FROM metadata WHERE key='memory-trace-metadata-version'").get() as Row | undefined;
    const upgrade = Number(version?.value ?? 0) !== metadataVersion;
    if (upgrade) this.db.exec('DROP TRIGGER IF EXISTS companion_trace_vcp_memory_notes_insert; DROP TRIGGER IF EXISTS companion_trace_vcp_memory_notes_update; DROP TRIGGER IF EXISTS companion_trace_vcp_memory_notes_delete');
    for (const source of sources) {
      const kinds = source === 'vcp_memory_notes' ? "'journal','dream'" : source === 'companion_learning_reads' ? "'learning'" : "'sleep'";
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS companion_trace_${source}_insert AFTER INSERT ON ${source} BEGIN ${write(source, 'n.id=new.id')}; END;
        CREATE TRIGGER IF NOT EXISTS companion_trace_${source}_update AFTER UPDATE ON ${source} BEGIN DELETE FROM companion_memory_trace_catalog WHERE companion_id=old.companion_id AND entity_id=old.id AND kind IN(${kinds}); ${write(source, 'n.id=new.id')}; END;
        CREATE TRIGGER IF NOT EXISTS companion_trace_${source}_delete AFTER DELETE ON ${source} BEGIN DELETE FROM companion_memory_trace_catalog WHERE companion_id=old.companion_id AND entity_id=old.id AND kind IN(${kinds}); END;`);
      this.db.prepare(`INSERT OR IGNORE INTO companion_memory_trace_backfill VALUES(?,0,(SELECT COALESCE(MAX(rowid),0) FROM ${source}))`).run(source);
    }
    if (upgrade) {
      this.db.prepare("UPDATE companion_memory_trace_backfill SET through_rowid=0,target_rowid=(SELECT COALESCE(MAX(rowid),0) FROM vcp_memory_notes) WHERE source='vcp_memory_notes'").run();
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('memory-trace-metadata-version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(metadataVersion));
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_trace_read_time ON companion_learning_reads(companion_id,json_extract(data,'$.readAt') DESC,id); CREATE INDEX IF NOT EXISTS companion_trace_sleep_time ON companion_world_jobs(companion_id,kind,json_extract(data,'$.createdAt') DESC,id)");
  }
  /** Worker maintenance only. A read request never fills the index. */
  backfill(limit = 200): boolean {
    const bound = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.db.transaction(() => {
      for (const source of sources) {
        const state = this.db.prepare('SELECT through_rowid,target_rowid FROM companion_memory_trace_backfill WHERE source=?').get(source) as Row;
        if (Number(state.through_rowid) >= Number(state.target_rowid)) continue;
        const rows = this.db.prepare(`SELECT rowid AS n FROM ${source} WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`).all(state.through_rowid, state.target_rowid, bound) as Row[];
        const through = rows.length ? Number(rows.at(-1)!.n) : Number(state.target_rowid);
        this.db.prepare(write(source, 'n.rowid>? AND n.rowid<=?')).run(state.through_rowid, through);
        this.db.prepare('UPDATE companion_memory_trace_backfill SET through_rowid=? WHERE source=?').run(through, source);
        break;
      }
      return !this.db.prepare('SELECT 1 FROM companion_memory_trace_backfill WHERE through_rowid<target_rowid LIMIT 1').get();
    }).immediate();
  }
  private owner(owner: string): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(owner)) throw new Error('伙伴不存在。');
  }
  private entry(owner: string, kind: CompanionMemoryTraceEntry['kind'], id: string): CompanionMemoryTraceEntry {
    const table = kind === 'learning' ? 'companion_learning_reads' : kind === 'sleep' ? 'companion_world_jobs' : 'vcp_memory_notes';
    const found = this.db.prepare(`SELECT n.id,n.companion_id,${kind === 'journal' || kind === 'dream' ? `${noteKind} AS kind,${title} AS title,json_extract(n.data,'$.status') AS status,COALESCE(json_extract(n.data,'$.createdAt'),'') AS at,json_extract(n.data,'$.version') AS version,n.conversation_id AS conversation_id,NULL AS source_message_id`
      : kind === 'learning' ? "'learning' AS kind,CASE WHEN n.status='read' THEN SUBSTR(COALESCE(json_extract(n.data,'$.assetName'),'已读资料'),1,160) ELSE '已撤回的阅读记录' END AS title,n.status,json_extract(n.data,'$.readAt') AS at,NULL AS version,(SELECT conversation_id FROM messages WHERE id=n.source_message_id) AS conversation_id,n.source_message_id," + assetProof('n') + ' AS proof'
        : "'sleep' AS kind,'睡眠回顾' AS title,n.status,json_extract(n.data,'$.createdAt') AS at,NULL AS version,json_extract(n.data,'$.conversationId') AS conversation_id,NULL AS source_message_id"} FROM ${table} n WHERE n.id=? AND n.companion_id=? ${kind === 'sleep' ? "AND n.kind='dream'" : ''}`).get(id, owner) as Row | undefined;
    if (!found || text(found.kind) !== kind && !(['journal', 'dream'].includes(kind) && !['queued', 'indexed'].includes(text(found.status)))) throw new Error('这条成长记录不属于当前伙伴或类型。');
    const visible = kind === 'journal' || kind === 'dream' ? ['queued', 'indexed'].includes(text(found.status)) && this.noteVisible(owner, id)
      : kind === 'learning' ? found.status === 'read' && !!found.conversation_id && this.sourceVisible(owner, text(found.conversation_id), text(found.source_message_id)) : true;
    return { kind, id, title: visible ? text(found.title) : kind === 'learning' ? '已撤回或失效的阅读记录' : '已撤回或失效的记忆记录', status: text(found.status), redacted: !visible,
      ...(found.at ? { at: text(found.at) } : {}), ...(visible && found.version ? { version: Number(found.version), noteId: id } : {}),
      ...(visible && found.proof ? JSON.parse(text(found.proof)) as { asset: NonNullable<CompanionMemoryTraceEntry['asset']> } : {}),
      ...(visible && found.source_message_id ? { sourceMessageId: text(found.source_message_id) } : {}), ...(visible && found.conversation_id ? { conversationId: text(found.conversation_id) } : {}) };
  }
  list(input: Extract<CompanionStorageCommand, { type: 'memory.trace.list' }>): CompanionMemoryTracePage {
    const query = companionMemoryTraceListCommand.parse(input); this.owner(query.companionId);
    if (query.from && query.to && query.from > query.to) throw new Error('开始时间不能晚于结束时间。');
    const fingerprint = createHash('sha256').update(JSON.stringify([query.companionId, query.kind, query.query, query.from, query.to])).digest('hex');
    const where = ['c.companion_id=?'], args: unknown[] = [query.companionId];
    if (query.kind !== 'all') { where.push('c.kind=?'); args.push(query.kind); }
    const tokens = query.query.toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 20), long = tokens.filter(token => [...token].length >= 3);
    if (long.length) { where.push('c.row_id IN(SELECT rowid FROM companion_memory_trace_search WHERE companion_memory_trace_search MATCH ?)'); args.push(long.map(token => '"' + token.replaceAll('"', '""') + '"').join(' AND ')); }
    for (const token of tokens.filter(token => [...token].length < 3)) { where.push('instr(lower(c.search),?)>0'); args.push(token); }
    if (query.from) { where.push('c.at>=?'); args.push(query.from); } if (query.to) { where.push('c.at<=?'); args.push(query.to); }
    if (query.cursor) {
      let cursor: { fingerprint: string; at: string; kind: string; id: string };
      try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); if (cursor.fingerprint !== fingerprint || typeof cursor.at !== 'string' || typeof cursor.kind !== 'string' || typeof cursor.id !== 'string' || cursor.id.length > 100) throw new Error(); }
      catch { throw new Error('成长足迹搜索条件已变化，请重新查询。'); }
      where.push('(c.at<? OR c.at=? AND (c.kind>? OR c.kind=? AND c.entity_id>?))'); args.push(cursor.at, cursor.at, cursor.kind, cursor.kind, cursor.id);
    }
    const found = this.db.prepare(`SELECT c.kind,c.entity_id,c.at FROM companion_memory_trace_catalog c WHERE ${where.join(' AND ')} ORDER BY c.at DESC,c.kind,c.entity_id LIMIT ?`).all(...args, query.limit + 1) as Row[];
    const rows = found.slice(0, query.limit), last = rows.at(-1), hasMore = found.length > query.limit;
    return { companionId: query.companionId, entries: rows.map(row => this.entry(query.companionId, text(row.kind) as CompanionMemoryTraceEntry['kind'], text(row.entity_id))), hasMore,
      ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ fingerprint, at: last.at, kind: last.kind, id: last.entity_id })).toString('base64url') } : {}),
      index: { state: this.db.prepare('SELECT 1 FROM companion_memory_trace_backfill WHERE through_rowid<target_rowid LIMIT 1').get() ? 'indexing' : 'ready', scope: 'metadata',
        indexed: Number((this.db.prepare('SELECT COUNT(*) AS n FROM companion_memory_trace_catalog WHERE companion_id=?').get(query.companionId) as Row).n) } };
  }
  inspect(input: Extract<CompanionStorageCommand, { type: 'memory.trace.inspect' }>): CompanionMemoryTrace {
    const query = companionMemoryTraceInspectCommand.parse(input), owner = query.companionId; this.owner(owner);
    if (query.cursor && !query.stage) throw new Error('请指定成长链阶段后再翻页。');
    const root = this.entry(owner, query.kind, query.id);
    if (root.redacted) return { companionId: owner, root, stages: [], hasMore: false,
      limitations: ['该记录已撤回、来源变化或当前不可见；只保留最少状态，不恢复旧正文或关系。'] };
    const kinds = query.stage ? [query.stage] : ['reading', 'capture', 'memory', 'index', 'tags', 'sleep', 'dream'] as const;
    const stages = kinds.map(stage => this.stage(owner, root, stage, query.limit, query.cursor));
    return { companionId: owner, root, stages, hasMore: stages.some(stage => stage.hasMore), limitations: [
      '历史任务可能未保存批次结果；只有明确批次凭证才标为保存/确认，去重复用不冒充新创。',
      '普通整合依赖原记忆版本，但未保存具体睡眠任务ID；只有明确梦境元数据才可指向那次梦境任务。',
      '阅读与索引投递确认不等于理解、认同或实时检索健康；原模型逐字证据片段未保存，不伪造引文。',
      '睡眠回顾可以没有新增反思或梦境；状态结束本身不能证明完成回顾，以版本水印为准。',
      '每次只展开真实一层关联；各阶段可独立翻页，缺少记录不代表全部历史从未产出。',
    ] };
  }
  private stage(owner: string, root: CompanionMemoryTraceEntry, stage: CompanionMemoryTrace['stages'][number]['kind'], limit: number, cursor?: string): CompanionMemoryTrace['stages'][number] {
    const labels = { reading: '真实来源与阅读', capture: '来源整理', memory: '引用与内化记忆', index: '索引投递', tags: '标签整理', sleep: '睡眠回顾', dream: '梦境联想' };
    const fingerprint = createHash('sha256').update(JSON.stringify([owner, root.kind, root.id, stage])).digest('hex');
    let after: { at: string; uid: string } | undefined;
    if (cursor) {
      try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { fingerprint: string; at: string; uid: string };
        if (parsed.fingerprint !== fingerprint || typeof parsed.at !== 'string' || typeof parsed.uid !== 'string' || parsed.uid.length > 180) throw new Error();
        after = parsed;
      } catch { throw new Error('成长链分页不属于当前伙伴、记录或阶段。'); }
    }
    const columns = (kind: string, id: string, title: string, status: string, at: string, note: string, version: string, source: string, conversation: string, relation: string, detail: string, proof = 'NULL') =>
      `${kind}||':'||${id}||COALESCE('_v'||${version},'') AS uid,${kind} AS kind,${id} AS entity_id,SUBSTR(COALESCE(${title},''),1,160) AS title,${status} AS status,COALESCE(${at},'') AS at,${note} AS note_id,${version} AS version,${source} AS source_id,${conversation} AS conversation_id,${relation} AS relation,'${detail}' AS detail,${proof} AS proof`;
    const cte = `WITH root_notes(id) AS (
      SELECT n.id FROM vcp_memory_notes n WHERE n.companion_id=@owner AND n.id=@root AND @kind IN('journal','dream')
      UNION SELECT n.id FROM vcp_memory_notes n JOIN vcp_note_sources s ON s.note_id=n.id JOIN companion_learning_reads r ON r.source_message_id=s.message_id WHERE @kind='learning' AND r.id=@root AND r.companion_id=@owner AND n.companion_id=@owner AND r.status='read'
      UNION SELECT n.id FROM vcp_memory_notes n JOIN companion_world_jobs j ON j.id=@root AND j.companion_id=@owner JOIN json_each(j.data,'$.memoryVersions') v ON json_extract(v.value,'$.id')=n.id AND json_extract(v.value,'$.version')=json_extract(n.data,'$.version') WHERE @kind='sleep' AND n.companion_id=@owner
    ), live_notes(id) AS (SELECT n.id FROM vcp_memory_notes n JOIN root_notes r ON r.id=n.id WHERE json_extract(n.data,'$.status') IN('queued','indexed')),
    root_sources(id) AS (
      SELECT r.source_message_id FROM companion_learning_reads r WHERE @kind='learning' AND r.id=@root AND r.companion_id=@owner AND r.status='read'
      UNION SELECT s.message_id FROM vcp_note_sources s JOIN live_notes n ON n.id=s.note_id
    ), related_notes(id) AS (
      SELECT id FROM live_notes UNION SELECT d.note_id FROM vcp_note_dependencies d JOIN live_notes n ON n.id=d.source_note_id
      UNION SELECT d.source_note_id FROM vcp_note_dependencies d JOIN live_notes n ON n.id=d.note_id
    ), records AS (`;
    let sql: string;
    if (stage === 'reading') {
      sql = `SELECT ${columns("'learning'", 'r.id', "json_extract(r.data,'$.assetName')", 'r.status', "json_extract(r.data,'$.readAt')", 'NULL', 'NULL', 'r.source_message_id', 'm.conversation_id', "'exact_source'", '真实阅读回执证明读取过该资产版本片段；不代表认可或掌握。', assetProof('r'))} FROM companion_learning_reads r JOIN messages m ON m.id=r.source_message_id WHERE r.companion_id=@owner AND r.status='read' AND r.source_message_id IN(SELECT id FROM root_sources)
        UNION ALL SELECT ${columns("'source'", 'm.id', "'原始来源记录'", "'available'", 'm.created_at', 'NULL', 'm.revision', 'm.id', 'm.conversation_id', "'exact_source'", '仅定位真实来源，不保存或伪造原模型逐字证据片段。')} FROM messages m WHERE m.id IN(SELECT id FROM root_sources)`;
    } else if (stage === 'capture') {
      const proof = `CASE WHEN j.completed_batch_id IS NOT NULL AND j.output_note_versions IS NOT NULL THEN json_object('captureBatchId',j.completed_batch_id,'outputCount',json_array_length(j.output_note_versions),'outputs',json(COALESCE((
        SELECT json_group_array(json_object('noteId',n.id,'version',json_extract(o.value,'$.version'))) FROM json_each(j.output_note_versions) o
        JOIN vcp_memory_notes n ON n.id=json_extract(o.value,'$.id') AND n.companion_id=@owner AND json_extract(n.data,'$.version')=json_extract(o.value,'$.version')
        WHERE n.id IN(SELECT id FROM live_notes) AND json_extract(n.data,'$.status') IN('queued','indexed') AND CAST(o.key AS INTEGER)<100),'[]'))) ELSE NULL END`;
      sql = `SELECT ${columns("'capture'", 'j.id', "'来源整理'", 'j.status', 'COALESCE(j.updated_at,j.created_at)', 'NULL', 'j.source_revision', 'j.message_id', 'j.conversation_id', "'shared_source'", '任务与日记共享原始来源；历史记录没有可验证的批次输出凭证时，不补造一对一因果。', proof)} FROM vcp_capture_jobs j JOIN messages m ON m.id=j.message_id AND m.revision=j.source_revision WHERE j.companion_id=@owner AND j.message_id IN(SELECT id FROM root_sources)`;
    } else if (stage === 'memory' || stage === 'dream') {
      const dream = stage === 'dream';
      sql = `SELECT ${columns(noteKind, 'n.id', title, "json_extract(n.data,'$.status')", "json_extract(n.data,'$.createdAt')", 'n.id', "json_extract(n.data,'$.version')", 'NULL', 'n.conversation_id', "CASE WHEN n.id=@root THEN 'root' WHEN n.id IN(SELECT id FROM live_notes) THEN 'exact_source' ELSE 'dependency' END", dream ? '梦境是虚拟联想；真实依赖来自日记版本，明确任务关联仅以已保存worldJobId为准。' : '当前可见记忆与真实来源或版本依赖有关联；不声称已经掌握或由某一次任务直接产出。', dream ? "CASE WHEN EXISTS(SELECT 1 FROM companion_world_jobs proof WHERE proof.id=json_extract(n.data,'$.metadata.worldJobId') AND proof.companion_id=@owner AND proof.kind='dream' AND json_extract(proof.data,'$.sleepEpisodeId')=json_extract(n.data,'$.metadata.sleepEpisodeId')) THEN json_object('worldJobId',json_extract(n.data,'$.metadata.worldJobId'),'sleepEpisodeId',json_extract(n.data,'$.metadata.sleepEpisodeId')) ELSE NULL END" : 'NULL')} FROM vcp_memory_notes n WHERE n.companion_id=@owner AND json_extract(n.data,'$.status') IN('queued','indexed') AND ${dream ? "json_extract(n.data,'$.metadata.dream')=1" : "COALESCE(json_extract(n.data,'$.metadata.dream'),0)=0"} AND (n.id IN(SELECT id FROM related_notes) ${dream ? "OR @kind='sleep' AND json_extract(n.data,'$.metadata.worldJobId')=@root" : ''})`;
    } else if (stage === 'index' || stage === 'tags') {
      const table = stage === 'index' ? 'vcp_memory_outbox' : 'companion_memory_tag_jobs';
      sql = `SELECT ${columns(`'${stage}'`, 'j.id', stage === 'index' ? "'记忆索引投递'" : "'文档标签整理'", 'j.status', 'COALESCE(j.updated_at,j.created_at)', 'j.note_id', 'j.note_version', 'NULL', 'NULL', "'delivery'", stage === 'index' ? '完成是该版本宿主投递确认，不代替当前实时向量检索健康检查。' : '这是该日记版本独立标签任务的实际状态。')} FROM ${table} j WHERE j.companion_id=@owner AND j.note_id IN(SELECT id FROM live_notes)`;
    } else {
      sql = `SELECT ${columns("'review'", 'w.memory_id', "'记忆版本已完成睡眠回顾'", "'reviewed'", 'w.processed_at', 'w.memory_id', 'w.version', 'NULL', 'NULL', "'reviewed_version'", '此版本有成功回顾水印；反思日记和梦境均可为零产出。')} FROM companion_world_dream_watermark w WHERE w.companion_id=@owner AND w.memory_id IN(SELECT id FROM live_notes)
        UNION ALL SELECT ${columns("'sleep'", 'j.id', "'绑定过记忆版本的睡眠任务'", 'j.status', "json_extract(j.data,'$.createdAt')", 'NULL', 'NULL', 'NULL', "json_extract(j.data,'$.conversationId')", "'bound_version'", '任务确实绑定过相关记忆版本；结束也可能中止，不以结束状态冒充回顾完成。')} FROM companion_world_jobs j WHERE j.companion_id=@owner AND j.kind='dream' AND (@kind='sleep' AND j.id=@root OR EXISTS(SELECT 1 FROM json_each(j.data,'$.memoryVersions') v WHERE json_extract(v.value,'$.id') IN(SELECT id FROM live_notes)))`;
    }
    const rows = this.db.prepare(cte + sql + `) SELECT * FROM records WHERE (@after=0 OR at<@at OR at=@at AND uid>@uid) ORDER BY at DESC,uid LIMIT @limit`).all({ owner, root: root.id, kind: root.kind, after: after ? 1 : 0, at: after?.at ?? '', uid: after?.uid ?? '', limit: limit + 1 }) as Row[];
    const selected = rows.slice(0, limit), hasMore = rows.length > limit, last = selected.at(-1), records: CompanionMemoryTraceRecord[] = [];
    const visibleOutputs = new Map<string, boolean>();
    for (const row of selected) {
      if (row.note_id && !this.noteVisible(owner, text(row.note_id))) continue;
      if (row.source_id && (!row.conversation_id || !this.sourceVisible(owner, text(row.conversation_id), text(row.source_id)))) continue;
      const proof = row.proof ? JSON.parse(text(row.proof)) as Pick<CompanionMemoryTraceRecord, 'asset' | 'worldJobId' | 'sleepEpisodeId' | 'captureBatchId' | 'outputCount' | 'outputs'> : undefined;
      if (proof?.outputs) proof.outputs = proof.outputs.slice(0, 100).filter(output => {
        if (!visibleOutputs.has(output.noteId)) visibleOutputs.set(output.noteId, this.noteVisible(owner, output.noteId));
        return visibleOutputs.get(output.noteId);
      });
      const record: CompanionMemoryTraceRecord = { id: text(row.uid), kind: text(row.kind) as CompanionMemoryTraceRecord['kind'], title: text(row.title), status: text(row.status),
        ...(row.at ? { at: text(row.at) } : {}), ...(row.note_id ? { noteId: text(row.note_id) } : {}), ...(row.version ? { version: Number(row.version) } : {}),
        ...(row.source_id ? { sourceMessageId: text(row.source_id) } : {}), ...(row.conversation_id ? { conversationId: text(row.conversation_id) } : {}),
          relation: text(row.relation) as CompanionMemoryTraceRecord['relation'], confidence: row.relation === 'shared_source' ? 'shared_source' : 'exact', detail: text(row.detail),
        ...(proof ?? {}) };
      if (proof?.captureBatchId) {
        if (proof.outputs?.length) {
          record.relation = 'batch_output'; record.confidence = 'exact';
          record.detail = `本批实际保存/确认${proof.outputCount}个日记版本；列出的可见版本与当前链匹配。去重可能复用已有条目，不代表新创。`;
        } else record.detail = proof.outputCount === 0 ? '本批处理已成功提交，实际确认的日记结果为空；这次检查没有提交任何日记条目。'
          : '本批保存/确认过日记版本，但它们当前不属于这条链、已修订或不可见；不展示旧内容，也不把它们冒充当前版本。';
      }
      records.push(record);
    }
    return { kind: stage, label: labels[stage], records, hasMore,
      ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ fingerprint, at: last.at, uid: last.uid })).toString('base64url') } : {}) };
  }
  execute(input: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (input.type === 'memory.trace.list') return { ok: true, memoryTracePage: this.list(input) };
    if (input.type === 'memory.trace.inspect') return { ok: true, memoryTrace: this.inspect(input) };
    return undefined;
  }
}
