import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionTopicCheckpointSchema } from '../shared/companion-topic';

export const companionTopicCheckpointHash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Derived, body-free reverse indexes of the actual immutable checkpoint DAG.
 * One event's direct edges/sources are indexed once, never flattened into each
 * consuming job. Source changes invalidate descendants once at mutation time. */
export function initializeCompanionTopicCheckpointIndex(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_topic_checkpoint_nodes(event_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,reader_id TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_topic_checkpoint_sources(event_id TEXT NOT NULL,source_id TEXT NOT NULL,revision INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(event_id,source_id));
    CREATE INDEX IF NOT EXISTS companion_topic_checkpoint_source ON companion_topic_checkpoint_sources(source_id,revision,checksum,event_id);
    CREATE TABLE IF NOT EXISTS companion_topic_checkpoint_edges(event_id TEXT NOT NULL,parent_event_id TEXT NOT NULL,PRIMARY KEY(event_id,parent_event_id));
    CREATE INDEX IF NOT EXISTS companion_topic_checkpoint_parent ON companion_topic_checkpoint_edges(parent_event_id,event_id);
    CREATE TABLE IF NOT EXISTS companion_topic_checkpoint_owner_blocks(owner_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(owner_id,event_id));
    CREATE INDEX IF NOT EXISTS companion_topic_checkpoint_block_event ON companion_topic_checkpoint_owner_blocks(event_id,owner_id);
    CREATE TABLE IF NOT EXISTS companion_topic_checkpoint_owner_reads(owner_id TEXT NOT NULL,event_id TEXT NOT NULL,acl_revision TEXT NOT NULL,PRIMARY KEY(owner_id,event_id));`);
  const affectedSources = `WITH RECURSIVE affected(event_id) AS (
    SELECT event_id FROM companion_topic_checkpoint_sources WHERE source_id=OLD.id
    UNION SELECT e.event_id FROM companion_topic_checkpoint_edges e JOIN affected a ON e.parent_event_id=a.event_id) SELECT event_id FROM affected`;
  const affectedEvent = `WITH RECURSIVE affected(event_id) AS (SELECT OLD.id
    UNION SELECT e.event_id FROM companion_topic_checkpoint_edges e JOIN affected a ON e.parent_event_id=a.event_id) SELECT event_id FROM affected`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS companion_topic_checkpoint_source_changed AFTER UPDATE OF content,revision,status ON messages
    WHEN OLD.content IS NOT NEW.content OR OLD.revision IS NOT NEW.revision OR OLD.status IS NOT NEW.status
    BEGIN UPDATE companion_topic_checkpoint_nodes SET state='source_changed' WHERE event_id IN(${affectedSources}); END;
    CREATE TRIGGER IF NOT EXISTS companion_topic_checkpoint_source_deleted BEFORE DELETE ON messages
    BEGIN UPDATE companion_topic_checkpoint_nodes SET state='source_removed' WHERE event_id IN(${affectedSources}); END;
    CREATE TRIGGER IF NOT EXISTS companion_topic_checkpoint_event_changed AFTER UPDATE OF data,topic_id,reader_id ON companion_topic_events
    WHEN OLD.data IS NOT NEW.data OR OLD.topic_id IS NOT NEW.topic_id OR OLD.reader_id IS NOT NEW.reader_id
    BEGIN UPDATE companion_topic_checkpoint_nodes SET state='event_changed' WHERE event_id IN(${affectedEvent}); END;
    CREATE TRIGGER IF NOT EXISTS companion_topic_checkpoint_event_deleted BEFORE DELETE ON companion_topic_events
    BEGIN UPDATE companion_topic_checkpoint_nodes SET state='event_removed' WHERE event_id IN(${affectedEvent});
      DELETE FROM companion_topic_checkpoint_sources WHERE event_id=OLD.id;
      DELETE FROM companion_topic_checkpoint_edges WHERE event_id=OLD.id;
      DELETE FROM companion_topic_checkpoint_owner_blocks WHERE event_id=OLD.id;
      DELETE FROM companion_topic_checkpoint_owner_reads WHERE event_id=OLD.id;
      DELETE FROM companion_topic_checkpoint_nodes WHERE event_id=OLD.id;
    END;`);
}

export function companionTopicCheckpointIndexed(db: CompanionConnection, eventId: string): boolean {
  return !!db.prepare('SELECT 1 FROM companion_topic_checkpoint_nodes WHERE event_id=?').get(eventId);
}

/** Call only after the existing host DAG/source-ACL validator, or while adding
 * a just-committed canonical event whose source transaction already passed. */
export function indexCompanionTopicCheckpoint(db: CompanionConnection, eventId: string, visiting = new Set<string>()): boolean {
  const saved = db.prepare('SELECT rowid AS ordinal,topic_id,reader_id,data FROM companion_topic_events WHERE id=?').get(eventId) as
    { ordinal: number; topic_id: string; reader_id: string; data: string } | undefined;
  if (!saved || visiting.has(eventId)) return false;
  const hash = companionTopicCheckpointHash(saved.data), existing = db.prepare('SELECT body_hash,state FROM companion_topic_checkpoint_nodes WHERE event_id=?').get(eventId) as { body_hash: string; state: string } | undefined;
  if (existing) return existing.body_hash === hash && existing.state === 'valid';
  const parsed = companionTopicCheckpointSchema.safeParse(JSON.parse(saved.data));
  if (!parsed.success || parsed.data.sourceEventId !== eventId) return false;
  const checkpoint = parsed.data, continuity = checkpoint.state?.__continuity;
  const previous = continuity && typeof continuity === 'object' && 'previousCheckpointEventId' in continuity && typeof continuity.previousCheckpointEventId === 'string'
    ? [continuity.previousCheckpointEventId] : [];
  const parents = checkpoint.derivedFromEventIds ?? previous;
  visiting.add(eventId); let valid = true;
  for (const parent of parents) {
    const ancestor = db.prepare('SELECT rowid AS ordinal FROM companion_topic_events WHERE id=?').get(parent) as { ordinal: number } | undefined;
    if (!ancestor || ancestor.ordinal >= saved.ordinal || !indexCompanionTopicCheckpoint(db, parent, visiting)) valid = false;
  }
  visiting.delete(eventId);
  const references: Array<{ id: string; revision: number; checksum: string }> = [];
  for (const id of checkpoint.sourceMessageIds) {
    const source = db.prepare('SELECT revision,content,status FROM messages WHERE id=?').get(id) as { revision: number; content: string; status: string } | undefined;
    if (!source || source.status !== 'sent') { valid = false; continue; }
    const checksum = companionTopicCheckpointHash(source.content);
    if (checkpoint.sourceChecksums?.[id] !== undefined && checkpoint.sourceChecksums[id] !== checksum) valid = false;
    references.push({ id, revision: source.revision, checksum });
  }
  db.prepare('INSERT INTO companion_topic_checkpoint_nodes(event_id,topic_id,reader_id,body_hash,state) VALUES(?,?,?,?,?)')
    .run(eventId, saved.topic_id, saved.reader_id, hash, valid ? 'valid' : 'invalid');
  const source = db.prepare('INSERT INTO companion_topic_checkpoint_sources(event_id,source_id,revision,checksum) VALUES(?,?,?,?)');
  for (const reference of references) source.run(eventId, reference.id, reference.revision, reference.checksum);
  const edge = db.prepare('INSERT INTO companion_topic_checkpoint_edges(event_id,parent_event_id) VALUES(?,?)');
  for (const parent of parents) {
    edge.run(eventId, parent);
    db.prepare('INSERT OR IGNORE INTO companion_topic_checkpoint_owner_blocks(owner_id,event_id) SELECT owner_id,? FROM companion_topic_checkpoint_owner_blocks WHERE event_id=?').run(eventId, parent);
  }
  return valid;
}

export function companionTopicCheckpointInputValid(db: CompanionConnection, ownerId: string, eventId: string, hash: string): boolean {
  return !!db.prepare(`SELECT 1 FROM companion_topic_checkpoint_nodes n WHERE event_id=? AND body_hash=? AND state='valid'
    AND NOT EXISTS(SELECT 1 FROM companion_topic_checkpoint_owner_blocks b WHERE b.owner_id=? AND b.event_id=n.event_id)`)
    .get(eventId, hash, ownerId);
}

/** Memoize direct ACL validation per immutable node and owner. The global
 * change marker and owner-local withdrawal blocks always take precedence. */
export function ensureCompanionTopicCheckpointOwnerRead(db: CompanionConnection, ownerId: string, eventId: string,
  allowedTopics: ReadonlySet<string>, aclRevision: string, sourcesValid: (ids: readonly string[]) => boolean, visiting = new Set<string>()): boolean {
  const node = db.prepare('SELECT topic_id,reader_id,body_hash FROM companion_topic_checkpoint_nodes WHERE event_id=?').get(eventId) as
    { topic_id: string; reader_id: string; body_hash: string } | undefined;
  if (!node || visiting.has(eventId) || !allowedTopics.has(node.topic_id) || node.reader_id !== '*' && node.reader_id !== ownerId
    || !companionTopicCheckpointInputValid(db, ownerId, eventId, node.body_hash)) return false;
  if (db.prepare('SELECT 1 FROM companion_topic_checkpoint_owner_reads WHERE owner_id=? AND event_id=? AND acl_revision=?').get(ownerId, eventId, aclRevision)) return true;
  visiting.add(eventId);
  const parents = db.prepare('SELECT parent_event_id FROM companion_topic_checkpoint_edges WHERE event_id=?').all(eventId) as Array<{ parent_event_id: string }>;
  for (const parent of parents) if (!ensureCompanionTopicCheckpointOwnerRead(db, ownerId, parent.parent_event_id, allowedTopics, aclRevision, sourcesValid, visiting)) return false;
  const sources = db.prepare('SELECT source_id FROM companion_topic_checkpoint_sources WHERE event_id=?').all(eventId) as Array<{ source_id: string }>;
  if (!sourcesValid(sources.map(source => source.source_id))) return false;
  visiting.delete(eventId);
  db.prepare('INSERT INTO companion_topic_checkpoint_owner_reads(owner_id,event_id,acl_revision) VALUES(?,?,?) ON CONFLICT(owner_id,event_id) DO UPDATE SET acl_revision=excluded.acl_revision').run(ownerId, eventId, aclRevision);
  return true;
}
