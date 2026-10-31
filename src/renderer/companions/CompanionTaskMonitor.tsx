import { useEffect, useRef, useState } from 'react';
import type { Companion, CompanionAction, CompanionActionPage } from '../../shared/companions';
import type { CompanionRequest } from './CompanionDialogs';
import { Avatar } from './CompanionVisuals';
import { CompanionActionCard } from './CompanionProgress';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { companionTimestamp, companionTimezone } from '../../shared/companion-time';
import type { WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { companionProgressEvent, mergeCompanionProgress } from '../../shared/companion-progress';
import type { CompanionActionEvent } from '../../shared/companions';
import { COMPANION_WORK_PHASE_LABELS, companionWorkOverview, companionWorkPhase } from './companion-work-overview';
import { dshRecordQuerySchema } from '../../shared/dsh-task-record';
import { createCoalescedRefresh } from './coalesced-refresh';
import { companionCapabilityTitle } from './companion-capability-presentation';

type Cursor = NonNullable<CompanionActionPage['nextCursor']>;
const PAGE_SIZE = 20;
const running = (action: CompanionAction) => ['queued', 'running'].includes(action.status);

/** Paged durable history and independent live streams within this conversation. */
export function CompanionTaskMonitor({ actions, companions, conversationId, request, dshApi, initialActionId, initialView = 'history', initialCompanionId = '', now, onClose, onStop, onGuide, onResume, onTerminate, onOpenUrl }: {
  actions: CompanionAction[]; companions: Companion[]; conversationId: string; request: CompanionRequest; now: number; onClose(): void;
  onStop(id: string): void; onGuide(id: string): void; onOpenUrl(url: string): void;
  dshApi?: WorldlineBoxDshLauncherApi; initialActionId?: string; initialView?: 'active' | 'history'; initialCompanionId?: string; onResume?(id: string): void | Promise<unknown>; onTerminate?(id: string): void | Promise<unknown>;
}) {
  useDialogFocusTrap(true, '伙伴实时任务');
  const [owner, setOwner] = useState(initialCompanionId);
  const [view, setView] = useState(initialView);
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const [pageNumber, setPageNumber] = useState(0);
  const [page, setPage] = useState<CompanionActionPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialActionId);
  const linkedSelection = useRef(initialActionId);
  const [detail, setDetail] = useState<CompanionAction>();
  const [detailError, setDetailError] = useState('');
  const streams = useRef(new Map<string, CompanionActionEvent[]>());
  const live = actions.find(action => action.id === selectedId);
  const stored = detail?.id === selectedId ? detail : undefined;
  const selected = live && stored ? { ...(live.updatedAt >= stored.updatedAt ? live : stored), events: mergeCompanionProgress(stored.events ?? [], live.events ?? []) } : live ?? stored;
  const selectedStatus = selected?.status ?? page?.items.find(action => action.id === selectedId)?.status;
  useEffect(() => dshApi?.onTaskEvent?.(event => {
    const progress = companionProgressEvent(event);
    if (!progress) return;
    streams.current.set(event.taskId, mergeCompanionProgress(streams.current.get(event.taskId) ?? [], [progress]));
    while (streams.current.size > 20) streams.current.delete(streams.current.keys().next().value!);
    setDetail(current => current?.taskId === event.taskId ? { ...current, events: mergeCompanionProgress(current.events ?? [], [progress]) } : current);
  }), [dshApi]);
  const cursor = cursors[pageNumber];
  const revision = actions.map(action => action.id + '/' + action.status).join(',');
  const overview = companionWorkOverview(actions, owner || undefined);
  const activeItems = overview.items.slice(pageNumber * PAGE_SIZE, (pageNumber + 1) * PAGE_SIZE).map(item => item.action);
  const firstActiveId = activeItems[0]?.id, activeCount = overview.total;
  const items = view === 'active' ? activeItems : page?.items ?? [];
  useEffect(() => {
    if (view !== 'active') return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(false);
      if (pageNumber > 0 && pageNumber * PAGE_SIZE >= activeCount) setPageNumber(Math.max(0, Math.ceil(activeCount / PAGE_SIZE) - 1));
      setSelectedId(current => current ?? firstActiveId);
    });
    return () => { cancelled = true; };
  }, [view, firstActiveId, activeCount, owner, pageNumber, refresh]); // Progress tokens do not change list selection.
  useEffect(() => {
    if (view !== 'history' || initialActionId) return;
    let cancelled = false;
    void request({ type: 'actions.page', conversationId, ...(owner ? { companionId: owner } : {}), ...(cursor ? { before: cursor } : {}), limit: PAGE_SIZE }).then(response => {
      if (cancelled) return;
      setLoading(false);
      if (!response?.actionPage) { setError('任务记录读取失败，请重试。'); return; }
      setError(''); setPage(response.actionPage);
      setSelectedId(current => current && (current === linkedSelection.current || response.actionPage!.items.some(item => item.id === current)) ? current : response.actionPage!.items[0]?.id);
    });
    return () => { cancelled = true; };
  }, [conversationId, owner, cursor, request, refresh, revision, view, initialActionId]);
  useEffect(() => {
    let cancelled = false;
    if (!selectedId) return;
    const reads = createCoalescedRefresh(async () => {
      const response = await request({ type: 'action.get', id: selectedId });
      if (cancelled) return;
      if (response?.action?.conversationId === conversationId) { const action = response.action; setDetail({ ...action, events: mergeCompanionProgress(action.events ?? [], streams.current.get(action.taskId ?? '') ?? []) }); setDetailError(''); }
      else setDetailError('任务详情读取失败，请重试。');
    }, () => { if (!cancelled) setDetailError('任务详情读取超时或失败，请重试。'); }, 1000);
    void reads.trigger();
    const timer = selectedStatus && ['queued', 'running'].includes(selectedStatus) ? setInterval(() => void reads.trigger(), 1000) : undefined;
    return () => { cancelled = true; reads.dispose(); if (timer) clearInterval(timer); };
  }, [selectedId, conversationId, request, revision, refresh, selectedStatus]);
  useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', handle); return () => document.removeEventListener('keydown', handle); }, [onClose]);
  const owners = view === 'history' && page?.owners.length ? page.owners : companions.map(role => ({ companionId: role.id, name: role.name, count: companionWorkOverview(actions, role.id).total }));
  function reset(nextOwner = owner) { linkedSelection.current = undefined; setSelectedId(undefined); setLoading(true); setOwner(nextOwner); setCursors([undefined]); setPageNumber(0); setRefresh(value => value + 1); }
  if (initialActionId) return <div className="companions-task-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="companions-task-monitor is-execution-detail" role="dialog" aria-modal="true" aria-label={selected?.capability ? '能力调用详情' : '执行详情'}><header><div><h2>{selected ? companionCapabilityTitle(selected) : '执行详情'}</h2><p>{selected?.capability ? '这次实际调用的输入、过程与结果' : '这次实际执行的记录'}</p></div><button className="companion-icon-button" aria-label="关闭任务监视" onClick={onClose}><Icon name="close" /></button></header><main>{selected ? <CompanionActionCard key={selected.id} action={selected} now={now} defaultShowProgress onReadRecord={selected.taskId && (!selected.capability || selected.capability.name === 'think') ? async query => (await request({ type: 'action.record', id: selected.id, query: dshRecordQuerySchema.parse(query) }))?.taskRecord : undefined} onStop={() => onStop(selected.id)} onResume={!selected.capability && onResume ? async () => { await onResume(selected.id); setRefresh(value => value + 1); } : undefined} onTerminate={!selected.capability && onTerminate ? async () => { await onTerminate(selected.id); setRefresh(value => value + 1); } : undefined} onGuide={!selected.capability ? () => onGuide(selected.id) : undefined} onOpenUrl={onOpenUrl} /> : <p>{detailError || '正在读取实际调用记录…'}</p>}</main></section></div>;
  return <div className="companions-task-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="companions-task-monitor" role="dialog" aria-modal="true" aria-label="伙伴实时任务">
    <header><div><h2>伙伴正在做什么</h2><p>{overview.counts.running} 件进行中 · {overview.counts.queued} 件等待中{overview.counts.confirmation ? ` · ${overview.counts.confirmation} 件待确认` : ''}{overview.counts.interrupted ? ` · ${overview.counts.interrupted} 件可继续` : ''}</p></div><button className="companion-icon-button" aria-label="关闭任务监视" onClick={onClose}><Icon name="close" /></button></header>
    <div className="companions-task-monitor-body"><aside className="companions-task-history">
      <div className="companions-task-filter"><div className="companions-task-views" role="tablist" aria-label="任务视图"><button role="tab" aria-selected={view === 'active'} onClick={() => { setView('active'); reset(); }}>当前工作</button><button role="tab" aria-selected={view === 'history'} onClick={() => { setView('history'); reset(); }}>全部记录</button></div><label htmlFor="companion-task-owner">按伙伴查看</label><select id="companion-task-owner" value={owner} onChange={event => reset(event.target.value)}><option value="">全部伙伴</option>{owners.map(role => <option key={role.companionId} value={role.companionId}>{role.name}（{role.count}）</option>)}</select>{view === 'history' && <button type="button" className="companion-text-button" onClick={() => reset()}>刷新最新记录</button>}</div>
      <nav aria-label="选择伙伴任务" aria-busy={loading}>{view === 'history' && error ? <p role="alert">{error}<button onClick={() => reset()}>重试</button></p> : !items.length ? <p>{loading ? '正在读取任务…' : view === 'active' ? '暂时没有待处理的工作。已完成的任务保存在全部记录中。' : '这位伙伴还没有任务记录。'}</p> : items.map(item => {
        const action = actions.find(value => value.id === item.id) ?? item;
        const companion = companions.find(role => role.id === action.companionId);
        const name = companion?.name ?? owners.find(role => role.companionId === action.companionId)?.name ?? '伙伴';
        return <button key={action.id} className={selectedId === action.id ? 'is-selected' : ''} aria-pressed={selectedId === action.id} onClick={() => { linkedSelection.current = undefined; setSelectedId(action.id); }}>
          <Avatar companion={companion} /><div><strong>{name}</strong><span>{action.title}</span><time dateTime={action.createdAt} title={companionTimezone(action.createdAt)}>{companionTimestamp(action.createdAt)}</time><small data-working={running(action)}>{companionWorkPhase(action) ? COMPANION_WORK_PHASE_LABELS[companionWorkPhase(action)!] + (action.stage ? ' · ' + action.stage : '') : action.status === 'succeeded' ? '已返回结果' : action.status === 'cancelled' ? '已停止' : action.status === 'failed' ? '处理失败' : '执行中断'}</small></div>
        </button>;
      })}</nav>
      <footer className="companions-task-pagination"><div><button type="button" disabled={loading || pageNumber === 0} onClick={() => { setLoading(view === 'history'); setPageNumber(value => value - 1); }}>上一页</button><span>第 {pageNumber + 1} 页</span><button type="button" disabled={loading || (view === 'active' ? (pageNumber + 1) * PAGE_SIZE >= overview.total : !page?.nextCursor)} onClick={() => { if (view === 'active') { setPageNumber(value => value + 1); return; } if (!page?.nextCursor) return; setLoading(true); setCursors(value => [...value.slice(0, pageNumber + 1), page.nextCursor]); setPageNumber(value => value + 1); }}>下一页</button></div><p>共 {view === 'active' ? overview.total : page?.total ?? 0} 条 · 每页 {PAGE_SIZE} 条</p></footer>
    </aside><main aria-busy={!!selectedId && !selected}>{selected ? <CompanionActionCard key={selected.id} action={selected} now={now} defaultShowProgress onReadRecord={async query => (await request({ type: 'action.record', id: selected.id, query: dshRecordQuerySchema.parse(query) }))?.taskRecord} onStop={() => onStop(selected.id)} onResume={onResume ? async () => { await onResume(selected.id); setRefresh(value => value + 1); } : undefined} onTerminate={onTerminate ? async () => { await onTerminate(selected.id); setRefresh(value => value + 1); } : undefined} onGuide={() => onGuide(selected.id)} onOpenUrl={onOpenUrl} /> : <p>{detailError || (selectedId ? '正在读取任务详情…' : '选择一条任务查看过程。')}{detailError && <button onClick={() => setRefresh(value => value + 1)}>重试</button>}</p>}</main></div>
  </section></div>;
}
