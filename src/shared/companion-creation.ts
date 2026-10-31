import { z } from 'zod';

/** The caller creates these once per submission and retains them on retry. */
export const companionCreationIdentitySchema = z.strictObject({
  operationId: z.uuid(), companionId: z.uuid(),
});
export const companionCreationReceiptSchema = companionCreationIdentitySchema.extend({
  schema: z.literal('companion-creation-v1'),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(['prepared', 'committed', 'failed']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), error: z.string().max(1000).optional(),
}).strict();
export type CompanionCreationIdentity = z.infer<typeof companionCreationIdentitySchema>;
export type CompanionCreationReceipt = z.infer<typeof companionCreationReceiptSchema>;
export const companionCreationStatusCommand = z.strictObject({
  type: z.literal('companion.creation.status'), operationId: z.uuid(),
});
