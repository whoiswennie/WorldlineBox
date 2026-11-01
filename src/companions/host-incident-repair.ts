import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { companionArtifactPathSchema, companionArtifactSchema } from '../shared/companion-artifact';
import { companionMemorySchema } from '../shared/companion-memory';
import { companionExecutionReadsetSchema } from '../shared/companion-execution-evidence';
import { companionMemoryHistoryPath } from '../shared/companion-memory-history';
import type { CompanionMemory } from '../shared/companions';
import { inspectCompanionFencedMaintenance, openCompanionFencedMaintenance } from './fenced-maintenance';
import { CompanionMemoryLedger } from './memory-ledger';
import { CompanionMemoryStore } from './memory-store';
import type { CompanionConnection } from './store';
import type { CompanionRecoveryHead, CompanionRecoverySelection } from './recovery-fence';

const hash = z.string().regex(/^[a-f0-9]{64}$/u), id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const integer = z.number().int().nonnegative().safe(), revision = z.number().int().positive().safe();
const headSchema = z.strictObject({ lineageId: id, generation: integer });
const fileSchema = z.strictObject({ owner: id, relativePath: companionArtifactPathSchema, sha256: hash, size: integer });
const noteSchema = z.strictObject({ id, owner: id, beforeSHA: hash, historyRevision: revision, historyDocumentSHA: hash,
  annotationsSHA: hash, afterSHA: hash, registryBeforeSHA: hash, registryPublishedSHA: hash });
const archiveSchema = z.strictObject({ id, owner: id, beforeSHA: hash, afterSHA: hash, witnessNote: z.string().max(262144), witnessSHA: hash });
const consolidationSchema = z.strictObject({ key: z.string().regex(/^memory-consolidation\//u).max(256), beforeSHA: hash, afterSHA: hash,
  witnessValue: z.string().max(262144), witnessSHA: hash });

/** This host-only protocol repairs one reviewed shutdown-withdrawal incident.
 * No table names, SQL, replacement prose, arbitrary status or permission fields
 * are accepted. It is deliberately absent from renderer/worker request unions. */
export const companionHostIncidentRepairManifestSchema = z.strictObject({
  schema: z.literal('worldlinebox.host-shutdown-withdrawal-repair-v1'), operationId: id, libraryId: id,
  initialHead: headSchema, repairAt: z.iso.datetime(), beforeStateSHA: hash,
  tombstones: z.array(z.strictObject({ kind: z.enum(['message', 'action']), id, valueSHA: hash })).min(1).max(100),
  notes: z.array(noteSchema).min(1).max(100), archives: z.array(archiveSchema).max(10), consolidations: z.array(consolidationSchema).max(10),
  canonicalFiles: z.array(fileSchema).min(1).max(10000),
  // These are exact, independently saved full Main gate receipts, not a boolean
  // permission port. Approval binds their hashes along with the entire plan.
  validation: z.strictObject({ beforeRepairReceiptSHA: hash, afterRepairReceiptSHA: hash, sourceSnapshotSHA: hash,
    fullMainGate: z.literal('sql+canonical+current-role+action-authority+final'), noCertificateShortcut: z.literal(true) }),
});
export type CompanionHostIncidentRepairManifest = z.infer<typeof companionHostIncidentRepairManifestSchema>;
export const hostIncidentRepairSHA = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sameHead = (a: CompanionRecoveryHead, b: CompanionRecoveryHead) => a.lineageId === b.lineageId && a.generation === b.generation;
const receiptKey = (operation: string) => `host-incident-repair/${operation}`;
const value = <T>(db: CompanionConnection, sql: string, ...bindings: unknown[]) => db.prepare(sql).get(...bindings) as T | undefined;
const exact = (actual: string | undefined, expected: string, what: string) => { if (actual === undefined || hostIncidentRepairSHA(actual) !== expected) throw new Error(`事故修复准确 ${what} 已变化。`); };

/** Includes all domain rows/schema, not just selected repair rows. Recovery
 * generations have their independent authority fence. Only this adapter's own
 * operation receipts are excluded to support exact two-phase crash reentry. */
export function hostIncidentRepairStateSHA(db: CompanionConnection, operationId?: string): string {
  const digest = createHash('sha256');
  digest.update(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()));
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string; sql: string }>;
  for (const table of tables) {
    if (table.name === 'companion_recovery_state') continue;
    const quoted = '"' + table.name.replaceAll('"', '""') + '"';
    const rows = db.prepare(`SELECT * FROM ${quoted}`).all() as Array<Record<string, unknown>>;
    const ordered = rows.filter(row => table.name !== 'metadata' || row.key !== (operationId ? receiptKey(operationId) : undefined))
      .map(row => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).sort();
    digest.update(JSON.stringify([table.name, table.sql, ordered]));
  }
  return digest.digest('hex');
}

/** File authorization is owner-relative, with no symlink/junction traversal or
 * hardlinked body. The caller never treats the installation helper as a path
 * authorization mechanism. Every existing ancestor is checked afresh. */
export function hostIncidentRepairFile(root: string, owner: string, relativePath: string, missingLeaf = false): string {
  id.parse(owner); companionArtifactPathSchema.parse(relativePath);
  const absoluteRoot = path.resolve(root), target = path.join(absoluteRoot, owner, ...relativePath.split('/'));
  if (!target.startsWith(absoluteRoot + path.sep)) throw new Error('事故修复文件越界。');
  for (const part of [absoluteRoot, ...[owner, ...relativePath.split('/')].map((_, index, parts) => path.join(absoluteRoot, ...parts.slice(0, index + 1)))]) {
    let stat;
    try { stat = lstatSync(part); } catch (error) {
      if (missingLeaf && part === target && (error as NodeJS.ErrnoException).code === 'ENOENT') return target;
      throw error;
    }
    if (stat.isSymbolicLink() || path.resolve(realpathSync(part)).toLowerCase() !== part.toLowerCase()
      || part !== target && !stat.isDirectory() || part === target && (!stat.isFile() || stat.nlink !== 1)) throw new Error('事故修复文件包含链接或异常类型。');
  }
  return target;
}

type Prepared = { notes: Array<{ before: string; note: CompanionMemory; dependencies: Array<{ id: string; contentRevision: number }>; artifact: ArtifactRow; originalMetadata: string }>; archives: Array<{ before: string; note: CompanionMemory }>; consolidations: Array<{ key: string; before: string; after: string }> };
type ArtifactRow = { owner_id: string; artifact_id: string; revision: number; content_hash: string; relative_path: string; metadata: string; state: string; body_removed_at: string | null };
const noteData = (db: CompanionConnection, noteId: string) => value<{ data: string }>(db, 'SELECT data FROM vcp_memory_notes WHERE id=?', noteId)?.data;
const artifactRow = (db: CompanionConnection, owner: string, noteId: string) => value<ArtifactRow>(db, 'SELECT * FROM companion_artifacts WHERE owner_id=? AND artifact_id=?', owner, 'memory:' + noteId);

function verifyFiles(db: CompanionConnection, manifest: CompanionHostIncidentRepairManifest, ownersRoot: string, completed = false): void {
  for (const file of manifest.canonicalFiles) {
    const target = hostIncidentRepairFile(ownersRoot, file.owner, file.relativePath), bytes = readFileSync(target);
    if (bytes.length !== file.size) throw new Error('事故修复来源文件大小已变化。');
    if (hostIncidentRepairSHA(bytes) !== file.sha256) throw new Error('事故修复来源文件字节已变化。');
  }
  // Every current committed role/host asset must be in the full-gate file set;
  // optional fixture adapters cannot silently omit the production role fence.
  const roles = db.prepare("SELECT owner_id,artifact_id,relative_path,content_hash FROM companion_artifacts WHERE state='committed' AND kind!='runtime_index'").all() as Array<{ owner_id: string; artifact_id: string; relative_path: string; content_hash: string }>;
  if (roles.some(role => !manifest.canonicalFiles.some(file => file.owner === role.owner_id && file.relativePath === role.relative_path && file.sha256 === role.content_hash)
    && !(completed && manifest.notes.some(note => note.owner === role.owner_id && 'memory:' + note.id === role.artifact_id)))) throw new Error('事故修复材料缺少真实当前人格或宿主资产。');
}
function prepare(db: CompanionConnection, manifest: CompanionHostIncidentRepairManifest, ownersRoot: string): Prepared {
  if (new Set(manifest.notes.map(note => note.id)).size !== manifest.notes.length
    || new Set([...manifest.notes, ...manifest.archives].map(note => note.id)).size !== manifest.notes.length + manifest.archives.length
    || new Set(manifest.tombstones.map(item => `${item.kind}:${item.id}`)).size !== manifest.tombstones.length
    || new Set(manifest.canonicalFiles.map(item => `${item.owner}/${item.relativePath}`)).size !== manifest.canonicalFiles.length) throw new Error('事故修复目标重复。');
  verifyFiles(db, manifest, ownersRoot);
  for (const marker of manifest.tombstones) exact(value<{ value: string }>(db, 'SELECT value FROM metadata WHERE key=?', `execution-source-invalid/${marker.kind}/${marker.id}`)?.value, marker.valueSHA, '撤回标记');
  const notes = manifest.notes.map(entry => {
    const before = noteData(db, entry.id); exact(before, entry.beforeSHA, '记忆 CAS');
    const prior = companionMemorySchema.parse(JSON.parse(before!));
    if (prior.companionId !== entry.owner || prior.status !== 'invalid') throw new Error('事故修复不能恢复正常遗忘或不同伙伴的记忆。');
    const annotationRow = value<{ annotations: string; content_revision: number }>(db, 'SELECT annotations,content_revision FROM companion_memory_version_revisions WHERE note_id=? AND version=?', entry.id, prior.version - 1);
    exact(annotationRow?.annotations, entry.annotationsSHA, '旧版本注解');
    const annotations = JSON.parse(annotationRow!.annotations) as { withdrawn?: boolean; tags: string[]; diaryName?: string; autoTags?: boolean };
    if (annotations.withdrawn || annotationRow!.content_revision !== entry.historyRevision) throw new Error('事故修复缺少准确的未撤回前版本。');
    const history = value<{ document_hash: string; relative_path: string; body_hash: string; dependencies: string; sources: string; state: string }>(db,
      'SELECT * FROM companion_memory_history_files WHERE companion_id=? AND note_id=? AND content_revision=?', entry.owner, entry.id, entry.historyRevision);
    if (!history || history.state !== 'published' || history.document_hash !== entry.historyDocumentSHA
      || history.relative_path !== companionMemoryHistoryPath(entry.id, entry.historyRevision, history.body_hash)) throw new Error('事故修复历史凭据已变化。');
    const document = readFileSync(hostIncidentRepairFile(ownersRoot, entry.owner, history.relative_path), 'utf8'); exact(document, entry.historyDocumentSHA, '历史正文');
    const envelope = /^---\n([^]*?)\n---\n([^]*)$/u.exec(document); if (!envelope) throw new Error('事故修复历史正文封装无效。');
    const header = JSON.parse(envelope[1]!) as { schema: string; id: string; companionId: string; contentRevision: number; bodyHash: string; memory: object; dependencies: Array<{ id: string; contentRevision: number }> };
    if (header.schema !== 'worldlinebox.companion-memory-history-v2' || header.id !== entry.id || header.companionId !== entry.owner || header.contentRevision !== entry.historyRevision
      || header.bodyHash !== history.body_hash || JSON.stringify(header.dependencies) !== history.dependencies) throw new Error('事故修复历史身份与依赖不匹配。');
    const old = companionMemorySchema.parse({ ...header.memory, content: envelope[2]! });
    if (old.version !== prior.version - 1 || old.id !== entry.id || old.companionId !== entry.owner || old.contentRevision !== entry.historyRevision
      || JSON.stringify(old.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum, revision: source.revision }))) !== history.sources) throw new Error('事故修复历史元数据不匹配。');
    const note: CompanionMemory = { ...old, tags: annotations.tags, status: 'queued', version: prior.version + 1, contentRevision: entry.historyRevision,
      annotationRevision: prior.annotationRevision! + 1, semanticRevision: prior.semanticRevision! + 1, updatedAt: manifest.repairAt };
    if (annotations.diaryName === undefined) delete note.diaryName; else note.diaryName = annotations.diaryName;
    if (annotations.autoTags !== undefined) note.metadata = { ...note.metadata, autoTags: annotations.autoTags };
    for (const key of ['archivedAt', 'supersededBy'] as const) {
      if (prior[key] !== undefined) note[key] = prior[key];
      else if (old[key] !== undefined) throw new Error('事故修复不能猜测归档移除。');
    }
    exact(JSON.stringify(note), entry.afterSHA, '恢复后记忆');
    const artifact = artifactRow(db, entry.owner, entry.id); exact(artifact ? JSON.stringify(artifact) : undefined, entry.registryBeforeSHA, '登记 CAS');
    if (!artifact || artifact.state !== 'revoked' || !artifact.body_removed_at || artifact.content_hash !== hostIncidentRepairSHA(note.content)) throw new Error('事故修复当前登记不匹配。');
    const saved = value<{ metadata: string }>(db, 'SELECT metadata FROM companion_artifact_versions WHERE owner_id=? AND artifact_id=? AND revision=? AND content_hash=?', entry.owner, artifact.artifact_id, artifact.revision, artifact.content_hash);
    exact(saved?.metadata, entry.registryPublishedSHA, '原登记'); const original = companionArtifactSchema.parse(JSON.parse(saved!.metadata));
    if (original.publicationState !== 'committed' || original.ownerId !== entry.owner || original.artifactId !== artifact.artifact_id || original.relativePath !== artifact.relative_path
      || JSON.stringify({ ...JSON.parse(artifact.metadata), publicationState: 'committed' }) !== saved!.metadata) throw new Error('事故修复不能改变原登记引用或权限。');
    return { before: before!, note, dependencies: header.dependencies, artifact, originalMetadata: saved!.metadata };
  });
  const archives = manifest.archives.map(entry => {
    const before = noteData(db, entry.id); exact(before, entry.beforeSHA, '归档 CAS'); exact(entry.witnessNote, entry.witnessSHA, '独立归档见证');
    const old = companionMemorySchema.parse(JSON.parse(entry.witnessNote)), current = companionMemorySchema.parse(JSON.parse(before!));
    if (current.id !== entry.id || current.companionId !== entry.owner || old.id !== current.id || old.companionId !== current.companionId || !old.archivedAt || !old.supersededBy
      || current.archivedAt || current.supersededBy || current.content !== old.content || current.contentRevision !== old.contentRevision || JSON.stringify(current.sources) !== JSON.stringify(old.sources)) throw new Error('事故修复归档见证不匹配。');
    if (!db.prepare("SELECT 1 FROM companion_memory_changes WHERE note_id=? AND json_extract(data,'$.causeEventId')=? AND json_extract(data,'$.cause.operation')='restore'")
      .get(entry.id, 'consolidation-restore/' + old.supersededBy)) throw new Error('事故修复缺少准确的错误解除归档事件。');
    const note = { ...current, archivedAt: old.archivedAt, supersededBy: old.supersededBy, version: current.version + 1,
      annotationRevision: current.annotationRevision! + 1, semanticRevision: current.semanticRevision! + 1, updatedAt: manifest.repairAt };
    exact(JSON.stringify(note), entry.afterSHA, '归档后记忆'); return { before: before!, note };
  });
  const consolidations = manifest.consolidations.map(entry => {
    const before = value<{ value: string }>(db, 'SELECT value FROM metadata WHERE key=?', entry.key)?.value; exact(before, entry.beforeSHA, '合并凭据 CAS'); exact(entry.witnessValue, entry.witnessSHA, '独立合并见证');
    const current = JSON.parse(before!) as { state: string; inputs: unknown; mergedId: string }, witness = JSON.parse(entry.witnessValue) as typeof current;
    if (current.state !== 'restored' || witness.state !== 'published' || current.mergedId !== witness.mergedId || JSON.stringify(current.inputs) !== JSON.stringify(witness.inputs)) throw new Error('事故修复合并凭据不匹配。');
    const after = JSON.stringify({ ...current, state: 'published' }); exact(after, entry.afterSHA, '恢复后合并凭据'); return { key: entry.key, before: before!, after };
  });
  return { notes, archives, consolidations };
}

type Receipt = { manifestSHA: string; initialHead: CompanionRecoveryHead; afterHead: CompanionRecoveryHead; phase: 'prepared' | 'completed'; postStateSHA?: string };
/** Only explicit approved apply may reconcile a crashed independent finish.
 * This readonly lookup supplies no authority: the real fence must still admit
 * exactly the durable receipt's head, library, enrollment and physical ledger.
 * A prepare that never committed a receipt cannot guess its burned head. */
function reconcileReceipt(selection: CompanionRecoverySelection, manifest: CompanionHostIncidentRepairManifest, approved: string): void {
  if (hostIncidentRepairSHA(JSON.stringify(manifest)) !== approved || selection.libraryId !== manifest.libraryId) throw new Error('事故修复重入没有准确批准。');
  const file = path.join(selection.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.resolve(realpathSync(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('事故修复重入账本不是普通原始文件。');
  const Database = BetterSqlite3 as { new(file: string, options: { readonly: true; fileMustExist: true }): CompanionConnection };
  const db = new Database(file, { readonly: true, fileMustExist: true }); let expected = manifest.initialHead;
  try {
    const raw = value<{ value: string }>(db, 'SELECT value FROM metadata WHERE key=?', receiptKey(manifest.operationId))?.value;
    if (raw) {
      const receipt = JSON.parse(raw) as Receipt;
      if (receipt.manifestSHA !== approved || !sameHead(receipt.initialHead, manifest.initialHead) || !['prepared', 'completed'].includes(receipt.phase)) throw new Error('事故修复重入凭据不匹配。');
      expected = headSchema.parse(receipt.afterHead);
    }
  } finally { db.close(); }
  const maintenance = openCompanionFencedMaintenance(selection, expected); maintenance.close();
}
export function planCompanionHostIncidentRepair(selection: CompanionRecoverySelection, input: unknown, ownersRoot: string) {
  const manifest = companionHostIncidentRepairManifestSchema.parse(input), manifestSHA = hostIncidentRepairSHA(JSON.stringify(manifest));
  if (selection.libraryId !== manifest.libraryId) throw new Error('事故修复资产库身份不匹配。');
  const inspection = inspectCompanionFencedMaintenance(selection);
  try {
    const raw = value<{ value: string }>(inspection.db, 'SELECT value FROM metadata WHERE key=?', receiptKey(manifest.operationId))?.value;
    const receipt = raw ? JSON.parse(raw) as Receipt : undefined;
    if (receipt) {
      if (receipt.manifestSHA !== manifestSHA || !sameHead(receipt.initialHead, manifest.initialHead) || !sameHead(receipt.afterHead, inspection.head)) throw new Error('事故修复重入凭据不匹配。');
      if (receipt.phase === 'completed') {
        if (hostIncidentRepairStateSHA(inspection.db, manifest.operationId) !== receipt.postStateSHA) throw new Error('事故修复完成后领域状态有变化。');
        verifyFiles(inspection.db, manifest, ownersRoot, true);
        for (const entry of manifest.notes) {
          exact(noteData(inspection.db, entry.id), entry.afterSHA, '完成后记忆');
          const artifact = artifactRow(inspection.db, entry.owner, entry.id);
          if (!artifact || artifact.state !== 'committed' || artifact.body_removed_at !== null) throw new Error('事故修复完成后登记已变化。');
          exact(artifact.metadata, entry.registryPublishedSHA, '完成后登记');
          exact(readFileSync(hostIncidentRepairFile(ownersRoot, entry.owner, artifact.relative_path), 'utf8'), artifact.content_hash, '完成后正文');
        }
        return { manifestSHA, state: 'completed' as const, head: inspection.head, files: [] };
      }
    } else if (!sameHead(inspection.head, manifest.initialHead)) throw new Error('事故修复宿主水位已变化。');
    if (hostIncidentRepairStateSHA(inspection.db, manifest.operationId) !== manifest.beforeStateSHA) throw new Error('事故修复完整领域状态已变化。');
    const prepared = prepare(inspection.db, manifest, ownersRoot);
    return { manifestSHA, state: receipt ? 'prepared' as const : 'planned' as const, head: inspection.head,
      files: prepared.notes.map(item => ({ owner: item.note.companionId, relativePath: item.artifact.relative_path, sha256: item.artifact.content_hash, size: Buffer.byteLength(item.note.content), text: item.note.content })) };
  } finally { inspection.close(); }
}

/** Explicit, approved host maintenance only. Files are installed by the Main
 * driver between these two synchronous fenced phases. Never called by Store,
 * a model, a renderer, ordinary capture/reingest or constructor recovery. */
export function beginCompanionHostIncidentRepair(selection: CompanionRecoverySelection, input: unknown, ownersRoot: string, approvedManifestSHA: string): CompanionRecoveryHead {
  const manifest = companionHostIncidentRepairManifestSchema.parse(input); reconcileReceipt(selection, manifest, approvedManifestSHA);
  const plan = planCompanionHostIncidentRepair(selection, manifest, ownersRoot);
  if (plan.manifestSHA !== approvedManifestSHA) throw new Error('事故修复需要逐字批准的计划 SHA。');
  if (plan.state !== 'planned') return plan.head;
  const maintenance = openCompanionFencedMaintenance(selection, plan.head);
  try {
    maintenance.mutate(db => {
      if (hostIncidentRepairStateSHA(db, manifest.operationId) !== manifest.beforeStateSHA) throw new Error('事故修复准备期间领域状态已变化。'); prepare(db, manifest, ownersRoot);
      const receipt: Receipt = { manifestSHA: plan.manifestSHA, initialHead: manifest.initialHead, afterHead: { ...plan.head, generation: plan.head.generation + 1 }, phase: 'prepared' };
      db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(receiptKey(manifest.operationId), JSON.stringify(receipt));
    }); return maintenance.head;
  } finally { maintenance.close(); }
}

export function completeCompanionHostIncidentRepair(selection: CompanionRecoverySelection, input: unknown, ownersRoot: string, approvedManifestSHA: string): CompanionRecoveryHead {
  const manifest = companionHostIncidentRepairManifestSchema.parse(input); reconcileReceipt(selection, manifest, approvedManifestSHA);
  const plan = planCompanionHostIncidentRepair(selection, manifest, ownersRoot);
  if (plan.manifestSHA !== approvedManifestSHA || plan.state === 'planned') throw new Error('事故修复尚未准确准备。');
  if (plan.state === 'completed') return plan.head;
  const maintenance = openCompanionFencedMaintenance(selection, plan.head);
  try {
    maintenance.mutate(db => {
      if (hostIncidentRepairStateSHA(db, manifest.operationId) !== manifest.beforeStateSHA) throw new Error('事故修复提交期间领域状态已变化。');
      const prepared = prepare(db, manifest, ownersRoot), ledger = new CompanionMemoryLedger(db);
      for (const item of prepared.notes) exact(readFileSync(hostIncidentRepairFile(ownersRoot, item.note.companionId, item.artifact.relative_path), 'utf8'), item.artifact.content_hash, '已安装当前正文');
      for (const marker of manifest.tombstones) if (db.prepare('DELETE FROM metadata WHERE key=? AND value=?').run(`execution-source-invalid/${marker.kind}/${marker.id}`,
        value<{ value: string }>(db, 'SELECT value FROM metadata WHERE key=?', `execution-source-invalid/${marker.kind}/${marker.id}`)!.value).changes !== 1) throw new Error('事故修复撤回标记 CAS 失败。');
      for (const item of [...prepared.archives, ...prepared.notes]) {
        const note = item.note;
        if (db.prepare('UPDATE vcp_memory_notes SET data=? WHERE id=? AND data=?').run(JSON.stringify(note), note.id, item.before).changes !== 1) throw new Error('事故修复记忆 CAS 失败。');
        const restored = prepared.notes.find(note => note === item);
        if (restored) {
          db.prepare('DELETE FROM vcp_note_sources WHERE note_id=?').run(note.id);
          for (const source of note.sources) {
            if (!db.prepare('SELECT 1 FROM vcp_note_source_history WHERE note_id=? AND message_id=?').get(note.id, source.messageId)) throw new Error('事故修复来源历史缺失。');
            db.prepare('INSERT INTO vcp_note_sources VALUES(?,?,?,?)').run(note.id, source.messageId, source.revision, source.checksum);
          }
          db.prepare('DELETE FROM vcp_note_dependencies WHERE note_id=?').run(note.id);
          for (const dependency of restored.dependencies) db.prepare('INSERT INTO vcp_note_dependencies(note_id,source_note_id,version) VALUES(?,?,?)').run(note.id, dependency.id, dependency.contentRevision);
          ledger.change(note.companionId, 'content', note, companionMemorySchema.parse(JSON.parse(item.before)), restored.dependencies, { operation: 'restore' });
        }
        ledger.recordVersion(note);
        db.prepare('INSERT OR IGNORE INTO companion_memory_delivery_owners(companion_id) VALUES(?)').run(note.companionId);
        db.prepare("UPDATE vcp_memory_outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE note_id=? AND note_version<? AND status!='running'").run(note.id, note.version);
        db.prepare('INSERT INTO vcp_memory_outbox(id,companion_id,scope_id,note_id,note_version,operation,data) VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), note.companionId, note.scopeId, note.id, note.version, note.archivedAt ? 'forget' : 'remember', JSON.stringify({ noteId: note.id, version: note.version }));
        db.prepare("UPDATE vcp_memory_scopes SET revision=revision+1,state='dirty',updated_at=? WHERE scope_id=?").run(manifest.repairAt, note.scopeId);
      }
      for (const item of prepared.notes) if (db.prepare("UPDATE companion_artifacts SET state='committed',metadata=?,body_removed_at=NULL WHERE owner_id=? AND artifact_id=? AND revision=? AND content_hash=? AND state='revoked' AND metadata=? AND body_removed_at=?")
        .run(item.originalMetadata, item.artifact.owner_id, item.artifact.artifact_id, item.artifact.revision, item.artifact.content_hash, item.artifact.metadata, item.artifact.body_removed_at).changes !== 1) throw new Error('事故修复登记 CAS 失败。');
      for (const item of prepared.consolidations) if (db.prepare('UPDATE metadata SET value=? WHERE key=? AND value=?').run(item.after, item.key, item.before).changes !== 1) throw new Error('事故修复合并凭据 CAS 失败。');
      // Constructors below only wire domain predicates; initialize() is never
      // invoked. All source/forget/reset/ACL/history gates remain the real SQL
      // implementations. Published-message cuts are deliberately not enabled.
      const memory = new CompanionMemoryStore(db, () => { throw new Error('事故修复不允许从替代消息端口返回正文。'); });
      memory.sources.withValidation(() => {
        for (const item of [...prepared.notes, ...prepared.archives]) {
          const scope = memory.sources.ownerScope(item.note.companionId);
          const result = memory.execute({ type: 'memory.records.filter', ...scope, ids: [item.note.id] });
          if (!result?.memories?.some(note => note.id === item.note.id)) throw new Error('事故修复当前记忆 SQL 权限核验失败。');
        }
        for (const marker of manifest.tombstones) {
          if (marker.kind === 'message') {
            const source = value<Record<string, string | number | null>>(db, 'SELECT * FROM messages WHERE id=?', marker.id);
            if (!source || !memory.sources.formal(source)) throw new Error('事故修复正式消息 SQL 来源核验失败。');
          } else {
            const row = value<{ data: string }>(db, 'SELECT data FROM actions WHERE id=?', marker.id), action = row ? JSON.parse(row.data) as { capability?: unknown; thought?: unknown; authorizationGrantId?: unknown } : undefined;
            // This fixed incident contains only completed legacy DSH effects.
            // Other live capabilities require a separately reviewed repair,
            // never a successful historical-report flag as authorization.
            if (!action || action.capability || action.thought || action.authorizationGrantId) throw new Error('事故修复不接受未覆盖的动态行动授权。');
            const checkpoint = value<{ value: string }>(db, 'SELECT value FROM metadata WHERE key=?', 'task-checkpoint/' + marker.id);
            const readset = companionExecutionReadsetSchema.safeParse(checkpoint ? (JSON.parse(checkpoint.value) as { executionReadset?: unknown }).executionReadset : undefined);
            if (!readset.success || !memory.sources.validatedActionReadsetDigest(marker.id, readset.data)) throw new Error('事故修复行动完整 SQL 来源核验失败。');
          }
        }
      });
      const receipt: Receipt = { manifestSHA: plan.manifestSHA, initialHead: manifest.initialHead, afterHead: { ...plan.head, generation: plan.head.generation + 1 }, phase: 'completed', postStateSHA: hostIncidentRepairStateSHA(db, manifest.operationId) };
      db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(receipt), receiptKey(manifest.operationId));
    }); return maintenance.head;
  } finally { maintenance.close(); }
}
