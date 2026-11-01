import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionExecutionReadsetSchema, type CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import { companionMessagePublicationCanonicalJSON as canonical, companionMessagePublicationCertificateSchema,
  type CompanionMessagePublicationCertificate, type CompanionPublishedActionFrontier } from '../shared/companion-message-publication';
import { companionMemoryHistoryDescriptorSchema, renderCompanionMemoryHistory, type CompanionMemoryHistoryDescriptor } from '../shared/companion-memory-history';
import { companionMemorySchema } from '../shared/companion-memory';
import { companionTopicCheckpointSchema, companionTopicSchema } from '../shared/companion-topic';
import { companionTopicCheckpointEventValid } from './topic-context';
import { companionTopicCheckpointInputValid } from './topic-checkpoint-index';
import type { CompanionMemory } from '../shared/companions';
import { companionArtifactSchema, type CompanionArtifact } from '../shared/companion-artifact';
import { readPublishedMessageActionPins } from './published-message-action-pins';
import { readCompanionMessageLoopHeader } from './message-loop-headers';

type Row = Record<string, string | number | null>;
type Edge = { kind: string; key: string };
type Descriptor = Omit<CompanionMemoryHistoryDescriptor, 'procedureValidation'>;
export type PublishedActionFrontier = CompanionPublishedActionFrontier;
type Obligations = { volatileActions: PublishedActionFrontier[]; assetOwners: string[] };
type MemoryNode = { descriptor: Descriptor; contentHash: string; path: string; artifactKind: string; maxSequence: number } & Obligations;
type Node = { node_key: string; companion_id: string; generation: number; binding: string; data: string; edges_hash: string };
type CurrentNode = Node & { obligations: Obligations; edges: readonly Edge[] };
type ReadsetTuple = { readset: CompanionExecutionReadset; readsetJSON: string; readsetDigest: string; typedReadsetJSON: string; typedReadsetDigest: string };
type Message = ReadsetTuple & { row: Row; certificate: CompanionMessagePublicationCertificate; binding: string };
type Action = ReadsetTuple & { id: string; companionId: string; conversationId: string; sourceMessageId: string; binding: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (...values: unknown[]) => canonical(values);
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
class Ineligible extends Error {}
function requireValue(value: unknown): asserts value { if (!value) throw new Ineligible(); }
function freezeSQLTuple<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSQLTuple(child);
    Object.freeze(value);
  }
  return value;
}
function describeReadset(readset: CompanionExecutionReadset): ReadsetTuple {
  const readsetJSON = canonical(readset), typedReadsetJSON = JSON.stringify(readset);
  return { readset, readsetJSON, readsetDigest: hash(readsetJSON), typedReadsetJSON, typedReadsetDigest: hash(typedReadsetJSON) };
}
const writers = new WeakMap<object, number>();
type ReadWindow = { stamp?: string; values: Map<string, unknown> };
const readWindows = new WeakMap<object, ReadWindow>();
/** Parsed SQL tuples only, never path/cut eligibility. A synchronous command
 * owns this window; async continuations and later commands cannot inherit it. */
export function withPublishedDependencyReadWindow<T>(db: CompanionConnection, operation: () => T): T {
  if (readWindows.has(db)) return operation();
  readWindows.set(db, { values: new Map() });
  try { return operation(); } finally { readWindows.delete(db); }
}
function readWindowStamp(db: CompanionConnection): string {
  const value = readStatement(db, 'stamp').get() as { changes: number; version: number; generation: number; covered_epoch?: number; protocol_version?: number };
  requireValue(Number.isSafeInteger(value.generation) && value.generation >= 0);
  return key(value.changes, value.version, value.generation, value.covered_epoch, value.protocol_version);
}
function readTuple<T>(db: CompanionConnection, kind: string, id: string, operation: () => T): T {
  const window = readWindows.get(db);
  if (!window) return operation();
  const stamp = readWindowStamp(db);
  if (window.stamp !== stamp) { window.values.clear(); window.stamp = stamp; }
  const cacheKey = key(kind, id, stamp);
  if (window.values.has(cacheKey)) return window.values.get(cacheKey) as T;
  const value = operation(), after = readWindowStamp(db);
  if (after === stamp) window.values.set(cacheKey, value);
  else { window.values.clear(); window.stamp = after; }
  return value;
}
const relevant = (kind: string, expression: string) => `EXISTS(SELECT 1 FROM companion_published_dependency_edges WHERE target_kind='${kind}' AND target_key=${expression})`;
const field = (alias: string, path: string) => `CASE WHEN json_valid(${alias}.value) THEN json_extract(${alias}.value,'$.${path}') END`;
const actionFields = ['id', 'companionId', 'conversationId', 'status', 'sourceMessageId', 'parentMessageId', 'toolCallId', 'loopStep', 'taskId',
  'result', 'error', 'capability', 'thought', 'authorizationGrantId', 'workOrderId', 'scheduleOccurrenceId', 'contentAvailable'] as const;
const actionField = (alias: string, name: string) => `CASE WHEN json_valid(${alias}.data) THEN json_extract(${alias}.data,'$.${name}') END`;
const indexVersion = 4;
const privateWriting = '(SELECT index_writing FROM companion_published_authority_generation WHERE id=1)';
function installPrivateIndexWriteGuards(db: CompanionConnection, table: string): void {
  for (const event of ['INSERT', 'UPDATE'] as const) {
    const name = `companion_published_dirty_${table}_${event.toLowerCase()}`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${event} ON ${table} WHEN CAST(companion_published_index_writing() AS INTEGER)=0 BEGIN
      SELECT RAISE(ABORT,'Published dependency metadata requires its private host writer'); END;`);
  }
}
/** All statements here run inside the mutating statement's transaction, even
 * for an external SQLite writer. No UDF/JavaScript authority is required. */
function installInvalidationTrigger(db: CompanionConnection, table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', predicate: string,
  seeds: string, replace = false): void {
  const name = `companion_published_dirty_${table}_${event.toLowerCase()}`;
  if (replace) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  const affected = `WITH RECURSIVE affected(node_key) AS (
    SELECT node_key FROM (${seeds}) UNION
    SELECT edge.parent_key FROM companion_published_dependency_edges edge JOIN affected child ON edge.target_kind='node' AND edge.target_key=child.node_key)
    SELECT affected.node_key FROM affected JOIN companion_published_dependency_nodes node ON node.node_key=affected.node_key`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} WHEN (${predicate}) BEGIN
    INSERT INTO companion_published_dependency_dirty(node_key,epoch)
      SELECT node_key,(SELECT generation+1 FROM companion_published_authority_generation WHERE id=1) FROM (${affected}) candidate
      WHERE NOT EXISTS(SELECT 1 FROM companion_published_dependency_dirty old WHERE old.node_key=candidate.node_key);
    DELETE FROM companion_published_invalidation_audit WHERE slot=(SELECT (generation+1)%64 FROM companion_published_authority_generation WHERE id=1);
    INSERT INTO companion_published_invalidation_audit(slot,epoch,at,origin,event,direct_count,affected_count)
      VALUES((SELECT (generation+1)%64 FROM companion_published_authority_generation WHERE id=1),
        (SELECT generation+1 FROM companion_published_authority_generation WHERE id=1),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        '${table}','${event}',(SELECT COUNT(*) FROM (${seeds})),
        (SELECT COUNT(*) FROM companion_published_dependency_dirty WHERE epoch=(SELECT generation+1 FROM companion_published_authority_generation WHERE id=1)));
    UPDATE companion_published_authority_generation SET generation=generation+1,covered_epoch=covered_epoch+1 WHERE id=1;
  END;`);
}
const readQueries = {
  stamp: `SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS version,authority.*
    FROM companion_published_authority_generation authority WHERE id=1`,
  // A read-only v2 maintenance adapter must fall back to its full SQL proof,
  // not ALTER its library or misclassify missing v3 columns as unavailable.
  generation: 'SELECT * FROM companion_published_authority_generation WHERE id=1',
  message: 'SELECT * FROM messages WHERE id=?',
  metadata: 'SELECT value FROM metadata WHERE key=?',
  certificate: 'SELECT data FROM companion_message_publication_certificates WHERE message_id=?',
  action: `SELECT id,companion_id,conversation_id,status,json_object(${actionFields.map(name => `'${name}',${actionField('actions', name)}`).join(',')}) AS data FROM actions WHERE id=?`,
  checkpoint: "SELECT CASE WHEN json_valid(value) THEN json_extract(value,'$.executionReadset') END AS proof,CASE WHEN json_valid(value) THEN json_type(value,'$.activityThought') END AS thought FROM metadata WHERE key=?",
  activeNode: `SELECT 1 FROM companion_published_dependency_nodes node WHERE node_key=?
    AND NOT EXISTS(SELECT 1 FROM companion_published_dependency_dirty dirty WHERE dirty.node_key=node.node_key)
    AND (CASE WHEN json_valid(data) THEN json_extract(data,'$.indexVersion') END)=4`,
  node: `SELECT * FROM companion_published_dependency_nodes node WHERE node_key=?
    AND NOT EXISTS(SELECT 1 FROM companion_published_dependency_dirty dirty WHERE dirty.node_key=node.node_key)`,
  edges: 'SELECT target_kind AS kind,target_key AS key FROM companion_published_dependency_edges WHERE parent_key=? ORDER BY target_kind,target_key',
} as const;
type ReadStatements = Partial<Record<keyof typeof readQueries, ReturnType<CompanionConnection['prepare']>>>;
const readStatements = new WeakMap<CompanionConnection, ReadStatements>();
/** Only this finite set of compiled SELECTs survives a read window. Every
 * invocation still reads current rows, stamps and authority through its exact
 * supplied (possibly fenced) connection. No bindings or results are retained. */
function readStatement(db: CompanionConnection, name: keyof typeof readQueries) {
  let owned = readStatements.get(db);
  if (!owned) { owned = {}; readStatements.set(db, owned); }
  const known = owned[name]; if (known) return known;
  const prepared = db.prepare(readQueries[name]); owned[name] = prepared; return prepared;
}

/** A derived, transactionally invalidated SQL index. It never stores body bytes
 * or creates a Main publication certificate. Unknown branches use the old gate. */
export function initializePublishedDependencyIndex(db: CompanionConnection): void {
  db.function('companion_published_index_writing', { deterministic: false }, () => String(writers.get(db) ?? 0));
  db.transaction(() => initializePublishedDependencyIndexWithinTransaction(db)).immediate();
}
function initializePublishedDependencyIndexWithinTransaction(db: CompanionConnection): void {
  const priorEdges = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_published_dependency_edges'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS companion_published_authority_generation(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_published_dependency_nodes(node_key TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,generation INTEGER NOT NULL,binding TEXT NOT NULL,data TEXT NOT NULL,edges_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS companion_published_dependency_owner ON companion_published_dependency_nodes(companion_id);
    CREATE TABLE IF NOT EXISTS companion_published_dependency_edges(parent_key TEXT NOT NULL REFERENCES companion_published_dependency_nodes(node_key) ON DELETE CASCADE,target_kind TEXT NOT NULL,target_key TEXT NOT NULL,PRIMARY KEY(parent_key,target_kind,target_key));
    CREATE INDEX IF NOT EXISTS companion_published_dependency_targets ON companion_published_dependency_edges(target_kind,target_key,parent_key);
    CREATE INDEX IF NOT EXISTS companion_published_action_messages ON messages(action_id) WHERE action_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS companion_published_index_maintenance(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL,message_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_published_dependency_dirty(node_key TEXT PRIMARY KEY,epoch INTEGER NOT NULL CHECK(epoch>=0));
    CREATE INDEX IF NOT EXISTS companion_published_dirty_epoch ON companion_published_dependency_dirty(epoch);
    CREATE TABLE IF NOT EXISTS companion_published_invalidation_audit(slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 0 AND 63),epoch INTEGER NOT NULL,at TEXT NOT NULL,
      origin TEXT NOT NULL,event TEXT NOT NULL CHECK(event IN('INSERT','UPDATE','DELETE')),direct_count INTEGER NOT NULL CHECK(direct_count>=0),affected_count INTEGER NOT NULL CHECK(affected_count>=0));`);
  const columns = new Set((db.prepare('PRAGMA table_info(companion_published_authority_generation)').all() as Array<{ name: string }>).map(row => row.name));
  for (const column of ['covered_epoch', 'protocol_version', 'index_writing']) if (!columns.has(column))
    db.exec(`ALTER TABLE companion_published_authority_generation ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  // BEFORE INSERT also runs for ignored/replaced rows. Do not attempt an
  // ignored duplicate against the singleton replacement protection below.
  db.exec('INSERT INTO companion_published_authority_generation(id,generation) SELECT 1,0 WHERE NOT EXISTS(SELECT 1 FROM companion_published_authority_generation WHERE id=1)');
  const upgrade = (db.prepare('SELECT protocol_version FROM companion_published_authority_generation WHERE id=1').get() as { protocol_version: number }).protocol_version !== indexVersion;
  const trigger = (table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', predicate: string, seeds: string) =>
    installInvalidationTrigger(db, table, event, predicate, seeds, upgrade);
  const tracked = (table: string, kind: string, expression: (alias: string) => string, changed?: string) => {
    const seeds = (aliases: readonly string[]) => `SELECT DISTINCT parent_key AS node_key FROM companion_published_dependency_edges WHERE target_kind='${kind}' AND target_key IN(${aliases.map(expression).join(',')})`;
    trigger(table, 'INSERT', relevant(kind, expression('NEW')), seeds(['NEW']));
    trigger(table, 'DELETE', relevant(kind, expression('OLD')), seeds(['OLD']));
    trigger(table, 'UPDATE', `(${relevant(kind, expression('OLD'))} OR ${relevant(kind, expression('NEW'))})${changed ? ` AND (${expression('OLD')} IS NOT ${expression('NEW')} OR ${changed})` : ''}`, seeds(['OLD', 'NEW']));
  };
  // New sources and new first publications have no indexed dependants. Only
  // already consumed identities can retire historical certificates.
  for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const aliases = event === 'INSERT' ? ['NEW'] : event === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
    const changed = ['author_id', 'conversation_id', 'sequence', 'revision', 'status', 'kind', 'action_id', 'reply_to_id', 'content', 'request_fingerprint']
      .map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ');
    const target = (alias: string) => `(${relevant('message', `${alias}.id`)} OR ${relevant('action-messages', `${alias}.action_id`)})`;
    trigger('messages', event, `(${aliases.map(target).join(' OR ')})${event === 'UPDATE' ? ` AND (${changed})` : ''}`,
      `SELECT DISTINCT parent_key AS node_key FROM companion_published_dependency_edges WHERE
        (target_kind='message' AND target_key IN(${aliases.map(alias => `${alias}.id`).join(',')})) OR
        (target_kind='action-messages' AND target_key IN(${aliases.map(alias => `${alias}.action_id`).join(',')}))`);
  }
  const metadataChange = `CASE WHEN OLD.key GLOB 'message-loop/*' THEN ${field('OLD', 'status')} IS NOT ${field('NEW', 'status')} OR ${field('OLD', 'sourceMessageId')} IS NOT ${field('NEW', 'sourceMessageId')}
    WHEN OLD.key GLOB 'task-checkpoint/*' THEN ${field('OLD', 'executionReadset')} IS NOT ${field('NEW', 'executionReadset')} OR ${field('OLD', 'activityThought')} IS NOT ${field('NEW', 'activityThought')}
    ELSE OLD.value IS NOT NEW.value END`;
  tracked('metadata', 'metadata', alias => `${alias}.key`, `json_valid(OLD.value) IS NOT json_valid(NEW.value) OR (${metadataChange})`);
  tracked('actions', 'action', alias => `${alias}.id`, ['OLD.companion_id IS NOT NEW.companion_id', 'OLD.conversation_id IS NOT NEW.conversation_id', 'OLD.status IS NOT NEW.status',
    'json_valid(OLD.data) IS NOT json_valid(NEW.data)', ...actionFields.map(name => `${actionField('OLD', name)} IS NOT ${actionField('NEW', name)}`)].join(' OR '));
  tracked('companion_message_publication_certificates', 'certificate', alias => `${alias}.message_id`, 'OLD.data IS NOT NEW.data');
  tracked('companion_message_publication_action_pins', 'publication-pins', alias => `${alias}.message_id`, 'OLD.certificate_hash IS NOT NEW.certificate_hash OR OLD.data IS NOT NEW.data');
  tracked('conversation_members', 'membership', alias => `json_array(${alias}.companion_id,${alias}.conversation_id)`, 'OLD.companion_id IS NOT NEW.companion_id OR OLD.conversation_id IS NOT NEW.conversation_id');
  tracked('conversations', 'room', alias => `${alias}.id`, 'OLD.kind IS NOT NEW.kind OR OLD.dissolved_at IS NOT NEW.dissolved_at');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_social_conversations'").get()) initializeSocialRoomInvalidation(db, upgrade);
  tracked('companions', 'owner', alias => `${alias}.id`, 'OLD.deleted_at IS NOT NEW.deleted_at');
  for (const table of ['vcp_source_observers', 'vcp_source_blocks']) tracked(table, 'source-policy', alias => `json_array(${alias}.companion_id,${alias}.message_id)`, 'OLD.companion_id IS NOT NEW.companion_id OR OLD.message_id IS NOT NEW.message_id');
  tracked('vcp_source_prohibitions', 'policy', alias => `${alias}.companion_id`);
  for (const table of ['vcp_source_prohibition_requests', 'vcp_source_prohibition_releases']) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const aliases = event === 'INSERT' ? ['NEW'] : event === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
      trigger(table, event, aliases.map(alias => relevant('prohibition', `${alias}.prohibition_id`)).join(' OR '),
        `SELECT DISTINCT parent_key AS node_key FROM companion_published_dependency_edges WHERE target_kind='prohibition' AND target_key IN(${aliases.map(alias => `${alias}.prohibition_id`).join(',')})`);
    }
  }
  tracked('companion_reset_jobs', 'owner', alias => `${alias}.companion_id`);
  tracked('companion_reset_boundaries', 'owner', alias => `${alias}.companion_id`);
  tracked('companion_reset_rooms', 'room', alias => `${alias}.conversation_id`);
  tracked('companion_reset_messages', 'message', alias => `${alias}.message_id`);
  tracked('companion_message_topics', 'message', alias => `${alias}.message_id`, 'OLD.message_id IS NOT NEW.message_id OR OLD.topic_id IS NOT NEW.topic_id');
  tracked('companion_topics', 'topic', alias => `${alias}.id`, ['kind', 'isPrimary', 'deletedAt', 'forkedFromTopicId', 'participantIds', 'invitedIds', 'conversationId']
    .map(field => `(CASE WHEN json_valid(OLD.data) THEN json_extract(OLD.data,'$.${field}') END) IS NOT (CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data,'$.${field}') END)`).join(' OR '));
  tracked('companion_topic_events', 'topic-event', alias => `${alias}.id`,
    'OLD.topic_id IS NOT NEW.topic_id OR OLD.reader_id IS NOT NEW.reader_id OR OLD.data IS NOT NEW.data OR OLD.rowid IS NOT NEW.rowid');
  tracked('companion_topic_checkpoint_nodes', 'topic-event', alias => `${alias}.event_id`,
    'OLD.topic_id IS NOT NEW.topic_id OR OLD.reader_id IS NOT NEW.reader_id OR OLD.body_hash IS NOT NEW.body_hash OR OLD.state IS NOT NEW.state');
  tracked('companion_topic_checkpoint_owner_blocks', 'topic-event-owner', alias => `json_array(${alias}.owner_id,${alias}.event_id)`);
  tracked('companion_memory_content_revisions', 'memory', alias => `json_array(${alias}.companion_id,${alias}.note_id,${alias}.content_revision)`, 'OLD.body_hash IS NOT NEW.body_hash OR OLD.data IS NOT NEW.data');
  tracked('companion_memory_version_revisions', 'memory-version', alias => `json_array(${alias}.note_id,${alias}.version)`, 'OLD.content_revision IS NOT NEW.content_revision');
  tracked('companion_memory_history_files', 'memory', alias => `json_array(${alias}.companion_id,${alias}.note_id,${alias}.content_revision)`,
    ['body_hash', 'document_hash', 'relative_path', 'state', 'sources', 'dependencies'].map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR '));
  for (const table of ['companion_memory_history_sources', 'companion_memory_history_dependencies']) tracked(table, 'memory', alias => `json_array(${alias}.companion_id,${alias}.note_id,${alias}.content_revision)`);
  tracked('vcp_note_source_history', 'note-source-history', alias => `json_array(${alias}.note_id,${alias}.message_id)`);
  tracked('vcp_memory_notes', 'note', alias => `${alias}.id`, `OLD.companion_id IS NOT NEW.companion_id OR
    (CASE WHEN json_valid(OLD.data) THEN json_extract(OLD.data,'$.status') END) IS NOT (CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data,'$.status') END)
    AND ((CASE WHEN json_valid(OLD.data) THEN json_extract(OLD.data,'$.status') END) IN('forgotten','invalid') OR (CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data,'$.status') END) IN('forgotten','invalid'))`);
  for (const table of ['companion_artifacts', 'companion_artifact_versions']) tracked(table, 'artifact', alias => `json_array(${alias}.owner_id,${alias}.artifact_id)`,
    table === 'companion_artifacts' ? 'OLD.state IS NOT NEW.state OR OLD.revision IS NOT NEW.revision OR OLD.content_hash IS NOT NEW.content_hash OR OLD.metadata IS NOT NEW.metadata'
      : 'OLD.revision IS NOT NEW.revision OR OLD.content_hash IS NOT NEW.content_hash OR OLD.metadata IS NOT NEW.metadata');
  tracked('companion_artifact_edges', 'artifact', alias => `json_array(${alias}.owner_id,${alias}.target_id)`);
  // These derived tables cannot be hand edited into fresh authority. Ordinary
  // external connections have no writer function and reject such edits; only
  // this module's bounded synchronous build opens the maintenance window.
  for (const table of ['companion_published_dependency_nodes', 'companion_published_dependency_edges']) {
    installPrivateIndexWriteGuards(db, table);
    trigger(table, 'DELETE', table === 'companion_published_dependency_nodes' ? '1' : `${privateWriting}=0 AND EXISTS(SELECT 1 FROM companion_published_dependency_nodes WHERE node_key=OLD.parent_key)`,
      `SELECT OLD.${table === 'companion_published_dependency_nodes' ? 'node_key' : 'parent_key'} AS node_key`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS companion_published_dirty_update_guard BEFORE UPDATE ON companion_published_dependency_dirty
      BEGIN SELECT RAISE(ABORT,'Published dirty markers are immutable until a complete private rebuild'); END;
    CREATE TRIGGER IF NOT EXISTS companion_published_dirty_delete_guard BEFORE DELETE ON companion_published_dependency_dirty
      WHEN ${privateWriting}=0 AND EXISTS(SELECT 1 FROM companion_published_dependency_nodes WHERE node_key=OLD.node_key)
      BEGIN SELECT RAISE(ABORT,'Live published dependency dirtiness requires its private builder'); END;
    CREATE TRIGGER IF NOT EXISTS companion_published_node_orphan_cleanup AFTER DELETE ON companion_published_dependency_nodes BEGIN
      DELETE FROM companion_published_dependency_dirty WHERE node_key=OLD.node_key;
      DELETE FROM companion_published_index_maintenance WHERE message_id=(CASE WHEN json_valid(OLD.node_key) AND json_extract(OLD.node_key,'$[0]')='message' THEN json_extract(OLD.node_key,'$[1]') END);
    END;
    CREATE TRIGGER IF NOT EXISTS companion_published_epoch_no_replace BEFORE INSERT ON companion_published_authority_generation
      WHEN EXISTS(SELECT 1 FROM companion_published_authority_generation WHERE id=1) BEGIN SELECT RAISE(ABORT,'Published authority epoch cannot be replaced'); END;
    CREATE TRIGGER IF NOT EXISTS companion_published_epoch_no_delete BEFORE DELETE ON companion_published_authority_generation
      BEGIN SELECT RAISE(ABORT,'Published authority epoch cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS companion_published_epoch_monotone BEFORE UPDATE OF generation,covered_epoch ON companion_published_authority_generation
      WHEN NEW.id!=1 OR typeof(NEW.generation)!='integer' OR NEW.generation<OLD.generation OR NEW.generation>9007199254740991
        OR typeof(NEW.covered_epoch)!='integer' OR NEW.covered_epoch<OLD.covered_epoch OR NEW.covered_epoch>NEW.generation
        OR (NEW.covered_epoch!=OLD.covered_epoch AND NOT(
          (NEW.generation=OLD.generation+1 AND NEW.covered_epoch=OLD.covered_epoch+1) OR
          (NEW.covered_epoch=NEW.generation AND NOT EXISTS(SELECT 1 FROM companion_published_dependency_nodes node
            WHERE NOT EXISTS(SELECT 1 FROM companion_published_dependency_dirty dirty WHERE dirty.node_key=node.node_key)))))
      BEGIN SELECT RAISE(ABORT,'Published authority coverage cannot bypass an unknown epoch'); END;
    CREATE TRIGGER IF NOT EXISTS companion_published_epoch_private_writer BEFORE UPDATE OF index_writing,protocol_version ON companion_published_authority_generation
      WHEN CAST(companion_published_index_writing() AS INTEGER)=0 OR typeof(NEW.index_writing)!='integer' OR NEW.index_writing<0
      BEGIN SELECT RAISE(ABORT,'Published index protocol requires its private writer'); END;`);
  if (upgrade) withPrivateIndexWriter(db, () => {
    // Generation-only v2 updates did not retain which node changed. None of
    // those old nodes may be assumed clean after this atomic protocol upgrade.
    db.exec('INSERT OR IGNORE INTO companion_published_dependency_dirty SELECT node_key,(SELECT generation FROM companion_published_authority_generation WHERE id=1) FROM companion_published_dependency_nodes');
    if (priorEdges) {
      // v2/v3 repeated every source's base-policy edges on each parent. All
      // old nodes are already unusable above. Retire that derived topology
      // atomically, retaining their original immutable bindings/data as well
      // as every certificate, pin, readset and business row. DROP does not
      // rename references in the other authority triggers. Restore this
      // table's own guards/index before reopening the protocol; rollback also
      // restores the complete old schema if any step fails.
      db.exec('DROP TABLE companion_published_dependency_edges');
      db.exec(`CREATE TABLE companion_published_dependency_edges(parent_key TEXT NOT NULL REFERENCES companion_published_dependency_nodes(node_key) ON DELETE CASCADE,target_kind TEXT NOT NULL,target_key TEXT NOT NULL,PRIMARY KEY(parent_key,target_kind,target_key));
        CREATE INDEX companion_published_dependency_targets ON companion_published_dependency_edges(target_kind,target_key,parent_key);`);
      installPrivateIndexWriteGuards(db, 'companion_published_dependency_edges');
      installInvalidationTrigger(db, 'companion_published_dependency_edges', 'DELETE',
        `${privateWriting}=0 AND EXISTS(SELECT 1 FROM companion_published_dependency_nodes WHERE node_key=OLD.parent_key)`, 'SELECT OLD.parent_key AS node_key');
    }
    db.prepare('UPDATE companion_published_authority_generation SET covered_epoch=generation,protocol_version=? WHERE id=1').run(indexVersion);
  });
}

function initializeSocialRoomInvalidation(db: CompanionConnection, replace = false): void {
  for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const aliases = event === 'INSERT' ? ['NEW'] : event === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
    const predicate = aliases.map(alias => relevant('social-room', `${alias}.id`)).join(' OR ');
    installInvalidationTrigger(db, 'companion_social_conversations', event,
      `(${predicate})${event === 'UPDATE' ? ' AND (OLD.id IS NOT NEW.id OR OLD.member_key IS NOT NEW.member_key)' : ''}`,
      `SELECT DISTINCT parent_key AS node_key FROM companion_published_dependency_edges WHERE target_kind='social-room' AND target_key IN(${aliases.map(alias => `${alias}.id`).join(',')})`, replace);
  }
}

function withPrivateIndexWriter<T>(db: CompanionConnection, operation: () => T): T {
  return db.transaction(() => {
    writers.set(db, (writers.get(db) ?? 0) + 1); let entered = false;
    try {
      db.prepare('UPDATE companion_published_authority_generation SET index_writing=index_writing+1 WHERE id=1').run(); entered = true;
      return operation();
    } finally {
      try { if (entered) db.prepare('UPDATE companion_published_authority_generation SET index_writing=index_writing-1 WHERE id=1').run(); }
      finally { writers.set(db, (writers.get(db) ?? 1) - 1); }
    }
  }).immediate();
}

function generation(db: CompanionConnection): number {
  const value = readStatement(db, 'generation').get() as { generation: number; covered_epoch: number; protocol_version: number; index_writing: number } | undefined;
  requireValue(value && Number.isSafeInteger(value.generation) && value.generation >= 0
    && value.covered_epoch === value.generation && value.protocol_version === indexVersion
    && (value.index_writing === 0 || (writers.get(db) ?? 0) > 0)); return value.generation;
}
function loadMessage(db: CompanionConnection, id: string, expected?: CompanionExecutionReadset): Message {
  const message = readTuple(db, 'message', id, () => {
  const row = readStatement(db, 'message').get(id) as Row | undefined;
  requireValue(row && row.kind === 'text' && row.status === 'sent' && !row.action_id && String(row.content).trim() && row.author_id !== 'user' && row.author_id !== 'system');
  const stored = readStatement(db, 'metadata').get('message-execution-readset/' + id) as { value: string } | undefined;
  const readset = companionExecutionReadsetSchema.parse(json(stored?.value));
  requireValue(readset.complete && readset.companionId === row.author_id && readset.conversationId === row.conversation_id);
  const description = describeReadset(readset);
  const saved = readStatement(db, 'certificate').get(id) as { data: string } | undefined;
  const certificate = companionMessagePublicationCertificateSchema.parse(json(saved?.data));
  requireValue(certificate.messageId === id && certificate.companionId === row.author_id && certificate.conversationId === row.conversation_id
    && certificate.messageRevision === Number(row.revision ?? 1) && certificate.bodySHA === hash(String(row.content)) && certificate.readsetDigest === description.readsetDigest);
  const binding = hash(canonical([...messageAuthority(row), certificate]));
  return freezeSQLTuple({ row, ...description, certificate, binding });
  });
  requireValue(!expected || expected === message.readset || canonical(expected) === message.readsetJSON);
  return message;
}
function loadAction(db: CompanionConnection, id: string, expected?: CompanionExecutionReadset): Action {
  const action = readTuple(db, 'action', id, () => {
  const row = readStatement(db, 'action').get(id) as Row | undefined;
  requireValue(row && ['succeeded', 'failed', 'cancelled'].includes(String(row.status)));
  const data = json<Record<string, unknown>>(row.data);
  requireValue(data.id === id && data.companionId === row.companion_id && data.conversationId === row.conversation_id && data.status === row.status
    && !data.capability && !data.thought && !data.authorizationGrantId && data.contentAvailable !== false
    && typeof data.sourceMessageId === 'string' && (typeof data.result === 'string' && !!data.result || typeof data.error === 'string' && !!data.error));
  const checkpoint = readStatement(db, 'checkpoint').get('task-checkpoint/' + id) as { proof?: string; thought?: string } | undefined;
  requireValue(checkpoint?.proof && !checkpoint.thought);
  const readset = companionExecutionReadsetSchema.parse(json(checkpoint.proof));
  requireValue(readset.complete && readset.companionId === row.companion_id && readset.conversationId === row.conversation_id);
  return freezeSQLTuple({ id, companionId: String(row.companion_id), conversationId: String(row.conversation_id), sourceMessageId: data.sourceMessageId,
    ...describeReadset(readset), binding: hash(canonical([row.id, row.companion_id, row.conversation_id, row.status, data, readset])) });
  });
  requireValue(!expected || expected === action.readset || canonical(expected) === action.readsetJSON);
  return action;
}
function actionObligations(value: string): PublishedActionFrontier[] {
  const values = json<{ volatileActions?: PublishedActionFrontier[] }>(value).volatileActions ?? [];
  requireValue(Array.isArray(values) && values.length <= 10000 && values.every(entry => entry && typeof entry.id === 'string' && typeof entry.companionId === 'string'
    && typeof entry.conversationId === 'string' && /^[a-f0-9]{64}$/u.test(entry.actionBindingHash) && /^[a-f0-9]{64}$/u.test(entry.readsetDigest)));
  return values;
}
function obligations(value: string): Obligations {
  const data = json<{ indexVersion?: number; assetOwners?: string[] }>(value), owners = data.assetOwners;
  requireValue(data.indexVersion === indexVersion && Array.isArray(owners) && owners.length > 0 && owners.length <= 10000
    && owners.every((owner, index) => typeof owner === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(owner) && (!index || owners[index - 1]! < owner)));
  return { volatileActions: actionObligations(value), assetOwners: owners! };
}
/** Exact current SQL tuple only. This does not certify the action's inputs,
 * files, execution permission or a Main observation of this tuple. */
export function readPublishedActionFrontier(db: CompanionConnection, actionId: string, expectedReadset?: CompanionExecutionReadset): PublishedActionFrontier | undefined {
  try {
    const action = loadAction(db, actionId, expectedReadset);
    return { id: action.id, companionId: action.companionId, conversationId: action.conversationId,
      actionBindingHash: action.binding, readsetDigest: action.readsetDigest };
  } catch (error) { return available(error); }
}
function activeIntersection(db: CompanionConnection, own: string, actions: readonly PublishedActionFrontier[], active: ReadonlySet<string> | undefined): boolean {
  if (!active?.size) return false;
  if (active.has(own) || actions.some(action => active.has('action:' + action.id))) return true;
  // An indexed active ordinary ancestor is conservatively left on the old
  // cycle-aware path. New, unindexed publication roots cannot be descendants
  // of an already closed node, so the ordinary hot path needs no DAG traversal.
  for (const entry of active) if (entry.startsWith('message:') && readStatement(db, 'activeNode').get(key('message', entry.slice(8)))) return true;
  return false;
}
function currentNode(db: CompanionConnection, nodeKey: string, epoch: number): CurrentNode | undefined {
  return readTuple(db, 'node', key(nodeKey, epoch), () => {
  const found = readStatement(db, 'node').get(nodeKey) as Node | undefined;
  if (!found) return;
  // A previous protocol did not retain every foreign owner's live Main
  // authority. It may be rebuilt, but cannot silently imply an empty set.
  if (json<{ indexVersion?: number }>(found.data).indexVersion !== indexVersion || !Number.isSafeInteger(found.generation)
    || found.generation < 0 || found.generation > epoch) return;
  const edges = readStatement(db, 'edges').all(nodeKey) as Edge[];
  const current = obligations(found.data);
  requireValue(hash(canonical(edges)) === found.edges_hash
    && canonical(edges.filter(edge => edge.kind === 'owner').map(edge => edge.key)) === canonical(current.assetOwners)); return { ...found, obligations: current, edges };
  });
}
function available(error: unknown): never | undefined {
  if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('SQLITE_')) throw error;
  return undefined;
}
function messageAuthority(row: Readonly<Row>): unknown[] {
  return [row.id, row.author_id, row.conversation_id, row.sequence, row.revision ?? 1, row.kind, row.status,
    row.content, row.action_id ?? null, row.reply_to_id ?? null, row.request_fingerprint ?? null];
}
/** Formal publication only. This is a boolean projection of a closed SQL
 * index, never a typed readset or permission for a reader. The full resolver
 * still returns the actual proof and its fresh Main/file/action obligations. */
export function currentPublishedSourceCutValid(db: CompanionConnection, source: Readonly<Row>, activeExecutionPath?: ReadonlySet<string>): boolean {
  try {
    requireValue(source.kind === 'text' && source.status === 'sent' && !source.action_id && source.author_id !== 'user' && source.author_id !== 'system');
    const epoch = generation(db), id = String(source.id), actual = readStatement(db, 'message').get(id) as Row | undefined;
    requireValue(actual && canonical(messageAuthority(actual)) === canonical(messageAuthority(source)));
    const saved = readStatement(db, 'certificate').get(id) as { data: string } | undefined;
    const certificate = companionMessagePublicationCertificateSchema.parse(json(saved?.data));
    requireValue(certificate.messageId === id && certificate.companionId === actual.author_id && certificate.conversationId === actual.conversation_id
      && certificate.messageRevision === Number(actual.revision ?? 1) && certificate.bodySHA === hash(String(actual.content)));
    const node = currentNode(db, key('message', id), epoch);
    requireValue(node && node.companion_id === actual.author_id && node.binding === hash(canonical([...messageAuthority(actual), certificate]))
      && canonical(json<{ certificate?: unknown }>(node.data).certificate) === canonical(certificate));
    const owner = String(actual.author_id), room = String(actual.conversation_id);
    const required: Edge[] = [ { kind: 'message', key: id }, { kind: 'certificate', key: id }, { kind: 'publication-pins', key: id },
      { kind: 'owner', key: owner }, { kind: 'room', key: room }, { kind: 'membership', key: key(owner, room) }, { kind: 'policy', key: owner },
      { kind: 'metadata', key: 'world-room/' + room },
      ...['message-execution-readset/', 'message-loop/', 'message-published-after/', 'memory-world-observation/', 'vcp-manual-input/', 'execution-source-invalid/message/']
        .map(prefix => ({ kind: 'metadata', key: prefix + id })) ];
    requireValue(required.every(expected => node.edges.some(edge => edge.kind === expected.kind && edge.key === expected.key)));
    const current = node.obligations, pins = readPublishedMessageActionPins(db, certificate);
    requireValue(current.assetOwners.includes(owner) && ((!current.volatileActions.length && pins === undefined)
      || pins !== undefined && canonical(pins) === canonical(current.volatileActions)));
    requireValue(!activeIntersection(db, 'message:' + id, current.volatileActions, activeExecutionPath) && epoch === generation(db));
    return true;
  } catch (error) { available(error); return false; }
}
/** Worker-internal physical description, never a retained authorization. Its
 * SQL-owned readset is immutable; every call still checks the current cut and
 * active path. Public mutable projections below copy only at their exit. */
export function observePublishedDependencyCut(db: CompanionConnection, messageId: string, expectedReadset?: CompanionExecutionReadset, activeExecutionPath?: ReadonlySet<string>):
  Readonly<ReadsetTuple & Obligations & { certificate: CompanionMessagePublicationCertificate; generation: number; binding: string }> | undefined {
  try {
    const epoch = generation(db), message = loadMessage(db, messageId, expectedReadset), node = currentNode(db, key('message', messageId), epoch);
    requireValue(node && node.binding === message.binding && epoch === generation(db));
    const current = node.obligations; requireValue(current.assetOwners.includes(message.readset.companionId) && !activeIntersection(db, 'message:' + messageId, current.volatileActions, activeExecutionPath));
    return freezeSQLTuple({ certificate: message.certificate, readset: message.readset, readsetJSON: message.readsetJSON, readsetDigest: message.readsetDigest,
      typedReadsetJSON: message.typedReadsetJSON, typedReadsetDigest: message.typedReadsetDigest, generation: epoch, binding: node.binding, ...current });
  } catch (error) { return available(error); }
}
export function observePublishedActionDependencyCut(db: CompanionConnection, actionId: string, expectedReadset?: CompanionExecutionReadset, activeExecutionPath?: ReadonlySet<string>):
  Readonly<ReadsetTuple & Obligations & { id: string; companionId: string; conversationId: string; generation: number; binding: string }> | undefined {
  try {
    const epoch = generation(db), action = loadAction(db, actionId, expectedReadset), node = currentNode(db, key('action', actionId), epoch);
    requireValue(node && node.binding === action.binding && epoch === generation(db));
    requireValue(node.edges.some(edge => edge.kind === 'action-messages' && edge.key === actionId));
    const current = node.obligations; requireValue(current.assetOwners.includes(action.companionId) && !activeIntersection(db, 'action:' + actionId, current.volatileActions, activeExecutionPath));
    return freezeSQLTuple({ id: action.id, companionId: action.companionId, conversationId: action.conversationId, readset: action.readset,
      readsetJSON: action.readsetJSON, readsetDigest: action.readsetDigest, typedReadsetJSON: action.typedReadsetJSON, typedReadsetDigest: action.typedReadsetDigest,
      generation: epoch, binding: node.binding, ...current });
  } catch (error) { return available(error); }
}
export function readPublishedDependencyCut(db: CompanionConnection, messageId: string, expectedReadset?: CompanionExecutionReadset, activeExecutionPath?: ReadonlySet<string>): {
  certificate: CompanionMessagePublicationCertificate; readset: CompanionExecutionReadset; generation: number; binding: string; volatileActions: PublishedActionFrontier[]; assetOwners: string[];
} | undefined {
  try {
    const observed = observePublishedDependencyCut(db, messageId, expectedReadset, activeExecutionPath);
    if (observed) return structuredClone({ certificate: observed.certificate, readset: observed.readset, generation: observed.generation,
      binding: observed.binding, volatileActions: observed.volatileActions, assetOwners: observed.assetOwners });
  } catch (error) { return available(error); }
}
export function readPublishedActionDependencyCut(db: CompanionConnection, actionId: string, expectedReadset?: CompanionExecutionReadset, activeExecutionPath?: ReadonlySet<string>): {
  id: string; companionId: string; conversationId: string; readset: CompanionExecutionReadset; generation: number; binding: string; volatileActions: PublishedActionFrontier[]; assetOwners: string[];
} | undefined {
  try {
    const observed = observePublishedActionDependencyCut(db, actionId, expectedReadset, activeExecutionPath);
    if (observed) return structuredClone({ id: observed.id, companionId: observed.companionId, conversationId: observed.conversationId,
      readset: observed.readset, generation: observed.generation, binding: observed.binding, volatileActions: observed.volatileActions, assetOwners: observed.assetOwners });
  } catch (error) { return available(error); }
}

/** Called only after the existing Main-certified batch has been stored, inside
 * that same IMMEDIATE transaction. Reconstructing a historical index never
 * manufactures a publication certificate for an unverified ancestor. */
export function certifyPublishedDependencyNode(db: CompanionConnection, certificate: CompanionMessagePublicationCertificate): boolean {
  return withPrivateIndexWriter(db, () => {
    try {
      const builder = new Builder(db, generation(db));
      const message = loadMessage(db, certificate.messageId);
      requireValue(canonical(message.certificate) === canonical(certificate));
      builder.message(certificate.messageId); return true;
    } catch (error) { available(error); return false; }
  });
}

/** Reconstruct only SQL-derived structure from an already exact Main
 * certificate and its original action pins. No certificate, pin, readset or
 * historical body is issued or changed here. Ordinary reads stay read-only;
 * the Store's fenced initialization owns this bounded maintenance pass.
 * Main must still admit the returned live action/file/owner obligations. */
export function maintainPublishedDependencyIndex(db: CompanionConnection, limit = 100): { indexed: number; skipped: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('历史发布索引维护批次无效。');
  return db.transaction(() => {
    initializeSocialRoomInvalidation(db);
    // Unknown epoch writes keep a permanent coverage gap. They can only be
    // reconciled after every old node is explicitly unusable; no stale node
    // becomes clean merely by bringing the counters back into agreement.
    const state = readStatement(db, 'generation').get() as { generation: number; covered_epoch: number; protocol_version: number };
    requireValue(state && Number.isSafeInteger(state.generation) && state.generation >= 0 && state.protocol_version === indexVersion);
    if (state.covered_epoch !== state.generation) {
      db.exec('INSERT OR IGNORE INTO companion_published_dependency_dirty SELECT node_key,(SELECT generation FROM companion_published_authority_generation WHERE id=1) FROM companion_published_dependency_nodes');
      db.exec('UPDATE companion_published_authority_generation SET covered_epoch=generation WHERE id=1');
    }
    db.exec('DELETE FROM companion_published_dependency_dirty WHERE NOT EXISTS(SELECT 1 FROM companion_published_dependency_nodes node WHERE node.node_key=companion_published_dependency_dirty.node_key)');
    db.exec('DELETE FROM companion_published_index_maintenance WHERE NOT EXISTS(SELECT 1 FROM messages WHERE id=companion_published_index_maintenance.message_id)');
    generation(db);
    const storedCursor = db.prepare('SELECT sequence,message_id FROM companion_published_index_maintenance WHERE id=1').get() as { sequence: number; message_id: string } | undefined;
    const cursor = storedCursor && Number.isSafeInteger(storedCursor.sequence) && storedCursor.sequence >= 0 && typeof storedCursor.message_id === 'string' ? storedCursor : undefined;
    const select = `SELECT c.data,m.sequence,m.id FROM companion_message_publication_certificates c
      JOIN messages m ON m.id=c.message_id LEFT JOIN companion_published_dependency_nodes n ON n.node_key=json_array('message',c.message_id)
      LEFT JOIN companion_published_dependency_dirty d ON d.node_key=n.node_key
      WHERE (n.node_key IS NULL OR d.node_key IS NOT NULL OR (CASE WHEN json_valid(n.data) THEN json_extract(n.data,'$.indexVersion') END) IS NOT 4)`;
    type Candidate = { data: string; sequence: number; id: string };
    // This cursor conveys no authority. Rotate bounded attempts so unsupported
    // historical nodes cannot monopolize every subsequent startup's batch.
    const after = cursor
      ? db.prepare(`${select} AND (m.sequence<? OR (m.sequence=? AND m.id<?)) ORDER BY m.sequence DESC,m.id DESC LIMIT ?`)
        .all(cursor.sequence, cursor.sequence, cursor.message_id, limit) as Candidate[] : [];
    const rows = after.length < limit ? [...after, ...db.prepare(`${select}${cursor ? ' AND (m.sequence>? OR (m.sequence=? AND m.id>=?))' : ''}
      ORDER BY m.sequence DESC,m.id DESC LIMIT ?`).all(...(cursor ? [cursor.sequence, cursor.sequence, cursor.message_id] : []), limit - after.length) as Candidate[]] : after;
    let indexed = 0, skipped = 0;
    for (const row of rows) {
      try {
        const parsed = companionMessagePublicationCertificateSchema.safeParse(json(row.data));
        if (parsed.success && parsed.data.messageId === row.id && certifyPublishedDependencyNode(db, parsed.data)) indexed++; else skipped++;
      } catch (error) { available(error); skipped++; }
    }
    const last = rows.at(-1);
    if (last) db.prepare('INSERT INTO companion_published_index_maintenance VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence,message_id=excluded.message_id')
      .run(last.sequence, last.id);
    return { indexed, skipped };
  }).immediate();
}

class Builder {
  private readonly active = new Set<string>();
  private readonly completed = new Map<string, MemoryNode | true>();
  // The Builder belongs to one IMMEDIATE transaction. Its only writes are
  // private derived-index writes: physical source tuples cannot change in
  // this window. No authority result or row is shared with another Builder.
  private readonly sourceRows = new Map<string, { row: Row; checksum: string; published?: { value: string } }>();
  private readonly sourceAuthorities = new Map<string, Obligations>();
  private readonly statements = new Map<string, ReturnType<CompanionConnection['prepare']>>();
  constructor(private readonly db: CompanionConnection, private readonly epoch: number) {}
  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) { requireValue(this.statements.size < 64); statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private physicalSource(id: string) {
    let value = this.sourceRows.get(id);
    if (!value) {
      requireValue(this.sourceRows.size < 10000);
      const row = this.statement('SELECT * FROM messages WHERE id=?').get(id) as Row | undefined;
      requireValue(row);
      value = { row, checksum: hash(String(row.content)), published: this.statement('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + id) as { value: string } | undefined };
      this.sourceRows.set(id, value);
    }
    return value;
  }
  private edges = new Map<string, Edge[]>();
  private readonly frontiers = new Map<string, Map<string, PublishedActionFrontier>>();
  private readonly assetOwners = new Map<string, Set<string>>();
  private readonly ready = new Map<string, Obligations>();
  private readonly pinnedActions = new Map<string, PublishedActionFrontier>();
  private readonly checkedArtifacts = new Map<string, CompanionArtifact>();
  private edge(parent: string, kind: string, target: string) { const list = this.edges.get(parent) ?? []; list.push({ kind, key: target }); this.edges.set(parent, list); }
  private carry(parent: string, value: Obligations) {
    const entries = this.frontiers.get(parent) ?? new Map<string, PublishedActionFrontier>();
    for (const entry of value.volatileActions) { const old = entries.get(entry.id); requireValue(!old || canonical(old) === canonical(entry)); entries.set(entry.id, entry); }
    this.frontiers.set(parent, entries);
    for (const owner of value.assetOwners) this.owner(parent, owner);
  }
  private owner(parent: string, owner: string) { const owners = this.assetOwners.get(parent) ?? new Set<string>(); if (!owners.has(owner)) { owners.add(owner); this.edge(parent, 'owner', owner); } this.assetOwners.set(parent, owners); }
  private pinned(values: readonly PublishedActionFrontier[]) {
    for (const entry of values) { const old = this.pinnedActions.get(entry.id); requireValue(!old || canonical(old) === canonical(entry)); this.pinnedActions.set(entry.id, entry); }
  }
  private obligations(parent: string): Obligations { return {
    volatileActions: [...this.frontiers.get(parent)?.values() ?? []].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    assetOwners: [...this.assetOwners.get(parent) ?? []].sort(),
  }; }
  private save(nodeKey: string, owner: string, binding: string, data: unknown) {
    this.owner(nodeKey, owner);
    requireValue(generation(this.db) === this.epoch);
    const unique = [...new Map((this.edges.get(nodeKey) ?? []).map(edge => [key(edge.kind, edge.key), edge])).values()]
      .sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    requireValue(unique.every(edge => typeof edge.kind === 'string' && typeof edge.key === 'string'));
    const uniqueJSON = canonical(unique);
    this.statement('INSERT INTO companion_published_dependency_nodes VALUES(?,?,?,?,?,?) ON CONFLICT(node_key) DO UPDATE SET companion_id=excluded.companion_id,generation=excluded.generation,binding=excluded.binding,data=excluded.data,edges_hash=excluded.edges_hash')
      .run(nodeKey, owner, this.epoch, binding, canonical({ ...data as Record<string, unknown>, indexVersion, assetOwners: this.obligations(nodeKey).assetOwners }), hash(uniqueJSON));
    this.statement('DELETE FROM companion_published_dependency_edges WHERE parent_key=?').run(nodeKey);
    this.statement("INSERT INTO companion_published_dependency_edges SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.key') FROM json_each(?)").run(nodeKey, uniqueJSON);
    this.statement('DELETE FROM companion_published_dependency_dirty WHERE node_key=?').run(nodeKey);
  }
  private enter(nodeKey: string) { requireValue(!this.active.has(nodeKey) && this.active.size + this.completed.size < 10000); this.active.add(nodeKey); }
  private scope(parent: string, owner: string, room: string) {
    requireValue(this.statement('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(owner));
    requireValue(this.statement('SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND m.companion_id=? AND c.dissolved_at IS NULL').get(room, owner));
    this.owner(parent, owner); this.edge(parent, 'room', room); this.edge(parent, 'membership', key(owner, room)); this.edge(parent, 'policy', owner);
    for (const rule of this.statement('SELECT id FROM vcp_source_prohibitions WHERE companion_id=?').all(owner) as Array<{ id: string }>) this.edge(parent, 'prohibition', rule.id);
    requireValue(!this.statement("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(owner));
    requireValue(!this.statement("SELECT 1 FROM companion_reset_rooms r JOIN companion_reset_jobs j ON j.id=r.job_id WHERE r.conversation_id=? AND j.status!='completed'").get(room));
    this.edge(parent, 'metadata', 'world-room/' + room);
    const world = this.statement('SELECT value FROM metadata WHERE key=?').get('world-room/' + room) as { value: string } | undefined;
    if (world) {
      requireValue(json(world.value) === true && (this.statement('SELECT kind FROM conversations WHERE id=?').get(room) as { kind: string } | undefined)?.kind === 'group');
      // The owner's host observation room and actual peer discussion rooms are
      // SQL interaction entrances, not untyped world/model authority. Arbitrary
      // marked rooms remain unsupported, and every reader/member gate above
      // still applies independently to the actual captured owner.
      if (room === 'world_' + owner) {
        requireValue((this.statement('SELECT companion_id FROM conversation_members WHERE conversation_id=?').all(room) as Array<{ companion_id: string }>).length === 1);
      } else {
        const social = this.statement('SELECT member_key FROM companion_social_conversations WHERE id=?').get(room) as { member_key: string } | undefined;
        const members = (this.statement('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id').all(room) as Array<{ companion_id: string }>).map(row => row.companion_id);
        requireValue(social && members.length >= 2 && social.member_key === members.join('|'));
        this.edge(parent, 'social-room', room);
      }
    } else {
      requireValue(room !== 'world_' + owner);
      const social = this.statement('SELECT member_key FROM companion_social_conversations WHERE id=?').get(room) as { member_key: string } | undefined;
      // User-room social indexing uses an explicit player prefix. A real peer
      // room cannot lose its host marker and silently become an ordinary room.
      requireValue(!social || social.member_key.startsWith('player|') || social.member_key.startsWith('player-instance|'));
      this.edge(parent, 'social-room', room);
    }
  }
  private primaryTopic(parent: string, id: string, owner: string, room: string) {
    const associations = this.statement('SELECT t.id,t.data FROM companion_message_topics m LEFT JOIN companion_topics t ON t.id=m.topic_id WHERE m.message_id=?').all(id) as Array<{ id: string; data: string }>;
    for (const association of associations) {
      const topic = companionTopicSchema.parse(json(association.data));
      requireValue(topic.id === association.id && topic.conversationId === room && topic.isPrimary && topic.kind === 'discussion'
        && !topic.deletedAt && !topic.forkedFromTopicId && (topic.participantIds.includes(owner) || topic.invitedIds.includes(owner)));
      this.edge(parent, 'topic', topic.id);
    }
  }
  private source(parent: string, owner: string, room: string, id: string, checksum: string, revision?: number, beforeSequence?: number): number {
    const { row, checksum: actualChecksum, published } = this.physicalSource(id);
    requireValue(row.conversation_id === room && ['text', 'action', 'notice'].includes(String(row.kind)) && row.status === 'sent' && actualChecksum === checksum
      && (revision === undefined || Number(row.revision ?? 1) === revision) && (beforeSequence === undefined || Number(row.sequence) <= beforeSequence));
    // Expected bytes/revision and the caller's actual cursor remain edge
    // predicates. Explicit readset.sources historically has no cursor; do not
    // invent one or conflate host snapshot logical and physical rooms.
    requireValue(beforeSequence === undefined || !published || beforeSequence > Number(published.value));
    const nodeKey = key('source', owner, room, id);
    requireValue(!this.active.has(nodeKey) && !this.active.has(key('message', id))
      && (!row.action_id || !this.active.has(key('action', row.action_id))));
    let current = this.sourceAuthorities.get(nodeKey);
    if (!current) current = this.sourceAuthority(nodeKey, owner, room, row, actualChecksum);
    requireValue(!current.volatileActions.some(action => this.active.has(key('action', action.id))));
    this.pinned(current.volatileActions);
    this.edge(parent, 'node', nodeKey); this.carry(parent, current);
    return Number(row.sequence);
  }
  private sourceAuthority(parent: string, owner: string, room: string, row: Row, checksum: string): Obligations {
    const id = String(row.id), binding = hash(canonical(row));
    const cached = currentNode(this.db, parent, this.epoch);
    if (cached?.binding === binding) {
      requireValue(cached.obligations.assetOwners.includes(owner) && this.active.size + this.completed.size < 10000);
      this.completed.set(parent, true);
      this.sourceAuthorities.set(parent, cached.obligations); return cached.obligations;
    }
    this.enter(parent);
    try {
    this.scope(parent, owner, room); this.edge(parent, 'message', id); this.edge(parent, 'source-policy', key(owner, id));
    requireValue(this.statement('SELECT 1 FROM vcp_source_observers WHERE companion_id=? AND message_id=?').get(owner, id));
    requireValue(!this.statement('SELECT 1 FROM vcp_source_blocks WHERE companion_id=? AND message_id=?').get(owner, id));
    this.primaryTopic(parent, id, owner, room);
    requireValue(!this.statement('SELECT 1 FROM companion_reset_messages WHERE message_id=?').get(id));
    const boundary = this.statement('SELECT through_sequence FROM companion_reset_boundaries WHERE companion_id=?').get(owner) as { through_sequence: number } | undefined;
    requireValue(!boundary || Number(row.sequence) > boundary.through_sequence);
    for (const prefix of ['vcp-manual-input/', 'execution-source-invalid/message/']) {
      this.edge(parent, 'metadata', prefix + id); requireValue(!this.statement('SELECT 1 FROM metadata WHERE key=?').get(prefix + id));
    }
    this.edge(parent, 'metadata', 'memory-world-observation/' + id);
    const observationRow = this.statement('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + id) as { value: string } | undefined;
    if (row.kind === 'notice') {
      const observation = observationRow && json<{ checksum?: string; companionId?: string; forConversationId?: string; throughSequence?: number;
        sources?: unknown[]; assetRead?: unknown; topicCheckpoints?: unknown; observation?: { category?: string } }>(observationRow.value);
      requireValue(row.author_id === 'system' && !row.action_id && observation && observation.checksum === checksum && observation.companionId === owner
        && room === 'world_' + owner && Array.isArray(observation.sources) && !observation.sources.length
        && !observation.assetRead && observation.topicCheckpoints === undefined
        && ['contacts', 'people'].includes(String(observation.observation?.category))
        && typeof observation.forConversationId === 'string'
        && (observation.throughSequence === undefined || Number.isSafeInteger(observation.throughSequence) && observation.throughSequence >= 0));
      this.scope(parent, owner, observation.forConversationId);
      requireValue(!this.statement('SELECT 1 FROM metadata WHERE key=?').get('message-execution-readset/' + id));
    } else requireValue(!observationRow);
    for (const prefix of ['message-execution-readset/', 'message-loop/', 'message-published-after/']) this.edge(parent, 'metadata', prefix + id);
    const completedLoop = readCompanionMessageLoopHeader(this.db, 'message-loop/' + id)
      ?? this.statement("SELECT CASE WHEN json_valid(value) THEN json_extract(value,'$.status') END AS status FROM metadata WHERE key=?").get('message-loop/' + id) as { status?: unknown } | undefined;
    requireValue(!completedLoop || completedLoop.status === 'done');
    const rules = this.statement("SELECT id,tag,through_sequence,persistent FROM vcp_source_prohibitions p WHERE companion_id=? AND conversation_id IN(?,'*') AND NOT EXISTS(SELECT 1 FROM vcp_source_prohibition_requests r WHERE r.prohibition_id=p.id AND r.message_id=?)")
      .all(owner, room, id) as Array<{ id: string; tag: string; through_sequence: number; persistent: number }>;
    requireValue(!rules.some(rule => (rule.persistent || Number(row.sequence) <= rule.through_sequence) && String(row.content).normalize('NFKC').toLocaleLowerCase().includes(rule.tag.normalize('NFKC').toLocaleLowerCase())));
    this.notForgotten(owner, row); this.edge(parent, 'node', key('forget', owner, id));
    if (row.action_id) {
      // A second message proof on a tool card is an additional gate, not the
      // action checkpoint. This first protocol never hides that unknown port.
      requireValue(!this.statement('SELECT 1 FROM metadata WHERE key=?').get('message-execution-readset/' + id));
      const action = loadAction(this.db, String(row.action_id)); requireValue(row.author_id === action.companionId && action.conversationId === room);
      this.carry(parent, this.action(action.id)); this.edge(parent, 'node', key('action', action.id));
    } else if (row.kind === 'notice') { /* Exact host snapshot above is a typed SQL leaf, never a model publication. */ }
    else if (row.author_id === 'user') requireValue(row.kind === 'text' && !this.statement('SELECT 1 FROM metadata WHERE key=?').get('message-execution-readset/' + id));
    // Reader authority above belongs to this edge. The child's publication
    // and its private input scopes belong to that child's actual author.
    else { requireValue(row.kind === 'text'); this.carry(parent, this.message(id)); this.edge(parent, 'node', key('message', id)); }
    const current = this.obligations(parent);
    this.save(parent, owner, binding, current); this.completed.set(parent, true); this.sourceAuthorities.set(parent, current);
    return current;
    } finally { this.active.delete(parent); }
  }
  /** Forgetting follows the current reader through reply ancestry, whereas
   * formal publication follows each author's own input authority. Keep these
   * separate typed nodes so neither can confer the other's permissions. */
  private notForgotten(owner: string, row: Row): void {
    const id = String(row.id), nodeKey = key('forget', owner, id), binding = hash(canonical(row));
    if (this.completed.has(nodeKey)) return;
    const cached = currentNode(this.db, nodeKey, this.epoch);
    if (cached?.binding === binding) { this.completed.set(nodeKey, true); return; }
    this.enter(nodeKey);
    try {
      this.edge(nodeKey, 'owner', owner); this.edge(nodeKey, 'policy', owner); this.edge(nodeKey, 'message', id); this.edge(nodeKey, 'source-policy', key(owner, id));
      this.edge(nodeKey, 'metadata', 'message-loop/' + id);
      requireValue(!this.statement('SELECT 1 FROM vcp_source_blocks WHERE companion_id=? AND message_id=?').get(owner, id));
      const rules = this.statement("SELECT id,tag,through_sequence,persistent FROM vcp_source_prohibitions p WHERE companion_id=? AND conversation_id IN(?,'*') AND NOT EXISTS(SELECT 1 FROM vcp_source_prohibition_requests r WHERE r.prohibition_id=p.id AND r.message_id=?)")
        .all(owner, row.conversation_id, id) as Array<{ id: string; tag: string; through_sequence: number; persistent: number }>;
      requireValue(!rules.some(rule => (rule.persistent || Number(row.sequence) <= rule.through_sequence) && String(row.content).normalize('NFKC').toLocaleLowerCase().includes(rule.tag.normalize('NFKC').toLocaleLowerCase())));
      for (const rule of rules) this.edge(nodeKey, 'prohibition', rule.id);
      if (row.author_id !== 'user') {
        const compact = readCompanionMessageLoopHeader(this.db, 'message-loop/' + id);
        const loop = compact === undefined ? this.statement('SELECT value FROM metadata WHERE key=?').get('message-loop/' + id) as { value: string } | undefined : undefined;
        const sourceMessageId = compact === undefined ? loop ? json<{ sourceMessageId?: unknown }>(loop.value).sourceMessageId : undefined : compact.sourceMessageId;
        const actionSource = row.action_id ? loadAction(this.db, String(row.action_id)).sourceMessageId : undefined;
        if (row.action_id) this.edge(nodeKey, 'action', String(row.action_id));
        for (const ancestorId of new Set([row.reply_to_id, sourceMessageId, actionSource].filter((value): value is string => typeof value === 'string' && !!value))) {
          const { row: ancestor } = this.physicalSource(ancestorId);
          this.notForgotten(owner, ancestor); this.edge(nodeKey, 'node', key('forget', owner, ancestorId));
        }
      }
      this.save(nodeKey, owner, binding, {}); this.completed.set(nodeKey, true);
    } finally { this.active.delete(nodeKey); }
  }
  message(id: string): Obligations {
    const nodeKey = key('message', id); if (this.completed.has(nodeKey)) { const ready = this.ready.get(nodeKey); requireValue(ready); return ready; }
    const { row, readset, certificate, binding } = loadMessage(this.db, id), cached = currentNode(this.db, nodeKey, this.epoch);
    const previous = this.statement('SELECT binding,data FROM companion_published_dependency_nodes WHERE node_key=?').get(nodeKey) as { binding: string; data: string } | undefined;
    if (cached && cached.binding === binding) { const current = obligations(cached.data); requireValue(current.assetOwners.includes(readset.companionId)); this.pinned(current.volatileActions); this.completed.set(nodeKey, true); this.ready.set(nodeKey, current); return current; }
    this.enter(nodeKey);
    try {
      requireValue(!readset.knowledgeReads.length);
      const pins = readPublishedMessageActionPins(this.db, certificate); if (pins) this.pinned(pins);
      this.scope(nodeKey, readset.companionId, readset.conversationId);
      this.edge(nodeKey, 'message', id); this.edge(nodeKey, 'certificate', id);
      this.edge(nodeKey, 'publication-pins', id);
      for (const prefix of ['message-execution-readset/', 'message-loop/', 'message-published-after/', 'memory-world-observation/', 'vcp-manual-input/', 'execution-source-invalid/message/']) this.edge(nodeKey, 'metadata', prefix + id);
      this.primaryTopic(nodeKey, id, readset.companionId, readset.conversationId);
      for (const prefix of ['memory-world-observation/', 'vcp-manual-input/', 'execution-source-invalid/message/']) requireValue(!this.statement('SELECT 1 FROM metadata WHERE key=?').get(prefix + id));
      const compact = readCompanionMessageLoopHeader(this.db, 'message-loop/' + id);
      const loop = compact === undefined ? this.statement('SELECT value FROM metadata WHERE key=?').get('message-loop/' + id) as { value: string } | undefined : undefined;
      const loopValue = compact === undefined ? loop ? json<{ status?: unknown; sourceMessageId?: unknown }>(loop.value) : undefined : compact;
      requireValue(!loopValue || loopValue.status === 'done');
      for (const ancestor of new Set([row.reply_to_id, loopValue?.sourceMessageId].filter((value): value is string => typeof value === 'string' && !!value))) {
        const source = this.physicalSource(ancestor);
        this.source(nodeKey, readset.companionId, String(source.row.conversation_id), ancestor, source.checksum);
      }
      const contexts = this.proof(nodeKey, readset);
      requireValue(hash(canonical(contexts)) === certificate.contextClosureDigest);
      const current = this.obligations(nodeKey), { volatileActions } = current;
      requireValue((!volatileActions.length && pins === undefined) || pins !== undefined && canonical(pins) === canonical(volatileActions));
      // A generation change may retire an immutable dependency, but cannot
      // silently rebind the same historical certificate to a different result.
      requireValue(!previous || previous.binding !== binding || canonical(actionObligations(previous.data)) === canonical(volatileActions));
      requireValue(!previous || previous.binding !== binding || json<{ indexVersion?: number }>(previous.data).indexVersion !== indexVersion
        || canonical(obligations(previous.data).assetOwners) === canonical(current.assetOwners));
      this.save(nodeKey, readset.companionId, binding, { certificate, ...current }); this.completed.set(nodeKey, true); this.ready.set(nodeKey, current); return current;
    } finally { this.active.delete(nodeKey); }
  }
  private action(id: string): Obligations {
    const nodeKey = key('action', id); if (this.completed.has(nodeKey)) { const ready = this.ready.get(nodeKey); requireValue(ready); return ready; }
    const action = loadAction(this.db, id), cached = currentNode(this.db, nodeKey, this.epoch);
    const pinned = this.pinnedActions.get(id);
    requireValue(pinned && pinned.actionBindingHash === action.binding && pinned.readsetDigest === hash(canonical(action.readset))
      && pinned.companionId === action.companionId && pinned.conversationId === action.conversationId);
    if (cached?.binding === action.binding) { const current = obligations(cached.data); requireValue(current.assetOwners.includes(action.companionId)); this.completed.set(nodeKey, true); this.ready.set(nodeKey, current); return current; }
    this.enter(nodeKey);
    try {
      this.scope(nodeKey, action.companionId, action.conversationId);
      this.edge(nodeKey, 'action', id); this.edge(nodeKey, 'metadata', 'task-checkpoint/' + id); this.edge(nodeKey, 'metadata', 'execution-source-invalid/action/' + id);
      requireValue(!this.statement('SELECT 1 FROM metadata WHERE key=?').get('execution-source-invalid/action/' + id));
      // A card can carry a second message proof in addition to the action's
      // checkpoint. This cut cannot erase that extra Main input gate. Index
      // the absence explicitly, including future card insertion/rebinding.
      this.edge(nodeKey, 'action-messages', id);
      for (const card of this.statement('SELECT id FROM messages WHERE action_id=?').all(id) as Array<{ id: string }>) {
        this.edge(nodeKey, 'message', card.id); this.edge(nodeKey, 'metadata', 'message-execution-readset/' + card.id);
        requireValue(!this.statement('SELECT 1 FROM metadata WHERE key=?').get('message-execution-readset/' + card.id));
      }
      this.proof(nodeKey, action.readset);
      const source = this.physicalSource(action.sourceMessageId);
      this.source(nodeKey, action.companionId, String(source.row.conversation_id), action.sourceMessageId, source.checksum);
      this.carry(nodeKey, { volatileActions: [{ id, companionId: action.companionId, conversationId: action.conversationId,
        actionBindingHash: action.binding, readsetDigest: hash(canonical(action.readset)) }], assetOwners: [action.companionId] });
      const current = this.obligations(nodeKey);
      this.save(nodeKey, action.companionId, action.binding, current); this.completed.set(nodeKey, true); this.ready.set(nodeKey, current); return current;
    } finally { this.active.delete(nodeKey); }
  }
  private proof(nodeKey: string, readset: CompanionExecutionReadset): unknown[] {
      requireValue(!readset.knowledgeReads.length);
      for (const source of readset.sources) this.source(nodeKey, readset.companionId, source.conversationId, source.id, source.checksum);
      this.topics(nodeKey, readset);
      const captured = [...readset.memoryReads ?? [], ...readset.frozenMemories ?? []];
      requireValue(readset.memories.every(note => readset.memoryReads?.some(read => read.id === note.id && read.version === note.version)));
      for (const memory of captured) {
        requireValue(memory.contentRevision !== undefined);
        const current = this.memory(readset.companionId, memory.id, memory.contentRevision);
        requireValue(readset.beforeSequence === undefined || current.maxSequence <= readset.beforeSequence);
        requireValue(memory.sources.length === current.descriptor.sources.length && memory.sources.every(source => current.descriptor.sources.some(actual => actual.id === source.id && actual.conversationId === source.conversationId && actual.checksum === source.checksum && (source.revision === undefined || source.revision === actual.revision))));
        if (memory.version !== undefined) {
          const alias = this.statement('SELECT content_revision FROM companion_memory_version_revisions WHERE note_id=? AND version=?').get(memory.id, memory.version) as { content_revision: number } | undefined;
          requireValue(alias?.content_revision === memory.contentRevision); this.edge(nodeKey, 'memory-version', key(memory.id, memory.version));
        }
        this.edge(nodeKey, 'node', key('memory', readset.companionId, memory.id, memory.contentRevision));
        this.carry(nodeKey, current);
      }
      const contexts: unknown[] = [];
      for (const context of readset.contexts) {
        requireValue(context.fileReceiptOnly && context.fileReceipts);
        const roots: Array<{ id: string; contentRevision: number }> = [];
        for (const receipt of context.fileReceipts) {
          requireValue(receipt.companionId === readset.companionId && captured.some(memory => memory.id === receipt.noteId && memory.contentRevision === receipt.contentRevision));
          const memory = this.memory(receipt.companionId, receipt.noteId, receipt.contentRevision);
          requireValue(memory.contentHash === receipt.contentHash && memory.path === receipt.path
            && (!context.typeScope || context.typeScope.contentKinds.some(kind => kind === memory.artifactKind))
            && (context.beforeSequence === undefined || memory.maxSequence <= context.beforeSequence));
          roots.push({ id: receipt.noteId, contentRevision: receipt.contentRevision });
        }
        const closure = new Map<string, Descriptor>();
        const visit = (id: string, revision: number) => {
          const identity = key(readset.companionId, id, revision); if (closure.has(identity)) return;
          const memory = this.memory(readset.companionId, id, revision);
          for (const dependency of memory.descriptor.dependencies) visit(dependency.id, dependency.contentRevision);
          closure.set(identity, memory.descriptor);
        };
        for (const root of roots) visit(root.id, root.contentRevision);
        contexts.push({ context, descriptors: [...closure].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, descriptor]) => descriptor) });
      }
      return contexts;
  }
  private topics(nodeKey: string, readset: CompanionExecutionReadset): void {
    for (const reference of readset.topics) {
      this.scope(nodeKey, readset.companionId, reference.conversationId);
      const found = this.statement('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(reference.topicId, reference.conversationId) as { data: string } | undefined;
      const topic = companionTopicSchema.parse(json(found?.data));
      // Forked/game/custom topic semantics remain on the complete old path.
      requireValue(topic.id === reference.topicId && topic.conversationId === reference.conversationId && topic.isPrimary && topic.kind === 'discussion'
        && !topic.deletedAt && !topic.forkedFromTopicId && (topic.participantIds.includes(readset.companionId) || topic.invitedIds.includes(readset.companionId)));
      this.edge(nodeKey, 'topic', topic.id);
      const sources = (ids: readonly string[]) => {
        for (const id of ids) {
          const source = this.physicalSource(id);
          requireValue(source.row.conversation_id === reference.conversationId);
          // Deliberately require original source observation here. A late
          // invitee's checkpoint grant does not authorize its raw messages;
          // such a checkpoint continues through the original shared ACL gate.
          this.source(nodeKey, readset.companionId, reference.conversationId, id, source.checksum);
        }
        return true;
      };
      sources(reference.sourceMessageIds);
      for (const id of reference.checkpointEventIds)
        requireValue(companionTopicCheckpointEventValid(this.db, topic, readset.companionId, id, sources, error => { available(error); }));
      // The original validator above owns reader, ordinal, checksum and DAG
      // semantics. Index every visited immutable event, not only its head.
      const pending = [...reference.checkpointEventIds], visited = new Set<string>();
      for (let index = 0; index < pending.length; index++) {
        const id = pending[index]!; if (visited.has(id)) continue; visited.add(id); requireValue(visited.size <= 10000);
        const event = this.statement('SELECT rowid AS ordinal,topic_id,reader_id,data FROM companion_topic_events WHERE id=?').get(id) as { ordinal: number; topic_id: string; reader_id: string; data: string } | undefined;
        requireValue(event && event.topic_id === topic.id && (event.reader_id === '*' || event.reader_id === readset.companionId));
        const checkpoint = companionTopicCheckpointSchema.parse(json(event.data)); requireValue(checkpoint.sourceEventId === id);
        const original = this.statement('SELECT topic_id,reader_id FROM companion_topic_checkpoint_nodes WHERE event_id=?').get(id) as { topic_id: string; reader_id: string } | undefined;
        requireValue(original?.topic_id === event.topic_id && original.reader_id === event.reader_id
          && companionTopicCheckpointInputValid(this.db, readset.companionId, id, hash(event.data)));
        // The existing checkpoint index pins original bytes and withdrawal.
        // Also pin its SQL identity/order: an old Main certificate must never
        // adopt a replacement event under the same ID after invalidation.
        const eventKey = key('topic-event', id), binding = hash(canonical([id, event.ordinal, event.topic_id, event.reader_id, event.data]));
        const previous = this.statement('SELECT binding FROM companion_published_dependency_nodes WHERE node_key=?').get(eventKey) as { binding: string } | undefined;
        requireValue(!previous || previous.binding === binding);
        if (!previous) {
          this.edge(eventKey, 'topic-event', id);
          this.save(eventKey, readset.companionId, binding, {});
        }
        this.edge(nodeKey, 'topic-event', id);
        this.edge(nodeKey, 'topic-event-owner', key(readset.companionId, id));
        this.edge(nodeKey, 'node', eventKey);
        const legacy = checkpoint.state?.__continuity as { previousCheckpointEventId?: unknown } | undefined;
        pending.push(...(checkpoint.derivedFromEventIds ?? (typeof legacy?.previousCheckpointEventId === 'string' ? [legacy.previousCheckpointEventId] : [])));
      }
    }
  }
  private artifact(parent: string, owner: string, id: string, expectedHash: string, expectedRevision?: number): CompanionArtifact {
    const marker = key('artifact', owner, id, expectedHash, expectedRevision ?? null);
    this.edge(parent, 'artifact', key(owner, id));
    const checked = this.checkedArtifacts.get(marker); if (checked) return checked;
    this.enter(marker);
    try {
      const found = this.statement('SELECT metadata,state,revision,content_hash FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get(owner, id) as Row | undefined;
      requireValue(found?.state === 'committed' && found.content_hash === expectedHash && (expectedRevision === undefined || found.revision === expectedRevision));
      const artifact = companionArtifactSchema.parse(json(found.metadata));
      requireValue(artifact.ownerId === owner && artifact.artifactId === id && artifact.contentRevision === found.revision && artifact.contentHash === expectedHash
        && artifact.publicationState === 'committed' && ['source_evidence', 'revision_history'].includes(artifact.kind) && artifact.allowedConsumers.includes('audit')
        && (artifact.visibility.scope === 'owner' || artifact.visibility.scope === 'public'));
      const version = this.statement('SELECT metadata,content_hash FROM companion_artifact_versions WHERE owner_id=? AND artifact_id=? AND revision=?').get(owner, id, artifact.contentRevision) as { metadata: string; content_hash: string } | undefined;
      requireValue(version?.content_hash === expectedHash && canonical(json(version.metadata)) === canonical(artifact));
      const refs = [...artifact.sourceRefs, ...artifact.dependencyRefs];
      const edges = this.statement('SELECT source_id FROM companion_artifact_edges WHERE owner_id=? AND target_id=?').all(owner, id) as Array<{ source_id: string }>;
      requireValue(canonical([...new Set(edges.map(edge => edge.source_id))].sort()) === canonical([...new Set(refs.map(ref => ref.artifactId))].sort()));
      for (const ref of refs) this.artifact(parent, owner, ref.artifactId, ref.contentHash, ref.contentRevision);
      this.checkedArtifacts.set(marker, artifact); return artifact;
    } finally { this.active.delete(marker); }
  }
  private memory(owner: string, id: string, revision: number): MemoryNode {
    const nodeKey = key('memory', owner, id, revision), complete = this.completed.get(nodeKey);
    if (complete && complete !== true) return complete;
    const cached = currentNode(this.db, nodeKey, this.epoch);
    if (cached) { const data = json<MemoryNode>(cached.data); Object.assign(data, obligations(cached.data)); requireValue(data.assetOwners.includes(owner)); this.pinned(data.volatileActions); this.completed.set(nodeKey, data); return data; }
    this.enter(nodeKey);
    try {
      const found = this.statement('SELECT * FROM companion_memory_history_files WHERE companion_id=? AND note_id=? AND content_revision=?').get(owner, id, revision) as Row | undefined;
      const body = this.statement('SELECT body_hash,data FROM companion_memory_content_revisions WHERE companion_id=? AND note_id=? AND content_revision=?').get(owner, id, revision) as { body_hash: string; data: string } | undefined;
      requireValue(found?.state === 'published' && body && body.body_hash === found.body_hash);
      const payload = json<{ memory: unknown; dependencies: Descriptor['dependencies']; withdrawn?: boolean }>(body.data), note = companionMemorySchema.parse(payload.memory);
      requireValue(!payload.withdrawn && note.id === id && note.companionId === owner && note.contentRevision === revision && note.sources.length);
      const descriptor = companionMemoryHistoryDescriptorSchema.parse({ companionId: owner, id, contentRevision: revision, bodyHash: found.body_hash,
        documentHash: found.document_hash, relativePath: found.relative_path, sources: json(found.sources), dependencies: json(found.dependencies) });
      // Validate the shape above, then retain the original JSON field order:
      // the durable document was rendered from those exact stored fields.
      requireValue(hash(renderCompanionMemoryHistory({ memory: payload.memory as CompanionMemory, dependencies: payload.dependencies }, body.body_hash)) === descriptor.documentHash);
      const ordered = (values: unknown[]) => [...values].map(canonical).sort();
      requireValue(canonical(ordered(payload.dependencies)) === canonical(ordered(descriptor.dependencies)));
      requireValue(canonical(ordered(note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, revision: source.revision, checksum: source.checksum })))) === canonical(ordered(descriptor.sources)));
      const sourceIndex = this.statement('SELECT source_id FROM companion_memory_history_sources WHERE companion_id=? AND note_id=? AND content_revision=?').all(owner, id, revision) as Array<{ source_id: string }>;
      const dependencies = this.statement('SELECT parent_id AS id,parent_revision AS contentRevision FROM companion_memory_history_dependencies WHERE companion_id=? AND note_id=? AND content_revision=?').all(owner, id, revision) as Descriptor['dependencies'];
      requireValue(canonical(sourceIndex.map(source => source.source_id).sort()) === canonical(descriptor.sources.map(source => source.id).sort()) && canonical(ordered(dependencies)) === canonical(ordered(descriptor.dependencies)));
      const current = this.statement('SELECT companion_id,data FROM vcp_memory_notes WHERE id=?').get(id) as { companion_id: string; data: string } | undefined;
      requireValue(current?.companion_id === owner); this.edge(nodeKey, 'note', id); this.edge(nodeKey, 'memory', key(owner, id, revision));
      this.scope(nodeKey, owner, note.sourceConversationId);
      let maxSequence = 0;
      for (const source of descriptor.sources) {
        requireValue(this.statement('SELECT 1 FROM vcp_note_source_history WHERE note_id=? AND message_id=?').get(id, source.id));
        this.edge(nodeKey, 'note-source-history', key(id, source.id));
        maxSequence = Math.max(maxSequence, this.source(nodeKey, owner, source.conversationId, source.id, source.checksum));
      }
      for (const dependency of descriptor.dependencies) { const parent = this.memory(owner, dependency.id, dependency.contentRevision);
        maxSequence = Math.max(maxSequence, parent.maxSequence); this.edge(nodeKey, 'node', key('memory', owner, dependency.id, dependency.contentRevision)); this.carry(nodeKey, parent); }
      const artifactId = `history:${id}:r${revision}`, artifact = this.artifact(nodeKey, owner, artifactId, descriptor.documentHash);
      requireValue(artifact.kind === 'revision_history' && artifact.relativePath === descriptor.relativePath);
      const sourceRefs = descriptor.sources.map(source => [ `source:${source.id}:r${source.revision}`, source.checksum ]);
      const dependencyRefs = descriptor.dependencies.map(dependency => [ `history:${dependency.id}:r${dependency.contentRevision}`, this.memory(owner, dependency.id, dependency.contentRevision).descriptor.documentHash ]);
      requireValue(canonical(sourceRefs.sort()) === canonical(artifact.sourceRefs.map(ref => [ref.artifactId, ref.contentHash]).sort())
        && canonical(dependencyRefs.sort()) === canonical(artifact.dependencyRefs.map(ref => [ref.artifactId, ref.contentHash]).sort()));
      const roots: Record<string, string> = { episode_memory: '经历', knowledge: '知识', procedure: '知识', self_understanding: '自我认识', navigation: '导航' };
      const path = note.artifactKind === 'dream_fiction' ? `演化/联想/${note.id}.md` : roots[note.artifactKind] ? `记忆/${roots[note.artifactKind]}/${encodeURIComponent(note.id)}.md` : '';
      requireValue(path);
      const result: MemoryNode = { descriptor, contentHash: hash(note.content), path, artifactKind: note.artifactKind, maxSequence, ...this.obligations(nodeKey) };
      this.save(nodeKey, owner, hash(canonical([body.data, descriptor])), result); this.completed.set(nodeKey, result); return result;
    } finally { this.active.delete(nodeKey); }
  }
}
