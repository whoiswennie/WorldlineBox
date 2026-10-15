import { z } from 'zod';

/** A receiver's decision over one actual peer request; never player tool authority. */
export const companionSocialWorkOfferSchema = z.strictObject({
  sourceMessageId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  title: z.string().trim().min(1).max(200), instruction: z.string().trim().min(1).max(16000),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(5), accept: z.boolean(),
});
