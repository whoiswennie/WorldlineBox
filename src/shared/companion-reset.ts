import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionResetSchema = z.strictObject({
  id, companionId: id, scope: z.literal('all'), status: z.enum(['running', 'completed', 'failed']),
  phase: z.string().max(80), processed: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), error: z.string().max(1000).optional(),
});
export type CompanionReset = z.infer<typeof companionResetSchema>;
export const companionResetCommands = [
  z.strictObject({ type: z.literal('companion.reset'), id, scope: z.literal('all'), expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal('companion.reset.status'), id }),
] as const;
