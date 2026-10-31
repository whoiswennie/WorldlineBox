import type { CompanionConnection } from './store';
import type { CompanionJobControlAdapter } from './job-control-store';
import { companionJobInputVersion, pageCompanionJobIds } from './job-control-store';
import { COMPANION_JOB_FAILURES_PER_CYCLE, type CompanionJobDisposition, type CompanionJobFailureKind } from '../shared/companion-job-control';

type Job = { grant_id: string; companion_id: string; asset_id: string; asset_revision: string; status: string;
  access_epoch: number;
  job_id: string; job_status: CompanionJobDisposition['state']; job_offset: number; job_byte_revision?: string; job_attempts: number;
  failure_count: number; cycle_failure_count: number; disposition_revision: number; last_failure_error?: string; last_failure_at?: string; job_next_at: number };

/** Processing metadata on the actual observed material/version row. The
 * original permission status and real read receipts keep their own meaning. */
export class CompanionLearningAssetJobs {
  constructor(private readonly db: CompanionConnection) {}
  initialize(): void {
    const existing = new Set((this.db.prepare('PRAGMA table_info(companion_learning_observed_assets)').all() as Array<{ name: string }>).map(row => row.name));
    for (const [name, type] of [['access_epoch', 'INTEGER NOT NULL DEFAULT 0'], ['job_id', 'TEXT'], ['job_status', 'TEXT'], ['job_offset', 'INTEGER NOT NULL DEFAULT 0'], ['job_byte_revision', 'TEXT'],
      ['job_attempts', 'INTEGER NOT NULL DEFAULT 0'], ['failure_count', 'INTEGER NOT NULL DEFAULT 0'], ['cycle_failure_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['disposition_revision', 'INTEGER NOT NULL DEFAULT 0'], ['last_failure_error', 'TEXT'], ['last_failure_at', 'TEXT'], ['job_next_at', 'INTEGER NOT NULL DEFAULT 0'], ['retry_requested', 'INTEGER NOT NULL DEFAULT 0']] as const)
      if (!existing.has(name)) this.db.exec(`ALTER TABLE companion_learning_observed_assets ADD COLUMN ${name} ${type}`);
    const grants = new Set((this.db.prepare('PRAGMA table_info(companion_learning_grants)').all() as Array<{ name: string }>).map(row => row.name));
    if (!grants.has('active_job_id')) this.db.exec('ALTER TABLE companion_learning_grants ADD COLUMN active_job_id TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_learning_asset_job_history(job_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,companion_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,asset_revision TEXT NOT NULL,status TEXT NOT NULL,access_epoch INTEGER NOT NULL,job_status TEXT NOT NULL,
      job_offset INTEGER NOT NULL,job_byte_revision TEXT,job_attempts INTEGER NOT NULL,failure_count INTEGER NOT NULL,cycle_failure_count INTEGER NOT NULL,
      disposition_revision INTEGER NOT NULL,job_next_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_learning_asset_history_page ON companion_learning_asset_job_history(companion_id,job_id);
      CREATE INDEX IF NOT EXISTS companion_learning_asset_history_state_page ON companion_learning_asset_job_history(companion_id,job_status,job_id);`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS companion_learning_asset_job_id ON companion_learning_observed_assets(job_id) WHERE job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS companion_learning_asset_job_page ON companion_learning_observed_assets(companion_id,job_id);
      CREATE INDEX IF NOT EXISTS companion_learning_asset_job_state_page ON companion_learning_observed_assets(companion_id,job_status,job_id);
      DROP INDEX IF EXISTS companion_learning_asset_normalized_state_page;
      CREATE INDEX companion_learning_asset_normalized_state_page ON companion_learning_observed_assets(companion_id,(CASE WHEN job_status IN('parked','abandoned') THEN job_status WHEN status='withdrawn' THEN 'stale' ELSE job_status END),job_id);
      CREATE INDEX IF NOT EXISTS companion_learning_asset_job_retry ON companion_learning_observed_assets(grant_id,retry_requested,job_next_at,job_id);
      CREATE TRIGGER IF NOT EXISTS companion_learning_asset_job_revision AFTER UPDATE OF job_status,failure_count,cycle_failure_count,job_byte_revision ON companion_learning_observed_assets
        WHEN OLD.job_status IS NOT NEW.job_status OR OLD.failure_count IS NOT NEW.failure_count OR OLD.cycle_failure_count IS NOT NEW.cycle_failure_count OR OLD.job_byte_revision IS NOT NEW.job_byte_revision
        BEGIN UPDATE companion_learning_observed_assets SET disposition_revision=OLD.disposition_revision+1 WHERE grant_id=NEW.grant_id AND asset_id=NEW.asset_id AND asset_revision=NEW.asset_revision; END;`);
  }
  private load(id: string): Job | undefined {
    return (this.db.prepare('SELECT * FROM companion_learning_observed_assets WHERE job_id=?').get(id)
      ?? this.db.prepare('SELECT * FROM companion_learning_asset_job_history WHERE job_id=?').get(id)) as Job | undefined;
  }
  private view(row: Job): CompanionJobDisposition {
    return { ownerId: row.companion_id, kind: 'learning', id: row.job_id, processorId: row.grant_id,
      inputVersion: companionJobInputVersion([row.companion_id, row.grant_id, row.asset_id, row.asset_revision, row.job_byte_revision ?? null, row.access_epoch]), revision: row.disposition_revision,
      state: ['parked', 'abandoned'].includes(row.job_status) ? row.job_status : row.status === 'withdrawn' ? 'stale' : row.job_status,
      failureCount: row.failure_count, cycleFailureCount: row.cycle_failure_count, attemptCount: row.job_attempts,
      assetId: row.asset_id, assetRevisionId: row.job_byte_revision ?? row.asset_revision, offset: row.job_offset,
      ...(row.last_failure_error ? { lastError: row.last_failure_error.slice(0, 1000) } : {}), ...(row.last_failure_at ? { lastErrorAt: row.last_failure_at } : {}) };
  }
  active(grantId: string): Job | undefined {
    return this.db.prepare('SELECT j.* FROM companion_learning_grants g JOIN companion_learning_observed_assets j ON j.job_id=g.active_job_id WHERE g.id=?').get(grantId) as Job | undefined;
  }
  begin(input: { ownerId: string; grantId: string; assetId: string; assetRevisionId: string; offset: number }): CompanionJobDisposition {
    let existing = this.db.prepare('SELECT * FROM companion_learning_observed_assets WHERE grant_id=? AND companion_id=? AND asset_id=? AND asset_revision=?')
      .get(input.grantId, input.ownerId, input.assetId, input.assetRevisionId) as Job | undefined;
    if (existing?.job_id && (existing.status === 'withdrawn' || existing.job_status === 'stale')) {
      if (['parked', 'abandoned'].includes(existing.job_status)) {
        // Fresh host authorization makes the file readable again, never a
        // new automatic processing cycle for a deliberately held input.
        this.db.prepare("UPDATE companion_learning_observed_assets SET status='job_input' WHERE job_id=?").run(existing.job_id);
        return this.view(this.load(existing.job_id)!);
      }
      if (input.offset !== 0) throw new Error('资料重新获权后必须从首片段建立新的真实读取，不能续用已撤回片段。');
      this.db.prepare(`INSERT OR IGNORE INTO companion_learning_asset_job_history(job_id,grant_id,companion_id,asset_id,asset_revision,status,access_epoch,job_status,
        job_offset,job_byte_revision,job_attempts,failure_count,cycle_failure_count,disposition_revision,job_next_at)
        VALUES(?,?,?,?,?,'withdrawn',?,'stale',?,?,?,?,?,?,?)`)
        .run(existing.job_id, existing.grant_id, existing.companion_id, existing.asset_id, existing.asset_revision, existing.access_epoch,
          existing.job_offset, existing.job_byte_revision ?? null, existing.job_attempts, existing.failure_count, existing.cycle_failure_count, existing.disposition_revision, existing.job_next_at);
      const epoch = existing.access_epoch + 1, nextId = companionJobInputVersion(['learning-asset', input.ownerId, input.grantId, input.assetId, input.assetRevisionId, epoch]);
      this.db.prepare(`UPDATE companion_learning_observed_assets SET status='job_input',access_epoch=?,job_id=?,job_status='pending',job_offset=0,job_byte_revision=NULL,
        job_attempts=0,failure_count=0,cycle_failure_count=0,disposition_revision=0,last_failure_error=NULL,last_failure_at=NULL,job_next_at=0,retry_requested=0
        WHERE grant_id=? AND companion_id=? AND asset_id=? AND asset_revision=?`)
        .run(epoch, nextId, input.grantId, input.ownerId, input.assetId, input.assetRevisionId);
      existing = this.load(nextId);
    }
    const id = existing?.job_id ?? companionJobInputVersion(['learning-asset', input.ownerId, input.grantId, input.assetId, input.assetRevisionId, existing?.access_epoch ?? 0]);
    this.db.prepare(`INSERT OR IGNORE INTO companion_learning_observed_assets(grant_id,companion_id,asset_id,asset_revision,status,job_id,job_status)
      VALUES(?,?,?,?,'job_input',?,'pending')`).run(input.grantId, input.ownerId, input.assetId, input.assetRevisionId, id);
    this.db.prepare("UPDATE companion_learning_observed_assets SET job_id=?,job_status='pending' WHERE grant_id=? AND asset_id=? AND asset_revision=? AND job_id IS NULL")
      .run(id, input.grantId, input.assetId, input.assetRevisionId);
    const row = this.load(id); if (!row) throw new Error('资料处理尚未登记。');
    if (row.status === 'withdrawn' || ['parked', 'abandoned', 'completed', 'stale', 'cancelled'].includes(row.job_status)) return this.view(row);
    if (row.job_status === 'running' && this.active(input.grantId)?.job_id === id && row.job_offset === input.offset) return this.view(row);
    this.db.prepare("UPDATE companion_learning_observed_assets SET job_status='running',job_attempts=job_attempts+1,job_offset=?,retry_requested=0 WHERE job_id=?")
      .run(input.offset, id);
    this.db.prepare('UPDATE companion_learning_grants SET active_job_id=? WHERE id=?').run(id, input.grantId);
    return this.view(this.load(id)!);
  }
  /** An explicit resumed material is selected only between completed files,
   * preserving any current partially read file and its exact offset. */
  resumed(grantId: string): { assetId: string; assetRevisionId: string; offset: number; assetJobId: string } | undefined {
    const row = this.db.prepare("SELECT * FROM companion_learning_observed_assets WHERE grant_id=? AND retry_requested=1 AND job_status='pending' AND status!='withdrawn' AND job_next_at<=? ORDER BY job_id LIMIT 1")
      .get(grantId, Date.now()) as Job | undefined;
    return row ? { assetId: row.asset_id, assetRevisionId: row.job_byte_revision ?? row.asset_revision, offset: row.job_offset, assetJobId: row.job_id } : undefined;
  }
  cursorJob(grantId: string, assetId?: string, revision?: string): string | undefined {
    if (!assetId || !revision) return;
    return (this.db.prepare('SELECT job_id FROM companion_learning_observed_assets WHERE grant_id=? AND asset_id=? AND (asset_revision=? OR job_byte_revision=?) AND job_id IS NOT NULL LIMIT 1')
      .get(grantId, assetId, revision, revision) as { job_id: string } | undefined)?.job_id;
  }
  missing(grantId: string, id: string): void {
    this.db.prepare("UPDATE companion_learning_observed_assets SET job_status='stale',retry_requested=0 WHERE grant_id=? AND job_id=? AND job_status NOT IN('completed','abandoned')").run(grantId, id);
  }
  commit(grantId: string, assetId: string, byteRevision: string, nextOffset?: number): void {
    const row = this.active(grantId); if (!row) throw new Error('资料读取缺少当前固定处理作业。');
    if (row.job_status !== 'running' || row.asset_id !== assetId || !byteRevision.startsWith(row.asset_revision + '_') && byteRevision !== row.asset_revision
      || row.job_byte_revision && row.job_byte_revision !== byteRevision) throw new Error('资料固定版本已经变化，旧处理不能提交新字节。');
    this.db.prepare('UPDATE companion_learning_observed_assets SET job_status=?,job_byte_revision=?,job_offset=?,cycle_failure_count=0 WHERE job_id=?')
      .run(nextOffset === undefined ? 'completed' : 'pending', byteRevision, nextOffset ?? row.job_offset, row.job_id);
    this.db.prepare('UPDATE companion_learning_grants SET active_job_id=NULL WHERE id=?').run(grantId);
  }
  settle(grantId: string, kind: CompanionJobFailureKind, error: string, retryAfterMs: number, park = false): Job | undefined {
    const row = this.active(grantId); if (!row || row.job_status !== 'running') return;
    const failure = kind === 'processing', cycle = row.cycle_failure_count + Number(failure);
    const status = kind === 'stale' || kind === 'cancelled' ? kind : park || cycle >= COMPANION_JOB_FAILURES_PER_CYCLE ? 'parked' : kind === 'waiting' ? 'pending' : 'failed';
    this.db.prepare(`UPDATE companion_learning_observed_assets SET job_status=?,failure_count=failure_count+?,cycle_failure_count=?,job_next_at=?,
      last_failure_error=?,last_failure_at=? WHERE job_id=?`).run(status, Number(failure), cycle, Date.now() + retryAfterMs, error.slice(0, 1000), new Date().toISOString(), row.job_id);
    this.db.prepare('UPDATE companion_learning_grants SET active_job_id=NULL WHERE id=?').run(grantId);
    return this.load(row.job_id);
  }
  adapter(): CompanionJobControlAdapter {
    const read = (ownerId: string, id: string) => { const row = this.load(id); return row?.companion_id === ownerId ? this.view(row) : undefined; };
    return { read, page: input => {
      const rows = [...new Set([...pageCompanionJobIds(this.db, 'companion_learning_observed_assets', input),
        ...pageCompanionJobIds(this.db, 'companion_learning_asset_job_history', input)])].sort().slice(0, input.limit + 1).map(job_id => ({ job_id }));
      const page = rows.slice(0, input.limit); return { items: page.map(row => read(input.ownerId, row.job_id)!), hasMore: rows.length > input.limit,
        ...(rows.length > input.limit && page.length ? { nextId: page.at(-1)!.job_id } : {}) };
    }, transition: (current, action) => {
      const row = this.load(current.id); if (!row) throw new Error('资料处理不存在。');
      this.db.prepare('UPDATE companion_learning_observed_assets SET job_status=?,cycle_failure_count=?,retry_requested=?,job_next_at=0,disposition_revision=disposition_revision+1 WHERE job_id=? AND disposition_revision=?')
        .run(action === 'resume' ? 'pending' : action === 'park' ? 'parked' : 'abandoned', action === 'resume' ? 0 : current.cycleFailureCount, Number(action === 'resume'), current.id, current.revision);
      if (action === 'resume') this.db.prepare('UPDATE companion_learning_grants SET manual=1,next_at=0 WHERE id=? AND enabled=1').run(row.grant_id);
      else this.db.prepare(`UPDATE companion_learning_grants SET cursor=?,active_job_id=NULL,lease_token=NULL,lease_until=0,next_at=? WHERE id=? AND active_job_id=?`)
        .run(JSON.stringify({ afterAssetId: row.asset_id }), Date.now() + 1000, row.grant_id, row.job_id);
      return read(current.ownerId, current.id)!;
    } };
  }
}
