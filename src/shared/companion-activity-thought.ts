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
