import { z } from 'zod';
import { companionMemorySnapshotCommandSchema } from './companion-memory';
import { companionMemoryContentKindsSchema } from './companion-memory-scope';
import { companionMemoryHistoryDependencySchema } from './companion-memory-history';
import { companionMemorySnapshotRevisionScopeSchema } from './companion-memory-snapshot-revisions';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const beforeSequence = z.number().int().nonnegative().safe().optional();
const normalizedScope = z.lazy(() => companionMemorySnapshotCommandSchema.omit({ type: true }).extend({
  contentKinds: companionMemoryContentKindsSchema, publishedOnly: z.boolean(),
}).strict());
const navigation = z.strictObject({ scope: companionMemorySnapshotRevisionScopeSchema, expectedRevision: z.string() });
/** Private bounded page predicate. It is not a renderer/native/model command.
 * Each complete reader/cursor scope keeps its own original qualification; only
 * synchronous physical SQL reads are shared inside one fresh transaction. */
export const companionMemoryDocumentAuthorityCommandSchema = z.strictObject({
  type: z.literal('memory.documents.authority'), companionId: id,
  noteIds: z.array(id).max(256), navigation: z.array(navigation).max(256),
  history: z.strictObject({ conversationId: id, beforeSequence,
    roots: z.array(companionMemoryHistoryDependencySchema).max(10000) }).optional(),
  sources: z.strictObject({ conversationId: id, beforeSequence, ids: z.array(id).max(1000) }).optional(),
}).refine(value => value.navigation.every(item => item.scope.companionId === value.companionId),
  'Page navigation scopes must belong to the requested owner.');
export type CompanionMemoryDocumentAuthorityCommand = z.input<typeof companionMemoryDocumentAuthorityCommandSchema>;
/** Source guard redaction is carried by the existing top-level
 * memorySnapshotRevisions.groups, memories and source-header fields. These
 * scalars alone never authorize a navigation document. */
export const companionMemoryDocumentAuthorityResultSchema = z.strictObject({
  navigation: z.array(z.strictObject({ scope: normalizedScope, expectedRevision: z.string(),
    valid: z.boolean(), matches: z.boolean(), revision: z.string(), semanticRevision: z.string().optional(),
  }).refine(value => !value.matches || value.valid && (value.semanticRevision ?? value.revision) === value.expectedRevision,
    'A matching page navigation requires its exact current semantic revision.')).max(256),
});
export type CompanionMemoryDocumentAuthorityResult = z.infer<typeof companionMemoryDocumentAuthorityResultSchema>;
