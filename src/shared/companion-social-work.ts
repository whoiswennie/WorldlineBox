import { z } from 'zod';

/** A receiver's decision over one actual peer request; never player tool authority. */
export const companionSocialWorkOfferSchema = z.strictObject({
  sourceMessageId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  title: z.string().trim().min(1).max(200), instruction: z.string().trim().min(1).max(16000),
  mode: z.literal('activity').optional().describe('本人明确接下需跨回合行动、等待和继续推进的内部责任时选activity并accept=true；省略保持一次性分析工作。不会获得真人或现实执行授权。'),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(5), accept: z.boolean(),
}).superRefine((offer, context) => {
  if (offer.mode === 'activity' && offer.title.length > 120) context.addIssue({ code: 'custom', path: ['title'], message: '持续活动标题最多120字。' });
});
