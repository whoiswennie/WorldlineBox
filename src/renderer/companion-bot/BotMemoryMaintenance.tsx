import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { BotMaintenanceCandidates, BotMaintenanceDiagnostics, BotMaintenanceJob,
  BotMaintenanceKind, BotMaintenanceList, BotMaintenanceSettings, BotMemoryMaintenanceRequest } from '../../shared/companion-bot-maintenance';
import type { BotMemoryWorkspaceRequest } from '../../shared/companion-bot-memory';
import { formatBotReplyDuration } from './BotReplyTiming';
import './bot-memory-maintenance.css';
import { BotMaintenanceCandidateReview } from './BotMaintenanceCandidateReview';

type Locale = 'zh-CN' | 'en';
type Scope = { conversationId: string; companionId: string };
type Call = (input: BotMemoryWorkspaceRequest) => Promise<unknown>;
const text = (zh: boolean, chinese: string, english: string) => zh ? chinese : english;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const activeStatuses = new Set(['queued', 'running', 'applying']);
const states: Record<string, [string, string]> = {
  queued: ['排队中', 'Queued'], running: ['生成方案中', 'Planning'], review: ['等待审阅', 'Awaiting review'], applying: ['正在核实写入', 'Verifying writes'],
  completed: ['已完成', 'Completed'], cancelled: ['已取消', 'Cancelled'], failed: ['未完成', 'Failed'], blocked: ['需人工检查', 'Needs review'],
  pending: ['待批准', 'Pending review'], approved: ['已批准，待执行', 'Approved, awaiting execution'], rejected: ['已驳回', 'Rejected'], applied: ['已应用', 'Applied'], superseded: ['已由其他方案整理', 'Organized by another proposal'],
  conflict: ['已批准 · 来源已变化', 'Approved · sources changed'], unknown: ['已批准 · 执行待核实', 'Approved · execution unconfirmed'], partial: ['部分完成，待核实', 'Partially completed; verify'], withdrawn: ['来源已撤回', 'Source withdrawn'],
  auto_running: ['自动审阅中', 'Reviewing automatically'], auto_queued: ['等待自动审阅', 'Queued for model review'], auto_waiting: ['审阅稍后重试', 'Review retry pending'], auto_manual: ['已审阅 · 需人工', 'Reviewed · needs human input'], auto_done: ['自动审阅完成', 'Model review complete'],
};
const phases: Record<string, [string, string]> = {
  queued: ['等待后台处理', 'Waiting to start'], scan: ['查找可整理日记', 'Finding notes'], read: ['读取来源原文', 'Reading sources'],
  dream: ['生成梦境候选', 'Generating dream candidates'], organize: ['生成整理方案', 'Planning organization'], pending_review: ['等待逐项审阅', 'Awaiting individual review'],
  review: ['等待逐项审阅', 'Awaiting individual review'], applying: ['应用已批准方案', 'Applying approved actions'], completed: ['处理结束', 'Finished'],
  partial: ['部分结果待核实', 'Some outcomes need verification'], unknown: ['核实执行结果', 'Verifying the outcome'], withdrawn: ['来源已撤回', 'Source withdrawn'],
  scanning: ['查找可整理日记', 'Finding notes'], reading: ['读取来源原文', 'Reading sources'], recalling: ['回查相关记忆', 'Recalling related memories'], planning: ['生成候选方案', 'Generating candidates'],
  waiting_index: ['等待索引确认', 'Waiting for indexing confirmation'], waiting_idle: ['等待空闲条件', 'Waiting for idle conditions'], paused_user: ['用户交互期间已暂停', 'Paused during user activity'],
  waiting_executor: ['等待执行环境恢复，稍后自动继续', 'Waiting for the executor; resumes automatically'],
  invalid_plan: ['方案证据未通过核对，需要重新生成', 'Proposal evidence failed validation; regenerate the plan'],
  auto_reviewing: ['全局模型正在逐项审阅', 'The global model is reviewing candidates'], auto_review_waiting: ['审阅暂时中断，稍后自动重试', 'Review interrupted; retrying automatically'],
  'candidate-validation': ['候选原文证据核对', 'Candidate evidence validation'], 'model-review-request': ['自动审阅输入', 'Model review input'], 'model-review-response': ['自动审阅结果', 'Model review output'], 'model-review-retry': ['自动审阅重试记录', 'Model review retry'], 'model-review-error': ['自动审阅异常', 'Model review error'],
  'schedule-repair': ['后台闲置计时修复', 'Background idle-clock repair'],
  checking_receipt: ['正在核实已批准方案的执行结果', 'Checking the approved operation'], reconciliation: ['执行结果核实记录', 'Execution verification'],
  continuing: ['正在续接未完成的方案', 'Continuing the unfinished plan'],
  waiting_checkpoint: ['正在保存增量处理进度，稍后自动继续', 'Saving incremental progress; continuing automatically'], no_new_versions: ['没有新增或变化的日记', 'No new or changed notes'], 'related-memory': ['按需联想的相关旧记忆', 'Related historical memories'],
  'output-continuation': ['输出进度已保存，正在自动续接', 'Output saved; continuing automatically'],
  source_withdrawn: ['来源资料已撤回，旧方案已停止', 'Sources withdrawn; the old plan is stopped'],
  cancelled: ['已停止未执行部分', 'Remaining work cancelled'], failed: ['处理未完成', 'Processing did not complete'], blocked: ['需要检查后继续', 'Needs review before continuing'], conflict: ['来源变化，需要重新核对', 'Source changed; verify again'],
  snapshot: ['来源快照', 'Source snapshot'], plan: ['候选计划', 'Candidate plan'], receipt: ['执行回执', 'Execution receipt'], scheduled: ['后台条件检查', 'Background eligibility check'], error: ['异常记录', 'Error record'],
  retrieval: ['原始检索结果', 'Original retrieval results'], 'model-request': ['方案生成输入', 'Planning input'], 'model-response': ['方案生成结果', 'Planning result'],
  'mutation-request': ['已批准的写入请求', 'Approved write request'], 'mutation-receipt': ['真实写入回执', 'Actual write receipt'], 'mutation-error': ['写入未完成', 'Write did not complete'],
};
const kinds = (kind: BotMaintenanceKind, zh: boolean) => kind === 'dream' ? text(zh, '梦境', 'Dream') : text(zh, '整理', 'Organization');
const actionName = (type: string, zh: boolean) => ({ organize: ['合并整理日记', 'Organize notes'], update: ['更新日记', 'Update a note'],
  insight: ['保存梦境感悟', 'Save a dream insight'], archive: ['归档冗余日记', 'Archive redundant notes'] } as Record<string, [string, string]>)[type]?.[zh ? 0 : 1] ?? text(zh, '候选方案', 'Candidate');
const label = (map: Record<string, [string, string]>, value: string, zh: boolean) => map[value]?.[zh ? 0 : 1] ?? text(zh, '状态未提供', 'Status not provided');
const stamp = (value: string | undefined, locale: Locale) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const errorText = (error: unknown, zh: boolean) => error instanceof Error ? error.message.slice(0, 1000) : text(zh, '操作未完成，请重新读取核实。', 'The operation did not complete. Reload to verify.');
function Status({ value, zh }: { value: string; zh: boolean }) { return <span className="bot-maintenance-status" data-state={value}>{label(states, value, zh)}</span>; }
const jobStatus = (job: BotMaintenanceJob) => job.status === 'review' && job.autoReview ? 'auto_' + job.autoReview.state : job.status;
function AutoReviewProgress({ job, locale }: { job: BotMaintenanceJob; locale: Locale }) {
  const progress = job.autoReview, zh = locale === 'zh-CN';
  if (!progress) return null;
  const description = progress.state === 'running' ? text(zh, `正在审阅第 ${progress.currentPosition} / ${progress.total} 项`, `Reviewing item ${progress.currentPosition} of ${progress.total}`)
    : progress.state === 'waiting' ? text(zh, `暂时中断，将于 ${stamp(progress.retryAt, locale)} 重试`, `Interrupted; retry at ${stamp(progress.retryAt, locale)}`)
      : progress.state === 'queued' ? progress.busyJobId ? text(zh, '正在处理此前的任务，本任务已排队', 'Processing an earlier task; this task is queued') : text(zh, '已加入全局模型审阅队列', 'Queued for global model review')
        : progress.state === 'manual' ? text(zh, '自动审阅已完成，部分方案需要人工确认', 'Model review finished; some items need human input') : text(zh, '自动审阅已完成', 'Model review finished');
  return <p className="bot-maintenance-review-progress" role="status">{description} · {text(zh, `已审 ${progress.reviewed}/${progress.total} 项`, `${progress.reviewed}/${progress.total} reviewed`)}{progress.manual > 0 && ` · ${text(zh, `${progress.manual} 项需人工`, `${progress.manual} need human input`)}`}{progress.error && <span title={progress.error}> · {text(zh, '异常已记录，其他候选继续处理', 'Issue recorded; other candidates continue')}</span>}</p>;
}
function Empty({ title, hint }: { title: string; hint?: string }) { return <div className="bot-maintenance-empty"><strong>{title}</strong>{hint && <p>{hint}</p>}</div>; }
function Pagination({ previous, next, page, busy, onPrevious, onNext, locale }: { previous: boolean; next: boolean; page: number; busy: boolean; onPrevious(): void; onNext(): void; locale: Locale }) {
  const zh = locale === 'zh-CN'; return <div className="bot-maintenance-pagination"><button disabled={busy || !previous} onClick={onPrevious}>{text(zh, '上一页', 'Previous')}</button><span>{page}</span><button disabled={busy || !next} onClick={onNext}>{text(zh, '下一页', 'Next')}</button></div>;
}
function JobClock({ job, locale }: { job: BotMaintenanceJob; locale: Locale }) {
  const active = activeStatuses.has(job.status), [now, setNow] = useState(Date.now);
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [active]);
  const started = Date.parse(job.startedAt ?? job.createdAt);
  const duration = active && Number.isFinite(started) ? Math.max(job.elapsedMs, now - started) : job.elapsedMs;
  return <span className="bot-maintenance-live-time" aria-live="off">{formatBotReplyDuration(Math.max(0, duration), locale)}</span>;
}
function MaintenanceToast({ message, kind, locale, dismiss, retry }: { message: string; kind: 'success' | 'error'; locale: Locale; dismiss(): void; retry?(): void }) {
  const zh = locale === 'zh-CN', element = useRef<HTMLDivElement>(null);
  useEffect(() => { if (kind !== 'success') return; const timer = window.setTimeout(dismiss, 3000); return () => window.clearTimeout(timer); }, [kind, dismiss]);
  useLayoutEffect(() => {
    const node = element.current, pane = node?.closest<HTMLElement>('.bot-memory-maintenance'); if (!node || !pane) return;
    let frame: number | undefined;
    const place = () => { const area = pane.getBoundingClientRect(), box = node.getBoundingClientRect();
      const actions = [...pane.querySelectorAll('button')].filter(button => !button.closest('.bot-maintenance-toast')).map(button => button.getBoundingClientRect()).filter(rect => rect.width && rect.height);
      const positions: Array<[number, number]> = [[area.width - box.width - 14, area.height - box.height - 14], [14, area.height - box.height - 54], [area.width - box.width - 14, 125]];
      const [left, top] = positions.find(([x, y]) => !actions.some(rect => area.left + x < rect.right && area.left + x + box.width > rect.left && area.top + y < rect.bottom && area.top + y + box.height > rect.top)) ?? positions[0]!;
      node.style.left = `${Math.max(8, left)}px`; node.style.top = `${Math.max(8, top)}px`; node.style.right = 'auto'; node.style.bottom = 'auto';
    };
    const schedule = () => { if (frame === undefined) frame = window.requestAnimationFrame(() => { frame = undefined; place(); }); };
    place(); pane.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
    return () => { pane.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); if (frame !== undefined) window.cancelAnimationFrame(frame); };
  }, [message, kind]);
  return <div ref={element} className="bot-maintenance-toast" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'} aria-live={kind === 'error' ? 'assertive' : 'polite'}>
    <span aria-hidden="true">{kind === 'error' ? '!' : '✓'}</span><p>{message}</p>{retry && <button onClick={retry}>{text(zh, '重新读取', 'Reload')}</button>}<button className="bot-maintenance-toast-close" aria-label={kind === 'error' ? text(zh, '关闭错误提示', 'Dismiss error') : text(zh, '关闭操作提示', 'Dismiss notification')} onClick={dismiss}>×</button>
  </div>;
}

/** Scoped and paged. Only summaries load on entry; plans and original notes are read on demand. */
export function BotMemoryMaintenance({ api, conversationId, companionId, locale }: { api: WorldlineBoxBotApi; conversationId: string; companionId: string; locale: Locale }) {
  const zh = locale === 'zh-CN', scope = useMemo(() => ({ conversationId, companionId }), [conversationId, companionId]);
  const [page, setPage] = useState<BotMaintenanceList>({ items: [] }), [cursor, setCursor] = useState<string>(), [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [loading, setLoading] = useState(false), [selected, setSelected] = useState(''), [job, setJob] = useState<BotMaintenanceJob>(), [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [noticeVersion, setNoticeVersion] = useState(0);
  const alive = useRef(true), listRevision = useRef(0), detailRevision = useRef(0), mutation = useRef(false), requestIds = useRef(new Map<string, string>());
  const retire = useCallback(() => { alive.current = false; ++listRevision.current; ++detailRevision.current; }, []);
  useEffect(() => { alive.current = true; return retire; }, [retire]);
  const call: Call = useCallback(async input => { const result = await api.request(input); if (!result.ok) throw new Error(result.error || text(zh, '操作未完成。', 'Operation failed.')); return result.memory; }, [api, zh]);
  const dismissNotice = useCallback(() => setNotice(''), []), dismissError = useCallback(() => setError(''), []);
  const notify = useCallback((kind: 'success' | 'error', message: string) => { if (kind === 'error') { setError(message); if (message) setNotice(''); } else { setError(''); setNotice(message); setNoticeVersion(value => value + 1); } }, []);
  const load = useCallback(async (quiet = false) => {
    const version = ++listRevision.current; if (!quiet) setLoading(true);
    try { const value = object(await call({ type: 'memory.maintenance.list', conversationId, companionId, cursor, limit: 20 }));
      if (!Array.isArray(value.items)) throw new Error(text(zh, '未取得任务列表。', 'No task list was returned.'));
      if (alive.current && version === listRevision.current) setPage({ ...value, items: value.items.slice(0, 20) } as unknown as BotMaintenanceList);
    } catch (reason) { if (alive.current && version === listRevision.current) setError(errorText(reason, zh)); }
    finally { if (alive.current && version === listRevision.current && !quiet) setLoading(false); }
  }, [call, conversationId, companionId, cursor, zh]);
  const readJob = useCallback(async (id: string, quiet = false) => {
    const version = ++detailRevision.current; if (!quiet) setDetailLoading(true);
    try { const value = object(await call({ type: 'memory.maintenance.get', conversationId, companionId, jobId: id }));
      if (value.id !== id || typeof value.status !== 'string' || !value.metrics) throw new Error(text(zh, '未取得完整任务状态。', 'No complete task status was returned.'));
      if (alive.current && version === detailRevision.current) setJob(value as unknown as BotMaintenanceJob);
    } catch (reason) { if (alive.current && version === detailRevision.current) setError(errorText(reason, zh)); }
    finally { if (alive.current && version === detailRevision.current && !quiet) setDetailLoading(false); }
  }, [call, conversationId, companionId, zh]);
  // External synchronization sets loading and is fenced against unmount/scope changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { let timer: number | undefined; const unsubscribe = api.onEvent?.(event => {
    if (event.type !== 'changed' || event.conversationId && event.conversationId !== conversationId || timer !== undefined) return;
    timer = window.setTimeout(() => { timer = undefined; void load(true); if (selected) void readJob(selected, true); }, 500);
  }); return () => { unsubscribe?.(); if (timer !== undefined) window.clearTimeout(timer); }; }, [api, conversationId, load, readJob, selected]);
  const choose = (id: string) => { setSelected(id); setJob(undefined); setError(''); setNotice(''); void readJob(id); };
  const refresh = () => { void load(true); if (selected) void readJob(selected, true); };
  const act = async (action: 'run' | 'cancel' | 'retry', kind?: BotMaintenanceKind, nextCursor?: string) => {
    if (mutation.current || action !== 'run' && !job) return;
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    const key = `${action}:${action === 'run' ? `${kind}:${nextCursor ?? 'first'}` : job!.id}`, requestId = requestIds.current.get(key) ?? crypto.randomUUID(); requestIds.current.set(key, requestId);
    const input: BotMemoryMaintenanceRequest = action === 'run' ? { type: 'memory.maintenance.run', ...scope, kind: kind!, requestId, ...(nextCursor ? { cursor: nextCursor } : {}) }
      : action === 'cancel' ? { type: 'memory.maintenance.cancel', ...scope, jobId: job!.id, requestId } : { type: 'memory.maintenance.retry', ...scope, jobId: job!.id, requestId };
    try { const value = object(await call(input)); if (typeof value.id !== 'string' || typeof value.status !== 'string' || !value.metrics) throw new Error(text(zh, '未取得完成回执，请重新读取核实。', 'No complete receipt. Reload to verify.'));
      if (!alive.current) return; ++detailRevision.current; requestIds.current.delete(key); setSelected(value.id); setJob(value as unknown as BotMaintenanceJob);
      notify('success', text(zh, '请求已记录，请以任务状态和逐项回执为准。', 'Request recorded. Check the task status and individual receipts.')); await load(true);
    } catch (reason) { if (alive.current) setError(errorText(reason, zh)); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="bot-memory-maintenance" aria-label={text(zh, '整理与梦境', 'Organization and dreams')}>
    <div className="bot-maintenance-body"><aside className="bot-maintenance-jobs"><div className="bot-maintenance-left-scroll"><header className="bot-maintenance-list-heading"><span>{text(zh, '维护任务', 'Maintenance tasks')}</span><button disabled={loading} onClick={() => void load()}>{text(zh, '刷新', 'Refresh')}</button></header>
      <div className="bot-maintenance-toolbar-actions"><button className="is-primary" disabled={busy} onClick={() => void act('run', 'organize')}>{text(zh, '生成整理方案', 'Plan organization')}</button><button disabled={busy} onClick={() => void act('run', 'dream')}>{text(zh, '生成梦境候选', 'Dream candidates')}</button></div>
      <MaintenanceSettings api={api} call={call} scope={scope} locale={locale} notify={notify} />
      <div className="bot-maintenance-job-list" aria-busy={loading}>{loading ? <Empty title={text(zh, '正在读取…', 'Loading…')} /> : !page.items.length ? <Empty title={text(zh, '还没有维护任务', 'No maintenance tasks')} hint={text(zh, '可以手动生成方案，或启用后台计划。', 'Start a plan manually or enable the background schedule.')} /> : page.items.map(item => <button key={item.id} className="bot-maintenance-job" aria-current={selected === item.id} onClick={() => choose(item.id)} data-maintenance-job={item.id}><div><strong>{kinds(item.kind, zh)} · {item.automatic ? text(zh, '后台', 'Background') : text(zh, '手动', 'Manual')}</strong><Status value={jobStatus(item)} zh={zh} /></div><p>{label(phases, item.phase, zh)}</p><p><time>{stamp(item.createdAt, locale)}</time> · {formatBotReplyDuration(item.elapsedMs, locale)}</p></button>)}</div>
      </div>
      <Pagination previous={!!previous.length} next={!!page.nextCursor} page={previous.length + 1} busy={loading} locale={locale} onPrevious={() => { setCursor(previous.at(-1)); setPrevious(value => value.slice(0, -1)); }} onNext={() => { setPrevious(value => [...value, cursor]); setCursor(page.nextCursor); }} />
    </aside><section className="bot-maintenance-detail" aria-busy={detailLoading}>{detailLoading ? <Empty title={text(zh, '正在读取任务…', 'Loading task…')} /> : !job ? <Empty title={text(zh, '选择一个任务查看方案', 'Select a task to inspect its plan')} hint={text(zh, '来源、候选和诊断记录都按需读取。', 'Sources, candidates, and diagnostics load on demand.')} /> : <>
      <header className="bot-maintenance-detail-heading"><div><h3>{kinds(job.kind, zh)}<span> · </span><Status value={jobStatus(job)} zh={zh} /></h3><p role="status">{label(phases, job.phase, zh)} · <JobClock key={job.id} job={job} locale={locale} /></p></div><div className="bot-maintenance-job-actions">
        {job.nextCursor && job.phase !== 'source_withdrawn' && ['review', 'completed'].includes(job.status) && <button disabled={busy} onClick={() => void act('run', job.kind, job.nextCursor)}>{text(zh, '继续下一批', 'Continue with the next batch')}</button>}
        {['queued', 'running', 'review', 'applying'].includes(job.status) && <button disabled={busy} onClick={() => void act('cancel')}>{text(zh, '取消待处理部分', 'Cancel remaining work')}</button>}
        {job.phase !== 'source_withdrawn' && ['failed', 'blocked', 'cancelled'].includes(job.status) && <button disabled={busy} onClick={() => void act('retry')}>{text(zh, '重试未完成部分', 'Retry unfinished work')}</button>}
      </div></header>
      <AutoReviewProgress job={job} locale={locale} />
      {job.error && <div className="bot-memory-alert" role="alert">{job.error}</div>}
      <dl className="bot-maintenance-facts">{([[text(zh, job.metrics.incremental ? '新增/变化' : '已检查', job.metrics.incremental ? 'New/changed' : 'Examined'), job.metrics.examined], [text(zh, '选为来源', 'Selected sources'), job.metrics.selected], ...(job.metrics.context ? [[text(zh, '相关旧记忆', 'Related memories'), job.metrics.context] as const] : []), [text(zh, '留待后续', 'Deferred'), job.metrics.deferred], [text(zh, '候选', 'Candidates'), job.metrics.candidates], [text(zh, '已应用', 'Applied'), job.metrics.applied], [text(zh, '已驳回', 'Rejected'), job.metrics.rejected]] as const).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      <JobPlan key={job.id} job={job} call={call} scope={scope} locale={locale} changed={refresh} regenerate={() => act('run', job.kind)} />
    </>}</section></div>
    <div className="bot-maintenance-toasts">{notice && <MaintenanceToast key={noticeVersion} message={notice} kind="success" locale={locale} dismiss={dismissNotice} />}{error && <MaintenanceToast message={error} kind="error" locale={locale} dismiss={dismissError} retry={() => { setError(''); refresh(); }} />}</div>
  </section>;
}

function MaintenanceSettings({ api, call, scope, locale, notify }: { api: WorldlineBoxBotApi; call: Call; scope: Scope; locale: Locale; notify(kind: 'success' | 'error', message: string): void }) {
  const zh = locale === 'zh-CN', [value, setValue] = useState<BotMaintenanceSettings>(), [draft, setDraft] = useState<BotMaintenanceSettings>(), [busy, setBusy] = useState(false);
  const alive = useRef(true), locked = useRef(false), dirty = useRef(false), revision = useRef(0);
  const retire = useCallback(() => { alive.current = false; ++revision.current; }, []);
  const load = useCallback(async () => { const current = ++revision.current; try { const next = object(await call({ type: 'memory.maintenance.settings.get', ...scope })); if (typeof next.enabled !== 'boolean' || !['never', 'lossless'].includes(String(next.autoApply))) throw new Error(text(zh, '未取得后台设置。', 'No background settings returned.')); if (alive.current && current === revision.current) { setValue(next as unknown as BotMaintenanceSettings); if (!dirty.current) setDraft(next as unknown as BotMaintenanceSettings); } } catch (reason) { if (alive.current && current === revision.current) notify('error', errorText(reason, zh)); } }, [call, scope, zh, notify]);
  // Synchronize the external settings receipt; draft edits stay local and are not overwritten.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { alive.current = true; void load(); let timer: number | undefined; const off = api.onEvent?.(event => { if (event.type !== 'changed' || event.conversationId && event.conversationId !== scope.conversationId || timer !== undefined) return; timer = window.setTimeout(() => { timer = undefined; void load(); }, 500); }); return () => { retire(); off?.(); if (timer !== undefined) window.clearTimeout(timer); }; }, [api, scope, load, retire]);
  const save = async () => { if (!draft || locked.current) return; locked.current = true; setBusy(true); notify('error', '');
    try { const next = object(await call({ type: 'memory.maintenance.settings.update', ...scope, settings: { enabled: draft.enabled, kind: draft.kind, autoApply: draft.autoApply, intervalHours: draft.intervalHours, idleMinutes: draft.idleMinutes, minNotes: draft.minNotes } }));
      if (typeof next.enabled !== 'boolean' || !['never', 'lossless'].includes(String(next.autoApply))) throw new Error(text(zh, '设置结果待核实，请重新打开查看。', 'The settings outcome is unconfirmed. Reopen to verify.'));
      if (alive.current) { ++revision.current; dirty.current = false; setValue(next as unknown as BotMaintenanceSettings); setDraft(next as unknown as BotMaintenanceSettings); notify('success', text(zh, '后台设置已保存。', 'Background settings saved.')); }
    } catch (reason) { if (alive.current) notify('error', errorText(reason, zh)); } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const valid = draft && Number.isInteger(draft.intervalHours) && draft.intervalHours >= 1 && draft.intervalHours <= 720 && Number.isInteger(draft.idleMinutes) && draft.idleMinutes >= 1 && draft.idleMinutes <= 1440 && Number.isInteger(draft.minNotes) && draft.minNotes >= 4 && draft.minNotes <= 1000;
  const toggleReview = async () => {
    if (!value || locked.current) return; locked.current = true; setBusy(true);
    try {
      const next = object(await call({ type: 'memory.maintenance.settings.update', ...scope, settings: { autoReview: !value.autoReview } }));
      if (typeof next.autoReview !== 'boolean') throw new Error(text(zh, '自动审阅开关结果未确认，请重新读取设置。', 'Review setting was not confirmed. Reload settings.'));
      if (alive.current) { ++revision.current; setValue(next as unknown as BotMaintenanceSettings); setDraft(current => current ? { ...current, autoReview: next.autoReview as boolean } : current); notify('success', text(zh, next.autoReview ? '已开启全局模型逐项审阅，结论与应用结果会保留记录。' : '已关闭自动审阅，后续候选交由人工处理。', next.autoReview ? 'Global-model review enabled; decisions and receipts are retained.' : 'Automatic review disabled; remaining candidates await manual review.')); }
    } catch (reason) { if (alive.current) notify('error', errorText(reason, zh)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return <><div className="bot-maintenance-auto-review"><div><strong>{text(zh, '自动审阅', 'Automatic review')}</strong><small>{text(zh, '全局模型逐项审查，通过后自动应用；疑问转人工。', 'Global model reviews each item and applies approvals; uncertain cases stay for manual review.')}</small></div><button type="button" role="switch" aria-label={text(zh, '自动审阅', 'Automatic review')} aria-checked={!!value?.autoReview} disabled={busy || !value} onClick={() => void toggleReview()}><span /></button></div><details className="bot-maintenance-settings"><summary>{text(zh, '周期后台计划', 'Background schedule')}<span>{value ? value.enabled ? text(zh, '已启用', 'Enabled') : text(zh, '未启用', 'Disabled') : text(zh, '读取中', 'Loading')}</span></summary>
    <button className="bot-maintenance-settings-refresh" type="button" onClick={() => void load()}>{text(zh, '重新读取设置', 'Reload settings')}</button>{draft && <form onChange={() => { dirty.current = true; }} onSubmit={event => { event.preventDefault(); if (valid) void save(); }}><div className="bot-maintenance-settings-form">
      <label className="is-toggle"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{text(zh, '启用周期后台维护', 'Enable background maintenance')}</label>
      <label>{text(zh, '后台类型', 'Background mode')}<select aria-label={text(zh, '后台类型', 'Background mode')} value={draft.kind} disabled={busy} onChange={event => setDraft({ ...draft, kind: event.target.value as BotMaintenanceKind })}><option value="organize">{text(zh, '整理', 'Organization')}</option><option value="dream">{text(zh, '梦境', 'Dream')}</option></select></label>
      <label>{text(zh, '应用策略', 'Application policy')}<select aria-label={text(zh, '应用策略', 'Application policy')} value={draft.autoApply} disabled={busy} onChange={event => setDraft({ ...draft, autoApply: event.target.value as 'never' | 'lossless' })}><option value="never">{text(zh, '全部逐项批准', 'Review every candidate')}</option><option value="lossless">{text(zh, '仅无损整理可自动应用', 'Auto-apply lossless organization only')}</option></select></label>
      {(['intervalHours', 'idleMinutes', 'minNotes'] as const).map((key, index) => <label key={key}>{[text(zh, '最短间隔（小时）', 'Minimum interval (hours)'), text(zh, '空闲至少（分钟）', 'Minimum idle time (minutes)'), text(zh, '合批目标（日记数）', 'Batch target (notes)')][index]}<input type="number" aria-label={[text(zh, '最短间隔（小时）', 'Minimum interval (hours)'), text(zh, '空闲至少（分钟）', 'Minimum idle time (minutes)'), text(zh, '合批目标（日记数）', 'Batch target (notes)')][index]} min={[1, 1, 4][index]} max={[720, 1440, 1000][index]} value={draft[key]} disabled={busy} onChange={event => setDraft({ ...draft, [key]: Number(event.target.value) })} /></label>)}
    </div><div className="bot-maintenance-settings-footer"><p>{text(zh, '关闭软件时暂停；错过计划时间会在下次启动并空闲后补跑，中断进度会保留。后台仅处理新增或正文变化的日记，按需关联旧记忆；达到维护间隔时少量日记也会处理，中断任务会续接，不设每日次数或累计用量额度。改写、归档和梦境感悟在审阅批准后应用，并保留完整记录。', 'Work pauses while the app is closed. Overdue work resumes on the next launch when idle, with progress preserved. Background work processes remaining batches and continues incomplete output, without daily or cumulative usage quotas. Rewrites, archiving, and dream insights follow recorded review approval.')}<br />{value?.enabled ? `${text(zh, '最早检查时间：', 'Earliest check: ')}${stamp(value.nextEligibleAt, locale)}` : text(zh, '未开启后台计划，仍可手动生成候选。', 'Background scheduling is off; manual planning remains available.')}{value?.blockedReason && <><br />{value.blockedReason}</>}</p><button className="is-primary" type="submit" disabled={busy || !valid}>{busy ? text(zh, '保存中…', 'Saving…') : text(zh, '保存后台设置', 'Save schedule')}</button></div></form>}
  </details></>;
}

function JobPlan({ job, call, scope, locale, changed, regenerate }: { job: BotMaintenanceJob; call: Call; scope: Scope; locale: Locale; changed(): void; regenerate(): Promise<void> }) {
  const zh = locale === 'zh-CN', [tab, setTab] = useState<'candidates' | 'diagnostics'>('candidates');
  if (job.phase === 'source_withdrawn') return <div className="bot-maintenance-safety" role="status"><strong>{text(zh, '来源资料已撤回', 'Sources withdrawn')}</strong>{text(zh, '旧候选和诊断正文已停止显示。请依据当前可用日记生成新方案。', 'Old candidates and diagnostic text are no longer displayed. Generate a fresh plan from the currently available notes.')}</div>;
  return <div className="bot-maintenance-plan"><nav className="bot-maintenance-detail-tabs" aria-label={text(zh, '任务内容', 'Task contents')}><button aria-pressed={tab === 'candidates'} onClick={() => setTab('candidates')}>{text(zh, '候选方案', 'Candidates')}</button><button aria-pressed={tab === 'diagnostics'} onClick={() => setTab('diagnostics')}>{text(zh, '梦境与诊断', 'Dreams and diagnostics')}</button></nav>
    <p className="bot-maintenance-guidance"><strong>{job.kind === 'dream' ? text(zh, '梦境不是用户事实。', 'Dreams are not user facts. ') : text(zh, '候选不等于已改写。', 'A candidate is not an applied change. ')}</strong>{job.metrics.incremental ? text(zh, '仅处理新增或变化的日记，按需联想相关旧记忆；已分析版本和待审来源不会重复排队。', 'Processes new or changed notes with related historical context; analyzed versions and pending reviews are not queued again.') : text(zh, '每批最多检查24篇；请逐项核对来源后批准。', 'Batches contain at most 24 notes; check sources before approving each action.')}</p>
    {tab === 'candidates' ? <CandidateList job={job} call={call} scope={scope} locale={locale} changed={changed} regenerate={regenerate} /> : <div className="bot-maintenance-diagnostics-scroll"><Diagnostics job={job} call={call} scope={scope} locale={locale} /></div>}
  </div>;
}

function CandidateList({ job, call, scope, locale, changed, regenerate }: { job: BotMaintenanceJob; call: Call; scope: Scope; locale: Locale; changed(): void; regenerate(): Promise<void> }) {
  const zh = locale === 'zh-CN', [page, setPage] = useState<BotMaintenanceCandidates>({ items: [] }), [cursor, setCursor] = useState<string>(), [previous, setPrevious] = useState<Array<string | undefined>>([]), [selected, setSelected] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const revision = useRef(0), list = useRef<HTMLDivElement>(null);
  const retire = useCallback(() => { ++revision.current; }, []);
  useEffect(() => { const current = ++revision.current; void call({ type: 'memory.maintenance.candidates', ...scope, jobId: job.id, cursor, limit: 12 }).then(raw => { const value = object(raw); if (!Array.isArray(value.items)) throw new Error(text(zh, '未取得候选列表。', 'No candidate list was returned.')); if (current === revision.current) setPage({ ...value, items: value.items.slice(0, 12) } as unknown as BotMaintenanceCandidates); }).catch(reason => { if (current === revision.current) setError(errorText(reason, zh)); }).finally(() => { if (current === revision.current) setLoading(false); }); return retire; }, [call, scope, job.id, job.updatedAt, cursor, zh, retire]);
  const item = page.items.find(value => value.id === selected), index = page.items.findIndex(value => value.id === selected);
  const closeReader = () => { const id = selected; setSelected(''); window.requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`[data-maintenance-candidate="${CSS.escape(id)}"] button`)?.focus()); };
  return <div ref={list} className="bot-maintenance-review-workbench" data-reading={!!item}><aside className="bot-review-candidate-list" hidden={!!item}><header><strong>{text(zh, '候选方案', 'Candidates')}</strong><span>{page.items.length} {text(zh, '项', 'items')}</span></header>{error && <p className="bot-memory-alert" role="alert">{error}</p>}<div className="bot-maintenance-candidates" aria-busy={loading}>{loading && !page.items.length ? <Empty title={text(zh, '正在读取候选…', 'Loading candidates…')} /> : !page.items.length ? <Empty title={text(zh, '还没有候选方案', 'No candidates yet')} hint={text(zh, '任务完成扫描后，会在这里列出可审阅方案。', 'Reviewable candidates appear here after scanning.')} /> : page.items.map(item => <article className="bot-maintenance-candidate" key={item.id} data-maintenance-candidate={item.id}>
    <button className="bot-maintenance-candidate-open" aria-expanded={selected === item.id} aria-current={selected === item.id ? 'true' : undefined} onClick={() => setSelected(item.id)}><div><strong>{actionName(item.type, zh)}</strong><Status value={item.status === 'pending' && item.autoReview ? 'auto_' + item.autoReview.state : item.status} zh={zh} /></div><p>{item.title}</p><footer><span>{item.sourceCount} {text(zh, '篇来源', 'sources')}</span><span>{item.uncertaintyCount} {text(zh, '处不确定', 'uncertainties')}</span></footer></button>
  </article>)}</div><Pagination previous={!!previous.length} next={!!page.nextCursor} page={previous.length + 1} busy={loading} locale={locale} onPrevious={() => { setSelected(''); setLoading(true); setCursor(previous.at(-1)); setPrevious(value => value.slice(0, -1)); }} onNext={() => { setSelected(''); setLoading(true); setPrevious(value => [...value, cursor]); setCursor(page.nextCursor); }} /></aside>
  {item && <BotMaintenanceCandidateReview key={`${item.id}:${item.revision}`} summary={item} call={call} scope={scope} locale={locale} changed={changed} regenerate={regenerate} close={closeReader} position={index + 1} count={page.items.length} hasPrevious={index > 0} hasNext={index < page.items.length - 1} navigate={direction => setSelected(page.items[index + direction]!.id)} />}
  </div>;
}

function Diagnostics({ job, call, scope, locale }: { job: BotMaintenanceJob; call: Call; scope: Scope; locale: Locale }) {
  const zh = locale === 'zh-CN', [page, setPage] = useState<BotMaintenanceDiagnostics>({ items: [] }), [after, setAfter] = useState<number>(), [previous, setPrevious] = useState<Array<number | undefined>>([]), [entry, setEntry] = useState<BotMaintenanceDiagnostics['entry']>(), [entryPrevious, setEntryPrevious] = useState<number[]>([]), [error, setError] = useState(''), revision = useRef(0), entryRevision = useRef(0);
  const retire = useCallback(() => { ++revision.current; }, []), retireEntry = useCallback(() => { ++entryRevision.current; }, []);
  useEffect(() => retireEntry, [retireEntry]);
  useEffect(() => { const current = ++revision.current; void call({ type: 'memory.maintenance.diagnostics', ...scope, jobId: job.id, after, limit: 20 }).then(raw => { const value = object(raw); if (!Array.isArray(value.items)) throw new Error(text(zh, '未取得诊断记录。', 'No diagnostics were returned.')); if (current === revision.current) setPage({ ...value, items: value.items.slice(0, 20) } as unknown as BotMaintenanceDiagnostics); }).catch(reason => { if (current === revision.current) setError(errorText(reason, zh)); }); return retire; }, [call, scope, job.id, job.updatedAt, after, zh, retire]);
  const read = async (id: number, offset = 0) => { const current = ++entryRevision.current; setError(''); try { const value = object(await call({ type: 'memory.maintenance.diagnostics', ...scope, jobId: job.id, entryId: id, offset, limit: 20 })); const full = object(value.entry); if (full.id !== id || typeof full.text !== 'string') throw new Error(text(zh, '未取得这段原文。', 'No original diagnostic text was returned.')); if (current === entryRevision.current) setEntry(full as unknown as NonNullable<BotMaintenanceDiagnostics['entry']>); } catch (reason) { if (current === entryRevision.current) setError(errorText(reason, zh)); } };
  return <><p className="bot-memory-hint">{text(zh, '这里保留梦境叙事、分析与执行诊断。联想是推测，不会因为出现在这里就写成用户事实。', 'Dream narratives, analysis, and execution diagnostics appear here. Associations are conjecture; appearing here does not turn them into user facts.')}</p>{error && <p className="bot-memory-alert" role="alert">{error}</p>}{!page.items.length ? <Empty title={text(zh, '还没有诊断记录', 'No diagnostics yet')} /> : page.items.map(item => <article className="bot-maintenance-diagnostic" key={item.id}><header><span>{label(phases, item.phase, zh)} · {stamp(item.createdAt, locale)}</span><button onClick={() => { setEntryPrevious([]); void read(item.id); }}>{text(zh, '阅读这段', 'Read entry')}</button></header><p>{item.preview}</p></article>)}
    <Pagination previous={!!previous.length} next={page.nextAfter !== undefined} page={previous.length + 1} busy={false} locale={locale} onPrevious={() => { setEntry(undefined); setAfter(previous.at(-1)); setPrevious(value => value.slice(0, -1)); }} onNext={() => { setEntry(undefined); setPrevious(value => [...value, after]); setAfter(page.nextAfter); }} />
    {entry && <article className="bot-maintenance-diagnostic"><header><strong>{text(zh, '原始诊断正文', 'Original diagnostic text')}</strong><span>{entry.offset} / {entry.total}</span></header><pre>{entry.text}</pre><Pagination previous={!!entryPrevious.length} next={entry.nextOffset !== undefined} page={entryPrevious.length + 1} busy={false} locale={locale} onPrevious={() => { const offset = entryPrevious.at(-1)!; setEntryPrevious(value => value.slice(0, -1)); void read(entry.id, offset); }} onNext={() => { setEntryPrevious(value => [...value, entry.offset]); void read(entry.id, entry.nextOffset); }} /></article>}
  </>;
}
