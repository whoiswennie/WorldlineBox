import { z } from 'zod';

export const companionWorldQuerySchema = z.strictObject({
  category: z.enum(['contacts', 'scenes', 'social', 'observations']), query: z.string().trim().max(200).default(''),
  roomId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(), limit: z.number().int().min(1).max(20).default(10),
});
export const companionWorldObservationSchema = z.object({
  category: z.enum(['contacts', 'scenes', 'social', 'observations']), observedAt: z.iso.datetime(),
  observedAtVirtual: z.iso.datetime(), internalized: z.literal(false),
});
