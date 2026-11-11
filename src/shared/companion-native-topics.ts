import { z } from 'zod';

export const botNativeTopicStateSchema = z.object({
  laneId: z.string().min(1).max(300), sessionId: z.string().min(1).max(200),
  exists: z.boolean(), title: z.string().max(4000).optional(), updatedAt: z.string().datetime().optional(),
});
export type BotNativeTopicState = z.infer<typeof botNativeTopicStateSchema>;
export const botNativeTopicStatesSchema = z.array(botNativeTopicStateSchema).max(200);
