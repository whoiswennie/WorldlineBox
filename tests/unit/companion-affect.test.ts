import { describe, expect, it } from 'vitest';
import { companionQualitativeBehavior } from '../../src/shared/companion-affect';
import { companionCurrentExperienceSchema } from '../../src/shared/companion-current-experience';

const state = { energy: 80, expression: 'gentle' as const, relationshipRecords: [] };
describe('qualitative companion behavior', () => {
  it('uses actual resource limits without automatically assigning intimacy or personality stages', () => {
    const behavior = companionQualitativeBehavior(state);
    expect(behavior).toMatchObject({ responseLength: 'contextual', topicExpansion: 'contextual', normalRequestsRemainAvailable: true,
      initiative: 'consider_current_goals_availability_and_actual_relationship_events', boundaryStyle: 'consider_specific_current_agreements_and_boundaries' });
    expect(companionQualitativeBehavior({ ...state, energy: 20 })).toMatchObject({ responseLength: 'brief', topicExpansion: 'limited' });
  });
  it('projects explicit current self-expression without measuring it as a psychological score', () => {
    const experience = companionCurrentExperienceSchema.parse({ id: 'experience', type: 'current_experience', companionId: 'alice', sourceConversationId: 'room',
      sourceMessageIds: ['source'], sourceVersions: [{ messageId: 'source', revision: 1, checksum: 'a'.repeat(64) }], occurredAt: '2026-10-28T00:00:00Z', recordedAt: '2026-10-28T00:00:00Z', revision: 1,
      situation: '正在核实一个安排。', statement: '我暂时不确定。', responsePreference: '先问清楚范围。', uncertainty: '尚未验证结果。', reassessWhen: ['验证以后。'] });
    expect(companionQualitativeBehavior({ ...state, experience })).toMatchObject({ responsePreference: '先问清楚范围。', uncertainty: '尚未验证结果。', currentExperienceIsSelfReport: true });
  });
  it('does not consume old numeric psychology or interaction stages', () => {
    const low = { ...state, affect: { pleasure: -1, arousal: -1, dominance: -1 }, relationship: { affinity: 0, trust: 0, respect: 0 }, familiarity: { stage: 'new', interactionCount: 0 } };
    const high = { ...state, affect: { pleasure: 1, arousal: 1, dominance: 1 }, relationship: { affinity: 100, trust: 100, respect: 100 }, familiarity: { stage: 'close', interactionCount: 10000 } };
    expect(companionQualitativeBehavior(low)).toEqual(companionQualitativeBehavior(high));
    expect(JSON.stringify(companionQualitativeBehavior(high))).not.toContain('10000');
  });
});
