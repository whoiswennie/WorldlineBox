import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionMemoryJobSchedule, CompanionMemoryProcessing, CompanionMemoryProcessingFilter, CompanionMemoryProcessingJob } from '../../shared/companion-memory-processing';
import type { ScheduleRequest } from './companion-schedules';
import { Icon } from '../Icons';
import { createCoalescedRefresh } from './coalesced-refresh';
import { CompanionModelResourcesPanel } from './CompanionModelResourcesPanel';
import './companion-memory-processing.css';

type Props = { companionId: string; companionName?: string; api?: WorldlineBoxCompanionsApi; request: ScheduleRequest };
const states = { pending: '待处理', running: '处理中', completed: '已处理', failed: '失败', cancelled: '已取消', stale: '已失效', waiting_model: '等待模型' };
const kinds = { capture: '来源整理', index: '向量索引', tags: '自动标签', timeline: '时间线整理' };
function stateLabel(job: CompanionMemoryProcessingJob) { return job.status === 'running' && job.schedule && job.schedule.scheduleKind !== 'running' ? '等待恢复' : states[job.status]; }
function stageLabel(job: CompanionMemoryProcessingJob) { return job.status === 'running' && job.schedule && job.schedule.scheduleKind !== 'running' ? '上次记录：' + job.stage : job.stage; }
function timestamp(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
const clockLabel = (basis: 'real' | 'world') => basis === 'world' ? '世界时间' : '现实时间';
function ScheduleMoment({ at, label, basis }: { at: string; label: string; basis: 'real' | 'world' }) {
  return <span>{label} <time dateTime={at}>{timestamp(at)}</time><small>（{clockLabel(basis)}）</small></span>;
}
function JobNextStep({ schedule }: { schedule?: CompanionMemoryJobSchedule }) {
  if (!schedule || schedule.scheduleKind === 'finished') return null;
  return <span className="memory-processing-next-step"><Icon name="clock" size={12} /><span>{schedule.nextCheckAt
    ? <ScheduleMoment at={schedule.nextCheckAt} label="下次检查" basis={schedule.timeBasis} />
    : schedule.nextAttemptAt ? <ScheduleMoment at={schedule.nextAttemptAt} label="最早可重试" basis={schedule.timeBasis} /> : schedule.condition}</span></span>;
}

function useMemoryProcessing({ companionId, api, request }: Props, limit: number, filter: CompanionMemoryProcessingFilter = 'all') {
  const [snapshot, setSnapshot] = useState<{ filter: CompanionMemoryProcessingFilter; report: CompanionMemoryProcessing }>(), [failure, setFailure] = useState<{ owner: string; filter: string; message: string }>();
  const alive = useRef(false), serial = useRef(0);
  const scope = `${companionId}:${filter}:${limit}`, currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; }, [scope]);
  const data = snapshot?.report.companionId === companionId && snapshot.filter === filter ? snapshot.report : undefined;
  const error = failure?.owner === companionId && failure.filter === filter ? failure.message : '';
  const refresh = useCallback(async () => {
    if (currentScope.current !== scope) return;
    const epoch = ++serial.current;
    try {
      const response = await request({ type: 'memory.processing.status', companionId, limit, ...(filter !== 'all' ? { filter } : {}) });
      if (!alive.current || epoch !== serial.current || currentScope.current !== scope) return;
      if (!response?.ok || response.memoryProcessing?.companionId !== companionId) throw new Error(response?.error || '记忆处理记录暂时无法读取。');
      setSnapshot({ report: response.memoryProcessing, filter }); setFailure(undefined);
    } catch (cause) { if (alive.current && epoch === serial.current && currentScope.current === scope) setFailure({ owner: companionId, filter, message: cause instanceof Error ? cause.message : '记忆处理记录暂时无法读取。' }); }
  }, [request, companionId, limit, filter, scope]);
  useEffect(() => {
    alive.current = true;
    const reads = createCoalescedRefresh(refresh, undefined, 500);
    void reads.trigger(); const unsubscribe = api?.onChanged(() => reads.trigger());
    return () => { alive.current = false; unsubscribe?.(); reads.dispose(); };
  }, [refresh, api]);
  const working = !!data && (data.schedule
    ? !!data.schedule.nextCheckAt || data.schedule.schedulers.some(scheduler => !!scheduler.nextCheckAt || scheduler.waitingReason === 'device_testing' || ['timer', 'retry', 'running'].includes(scheduler.scheduleKind))
      || data.jobs.some(job => !!job.schedule && ['timer', 'retry', 'running'].includes(job.schedule.scheduleKind))
    : !!(data.summary.pending || data.summary.running || data.jobs.some(job => job.status === 'failed' && job.attempts < 8 && !!job.nextAttemptAt)));
  useEffect(() => { if (!working) return; const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, [working, refresh]);
  return { data, error, refresh };
}

/** An owner-scoped entrance, shared by the memory library and the current chat. */
export function CompanionMemoryProcessingSummary({ onOpen, ...props }: Props & { onOpen(): void }) {
  const { data, error } = useMemoryProcessing(props, 1);
  const current = data?.jobs.find(job => job.status === 'running' && (!job.schedule || job.schedule.scheduleKind === 'running'));
  return <button type="button" className="companion-memory-processing-summary" aria-label="查看记忆处理进度" onClick={onOpen}>
    <span className={'memory-processing-summary-icon' + (current ? ' is-working' : '')}><Icon name="activity" size={16} /></span>
    <span><strong>记忆整理</strong><small>{error ? '记录暂时不可用，点此查看' : !data ? '正在读取处理进度…' : current ? kinds[current.kind] + '进行中' : data.summary.failed ? `${data.summary.failed} 项需要处理` : data.summary.pending ? `${data.summary.pending} 项等待整理` : data.summary.running ? `${data.summary.running} 项已领取，等待核对执行条件` : data.summary.completed ? '已整理，记录可查' : '还没有需要整理的来源'}</small>{!error && data?.schedule && <small className="memory-processing-summary-next">{data.schedule.nextCheckAt
      ? <ScheduleMoment at={data.schedule.nextCheckAt} label="下次检查" basis={data.schedule.timeBasis} /> : data.schedule.condition}</small>}</span>
    <Icon name="chevron-right" size={14} />
  </button>;
}

/** Read-only queue evidence; retry reuses the host's existing owner-bound action. */
export function CompanionMemoryProcessingPanel({ onClose, onOpenDocument, ...props }: Props & { onClose(): void; onOpenDocument?(noteId: string): void }) {
  const [filter, setFilter] = useState<'all' | 'active' | 'failed' | 'completed'>('all');
  const [selection, setSelection] = useState<{ owner: string; key: string }>();
  const [detailOwner, setDetailOwner] = useState<string>();
  const { data, error, refresh } = useMemoryProcessing(props, 30, filter);
  const [retryOwner, setRetryOwner] = useState<string>(), [retryFailure, setRetryFailure] = useState<{ owner: string; message: string }>();
  const retrying = retryOwner === props.companionId, retryError = retryFailure?.owner === props.companionId ? retryFailure.message : '';
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement, panel = close.current?.closest('section'); close.current?.focus();
    return () => {
      const current = document.activeElement;
      if (current && current !== document.body && !panel?.contains(current)) return;
      if (previous instanceof HTMLElement && document.contains(previous) && previous.getClientRects().length && !previous.closest('[hidden]')) previous.focus();
    };
  }, []);
  const jobs = data?.jobs.filter(job => filter === 'all' || filter === 'active' && ['pending', 'running', 'waiting_model'].includes(job.status) || filter === 'failed' && job.status === 'failed' || filter === 'completed' && job.status === 'completed') ?? [];
  const selected = jobs.find(job => selection?.owner === props.companionId && selection.key === job.kind + ':' + job.id) ?? jobs[0];
  const counts = data ? { all: data.summary.pending + data.summary.running + data.summary.failed + data.summary.completed + data.summary.cancelled,
    active: data.summary.pending + data.summary.running, failed: data.summary.failed, completed: data.summary.completed } : undefined;
  const filters = [['all', '全部'], ['active', '待处理与进行中'], ['failed', '失败'], ['completed', '已处理']] as const;
  const needsRetry = !!data?.summary.failed || !!data?.jobs.some(job => job.schedule?.scheduleKind === 'manual' || job.schedule?.waitingReason === 'retry_limit');
  const retry = async () => {
    if (retrying) return; setRetryOwner(props.companionId); setRetryFailure(undefined);
    try { const result = await props.request({ type: 'memory.jobs.retry', companionId: props.companionId }); if (!result?.ok) throw new Error(result?.error || '重试未完成。'); await refresh(); }
    catch (cause) { setRetryFailure({ owner: props.companionId, message: cause instanceof Error ? cause.message : '重试未完成。' }); }
    finally { setRetryOwner(current => current === props.companionId ? undefined : current); }
  };
  return <section className="companion-memory-processing-panel" role="region" aria-label="记忆处理进度" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
    event.preventDefault(); event.stopPropagation();
    const rules = event.currentTarget.querySelector<HTMLDetailsElement>('.memory-processing-rules[open]');
    if (rules) { rules.open = false; rules.querySelector<HTMLElement>('summary')?.focus(); } else onClose();
  } }}>
    <header className="memory-processing-header"><span className="memory-processing-mark"><Icon name="activity" size={21} /></span><div><h2>记忆处理进度</h2><p>{props.companionName ?? '这位伙伴'}的来源整理、向量索引与自动标签</p></div><button ref={close} type="button" aria-label="关闭记忆处理进度" onClick={onClose}><Icon name="close" size={18} /></button></header>
    <div className="memory-processing-layout">
      <aside className="memory-processing-navigation"><span className="memory-processing-section-label">处理记录</span>
        <div role="tablist" aria-label="记忆处理状态筛选" aria-orientation="vertical">{filters.map(([value, title]) => <button key={value} type="button" role="tab" aria-label={title} aria-selected={filter === value} onClick={() => { setFilter(value); setDetailOwner(undefined); }}><Icon name={value === 'all' ? 'layers' : value === 'active' ? 'clock' : value === 'failed' ? 'alert-circle' : 'check'} size={16} /><span>{title}</span><small aria-hidden="true">{counts ? counts[value].toLocaleString('zh-CN') : '—'}</small></button>)}</div>
        <div className="memory-processing-owner-note"><Icon name="shield" size={15} /><span>仅显示{props.companionName ?? '当前伙伴'}的记录</span></div>
      </aside>
      <main className={'memory-processing-content' + (detailOwner === props.companionId ? ' is-detail-open' : '')}>
        <div className="memory-processing-toolbar"><div><strong>{filters.find(([value]) => value === filter)?.[1]}</strong><span>{data ? `${jobs.length} 项记录` : '正在读取'}</span></div><div><details className="memory-processing-rules"><summary aria-label="处理规则" title="处理规则"><Icon name="info" size={15} /></summary><p>“已处理”表示对应后台步骤结束。来源整理可能判断无需写日记；向量收录和自动标签是各自独立的步骤。</p></details><button type="button" onClick={() => void refresh()} aria-label="刷新处理记录"><Icon name="refresh" size={14} /><span>刷新</span></button>{needsRetry && <button type="button" className="memory-processing-retry" disabled={retrying} onClick={() => void retry()}>{retrying ? '正在重试…' : data?.summary.failed ? '重试失败的整理' : '重试待处理任务'}</button>}</div></div>
        {(error || retryError) && <p className="memory-processing-error" role="alert">{retryError || error}</p>}
        {data?.metrics && <p className="memory-processing-counts" aria-label="当前伙伴来源与条目统计">当前账本：{data.metrics.sourceVersions.toLocaleString('zh-CN')} 个整理来源版本 · {data.metrics.originalEntries.toLocaleString('zh-CN')} 条原始记录 · {data.metrics.derivedEntries.toLocaleString('zh-CN')} 条派生记录。来源和条目数都不等于模型调用数。</p>}
        <CompanionModelResourcesPanel companionId={props.companionId} api={props.api} />
        {data?.schedule && <section className="memory-processing-next-check" aria-label="当前伙伴后台检查安排"><Icon name="clock" size={15} /><div><p>{data.schedule.condition}</p>{data.schedule.nextCheckAt && <ScheduleMoment at={data.schedule.nextCheckAt} label="下次检查" basis={data.schedule.timeBasis} />}</div><details className="memory-processing-rules memory-processing-schedule-info"><summary aria-label="后台检查时间说明" title="后台检查时间说明"><Icon name="info" size={14} /></summary><p>{data.schedule.explanation}</p></details></section>}
        {!data && !error ? <p className="memory-processing-empty" role="status">正在读取实际处理记录…</p> : !jobs.length ? <div className="memory-processing-empty"><Icon name="check" size={25} /><p>{filter === 'all' ? '还没有记忆处理任务。产生正式交流或提供资料后，处理记录会出现在这里。' : '暂无此状态的记忆处理任务。'}</p></div> : <div className="memory-processing-board">
          <ol className="memory-processing-jobs" aria-label="处理任务">{jobs.map(job => <li key={job.kind + ':' + job.id} data-processing-kind={job.kind} data-processing-status={job.status}><button type="button" className="memory-processing-job" aria-pressed={selected?.kind === job.kind && selected.id === job.id} onClick={() => { setSelection({ owner: props.companionId, key: job.kind + ':' + job.id }); setDetailOwner(props.companionId); }}>
            <span className="memory-processing-job-top"><small>{kinds[job.kind]}</small><span className="memory-processing-state" data-status={job.status}>{stateLabel(job)}</span></span>
            <strong>{job.title}</strong><span className="memory-processing-stage">{stageLabel(job)}</span><JobNextStep schedule={job.schedule} />{job.preview && <span className="memory-processing-preview">{job.preview}</span>}
            <span className="memory-processing-job-foot">{job.updatedAt ? <time dateTime={job.updatedAt}>{timestamp(job.updatedAt)}</time> : <span>处理时间未记录</span>}<Icon name="chevron-right" size={13} /></span>
          </button></li>)}</ol>
          {selected && <article className="memory-processing-detail" aria-label="处理任务详情"><button type="button" className="memory-processing-back" onClick={() => setDetailOwner(undefined)}><Icon name="chevron-left" size={14} />返回任务列表</button>
            <div className="memory-processing-detail-heading"><span>{kinds[selected.kind]}</span><span className="memory-processing-state" data-status={selected.status}>{stateLabel(selected)}</span></div><h3>{selected.title}</h3>
            <p className="memory-processing-detail-stage"><Icon name={selected.status === 'failed' ? 'alert-circle' : selected.status === 'completed' ? 'check' : 'clock'} size={17} /><span>{stageLabel(selected)}</span></p>
            {selected.schedule && <section className="memory-processing-execution-plan" aria-label="任务后续执行安排"><h4>执行安排</h4><p>{selected.schedule.condition}</p><dl>{selected.schedule.nextCheckAt && <div><dt>下次检查</dt><dd><time dateTime={selected.schedule.nextCheckAt}>{timestamp(selected.schedule.nextCheckAt)}</time>（{clockLabel(selected.schedule.timeBasis)}）</dd></div>}{selected.schedule.nextAttemptAt && <div><dt>最早可重试</dt><dd><time dateTime={selected.schedule.nextAttemptAt}>{timestamp(selected.schedule.nextAttemptAt)}</time>（{clockLabel(selected.schedule.timeBasis)}）</dd></div>}</dl><p className="memory-processing-trigger-rule">{selected.schedule.triggerRule}</p><small>{selected.schedule.explanation}</small></section>}
            {selected.preview && <section className="memory-processing-source"><h4>来源片段</h4><p>{selected.preview}</p></section>}
            {selected.error && <p className={selected.status === 'stale' ? 'memory-processing-job-note' : 'memory-processing-job-error'} role={selected.status === 'stale' ? 'status' : 'alert'}>{selected.error}</p>}
            <section className="memory-processing-timing"><h4>处理时间</h4><dl>{selected.createdAt && <div><dt>创建</dt><dd><time dateTime={selected.createdAt}>{timestamp(selected.createdAt)}</time></dd></div>}{selected.startedAt && <div><dt>本次开始</dt><dd><time dateTime={selected.startedAt}>{timestamp(selected.startedAt)}</time></dd></div>}{selected.updatedAt && <div><dt>更新</dt><dd><time dateTime={selected.updatedAt}>{timestamp(selected.updatedAt)}</time></dd></div>}{!selected.createdAt && !selected.updatedAt && <div><dt>时间记录</dt><dd>旧任务未记录处理时间</dd></div>}<div><dt>执行次数</dt><dd>已尝试 {selected.attempts} 次</dd></div>{!selected.schedule && selected.nextAttemptAt && <div><dt>可重试时间</dt><dd><time dateTime={selected.nextAttemptAt}>{timestamp(selected.nextAttemptAt)}</time></dd></div>}</dl></section>
            <details className="memory-processing-evidence"><summary>处理凭证<Icon name="chevron" size={12} /></summary><dl><div><dt>任务编号</dt><dd>{selected.id}</dd></div>{selected.sourceRevision && <div><dt>来源版本</dt><dd>{selected.sourceRevision}</dd></div>}{selected.noteId && <div><dt>记忆编号</dt><dd>{selected.noteId}</dd></div>}{selected.sourceMessageId && <div><dt>来源消息编号</dt><dd>{selected.sourceMessageId}</dd></div>}</dl></details>
            {selected.noteId && onOpenDocument && <button type="button" className="memory-processing-open-document" onClick={() => onOpenDocument(selected.noteId!)}><Icon name="file-text" size={15} />查看对应记忆</button>}
          </article>}
        </div>}
        {data && <footer className="memory-processing-footer">展示最多 30 项，优先呈现进行中和待处理任务。{data.hasMore && '还有其他历史任务未在本次列表中展开。'}{data.summary.cancelled > 0 && ` ${data.summary.cancelled} 项已取消或因来源变化失效。`} 时间线整理仅展示本次应用运行期间的任务，重启后不补造历史。</footer>}
      </main>
    </div>
  </section>;
}
