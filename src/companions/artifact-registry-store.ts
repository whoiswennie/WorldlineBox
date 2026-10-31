import type { CompanionConnection } from './store';
import { createHash } from 'node:crypto';
import { companionMemorySchema } from '../shared/companion-memory';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionArtifactPathMatchesKind, companionArtifactSchema, type CompanionArtifact, type CompanionArtifactReference } from '../shared/companion-artifact';
import { companionRegistryPublicationSchema, type CompanionRegistryPublication, type CompanionRegistryStorageCommand, type CompanionFilePublicationGuard } from '../shared/companion-registry-storage';
import { CompanionPublicationReservations } from './artifact-publication-reservations';

type Row = { metadata: string };
const decodeArtifact = (row: Row | undefined): CompanionArtifact | undefined => row && companionArtifactSchema.parse(JSON.parse(row.metadata));
const pending = "('prepared','validated','file_published')";
/** SQLite holds typed identities, versions, permissions and outbox receipts;
 * canonical body bytes never enter these tables. Every query is indexed or paged. */
export class CompanionArtifactRegistryStore {
  private readonly reservations: CompanionPublicationReservations;
  constructor(private readonly db: CompanionConnection, private readonly options: { fileJobValid?(guard: CompanionFilePublicationGuard): boolean } = {}) {
    this.reservations = new CompanionPublicationReservations(db, (owner, reference) => decodeArtifact(this.db.prepare(
      'SELECT metadata FROM companion_artifact_versions WHERE owner_id=? AND artifact_id=? AND revision=? AND content_hash=?')
      .get(owner, reference.artifactId, reference.contentRevision, reference.contentHash) as Row | undefined), (owner, id) => this.read(owner, id));
  }
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_artifacts(
      owner_id TEXT NOT NULL,artifact_id TEXT NOT NULL,kind TEXT NOT NULL,relative_path TEXT NOT NULL,path_key TEXT NOT NULL,
      state TEXT NOT NULL,revision INTEGER NOT NULL,content_hash TEXT NOT NULL,metadata TEXT NOT NULL,body_removed_at TEXT,
      PRIMARY KEY(owner_id,artifact_id),UNIQUE(owner_id,path_key));
      CREATE INDEX IF NOT EXISTS companion_artifact_kind ON companion_artifacts(owner_id,kind,state,artifact_id);
      CREATE INDEX IF NOT EXISTS companion_artifact_producer ON companion_artifacts(owner_id,json_extract(metadata,'$.producer.id'),state,artifact_id);
      CREATE INDEX IF NOT EXISTS companion_artifact_recent ON companion_artifacts(owner_id,state,json_extract(metadata,'$.committedAt') DESC,artifact_id DESC);
      CREATE INDEX IF NOT EXISTS companion_artifact_kind_recent ON companion_artifacts(owner_id,kind,state,json_extract(metadata,'$.committedAt') DESC,artifact_id DESC);
      CREATE INDEX IF NOT EXISTS companion_artifact_body_cleanup ON companion_artifacts(owner_id,state,kind,body_removed_at,artifact_id);
      CREATE TABLE IF NOT EXISTS companion_artifact_versions(owner_id TEXT NOT NULL,artifact_id TEXT NOT NULL,revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(owner_id,artifact_id,revision));
      CREATE TABLE IF NOT EXISTS companion_artifact_edges(owner_id TEXT NOT NULL,target_id TEXT NOT NULL,source_id TEXT NOT NULL,
        PRIMARY KEY(owner_id,target_id,source_id));
      CREATE INDEX IF NOT EXISTS companion_artifact_reverse_edges ON companion_artifact_edges(owner_id,source_id,target_id);
      CREATE TABLE IF NOT EXISTS companion_artifact_publications(owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL,
        request_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner_id,operation_id));
      CREATE INDEX IF NOT EXISTS companion_artifact_pending ON companion_artifact_publications(owner_id,state,operation_id);
      CREATE INDEX IF NOT EXISTS companion_artifact_uncleaned ON companion_artifact_publications(owner_id,state,operation_id)
        WHERE json_extract(data,'$.stagesCleanedAt') IS NULL;
      CREATE TABLE IF NOT EXISTS companion_artifact_publication_edges(owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,
        PRIMARY KEY(owner_id,operation_id,source_id,source_revision));
      CREATE INDEX IF NOT EXISTS companion_artifact_publication_sources ON companion_artifact_publication_edges(owner_id,source_id,source_revision,operation_id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_artifact_publication_producers(owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,producer_id TEXT NOT NULL,
      PRIMARY KEY(owner_id,operation_id,producer_id));
      CREATE INDEX IF NOT EXISTS companion_artifact_publication_producer_lookup ON companion_artifact_publication_producers(owner_id,producer_id,operation_id);`);
    this.reservations.initialize();
  }
  private owner(owner: string): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(owner)) throw new Error('认知登记所属伙伴不存在或已删除。');
  }
  private read(owner: string, id: string): CompanionArtifact | undefined {
    return decodeArtifact(this.db.prepare('SELECT metadata FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get(owner, id) as Row | undefined);
  }
  private publication(owner: string, operation: string): CompanionRegistryPublication | undefined {
    const found = this.db.prepare('SELECT data FROM companion_artifact_publications WHERE owner_id=? AND operation_id=?').get(owner, operation) as { data: string } | undefined;
    return found && companionRegistryPublicationSchema.parse(JSON.parse(found.data));
  }
  private save(publication: CompanionRegistryPublication): void {
    this.db.prepare(`INSERT INTO companion_artifact_publications(owner_id,operation_id,state,request_hash,data) VALUES(?,?,?,?,?)
      ON CONFLICT(owner_id,operation_id) DO UPDATE SET state=excluded.state,data=excluded.data`)
      .run(publication.ownerId, publication.operationId, publication.state, publication.requestHash, JSON.stringify(publication));
    if (!['prepared', 'validated', 'file_published'].includes(publication.state)) this.reservations.release(publication.ownerId, publication.operationId);
  }
  private reference(owner: string, reference: CompanionArtifactReference, next: CompanionArtifact[] = []): CompanionArtifact | undefined {
    const prepared = next.find(artifact => artifact.artifactId === reference.artifactId && artifact.contentRevision === reference.contentRevision && artifact.contentHash === reference.contentHash);
    if (prepared) return prepared;
    const current = this.read(owner, reference.artifactId);
    if (!current || current.publicationState !== 'committed') return;
    return decodeArtifact(this.db.prepare('SELECT metadata FROM companion_artifact_versions WHERE owner_id=? AND artifact_id=? AND revision=? AND content_hash=?')
      .get(owner, reference.artifactId, reference.contentRevision, reference.contentHash) as Row | undefined);
  }
  private memoryPublicationRevision(owner: string, artifact: CompanionArtifact, currentAttempt = false): number | undefined {
    const noteId = artifact.artifactId.startsWith('memory:') ? artifact.artifactId.slice('memory:'.length) : '';
    const ordinary = /^memory:([a-zA-Z0-9_-]+):r([1-9][0-9]*):([a-f0-9]{16})$/u.exec(artifact.operationId);
    if (ordinary) return ordinary[1] === noteId && ordinary[3] === artifact.contentHash.slice(0, 16) && Number.isSafeInteger(Number(ordinary[2])) ? Number(ordinary[2]) : undefined;
    const cycle = /^memory-file:([a-zA-Z0-9_-]{1,100}):cycle:(0|[1-9][0-9]*)$/u.exec(artifact.operationId);
    if (!cycle || !Number.isSafeInteger(Number(cycle[2]))) return;
    const job = this.db.prepare(`SELECT id,companion_id,note_id,content_revision,retry_cycle,status,lease_token,lease_until
      FROM companion_memory_history_outbox WHERE id=? AND companion_id=? AND operation='publish'`).get(cycle[1], owner) as
      { id: string; companion_id: string; note_id: string; content_revision: number; retry_cycle: number; status: string; lease_token: string | null; lease_until: number | null } | undefined;
    if (!job || job.note_id !== noteId || Number(cycle[2]) > job.retry_cycle) return;
    if (currentAttempt) {
      if (Number(cycle[2]) !== job.retry_cycle || job.status !== 'running' || !job.lease_token || !job.lease_until || job.lease_until <= Date.now()) return;
      const fixed = this.db.prepare(`SELECT document_hash,state FROM companion_memory_history_files WHERE companion_id=? AND note_id=? AND content_revision=?`)
        .get(owner, noteId, job.content_revision) as { document_hash: string; state: string } | undefined;
      const history = this.read(owner, `history:${noteId}:r${job.content_revision}`);
      const publishedCycle = history && /^history-file:([a-zA-Z0-9_-]{1,100}):cycle:(0|[1-9][0-9]*)$/u.exec(history.operationId);
      if (!fixed || fixed.state === 'retracted' || !history || history.kind !== 'revision_history' || history.publicationState !== 'committed'
        || history.contentHash !== fixed.document_hash || !publishedCycle || publishedCycle[1] !== job.id || Number(publishedCycle[2]) > job.retry_cycle) return;
    }
    return job.content_revision;
  }
  /** Producer capability is transported per RPC, not saved in the stable
   * content package. A fresh same-cycle claim may finish that exact package,
   * while an old token cannot borrow the new worker's authority. */
  private fileJob(publication: CompanionRegistryPublication, guard: CompanionFilePublicationGuard | undefined, cancel = false): void {
    const match = /^(source|history|memory)-file:([a-zA-Z0-9_-]{1,100}):cycle:(0|[1-9][0-9]*)$/u.exec(publication.operationId);
    if (!match) {
      if (guard || /^(?:source|history|memory)-file:/u.test(publication.operationId)) throw new Error('文件作业发布身份无效。');
      return;
    }
    const family = match[1]!, id = match[2]!, cycle = Number(match[3]), kind = family === 'source' ? 'source_files' : 'history_files';
    if (!Number.isSafeInteger(cycle) || publication.items.length !== 1) throw new Error('文件作业发布必须绑定一个固定对象和准确周期。');
    const table = family === 'source' ? 'companion_memory_source_outbox' : 'companion_memory_history_outbox';
    const job = this.db.prepare(`SELECT * FROM ${table} WHERE companion_id=? AND id=? AND operation='publish'`).get(publication.ownerId, id) as
      { id: string; companion_id: string; status: string; retry_cycle: number; lease_token: string | null; lease_until: number | null;
        source_id?: string; source_revision?: number; source_checksum?: string; note_id?: string; content_revision?: number } | undefined;
    if (!job || cycle > job.retry_cycle) throw new Error('文件发布作业或周期不存在。');
    const artifact = publication.items[0]!.next;
    if (family === 'source') {
      if (artifact.kind !== 'source_evidence' || artifact.producer.kind !== 'host' || artifact.producer.id !== 'source-outbox'
        || artifact.artifactId !== `source:${job.source_id}:r${job.source_revision}` || artifact.contentHash !== job.source_checksum
        || artifact.relativePath !== `证据/来源/${job.source_id}-r${job.source_revision}-${job.source_checksum?.slice(0, 20)}.md`)
        throw new Error('来源文件发布与原作业固定身份不符。');
    } else {
      const fixed = this.db.prepare('SELECT document_hash,relative_path FROM companion_memory_history_files WHERE companion_id=? AND note_id=? AND content_revision=?')
        .get(publication.ownerId, job.note_id, job.content_revision) as { document_hash: string; relative_path: string } | undefined;
      if (!fixed || family === 'history' && (artifact.kind !== 'revision_history' || artifact.producer.kind !== 'host' || artifact.producer.id !== 'history-outbox'
        || artifact.artifactId !== `history:${job.note_id}:r${job.content_revision}` || artifact.contentHash !== fixed.document_hash || artifact.relativePath !== fixed.relative_path)
        || family === 'memory' && (!['episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction'].includes(artifact.kind)
          || artifact.producer.kind !== 'system' || artifact.producer.id !== 'memory-commit' || artifact.artifactId !== `memory:${job.note_id}`))
        throw new Error('历史或当前正文发布与原作业固定身份不符。');
    }
    if (cancel) {
      if (cycle < job.retry_cycle || ['parked', 'abandoned', 'stale', 'cancelled', 'done'].includes(job.status)) return;
      throw new Error('同一周期仍由当前作业处理，迟到取消不能停止新的领取。');
    }
    if (!guard || guard.kind !== kind || guard.id !== id || guard.retryCycle !== cycle || job.retry_cycle !== cycle
      || job.status !== 'running' || job.lease_token !== guard.leaseToken || !job.lease_until || job.lease_until <= Date.now())
      throw new Error('文件发布作业的准确租约或处理周期已变化。');
    let valid = false;
    try { valid = this.options.fileJobValid?.(guard) === true; } catch { /* Fail closed without exposing producer diagnostics or tokens. */ }
    if (!valid) throw new Error('文件发布的实际来源、修订或授权已失效。');
    if (family === 'memory') {
      const saved = this.db.prepare('SELECT data FROM vcp_memory_notes WHERE companion_id=? AND id=?').get(publication.ownerId, job.note_id) as { data: string } | undefined;
      const note = saved && companionMemorySchema.parse(JSON.parse(saved.data));
      if (!note || !['queued', 'indexed'].includes(note.status) || note.archivedAt || note.contentRevision !== job.content_revision
        || note.artifactKind !== artifact.kind || createHash('sha256').update(note.content).digest('hex') !== artifact.contentHash)
        throw new Error('当前正文不再是原文件作业绑定的准确修订。');
    }
  }
  private validate(publication: CompanionRegistryPublication): void {
    const ids = new Set<string>(), paths = new Set<string>(), next = publication.items.map(item => item.next);
    for (const item of publication.items) {
      const artifact = item.next, previous = this.read(publication.ownerId, artifact.artifactId), key = artifact.relativePath.toLocaleLowerCase('en-US');
      if (artifact.ownerId !== publication.ownerId || artifact.operationId !== publication.operationId || artifact.publicationState !== 'committed'
        || !companionArtifactPathMatchesKind(artifact.kind, artifact.relativePath) || ids.has(artifact.artifactId) || paths.has(key)) throw new Error('发布对象归属、类型、用途或路径不合法。');
      if ([...paths].some(value => value.startsWith(key + '/') || key.startsWith(value + '/'))) throw new Error('发布包内的文件路径不能互为父子。');
      ids.add(artifact.artifactId); paths.add(key);
      if (previous ? !item.previous || previous.contentRevision !== item.previous.contentRevision || previous.contentHash !== item.previous.contentHash
        || previous.publicationState !== item.previous.publicationState || previous.kind !== artifact.kind || previous.relativePath !== artifact.relativePath
        || artifact.contentRevision !== previous.contentRevision + 1 : !!item.previous || artifact.contentRevision !== 1)
        throw new Error('对象CAS版本已经变化，拒绝覆盖。');
      if (previous?.publicationState === 'revoked' && !['retraction', 'memory_revalidation'].includes(publication.authorization)) throw new Error('普通发布不能复活已撤回对象。');
      if (item.expectedAbsent && publication.authorization !== 'memory_revalidation') throw new Error('普通发布不能跳过准确旧正文CAS。');
      if (previous?.kind === 'origin_snapshot') throw new Error('创建起点已封存。');
      const occupied = this.db.prepare('SELECT artifact_id FROM companion_artifacts WHERE owner_id=? AND path_key=?').get(publication.ownerId, key) as { artifact_id: string } | undefined;
      if (occupied && occupied.artifact_id !== artifact.artifactId) throw new Error('同一受管路径不能被其它对象冒充。');
      if (publication.authorization === 'creation') {
        if (artifact.producer.kind !== 'creation' || publication.operationId !== `create:${publication.ownerId}`) throw new Error('创建权限只属于唯一创建事务。');
      } else if (artifact.producer.kind === 'creation' || artifact.kind === 'origin_snapshot') throw new Error('创建后不能生成第二个人格起点。');
      if (publication.authorization === 'memory_revalidation') {
        if (!previous || previous.publicationState !== 'revoked' || publication.items.length !== 1 || artifact.producer.kind !== 'system'
          || artifact.producer.id !== 'memory-commit' || !['episode_memory', 'knowledge', 'procedure', 'self_understanding'].includes(artifact.kind)
          || !artifact.artifactId.startsWith('memory:')) throw new Error('重新收录只接受正式记忆生产者和准确退役身份。');
        const noteId = artifact.artifactId.slice('memory:'.length), row = this.db.prepare('SELECT data FROM vcp_memory_notes WHERE companion_id=? AND id=?').get(publication.ownerId, noteId) as { data: string } | undefined;
        const note = row && companionMemorySchema.parse(JSON.parse(row.data));
        const oldRevision = this.memoryPublicationRevision(publication.ownerId, previous), nextRevision = this.memoryPublicationRevision(publication.ownerId, artifact, true);
        if (!note || note.artifactKind !== artifact.kind || note.captureMethod !== 'automatic' || !['queued', 'indexed'].includes(note.status)
          || note.archivedAt || !note.contentRevision || !oldRevision || note.contentRevision <= oldRevision || nextRevision !== note.contentRevision
          || createHash('sha256').update(note.content).digest('hex') !== artifact.contentHash
          || artifact.sourceRefs.length !== note.sources.length || !note.sources.length
          || note.sources.some(source => !artifact.sourceRefs.some(reference => reference.artifactId === `source:${source.messageId}:r${source.revision}` && reference.contentHash === source.checksum)))
          throw new Error('重新收录缺少新捕获版本、当前正文或准确来源授权。');
        if (item.expectedAbsent && !this.db.prepare('SELECT 1 FROM companion_artifacts WHERE owner_id=? AND artifact_id=? AND state=\'revoked\' AND body_removed_at IS NOT NULL').get(publication.ownerId, artifact.artifactId))
          throw new Error('旧正文缺失尚无正式清除凭证，不能重新收录。');
      } else if (publication.authorization === 'retraction') {
        if (!previous || artifact.producer.kind !== 'host' || !(['persona_current', 'role_guidance'].includes(artifact.kind)
          || artifact.kind === 'host_metadata' && artifact.relativePath === 'profile.fragments.json')) throw new Error('撤回修复不能扩大到其它类型。');
      } else if (publication.authorization !== 'creation' && ['persona_current', 'role_guidance'].includes(artifact.kind) && artifact.producer.kind !== 'system')
        throw new Error('人格仅接受系统的有据发布。');
      if (artifact.kind === 'source_evidence' && artifact.producer.kind !== 'host') throw new Error('原始来源只接受宿主生产者。');
      for (const source of artifact.sourceRefs) if (this.reference(publication.ownerId, source, next)?.kind !== 'source_evidence') throw new Error('派生正文不是独立原始来源。');
      for (const reference of [...artifact.sourceRefs, ...artifact.dependencyRefs]) if (!this.reference(publication.ownerId, reference, next)) throw new Error('来源或依赖版本已撤回、变更或未登记。');
      if (artifact.kind === 'role_guidance' && !artifact.dependencyRefs.some(reference => {
        const target = next.find(value => value.artifactId === reference.artifactId) ?? this.read(publication.ownerId, reference.artifactId);
        return target?.kind === 'persona_current' && target.publicationState === 'committed' && target.contentRevision === reference.contentRevision && target.contentHash === reference.contentHash;
      })) throw new Error('角色指导必须绑定同版当前人格。');
    }
  }
  execute(command: CompanionStorageCommand | CompanionRegistryStorageCommand): CompanionStorageResponse | undefined {
    if (!command.type.startsWith('cognition.registry.')) return;
    const input = command as CompanionRegistryStorageCommand; this.owner(input.ownerId);
    if (input.type === 'cognition.registry.read') {
      if (input.artifactIds) return { ok: true, registryArtifacts: (this.db.prepare('SELECT metadata FROM companion_artifacts WHERE owner_id=? AND artifact_id IN('
        + input.artifactIds.map(() => '?').join(',') + ')' + (input.includeRevoked ? '' : " AND state='committed'")).all(input.ownerId, ...input.artifactIds) as Row[]).map(value => decodeArtifact(value)!) };
      if (input.relativePaths) return { ok: true, registryArtifacts: (this.db.prepare('SELECT metadata FROM companion_artifacts WHERE owner_id=? AND path_key IN('
        + input.relativePaths.map(() => '?').join(',') + ')' + (input.includeRevoked ? '' : " AND state='committed'"))
        .all(input.ownerId, ...input.relativePaths.map(relative => relative.toLocaleLowerCase('en-US'))) as Row[]).map(value => decodeArtifact(value)!) };
      const artifact = input.artifactId ? this.read(input.ownerId, input.artifactId)
        : decodeArtifact(this.db.prepare('SELECT metadata FROM companion_artifacts WHERE owner_id=? AND path_key=?')
          .get(input.ownerId, input.relativePath!.toLocaleLowerCase('en-US')) as Row | undefined);
      return { ok: true, ...(artifact && (input.includeRevoked || artifact.publicationState === 'committed') ? { registryArtifact: artifact } : {}) };
    }
    if (input.type === 'cognition.registry.page') {
      const where = ['owner_id=?'], values: Array<string | number> = [input.ownerId];
      if (input.newestFirst && input.afterId) {
        const cursor = this.read(input.ownerId, input.afterId); if (!cursor) throw new Error('登记分页游标已经失效。');
        where.push("(json_extract(metadata,'$.committedAt')<? OR json_extract(metadata,'$.committedAt')=? AND artifact_id<?)");
        values.push(cursor.committedAt, cursor.committedAt, cursor.artifactId);
      } else if (!input.newestFirst) { where.push('artifact_id>?'); values.push(input.afterId ?? ''); }
      if (input.publicationState) { where.push('state=?'); values.push(input.publicationState); }
      else if (!input.includeRevoked) where.push("state='committed'");
      if (input.bodyCleanupRequired) { where.push("state='revoked' AND body_removed_at IS NULL"); }
      if (input.kind) { where.push('kind=?'); values.push(input.kind); }
      if (input.producerId) { where.push("json_extract(metadata,'$.producer.id')=?"); values.push(input.producerId); }
      if (input.consumer) { where.push("EXISTS(SELECT 1 FROM json_each(json_extract(metadata,'$.allowedConsumers')) WHERE value=?)"); values.push(input.consumer); }
      if (input.prefix) { where.push('artifact_id>=? AND artifact_id<?'); values.push(input.prefix, input.prefix + '\uffff'); }
      const order = input.newestFirst ? "json_extract(metadata,'$.committedAt') DESC,artifact_id DESC" : 'artifact_id';
      const limit = input.limit ?? 128, found = this.db.prepare('SELECT metadata FROM companion_artifacts WHERE ' + where.join(' AND ') + ' ORDER BY ' + order + ' LIMIT ?')
        .all(...values, limit + 1) as Row[], artifacts = found.slice(0, limit).map(value => decodeArtifact(value)!);
      return { ok: true, registryPage: { items: artifacts, hasMore: found.length > limit, ...(found.length > limit ? { nextId: artifacts.at(-1)!.artifactId } : {}) } };
    }
    if (input.type === 'cognition.registry.refs.validate') return { ok: true, registryReferencesValid: input.references.every(reference => !!this.reference(input.ownerId, reference)) };
    if (input.type === 'cognition.registry.publication.read') return { ok: true, registryPublication: this.publication(input.ownerId, input.operationId) };
    if (input.type === 'cognition.registry.publication.check') return { ok: true,
      registryPublicationBusy: this.reservations.check(input.ownerId, input.operationId, input.creation, input.targets) };
    if (input.type === 'cognition.registry.publication.pending') {
      const states = input.uncleanedOnly ? "('committed','revoked','cancelled')" : input.includeRevoked ? "('prepared','validated','file_published','revoked')" : pending;
      const extra: string[] = [], parameters: Array<string | number> = [input.ownerId];
      if (input.artifactId) { extra.push('EXISTS(SELECT 1 FROM companion_artifact_publication_edges e WHERE e.owner_id=p.owner_id AND e.operation_id=p.operation_id AND e.source_id=?'
        + (input.baseRevision === undefined ? '' : ' AND e.source_revision=?') + ')'); parameters.push(input.artifactId); if (input.baseRevision !== undefined) parameters.push(input.baseRevision); }
      if (input.previousTarget) {
        if (!input.artifactId) throw new Error('准确旧版本查询需要对象身份。');
        extra.push("EXISTS(SELECT 1 FROM json_each(p.data,'$.items') i WHERE json_extract(i.value,'$.previous.artifactId')=?"
          + (input.baseRevision === undefined ? '' : " AND json_extract(i.value,'$.previous.contentRevision')=?") + ')');
        parameters.push(input.artifactId); if (input.baseRevision !== undefined) parameters.push(input.baseRevision);
      }
      if (input.producerId) { extra.push('EXISTS(SELECT 1 FROM companion_artifact_publication_producers r WHERE r.owner_id=p.owner_id AND r.operation_id=p.operation_id AND r.producer_id=?)'); parameters.push(input.producerId); }
      if (input.operationPrefix) { extra.push('p.operation_id>=? AND p.operation_id<?'); parameters.push(input.operationPrefix, input.operationPrefix + '\uffff'); }
      if (input.afterOperationId) { extra.push('p.operation_id>?'); parameters.push(input.afterOperationId); }
      const suffix = extra.map(condition => 'AND ' + condition).join(' ');
      // Keep the revoked branch on the partial cleanup index. A broad OR over
      // lifetime revoked receipts would still scan every already-cleaned row.
      const query = input.includeRevoked && !input.uncleanedOnly
        ? `SELECT data FROM (SELECT p.operation_id,p.data FROM companion_artifact_publications p WHERE p.owner_id=? AND p.state IN${pending} ${suffix}
          UNION ALL SELECT p.operation_id,p.data FROM companion_artifact_publications p INDEXED BY companion_artifact_uncleaned WHERE p.owner_id=? AND p.state='revoked'
          AND json_extract(p.data,'$.stagesCleanedAt') IS NULL ${suffix}) ORDER BY operation_id LIMIT ?`
        : `SELECT p.data FROM companion_artifact_publications p ${input.uncleanedOnly ? 'INDEXED BY companion_artifact_uncleaned' : ''} WHERE p.owner_id=? AND p.state IN${states}
          ${input.uncleanedOnly ? "AND json_extract(p.data,'$.stagesCleanedAt') IS NULL" : ''} ${suffix} ORDER BY p.operation_id LIMIT ?`;
      return { ok: true, registryPending: (this.db.prepare(query).all(...parameters,
        ...input.includeRevoked && !input.uncleanedOnly ? parameters : [], input.limit ?? 8) as Array<{ data: string }>)
        .map(value => companionRegistryPublicationSchema.parse(JSON.parse(value.data))) };
    }
    return this.db.transaction(() => {
      if (input.type === 'cognition.registry.body-removed') {
        const current = this.read(input.ownerId, input.artifactId);
        if (!current || current.publicationState !== 'revoked' || current.contentRevision !== input.contentRevision || current.contentHash !== input.contentHash)
          throw new Error('正文清理凭证与当前撤回版本不符。');
        this.db.prepare('UPDATE companion_artifacts SET body_removed_at=COALESCE(body_removed_at,?) WHERE owner_id=? AND artifact_id=?')
          .run(new Date().toISOString(), input.ownerId, input.artifactId); return { ok: true, registryBodyRemoved: true };
      }
      if (input.type === 'cognition.registry.publication.stages-cleaned') {
        const publication = this.publication(input.ownerId, input.operationId);
        if (!publication || !['committed', 'revoked', 'cancelled', 'conflict'].includes(publication.state)) throw new Error('只可清理已终结发布的暂存正文。');
        if (publication.state === 'conflict') {
          if (!/^(?:source|history|memory)-file:/u.test(publication.operationId)) throw new Error('冲突暂存清理只属于原文件作业。');
          this.fileJob(publication, undefined, true);
        }
        publication.stagesCleanedAt ??= new Date().toISOString(); this.save(publication); return { ok: true, registryPublication: publication };
      }
      if (input.type === 'cognition.registry.publication.prepare') {
        const publication = companionRegistryPublicationSchema.parse(input.publication);
        if (publication.ownerId !== input.ownerId || publication.state !== 'prepared') throw new Error('发布提议归属或初态无效。');
        this.fileJob(publication, input.fileJobGuard);
        const previous = this.publication(input.ownerId, publication.operationId);
        if (previous) { if (previous.requestHash !== publication.requestHash) throw new Error('幂等操作已绑定不同内容。'); return { ok: true, registryPublication: previous }; }
        const busy = this.reservations.check(input.ownerId, publication.operationId, publication.authorization === 'creation', publication.items.map(item => item.next), publication);
        if (busy) return { ok: true, registryPublicationBusy: busy };
        if (publication.authorization === 'creation' && (this.db.prepare('SELECT 1 FROM companion_artifacts WHERE owner_id=? LIMIT 1').get(input.ownerId)
          || this.db.prepare('SELECT 1 FROM companion_artifact_publications WHERE owner_id=? LIMIT 1').get(input.ownerId))) throw new Error('该伙伴已创建或已经固定创建事务。');
        this.validate(publication); this.save(publication); this.reservations.reserve(publication);
        for (const producer of new Set(publication.items.map(item => item.next.producer.id))) this.db.prepare('INSERT OR IGNORE INTO companion_artifact_publication_producers VALUES(?,?,?)').run(input.ownerId, publication.operationId, producer);
        const references = new Map(publication.items.flatMap(item => [...item.next.sourceRefs, ...item.next.dependencyRefs,
          ...(item.previous ? [{ artifactId: item.previous.artifactId, contentRevision: item.previous.contentRevision }] : [])])
          .map(reference => [`${reference.artifactId}:${reference.contentRevision}`, reference]));
        for (const reference of references.values()) this.db.prepare('INSERT OR IGNORE INTO companion_artifact_publication_edges VALUES(?,?,?,?)')
          .run(input.ownerId, publication.operationId, reference.artifactId, reference.contentRevision);
        return { ok: true, registryPublication: publication };
      }
      if (input.type === 'cognition.registry.revoke') {
        if (!this.read(input.ownerId, input.artifactId)) throw new Error('撤回对象没有登记。');
        const closure = `WITH RECURSIVE affected(id) AS(SELECT ? UNION SELECT e.target_id FROM companion_artifact_edges e JOIN affected a ON e.source_id=a.id WHERE e.owner_id=?) `;
        const parameters = [input.artifactId, input.ownerId, input.ownerId];
        const rows = this.db.prepare(closure + 'SELECT artifact_id FROM companion_artifacts WHERE owner_id=? AND artifact_id IN(SELECT id FROM affected) ORDER BY artifact_id LIMIT 256')
          .all(...parameters) as Array<{ artifact_id: string }>;
        this.db.prepare(closure + "UPDATE companion_artifacts SET state='revoked',metadata=json_set(metadata,'$.publicationState','revoked') WHERE owner_id=? AND artifact_id IN(SELECT id FROM affected)").run(...parameters);
        const count = this.db.prepare(closure + 'SELECT COUNT(*) AS count FROM companion_artifacts WHERE owner_id=? AND artifact_id IN(SELECT id FROM affected)').get(...parameters) as { count: number };
        const operations = this.db.prepare(closure + `SELECT DISTINCT p.data FROM companion_artifact_publications p JOIN companion_artifact_publication_edges e ON e.owner_id=p.owner_id AND e.operation_id=p.operation_id
          WHERE p.owner_id=? AND e.source_id IN(SELECT id FROM affected)`).all(...parameters) as Array<{ data: string }>;
        for (const row of operations) { const publication = companionRegistryPublicationSchema.parse(JSON.parse(row.data));
          if (['prepared', 'validated', 'file_published', 'conflict', 'cancelled'].includes(publication.state)) publication.state = 'revoked';
          publication.reason = '来源已撤回；形成理由正文不再保留。'; this.save(publication); }
        return { ok: true, registryRevocation: { artifactIds: rows.map(value => value.artifact_id), affectedCount: count.count,
          personaRepairRequired: this.read(input.ownerId, 'persona:current')?.publicationState === 'revoked' || operations.some(value => {
            const publication = companionRegistryPublicationSchema.parse(JSON.parse(value.data));
            return ['prepared', 'validated', 'file_published', 'conflict'].includes(publication.state) && publication.items.some(item => item.next.kind === 'persona_current');
          }) } };
      }
      if (input.type === 'cognition.registry.publication.transition' || input.type === 'cognition.registry.publication.commit') {
        const publication = this.publication(input.ownerId, input.operationId); if (!publication) throw new Error('发布凭证不存在。');
        const conflictCleanup = input.type === 'cognition.registry.publication.transition' && publication.state === 'conflict'
          && input.expectedState === 'conflict' && input.nextState === 'conflict';
        if (conflictCleanup && !/^(?:source|history|memory)-file:/u.test(publication.operationId)) throw new Error('冲突暂存清理只属于原文件作业。');
        this.fileJob(publication, input.fileJobGuard, input.type === 'cognition.registry.publication.transition'
          && (input.nextState === 'cancelled' || conflictCleanup));
        if (['prepared', 'validated', 'file_published'].includes(publication.state)
          && !(input.type === 'cognition.registry.publication.transition' && ['cancelled', 'revoked', 'conflict'].includes(input.nextState))) {
          const busy = this.reservations.check(input.ownerId, publication.operationId, publication.authorization === 'creation', publication.items.map(item => item.next), publication);
          if (busy) return { ok: true, registryPublicationBusy: busy };
        }
        if (input.type === 'cognition.registry.publication.transition') {
          if (publication.state === input.nextState) return { ok: true, registryPublication: publication };
          if (publication.state !== input.expectedState || !['prepared', 'validated', 'file_published'].includes(publication.state)
            || input.nextState === 'validated' && publication.state !== 'prepared'
            || input.nextState === 'file_published' && publication.state !== 'validated') throw new Error('发布状态CAS或合法转移条件不满足。');
          publication.state = input.nextState; this.save(publication); return { ok: true, registryPublication: publication };
        }
        if (publication.state === 'committed') return { ok: true, registryPublication: publication };
        if (publication.state !== 'file_published') throw new Error('只有完成文件发布的有效提议可提交。');
        this.validate(publication);
        for (const item of publication.items) {
          const artifact = item.next, metadata = JSON.stringify(artifact);
          this.db.prepare(`INSERT INTO companion_artifacts(owner_id,artifact_id,kind,relative_path,path_key,state,revision,content_hash,metadata) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,artifact_id) DO UPDATE SET kind=excluded.kind,
            relative_path=excluded.relative_path,path_key=excluded.path_key,state=excluded.state,revision=excluded.revision,content_hash=excluded.content_hash,metadata=excluded.metadata,body_removed_at=NULL`)
            .run(input.ownerId, artifact.artifactId, artifact.kind, artifact.relativePath, artifact.relativePath.toLocaleLowerCase('en-US'), 'committed', artifact.contentRevision, artifact.contentHash, metadata);
          this.db.prepare('INSERT INTO companion_artifact_versions VALUES(?,?,?,?,?)').run(input.ownerId, artifact.artifactId, artifact.contentRevision, artifact.contentHash, metadata);
          this.db.prepare('DELETE FROM companion_artifact_edges WHERE owner_id=? AND target_id=?').run(input.ownerId, artifact.artifactId);
          for (const id of new Set([...artifact.sourceRefs, ...artifact.dependencyRefs].map(reference => reference.artifactId)))
            this.db.prepare('INSERT OR IGNORE INTO companion_artifact_edges VALUES(?,?,?)').run(input.ownerId, artifact.artifactId, id);
        }
        publication.state = 'committed'; publication.completedAt = new Date().toISOString(); this.save(publication);
        return { ok: true, registryPublication: publication };
      }
      return undefined;
    }).immediate();
  }
}
