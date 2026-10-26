import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/u), id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionModelRequestPurposeSchema = z.enum(['reply', 'journal', 'reflection', 'consolidation', 'dream', 'tags', 'timeline', 'learning', 'world', 'other']);
export type CompanionModelRequestPurpose = z.infer<typeof companionModelRequestPurposeSchema>;
export const companionModelConnectionPolicySchema = z.strictObject({
  concurrency: z.number().int().min(1).max(4), requestsPerMinute: z.number().int().min(1).max(10000),
  requestsPerUtcDay: z.number().int().min(1).max(1000000), inputBytesPerUtcDay: z.number().int().min(1).max(1_000_000_000_000),
  reservedOutputTokensPerUtcDay: z.number().int().min(1).max(1_000_000_000),
  /** Optional user-supplied prices. No provider price is guessed or fetched. */
  cost: z.strictObject({ unit: z.string().trim().min(1).max(24), maximumMicrosPerUtcDay: z.number().int().min(1).max(1_000_000_000_000),
    inputMicrosPerMillionTokens: z.number().int().min(0).max(1_000_000_000), outputMicrosPerMillionTokens: z.number().int().min(0).max(1_000_000_000) }).optional(),
});
export type CompanionModelConnectionPolicy = z.infer<typeof companionModelConnectionPolicySchema>;
export const companionModelResourcePolicySchema = z.strictObject({ schema: z.literal('worldlinebox.companion-model-resources-v1'),
  defaultConnection: companionModelConnectionPolicySchema,
  connections: z.record(digest, companionModelConnectionPolicySchema).refine(value => Object.keys(value).length <= 128),
});
export type CompanionModelResourcePolicy = z.infer<typeof companionModelResourcePolicySchema>;
export const INITIAL_COMPANION_MODEL_RESOURCES: Readonly<CompanionModelResourcePolicy> = Object.freeze({
  schema: 'worldlinebox.companion-model-resources-v1', defaultConnection: { concurrency: 4, requestsPerMinute: 120,
    requestsPerUtcDay: 10000, inputBytesPerUtcDay: 200_000_000, reservedOutputTokensPerUtcDay: 20_000_000 }, connections: {},
});
export const companionModelResourceCommands = [
  z.strictObject({ type: z.literal('model.resources.config.status') }),
  z.strictObject({ type: z.literal('model.resources.config.initialized') }),
  z.strictObject({ type: z.literal('model.resources.admit'), id, companionId: id, connectionId: digest,
    hostPid: z.number().int().positive(), hostInstance: z.string().uuid(),
    policy: companionModelConnectionPolicySchema, policyRevision: digest,
    purpose: companionModelRequestPurposeSchema.optional(),
    inputBytes: z.number().int().nonnegative().max(128 * 1024 * 1024), reservedOutputTokens: z.number().int().positive().max(1_000_000) }),
  z.strictObject({ type: z.literal('model.resources.finish'), id, outcome: z.enum(['response', 'network_error', 'cancelled_before_send']),
    httpStatus: z.number().int().min(100).max(599).optional(), durationMs: z.number().finite().nonnegative().max(86_400_000) }),
  z.strictObject({ type: z.literal('model.resources.usage'), companionId: id.optional(), connectionId: digest.optional() }),
] as const;
export const companionModelResourceAdmissionSchema = z.strictObject({ accepted: z.boolean(), duplicate: z.boolean().optional(),
  reason: z.enum(['concurrency', 'requests_minute', 'requests_day', 'input_day', 'output_day', 'cost_day', 'cost_unit_changed']).optional(), retryAt: z.string().optional() });
export const companionModelResourceUsageSchema = z.object({ requests: z.number().int().nonnegative(), inputBytes: z.number().int().nonnegative(),
  reservedOutputTokens: z.number().int().nonnegative(), reservedCostMicros: z.number().nonnegative(),
  responses: z.number().int().nonnegative(), networkErrors: z.number().int().nonnegative(), unfinished: z.number().int().nonnegative(), interrupted: z.number().int().nonnegative(),
  observedAt: z.string(), windowStart: z.string(), purposes: z.array(z.object({ purpose: companionModelRequestPurposeSchema,
    requests: z.number().int().nonnegative(), inputBytes: z.number().int().nonnegative(), reservedOutputTokens: z.number().int().nonnegative() })).max(10).optional() });
