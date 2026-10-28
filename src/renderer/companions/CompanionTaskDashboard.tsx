import { useEffect, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { COMPANION_TASK_KIND_LABELS, type CompanionTaskItem, type CompanionTaskPage } from '../../shared/companion-task-overview';
import { companionTimestamp, companionTimezone } from '../../shared/companion-time';
import type { CompanionRequest } from './CompanionDialogs';
import { Icon } from '../Icons';
import { Avatar } from './CompanionVisuals';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { createCoalescedRefresh } from './coalesced-refresh';
import { useCompanionClock } from './CompanionProgress';
import { companionTaskDuration } from './task-duration';
import { CompanionTaskConcurrencySettings } from './CompanionTaskConcurrencySettings';
import { CompanionTaskInspector } from './CompanionTaskInspector';
import './companion-task-dashboard.css';

type Cursor = CompanionTaskPage['nextCursor'];
const PAGE_SIZE = 20;
const keyFor = (item: CompanionTaskItem) => item.kind + ':' + item.id;
const terminal = (item: CompanionTaskItem) => ['completed', 'cancelled', 'failed'].includes(item.status);
const resumable = (item: CompanionTaskItem) => ['cancelled', 'interrupted'].includes(item.status) && ['reply', 'action', 'activity'].includes(item.kind)
  || item.status === 'paused' && item.kind === 'work_order';
const labels: Record<CompanionTaskItem['status'], string> = { queued: '排队中', running: '进行中', waiting: '等待中', paused: '已暂停', completed: '已完成', failed: '执行失败', cancelled: '已停止', interrupted: '执行中断' };
function compactTime(value: string | undefined): string {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(timestamp) : '未记录';
}
function TaskTime({ value }: { value?: string }) {
  return value ? <time dateTime={value} title={`${companionTimestamp(value)} · ${companionTimezone(value)}`}>{compactTime(value)}</time> : <span>未记录</span>;
}
export function companionTaskStatusLabel(item: CompanionTaskItem): string {
  return item.stoppedByUser ? item.status === 'paused' ? '用户已暂停' : '用户已停止' : labels[item.status];
}
function durationFor(item: CompanionTaskItem, now: number): string | undefined {
  // A recurring plan is configuration, not one execution. Its occurrences
  // carry their own queue/start/end times in the same dashboard.
  if (item.kind === 'schedule' || item.kind === 'world_action') return undefined;
  const ended = terminal(item) || item.status === 'paused' || item.status === 'interrupted';
  return companionTaskDuration(item.createdAt ?? item.startedAt, ended ? item.finishedAt ?? (item.stoppedByUser ? item.stopRequestedAt : undefined) : undefined, ended ? undefined : now);
}

/** One cross-conversation task catalogue. Detailed tool logs remain in their
 * existing source-checked viewer; this list never loads those bodies eagerly. */
export function CompanionTaskDashboard({ companions, request, api, initialCompanionId = '', initialView = 'current', onClose, onOpenAction }: {
  companions: Companion[]; request: CompanionRequest; initialCompanionId?: string; initialView?: 'current' | 'history';
  api?: Pick<WorldlineBoxCompanionsApi, 'onChanged'>;
  onClose(): void; onOpenAction?(id: string): void;
}) {
  useDialogFocusTrap(true, '伙伴任务总览');
  const [owner, setOwner] = useState(initialCompanionId), [view, setView] = useState(initialView);
  const [cursors, setCursors] = useState<Cursor[]>([undefined]), [pageNumber, setPageNumber] = useState(0);
  const [page, setPage] = useState<CompanionTaskPage>(), [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [stopping, setStopping] = useState<string>(), [notice, setNotice] = useState('');
  const alive = useRef(true), now = useCompanionClock(true, true), cursor = cursors[pageNumber];
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    let cancelled = false;
    const reads = createCoalescedRefresh(async () => {
      const response = await request({ type: 'tasks.list', ...(owner ? { companionId: owner } : {}), view, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      if (cancelled) return;
      setLoading(false);
      if (!response?.taskPage) { setError('任务清单暂时无法读取，请刷新重试。'); return; }
      setError(''); setPage(response.taskPage);
      setSelected(current => response.taskPage!.items.some(item => keyFor(item) === current) ? current : response.taskPage!.items[0] ? keyFor(response.taskPage!.items[0]) : undefined);
    }, () => { if (!cancelled) { setLoading(false); setError('任务清单读取失败，请刷新重试。'); } }, 1000);
    void reads.trigger();
    const timer = view === 'current' ? setInterval(() => void reads.trigger(), 1000) : undefined;
    const unsubscribe = api?.onChanged(() => void reads.trigger());
    return () => { cancelled = true; reads.dispose(); if (timer) clearInterval(timer); unsubscribe?.(); };
  }, [owner, view, cursor, request, refresh, api]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  const item = page?.items.find(entry => keyFor(entry) === selected), duration = item && durationFor(item, now);
  const owners = page?.owners ?? companions.map(companion => ({ companionId: companion.id, name: companion.name, current: 0, history: 0 }));
  const roleFor = (id: string) => companions.find(companion => companion.id === id);
  const nameFor = (id: string) => roleFor(id)?.name ?? owners.find(companion => companion.companionId === id)?.name ?? '伙伴';
  function reset(nextOwner = owner, nextView = view) {
    setOwner(nextOwner); setView(nextView); setLoading(true); setPage(undefined); setSelected(undefined); setError(''); setNotice(''); setCursors([undefined]); setPageNumber(0); setRefresh(value => value + 1);
  }
  async function stop(entry: CompanionTaskItem) {
    if (!entry.canStop || stopping) return;
    setStopping(keyFor(entry)); setNotice('');
    try {
      const result = await request({ type: 'task.stop', companionId: entry.companionId, kind: entry.kind, id: entry.id });
      if (!alive.current) return;
      if (!result?.ok) { setError(result?.error ?? '停止请求尚未确认，请刷新查看当前状态。'); return; }
      setNotice(entry.stopLabel?.includes('暂停') ? '任务已暂停' : '任务已停止');
      setRefresh(value => value + 1);
    } catch { if (alive.current) setError('停止请求尚未确认，请刷新查看当前状态。'); }
    finally { if (alive.current) setStopping(undefined); }
  }
  async function resume(entry: CompanionTaskItem) {
    if (stopping) return;
    setStopping(keyFor(entry)); setNotice('');
    try {
      const result = await request({ type: 'task.resume', companionId: entry.companionId, kind: entry.kind, id: entry.id });
      if (!alive.current) return;
      if (!result?.ok) { setError(result?.error ?? '恢复尚未确认，请刷新任务。'); return; }
      setNotice('任务已恢复'); setRefresh(value => value + 1);
    } catch { if (alive.current) setError('恢复尚未确认，请刷新任务。'); }
    finally { if (alive.current) setStopping(undefined); }
  }
  return <div className="companions-task-backdrop task-center-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="companions-task-dashboard" role="dialog" aria-modal="true" aria-label="伙伴任务总览">
      <header className="task-center-header">
        <div className="task-center-brand"><span className="task-center-brand-icon"><Icon name="activity" size={21} /></span><div><h2>任务中心</h2><p>伙伴的任务与执行记录</p></div></div>
        <div className="task-center-header-counts"><span>当前 <strong>{page?.current ?? '—'}</strong></span><span>已结束 <strong>{page?.history ?? '—'}</strong></span></div>
        <div className="task-center-header-controls"><CompanionTaskConcurrencySettings companions={companions} companionId={owner || undefined} request={request} /><button className="task-center-icon-button" aria-label="关闭任务总览" title="关闭任务中心" onClick={onClose}><Icon name="close" size={20} /></button></div>
      </header>
      <div className="task-center-toolbar">
        <div className="task-center-owner-filter">{owner ? <Avatar companion={roleFor(owner)} /> : <span className="task-center-owner-all"><Icon name="users" size={17} /></span>}<div><label htmlFor="companion-task-dashboard-owner">任务归属</label><select id="companion-task-dashboard-owner" value={owner} onChange={event => reset(event.target.value)}><option value="">全部伙伴 · 全部聊天</option>{owners.map(companion => <option key={companion.companionId} value={companion.companionId}>{companion.name} · {view === 'current' ? companion.current : companion.history} 项</option>)}</select></div><Icon name="chevrons-up-down" size={15} /></div>
        <div className="task-center-tabs" role="tablist" aria-label="任务范围"><button role="tab" aria-label="当前任务" aria-selected={view === 'current'} onClick={() => reset(owner, 'current')}>当前任务<span>{page?.current ?? 0}</span></button><button role="tab" aria-label="已结束记录" aria-selected={view === 'history'} onClick={() => reset(owner, 'history')}>已结束记录<span>{page?.history ?? 0}</span></button></div>
        <button type="button" className="task-center-refresh" aria-label="刷新任务清单" title="刷新任务清单" onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={16} /><span>刷新</span></button>
      </div>
      <div className="task-center-body">
        <aside className="task-center-list-pane"><div className="task-center-list-heading"><span>{view === 'current' ? '任务' : '历史记录'}</span><small>{page?.total ?? 0} 项</small></div>
          <nav className="task-center-list" aria-label="选择任务" aria-busy={loading}>
            {page?.items.map(entry => <button type="button" key={keyFor(entry)} data-companion-task={keyFor(entry)} className={'task-center-list-item' + (keyFor(entry) === selected ? ' is-selected' : '')} aria-pressed={keyFor(entry) === selected} onClick={() => { setSelected(keyFor(entry)); setNotice(''); }}>
              <div className="task-center-item-top"><strong className="task-center-item-title" title={entry.title}>{entry.title}</strong><span className="task-center-status" data-status={entry.status} data-user-stop={entry.stoppedByUser}><i />{companionTaskStatusLabel(entry)}</span></div>
              {entry.stage && <span className="task-center-item-stage">{entry.stage}</span>}
              <div className="task-center-item-bottom"><Avatar companion={roleFor(entry.companionId)} /><span>{nameFor(entry.companionId)}{entry.conversationTitle && <small> · {entry.conversationTitle}</small>}</span><small className="task-center-item-kind">{COMPANION_TASK_KIND_LABELS[entry.kind]}</small>{durationFor(entry, now) && <time>{durationFor(entry, now)}</time>}</div>
            </button>)}
            {!page?.items.length && <div className="task-center-list-empty"><Icon name={loading ? 'refresh' : 'check'} size={25} /><strong>{loading ? '正在同步任务' : view === 'current' ? '当前没有任务' : '还没有执行记录'}</strong><p>{loading ? '读取伙伴的实际进展…' : view === 'current' ? '新的工作开始后，会出现在这里。' : '已结束的工作会保存在这里。'}</p></div>}
          </nav>
          <footer className="task-center-pagination"><span>共 {page?.total ?? 0} 项</span><div><button type="button" aria-label="上一页" title="上一页" disabled={loading || pageNumber === 0} onClick={() => { setLoading(true); setPageNumber(value => value - 1); }}><Icon name="chevron-left" size={15} /></button><span>{pageNumber + 1}</span><button type="button" aria-label="下一页" title="下一页" disabled={loading || !page?.nextCursor} onClick={() => { if (!page?.nextCursor) return; setLoading(true); setCursors(values => [...values.slice(0, pageNumber + 1), page.nextCursor]); setPageNumber(value => value + 1); }}><Icon name="chevron-right" size={15} /></button></div></footer>
        </aside>
        <main className="task-center-main">
          {error && <p className="task-center-notice is-error" role="alert"><Icon name="alert-circle" size={16} />{error}</p>}
          {notice && <div className="task-center-toast" role="status"><Icon name="check" size={14} />{notice}</div>}
          {item ? <article className="task-center-detail" data-selected-task={keyFor(item)}>
            <p className="task-inspector-owner">{nameFor(item.companionId)}<span> / </span>{COMPANION_TASK_KIND_LABELS[item.kind]}{item.conversationTitle && <><span> / </span>{item.conversationTitle}</>}</p>
            <h3>{item.title.replace(/^回复\s*·\s*/u, '')}</h3>
            <section className="task-center-execution" aria-label="当前任务状态">
              <div className="task-center-execution-summary"><strong className="task-center-status" data-status={item.status} data-user-stop={item.stoppedByUser} data-task-status={item.status} title={companionTaskStatusLabel(item)}><i />{!terminal(item) && !item.stoppedByUser && item.stage ? item.stage : companionTaskStatusLabel(item)}</strong><span className="task-center-duration" aria-label={`总用时 ${duration ?? '未记录'}`} title={duration ? '总用时，包含排队与准备' : '时间未完整记录'}><Icon name="clock" size={13} />{item.kind === 'schedule' ? '按次计时' : <strong>{duration ?? '未记录'}</strong>}</span></div>
              <div className="task-center-actions">{resumable(item) && <button className="task-center-primary-button" type="button" aria-label={`恢复任务 ${item.title}`} disabled={!!stopping} onClick={() => void resume(item)}><Icon name="play" size={14} />恢复任务</button>}{item.canStop && <button className="task-center-stop-button" type="button" aria-label={`停止任务 ${item.title}`} disabled={!!stopping} onClick={() => void stop(item)}><Icon name="stop" size={13} />{stopping === keyFor(item) ? '正在停止…' : item.stopLabel ?? '停止任务'}</button>}{(item.kind === 'action' || item.relatedActionId) && onOpenAction && <button className="task-center-secondary-button" type="button" onClick={() => onOpenAction(item.relatedActionId ?? item.id)}>工具执行过程<Icon name="arrow-up-right" size={14} /></button>}</div>
            </section>
            {!terminal(item) && !item.canStop && !resumable(item) && item.stopReason && <p className="task-center-control-note">{item.stopReason}</p>}
            <CompanionTaskInspector key={keyFor(item)} task={item} request={request} api={api} refresh={refresh} />
            <details className="task-center-time-section"><summary>执行时间<span title={companionTimezone(item.createdAt ?? item.updatedAt)}>本地时间</span></summary><dl className="task-center-time-table"><div><dt>{item.kind === 'world_action' ? '事件记录' : '接收任务'}</dt><dd><TaskTime value={item.createdAt} /></dd></div>{item.kind !== 'world_action' && <><div><dt>开始执行</dt><dd>{item.startedAt ? <TaskTime value={item.startedAt} /> : item.status === 'queued' || item.status === 'waiting' ? '尚未开始' : '未记录'}</dd></div><div><dt>{item.stoppedByUser ? '用户手动停止' : item.scheduledAt && !terminal(item) ? '计划执行' : '执行结束'}</dt><dd>{item.finishedAt || item.stopRequestedAt || item.scheduledAt ? <TaskTime value={item.finishedAt ?? item.stopRequestedAt ?? item.scheduledAt} /> : terminal(item) ? '未记录' : '尚未结束'}</dd></div></>}</dl></details>
          </article> : <div className="task-center-empty-detail"><h3>{loading ? '正在读取任务…' : '选择一个任务'}</h3><p>{loading ? '正在同步实际执行记录。' : '查看进度、用时，并管理这次执行。'}</p></div>}
        </main>
      </div>
    </section>
  </div>;
}
