import { randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMemory } from '../shared/companions';
import { companionMemorySourceOutboxSchema, type CompanionMemorySourceOutbox } from '../shared/companion-memory';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';

type Source = NonNullable<CompanionMemorySourceOutbox['source']>;
type Row = { id: string; companion_id: string; source_id: string; source_revision: number; source_checksum: string; operation: 'publish' | 'retract'; attempts: number };
export class CompanionMemorySourceOutboxStore {
  private readonly changed = new Set<string>();
  constructor(private readonly db: CompanionConnection, private readonly resolve: (owner: string, id: string) => Source | undefined) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_memory_source_outbox(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      companion_id TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_checksum TEXT NOT NULL,operation TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,error TEXT,
      UNIQUE(companion_id,source_id,source_revision,source_checksum,operation));
      CREATE INDEX IF NOT EXISTS companion_memory_source_delivery ON companion_memory_source_outbox(companion_id,status,next_attempt,ordinal);`);
    this.db.prepare("UPDATE companion_memory_source_outbox SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running'").run();
  }
  takeChangedOwners(): string[] { const result = [...this.changed]; this.changed.clear(); return result; }
  private enqueue(owner: string, source: Pick<Source, 'messageId' | 'revision' | 'checksum'>, operation: 'publish' | 'retract'): void {
    const result = this.db.prepare('INSERT OR IGNORE INTO companion_memory_source_outbox(id,companion_id,source_id,source_revision,source_checksum,operation) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), owner, source.messageId, source.revision, source.checksum, operation);
    if (result.changes) this.changed.add(owner);
  }
  publish(note: CompanionMemory): void {
    if (note.status === 'invalid' || note.status === 'forgotten') return;
    for (const reference of note.sources) {
      const actual = this.resolve(note.companionId, reference.messageId);
      if (actual?.revision === reference.revision && actual.checksum === reference.checksum) this.enqueue(note.companionId, reference, 'publish');
    }
  }
  retract(owner: string, ids: readonly string[]): void {
    for (const id of new Set(ids)) {
      const known = this.db.prepare("SELECT DISTINCT source_revision,source_checksum FROM companion_memory_source_outbox WHERE companion_id=? AND source_id=? AND operation='publish'")
        .all(owner, id) as Array<{ source_revision: number; source_checksum: string }>;
      for (const previous of known) this.enqueue(owner, { messageId: id, revision: previous.source_revision, checksum: previous.source_checksum }, 'retract');
      this.db.prepare("UPDATE companion_memory_source_outbox SET status='done' WHERE companion_id=? AND source_id=? AND operation='publish' AND status IN('pending','failed')").run(owner, id);
    }
  }
  changedSource(owner: string, id: string): void {
    const known = this.db.prepare("SELECT 1 FROM companion_memory_source_outbox WHERE companion_id=? AND source_id=? AND operation='publish' LIMIT 1").get(owner, id);
    if (!known) return;
    this.retract(owner, [id]); const actual = this.resolve(owner, id); if (actual) this.enqueue(owner, actual, 'publish');
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type === 'memory.sources.outbox.owners') {
      const now = Date.now(), owners = this.db.prepare(`SELECT o.companion_id,MIN(o.ordinal) AS first FROM companion_memory_source_outbox o JOIN companions c ON c.id=o.companion_id
        WHERE c.deleted_at IS NULL AND (o.status IN('pending','failed') AND o.next_attempt<=? OR o.status='running' AND o.lease_until<=?)
        AND o.companion_id NOT IN(SELECT value FROM json_each(?)) GROUP BY o.companion_id ORDER BY first LIMIT ?`)
        .all(now, now, JSON.stringify(command.excludedOwners ?? []), command.limit ?? 4) as Array<{ companion_id: string }>;
      return { ok: true, memorySourcePendingOwners: owners.map(owner => owner.companion_id) };
    }
    if (command.type === 'memory.sources.outbox.claim') return this.db.transaction(() => {
      const now = Date.now();
      const found = this.db.prepare(`SELECT * FROM companion_memory_source_outbox WHERE (status IN('pending','failed') AND next_attempt<=? OR status='running' AND lease_until<=?)
        ${command.companionId ? 'AND companion_id=?' : ''} ORDER BY ordinal LIMIT 1`).get(now, now, ...(command.companionId ? [command.companionId] : [])) as Row | undefined;
      if (!found) return { ok: true };
      const operation = companionMemorySourceOutboxSchema.shape.operation.parse(found.operation);
      const token = randomUUID(), actual = operation === 'publish' ? this.resolve(found.companion_id, found.source_id) : undefined;
      const valid = actual?.revision === found.source_revision && actual.checksum === found.source_checksum;
      this.db.prepare("UPDATE companion_memory_source_outbox SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?")
        .run(token, now + (command.leaseMs ?? 120000), found.id);
      return { ok: true, memorySourceOutbox: companionMemorySourceOutboxSchema.parse({ id: found.id, companionId: found.companion_id, sourceId: found.source_id,
        sourceRevision: found.source_revision, sourceChecksum: found.source_checksum, operation: operation === 'publish' && valid ? 'publish' : 'retract',
        leaseToken: token, attempts: found.attempts + 1, ...(valid ? { source: actual } : {}) }) };
    }).immediate();
    if (command.type !== 'memory.sources.outbox.complete' && command.type !== 'memory.sources.outbox.fail') return;
    return this.db.transaction(() => {
      const found = this.db.prepare("SELECT * FROM companion_memory_source_outbox WHERE id=? AND status='running' AND lease_token=? AND lease_until>?")
        .get(command.id, command.leaseToken, Date.now()) as Row | undefined;
      if (!found) throw new Error('原始资料发布租约已取消或过期。');
      const operation = companionMemorySourceOutboxSchema.shape.operation.parse(found.operation);
      if (command.type === 'memory.sources.outbox.fail') {
        this.db.prepare("UPDATE companion_memory_source_outbox SET status='failed',error=?,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE id=?")
          .run(command.error, Date.now() + (command.retryAfterMs ?? 30000), found.id); return { ok: true };
      }
      const current = operation === 'publish' ? this.resolve(found.companion_id, found.source_id) : undefined;
      const accepted = operation === 'retract' || current?.revision === found.source_revision && current.checksum === found.source_checksum;
      this.db.prepare("UPDATE companion_memory_source_outbox SET status='done',lease_token=NULL,lease_until=NULL,error=NULL WHERE id=?").run(found.id);
      if (!accepted) this.retract(found.companion_id, [found.source_id]);
      return { ok: true, memorySourceOutboxAccepted: accepted };
    }).immediate();
  }
}
