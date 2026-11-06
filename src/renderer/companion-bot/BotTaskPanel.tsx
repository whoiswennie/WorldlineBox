import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { BotCompanion, BotRequest, BotResponse, BotTask } from '../../shared/companion-bot';
import { BotIcon } from './BotIcon';
import { BotTaskCard } from './BotTaskCard';
import { BotTaskOwner } from './BotTaskOwner';
import { botTaskTitle, botTaskStatus, botTaskActivity, botTaskState, botTaskActive, botTaskTimerRunning } from './task-presentation';
import { formatBotReplyDuration } from './BotReplyTiming';
import { botTaskElapsedMs } from '../../shared/companion-bot-task-clock';
import './bot-task-panel.css';

type Filter = 'all' | 'active' | 'issues' | 'done';
const PAGE_SIZE = 6;
function visibleTabStop(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && element.type === 'hidden' || element.hasAttribute('tabindex') && element.tabIndex < 0) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hidden || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') return false;
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open && ![...ancestor.children].find(child => child.tagName === 'SUMMARY')?.contains(element)) return false;
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}
interface Props {
  conversationId: string; tasks: BotTask[]; locale: 'zh-CN' | 'en'; focusedTaskId?: string; onFocus(taskId: string): void; onClose(): void;
  group?: boolean; companions?: readonly BotCompanion[]; refreshVersion?: unknown;
  onFollowTask?(task: BotTask): void;
  request(input: BotRequest): Promise<BotResponse>; changed(): Promise<unknown>; children?: ReactNode;
}

/** One selected task owns the forms. Paging the compact catalog never mounts
 * every task's large prompt, output and question editor at once. */
export function BotTaskPanel({ conversationId, tasks, locale, focusedTaskId, onFocus, onClose, request, changed, children, group = false, companions = [], refreshVersion, onFollowTask }: Props) {
  const zh = locale === 'zh-CN';
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [filter, setFilter] = useState<Filter>('all'), [page, setPage] = useState(0);
  const [owner, setOwner] = useState('');
  const companionId = group && owner ? owner : undefined;
  const ownerName = companions.find(person => person.id === companionId)?.name ?? tasks.find(task => task.companionId === companionId)?.companionName ?? companionId;
  const scopeName = group ? companionId ? zh ? `本群 · ${ownerName}` : `This group · ${ownerName}` : zh ? '本群全部伙伴' : 'All companions in this group' : zh ? '当前聊天' : 'This chat';
  const [catalog, setCatalog] = useState<BotResponse['taskPage']>(), [selected, setSelected] = useState<BotTask>(), [chosen, setChosen] = useState(focusedTaskId);
  const [loadedKey, setLoadedKey] = useState(''), [settledDetailId, setSettledDetailId] = useState<string>(), [error, setError] = useState('');
  const [removedId, setRemovedId] = useState<string>();
  const [queueAction, setQueueAction] = useState<'cancel_queued' | 'cancel_all' | 'clear_finished'>(), [clearing, setClearing] = useState(false);
  const [queueMenu, setQueueMenu] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const observedVersion = useRef(refreshVersion), refreshTimer = useRef<number | null>(null);
  const confirm = useRef<HTMLDivElement>(null), restoreFocus = useRef<HTMLElement | null>(null), controls = useRef<HTMLButtonElement>(null), container = useRef<HTMLElement>(null);
  const queueAttempts = useRef(new Map<string, string>()), queuePending = useRef(false);
  const reads = useRef(0), details = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; reads.current++; details.current++; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (refreshVersion === undefined || observedVersion.current === refreshVersion) return;
    observedVersion.current = refreshVersion;
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; setReload(value => value + 1); }, 250);
  }, [refreshVersion]);
  useEffect(() => () => { if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current); }, []);
  useEffect(() => { const previous = document.activeElement; container.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => { const normalized = query.trim(); if (normalized === search) return; const timer = window.setTimeout(() => { setSearch(normalized); setPage(0); }, 180); return () => window.clearTimeout(timer); }, [query, search]);
  const revision = tasks.map(task => `${task.id}:${task.status}:${task.updatedAt ?? ''}:${task.progress?.updatedAt ?? ''}`).join('|');
  const readKey = JSON.stringify([filter, search, page, companionId]), loading = loadedKey !== readKey;
  const read = useCallback(async () => {
    const generation = ++reads.current;
    try {
      const result = await request({ type: 'task.list', conversationId, ...(companionId ? { companionId } : {}), filter, query: search, page, limit: PAGE_SIZE });
      if (!mounted.current || generation !== reads.current) return;
      if (result.ok && result.taskPage && result.taskPage.items.every(task => task.conversationId === conversationId && (!companionId || task.companionId === companionId))) { setCatalog(result.taskPage); setError(''); const lastPage = Math.max(0, Math.ceil(result.taskPage.total / PAGE_SIZE) - 1); if (page > lastPage) { setPage(lastPage); setChosen(undefined); } }
      else setError(result.error ?? (zh ? '暂时无法读取任务。' : 'Tasks could not be loaded.'));
    } catch { if (mounted.current && generation === reads.current) setError(zh ? '暂时无法读取任务。' : 'Tasks could not be loaded.'); }
    finally { if (mounted.current && generation === reads.current) setLoadedKey(readKey); }
  }, [conversationId, companionId, request, filter, search, page, zh, readKey]);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => { if (current) return read(); });
    return () => { current = false; };
  }, [read, revision, reload]);
  const selectedId = chosen ?? catalog?.items[0]?.id;
  const detailLoading = !!selectedId && selected?.id !== selectedId && settledDetailId !== selectedId;
  useEffect(() => {
    const generation = ++details.current;
    if (!selectedId) return;
    void request({ type: 'task.get', conversationId, taskId: selectedId }).then(result => {
      if (!mounted.current || generation !== details.current) return;
      if (result.ok && result.taskRemoved) { setSelected(undefined); setRemovedId(selectedId); setError(''); }
      else if (result.ok && result.task?.id === selectedId && result.task.conversationId === conversationId && (!companionId || result.task.companionId === companionId)) { setSelected(result.task); setRemovedId(undefined); setError(''); }
      else { setSelected(undefined); setError(result.error ?? (zh ? '任务详情暂时无法读取。' : 'Task details could not be loaded.')); }
    }).catch(() => { if (mounted.current && generation === details.current) setError(zh ? '任务详情暂时无法读取。' : 'Task details could not be loaded.'); })
      .finally(() => { if (mounted.current && generation === details.current) setSettledDetailId(selectedId); });
  }, [conversationId, companionId, selectedId, request, revision, reload, zh]);
  const refresh = async () => { await changed(); setReload(value => value + 1); };
  const refreshRemoved = async (allFinished = false) => {
    const index = catalog?.items.findIndex(task => task.id === selectedId) ?? -1;
    const next = allFinished && selected && botTaskActive(selected) ? selected.id : !allFinished && index >= 0 ? catalog?.items[index + 1]?.id ?? catalog?.items[index - 1]?.id : undefined;
    ++reads.current; ++details.current; setChosen(next); setSelected(undefined); setSettledDetailId(undefined); setCatalog(undefined); setLoadedKey(''); await refresh();
  };
  const closeQueue = () => { if (clearing) return; setQueueAction(undefined); restoreFocus.current?.focus(); };
  useEffect(() => {
    if (!queueAction) return;
    const cancel = confirm.current?.querySelector<HTMLButtonElement>('button'); cancel?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!clearing) { setQueueAction(undefined); restoreFocus.current?.focus(); } }
      if (event.key === 'Tab') {
        const buttons = [...confirm.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        if (buttons.length) buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]!.focus();
        else confirm.current?.focus();
      }
    };
    document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true);
  }, [queueAction, clearing]);
  const clearQueue = async () => {
    if (!queueAction || queuePending.current) return;
    queuePending.current = true; setClearing(true); setError('');
    try {
      const attemptKey = JSON.stringify([conversationId, companionId, queueAction]);
      const requestId = queueAttempts.current.get(attemptKey) ?? crypto.randomUUID(); queueAttempts.current.set(attemptKey, requestId);
      const result = await request({ type: 'task.queue.control', conversationId, ...(companionId ? { companionId } : {}), operation: queueAction, requestId });
      if (!mounted.current) return;
      if (result.ok) { queueAttempts.current.delete(attemptKey); setQueueAction(undefined); restoreFocus.current?.focus(); if (queueAction === 'clear_finished') await refreshRemoved(true); else await refresh(); }
      else setError(result.error ?? (zh ? '未能提交停止请求。' : 'The stop request could not be submitted.'));
    } catch { if (mounted.current) setError(zh ? '未能提交停止请求。' : 'The stop request could not be submitted.'); }
    finally { queuePending.current = false; if (mounted.current) setClearing(false); }
  };
  const pages = Math.max(1, Math.ceil((catalog?.total ?? 0) / PAGE_SIZE)), currentPage = catalog?.page ?? page;
  const filters: Array<[Filter, string]> = [['all', zh ? '全部' : 'All'], ['active', zh ? '进行中' : 'Active'], ['issues', zh ? '需处理' : 'Attention'], ['done', zh ? '已结束' : 'Finished']];
  const keyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || queueAction) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (queueMenu) { setQueueMenu(false); controls.current?.focus(); } else if (runtimeOpen) setRuntimeOpen(false); else onClose(); }
    if (event.key !== 'Tab') return;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(visibleTabStop);
    const first = stops[0], last = stops.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <div className="bot-tasks-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !queueAction) onClose(); }}><aside className="bot-tasks-panel" ref={container} tabIndex={-1} role="dialog" aria-modal="true" aria-label={zh ? '任务工作台' : 'Task workspace'} onKeyDown={keyboard}>
    <header className="bot-tasks-header"><div><BotIcon name="tasks" /><h3>{group ? zh ? '群任务工作台' : 'Group task workspace' : zh ? '任务工作台' : 'Task workspace'}</h3>{!!catalog?.activeCount && <span>{zh ? `${catalog.activeCount} 项进行中` : `${catalog.activeCount} active`}</span>}</div><div className="bot-tasks-window-actions">{children && <div className="bot-task-runtime-tools"><button aria-expanded={runtimeOpen} onClick={() => setRuntimeOpen(!runtimeOpen)}><BotIcon name="settings" />{zh ? '运行信息' : 'Runtime'}</button>{runtimeOpen && <div className="bot-task-runtime-popover" role="region" aria-label={zh ? '运行信息' : 'Runtime'}>{children}</div>}</div>}<button className="bot-tasks-close" aria-label={zh ? '关闭任务' : 'Close tasks'} onClick={onClose}>×</button></div></header>
    <div className="bot-tasks-catalog">
      {group && <label className="bot-tasks-owner-filter"><span>{zh ? '负责伙伴' : 'Responsible companion'}</span><select aria-label={zh ? '筛选负责伙伴' : 'Filter responsible companion'} value={owner} onChange={event => {
        ++reads.current; ++details.current; setOwner(event.target.value); setPage(0); setChosen(undefined); setSelected(undefined); setSettledDetailId(undefined); setCatalog(undefined); setLoadedKey(''); setError('');
      }}><option value="">{zh ? '全部伙伴' : 'All companions'}</option>{companions.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>}
      <label className="bot-tasks-search"><BotIcon name="search" /><input aria-label={zh ? '搜索任务' : 'Search tasks'} placeholder={zh ? '搜索任务' : 'Search tasks'} value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setChosen(undefined); }} /></label>
      <div className="bot-tasks-catalog-tools"><nav className="bot-tasks-filters" aria-label={zh ? '任务筛选' : 'Task filters'}>{filters.map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0); setChosen(undefined); }}>{label}</button>)}</nav><div className="bot-task-queue-tools" onBlur={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setQueueMenu(false); }}><button ref={controls} aria-label={zh ? '管理任务队列' : 'Manage task queue'} aria-expanded={queueMenu} aria-haspopup="menu" onClick={() => setQueueMenu(!queueMenu)}>···</button>{queueMenu && <div role="menu">{(['cancel_queued', 'cancel_all', 'clear_finished'] as const).map(operation => <button role="menuitem" key={operation} disabled={operation === 'cancel_queued' ? !catalog?.queuedCount : operation === 'clear_finished' ? !catalog?.finishedCount : !catalog?.activeCount} onClick={event => { restoreFocus.current = controls.current ?? event.currentTarget; setQueueMenu(false); setQueueAction(operation); }}>{operation === 'cancel_queued' ? group ? companionId ? zh ? '清理该伙伴排队' : 'Clear this companion’s queue' : zh ? '清理全群排队' : 'Clear group queue' : zh ? '清理排队' : 'Clear queued tasks' : operation === 'clear_finished' ? group ? companionId ? zh ? '清理该伙伴已结束' : 'Clear this companion’s records' : zh ? '清理全群已结束' : 'Clear group records' : zh ? '清理已结束' : 'Clear finished records' : group ? companionId ? zh ? '停止该伙伴任务' : 'Stop this companion’s tasks' : zh ? '停止全群任务' : 'Stop group tasks' : zh ? '停止全部' : 'Stop all tasks'}</button>)}</div>}</div></div>
      <div className="bot-tasks-list" aria-busy={loading} aria-label={zh ? '任务列表' : 'Tasks'}>{catalog?.items.length ? catalog.items.map(task => <button key={task.id} className="bot-task-row" aria-current={selectedId === task.id} onClick={() => { setChosen(task.id); onFocus(task.id); }} data-task-row={task.id}>
        <span className={`bot-task-dot is-${botTaskState(task)}`} aria-hidden="true" /><span className="bot-task-row-main">{group && <BotTaskOwner task={task} companion={companions.find(person => person.id === task.companionId)} locale={locale} compact />}<span className="bot-task-row-title">{botTaskTitle(task)}</span><TaskRowActivity task={task} locale={locale} /></span><span className={`bot-task-badge is-${botTaskState(task)}`}>{botTaskStatus(task, locale)}</span>
      </button>) : <p className="bot-tasks-empty">{loading ? zh ? '正在读取任务…' : 'Loading tasks…' : zh ? '没有匹配的任务' : 'No matching tasks'}</p>}</div>
      <footer className="bot-tasks-pagination"><span>{zh ? `共 ${catalog?.total ?? 0} 项` : `${catalog?.total ?? 0} tasks`}</span><button disabled={loading || currentPage === 0} aria-label={zh ? '上一页任务' : 'Previous task page'} onClick={() => { setPage(currentPage - 1); setChosen(undefined); }}>‹</button><span>{currentPage + 1} / {pages}</span><button disabled={loading || currentPage + 1 >= pages} aria-label={zh ? '下一页任务' : 'Next task page'} onClick={() => { setPage(currentPage + 1); setChosen(undefined); }}>›</button></footer>
    </div>
    <section className="bot-task-selected" aria-busy={detailLoading} aria-label={zh ? '任务详情' : 'Task details'}>{selected && selected.id === selectedId ? <BotTaskCard key={selected.id} task={selected} showOwner={group} companion={companions.find(person => person.id === selected.companionId)} locale={locale} request={request} changed={refresh} removed={() => refreshRemoved()} onFollow={onFollowTask} /> : <div className="bot-tasks-blank"><BotIcon name="tasks" /><strong>{removedId === selectedId && selectedId ? zh ? '该任务记录已移除' : 'This task record was removed' : detailLoading ? zh ? '正在读取详情…' : 'Loading details…' : zh ? '选择一项任务' : 'Choose a task'}</strong><p>{removedId === selectedId && selectedId ? zh ? '原文件与已发送的附件仍保留。可以继续查看其他任务。' : 'Original files and sent attachments remain available. You can view other tasks.' : zh ? '任务的进展、结果和需要处理的事项会显示在这里。' : 'Progress, results and items needing attention appear here.'}</p>{removedId === selectedId && selectedId && <button onClick={() => { setChosen(undefined); setRemovedId(undefined); setReload(value => value + 1); }}>{zh ? '返回任务列表' : 'Back to tasks'}</button>}</div>}</section>
    {error && <div className="bot-task-read-error" role="alert"><span>{error}</span><button onClick={() => { setError(''); setReload(value => value + 1); }}>{zh ? '重新读取' : 'Reload'}</button><button aria-label={zh ? '关闭提示' : 'Dismiss message'} onClick={() => setError('')}>×</button></div>}
    {queueAction && <div className="bot-task-queue-confirm"><div ref={confirm} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="bot-task-queue-title"><p className="bot-task-bulk-scope">{scopeName}</p><h4 id="bot-task-queue-title">{queueAction === 'cancel_queued' ? zh ? `清理${scopeName}的 ${catalog?.queuedCount ?? 0} 项排队任务？` : `Clear ${catalog?.queuedCount ?? 0} queued tasks · ${scopeName}?` : queueAction === 'clear_finished' ? zh ? `移除${scopeName}的 ${catalog?.finishedCount ?? 0} 项已结束记录？` : `Remove ${catalog?.finishedCount ?? 0} finished records · ${scopeName}?` : zh ? `停止${scopeName}的 ${catalog?.activeCount ?? 0} 项任务？` : `Stop ${catalog?.activeCount ?? 0} tasks · ${scopeName}?`}</h4>{group && <p className="bot-task-scope-note">{zh ? '仅操作以上伙伴在本群的任务；关键词与状态筛选不改变批量操作范围。其他聊天的任务不受影响。' : 'Only these companions’ tasks in this group are affected. Search and status filters do not change this scope. Other chats are unaffected.'}</p>}<p>{queueAction === 'clear_finished' ? zh ? '只清理已完成、失败和已停止的任务记录，保留原文件与已发送的附件。进行中和已暂停的任务会保留。' : 'Remove completed, failed and stopped task records. Original files, sent attachments, active work and paused tasks are retained.' : zh ? '任务将立即停止，计时同时冻结。已有结果与文件会保留。' : 'Tasks stop immediately and their timers freeze. Existing results and files are retained.'}</p><footer><button disabled={clearing} onClick={closeQueue}>{zh ? '继续查看' : 'Keep viewing'}</button><button className="bot-task-primary" disabled={clearing} onClick={() => void clearQueue()}>{clearing ? zh ? '正在提交…' : 'Submitting…' : zh ? '确认' : 'Confirm'}</button></footer></div></div>}
  </aside></div>;
}

function TaskRowActivity({ task, locale }: { task: BotTask; locale: 'zh-CN' | 'en' }) {
  const [now, setNow] = useState(Date.now), ticking = botTaskTimerRunning(task);
  useEffect(() => { if (!ticking) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [ticking]);
  const elapsed = botTaskElapsedMs(task, now);
  return <small className="bot-task-row-activity">{botTaskActivity(task, locale)}{Number.isFinite(elapsed) && <span> · {formatBotReplyDuration(elapsed, locale)}</span>}</small>;
}
