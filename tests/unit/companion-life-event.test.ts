import { describe, expect, it } from 'vitest';
import { companionLifeHazard, companionLifeMultiplier, companionLifeThreshold, companionLifeRuleDraftSchema } from '../../src/shared/companion-life-event';
import { lifeWindow } from '../../src/companions/life-event-store';

describe('state dependent integrated life-event hazard', () => {
  it('has the configured baseline distribution and is independent of timer frequency', () => {
    const probability = .4, window = 4 * 3600000;
    const whole = companionLifeHazard(probability, window, window, 1);
    const pieces = Array.from({ length: 1000 }, () => companionLifeHazard(probability, window, window / 1000, 1)).reduce((a, b) => a + b, 0);
    expect(pieces).toBeCloseTo(whole, 12);
    const frequency = Array.from({ length: 20000 }, (_, index) => companionLifeThreshold('independent-life-' + index)).filter(threshold => threshold <= whole).length / 20000;
    expect(frequency).toBeCloseTo(probability, 1); expect(Math.abs(frequency - probability)).toBeLessThan(.012);
  });
  it('gates unavailable actors and raises social propensity with energy, affect, affinity and trust', () => {
    const base = { energy: 60, pleasure: 0, arousal: 0, affinity: 50, trust: 50, action: 'message' as const, available: true };
    expect(companionLifeMultiplier(base)).toBe(1);
    expect(companionLifeMultiplier({ ...base, available: false })).toBe(0);
    for (const patch of [{ energy: 90 }, { pleasure: .6 }, { affinity: 80 }, { trust: 80 }, { expression: 'playful' }]) expect(companionLifeMultiplier({ ...base, ...patch })).toBeGreaterThan(1);
    expect(companionLifeMultiplier({ ...base, action: 'rest', energy: 10 })).toBeGreaterThan(companionLifeMultiplier({ ...base, action: 'rest', energy: 90 }));
    expect(companionLifeHazard(0, 1000, 500, 4)).toBe(0);
  });
  it('retains the same exponential threshold across process restarts and world date rollback', () => {
    expect(companionLifeThreshold('rule_a/2026-10-15T10:00Z')).toBe(companionLifeThreshold('rule_a/2026-10-15T10:00Z'));
    expect(companionLifeThreshold('rule_a/2026-10-15T10:00Z')).not.toBe(companionLifeThreshold('rule_b/2026-10-15T10:00Z'));
  });
  it('makes long park strolls conditional on actual outdoor safety, energy and emotional regulation need', () => {
    const base = { action: 'park_walk' as const, available: true, energy: 70, pleasure: 0, arousal: 0, affinity: 50, trust: 50, thermalComfort: 1, weather: 'clear' as const, outdoorTemperature: 22 };
    expect(companionLifeMultiplier(base)).toBe(1);
    for (const patch of [{ energy: 25 }, { available: false }, { weather: 'rain' }, { weather: 'snow' }, { outdoorTemperature: 35 }, { thermalComfort: 0 }] as const) expect(companionLifeMultiplier({ ...base, ...patch })).toBe(0);
    expect(companionLifeMultiplier({ ...base, energy: 30 })).toBeLessThan(.1);
    expect(companionLifeMultiplier({ ...base, pleasure: -.6, arousal: .5 })).toBeGreaterThan(1);
    expect(companionLifeMultiplier({ ...base, expression: 'playful' })).toBeGreaterThan(companionLifeMultiplier({ ...base, expression: 'reserved' }));
    const rule = { title: '公园散步', startMinute: 900, endMinute: 1080, probability: .55, action: 'park_walk', durationMinutes: 35 };
    expect(companionLifeRuleDraftSchema.safeParse(rule).success).toBe(true);
    for (const patch of [{ durationMinutes: 9 }, { durationMinutes: 121 }, { targetId: 'user' }, { action: 'rest' }]) expect(companionLifeRuleDraftSchema.safeParse({ ...rule, ...patch }).success).toBe(false);
  });
  it('resolves cross-midnight and DST civil windows without using the host timezone', () => {
    const overnight = lifeWindow(Date.parse('2026-10-15T01:00:00Z'), 23 * 60, 2 * 60, 'UTC');
    expect(overnight).toEqual({ start: Date.parse('2026-10-14T23:00:00Z'), end: Date.parse('2026-10-15T02:00:00Z') });
    expect(lifeWindow(Date.parse('2026-10-15T03:00:00Z'), 23 * 60, 2 * 60, 'UTC')).toBeUndefined();
    const dst = lifeWindow(Date.parse('2026-03-08T07:30:00Z'), 60, 240, 'America/New_York');
    expect(dst!.end - dst!.start).toBe(2 * 3600000);
  });
});
