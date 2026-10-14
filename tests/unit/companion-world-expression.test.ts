import { describe, expect, it } from 'vitest';
import { companionWorldExpression } from '../../src/shared/companion-world-expression';
import type { CompanionWorldActor, CompanionWorldEvent } from '../../src/shared/companion-world';

const now = Date.parse('2026-10-14T14:00:00Z');
const calm: CompanionWorldActor['state'] = { energy: 80, mood: 'calm', expression: 'gentle',
  affect: { pleasure: 0, arousal: 0, dominance: 0 }, thermalComfort: 1 };
const reaction = (state: CompanionWorldActor['state'], pose: CompanionWorldActor['artAction'] = 'idle', events: CompanionWorldEvent[] = []) =>
  companionWorldExpression({ companionId: 'alice', pose, state, events, now });
const event = (kind: string, actorId: string, targetId: string, age = 500): CompanionWorldEvent => ({ id: 'event', sequence: 1,
  at: new Date(now - age).toISOString(), realAt: new Date(now - age).toISOString(), kind, actorId, targetId, text: '可见的实际世界事件', simulation: true });

describe('host world expressions remain consistent with real activity', () => {
  it('keeps bed, seated work, meals and movement poses even during strong emotion', () => {
    const upset = { ...calm, mood: 'low' as const, affect: { pleasure: -.8, arousal: .7, dominance: .6 } };
    for (const pose of ['sleep', 'work', 'eat', 'sitDown', 'standUp', 'lieDown', 'wake', 'run'] as const)
      expect(reaction(upset, pose, [event('visit_request', 'bob', 'alice')]).action).toBe(pose);
  });
  it('distinguishes withdrawn low arousal from high arousal frustration using the same PAD state as the brain', () => {
    expect(reaction({ ...calm, mood: 'low', affect: { pleasure: -.6, arousal: -.3, dominance: -.2 } }).action).toBe('sad');
    expect(reaction({ ...calm, mood: 'low', affect: { pleasure: -.6, arousal: .6, dominance: .4 } }).action).toBe('angry');
    expect(reaction({ ...calm, affect: { pleasure: .5, arousal: .3, dominance: .1 } }).action).toBe('pleased');
    expect(reaction({ ...calm, energy: 18, mood: 'bright' }).action).toBe('tired');
  });
  it('reacts to a current incoming visit and uses the actual event start', () => {
    const visit = event('visit_request', 'bob', 'alice');
    expect(reaction(calm, 'idle', [visit])).toEqual({ action: 'surprised', startedAtReal: visit.realAt });
    expect(reaction(calm, 'idle', [event('visit_request', 'alice', 'bob')]).action).toBe('idle');
  });
  it('does not replay old, future or withdrawn events when opening a saved world', () => {
    expect(reaction(calm, 'idle', [event('visit_request', 'bob', 'alice', 10_000)]).action).toBe('idle');
    expect(reaction(calm, 'idle', [event('visit_request', 'bob', 'alice', -1)]).action).toBe('idle');
    expect(reaction(calm, 'idle', []).action).toBe('idle');
  });
  it('animates only the actual speaker, without treating the later appraisal as another utterance', () => {
    expect(reaction(calm, 'idle', [event('social_talk', 'alice', 'bob')]).action).toBe('communicate');
    expect(reaction(calm, 'idle', [event('social_talk', 'bob', 'alice')]).action).toBe('idle');
    expect(reaction(calm, 'idle', [event('social_appraisal', 'alice', 'bob')]).action).toBe('idle');
  });
});
