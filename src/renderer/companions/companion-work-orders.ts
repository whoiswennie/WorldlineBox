import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionWorkOrder } from '../../shared/companion-work-order';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { ScheduleRequest } from './companion-schedules';

export const WORK_ORDER_STATUS: Record<CompanionWorkOrder['status'], string> = {
  offered: '待接受', accepted: '等待处理', running: '进行中', paused: '已暂停', completed: '已完成', failed: '未完成', cancelled: '已取消',
};
export function activeWorkOrder(order: CompanionWorkOrder) { return ['offered', 'accepted', 'running', 'paused'].includes(order.status); }

export function useCompanionWorkOrders(companionId: string, conversationId: string, request: ScheduleRequest, api?: WorldlineBoxCompanionsApi, includeHistory = false, limit = 40) {
  const [orders, setOrders] = useState<CompanionWorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const before = useRef<number | undefined>(undefined), epoch = useRef(0), paging = useRef(false);
  const load = useCallback(async (append = false) => {
    if (append && (paging.current || before.current === undefined)) return;
    const current = append ? epoch.current : ++epoch.current;
    if (append) { paging.current = true; setLoadingMore(true); }
    try {
      const response = await request({ type: 'work-order.list', companionId, conversationId, includeHistory, limit, ...(append ? { before: before.current } : {}) });
      if (current !== epoch.current) return;
      if (!response?.workOrderPage) { setError(response?.error || '工作暂时无法读取，请刷新重试。'); return; }
      const page = response.workOrderPage;
      setOrders(previous => append ? [...new Map([...previous, ...page.items].map(order => [order.id, order])).values()] : page.items);
      before.current = page.nextBefore; setHasMore(page.hasMore); setError('');
    } catch (cause) { if (current === epoch.current) setError(cause instanceof Error ? cause.message : '工作暂时无法读取。'); }
    finally { if (current === epoch.current) { setLoading(false); setLoadingMore(false); } paging.current = false; }
  }, [companionId, conversationId, request, includeHistory, limit]);
  useEffect(() => { const counter = epoch; void Promise.resolve().then(() => load()); return () => { counter.current++; }; }, [load]);
  useEffect(() => { let timer: ReturnType<typeof setTimeout> | undefined; const unsubscribe = api?.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => void load(), 200); }); return () => { unsubscribe?.(); clearTimeout(timer); }; }, [api, load]);
  return { orders, loading, loadingMore, hasMore, error, refresh: () => load(), loadMore: () => load(true) };
}
