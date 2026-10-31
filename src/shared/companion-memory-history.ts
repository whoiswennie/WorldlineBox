import { z } from 'zod';
import { companionJobFailureKindSchema } from './companion-job-control';
import type { CompanionMemory } from './companions';
import { companionMemoryProcedureValidationSchema } from './companion-procedure';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u), revision = z.number().int().positive().safe();
export const companionMemoryHistoryDependencySchema = z.strictObject({ id, contentRevision: revision });
export const companionMemoryHistoryDescriptorSchema = z.strictObject({ companionId: id, id, contentRevision: revision, bodyHash: hash,
  documentHash: hash, relativePath: z.string().min(1).max(768),
  sources: z.array(z.strictObject({ id, conversationId: id, checksum: hash, revision })),
  dependencies: z.array(companionMemoryHistoryDependencySchema), procedureValidation: companionMemoryProcedureValidationSchema.optional() });
export type CompanionMemoryHistoryDescriptor = z.infer<typeof companionMemoryHistoryDescriptorSchema>;
export const companionMemoryHistoryOutboxSchema = z.strictObject({ id, companionId: id, memoryId: id, contentRevision: revision, bodyHash: hash,
  documentHash: hash, relativePath: z.string().min(1).max(768), operation: z.enum(['publish', 'retract']), leaseToken: id, attempts: z.number().int().positive(), retryCycle: z.number().int().nonnegative().safe(),
  /** A payload exists only on the internal publisher port, never describe/read. */
  payload: z.strictObject({ memory: z.unknown(), dependencies: z.array(companionMemoryHistoryDependencySchema) }).optional() });
export type CompanionMemoryHistoryOutbox = z.infer<typeof companionMemoryHistoryOutboxSchema>;
export type CompanionMemoryHistoryPayload = { memory: CompanionMemory; dependencies: z.infer<typeof companionMemoryHistoryDependencySchema>[] };
export const companionMemoryHistoryCommands = [
  z.strictObject({ type: z.literal('memory.history.outbox.owners'), limit: z.number().int().min(1).max(128).default(4), excludedOwners: z.array(id).max(128).default([]), afterOwnerId: id.optional() }),
  z.strictObject({ type: z.literal('memory.history.outbox.claim'), companionId: id, memoryId: id.optional(), contentRevision: revision.optional(), operation: z.enum(['publish', 'retract']).optional(), throughOrdinal: z.number().int().nonnegative().safe().optional(), leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
  z.strictObject({ type: z.literal('memory.history.outbox.check'), id, leaseToken: id }),
  z.strictObject({ type: z.literal('memory.history.outbox.complete'), id, leaseToken: id, documentHash: hash }),
  z.strictObject({ type: z.literal('memory.history.outbox.fail'), id, leaseToken: id, error: z.string().max(2000), failureKind: companionJobFailureKindSchema.optional(), retryAfterMs: z.number().int().min(1000).max(3600000).default(30000) }),
  z.strictObject({ type: z.literal('memory.revision.describe'), companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().optional(), id, contentRevision: revision }),
  z.strictObject({ type: z.literal('memory.revisions.describe'), companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().optional(),
    roots: z.array(companionMemoryHistoryDependencySchema).max(10000) }),
] as const;

export function companionMemoryHistoryPath(noteId: string, contentRevision: number, bodyHash: string): string {
  id.parse(noteId); revision.parse(contentRevision); hash.parse(bodyHash);
  return `证据/历史/${noteId}/r${contentRevision}-${bodyHash}.md`;
}
/** One atomic document contains both historical metadata and exact old body.
 * It is outside discoverable diary categories, so it cannot re-enter capture. */
export function renderCompanionMemoryHistory(payload: CompanionMemoryHistoryPayload, bodyHash: string): string {
  const { content, ...metadata } = payload.memory;
  return '---\n' + JSON.stringify({ schema: 'worldlinebox.companion-memory-history-v2', companionId: payload.memory.companionId,
    id: payload.memory.id, contentRevision: payload.memory.contentRevision, bodyHash, memory: metadata, dependencies: payload.dependencies }, null, 2) + '\n---\n' + content;
}
