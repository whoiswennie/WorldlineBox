import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
/** Read-only host attestation of a completed virtual-world action. This field
 * is never accepted by message append or a model-authored memory candidate. */
export const companionHostBehaviorReceiptSchema = z.strictObject({
  schema: z.literal('worldlinebox.host-behavior-receipt-v2'), ownerId: id, actorId: id,
  sourceId: id, sourceRevision: z.literal(1), sourceHash: hash, eventId: id, eventSequence: z.number().int().positive(), eventHash: hash,
  kind: z.enum(['park_walk_complete', 'scene_enter']), realm: z.literal('virtual_world'), completedAt: z.iso.datetime(),
  audienceIds: z.array(id).min(1).max(2),
}).refine(value => value.ownerId === value.actorId && value.audienceIds.includes(`world_${value.ownerId}`)
  && new Set(value.audienceIds).size === value.audienceIds.length, 'Host behavior must belong to its actor and include its owner domain.');
export type CompanionHostBehaviorReceipt = z.infer<typeof companionHostBehaviorReceiptSchema>;
export function companionHostBehaviorMatches(ownerId: string, source: { id: string; authorId: string; conversationId?: string;
  revision?: number; checksum?: string; kind?: string; hostBehavior?: unknown }): CompanionHostBehaviorReceipt | undefined {
  const parsed = companionHostBehaviorReceiptSchema.safeParse(source.hostBehavior); if (!parsed.success) return;
  const receipt = parsed.data;
  return receipt.ownerId === ownerId && receipt.actorId === ownerId && source.id === receipt.sourceId && source.revision === receipt.sourceRevision
    && source.authorId === 'system' && (source.kind === undefined || source.kind === 'notice') && source.conversationId === `world_${ownerId}`
    && (source.checksum === undefined || source.checksum === receipt.sourceHash) ? receipt : undefined;
}
export function companionSourceSupportsOwnBehavior(ownerId: string, source: Parameters<typeof companionHostBehaviorMatches>[1]): boolean {
  return source.authorId === ownerId || !!companionHostBehaviorMatches(ownerId, source);
}
