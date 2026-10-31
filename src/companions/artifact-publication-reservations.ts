import type { CompanionConnection } from './store';
import type { CompanionArtifact, CompanionArtifactReference } from '../shared/companion-artifact';
import { companionRegistryPublicationSchema, type CompanionPublicationBusy, type CompanionRegistryPublication } from '../shared/companion-registry-storage';

const active = "('prepared','validated','file_published')";
type Target = Pick<CompanionArtifact, 'artifactId' | 'relativePath' | 'sourceRefs' | 'dependencyRefs'>;
type Entry = { access: 'owner' | 'read' | 'write'; artifactId: string; path: string };
const key = (value: string) => value.toLocaleLowerCase('en-US');

/** A derived metadata index, never body or source authority. Reservations are
 * installed with the durable package and released with its terminal state. */
export class CompanionPublicationReservations {
  constructor(private readonly db: CompanionConnection, private readonly version: (owner: string, reference: CompanionArtifactReference) => CompanionArtifact | undefined,
    private readonly current: (owner: string, id: string) => CompanionArtifact | undefined) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_artifact_publication_reservations(
      owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,access TEXT NOT NULL,artifact_id TEXT NOT NULL,path_key TEXT NOT NULL,
      PRIMARY KEY(owner_id,operation_id,access,artifact_id,path_key));
      CREATE INDEX IF NOT EXISTS companion_publication_reserved_artifact ON companion_artifact_publication_reservations(owner_id,artifact_id,access,operation_id);
      CREATE INDEX IF NOT EXISTS companion_publication_reserved_path ON companion_artifact_publication_reservations(owner_id,path_key,access,operation_id);
      CREATE INDEX IF NOT EXISTS companion_publication_reserved_owner ON companion_artifact_publication_reservations(owner_id,access,operation_id);
      CREATE INDEX IF NOT EXISTS companion_publication_active_recovery ON companion_artifact_publications(owner_id,operation_id)
        WHERE state IN('prepared','validated','file_published');`);
    // Old databases may contain an interrupted package. Rebuild *all* pending
    // footprints before allowing any prepare, paging metadata without bodies.
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM companion_artifact_publication_reservations AS r WHERE NOT EXISTS(SELECT 1 FROM companion_artifact_publications p
        WHERE p.owner_id=r.owner_id AND p.operation_id=r.operation_id AND p.state IN${active})`).run();
      let owner = '', operation = '';
      for (;;) {
        const rows = this.db.prepare(`SELECT owner_id,operation_id,data FROM companion_artifact_publications WHERE state IN${active}
          AND (owner_id>? OR owner_id=? AND operation_id>?) ORDER BY owner_id,operation_id LIMIT 128`).all(owner, owner, operation) as Array<{ owner_id: string; operation_id: string; data: string }>;
        if (!rows.length) break;
        for (const row of rows) { const publication = companionRegistryPublicationSchema.parse(JSON.parse(row.data)); this.reserve(publication); owner = row.owner_id; operation = row.operation_id; }
      }
    }).immediate();
  }
  private entries(owner: string, creation: boolean, targets: Target[], fixed?: CompanionRegistryPublication): Entry[] {
    const entries: Entry[] = [], add = (access: Entry['access'], artifact: Pick<CompanionArtifact, 'artifactId' | 'relativePath'>) =>
      entries.push({ access, artifactId: artifact.artifactId, path: key(artifact.relativePath) });
    if (creation) entries.push({ access: 'owner', artifactId: '', path: '' });
    for (const target of targets) {
      add('write', target);
      const previous = fixed ? fixed.items.find(item => item.next.artifactId === target.artifactId)?.previous : this.current(owner, target.artifactId);
      if (previous) { add('write', previous); add('read', previous); }
      for (const reference of [...target.sourceRefs, ...target.dependencyRefs]) {
        const artifact = fixed?.items.find(item => item.next.artifactId === reference.artifactId && item.next.contentRevision === reference.contentRevision && item.next.contentHash === reference.contentHash)?.next
          ?? this.version(owner, reference)
          // Early precheck only knows proposed paths. The final fixed package
          // must still prove the exact same-batch revision/hash in validate().
          ?? (!fixed ? targets.find(item => item.artifactId === reference.artifactId) : undefined);
        if (!artifact) throw new Error('发布依赖缺少准确已登记版本，不能建立路径预约。');
        add('read', artifact);
      }
    }
    return [...new Map(entries.map(entry => [JSON.stringify(entry), entry])).values()];
  }
  private conflict(owner: string, operation: string, entries: Entry[]): CompanionPublicationBusy | undefined {
    const query = (condition: string, ...values: string[]) => this.db.prepare(`SELECT r.operation_id FROM companion_artifact_publication_reservations r
      JOIN companion_artifact_publications p ON p.owner_id=r.owner_id AND p.operation_id=r.operation_id
      WHERE r.owner_id=? AND r.operation_id<>? AND p.state IN${active} AND (${condition}) ORDER BY r.operation_id LIMIT 1`).get(owner, operation, ...values) as { operation_id: string } | undefined;
    const busy = (row: { operation_id: string } | undefined, reason: CompanionPublicationBusy['reason']) => row && ({ ownerId: owner, operationId: operation, blockingOperationId: row.operation_id, reason });
    const seal = query("r.access='owner'"); if (seal) return busy(seal, 'creation');
    if (entries.some(entry => entry.access === 'owner')) {
      const row = query('1=1'); if (row) return busy(row, 'creation');
    }
    for (const entry of entries) {
      if (entry.access === 'owner') continue;
      const access = entry.access === 'read' ? "r.access='write'" : "r.access IN('read','write')";
      const artifact = query(`${access} AND r.artifact_id=?`, entry.artifactId); if (artifact) return busy(artifact, 'artifact');
      if (!entry.path) continue;
      const parts = entry.path.split('/'), ancestors = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
      const sameOrAncestor = query(`${access} AND r.path_key IN(${ancestors.map(() => '?').join(',')})`, ...ancestors);
      if (sameOrAncestor) return busy(sameOrAncestor, 'path');
      // '/' sorts immediately before '0': this exact range finds descendants
      // without LIKE wildcards or a shared-directory owner-wide lock.
      const descendant = query(`${access} AND r.path_key>=? AND r.path_key<?`, entry.path + '/', entry.path + '0');
      if (descendant) return busy(descendant, 'path');
    }
    return;
  }
  check(owner: string, operation: string, creation: boolean, targets: Target[], fixed?: CompanionRegistryPublication): CompanionPublicationBusy | undefined {
    return this.conflict(owner, operation, this.entries(owner, creation, targets, fixed));
  }
  reserve(publication: CompanionRegistryPublication): void {
    this.release(publication.ownerId, publication.operationId);
    const insert = this.db.prepare('INSERT INTO companion_artifact_publication_reservations VALUES(?,?,?,?,?)');
    for (const entry of this.entries(publication.ownerId, publication.authorization === 'creation', publication.items.map(item => item.next), publication))
      insert.run(publication.ownerId, publication.operationId, entry.access, entry.artifactId, entry.path);
  }
  release(owner: string, operation: string): void { this.db.prepare('DELETE FROM companion_artifact_publication_reservations WHERE owner_id=? AND operation_id=?').run(owner, operation); }
}
