import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionSchedule, CompanionScheduleOccurrence } from '../../shared/companion-schedule';
import type { CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../shared/companions';

export type ScheduleRequest = (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
export const RECURRENCE_LABELS: Record<CompanionSchedule['recurrence'], string> = { once: '仅这一次', daily: '每天', weekly: '每周', monthly: '每月', interval: '按间隔' };
export function scheduleTime(value: string) { const date = new Date(value); return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
export function localDateKey(value: string | number) { const date = new Date(value); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
export function scheduleStatus(schedule: CompanionSchedule): string {
  if (schedule.status === 'cancelled') return '已取消';
  if (schedule.status === 'paused') return '已暂停';
  if (schedule.blockedReason === 'resting') return '稍后执行';
  if (schedule.blockedReason === 'unavailable') return '等待连接';
  if (schedule.lastOccurrenceStatus === 'running' || schedule.lastOccurrenceStatus === 'dispatching') return '正在执行';
  if (schedule.lastOccurrenceStatus === 'pending') return '等待执行';
  if (schedule.recurrence === 'once' && !schedule.nextRunAt && schedule.lastOccurrenceStatus === 'done') return '已完成';
  if (schedule.lastOccurrenceStatus === 'failed') return '上次失败';
  return '已安排';
}

export function useCompanionSchedules(companionId: string, conversationId: string, request: ScheduleRequest, api?: WorldlineBoxCompanionsApi) {
  const [schedules, setSchedules] = useState<CompanionSchedule[]>([]);
  const [occurrences, setOccurrences] = useState<CompanionScheduleOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setError] = useState<{ scope: string; message: string }>();
  const scope = companionId + '/' + conversationId;
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const current = ++epoch.current;
    const response = await request({ type: 'schedule.list', companionId, conversationId, includeHistory: true, limit: 100 });
    if (current !== epoch.current) return;
    setLoading(false);
    if (response?.schedules) { setSchedules(response.schedules); setOccurrences(response.scheduleOccurrences ?? []); setError(undefined); }
    else setError({ scope, message: '安排暂时无法读取，请刷新重试。' });
  }, [request, companionId, conversationId, scope]);
  useEffect(() => { const currentEpoch = epoch; void Promise.resolve().then(load); return () => { currentEpoch.current++; }; }, [load]);
  useEffect(() => { let timer: ReturnType<typeof setTimeout> | undefined; const unsubscribe = api?.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => void load(), 200); }); return () => { unsubscribe?.(); clearTimeout(timer); }; }, [api, load]);
  return { schedules: schedules.filter(item => item.companionId === companionId && item.conversationId === conversationId),
    occurrences: occurrences.filter(item => item.companionId === companionId && item.conversationId === conversationId), loading, error: failure?.scope === scope ? failure.message : '', refresh: load };
}
