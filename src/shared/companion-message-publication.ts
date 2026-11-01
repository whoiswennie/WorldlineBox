import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
/** Issued only after Main's complete publication/read fence. This describes
 * historical publication, never permission to read a current file or act. */
export const companionMessagePublicationCandidateSchema = z.strictObject({
  policyVersion: z.literal(1), companionId: id, conversationId: id, messageId: id,
  messageRevision: z.number().int().positive().safe(), bodySHA: hash, readsetDigest: hash, contextClosureDigest: hash,
});
export const companionMessagePublicationModeSchema = z.enum(['new_publication', 'revalidated_historical']);
export const companionMessagePublicationCertificateSchema = companionMessagePublicationCandidateSchema.extend({
  mode: companionMessagePublicationModeSchema, certifiedAt: z.string().datetime(),
});
export type CompanionMessagePublicationCandidate = z.infer<typeof companionMessagePublicationCandidateSchema>;
export type CompanionMessagePublicationCertificate = z.infer<typeof companionMessagePublicationCertificateSchema>;
export type CompanionMessagePublicationMode = z.infer<typeof companionMessagePublicationModeSchema>;
/** Metadata-only SQL closure boundary. Volatile actions retain their original
 * Main authority and file gates; this never certifies an action's execution. */
export const companionPublishedActionFrontierSchema = z.strictObject({ id, companionId: id, conversationId: id,
  actionBindingHash: hash, readsetDigest: hash });
export type CompanionPublishedActionFrontier = z.infer<typeof companionPublishedActionFrontierSchema>;
export const companionPublishedDependencyCutSchema = z.strictObject({ generation: z.number().int().nonnegative().safe(), bindingHash: hash,
  assetOwners: z.array(id).min(1).max(10000).refine(values => values.every((value, index) => index === 0 || values[index - 1]! < value), 'Asset owners must be sorted and unique.'),
  volatileActions: z.array(companionPublishedActionFrontierSchema).max(10000) });
export type CompanionPublishedDependencyCut = z.infer<typeof companionPublishedDependencyCutSchema>;

/** Object insertion order is not an evidence change. Array order and every
 * value remain bound, including optional fields that are actually present. */
export function companionMessagePublicationCanonicalJSON(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : input;
  return JSON.stringify(canonical(value));
}
