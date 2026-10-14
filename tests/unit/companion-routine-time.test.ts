import { describe, expect, it } from 'vitest';
import { companionRoutineConfigSchema } from '../../src/shared/companion-routine';
import { advanceCompanionRoutineEnergy, defaultCompanionRoutineConfig, deriveCompanionHabitProgress, evaluateCompanionRoutine } from '../../src/shared/companion-routine-time';
import { routineConfigurationRequested, urgentRoutineRequest } from '../../src/companions/routine-store';

const config = companionRoutineConfigSchema.parse({ timeZone: 'UTC', meals: [{ name: '午餐', at: '12:00', durationMinutes: 30 }],
  habits: [{ id: 'read', title: '阅读', at: '10:00', durationMinutes: 30, kind: 'study' }] });

describe('offline virtual routines', () => {
  it('uses the actual local phase across midnight and returns its next real transition', () => {
    expect(evaluateCompanionRoutine(config, '2026-10-14T23:30:00Z')).toMatchObject({ phase: 'sleeping', canRespond: false, nextTransitionAt: '2026-10-15T07:00:00.000Z' });
    expect(evaluateCompanionRoutine(config, '2026-10-15T07:00:00Z')).toMatchObject({ phase: 'awake', canRespond: true, nextTransitionAt: '2026-10-15T10:00:00.000Z' });
    expect(evaluateCompanionRoutine(config, '2026-10-15T12:15:00Z')).toMatchObject({ phase: 'eating', activity: '午餐', nextTransitionAt: '2026-10-15T12:30:00.000Z' });
  });
  it('integrates awake, sleep and meal phases with intermediate saturation rather than an idle recovery shortcut', () => {
    const meals = { ...config, habits: [], meals: [{ name: '早餐', at: '08:00', durationMinutes: 20 }] };
    expect(advanceCompanionRoutineEnergy(meals, '2026-10-14T22:30:00Z', '2026-10-15T08:30:00Z', 50)).toBeCloseTo(99.2);
    const begin = new Date('2026-10-14T00:00:00Z'), end = new Date('2026-11-13T00:00:00Z');
    let daily = 32;
    for (let day = begin.getTime(); day < end.getTime(); day += 86_400_000) daily = advanceCompanionRoutineEnergy(config, new Date(day), new Date(day + 86_400_000), daily);
    expect(advanceCompanionRoutineEnergy(config, begin, end, 32)).toBeCloseTo(daily, 8);
  });
  it('does not count a habit already underway at creation, but counts completion across later weekly chunk boundaries', () => {
    const weekly = { ...config, habits: [{ ...config.habits[0]!, weekDays: [1] }] };
    expect(deriveCompanionHabitProgress(weekly, '2026-10-12T10:15:00Z', '2026-10-12T10:40:00Z')[0]).toMatchObject({ completedCount: 0, streak: 0, strength: 0 });
    expect(deriveCompanionHabitProgress(weekly, '2026-10-12T10:15:00Z', '2026-11-02T10:40:00Z')[0]).toMatchObject({ completedCount: 3, streak: 3, lastCompletedAt: '2026-11-02T10:30:00.000Z' });
  });
  it('treats an interrupted occurrence as missed and starts the streak again after it', () => {
    const interruptions = [{ start: '2026-10-15T10:10:00Z', end: '2026-10-15T10:20:00Z' }, { start: '2026-10-15T10:12:00Z', end: '2026-10-15T10:25:00Z' }];
    const progress = deriveCompanionHabitProgress(config, '2026-10-14T09:00:00Z', '2026-10-17T11:00:00Z', interruptions)[0]!;
    expect(progress).toMatchObject({ completedCount: 3, streak: 2, lastCompletedAt: '2026-10-17T10:30:00.000Z' });
    expect(progress.strength).toBeGreaterThan(0);
    const atMiss = deriveCompanionHabitProgress(config, '2026-10-14T09:00:00Z', '2026-10-15T11:00:00Z', interruptions)[0]!;
    expect(atMiss).toMatchObject({ completedCount: 1, streak: 0 });
  });
  it('does not count a virtual activity hidden by sleep or a higher priority meal', () => {
    const conflict = { ...config, habits: [{ ...config.habits[0]!, at: '12:10' }] };
    expect(deriveCompanionHabitProgress(conflict, '2026-10-14T00:00:00Z', '2026-10-16T00:00:00Z')[0]).toMatchObject({ completedCount: 0, streak: 0 });
  });
  it('moves a DST gap to the next valid local instant and runs the first overlap occurrence only', () => {
    const dst = { ...config, timeZone: 'America/New_York', sleepAt: '20:00', wakeAt: '01:00', meals: [], habits: [{ ...config.habits[0]!, at: '02:30' }] };
    expect(evaluateCompanionRoutine(dst, '2026-03-08T07:05:00Z')).toMatchObject({ phase: 'habit', activity: '阅读', nextTransitionAt: '2026-03-08T07:30:00.000Z' });
    const overlap = { ...dst, habits: [{ ...dst.habits[0]!, at: '01:30' }] };
    expect(evaluateCompanionRoutine(overlap, '2026-11-01T05:40:00Z').phase).toBe('habit');
    expect(evaluateCompanionRoutine(overlap, '2026-11-01T06:40:00Z').phase).toBe('awake');
  });
  it('uses authored character plans while starting every progress counter at creation', () => {
    const sister = defaultCompanionRoutineConfig('deepseek-sister'), little = defaultCompanionRoutineConfig('deepseek-flash');
    expect(sister.habits.some(habit => habit.title.includes('安静听歌'))).toBe(true);
    expect(little.habits.some(habit => habit.kind === 'exercise')).toBe(true);
    const now = '2026-10-14T00:00:00Z';
    expect(deriveCompanionHabitProgress(sister, now, now).every(habit => habit.completedCount === 0 && habit.strength === 0)).toBe(true);
  });
});

describe('current user routine intent', () => {
  it.each(['你昨晚睡了吗？', '你喜欢什么作息？', '我每天十点睡觉', '他说以后每天九点睡觉', '如果每天早点睡会怎样', '不要修改我的作息'])('does not authorize configuration from %s', content => {
    expect(routineConfigurationRequested(content)).toBe(false);
  });
  it.each(['请你把作息改成早睡早起', '把睡觉时间改到十点', '每天晚上九点读书半小时', '希望你养成散步的习惯', '调整你的起床时间到七点'])('accepts the actual requested change %s', content => {
    expect(routineConfigurationRequested(content)).toBe(true);
  });
  it.each(['不是紧急', '没有急事', '不紧急，你继续睡吧', '假如有人紧急叫你会怎样', '如果有紧急情况会怎么办', '故事里有人喊醒醒', '不要叫醒你', '“紧急帮我处理”'])('does not wake from %s', content => {
    expect(urgentRoutineRequest(content)).toBe(false);
  });
  it('accepts an actual urgent instruction', () => expect(urgentRoutineRequest('别睡了，紧急帮我处理这个故障')).toBe(true));
});
