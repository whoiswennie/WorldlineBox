import { z } from 'zod';
import { companionQualitativeSourceVersionSchema } from './companion-current-experience';

/** A committed qualitative transition, with only objective energy change. */
export const companionStateChangeSchema = z.strictObject({
  id: z.string().min(1).max(200), kind: z.enum(['experience', 'task', 'world', 'interruption', 'memory']),
  appliedAt: z.iso.datetime(), occurredAt: z.iso.datetime(), reason: z.string().max(1000), energyDelta: z.number().finite(),
  experienceId: z.string().optional(), relationshipRecordIds: z.array(z.string()).max(24).optional(),
  expression: z.strictObject({ before: z.string().max(60), after: z.string().max(60) }).optional(),
  focus: z.strictObject({ before: z.string().max(300).optional(), after: z.string().max(300).optional() }).optional(),
  sourceConversationId: z.string().optional(), sourceMessageIds: z.array(z.string()).max(100), memoryIds: z.array(z.string()).max(30).optional(),
  sourceVersions: z.array(companionQualitativeSourceVersionSchema).max(100).optional(),
  memoryVersions: z.array(z.strictObject({ id: z.string(), version: z.number().int().positive() })).max(30).optional(),
});
export type CompanionStateChange = z.infer<typeof companionStateChangeSchema>;
