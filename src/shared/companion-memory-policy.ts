import { z } from 'zod';

/** Defaults are initialization templates. Bounds are host resource limits,
 * not settings a role can widen through a prompt or arbitrary metadata. */
export const companionMemoryPolicySchema = z.strictObject({
  mode: z.enum(['quiet', 'balanced', 'learning']),
  capture: z.strictObject({ quietMs: z.number().int().min(5_000).max(300_000), maxWaitMs: z.number().int().min(5_000).max(1_800_000), batchSize: z.number().int().min(1).max(12) })
    .refine(value => value.maxWaitMs >= value.quietMs, '最大等待必须不少于静默窗口。'),
  deep: z.strictObject({ intervalMs: z.number().int().min(1_800_000).max(172_800_000), maxDebtAgeMs: z.number().int().min(1_800_000).max(604_800_000), minEpisodes: z.number().int().min(1).max(12) })
    .refine(value => value.maxDebtAgeMs >= value.intervalMs, '最老欠账期限必须不少于深度决策间隔。'),
  dream: z.strictObject({ probability: z.number().min(0).max(1), cooldownMs: z.number().int().min(28_800_000).max(259_200_000), maxAttempts: z.number().int().min(1).max(3) }),
});
export type CompanionMemoryPolicy = z.infer<typeof companionMemoryPolicySchema>;
export const companionMemoryPolicyFileSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-memory-policy-v1'),
  companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), policy: companionMemoryPolicySchema });
export const COMPANION_MEMORY_POLICY_FILE = '记忆策略.json';
export function initialCompanionMemoryPolicy(mode: CompanionMemoryPolicy['mode'] = 'balanced'): CompanionMemoryPolicy {
  const policies: Record<CompanionMemoryPolicy['mode'], CompanionMemoryPolicy> = {
    quiet: { mode, capture: { quietMs: 120_000, maxWaitMs: 600_000, batchSize: 12 }, deep: { intervalMs: 43_200_000, maxDebtAgeMs: 172_800_000, minEpisodes: 5 }, dream: { probability: .3, cooldownMs: 57_600_000, maxAttempts: 2 } },
    balanced: { mode, capture: { quietMs: 60_000, maxWaitMs: 300_000, batchSize: 12 }, deep: { intervalMs: 21_600_000, maxDebtAgeMs: 86_400_000, minEpisodes: 3 }, dream: { probability: .6, cooldownMs: 28_800_000, maxAttempts: 3 } },
    learning: { mode, capture: { quietMs: 30_000, maxWaitMs: 180_000, batchSize: 8 }, deep: { intervalMs: 10_800_000, maxDebtAgeMs: 43_200_000, minEpisodes: 2 }, dream: { probability: .6, cooldownMs: 28_800_000, maxAttempts: 3 } },
  };
  return companionMemoryPolicySchema.parse(policies[mode]);
}
