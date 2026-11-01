import { z } from 'zod';
import { companionMemoryDescriptorSchema, companionMemorySnapshotCommandSchema } from './companion-memory';
import { companionMemoryContentKinds, companionMemoryContentKindsSchema } from './companion-memory-scope';

// Storage DTOs and memory DTOs reference each other; resolve the original
// scope only when parsing, after their modules have finished initialization.
export const companionMemorySnapshotRevisionScopeSchema = z.lazy(() => companionMemorySnapshotCommandSchema.omit({ type: true }).strict());
export type CompanionMemorySnapshotRevisionScope = z.infer<typeof companionMemorySnapshotRevisionScopeSchema>;
export function normalizeCompanionMemorySnapshotRevisionScope(input: CompanionMemorySnapshotRevisionScope) {
  const scope = companionMemorySnapshotRevisionScopeSchema.parse(input);
  return { companionId: scope.companionId, conversationId: scope.conversationId,
    ...(scope.beforeSequence !== undefined ? { beforeSequence: scope.beforeSequence } : {}),
    contentKinds: companionMemoryContentKinds(scope.contentKinds), publishedOnly: scope.publishedOnly === true };
}
export function companionMemorySnapshotRevisionScopeKey(scope: CompanionMemorySnapshotRevisionScope): string {
  const normalized = normalizeCompanionMemorySnapshotRevisionScope(scope);
  return JSON.stringify([normalized.companionId, normalized.conversationId, normalized.beforeSequence ?? null, normalized.contentKinds, normalized.publishedOnly]);
}
/** Private metadata predicate; no native/model tool exposes this command. */
export const companionMemorySnapshotRevisionsCommandSchema = z.strictObject({ type: z.literal('memory.snapshot.revisions'),
  scopes: z.array(companionMemorySnapshotRevisionScopeSchema).min(1).max(100) });
const normalizedScope = z.lazy(() => companionMemorySnapshotCommandSchema.omit({ type: true }).extend({ contentKinds: companionMemoryContentKindsSchema,
  publishedOnly: z.boolean() }).strict());
// A private document page can aggregate 256 independently qualified scopes.
// The original snapshot-revisions command remains bounded to 100 requests.
export const companionMemorySnapshotRevisionsResultSchema = z.strictObject({ groups: z.array(z.strictObject({
  scope: normalizedScope, valid: z.boolean(), revision: z.string(), semanticRevision: z.string().optional(),
  memories: z.array(z.lazy(() => companionMemoryDescriptorSchema)),
})).min(1).max(256) });
export type CompanionMemorySnapshotRevisionsResult = z.infer<typeof companionMemorySnapshotRevisionsResultSchema>;
