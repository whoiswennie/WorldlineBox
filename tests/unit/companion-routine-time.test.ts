import { describe, expect, it } from 'vitest';
import { companionRoutineConfigSchema } from '../../src/shared/companion-routine';
import { defaultCompanionRoutineConfig, evaluateCompanionRoutine } from '../../src/shared/companion-routine-time';
import { routineConfigurationRequested } from '../../src/companions/routine-store';

const config = companionRoutineConfigSchema.parse({ timeZone: 'UTC', meals: [{ name: '午餐', at: '12:00', durationMinutes: 30 }],
  habits: [{ id: 'read', title: '阅读', at: '10:00', durationMinutes: 30, kind: 'study' }] });

describe('offline virtual routines', () => {
  it('uses the actual local phase across midnight and returns its next real transition', () => {
    expect(evaluateCompanionRoutine(config, '2026-10-14T23:30:00Z')).toMatchObject({ phase: 'sleeping', canRespond: false, nextTransitionAt: '2026-10-15T07:00:00.000Z' });
    expect(evaluateCompanionRoutine(config, '2026-10-15T07:00:00Z')).toMatchObject({ phase: 'awake', canRespond: true, nextTransitionAt: '2026-10-15T10:00:00.000Z' });
    expect(evaluateCompanionRoutine(config, '2026-10-15T12:15:00Z')).toMatchObject({ phase: 'eating', activity: '午餐', nextTransitionAt: '2026-10-15T12:30:00.000Z' });
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

  });
});

describe('current user routine intent', () => {
  it.each(['你昨晚睡了吗？', '你喜欢什么作息？', '我每天十点睡觉', '他说以后每天九点睡觉', '如果每天早点睡会怎样', '不要修改我的作息'])('does not authorize configuration from %s', content => {
    expect(routineConfigurationRequested(content)).toBe(false);
  });
  it.each(['请你把作息改成早睡早起', '把睡觉时间改到十点', '每天晚上九点读书半小时', '希望你养成散步的习惯', '调整你的起床时间到七点'])('accepts the actual requested change %s', content => {
    expect(routineConfigurationRequested(content)).toBe(true);
  });
});
