import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { inspectCompanionFencedMaintenance, openCompanionFencedMaintenance } from './fenced-maintenance';
import { bindCompanionMemoryPolicyRoot, resolveCompanionMemoryPolicy } from './memory-policy-files';
import { CompanionMemoryStore } from './memory-store';
import { assertCompanionRecoveryLedger, type CompanionRecoveryHead, type CompanionRecoverySelection } from './recovery-fence';
import type { CompanionConnection } from './store';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative().safe();
const head = z.strictObject({ lineageId: id, generation: integer });
const reference = z.strictObject({ id, owner: id, conversationId: id, sourceMessageId: id, sourceAuthorId: id,
  sourceSequence: integer, throughSequence: integer, sourceRevision: z.number().int().positive().safe(), sourceChecksum: hash,
  beforeRowSHA: hash, attempts: integer, dispositionRevision: integer, policyRevision: hash });
/** An offline, explicitly reviewed two-row incident repair. This is not an IPC
 * command and cannot select arbitrary tables, columns or replacement values. */
export const companionHostCaptureRequeueManifestSchema = z.strictObject({
  schema: z.literal('worldlinebox.host-capture-unavailable-requeue-v1'), operationId: id, libraryId: id,
  initialHead: head, incidentAt: z.iso.datetime(), evidenceSHA: hash, jobs: z.array(reference).length(2),
}).superRefine((value, context) => {
  if (new Set(value.jobs.map(item => item.id)).size !== 2 || new Set(value.jobs.map(item => item.sourceMessageId)).size !== 2
    || value.jobs.some(item => item.throughSequence < item.sourceSequence || item.sourceAuthorId !== 'user' && item.sourceAuthorId !== item.owner))
    context.addIssue({ code: 'custom', message: '编码恢复仅接受两个独立、准确绑定的用户或本人来源作业。' });
});
export type CompanionHostCaptureRequeueManifest = z.infer<typeof companionHostCaptureRequeueManifestSchema>;
const receiptSchema = z.strictObject({ schema: z.literal('worldlinebox.host-capture-requeue-receipt-v1'), manifestSHA: hash,
  initialHead: head, afterHead: head, rowSHAs: z.array(z.strictObject({ id, sha256: hash })).length(2) });
type Receipt = z.infer<typeof receiptSchema>;
type Row = Record<string, string | number | null>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const companionHostCaptureRequeueRowSHA = (row: Readonly<Row>) => sha(JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))));
export const companionHostCaptureRequeueManifestSHA = (input: unknown) => sha(JSON.stringify(companionHostCaptureRequeueManifestSchema.parse(input)));
const receiptKey = (operation: string) => 'host-capture-unavailable-requeue/' + operation;
const sameHead = (a: CompanionRecoveryHead, b: CompanionRecoveryHead) => a.lineageId === b.lineageId && a.generation === b.generation;
const nextHead = (value: CompanionRecoveryHead) => ({ ...value, generation: value.generation + 1 });
const technicalError = '伙伴存储请求 cognition.registry.read 排队超过 30 秒，尚未派发、未执行。';
const get = <T>(db: CompanionConnection, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T | undefined;

function readReceipt(db: CompanionConnection, manifest: CompanionHostCaptureRequeueManifest, manifestSHA: string): Receipt | undefined {
  const raw = get<{ value: string }>(db, 'SELECT value FROM metadata WHERE key=?', receiptKey(manifest.operationId))?.value;
  if (!raw) return;
  const receipt = receiptSchema.parse(JSON.parse(raw));
  if (receipt.manifestSHA !== manifestSHA || !sameHead(receipt.initialHead, manifest.initialHead)
    || !sameHead(receipt.afterHead, nextHead(manifest.initialHead))
    || receipt.rowSHAs.some((row, index) => row.id !== manifest.jobs[index]!.id)) throw new Error('编码恢复重入凭据不匹配。');
  return receipt;
}

/** Pure constructors only. No initialize(), Store, index maintenance, timers,
 * current-node shortcut, or public message hydration is available here. */
function validate(db: CompanionConnection, selection: CompanionRecoverySelection, manifest: CompanionHostCaptureRequeueManifest,
  state: 'cancelled' | 'pending', expectedRows?: readonly { id: string; sha256: string }[]): Row[] {
  const memory = new CompanionMemoryStore(db, () => { throw new Error('离线编码恢复不提供替代消息正文。'); });
  bindCompanionMemoryPolicyRoot(db, path.join(selection.libraryPath, '伙伴记忆'));
  return memory.sources.withCurrentReferencesValidation(() => manifest.jobs.map((expected, index) => {
    const row = get<Row>(db, 'SELECT * FROM vcp_capture_jobs WHERE id=?', expected.id);
    const source = get<Row>(db, 'SELECT * FROM messages WHERE id=?', expected.sourceMessageId);
    const owner = get<{ active: number | null; deleted_at: string | null }>(db,
      "SELECT json_extract(data,'$.active') AS active,deleted_at FROM companions WHERE id=?", expected.owner);
    if (!row || row.status !== state || row.companion_id !== expected.owner || row.conversation_id !== expected.conversationId
      || row.message_id !== expected.sourceMessageId || row.source_sequence !== expected.sourceSequence || row.through_sequence !== expected.throughSequence
      || row.source_revision !== expected.sourceRevision || row.source_checksum !== expected.sourceChecksum
      || row.attempts !== expected.attempts || row.disposition_revision !== expected.dispositionRevision + Number(state === 'pending')
      || row.error !== technicalError || row.updated_at !== manifest.incidentAt || row.lease_token !== null || row.lease_until !== null
      || row.completed_batch_id !== null || row.output_note_versions !== null
      || state === 'pending' && row.admission_deferred !== 1
      || companionHostCaptureRequeueRowSHA(row) !== (state === 'cancelled' ? expected.beforeRowSHA : expectedRows?.[index]?.sha256))
      throw new Error('编码恢复准确作业 CAS、技术错误或结算状态已变化。');
    if (!source || source.id !== expected.sourceMessageId || source.author_id !== expected.sourceAuthorId || source.kind !== 'text' || source.status !== 'sent'
      || source.conversation_id !== expected.conversationId || source.sequence !== expected.sourceSequence || source.revision !== expected.sourceRevision
      || sha(String(source.content)) !== expected.sourceChecksum || !String(source.content).trim() || owner?.deleted_at !== null || owner.active !== 1
      || get(db, 'SELECT 1 FROM companion_capture_proposals WHERE job_id=?', expected.id))
      throw new Error('编码恢复来源、伙伴或未结提案已变化。');
    const policy = resolveCompanionMemoryPolicy(db, expected.owner);
    if (!policy.canonical || policy.revision !== expected.policyRevision
      || !memory.sources.currentReferencesValid({ companionId: expected.owner, conversationId: expected.conversationId, beforeSequence: expected.throughSequence },
        [{ id: expected.sourceMessageId, conversationId: expected.conversationId, revision: expected.sourceRevision, checksum: expected.sourceChecksum }]))
      throw new Error('编码恢复的当前来源、读取权、遗忘、重置或记忆策略不成立。');
    return row;
  }));
}

export function planCompanionHostCaptureRequeue(selection: CompanionRecoverySelection, input: unknown) {
  const manifest = companionHostCaptureRequeueManifestSchema.parse(input), manifestSHA = companionHostCaptureRequeueManifestSHA(manifest);
  if (selection.libraryId !== manifest.libraryId) throw new Error('编码恢复选择的资产库不匹配。');
  const inspection = inspectCompanionFencedMaintenance(selection);
  try {
    inspection.db.pragma('query_only=ON');
    return inspection.db.transaction(() => {
      const receipt = readReceipt(inspection.db, manifest, manifestSHA);
      if (receipt) {
        if (!sameHead(inspection.head, receipt.afterHead)) throw new Error('编码恢复完成后宿主水位已变化。');
        validate(inspection.db, selection, manifest, 'pending', receipt.rowSHAs);
        return { state: 'completed' as const, manifestSHA, head: inspection.head, jobs: 2, modelRequests: 0, runtimeEffectsReplayed: false };
      }
      if (!sameHead(inspection.head, manifest.initialHead)) throw new Error('编码恢复计划的宿主水位已变化。');
      validate(inspection.db, selection, manifest, 'cancelled');
      return { state: 'planned' as const, manifestSHA, head: inspection.head, jobs: 2, modelRequests: 0, runtimeEffectsReplayed: false };
    })();
  } finally { inspection.close(); }
}

export function applyCompanionHostCaptureRequeue(selection: CompanionRecoverySelection, input: unknown, approvedManifestSHA: string) {
  const manifest = companionHostCaptureRequeueManifestSchema.parse(input), manifestSHA = companionHostCaptureRequeueManifestSHA(manifest);
  if (selection.libraryId !== manifest.libraryId || approvedManifestSHA !== manifestSHA) throw new Error('编码恢复应用需要准确选库与批准的 manifest SHA。');
  // The exact durable receipt can select only this operation's post-commit
  // head. The real fence still validates enrollment/inode and settles a crash.
  const file = path.join(selection.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite');
  assertCompanionRecoveryLedger(selection, file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.resolve(realpathSync(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('编码恢复账本路径不安全。');
  const Database = BetterSqlite3 as { new(file: string, options: { readonly: true; fileMustExist: true }): CompanionConnection };
  const readonly = new Database(file, { readonly: true, fileMustExist: true }); let expectedHead = manifest.initialHead;
  try { expectedHead = readReceipt(readonly, manifest, manifestSHA)?.afterHead ?? expectedHead; } finally { readonly.close(); }
  const session = openCompanionFencedMaintenance(selection, expectedHead);
  try {
    const existing = readReceipt(session.db, manifest, manifestSHA);
    if (existing) { validate(session.db, selection, manifest, 'pending', existing.rowSHAs);
      return { state: 'completed' as const, manifestSHA, head: session.head, jobs: 2, modelRequests: 0, runtimeEffectsReplayed: false }; }
    session.mutate(db => {
      const before = validate(db, selection, manifest, 'cancelled');
      const after: Row[] = before.map(row => ({ ...row, status: 'pending', admission_deferred: 1, disposition_revision: Number(row.disposition_revision) + 1 }));
      for (const [index, job] of manifest.jobs.entries()) {
        if (db.prepare("UPDATE vcp_capture_jobs SET status='pending',admission_deferred=1 WHERE id=? AND companion_id=? AND status='cancelled' AND disposition_revision=?")
          .run(job.id, job.owner, job.dispositionRevision).changes !== 1) throw new Error('编码恢复作业更新 CAS 失败。');
        // The ordinary status journal legitimately touches updated_at. This
        // one-off repair preserves that original incident timestamp too; no
        // status/attempt/error trigger is disabled or fired a second time.
        if (db.prepare("UPDATE vcp_capture_jobs SET updated_at=? WHERE id=? AND companion_id=? AND status='pending' AND disposition_revision=?")
          .run(before[index]!.updated_at, job.id, job.owner, job.dispositionRevision + 1).changes !== 1) throw new Error('编码恢复原时间戳 CAS 失败。');
      }
      const rowSHAs = after.map(row => ({ id: String(row.id), sha256: companionHostCaptureRequeueRowSHA(row) }));
      // Late revocation, a missing trigger or any unexpected side mutation
      // rejects both updates and the operation receipt in this transaction.
      validate(db, selection, manifest, 'pending', rowSHAs);
      const receipt: Receipt = { schema: 'worldlinebox.host-capture-requeue-receipt-v1', manifestSHA, initialHead: manifest.initialHead,
        afterHead: nextHead(manifest.initialHead), rowSHAs };
      db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(receiptKey(manifest.operationId), JSON.stringify(receipt));
    });
    return { state: 'completed' as const, manifestSHA, head: session.head, jobs: 2, modelRequests: 0, runtimeEffectsReplayed: false };
  } finally { session.close(); }
}
