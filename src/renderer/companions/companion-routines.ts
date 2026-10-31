import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CompanionRoutine } from '../../shared/companion-routine';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { ScheduleRequest } from './companion-schedules';
import { createCoalescedRefresh } from './coalesced-refresh';

export function useCompanionRoutine(companionId: string, conversationId: string, request: ScheduleRequest, api?: WorldlineBoxCompanionsApi, active = true) {
  const [snapshot, setRoutine] = useState<{ scope: string; routine: CompanionRoutine }>();
  const [failure, setError] = useState<{ scope: string; message: string }>();
  const scope = companionId + '/' + conversationId;
  const routine = active && snapshot?.scope === scope && snapshot.routine.companionId === companionId ? snapshot.routine : undefined;
  const error = failure?.scope === scope ? failure.message : '';
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    if (!active) return;
    const current = ++epoch.current;
    const response = await request({ type: 'routine.get', companionId, conversationId });
    if (current !== epoch.current) return;
    if (response?.ok && response.routine?.companionId === companionId) { setRoutine({ scope, routine: response.routine }); setError(undefined); }
    else { setRoutine(undefined); setError({ scope, message: '暂时无法读取作息。' }); }
  }, [companionId, conversationId, request, scope, active]);
  useLayoutEffect(() => {
    if (!active) return;
    const currentEpoch = epoch, reads = createCoalescedRefresh(refresh, undefined, 200);
    void reads.trigger();
    const unsubscribe = api?.onChanged(change => {
      if (change?.kind !== 'progress') { ++currentEpoch.current; setRoutine(undefined); setError(undefined); }
      void reads.trigger();
    });
    return () => { ++currentEpoch.current; setRoutine(undefined); setError(undefined); reads.dispose(); unsubscribe?.(); };
  }, [active, api, refresh]);
  return { routine, error, refresh };
}

export function routineClock(date: Date, timeZone: string) {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone !== 'system' ? { timeZone } : {}) };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', options).formatToParts(date).map(part => [part.type, part.value]));
  const weekday = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`).getUTCDay();
  return { day: `${parts.year}-${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}`, weekday };
}

export function routineAgenda(routine: CompanionRoutine, date: Date) {
  const { weekday } = routineClock(date, routine.config.timeZone);
  return [{ id: 'wake', at: routine.config.wakeAt, title: '醒来，开始新的一天' },
    ...routine.config.meals.map((meal, index) => ({ id: 'meal-' + index, at: meal.at, title: meal.name })),
    ...routine.config.habits.filter(habit => !habit.weekDays || habit.weekDays.includes(weekday)).map(habit => ({ id: habit.id, at: habit.at, title: habit.title })),
    { id: 'sleep', at: routine.config.sleepAt, title: '晚安，休息一下' }].sort((a, b) => a.at.localeCompare(b.at));
}
