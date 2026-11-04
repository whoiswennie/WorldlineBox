import { z } from 'zod';
import { companionReportedUsageSchema } from './companion-model-usage';

const count = z.number().int().nonnegative().safe();
/** One actual App HTTP request, never lifetime token expenditure or a tokenizer claim. */
export const botBrainRequestMetricsSchema = z.strictObject({
  requestId: z.string().min(1).max(160), purpose: z.enum(['reply', 'compaction']),
  measuredAt: z.string().datetime(), phase: z.enum(['prepared', 'finished']), model: z.string().max(160),
  window: count.positive(), windowSource: z.enum(['explicit', 'metadata', 'official-default', 'unknown']),
  inputTokensUpperBound: count, estimateMethod: z.literal('utf8-byte-upper-bound'),
  reservedOutputTokens: count, framingReserveTokens: z.literal(256), remainingTokensLowerBound: count,
  messageCount: count, toolDefinitionCount: count, reportedUsage: companionReportedUsageSchema.optional(),
});
export type BotBrainRequestMetrics = z.infer<typeof botBrainRequestMetricsSchema>;
export interface BotBrainContextSummary {
  conversationId: string; companionId: string; epoch: number;
  queuedMessages: number; runningMessages: number; phase?: string;
  retention: { completedTurns: number };
  compactionRequests: number; latestCompactionAt?: string;
  /** Latest request in this epoch; future input/tool results are not yet measured. */
  lastRequest?: BotBrainRequestMetrics;
}
