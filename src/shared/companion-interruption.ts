import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionInterruptionSchema = z.strictObject({ id, companionId: id, sourceMessageId: id,
  orders: z.array(z.strictObject({ id, conversationId: id, revision: z.number().int().positive(), actionId: id.optional(), actionIds: z.array(id).max(1024).default([]) })).max(100) });
export type CompanionInterruption = z.infer<typeof companionInterruptionSchema>;
export const companionInterruptionCommands = [
  z.strictObject({ type: z.literal('interruption.begin'), companionId: id, conversationId: id, sourceMessageId: id }),
  z.strictObject({ type: z.literal('interruption.end'), id }),
  z.strictObject({ type: z.literal('interruption.recover') }),
] as const;
