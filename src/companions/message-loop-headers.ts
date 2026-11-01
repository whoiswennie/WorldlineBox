import type { CompanionConnection } from './store';

const table = 'companion_message_loop_headers';
const prefix = "substr(m.key,1,13)='message-loop/'";
const authorityFields = ['json_valid', 'root_type', 'status_type', 'source_type', 'status_value', 'source_message_id'] as const;
const taskFields = [...authorityFields, 'draft_type'] as const;
const fields = [...taskFields, 'progress_phase_type', 'progress_phase'] as const;
const values = (value: string) => [
  `json_valid(${value})`,
  `CASE WHEN json_valid(${value}) THEN json_type(${value}) END`,
  `CASE WHEN json_valid(${value}) THEN json_type(${value},'$.status') END`,
  `CASE WHEN json_valid(${value}) THEN json_type(${value},'$.sourceMessageId') END`,
  `CASE WHEN json_valid(${value}) THEN json_extract(${value},'$.status') END`,
  `CASE WHEN json_valid(${value}) THEN json_extract(${value},'$.sourceMessageId') END`,
  `CASE WHEN json_valid(${value}) THEN json_type(${value},'$.draft') END`,
  `CASE WHEN json_valid(${value}) THEN json_type(${value},'$.progress.phase') END`,
  `CASE WHEN json_valid(${value}) THEN json_extract(${value},'$.progress.phase') END`,
];
const equal = (left: string, right: string) => `${left} IS ${right} AND typeof(${left})=typeof(${right})`;
const changed = fields.map(field => `NOT(${equal(table + '.' + field, 'excluded.' + field)})`).join(' OR ');
const upsert = (where: string) => `INSERT INTO ${table}(metadata_key,${fields.join(',')})
  SELECT m.key,${values('m.value').join(',')} FROM metadata m WHERE ${prefix} AND ${where}
  ON CONFLICT(metadata_key) DO UPDATE SET ${fields.map(field => `${field}=excluded.${field}`).join(',')}
  WHERE ${changed};`;

/** A persistent scalar projection, maintained by SQLite in the metadata
 * writer's transaction, including writers outside this process. It never
 * rewrites the original checkpoint or stores an authorization result. */
export function initializeCompanionMessageLoopHeaders(db: CompanionConnection): void {
  db.transaction(() => {
    const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    // Untyped value columns have no affinity: JSON strings such as "01"
    // must never be converted to numbers before the original typeof checks.
    db.exec(`CREATE TABLE IF NOT EXISTS ${table}(
      metadata_key TEXT PRIMARY KEY NOT NULL,
      json_valid INTEGER NOT NULL CHECK(json_valid IN(0,1)), root_type TEXT,
      status_type TEXT, source_type TEXT, status_value, source_message_id, draft_type TEXT,
      progress_phase_type TEXT, progress_phase
    );`);
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
    const missing = (['draft_type', 'progress_phase_type', 'progress_phase'] as const).filter(column => !columns.has(column));
    const upgrade = existed && missing.length > 0;
    if (upgrade) {
      for (const column of missing) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}${column === 'progress_phase' ? '' : ' TEXT'};`);
      // Replace the former projection guards and writers and backfill once in
      // this explicit transaction. Later recovery reads only compact scalars.
      for (const name of ['verify_insert', 'verify_update', 'metadata_insert', 'metadata_update', 'metadata_delete'])
        db.exec(`DROP TRIGGER IF EXISTS companion_message_loop_headers_${name};`);
    }
    const matches = `EXISTS(SELECT 1 FROM metadata m WHERE m.key=NEW.metadata_key AND ${prefix}
      AND ${fields.map((field, index) => equal('NEW.' + field, values('m.value')[index]!)).join(' AND ')})`;
    // A direct editor cannot change a derivative header into a forged "done"
    // record. Deletion is safe: readers use the original SQL path on a miss.
    for (const operation of ['INSERT', 'UPDATE'] as const) db.exec(`CREATE TRIGGER IF NOT EXISTS companion_message_loop_headers_verify_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table} WHEN NOT ${matches}
      BEGIN SELECT RAISE(ABORT,'Message loop header does not match its metadata source.'); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS companion_message_loop_headers_metadata_insert
      AFTER INSERT ON metadata WHEN substr(NEW.key,1,13)='message-loop/' BEGIN ${upsert('m.key=NEW.key')} END;
      CREATE TRIGGER IF NOT EXISTS companion_message_loop_headers_metadata_update
      AFTER UPDATE OF key,value ON metadata BEGIN
        DELETE FROM ${table} WHERE metadata_key=OLD.key AND OLD.key IS NOT NEW.key;
        ${upsert('m.key=NEW.key')}
      END;
      CREATE TRIGGER IF NOT EXISTS companion_message_loop_headers_metadata_delete
      AFTER DELETE ON metadata WHEN substr(OLD.key,1,13)='message-loop/'
      BEGIN DELETE FROM ${table} WHERE metadata_key=OLD.key; END;`);
    // Table creation, triggers and this one backfill commit atomically. Later
    // opens do not scan historical checkpoint blobs again.
    if (!existed || upgrade) db.exec(upsert('1'));
  })();
}

type Header = { json_valid: number; root_type: string | null; status_type: string | null; source_type: string | null;
  status_value: unknown; source_message_id: unknown; draft_type?: string | null };
type Statements = { authority?: ReturnType<CompanionConnection['prepare']>; task?: ReturnType<CompanionConnection['prepare']>;
  recovery?: ReturnType<CompanionConnection['prepare']> };
const statements = new WeakMap<object, Statements>();
function unavailableProjection(error: unknown, task: boolean): boolean {
  return error instanceof Error && (error.message === 'no such table: ' + table || task && error.message === 'no such column: draft_type');
}
/** Pure PK read. Missing/unsupported/legacy projections use the caller's
 * original json_extract query; no schema or repair work happens on reads. */
function readHeader(db: CompanionConnection, key: string, task: boolean): Header | undefined {
  let owned = statements.get(db); if (!owned) { owned = {}; statements.set(db, owned); }
  const mode = task ? 'task' : 'authority';
  let statement = owned[mode];
  if (!statement) {
    try {
      statement = db.prepare(`SELECT ${(task ? taskFields : authorityFields).join(',')} FROM ${table} WHERE metadata_key=? AND json_valid=1 AND root_type='object'
        AND (status_type IS NULL OR status_type='text') AND (source_type IS NULL OR source_type='text')`);
      owned[mode] = statement;
    } catch (error) {
      if (unavailableProjection(error, task)) return;
      throw error;
    }
  }
  let header: Header | undefined;
  try { header = statement.get(key) as Header | undefined; }
  catch (error) {
    if (unavailableProjection(error, task)) { delete owned[mode]; return; }
    throw error;
  }
  if (!header || header.json_valid !== 1 || header.root_type !== 'object'
    || header.status_type !== null && header.status_type !== 'text'
    || header.source_type !== null && header.source_type !== 'text') return;
  return header;
}
export function readCompanionMessageLoopHeader(db: CompanionConnection, key: string): { status: unknown; sourceMessageId: unknown } | undefined {
  const header = readHeader(db, key, false);
  return header && { status: header.status_value, sourceMessageId: header.source_message_id };
}
/** Task projection only. SQL NULL means the draft field is absent; a JSON
 * null/false/object/etc keeps its explicit type and the original DTO fallback. */
export function readCompanionTaskMessageLoopHeader(db: CompanionConnection, key: string): { status: unknown; sourceMessageId: unknown; draftType: string | null } | undefined {
  const header = readHeader(db, key, true);
  return header && header.draft_type !== undefined ? { status: header.status_value, sourceMessageId: header.source_message_id, draftType: header.draft_type } : undefined;
}

/** Process-presentation recovery only, never source authorization. An absent
 * phase is inactive; a missing/unsupported projection keeps the legacy path. */
export function readCompanionReplyProgressRecoveryWorkRows(db: CompanionConnection): readonly { data: unknown }[] | undefined {
  let owned = statements.get(db); if (!owned) { owned = {}; statements.set(db, owned); }
  try {
    owned.recovery ??= db.prepare(`SELECT w.data FROM companion_work_queue w
      LEFT JOIN ${table} h ON h.metadata_key='message-loop/' || json_extract(w.data,'$.messageId')
      WHERE w.status='running' OR w.status IN ('done','cancelled','interrupted') AND (
        h.metadata_key IS NULL OR h.json_valid<>1 OR h.root_type IS NOT 'object'
        OR h.progress_phase_type IS NOT NULL AND (
          h.progress_phase_type<>'text' OR h.progress_phase NOT IN ('completed','failed','cancelled','interrupted')))
      ORDER BY w.ordinal`);
    return owned.recovery.all() as { data: unknown }[];
  } catch (error) {
    if (!(error instanceof Error) || !/^no such (?:table: companion_message_loop_headers|column: h\.progress_phase(?:_type)?)$/u.test(error.message)) throw error;
    delete owned.recovery; return;
  }
}
