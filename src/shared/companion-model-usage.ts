import { z } from 'zod';

const tokens = z.number().int().nonnegative().safe();
export const companionReportedUsageSchema = z.strictObject({ inputTokens: tokens.optional(), outputTokens: tokens.optional(), totalTokens: tokens.optional(),
  cacheReadTokens: tokens.optional(), cacheWriteTokens: tokens.optional(), reasoningTokens: tokens.optional() });
export type CompanionReportedUsage = z.infer<typeof companionReportedUsageSchema>;
export const companionModelUsageCurrentSchema = z.strictObject({ attemptId: z.uuid(), step: tokens.optional(), model: z.string().max(160),
  providerFormat: z.string().max(80), phase: z.enum(['prepared', 'dispatched', 'streaming', 'finished']), updatedAt: z.string(),
  estimate: z.strictObject({ inputTokens: tokens, method: z.literal('utf8_bytes_div_3'), hasUnmeteredImages: z.boolean(),
    breakdown: z.strictObject({ system: tokens, dialogue: tokens, toolDefinitions: tokens, toolHistory: tokens, other: tokens }) }),
  actual: companionReportedUsageSchema.optional(), contextLimit: tokens.positive().optional(),
});
export type CompanionModelUsageCurrent = z.infer<typeof companionModelUsageCurrentSchema>;
const totals = companionReportedUsageSchema.extend({ requests: tokens, reportedRequests: tokens, complete: z.boolean() });
export const companionModelUsageSchema = z.strictObject({ revision: tokens.positive(), current: companionModelUsageCurrentSchema, totals });
export const companionModelUsageStateSchema = companionModelUsageSchema.extend({ prior: totals });
export type CompanionModelUsage = z.infer<typeof companionModelUsageSchema>;
export type CompanionModelUsageState = z.infer<typeof companionModelUsageStateSchema>;
const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;
const empty = () => ({ requests: 0, reportedRequests: 0, complete: true });
function add(prior: CompanionModelUsage['totals'], current: CompanionModelUsageCurrent): CompanionModelUsage['totals'] {
  if (current.phase === 'prepared') return { ...prior };
  const result: CompanionModelUsage['totals'] = { requests: prior.requests + 1, reportedRequests: prior.reportedRequests + (current.actual ? 1 : 0),
    complete: prior.complete && current.actual?.inputTokens !== undefined && current.actual?.outputTokens !== undefined };
  for (const field of fields) {
    const value = current.actual?.[field];
    if (value !== undefined && (prior.requests === 0 || prior[field] !== undefined)) {
      const sum = (prior[field] ?? 0) + value; if (Number.isSafeInteger(sum)) result[field] = sum;
    }
  }
  return result;
}
/** Each provider report replaces that attempt's cumulative counters. Repeated
 * SSE usage frames do not count as new requests or get summed twice. */
export function updateCompanionModelUsage(previous: CompanionModelUsageState | undefined, current: CompanionModelUsageCurrent): CompanionModelUsageState {
  const prior = previous ? previous.current.attemptId === current.attemptId ? previous.prior : add(previous.prior, previous.current) : empty();
  return { revision: (previous?.revision ?? 0) + 1, current, prior, totals: add(prior, current) };
}
export function companionModelUsageView(state: CompanionModelUsageState): CompanionModelUsage { return { revision: state.revision, current: state.current, totals: state.totals }; }
export function companionUsageCacheHitPercent(usage?: CompanionReportedUsage): number | undefined {
  return usage?.inputTokens !== undefined && usage.inputTokens > 0 && usage.cacheReadTokens !== undefined
    && usage.cacheReadTokens <= usage.inputTokens ? usage.cacheReadTokens / usage.inputTokens * 100 : undefined;
}
