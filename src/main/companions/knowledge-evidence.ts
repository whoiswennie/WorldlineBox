import { createHash } from 'node:crypto';
import { companionKnowledgeResponseSchema } from '../../shared/companion-knowledge-store';
import { companionKnowledgeReadSchema, type CompanionKnowledgeRead } from '../../shared/companion-agent-run';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionLoopTurn } from '../../shared/companion-loop';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (read: CompanionKnowledgeRead) => JSON.stringify([read.id, read.version, read.sourceType, read.sourceId, read.sourceVersion, read.sourceDigest,
  read.conversationId, read.grantId ?? null, read.grantRevision ?? null, read.assetId ?? null, read.assetRevisionId ?? null]);
/** Only a typed host envelope introduces evidence. Never parse source prose or
 * traverse nested user JSON looking for a receipt that resembles host output. */
export function companionKnowledgeReads(value: unknown): CompanionKnowledgeRead[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const envelope = value as Record<string, unknown>;
  const parsed = envelope.ok === true ? companionKnowledgeResponseSchema.safeParse(envelope.memoryKnowledge) : undefined;
  if (!parsed?.success || !parsed.data.available || !['search', 'read'].includes(parsed.data.operation)) return [];
  const reads: CompanionKnowledgeRead[] = [];
  for (const item of [...(parsed.data.result ? [parsed.data.result] : []), ...(parsed.data.items ?? [])]) {
    if (!item.text?.trim()) continue;
    const metadata = item.metadata ?? {};
    const expected = item.sourceType === 'learning' && typeof metadata.assetId === 'string'
      ? `cold_learning_${hash(item.sourceId + ':' + metadata.assetId).slice(0, 48)}`
      : `cold_${item.sourceType}_${hash(item.sourceId).slice(0, 48)}`;
    if (item.id !== expected) continue;
    const read = companionKnowledgeReadSchema.safeParse({ id: item.id, version: item.version, sourceType: item.sourceType,
      sourceId: item.sourceId, sourceVersion: item.sourceVersion, sourceDigest: item.sourceDigest, conversationId: metadata.conversationId,
      ...(item.sourceType === 'learning' ? { grantId: metadata.grantId, grantRevision: metadata.grantRevision,
        assetId: metadata.assetId, assetRevisionId: metadata.assetRevisionId } : {}) });
    if (read.success && (read.data.sourceType !== 'learning' || read.data.sourceVersion === `${read.data.grantRevision}:${read.data.assetRevisionId}`)) reads.push(read.data);
  }
  return [...new Map(reads.map(read => [identity(read), read])).values()];
}

/** Reconstruct only receipts of actual knowledge calls from durable tool
 * history. A different tool's JSON output cannot impersonate a knowledge read. */
export function companionKnowledgeReadsFromTurns(turns: readonly CompanionLoopTurn[]): CompanionKnowledgeRead[] {
  const reads: CompanionKnowledgeRead[] = [];
  for (const turn of turns) for (const call of turn.calls) {
    try {
      if (normalizeCompanionCapabilityCall(call).name !== 'memory.knowledge') continue;
      const result = turn.results?.find(result => result.callId === call.id);
      if (result) reads.push(...companionKnowledgeReads(JSON.parse(result.content)));
    } catch { /* A legacy malformed receipt never creates new authority. */ }
  }
  return [...new Map(reads.map(read => [identity(read), read])).values()];
}

/** Main-process read checks the current asset bytes/grant and rechecks them
 * before returning. Equal hot-memory epochs alone cannot validate cold files. */
export async function verifyCompanionKnowledgeReads(reads: readonly CompanionKnowledgeRead[] | undefined,
  scope: { companionId: string; conversationId: string; beforeSequence?: number },
  request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>): Promise<boolean> {
  for (const read of reads ?? []) {
    try {
      const result = await request({ type: 'memory.knowledge', ...scope, operation: 'read', id: read.id, version: read.version });
      if (!companionKnowledgeReads(result).some(current => identity(current) === identity(read))) return false;
    } catch { return false; }
  }
  return true;
}
