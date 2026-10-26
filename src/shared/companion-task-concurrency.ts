import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const COMPANION_DEFAULT_TASK_CONCURRENCY = 3;
export const companionTaskConcurrencyPolicySchema = z.strictObject({ companionId: id, limit: z.number().int().min(1).max(10),
  active: z.number().int().nonnegative(), queued: z.number().int().nonnegative() });
export const companionTaskConcurrencySchema = z.strictObject({ defaultLimit: z.literal(3), policies: z.array(companionTaskConcurrencyPolicySchema) });
export const companionTaskConcurrencyCommands = [
  z.strictObject({ type: z.literal('tasks.concurrency.get'), companionId: id.optional() }),
  z.strictObject({ type: z.literal('tasks.concurrency.set'), companionId: id, limit: z.number().int().min(1).max(10) }),
] as const;
export type CompanionTaskConcurrency = z.infer<typeof companionTaskConcurrencySchema>;
