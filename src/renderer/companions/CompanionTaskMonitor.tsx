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

type Cursor = NonNullable<CompanionActionPage['nextCursor']>;
const PAGE_SIZE = 20;
const running = (action: CompanionAction) => ['queued', 'running'].includes(action.status);

/** Paged durable history and independent live streams within this conversation. */
export function CompanionTaskMonitor({ actions, companions, conversationId, request, dshApi, now, onClose, onStop, onGuide, onResume, onTerminate, onOpenUrl }: {
  actions: CompanionAction[]; companions: Companion[]; conversationId: string; request: CompanionRequest; now: number; onClose(): void;
  onStop(id: string): void; onGuide(id: string): void; onOpenUrl(url: string): void;
  dshApi?: WorldlineBoxDshLauncherApi; onResume?(id: string): void | Promise<unknown>; onTerminate?(id: string): void | Promise<unknown>;
}) {
  useDialogFocusTrap(true, '伙伴实时任务');
  const [owner, setOwner] = useState('');
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const [pageNumber, setPageNumber] = useState(0);
  const [page, setPage] = useState<CompanionActionPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<CompanionAction>();
  const [detailError, setDetailError] = useState('');
  const streams = useRef(new Map<string, CompanionActionEvent[]>());
  const selectedStatus = actions.find(action => action.id === selectedId)?.status ?? (detail?.id === selectedId ? detail?.status : page?.items.find(action => action.id === selectedId)?.status);
  useEffect(() => dshApi?.onTaskEvent?.(event => {
    const progress = companionProgressEvent(event);
    if (!progress) return;
    streams.current.set(event.taskId, mergeCompanionProgress(streams.current.get(event.taskId) ?? [], [progress]));
    while (streams.current.size > 20) streams.current.delete(streams.current.keys().next().value!);
    setDetail(current => current?.taskId === event.taskId ? { ...current, events: mergeCompanionProgress(current.events ?? [], [progress]) } : current);
  }), [dshApi]);
  const cursor = cursors[pageNumber];
  const revision = actions.map(action => action.id + '/' + action.status).join(',');
  useEffect(() => {
    let cancelled = false;
    void request({ type: 'actions.page', conversationId, ...(owner ? { companionId: owner } : {}), ...(cursor ? { before: cursor } : {}), limit: PAGE_SIZE }).then(response => {
      if (cancelled) return;
      setLoading(false);
      if (!response?.actionPage) { setError('任务记录读取失败，请重试。'); return; }
      setError(''); setPage(response.actionPage);
      setSelectedId(current => response.actionPage!.items.some(item => item.id === current) ? current : response.actionPage!.items[0]?.id);
    });
    return () => { cancelled = true; };
  }, [conversationId, owner, cursor, request, refresh, revision]);
  useEffect(() => {
    let cancelled = false;
    if (!selectedId) return;
    const load = () => { void request({ type: 'action.get', id: selectedId }).then(response => {
      if (cancelled) return;
      if (response?.action) { const action = response.action; setDetail({ ...action, events: mergeCompanionProgress(action.events ?? [], streams.current.get(action.taskId ?? '') ?? []) }); setDetailError(''); }
      else setDetailError('任务详情读取失败，请重试。');
    }); };
    load();
    const timer = selectedStatus && ['queued', 'running'].includes(selectedStatus) ? setInterval(load, 1000) : undefined;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [selectedId, request, revision, refresh, selectedStatus]);
  useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', handle); return () => document.removeEventListener('keydown', handle); }, [onClose]);
  const live = actions.find(action => action.id === selectedId);
  const stored = detail?.id === selectedId ? detail : undefined;
  const selected = live && stored ? { ...(live.updatedAt >= stored.updatedAt ? live : stored), events: mergeCompanionProgress(stored.events ?? [], live.events ?? []) } : live ?? stored;
  const owners = page?.owners ?? companions.map(role => ({ companionId: role.id, name: role.name, count: 0 }));
  function reset(nextOwner = owner) { setLoading(true); setOwner(nextOwner); setCursors([undefined]); setPageNumber(0); setRefresh(value => value + 1); }
  return <div className="companions-task-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="companions-task-monitor" role="dialog" aria-modal="true" aria-label="伙伴实时任务">
    <header><div><h2>伙伴正在做什么</h2><p>{actions.filter(running).length} 件正在进行 · 按创建时间从新到旧</p></div><button className="companion-icon-button" aria-label="关闭任务监视" onClick={onClose}><Icon name="close" /></button></header>
    <div className="companions-task-monitor-body"><aside className="companions-task-history">
      <div className="companions-task-filter"><label htmlFor="companion-task-owner">按伙伴查看</label><select id="companion-task-owner" value={owner} onChange={event => reset(event.target.value)}><option value="">全部伙伴</option>{owners.map(role => <option key={role.companionId} value={role.companionId}>{role.name}（{role.count}）</option>)}</select><button type="button" className="companion-text-button" onClick={() => reset()}>刷新最新记录</button></div>
      <nav aria-label="选择伙伴任务" aria-busy={loading}>{error ? <p role="alert">{error}<button onClick={() => reset()}>重试</button></p> : !page?.items.length ? <p>{loading ? '正在读取任务…' : '这位伙伴还没有任务记录。'}</p> : page.items.map(item => {
        const action = actions.find(value => value.id === item.id) ?? item;
        const companion = companions.find(role => role.id === action.companionId);
        const name = companion?.name ?? owners.find(role => role.companionId === action.companionId)?.name ?? '伙伴';
        return <button key={action.id} className={selectedId === action.id ? 'is-selected' : ''} aria-pressed={selectedId === action.id} onClick={() => setSelectedId(action.id)}>
          <Avatar companion={companion} /><div><strong>{name}</strong><span>{action.title}</span><time dateTime={action.createdAt} title={companionTimezone(action.createdAt)}>{companionTimestamp(action.createdAt)}</time><small data-working={running(action)}>{running(action) ? action.stage || '正在处理' : action.status === 'succeeded' ? '已返回结果' : action.status === 'cancelled' ? '已停止' : action.status === 'failed' ? '处理失败' : '执行中断'}</small></div>
        </button>;
      })}</nav>
      <footer className="companions-task-pagination"><div><button type="button" disabled={loading || pageNumber === 0} onClick={() => { setLoading(true); setPageNumber(value => value - 1); }}>上一页</button><span>第 {pageNumber + 1} 页</span><button type="button" disabled={loading || !page?.nextCursor} onClick={() => { if (!page?.nextCursor) return; setLoading(true); setCursors(value => [...value.slice(0, pageNumber + 1), page.nextCursor]); setPageNumber(value => value + 1); }}>下一页</button></div><p>共 {page?.total ?? 0} 条 · 每页 {PAGE_SIZE} 条</p></footer>
    </aside><main aria-busy={!!selectedId && !selected}>{selected ? <CompanionActionCard key={selected.id} action={selected} now={now} defaultShowProgress onStop={() => onStop(selected.id)} onResume={onResume ? async () => { await onResume(selected.id); setRefresh(value => value + 1); } : undefined} onTerminate={onTerminate ? async () => { await onTerminate(selected.id); setRefresh(value => value + 1); } : undefined} onGuide={() => onGuide(selected.id)} onOpenUrl={onOpenUrl} /> : <p>{detailError || (selectedId ? '正在读取任务详情…' : '选择一条任务查看过程。')}{detailError && <button onClick={() => setRefresh(value => value + 1)}>重试</button>}</p>}</main></div>
  </section></div>;
}
