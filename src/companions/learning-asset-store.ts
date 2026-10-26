import { randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionLearningAssetSnapshot, CompanionLearningAssetValidation, CompanionLearningGrant } from '../shared/companion-learning';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';

type Reference = { grant_id: string; asset_id: string; asset_revision: string };
/** A real read is indexed once for both passive reading and goal-driven learning. */
export function registerCompanionLearningAssetSource(db: CompanionConnection, owner: string, grantId: string | undefined,
  assetId: string | undefined, assetRevision: string, sourceMessageId: string): void {
  if (!grantId || !assetId) return;
  db.prepare(`INSERT INTO companion_learning_asset_sources(source_message_id,companion_id,grant_id,asset_id,asset_revision,status)
    VALUES(?,?,?,?,?,'read') ON CONFLICT(source_message_id) DO NOTHING`).run(sourceMessageId, owner, grantId, assetId, assetRevision);
}

/** Canonical asset verification is async in Main; single-use receipts bind its result
 * to a bounded exact read-set. Applying the receipt rechecks current authorization. */
export class CompanionLearningAssetStore {
  private readonly snapshots = new Map<string, { page: CompanionLearningAssetSnapshot; observedRevisions: Array<number | undefined> }>();
  constructor(private readonly db: CompanionConnection, private readonly grant: (id: string) => CompanionLearningGrant,
    private readonly withdraw: (owner: string, ids: string[]) => void) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_learning_asset_sources(source_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      companion_id TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES companion_learning_grants(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL,asset_revision TEXT NOT NULL,status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_learning_asset_authorization ON companion_learning_asset_sources(grant_id,status,asset_id,asset_revision);
      CREATE TABLE IF NOT EXISTS companion_learning_observed_assets(grant_id TEXT NOT NULL REFERENCES companion_learning_grants(id) ON DELETE CASCADE,
        companion_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_revision TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(grant_id,asset_id,asset_revision));`);
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type === 'learning.assets.observe') {
      const grant = this.grant(command.grantId);
      if (!grant.enabled || grant.revision !== command.expectedRevision) throw new Error('实际资料读取的授权已变化。');
      this.db.prepare(`INSERT INTO companion_learning_observed_assets(grant_id,companion_id,asset_id,asset_revision,status) VALUES(?,?,?,?,'read')
        ON CONFLICT(grant_id,asset_id,asset_revision) DO UPDATE SET status='read',revision=revision+1`).run(grant.id, grant.companionId, command.assetId, command.assetRevisionId);
      return { ok: true };
    }
    if (command.type === 'learning.assets.snapshot') {
      const now = Date.now();
      for (const [token, snapshot] of this.snapshots) if (Date.parse(snapshot.page.expiresAt) <= now) this.snapshots.delete(token);
      if (this.snapshots.size >= 256) throw new Error('资产验证作业过多，请稍后重试。');
      let after: [string, string, string] = ['', '', ''];
      if (command.cursor) {
        const parsed: unknown = JSON.parse(Buffer.from(command.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some(value => typeof value !== 'string')) throw new Error('资产验证游标无效。');
        after = parsed as typeof after;
      }
      const rows = this.db.prepare(`SELECT grant_id,asset_id,asset_revision FROM (
        SELECT g.id grant_id,'' asset_id,'' asset_revision FROM companion_learning_grants g WHERE g.enabled=1
          AND (? IS NULL OR g.library_id=?) AND (? IS NULL OR g.companion_id=?)
        UNION SELECT s.grant_id,s.asset_id,s.asset_revision FROM companion_learning_asset_sources s JOIN companion_learning_grants g ON g.id=s.grant_id
          WHERE g.enabled=1 AND s.status='read' AND (? IS NULL OR g.library_id=?) AND (? IS NULL OR g.companion_id=?)
        UNION SELECT s.grant_id,s.asset_id,s.asset_revision FROM companion_learning_observed_assets s JOIN companion_learning_grants g ON g.id=s.grant_id
          WHERE g.enabled=1 AND s.status='read' AND (? IS NULL OR g.library_id=?) AND (? IS NULL OR g.companion_id=?)
        ) WHERE (grant_id,asset_id,asset_revision)>(?,?,?) ORDER BY grant_id,asset_id,asset_revision LIMIT ?`)
        .all(command.libraryId ?? null, command.libraryId ?? null, command.companionId ?? null, command.companionId ?? null,
          command.libraryId ?? null, command.libraryId ?? null, command.companionId ?? null, command.companionId ?? null,
          command.libraryId ?? null, command.libraryId ?? null, command.companionId ?? null, command.companionId ?? null, ...after, (command.limit ?? 64) + 1) as Reference[];
      const selected = rows.slice(0, command.limit ?? 64), last = selected.at(-1);
      const page: CompanionLearningAssetSnapshot = { token: randomUUID(), expiresAt: new Date(now + 60_000).toISOString(),
        entries: selected.map(reference => ({ grant: this.grant(reference.grant_id), ...(reference.asset_id ? { asset: { assetId: reference.asset_id, assetRevisionId: reference.asset_revision } } : {}) })),
        ...(rows.length > (command.limit ?? 64) && last ? { nextCursor: Buffer.from(JSON.stringify([last.grant_id, last.asset_id, last.asset_revision])).toString('base64url') } : {}) };
      const observedRevisions = page.entries.map(entry => entry.asset ? (this.db.prepare('SELECT revision FROM companion_learning_observed_assets WHERE grant_id=? AND asset_id=? AND asset_revision=?')
        .get(entry.grant.id, entry.asset.assetId, entry.asset.assetRevisionId) as { revision: number } | undefined)?.revision : undefined);
      this.snapshots.set(page.token, { page, observedRevisions }); return { ok: true, learningAssetSnapshot: page };
    }
    if (command.type !== 'learning.assets.validate') return;
    const snapshot = this.snapshots.get(command.token), page = snapshot?.page; this.snapshots.delete(command.token);
    if (!page || Date.parse(page.expiresAt) <= Date.now()) throw new Error('资产验证凭证已过期或已使用。');
    if (command.checks.length !== page.entries.length || new Set(command.checks.map(check => check.index)).size !== page.entries.length
      || command.checks.some(check => !page.entries[check.index])) throw new Error('资产验证结果与快照不一致。');
    return this.db.transaction(() => {
      const changed = new Set<string>(), unavailable = new Set<string>(); let revokedSourceCount = 0;
      for (const check of command.checks) {
        const entry = page.entries[check.index]!, current = this.db.prepare('SELECT enabled,revision FROM companion_learning_grants WHERE id=? AND companion_id=?')
          .get(entry.grant.id, entry.grant.companionId) as { enabled: number; revision: number } | undefined;
        if (!current?.enabled) continue;
        if (current.revision !== entry.grant.revision) { unavailable.add(entry.grant.companionId); continue; }
        if (check.state === 'unavailable') { unavailable.add(entry.grant.companionId); continue; }
        if (check.state === 'valid') continue;
        if (entry.asset) {
          const observed = this.db.prepare('SELECT revision FROM companion_learning_observed_assets WHERE grant_id=? AND asset_id=? AND asset_revision=?')
            .get(entry.grant.id, entry.asset.assetId, entry.asset.assetRevisionId) as { revision: number } | undefined;
          if (observed?.revision !== snapshot!.observedRevisions[check.index]) { unavailable.add(entry.grant.companionId); continue; }
        }
        const ids = (entry.asset ? this.db.prepare("SELECT source_message_id FROM companion_learning_asset_sources WHERE grant_id=? AND asset_id=? AND asset_revision=? AND status='read'")
          .all(entry.grant.id, entry.asset.assetId, entry.asset.assetRevisionId)
          : this.db.prepare("SELECT source_message_id FROM companion_learning_asset_sources WHERE grant_id=? AND status='read'").all(entry.grant.id)) as Array<{ source_message_id: string }>;
        if (!entry.asset) this.db.prepare('UPDATE companion_learning_grants SET enabled=0,revision=revision+1,manual=0,lease_token=NULL,lease_until=0 WHERE id=?').run(entry.grant.id);
        else this.db.prepare("UPDATE companion_learning_grants SET lease_token=NULL,lease_until=0,cursor='{}' WHERE id=?").run(entry.grant.id);
        if (entry.asset) this.db.prepare("UPDATE companion_learning_observed_assets SET status='withdrawn' WHERE grant_id=? AND asset_id=? AND asset_revision=? AND status='read'")
          .run(entry.grant.id, entry.asset.assetId, entry.asset.assetRevisionId);
        else this.db.prepare("UPDATE companion_learning_observed_assets SET status='withdrawn' WHERE grant_id=? AND status='read'").run(entry.grant.id);
        for (const source of ids) {
          this.db.prepare("UPDATE companion_learning_asset_sources SET status='withdrawn' WHERE source_message_id=?").run(source.source_message_id);
          this.db.prepare("UPDATE companion_learning_reads SET status='withdrawn' WHERE source_message_id=?").run(source.source_message_id);
        }
        revokedSourceCount += ids.length; changed.add(entry.grant.companionId);
        this.withdraw(entry.grant.companionId, ids.map(source => source.source_message_id));
      }
      const result: CompanionLearningAssetValidation = { changedCompanionIds: [...changed], unavailableCompanionIds: [...unavailable], revokedSourceCount };
      return { ok: true, learningAssetValidation: result };
    }).immediate();
  }
}
