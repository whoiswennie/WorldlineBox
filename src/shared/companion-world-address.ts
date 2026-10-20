import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
/** Spatial memory belongs to the observer, never inferred from the contact directory. */
export const companionHomeAddressSchema = z.object({ companionId: id, homeSceneId: id,
  entrance: z.object({ sceneId: id, portalId: id }),
  learnedAt: z.iso.datetime(), source: z.enum(['own_home', 'owner_shared']), sourceMessageId: id.optional(), sourceConversationId: id.optional() });
export type CompanionHomeAddress = z.infer<typeof companionHomeAddressSchema>;
