import { z } from 'zod';

export const companionWorldQuerySchema = z.strictObject({
  category: z.enum(['contacts', 'people', 'scenes', 'social', 'observations', 'topics']), query: z.string().trim().max(200).default(''),
  roomId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(), limit: z.number().int().min(1).max(20).default(10),
  topicId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
});
export const companionWorldObservationSchema = z.object({
  category: z.enum(['contacts', 'people', 'scenes', 'social', 'observations', 'topics', 'experience', 'learning']), observedAt: z.iso.datetime(),
  observedAtVirtual: z.iso.datetime(), internalized: z.literal(false),
});
