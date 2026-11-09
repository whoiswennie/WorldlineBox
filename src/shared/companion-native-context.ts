import {z} from 'zod';

const tokens=z.number().int().nonnegative().safe();
/** DSH's native context meter projections. Composition is heuristic and must
 * not be presented as the provider-anchored occupancy sum. */
export const botNativeContextSchema=z.strictObject({
  source:z.literal('dsh-native-projections'),sessionId:z.string().min(1).max(200),
  state:z.enum(['ready','empty','migration-required','unsupported']),
  asOfSeq:z.number().int().min(-1).safe().optional(),sampledAt:z.string().datetime(),
  pressure:z.strictObject({pressureTokens:tokens.optional(),projectedTokens:tokens.optional(),contextWindow:tokens.positive().optional()}).optional(),
  breakdown:z.strictObject({systemTokens:tokens,toolsTokens:tokens,messageTokens:tokens}).optional(),
  usage:z.strictObject({uncachedInputTokens:tokens,outputTokens:tokens,cacheReadTokens:tokens,cacheWriteTokens:tokens}).optional(),
});
export type BotNativeContext=z.infer<typeof botNativeContextSchema>;
export interface BotTopicContext {topicId:string;companionId:string;sample?:BotNativeContext;stale?:boolean;error?:string}
export function botContextOccupancy(sample?:BotNativeContext):{tokens:number;capacity:number;percent:number}|undefined{
  const used=sample?.pressure?.projectedTokens??sample?.pressure?.pressureTokens,capacity=sample?.pressure?.contextWindow;
  if(used===undefined||capacity===undefined)return;
  return{tokens:used,capacity,percent:Math.min(100,Math.round(used/capacity*100))};
}
