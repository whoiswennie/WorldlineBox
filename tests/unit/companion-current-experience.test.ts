import { describe, expect, it } from 'vitest';
import { companionRuntimeStateSchema, companionStateProposalSchema } from '../../src/shared/companion-state';
import { companionCurrentExperienceSchema } from '../../src/shared/companion-current-experience';
import { companionQualitativeBehavior } from '../../src/shared/companion-affect';
import { companionLifeMultiplier } from '../../src/shared/companion-life-event';
import { companionWorldExpression } from '../../src/shared/companion-world-expression';

const at = '2026-10-28T00:00:00Z';
const experience = companionCurrentExperienceSchema.parse({ type: 'current_experience', id: 'experience', companionId: 'alice',
  sourceConversationId: 'private', sourceMessageIds: ['self'], sourceVersions: [{ messageId: 'self', revision: 1, checksum: 'a'.repeat(64) }],
  occurredAt: at, recordedAt: at, revision: 1, situation: '刚结束一次需要核实结果的工作。', statement: '我想先安静核对结果。',
  uncertainty: '还未知道全部结果。', responsePreference: '先说已核实部分。', reassessWhen: ['结果核对完成后。'], visibleExpression: 'troubled' });

describe('qualitative current experience and behavioral consumers', () => {
  it('rejects the old numeric runtime and appraisal protocols instead of converting scores into labels', () => {
    const state = { schema: 'companion-runtime-qualitative-v1', companionId: 'alice', energy: 80, expression: 'direct', relationshipRecords: [], updatedAt: at, revision: 1 };
    expect(companionRuntimeStateSchema.parse(state)).toEqual(state);
    for (const old of [{ affect: { pleasure: 0, arousal: 0, dominance: 0 } }, { relationship: { affinity: 80, trust: 80, respect: 80 } }, { familiarity: { stage: 'close', interactionCount: 500 } }, { mood: 'bright' }])
      expect(companionRuntimeStateSchema.safeParse({ ...state, ...old }).success).toBe(false);
    expect(companionStateProposalSchema.safeParse({ reason: '一次交流', sourceMessageIds: ['self'], evidence: [{ sourceMessageId: 'self', quote: '我想先核对' }],
      appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] }).success).toBe(false);
  });
  it('keeps factual resource constraints while numeric psychology cannot alter delivery or initiative', () => {
    const base = { energy: 80, expression: 'direct', experience, relationshipRecords: [] };
    const low = { ...base, mood: 'low', affect: { pleasure: -1, arousal: 1, dominance: -1 }, relationship: { affinity: 0, trust: 0, respect: 0 }, familiarity: { stage: 'new' } };
    const high = { ...base, mood: 'bright', affect: { pleasure: 1, arousal: -1, dominance: 1 }, relationship: { affinity: 100, trust: 100, respect: 100 }, familiarity: { stage: 'close' } };
    expect(companionQualitativeBehavior(low)).toEqual(companionQualitativeBehavior(high));
    expect(companionQualitativeBehavior(base)).toMatchObject({ responsePreference: '先说已核实部分。', uncertainty: '还未知道全部结果。' });
    expect(companionQualitativeBehavior({ ...base, energy: 10 }).responseLength).toBe('brief');
  });
  it('does not weight life opportunities by old affect, relationship or expression numbers', () => {
    const base = { energy: 80, action: 'message' as const, available: true };
    expect(companionLifeMultiplier({ ...base, ...{ pleasure: -1, arousal: 1, affinity: 0, trust: 0, expression: 'reserved' } }))
      .toBe(companionLifeMultiplier({ ...base, ...{ pleasure: 1, arousal: 0, affinity: 100, trust: 100, expression: 'playful' } }));
    expect(companionLifeMultiplier({ ...base, available: false })).toBe(0);
    expect(companionLifeMultiplier({ ...base, action: 'park_walk', weather: 'rain', outdoorTemperature: 4 })).toBe(0);
  });
  it('shows an explicit current expression without inferring anger or happiness from hidden numeric fields', () => {
    const base = { companionId: 'alice', pose: 'idle' as const, events: [], now: Date.parse(at) + 1000 };
    const old = { energy: 80, affect: { pleasure: -1, arousal: 1, dominance: 1 }, mood: 'low' };
    expect(companionWorldExpression({ ...base, state: old })).toEqual({ action: 'idle' });
    expect(companionWorldExpression({ ...base, state: { energy: 80, experience } }).action).toBe('troubled');
    expect(companionWorldExpression({ ...base, state: { energy: 80, experience: { ...experience, companionId: 'bob' } } }).action).toBe('idle');
    expect(companionWorldExpression({ ...base, state: { energy: 80, experience: { ...experience, validUntil: at } } }).action).toBe('idle');
  });
});
