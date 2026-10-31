import { z } from 'zod';
import { companionWorldParkSuitable } from './companion-world-park';
import type { CompanionWorldSnapshot } from './companion-world';
import { companionExecutionReadsetSchema } from './companion-execution-evidence';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const COMPANION_LIFE_DEFAULT_RHYTHM = { checkIntervalMinutes: 15, actionCooldownMinutes: 90,
  silenceCooldownMinutes: 20, failureCooldownMinutes: 30 } as const;
export function companionLifeRhythm(rule: Partial<{ [K in keyof typeof COMPANION_LIFE_DEFAULT_RHYTHM]: number }>): { [K in keyof typeof COMPANION_LIFE_DEFAULT_RHYTHM]: number } {
  return { ...COMPANION_LIFE_DEFAULT_RHYTHM, ...Object.fromEntries(Object.entries(rule).filter(([key, value]) => key in COMPANION_LIFE_DEFAULT_RHYTHM && typeof value === 'number')) };
}
export const companionLifeRuleDraftSchema = z.strictObject({ title: z.string().trim().min(1).max(120), enabled: z.boolean().default(true),
  startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(0).max(1440),
  probability: z.number().min(0).max(1), action: z.enum(['message', 'visit', 'rest', 'study', 'leisure', 'park_walk']), targetId: id.optional(),
  durationMinutes: z.number().int().min(10).max(120).optional(),
  checkIntervalMinutes: z.number().int().min(1).max(120).optional(), actionCooldownMinutes: z.number().int().min(5).max(1440).optional(),
  silenceCooldownMinutes: z.number().int().min(1).max(1440).optional(), failureCooldownMinutes: z.number().int().min(1).max(1440).optional() })
  .refine(rule => rule.startMinute !== rule.endMinute, '时间窗口不能为空。')
  .refine(rule => rule.action !== 'visit' || rule.targetId !== 'user', '拜访目标必须是伙伴。')
  .refine(rule => rule.action === 'park_walk' || rule.durationMinutes === undefined, '只有公园散步可以设置散步时长。')
  .refine(rule => rule.action !== 'park_walk' || rule.targetId === undefined, '公园散步不指定交流对象。');
export const companionLifeRuleSchema = companionLifeRuleDraftSchema.safeExtend({ id, companionId: id, revision: z.number().int().positive(), createdAt: z.iso.datetime() });
export type CompanionLifeRule = z.output<typeof companionLifeRuleSchema>;
export const companionLifeOccurrenceSchema = z.object({ id, companionId: id, ruleId: id, rule: companionLifeRuleSchema,
  windowStart: z.iso.datetime(), windowEnd: z.iso.datetime(), status: z.enum(['observing', 'pending', 'running', 'active', 'done', 'silent', 'expired', 'cancelled', 'failed']),
  hazard: z.number().nonnegative(), threshold: z.number().positive(), multiplier: z.number().nonnegative(), lastRealAt: z.iso.datetime(),
  lastEvaluatedAt: z.iso.datetime().optional(), settledAt: z.iso.datetime().optional(), nextEligibleAt: z.iso.datetime().optional(),
  targetId: id.optional(), leaseToken: id.optional(), leaseUntil: z.iso.datetime().optional(), attempts: z.number().int().nonnegative(),
  result: z.string().max(4000).optional(), reason: z.string().max(500).optional() });
export type CompanionLifeOccurrence = z.output<typeof companionLifeOccurrenceSchema>;
const scope = z.object({ companionId: id });
export const companionLifePublicCommands = [
  scope.extend({ type: z.literal('life-rule.list') }).strict(),
  scope.extend({ type: z.literal('life-rule.create'), rule: companionLifeRuleDraftSchema, clientId: id.optional() }).strict(),
  scope.extend({ type: z.literal('life-rule.update'), id, expectedRevision: z.number().int().positive(), rule: companionLifeRuleDraftSchema }).strict(),
  scope.extend({ type: z.literal('life-rule.remove'), id, expectedRevision: z.number().int().positive() }).strict(),
] as const;
export const companionLifeStorageCommands = [...companionLifePublicCommands,
  z.strictObject({ type: z.literal('life-event.tick') }),
  z.strictObject({ type: z.literal('life-event.claim'), excludedCompanionIds: z.array(id).max(100).optional() }),
  z.strictObject({ type: z.literal('life-event.complete'), id, leaseToken: id, text: z.string().max(2000).optional(), silent: z.boolean().optional(), reason: z.string().max(500).optional(), executionReadset: companionExecutionReadsetSchema.optional(), expectedMemoryRevision: z.string().min(1).max(128).optional() }),
  z.strictObject({ type: z.literal('life-event.fail'), id, leaseToken: id, error: z.string().max(500) }),
] as const;

/** Integrated nonhomogeneous Poisson hazard; changing tick rate never rerolls luck. */
export function companionLifeHazard(probability: number, windowMs: number, elapsedMs: number, multiplier: number): number {
  if (![probability, windowMs, elapsedMs, multiplier].every(Number.isFinite) || windowMs <= 0) throw new Error('生活事件概率参数无效。');
  return -Math.log1p(-Math.min(1 - 1e-12, Math.max(0, probability))) * Math.max(0, elapsedMs) / windowMs * Math.max(0, Math.min(4, multiplier));
}
export function companionLifeThreshold(seed: string): number {
  let value = 2166136261;
  for (const character of seed) { value ^= character.codePointAt(0)!; value = Math.imul(value, 16777619); }
  // Avalanche the persistent seed before mapping to the open unit interval.
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b); value ^= value >>> 16;
  return -Math.log(((value >>> 0) + .5) / 4294967296);
}
export function companionLifeMultiplier(input: { energy: number; action: CompanionLifeRule['action']; available: boolean;
  thermalComfort?: number; weather?: CompanionWorldSnapshot['environment']['weather']; outdoorTemperature?: number }): number {
  if (!input.available) return 0;
  const energy = Math.max(0, Math.min(100, input.energy));
  const comfort = Math.max(.35, Math.min(1, input.thermalComfort ?? 1));
  if (input.action === 'park_walk') {
    if (input.thermalComfort !== undefined && input.thermalComfort <= .2) return 0;
    if (!companionWorldParkSuitable({ weather: input.weather ?? 'clear', outdoorTemperature: input.outdoorTemperature ?? 20 }, energy)) return 0;
    const readiness = Math.max(0, Math.min(1, (energy - 25) / 40));
    return readiness * readiness * (3 - 2 * readiness) * comfort * (input.weather === 'cloudy' ? .85 : 1);
  }
  // Opportunity is based on actual resources. Desire and specific relationship
  // matters are evaluated by the owner, never converted into a friendship score.
  return (input.action === 'rest' ? .5 + (100 - energy) / 100 : .25 + energy / 100) * comfort;
}
