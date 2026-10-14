import type { CompanionAppraisal, CompanionRuntimeState } from './companion-state';

export type CompanionAffect = CompanionRuntimeState['affect'];
export type CompanionRelationship = CompanionRuntimeState['relationship'];
type AffectState = Pick<CompanionRuntimeState, 'affect' | 'relationship'>;
type Appraisal = CompanionAppraisal | { type: 'neutral'; target: CompanionAppraisal['target']; intensity: number; confidence: number };
export const COMPANION_APPRAISAL_CONFIDENCE_THRESHOLD = 0.65;
export const COMPANION_RELATIONSHIP_DAILY_POSITIVE_LIMIT = 6;
const HOUR = 3_600_000, DAY = HOUR * 24;

// PAD is a representation framework. These impulses, decay rates and relation
// deltas are product/game coefficients, not measurements or scientific constants.
const effects: Record<CompanionAppraisal['type'], { affect: CompanionAffect; relationship: CompanionRelationship }> = {
  support: { affect: { pleasure: 0.3, arousal: -0.08, dominance: 0.12 }, relationship: { affinity: 2.4, trust: 1.2, respect: 0.5 } },
  respect: { affect: { pleasure: 0.12, arousal: -0.03, dominance: 0.2 }, relationship: { affinity: 0.6, trust: 1, respect: 2.5 } },
  boundary_violation: { affect: { pleasure: -0.35, arousal: 0.3, dominance: -0.3 }, relationship: { affinity: -1, trust: -1.5, respect: -3 } },
  hostility: { affect: { pleasure: -0.5, arousal: 0.45, dominance: -0.25 }, relationship: { affinity: -2.5, trust: -2, respect: -2 } },
  shared_success: { affect: { pleasure: 0.4, arousal: 0.25, dominance: 0.3 }, relationship: { affinity: 1.4, trust: 1.8, respect: 0.8 } },
  repair: { affect: { pleasure: 0.15, arousal: -0.12, dominance: 0.14 }, relationship: { affinity: 0.9, trust: 2.4, respect: 1.4 } },
  disappointment: { affect: { pleasure: -0.25, arousal: 0.06, dominance: -0.18 }, relationship: { affinity: -1.2, trust: -1.8, respect: -0.3 } },
};

/** A late event adds a weakened impulse; it never replaces newer state outright. */
export function applyCompanionAppraisal(state: AffectState, appraisal: Appraisal, elapsedMs: number, positiveBudgetRemaining: number): AffectState & { positiveChange: number } {
  validateState(state); unit(appraisal.intensity); unit(appraisal.confidence);
  finite(elapsedMs); finite(positiveBudgetRemaining);
  if (appraisal.type === 'neutral' || appraisal.confidence < COMPANION_APPRAISAL_CONFIDENCE_THRESHOLD || appraisal.intensity === 0) {
    return { affect: { ...state.affect }, relationship: { ...state.relationship }, positiveChange: 0 };
  }
  const effect = effects[appraisal.type];
  if (!effect || !['self', 'user', 'task', 'other'].includes(appraisal.target)) throw new Error('伙伴互动评价类型无效。');
  const age = Math.max(0, elapsedMs), weight = appraisal.intensity * appraisal.confidence;
  const affectWeight = weight * Math.pow(0.5, age / (2 * HOUR));
  const affect = { ...state.affect };
  for (const dimension of ['pleasure', 'arousal', 'dominance'] as const) {
    const delta = effect.affect[dimension] * affectWeight;
    affect[dimension] = clamp(affect[dimension] + delta * (delta >= 0 ? (1 - affect[dimension]) / 2 : (1 + affect[dimension]) / 2), -1, 1);
  }
  const relationship = { ...state.relationship };
  if (appraisal.target !== 'user') return { affect, relationship, positiveChange: 0 };
  const relationWeight = weight * Math.pow(0.5, age / (7 * DAY));
  const deltas = { affinity: 0, trust: 0, respect: 0 };
  for (const dimension of ['affinity', 'trust', 'respect'] as const) {
    const delta = effect.relationship[dimension] * relationWeight;
    deltas[dimension] = delta * (delta >= 0 ? (100 - relationship[dimension]) / 100 : relationship[dimension] / 100);
  }
  const requestedPositive = Object.values(deltas).reduce((sum, value) => sum + Math.max(0, value), 0);
  const budget = clamp(positiveBudgetRemaining, 0, COMPANION_RELATIONSHIP_DAILY_POSITIVE_LIMIT);
  const positiveScale = requestedPositive ? Math.min(1, budget / requestedPositive) : 1;
  let positiveChange = 0;
  for (const dimension of ['affinity', 'trust', 'respect'] as const) {
    const delta = deltas[dimension] > 0 ? deltas[dimension] * positiveScale : deltas[dimension];
    const next = clamp(relationship[dimension] + delta, 0, 100);
    positiveChange += Math.max(0, next - relationship[dimension]); relationship[dimension] = next;
  }
  return { affect, relationship, positiveChange };
}

/** Transient affect recovers toward neutral; relationships are not forgotten by time alone. */
export function decayCompanionAffect(affect: CompanionAffect, elapsedMs: number): CompanionAffect {
  validateAffect(affect); finite(elapsedMs);
  const elapsed = Math.max(0, elapsedMs);
  return { pleasure: affect.pleasure * Math.pow(0.5, elapsed / (2 * HOUR)),
    arousal: affect.arousal * Math.pow(0.5, elapsed / (0.5 * HOUR)), dominance: affect.dominance * Math.pow(0.5, elapsed / (4 * HOUR)) };
}

export function deriveCompanionMood(affect: CompanionAffect, energy: number, busy = false): CompanionRuntimeState['mood'] {
  validateAffect(affect); finite(energy);
  if (energy <= 25) return 'tired';
  if (affect.pleasure < -0.18 && affect.dominance < 0.1) return 'low';
  if (busy || affect.arousal > 0.18 && affect.dominance > 0.18 && affect.pleasure >= -0.05) return 'focused';
  if (affect.pleasure > 0.18) return 'bright';
  return 'calm';
}

function validateAffect(affect: CompanionAffect): void {
  for (const value of Object.values(affect)) { finite(value); if (value < -1 || value > 1) throw new Error('伙伴情绪维度无效。'); }
}
function validateState(state: AffectState): void {
  validateAffect(state.affect);
  for (const value of Object.values(state.relationship)) { finite(value); if (value < 0 || value > 100) throw new Error('伙伴关系维度无效。'); }
}
function unit(value: number): void { finite(value); if (value < 0 || value > 1) throw new Error('伙伴互动评价强度无效。'); }
function finite(value: number): void { if (!Number.isFinite(value)) throw new Error('伙伴状态数值无效。'); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
