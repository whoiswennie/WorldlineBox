import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionLifeRuleDraftSchema = z.strictObject({ title: z.string().trim().min(1).max(120), enabled: z.boolean().default(true),
  startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(0).max(1440),
  probability: z.number().min(0).max(1), action: z.enum(['message', 'visit', 'rest', 'study', 'leisure']), targetId: id.optional() })
  .refine(rule => rule.startMinute !== rule.endMinute, '时间窗口不能为空。')
  .refine(rule => rule.action !== 'visit' || rule.targetId !== 'user', '拜访目标必须是伙伴。');
export const companionLifeRuleSchema = companionLifeRuleDraftSchema.safeExtend({ id, companionId: id, revision: z.number().int().positive(), createdAt: z.iso.datetime() });
export type CompanionLifeRule = z.output<typeof companionLifeRuleSchema>;
export const companionLifeOccurrenceSchema = z.object({ id, companionId: id, ruleId: id, rule: companionLifeRuleSchema,
  windowStart: z.iso.datetime(), windowEnd: z.iso.datetime(), status: z.enum(['observing', 'pending', 'running', 'done', 'expired', 'cancelled', 'failed']),
  hazard: z.number().nonnegative(), threshold: z.number().positive(), multiplier: z.number().nonnegative(), lastRealAt: z.iso.datetime(),
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
  z.strictObject({ type: z.literal('life-event.claim') }),
  z.strictObject({ type: z.literal('life-event.complete'), id, leaseToken: id, text: z.string().max(2000).optional() }),
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
export function companionLifeMultiplier(input: { energy: number; pleasure: number; arousal: number; affinity: number; trust: number;
  action: CompanionLifeRule['action']; available: boolean; expression?: string; thermalComfort?: number }): number {
  if (!input.available) return 0;
  const social = input.action === 'message' || input.action === 'visit';
  const energy = (Math.max(0, Math.min(100, input.energy)) - 60) / 100;
  const relationship = social ? .9 * (input.affinity - 50) / 50 + .4 * (input.trust - 50) / 50 : 0;
  const mood = social ? .45 * input.pleasure - .25 * Math.max(0, input.arousal) : input.action === 'rest' ? -energy : .2 * input.pleasure;
  const expression = social ? input.expression === 'playful' ? .15 : input.expression === 'reserved' ? -.2 : 0 : 0;
  return Math.max(.1, Math.min(3, Math.exp((input.action === 'rest' ? -energy : energy) + relationship + mood + expression)
    * Math.max(.35, Math.min(1, input.thermalComfort ?? 1))));
}
