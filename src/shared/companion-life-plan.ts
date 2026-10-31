import { z } from 'zod';
import { companionMemoryPolicySchema } from './companion-memory-policy';
import { companionRoutineConfigSchema } from './companion-routine';
import { companionLearningGrantSchema } from './companion-learning';
import { companionJobDispositionSchema } from './companion-job-control';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const instant = z.iso.datetime();
export const companionMemoryLifePlanCommand = z.strictObject({ type: z.literal('memory.life-plan.status'), companionId: id });
export const companionMemoryLifePlanItemSchema = z.object({
  id: z.string().min(1).max(160), kind: z.enum(['learning', 'journal', 'sleep_consolidation', 'dream']),
  title: z.string().max(160), state: z.enum(['unconfigured', 'idle', 'scheduled', 'eligible', 'waiting', 'running']),
  timing: z.object({ kind: z.enum(['next_check', 'eligibility', 'retry', 'window', 'event_driven', 'conditional']), clock: z.enum(['real', 'world']),
    timeZone: z.string().max(100).optional(), at: instant.optional(), windowStart: instant.optional(), windowEnd: instant.optional() }),
  reason: z.string().max(1000), sourceTitle: z.string().max(512).optional(), probability: z.number().min(0).max(1).optional(),
});
export const companionMemoryLifePlanSchema = z.object({ companionId: id, checkedAt: instant,
  items: z.array(companionMemoryLifePlanItemSchema).max(50), hasMore: z.boolean() });
export type CompanionMemoryLifePlanItem = z.infer<typeof companionMemoryLifePlanItemSchema>;
export type CompanionMemoryLifePlan = z.infer<typeof companionMemoryLifePlanSchema>;

/** Internal read projection: no source text, model call, clock advance or admission draw. */
export const companionWorldSleepPlanSchema = z.object({ companionId: id, checkedAt: instant, active: z.boolean(), resetting: z.boolean(),
  clock: z.object({ realNow: instant, virtualNow: instant, observedRealAt: instant, timeZone: z.string(), speed: z.number().positive() }),
  routine: companionRoutineConfigSchema,
  actor: z.object({ activity: z.string(), routinePhase: z.string(), activityStartedAtReal: instant, moving: z.boolean(), working: z.boolean() }).optional(),
  hasUnconsolidated: z.boolean(), admission: z.enum(['unchecked', 'admitted', 'not_admitted']),
  maintenance: z.object({ eligible: z.boolean().optional(), policy: companionMemoryPolicySchema.optional(), policyError: z.string().max(1000).optional(), lastDecisionAt: instant.optional(), nextDeepEligibleAt: instant.optional(), lastDreamSuccessAt: instant.optional(),
    investigations: z.object({ waiting: z.number().int().nonnegative(), observed: z.number().int().nonnegative(), reason: z.string().max(1000).optional() }).optional(),
    mode: z.enum(['sleep', 'background']).optional(), reflectionCompletedAt: instant.optional(), realCompletedAt: instant.optional(),
    narrativeAttempts: z.number().int().nonnegative().optional(), narrativeStatus: z.enum(['pending', 'skipped', 'completed', 'failed']).optional() }).optional(),
  dreamCooldownUntilWorld: instant.optional(),
  job: z.object({ id, status: z.enum(['pending', 'running', 'failed', 'parked', 'abandoned']), attempts: z.number().int().nonnegative(),
    disposition: companionJobDispositionSchema.optional(),
    terminal: z.boolean().optional(), error: z.string().max(2000).optional(),
    nextAttemptAt: instant.optional(), leaseActive: z.boolean(), dreamAllowed: z.boolean() }).optional(),
  captureQueue: z.object({ pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
    liveRunning: z.number().int().nonnegative(), expiredLeases: z.number().int().nonnegative(),
    retryExhausted: z.number().int().nonnegative(), eligible: z.number().int().nonnegative(), nextAttemptAt: instant.optional() }),
  learning: z.array(z.object({ grant: companionLearningGrantSchema, manualPending: z.boolean() })).max(47), learningHasMore: z.boolean(),
});
export type CompanionWorldSleepPlan = z.infer<typeof companionWorldSleepPlanSchema>;
