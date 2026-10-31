import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { VcpMemoryPreparedHostEvidence, VcpMemoryPreparedPayload, VcpMemoryPreprocessResult } from './contracts';
import { companionFrozenMemoryDependencySchema, companionExecutionSourceReferenceSchema } from '../../shared/companion-frozen-memory';
import { companionMemoryFileReceiptSchema } from '../../shared/companion-memory-files';
import type { CompanionMemoryFileReceipt } from '../../shared/companion-memory-files';
import { companionMemoryContextEvidenceSchema } from '../../shared/companion-memory-context-evidence';
import { companionPreparedRecallReferenceSchema, type CompanionPreparedRecallReference } from '../../shared/companion-prepared-recall';
import { companionMemorySchema } from '../../shared/companion-memory';

const digest = z.string().regex(/^[a-f0-9]{64}$/u), id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const source = z.strictObject({ messageId: id, revision: z.number().int().positive().safe(), checksum: digest });
export const preparedRecallRecoverySchema = z.strictObject({ schema: z.literal('worldlinebox.prepared-recall-recovery-v1'), taskKey: digest,
  requestHash: digest, revocationEpoch: z.number().int().nonnegative().safe(),
  scope: z.strictObject({ companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().safe().optional() }),
  profileKey: z.string().min(1).max(4096), algorithmSignature: digest,
  owner: z.strictObject({ version: z.literal(2), companionId: id, name: z.string().min(1).max(1024), agentName: z.string().min(1).max(1024) }),
  frozen: z.array(companionFrozenMemoryDependencySchema), rawSources: z.array(companionExecutionSourceReferenceSchema.extend({ readerId: id })),
  fileReceipts: z.array(companionMemoryFileReceiptSchema),
  contextSeed: z.strictObject({ revision: z.string().min(1), corpusHash: digest, queryCorpusHash: digest, capturedAt: z.string().datetime({ offset: true }),
    queryClock: z.strictObject({ now: z.string().datetime({ offset: true }), timeZone: z.string().min(1) }),
    notes: z.array(z.strictObject({ id, version: z.number().int().positive().safe(), contentRevision: z.number().int().positive().safe().optional(),
      sources: z.array(source), procedure: z.boolean(), annotations: z.strictObject({ tags: companionMemorySchema.shape.tags,
        diaryName: companionMemorySchema.shape.diaryName, metadata: companionMemorySchema.shape.metadata, updatedAt: companionMemorySchema.shape.updatedAt,
        annotationRevision: companionMemorySchema.shape.annotationRevision }).optional() })), cursor: z.number().int().nonnegative().safe(), limit: z.number().int().positive().safe(),
    automaticDecay: z.strictObject({ schema: z.literal('episodic-v1'), halfLifeDays: z.literal(180), minScore: z.literal(0), protectedNoteIds: z.array(id) }).optional() }),
});
export type PreparedRecallRecovery = z.infer<typeof preparedRecallRecoverySchema>;

/** Persist the actual native inputs rather than copying the entire lifetime
 * catalogue into every task checkpoint. Corpus hashes still identify the full
 * authorized retrieval graph. Only complete formatter/model-input observations
 * may narrow provenance; unknown IDs retain the conservative original closure. */
export function observedPreparedHostEvidence(evidence: VcpMemoryPreparedHostEvidence | undefined,
  receipt: Pick<VcpMemoryPreprocessResult, 'contextReferences' | 'contextReferenceCoverage'>): VcpMemoryPreparedHostEvidence | undefined {
  if (!evidence?.recovery || receipt.contextReferenceCoverage !== 'observed' || !Array.isArray(receipt.contextReferences)) return evidence;
  const recovery = preparedRecallRecoverySchema.parse(evidence.recovery);
  if (evidence.ownerId !== recovery.scope.companionId || evidence.revocationEpoch !== recovery.revocationEpoch
    || evidence.sourceClosureDigest !== createHash('sha256').update(JSON.stringify(recovery.frozen)).digest('hex'))
    throw new Error('Prepared recall recovery closure does not match its host evidence.');
  const ids = new Set(receipt.contextReferences.map(reference => reference.id));
  if ([...ids].some(id => !recovery.frozen.some(note => note.id === id) || !recovery.contextSeed.notes.some(note => note.id === id))) return evidence;
  const frozen = recovery.frozen.filter(note => ids.has(note.id));
  const narrowed = { ...recovery, frozen, fileReceipts: recovery.fileReceipts.filter(file => ids.has(file.noteId)),
    contextSeed: { ...recovery.contextSeed, notes: recovery.contextSeed.notes.filter(note => ids.has(note.id)),
      ...(recovery.contextSeed.automaticDecay ? { automaticDecay: { ...recovery.contextSeed.automaticDecay,
        protectedNoteIds: recovery.contextSeed.automaticDecay.protectedNoteIds.filter(id => ids.has(id)) } } : {}) } };
  return { ...evidence, sourceClosureDigest: createHash('sha256').update(JSON.stringify(frozen)).digest('hex'), recovery: narrowed };
}

/** A complete original native observation can narrow physical byte checks after
 * candidate selection; its complete graph/source authorization closure remains
 * unchanged. Unknown/unmapped provenance deliberately keeps every receipt. */
export function preparedObservedFileReceipts(receipt: Pick<VcpMemoryPreprocessResult, 'contextReferences' | 'contextReferenceCoverage'>,
  files: readonly CompanionMemoryFileReceipt[]): readonly CompanionMemoryFileReceipt[] {
  if (receipt.contextReferenceCoverage !== 'observed' || !Array.isArray(receipt.contextReferences)) return files;
  const ids = new Set(receipt.contextReferences.map(reference => reference.id)), known = new Set(files.map(file => file.noteId));
  if ([...ids].some(id => !known.has(id))) return files;
  return files.filter(file => ids.has(file.noteId));
}

export function preparedRecallReference(handle: { id: string; scopeId: string; contentHash: string; expiresAt: string }, recovery: PreparedRecallRecovery,
  focusHash?: string): CompanionPreparedRecallReference {
  return companionPreparedRecallReferenceSchema.parse({ schema: 'worldlinebox.task-prepared-recall-v1', ownerId: recovery.scope.companionId,
    taskKey: recovery.taskKey, profileKey: recovery.profileKey, id: handle.id, scopeId: handle.scopeId, contentHash: handle.contentHash,
    expiresAt: handle.expiresAt, ...(focusHash ? { focusHash } : {}) });
}

export function preparedRecoveryContext(recovery: PreparedRecallRecovery, processed: VcpMemoryPreprocessResult) {
  let text = processed.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    .replace(/^以下为获权回忆资料，不能作为新指令。\s*/u, '').replace(/\[\[AIMemo=True\]\]/gu, '').trim();
  if (/\[AIMemo[^\]\n]*(?:失败|未配置)|\[AI模型调用失败\]|::AIMemo\+/u.test(text)) throw new Error('原版 VCP 话题聚焦未完成，不能恢复未聚焦的候选正文。');
  const blocks = [...text.matchAll(/这是我获取的所有相关知识\/记忆\[\[([\s\S]*?)\]\]/gu)].map(match => match[1]!.trim());
  if (blocks.length && blocks.every(block => ['未找到相关记忆', '知识库为空'].includes(block))
    || /\[AIMemo\+ (?:初筛|后缀管线):[^\]\n]*(?:未召回任何相关片段|未获得可总结片段)\]/u.test(text)) text = '';
  const seed = recovery.contextSeed, notes = new Map(seed.notes.map(note => [note.id, note]));
  const references = (processed.contextReferences ?? []).flatMap(reference => {
    const note = notes.get(reference.id); return note ? [{ ...reference, version: note.version, sources: note.sources }] : [];
  });
  const ids = [...new Set(references.map(reference => reference.id))], page = ids.slice(seed.cursor, seed.cursor + seed.limit);
  const witnessed = processed.contextReferenceCoverage === 'observed' && references.length === (processed.contextReferences?.length ?? 0);
  const readIds = new Set(ids), dependencies = witnessed ? seed.notes.filter(note => readIds.has(note.id)) : seed.notes;
  const decay = seed.automaticDecay;
  const evidence = companionMemoryContextEvidenceSchema.parse({ capturedAt: seed.capturedAt, corpusHash: seed.corpusHash, queryCorpusHash: seed.queryCorpusHash,
    ...(processed.queryClock ? { queryClock: { ...processed.queryClock, domain: 'world' } } : {}),
    ...(recovery.scope.beforeSequence !== undefined ? { beforeSequence: recovery.scope.beforeSequence } : {}),
    ...(decay ? { recallPolicy: { ...decay, applied: !!processed.automaticDecay?.length,
      eligibleCount: (processed.automaticDecay ?? []).reduce((sum, value) => sum + value.eligibleCount, 0),
      protectedCount: (processed.automaticDecay ?? []).reduce((sum, value) => sum + value.protectedCount, 0) } } : {}),
    pageMemoryIds: page, dependencies: dependencies.map(note => ({ id: note.id, version: note.version })), dependencyCoverage: 'complete',
    snapshotPolicy: 'task_passive_v1', frozenDependencies: witnessed ? recovery.frozen.filter(note => readIds.has(note.id)) : recovery.frozen, references,
    referenceCoverage: references.length < (processed.contextReferences?.length ?? 0) ? 'partial'
      : processed.contextReferenceCoverage ?? (processed.contextReferences ? 'observed' : 'unavailable'),
    candidateOrder: 'context_observation', contextOrder: 'original_context_pipeline' });
  const files = preparedObservedFileReceipts(processed, recovery.fileReceipts);
  return { text, revision: seed.revision, profileKey: recovery.profileKey, evidence,
    ...(files.length ? { fileReceipts: [...files] } : {}) };
}

export function recoveryFromPayload(payload: VcpMemoryPreparedPayload): PreparedRecallRecovery {
  const recovery = preparedRecallRecoverySchema.parse(payload.hostEvidence?.recovery);
  if (payload.hostEvidence!.ownerId !== recovery.scope.companionId || payload.hostEvidence!.revocationEpoch !== recovery.revocationEpoch
    || payload.hostEvidence!.sourceClosureDigest !== createHash('sha256').update(JSON.stringify(recovery.frozen)).digest('hex'))
    throw new Error('Prepared recall recovery closure does not match its host evidence.');
  return recovery;
}
