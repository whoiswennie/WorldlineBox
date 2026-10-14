import { describe, expect, it } from 'vitest';
import { applyCompanionAppraisal, decayCompanionAffect, deriveCompanionMood } from '../../src/shared/companion-affect';

const neutral = { affect: { pleasure: 0, arousal: 0, dominance: 0 }, relationship: { affinity: 50, trust: 50, respect: 50 } };
const support = { type: 'support' as const, target: 'user' as const, intensity: 1, confidence: 1 };
describe('host-owned PAD and relationship updates', () => {
  it('keeps routine neutral interactions from farming affinity, trust or respect', () => {
    let state = neutral;
    for (let i = 0; i < 500; i++) state = applyCompanionAppraisal(state, { ...support, type: 'neutral' }, 0, 6);
    expect(state.affect).toEqual(neutral.affect);
    expect(state.relationship).toEqual(neutral.relationship);
  });
  it('uses actual support/hostility as opposite impulses rather than accepting a replacement mood', () => {
    const positive = applyCompanionAppraisal(neutral, support, 0, 6);
    const negative = applyCompanionAppraisal(neutral, { ...support, type: 'hostility' }, 0, 6);
    expect(positive.affect.pleasure).toBeGreaterThan(0);
    expect(positive.relationship.affinity).toBeGreaterThan(50);
    expect(negative.affect.pleasure).toBeLessThan(0);
    expect(negative.relationship.trust).toBeLessThan(50);
    expect(deriveCompanionMood(negative.affect, 90)).toBe('low');
    expect(negative.positiveChange).toBe(0);
  });
  it.each(['task', 'self', 'other'] as const)('does not penalize the user for a disappointment attributed to %s', target => {
    const result = applyCompanionAppraisal(neutral, { ...support, type: 'disappointment', target }, 0, 6);
    expect(result.affect.pleasure).toBeLessThan(0);
    expect(result.relationship).toEqual(neutral.relationship);
    expect(result.positiveChange).toBe(0);
  });
  it('does not promote uncertain attribution into affect or relationship changes', () => {
    expect(applyCompanionAppraisal(neutral, { ...support, type: 'hostility', confidence: 0.64 }, 0, 6)).toMatchObject(neutral);
  });
  it('caps aggregate daily positive relationship points without preventing a real emotional response', () => {
    let state = neutral, used = 0;
    for (let i = 0; i < 100; i++) {
      const result = applyCompanionAppraisal(state, support, 0, 6 - used); used += result.positiveChange; state = result;
    }
    expect(used).toBeCloseTo(6, 8);
    expect(Object.values(state.relationship).reduce((sum, value) => sum + value, 0) - 150).toBeCloseTo(6, 8);
    expect(state.affect.pleasure).toBeGreaterThan(0);
    const exhausted = applyCompanionAppraisal(neutral, support, 0, 0);
    expect(exhausted.relationship).toEqual(neutral.relationship);
    expect(exhausted.affect.pleasure).toBeGreaterThan(0);
  });
  it('slows positive changes near saturation and keeps every component inside its range', () => {
    const high = applyCompanionAppraisal({ ...neutral, relationship: { affinity: 99, trust: 99, respect: 99 } }, support, 0, 6);
    const low = applyCompanionAppraisal({ ...neutral, relationship: { affinity: 10, trust: 10, respect: 10 } }, support, 0, 6);
    expect(high.positiveChange).toBeLessThan(low.positiveChange);
    const edge = applyCompanionAppraisal({ affect: { pleasure: 1, arousal: -1, dominance: 1 }, relationship: { affinity: 100, trust: 100, respect: 100 } }, support, 0, 6);
    expect(Object.values(edge.affect).every(value => value >= -1 && value <= 1)).toBe(true);
    expect(Object.values(edge.relationship).every(value => value >= 0 && value <= 100)).toBe(true);
  });
  it('attenuates a late appraisal instead of replacing newer feelings or trust', () => {
    const timely = applyCompanionAppraisal(neutral, support, 0, 6);
    const delayed = applyCompanionAppraisal(neutral, support, 7 * 86_400_000, 6);
    expect(delayed.affect.pleasure).toBeLessThan(timely.affect.pleasure);
    expect(delayed.positiveChange).toBeLessThan(timely.positiveChange);
    const newer = { ...neutral, affect: { pleasure: -0.7, arousal: 0.8, dominance: -0.3 } };
    expect(applyCompanionAppraisal(newer, support, 7 * 86_400_000, 6).affect.pleasure).toBeLessThan(-0.69);
  });
  it('decays transient affect while preserving sign and lets arousal settle sooner', () => {
    const recovered = decayCompanionAffect({ pleasure: -0.8, arousal: 0.8, dominance: -0.8 }, 2 * 3_600_000);
    expect(recovered.pleasure).toBeLessThan(0);
    expect(recovered.arousal).toBeGreaterThan(0);
    expect(Math.abs(recovered.arousal)).toBeLessThan(Math.abs(recovered.pleasure));
    expect(Math.abs(recovered.pleasure)).toBeLessThan(Math.abs(recovered.dominance));
  });
  it('derives tired/focused/bright moods from host affect and energy', () => {
    expect(deriveCompanionMood({ pleasure: 0.8, arousal: 0.4, dominance: 0.4 }, 15)).toBe('tired');
    expect(deriveCompanionMood({ pleasure: 0, arousal: 0, dominance: 0 }, 90, true)).toBe('focused');
    expect(deriveCompanionMood({ pleasure: 0.4, arousal: 0, dominance: 0 }, 90)).toBe('bright');
    expect(deriveCompanionMood({ pleasure: 0, arousal: 0, dominance: 0 }, 90)).toBe('calm');
  });
});
