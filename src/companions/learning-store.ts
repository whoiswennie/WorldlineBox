import { createHash, randomUUID } from 'node:crypto';
import type { CompanionLearningGrant, CompanionLearningJob, CompanionLearningRead, CompanionLearningStatus } from '../shared/companion-learning';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionConnection } from './store';

type GrantRow = { id: string; companion_id: string; data: string; enabled: number; autonomous: number; revision: number; lease_token: string | null; lease_until: number; next_at: number; cursor: string; manual: number };
type Cursor = { afterAssetId?: string; assetId?: string; assetRevisionId?: string; offset?: number };
const now = () => new Date().toISOString(), hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface CompanionLearningStoreOptions {
  record(grant: CompanionLearningGrant, receipt: Omit<CompanionLearningRead, 'sourceMessageId'>, content: string): string;
  capture(owner: string, sourceMessageId: string): void;
  withdraw(owner: string, sourceMessageIds: string[]): void;
}
/** Explicit read grants and durable delivery. A file is not knowledge until a real read receipt is captured. */
export class CompanionLearningStore {
  constructor(private readonly db: CompanionConnection, private readonly options: CompanionLearningStoreOptions) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_learning_grants(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,library_id TEXT NOT NULL,folder_id TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL,autonomous INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,next_at INTEGER NOT NULL DEFAULT 0,manual INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,cursor TEXT NOT NULL DEFAULT '{}');
      CREATE UNIQUE INDEX IF NOT EXISTS companion_learning_active_grant ON companion_learning_grants(companion_id,library_id,folder_id) WHERE enabled=1;
      CREATE INDEX IF NOT EXISTS companion_learning_due ON companion_learning_grants(enabled,next_at);
      CREATE TABLE IF NOT EXISTS companion_learning_reads(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES companion_learning_grants(id),asset_id TEXT NOT NULL,asset_revision TEXT NOT NULL,offset INTEGER NOT NULL,source_message_id TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,UNIQUE(grant_id,asset_id,asset_revision,offset));
      CREATE INDEX IF NOT EXISTS companion_learning_read_owner ON companion_learning_reads(companion_id,grant_id);
      CREATE INDEX IF NOT EXISTS companion_learning_read_source ON companion_learning_reads(source_message_id);
    `);
    // This database has one owned utility process. Its previous leases cannot
    // still be running after a restart; retain the cursor but resume promptly.
    this.db.prepare(`UPDATE companion_learning_grants SET lease_token=NULL,lease_until=0,next_at=0,
      data=json_set(data,'$.status','idle') WHERE lease_token IS NOT NULL`).run();
  }
  private load(id: string): GrantRow {
    const found = this.db.prepare('SELECT * FROM companion_learning_grants WHERE id=?').get(id) as GrantRow | undefined;
    if (!found) throw new Error('学习来源不存在。'); return found;
  }
  private grant(row: GrantRow): CompanionLearningGrant {
    const value = JSON.parse(row.data) as CompanionLearningGrant;
    return { ...value, enabled: !!row.enabled, autonomous: !!row.autonomous, revision: row.revision,
      status: row.lease_token && row.lease_until > Date.now() ? 'reading' : value.status,
      nextAt: new Date(row.next_at).toISOString(), reads: Number((this.db.prepare('SELECT COUNT(*) AS n FROM companion_learning_reads WHERE grant_id=? AND status=\'read\'').get(row.id) as { n: number }).n) };
  }
  private status(owner: string): CompanionLearningStatus {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(owner)) throw new Error('伙伴不存在。');
    return { grants: (this.db.prepare('SELECT * FROM companion_learning_grants WHERE companion_id=? AND enabled=1 ORDER BY rowid').all(owner) as GrantRow[]).map(row => this.grant(row)),
      reads: (this.db.prepare('SELECT data,status FROM companion_learning_reads WHERE companion_id=? ORDER BY rowid DESC LIMIT 30').all(owner) as Array<{ data: string; status: 'read' | 'withdrawn' }>).map(row => ({ ...JSON.parse(row.data) as CompanionLearningRead, status: row.status })) };
  }
  private expected(owner: string, id: string, revision: number): GrantRow {
    const row = this.load(id); if (row.companion_id !== owner || !row.enabled || row.revision !== revision) throw new Error('学习来源或权限已变化，请重新读取。'); return row;
  }
  private leased(id: string, token: string): GrantRow {
    const row = this.load(id);
    if (!row.enabled || row.lease_token !== token || row.lease_until <= Date.now()
      || !this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND COALESCE(json_extract(data,'$.active'),1)=1").get(row.companion_id)
      || this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(row.companion_id)) throw new Error('学习作业已取消、过期或权限已改变。');
    return row;
  }
  private release(row: GrantRow, cursor: Cursor, more: boolean, error?: string): void {
    const value = JSON.parse(row.data) as CompanionLearningGrant;
    value.status = error ? 'waiting' : 'idle'; value.updatedAt = now(); value.error = error;
    const next = more ? Date.now() + 1000 : Date.now() + value.intervalMinutes * 60000;
    this.db.prepare('UPDATE companion_learning_grants SET data=?,cursor=?,next_at=?,manual=?,lease_token=NULL,lease_until=0 WHERE id=?')
      .run(JSON.stringify(value), JSON.stringify(more ? cursor : {}), next, row.manual && more ? 1 : 0, row.id);
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'learning.status': return { ok: true, learning: this.status(command.companionId) };
      case 'learning.grant': return this.db.transaction(() => {
        this.status(command.companionId);
        const existing = this.db.prepare('SELECT id FROM companion_learning_grants WHERE companion_id=? AND library_id=? AND folder_id=? AND enabled=1').get(command.companionId, command.libraryId, command.folderId ?? '');
        if (existing) throw new Error('此伙伴已获准学习这个来源。');
        const grant: CompanionLearningGrant = { ...command, id: randomUUID(), enabled: true, revision: 1, createdAt: now(), updatedAt: now(), status: 'idle', reads: 0 };
        this.db.prepare('INSERT INTO companion_learning_grants(id,companion_id,library_id,folder_id,enabled,autonomous,revision,data) VALUES(?,?,?,?,1,?,1,?)')
          .run(grant.id, grant.companionId, grant.libraryId, grant.folderId ?? '', grant.autonomous ? 1 : 0, JSON.stringify(grant));
        return { ok: true, learning: this.status(command.companionId) };
      }).immediate();
      case 'learning.update': return this.db.transaction(() => {
        const row = this.expected(command.companionId, command.id, command.expectedRevision), value = this.grant(row);
        value.autonomous = command.autonomous; value.intervalMinutes = command.intervalMinutes; value.updatedAt = now(); value.status = 'idle'; delete value.error;
        this.db.prepare('UPDATE companion_learning_grants SET autonomous=?,revision=revision+1,data=?,lease_token=NULL,lease_until=0 WHERE id=?')
          .run(command.autonomous ? 1 : 0, JSON.stringify(value), row.id);
        return { ok: true, learning: this.status(command.companionId) };
      }).immediate();
      case 'learning.revoke': return this.db.transaction(() => {
        const row = this.expected(command.companionId, command.id, command.expectedRevision);
        const sourceIds = (this.db.prepare("SELECT source_message_id FROM companion_learning_reads WHERE grant_id=? AND status='read' UNION SELECT source_message_id FROM companion_learning_goal_sources WHERE grant_id=?").all(row.id, row.id) as Array<{ source_message_id: string }>).map(row => row.source_message_id);
        this.db.prepare('UPDATE companion_learning_grants SET enabled=0,revision=revision+1,manual=0,lease_token=NULL,lease_until=0 WHERE id=?').run(row.id);
        this.db.prepare("UPDATE companion_learning_reads SET status='withdrawn' WHERE grant_id=?").run(row.id);
        this.options.withdraw(command.companionId, sourceIds);
        return { ok: true, learning: this.status(command.companionId) };
      }).immediate();
      case 'learning.run': {
        const row = this.expected(command.companionId, command.id, command.expectedRevision);
        this.db.prepare('UPDATE companion_learning_grants SET manual=1,next_at=0 WHERE id=?').run(row.id);
        return { ok: true, learning: this.status(command.companionId) };
      }
      case 'learning.claim': return this.db.transaction(() => {
        const found = this.db.prepare(`SELECT g.* FROM companion_learning_grants g JOIN companions c ON c.id=g.companion_id
          WHERE g.enabled=1 AND (g.autonomous=1 OR g.manual=1) AND g.next_at<=? AND g.lease_until<=? AND c.deleted_at IS NULL
          AND COALESCE(json_extract(c.data,'$.active'),1)=1
          AND g.companion_id NOT IN(SELECT value FROM json_each(?))
          AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=g.companion_id AND r.status!='completed')
          AND NOT EXISTS(SELECT 1 FROM companion_learning_grants other WHERE other.companion_id=g.companion_id AND other.lease_until>?)
          ORDER BY g.next_at,g.rowid LIMIT 1`).get(Date.now(), Date.now(), JSON.stringify(command.excludedOwners), Date.now()) as GrantRow | undefined;
        if (!found) return { ok: true };
        const token = randomUUID(); this.db.prepare('UPDATE companion_learning_grants SET lease_token=?,lease_until=? WHERE id=?').run(token, Date.now() + (command.leaseMs ?? 120000), found.id);
        const job: CompanionLearningJob = { id: found.id, leaseToken: token, grant: this.grant(found), offset: 0, ...JSON.parse(found.cursor) as Cursor };
        return { ok: true, learningJob: job };
      }).immediate();
      case 'learning.commit': return this.db.transaction(() => {
        const row = this.leased(command.id, command.leaseToken), grant = this.grant(row);
        const cursor = JSON.parse(row.cursor) as Cursor;
        const expectedOffset = cursor.assetId === command.assetId && cursor.assetRevisionId === command.assetRevisionId ? cursor.offset ?? 0 : 0;
        if (cursor.assetId && cursor.assetId !== command.assetId || command.offset !== expectedOffset
          || command.nextOffset !== undefined && command.nextOffset !== command.offset + command.content.length)
          throw new Error('学习片段顺序已经变化，不能跳过或伪造未读取的内容。');
        const previous = this.db.prepare('SELECT id FROM companion_learning_reads WHERE grant_id=? AND asset_id=? AND asset_revision=? AND offset=?').get(row.id, command.assetId, command.assetRevisionId, command.offset);
        if (!previous) {
          const receipt: Omit<CompanionLearningRead, 'sourceMessageId'> = { id: randomUUID(), companionId: row.companion_id, grantId: row.id, libraryId: grant.libraryId,
            assetId: command.assetId, assetRevisionId: command.assetRevisionId, assetName: command.assetName, offset: command.offset, characters: command.content.length,
            contentHash: hash(command.content), readAt: now(), status: 'read' };
          const sourceMessageId = this.options.record(grant, receipt, command.content);
          this.db.prepare('INSERT INTO companion_learning_reads(id,companion_id,grant_id,asset_id,asset_revision,offset,source_message_id,data,status) VALUES(?,?,?,?,?,?,?,?,\'read\')')
            .run(receipt.id, row.companion_id, row.id, command.assetId, command.assetRevisionId, command.offset, sourceMessageId, JSON.stringify({ ...receipt, sourceMessageId }));
          this.options.capture(row.companion_id, sourceMessageId);
        }
        this.release(row, command.nextOffset !== undefined ? { assetId: command.assetId, assetRevisionId: command.assetRevisionId, offset: command.nextOffset, afterAssetId: command.afterAssetId }
          : { afterAssetId: command.assetId }, command.more || command.nextOffset !== undefined);
        return { ok: true, learning: this.status(row.companion_id) };
      }).immediate();
      case 'learning.advance': {
        const row = this.leased(command.id, command.leaseToken); this.release(row, { afterAssetId: command.afterAssetId }, command.more, command.reason); return { ok: true };
      }
      case 'learning.defer': {
        const row = this.leased(command.id, command.leaseToken), value = this.grant(row); value.status = command.state ?? 'failed'; value.error = command.error;
        this.db.prepare('UPDATE companion_learning_grants SET data=?,next_at=?,lease_token=NULL,lease_until=0 WHERE id=?').run(JSON.stringify(value), Date.now() + (command.retryAfterMs ?? 30000), row.id); return { ok: true };
      }
    }
  }
}
