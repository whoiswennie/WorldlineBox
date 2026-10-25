import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
/** An actual native call within one durable activity step, never user authority. */
export const companionActivityThoughtOriginSchema = z.strictObject({ taskId: id,
  step: z.number().int().nonnegative().safe(), effectId: z.string().min(1).max(200) });
export const companionActivityThoughtAuthorizationSchema = companionActivityThoughtOriginSchema.extend({
  companionId: id, conversationId: id, leaseToken: id, observationFingerprint: z.string().min(2).max(65536),
});
export type CompanionActivityThoughtOrigin = z.infer<typeof companionActivityThoughtOriginSchema>;
export type CompanionActivityThoughtAuthorization = z.infer<typeof companionActivityThoughtAuthorizationSchema>;

/** A native analysis call belongs to an actual inbound peer job. It never
 * creates a persistent activity or inherits the sender's external authority. */
export const companionPeerThoughtOriginSchema = z.strictObject({ kind: z.literal('peer'), jobId: id,
  effectId: z.string().min(1).max(200) });
export const companionPeerThoughtAuthorizationSchema = companionPeerThoughtOriginSchema.extend({
  companionId: id, conversationId: id, leaseToken: id, sourceMessageId: id,
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u), throughSequence: z.number().int().positive().safe(),
  observationFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const companionThoughtOriginSchema = z.union([companionActivityThoughtOriginSchema, companionPeerThoughtOriginSchema]);
export const companionThoughtAuthorizationSchema = z.union([companionActivityThoughtAuthorizationSchema, companionPeerThoughtAuthorizationSchema]);
export type CompanionPeerThoughtAuthorization = z.infer<typeof companionPeerThoughtAuthorizationSchema>;
export type CompanionThoughtOrigin = z.infer<typeof companionThoughtOriginSchema>;
export type CompanionThoughtAuthorization = z.infer<typeof companionThoughtAuthorizationSchema>;
