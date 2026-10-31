import { expect, it } from 'vitest';
import { companionAgendaRuleDraftSchema, companionAgendaRuleSchema } from '../../src/shared/companion-agenda';
import { companionAgendaRoutineRuleDrafts, projectCompanionAgendaRoutine } from '../../src/shared/companion-agenda-routine';
import { companionRoutineConfigSchema } from '../../src/shared/companion-routine';
import { evaluateCompanionRoutine } from '../../src/shared/companion-routine-time';

const at = '2026-10-29T10:00:00.000Z';
function rules() {
  const config = companionRoutineConfigSchema.parse({ timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [{ name: '午餐', at: '12:00', durationMinutes: 30 }],
    habits: [{ id: 'reading', title: '读一会儿书', at: '15:00', durationMinutes: 25, kind: 'study', weekDays: [4] }] });
  return companionAgendaRoutineRuleDrafts(config).map((rule, index) => companionAgendaRuleSchema.parse({ ...rule,
    id: 'body_' + index, companionId: 'alice', revision: 1, origin: 'system', status: 'active', createdAt: at, updatedAt: at }));
}
it('round-trips structured world windows without duplicate start/end fields in the activity payload', () => {
  const source = rules(), projected = projectCompanionAgendaRoutine(source, 'UTC');
  expect(projected.config).toMatchObject({ sleepEnabled: true, sleepAt: '23:00', wakeAt: '07:00', meals: [{ name: '午餐', at: '12:00', durationMinutes: 30 }],
    habits: [{ id: 'body_2', at: '15:00', durationMinutes: 25, kind: 'study', weekDays: [4] }] });
  expect(source[0]!.routine).toEqual({ kind: 'sleep' });
  expect(projected.sources.map(item => ({ id: item.id, revision: item.revision }))).toEqual(source.map(item => ({ id: item.id, revision: item.revision })));
});
it('pausing the sleep window actually removes sleep instead of restoring a hidden default', () => {
  const source = rules(); source[0]!.status = 'paused';
  const { config } = projectCompanionAgendaRoutine(source, 'UTC');
  expect(config.sleepEnabled).toBe(false); expect(evaluateCompanionRoutine(config, '2026-10-29T23:30:00.000Z').phase).toBe('awake');
  expect(projectCompanionAgendaRoutine([], 'UTC').config).toMatchObject({ sleepEnabled: false, meals: [], habits: [] });
});
it('uses the current world timezone while preserving rule source identity', () => {
  const source = rules(), { config, sources } = projectCompanionAgendaRoutine(source, 'Asia/Shanghai');
  expect(config.timeZone).toBe('Asia/Shanghai'); expect(config.sleepAt).toBe('23:00'); expect(sources[0]!.id).toBe('body_0');
  expect(evaluateCompanionRoutine(config, '2026-10-29T16:00:00.000Z').phase).toBe('sleeping');
});
it('rejects body payloads on semantic rules and chance-based body windows', () => {
  const source = rules()[0]!;
  const draft = { title: source.title, intent: source.intent, kind: source.kind, executor: source.executor,
    clock: source.clock, routine: source.routine, trigger: source.trigger, reason: source.reason };
  expect(companionAgendaRuleDraftSchema.safeParse({ ...draft, executor: 'brain' }).success).toBe(false);
  expect(companionAgendaRuleDraftSchema.safeParse({ ...draft, clock: 'real' }).success).toBe(false);
  expect(companionAgendaRuleDraftSchema.safeParse({ ...draft, trigger: { ...draft.trigger, probability: .4 } }).success).toBe(false);
});
it('rejects overlapping daily sleep definitions and invalid meal durations instead of silently truncating', () => {
  const source = rules();
  expect(() => projectCompanionAgendaRoutine([...source, { ...source[0]!, id: 'other_sleep' }], 'UTC')).toThrow('重复');
  const meal = source[1]!;
  expect(companionAgendaRuleDraftSchema.safeParse({ title: meal.title, intent: meal.intent, kind: meal.kind, executor: meal.executor,
    clock: meal.clock, routine: meal.routine, trigger: { kind: 'window', startMinute: 720, endMinute: 1000, timeZone: 'UTC', probability: 1 }, reason: meal.reason }).success).toBe(false);
});
