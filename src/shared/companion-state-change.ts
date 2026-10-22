import { z } from 'zod';

const delta = z.number().finite();
/** A committed host transition, distinct from a proposal or a clock tick. */
export const companionStateChangeSchema = z.object({
  id: z.string().min(1).max(200), kind: z.enum(['appraisal', 'task', 'world', 'interruption', 'memory']),
  appliedAt: z.iso.datetime(), occurredAt: z.iso.datetime(), reason: z.string().max(1000),
  affectDelta: z.object({ pleasure: delta, arousal: delta, dominance: delta }),
  relationshipDelta: z.object({ affinity: delta, trust: delta, respect: delta }), energyDelta: delta,
  expression: z.object({ before: z.string().max(60), after: z.string().max(60) }).optional(),
  focus: z.object({ before: z.string().max(300).optional(), after: z.string().max(300).optional() }).optional(),
  sourceConversationId: z.string().optional(), sourceMessageIds: z.array(z.string()).max(100), memoryIds: z.array(z.string()).max(30).optional(),
  memoryVersions: z.array(z.object({ id: z.string(), version: z.number().int().positive() })).max(30).optional(),
});
export type CompanionStateChange = z.infer<typeof companionStateChangeSchema>;
