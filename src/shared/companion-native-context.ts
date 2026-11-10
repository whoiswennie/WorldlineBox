import {z} from 'zod';

const tokens=z.number().int().nonnegative().safe();
/** DSH's native context meter projections. Composition is heuristic and must
 * not be presented as the provider-anchored occupancy sum. */
export const botNativeContextSchema=z.strictObject({
  source:z.literal('dsh-native-projections'),sessionId:z.string().min(1).max(200),
  state:z.enum(['ready','empty','migration-required','unsupported']),
  asOfSeq:z.number().int().min(-1).safe().optional(),sampledAt:z.string().datetime(),
  observation:z.strictObject({hostId:z.string().max(80),revision:tokens}).optional(),
  pressure:z.strictObject({pressureTokens:tokens.optional(),projectedTokens:tokens.optional(),contextWindow:tokens.positive().optional()}).optional(),
  breakdown:z.strictObject({systemTokens:tokens,toolsTokens:tokens,messageTokens:tokens}).optional(),
  usage:z.strictObject({uncachedInputTokens:tokens,outputTokens:tokens,cacheReadTokens:tokens,cacheWriteTokens:tokens}).optional(),
  activity:z.strictObject({phase:z.enum(['idle','running','maintenance','compacting','recovering']),command:z.string().max(200).optional(),
    compaction:z.strictObject({id:z.string().max(200),state:z.enum(['running','succeeded','failed','interrupted']),origin:z.enum(['manual','automatic']),
      startedAt:z.string().datetime(),finishedAt:z.string().datetime().optional(),sequence:tokens,error:z.string().max(2000).optional()}).optional()}).optional(),
});
export type BotNativeContext=z.infer<typeof botNativeContextSchema>;
/** Native phase can change without advancing the durable log watermark. */
export function botContextIsNewer(candidate:BotNativeContext,current:BotNativeContext):boolean{
  if(candidate.sessionId!==current.sessionId)return false;
  if(candidate.asOfSeq!==current.asOfSeq)return(candidate.asOfSeq??-1)>(current.asOfSeq??-1);
  if(candidate.observation&&current.observation&&candidate.observation.hostId===current.observation.hostId)return candidate.observation.revision>current.observation.revision;
  return candidate.sampledAt>current.sampledAt;
}
export interface BotTopicContext {topicId:string;companionId:string;sample?:BotNativeContext;stale?:boolean;error?:string}
export function botContextOccupancy(sample?:BotNativeContext):{tokens:number;capacity:number;percent:number}|undefined{
  const used=sample?.pressure?.projectedTokens??sample?.pressure?.pressureTokens,capacity=sample?.pressure?.contextWindow;
  if(used===undefined||capacity===undefined)return;
  return{tokens:used,capacity,percent:Math.min(100,Math.round(used/capacity*100))};
}
