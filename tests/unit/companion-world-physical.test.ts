import { describe, expect, it } from 'vitest';
import { advanceCompanionWorldEnergy, deriveCompanionWorldHabitProgress } from '../../src/shared/companion-world-engine';
import { companionRoutineConfigSchema } from '../../src/shared/companion-routine';
const at = (value: string) => Date.parse(value), identity = (value: number) => value;
const config = companionRoutineConfigSchema.parse({ timeZone: 'UTC', meals: [], habits: [{ id: 'read', title: '阅读', at: '10:00', durationMinutes: 30, kind: 'study' }] });
describe('authoritative physical participation', () => {
  it('does not grant sleep recovery for the time still spent walking to the bed', () => {
    const from = at('2026-10-14T23:00:00Z'), to = at('2026-10-15T00:15:00Z');
    expect(advanceCompanionWorldEnergy([{ start: at('2026-10-15T00:00:00Z'), end: at('2026-10-15T00:10:00Z'), phase: 'sleeping' }], from, to, 50, identity)).toBeCloseTo(47.8);
    expect(advanceCompanionWorldEnergy([], from, to, 50, identity)).toBeCloseTo(44);
  });
  it('counts actual practiced time across interrupted sessions and never counts an unvisited planned occurrence', () => {
    expect(deriveCompanionWorldHabitProgress(config, [], at('2026-10-17T11:00:00Z'), identity, identity)[0]).toMatchObject({ completedCount: 0, practicedMinutes: 0, strength: 0, streak: 0 });
    const windows = [{ start: at('2026-10-14T10:05:00Z'), end: at('2026-10-14T10:25:00Z'), phase: 'habit' as const, habitId: 'read', habitKind: 'study' as const },
      { start: at('2026-10-15T10:10:00Z'), end: at('2026-10-15T10:30:00Z'), phase: 'habit' as const, habitId: 'read', habitKind: 'study' as const }];
    expect(deriveCompanionWorldHabitProgress(config, windows, at('2026-10-15T11:00:00Z'), identity, identity)[0]).toMatchObject({ completedCount: 1, practicedMinutes: 40, streak: 2, lastCompletedAt: '2026-10-15T10:20:00.000Z' });
  });
  it('integrates saturation in chronological order and uses virtual time for actual participation', () => {
    const begin = at('2026-10-14T00:00:00Z'), end = begin + 120000;
    const virtual = (real: number) => begin + (real - begin) * 72;
    const windows = [{ start: begin, end: begin + 60000, phase: 'sleeping' as const }];
    expect(advanceCompanionWorldEnergy(windows, begin, end, 90, virtual)).toBeCloseTo(94.24);
  });
});
