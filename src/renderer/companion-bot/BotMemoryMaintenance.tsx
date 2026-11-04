import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { BotMaintenanceCandidateDetail, BotMaintenanceCandidateSummary, BotMaintenanceCandidates, BotMaintenanceDiagnostics, BotMaintenanceJob,
  BotMaintenanceKind, BotMaintenanceList, BotMaintenanceSettings, BotMemoryMaintenanceRequest } from '../../shared/companion-bot-maintenance';
import type { BotMemoryFullNote, BotMemoryWorkspaceRequest } from '../../shared/companion-bot-memory';
import { formatBotReplyDuration } from './BotReplyTiming';
import './bot-memory-maintenance.css';

type Locale = 'zh-CN' | 'en';
type Scope = { conversationId: string; companionId: string };
type Call = (input: BotMemoryWorkspaceRequest) => Promise<unknown>;
const text = (zh: boolean, chinese: string, english: string) => zh ? chinese : english;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const completeCandidate = (value: Record<string, unknown>) => typeof value.id === 'string' && typeof value.jobId === 'string' && typeof value.content === 'string'
  && typeof value.revision === 'string' && /^[a-f0-9]{64}$/i.test(value.revision) && typeof value.status === 'string'
  && [value.tags, value.uncertainties, value.quotes, value.sources].every(Array.isArray);
const activeStatuses = new Set(['queued', 'running', 'applying']);
const states: Record<string, [string, string]> = {
  queued: ['排队中', 'Queued'], running: ['生成方案中', 'Planning'], review: ['等待审阅', 'Awaiting review'], applying: ['正在核实写入', 'Verifying writes'],
  completed: ['已完成', 'Completed'], cancelled: ['已取消', 'Cancelled'], failed: ['未完成', 'Failed'], blocked: ['需人工检查', 'Needs review'],
  pending: ['待批准', 'Pending review'], approved: ['已批准，待执行', 'Approved, awaiting execution'], rejected: ['已驳回', 'Rejected'], applied: ['已应用', 'Applied'],
  conflict: ['来源已变化', 'Source changed'], unknown: ['结果待核实', 'Outcome unconfirmed'], partial: ['部分完成，待核实', 'Partially completed; verify'], withdrawn: ['来源已撤回', 'Source withdrawn'],
};
const phases: Record<string, [string, string]> = {
  queued: ['等待后台处理', 'Waiting to start'], scan: ['查找可整理日记', 'Finding notes'], read: ['读取来源原文', 'Reading sources'],
  dream: ['生成梦境候选', 'Generating dream candidates'], organize: ['生成整理方案', 'Planning organization'], pending_review: ['等待逐项审阅', 'Awaiting individual review'],
  review: ['等待逐项审阅', 'Awaiting individual review'], applying: ['应用已批准方案', 'Applying approved actions'], completed: ['处理结束', 'Finished'],
  partial: ['部分结果待核实', 'Some outcomes need verification'], unknown: ['核实执行结果', 'Verifying the outcome'], withdrawn: ['来源已撤回', 'Source withdrawn'],
  scanning: ['查找可整理日记', 'Finding notes'], reading: ['读取来源原文', 'Reading sources'], recalling: ['回查相关记忆', 'Recalling related memories'], planning: ['生成候选方案', 'Generating candidates'],
  waiting_index: ['等待索引确认', 'Waiting for indexing confirmation'], waiting_idle: ['等待空闲条件', 'Waiting for idle conditions'], paused_user: ['用户交互期间已暂停', 'Paused during user activity'],
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
      <div className="bot-maintenance-job-list" aria-busy={loading}>{loading ? <Empty title={text(zh, '正在读取…', 'Loading…')} /> : !page.items.length ? <Empty title={text(zh, '还没有维护任务', 'No maintenance tasks')} hint={text(zh, '可以手动生成方案，或启用后台计划。', 'Start a plan manually or enable the background schedule.')} /> : page.items.map(item => <button key={item.id} className="bot-maintenance-job" aria-current={selected === item.id} onClick={() => choose(item.id)} data-maintenance-job={item.id}><div><strong>{kinds(item.kind, zh)} · {item.automatic ? text(zh, '后台', 'Background') : text(zh, '手动', 'Manual')}</strong><Status value={item.status} zh={zh} /></div><p>{label(phases, item.phase, zh)}</p><p><time>{stamp(item.createdAt, locale)}</time> · {formatBotReplyDuration(item.elapsedMs, locale)}</p></button>)}</div>
      </div>
      <Pagination previous={!!previous.length} next={!!page.nextCursor} page={previous.length + 1} busy={loading} locale={locale} onPrevious={() => { setCursor(previous.at(-1)); setPrevious(value => value.slice(0, -1)); }} onNext={() => { setPrevious(value => [...value, cursor]); setCursor(page.nextCursor); }} />
    </aside><section className="bot-maintenance-detail" aria-busy={detailLoading}>{detailLoading ? <Empty title={text(zh, '正在读取任务…', 'Loading task…')} /> : !job ? <Empty title={text(zh, '选择一个任务查看方案', 'Select a task to inspect its plan')} hint={text(zh, '来源、候选和诊断记录都按需读取。', 'Sources, candidates, and diagnostics load on demand.')} /> : <>
      <header className="bot-maintenance-detail-heading"><div><h3>{kinds(job.kind, zh)}<span> · </span><Status value={job.status} zh={zh} /></h3><p role="status">{label(phases, job.phase, zh)} · <JobClock key={job.id} job={job} locale={locale} /></p></div><div className="bot-maintenance-job-actions">
        {job.nextCursor && job.phase !== 'source_withdrawn' && ['review', 'completed'].includes(job.status) && <button disabled={busy} onClick={() => void act('run', job.kind, job.nextCursor)}>{text(zh, '继续下一批', 'Continue with the next batch')}</button>}
        {['queued', 'running', 'review', 'applying'].includes(job.status) && <button disabled={busy} onClick={() => void act('cancel')}>{text(zh, '取消待处理部分', 'Cancel remaining work')}</button>}
        {job.phase !== 'source_withdrawn' && ['failed', 'blocked', 'cancelled'].includes(job.status) && <button disabled={busy} onClick={() => void act('retry')}>{text(zh, '重试未完成部分', 'Retry unfinished work')}</button>}
      </div></header>
      {job.error && <div className="bot-memory-alert" role="alert">{job.error}</div>}
      <dl className="bot-maintenance-facts">{([[text(zh, '已检查', 'Examined'), job.metrics.examined], [text(zh, '选为来源', 'Selected sources'), job.metrics.selected], [text(zh, '留待后续', 'Deferred'), job.metrics.deferred], [text(zh, '候选', 'Candidates'), job.metrics.candidates], [text(zh, '已应用', 'Applied'), job.metrics.applied], [text(zh, '已驳回', 'Rejected'), job.metrics.rejected]] as const).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      <JobPlan key={job.id} job={job} call={call} scope={scope} locale={locale} changed={refresh} />
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
  const valid = draft && Number.isInteger(draft.intervalHours) && draft.intervalHours >= 24 && draft.intervalHours <= 720 && Number.isInteger(draft.idleMinutes) && draft.idleMinutes >= 5 && draft.idleMinutes <= 1440 && Number.isInteger(draft.minNotes) && draft.minNotes >= 4 && draft.minNotes <= 1000;
  return <details className="bot-maintenance-settings"><summary>{text(zh, '周期后台计划', 'Background schedule')}<span>{value ? value.enabled ? text(zh, '已启用', 'Enabled') : text(zh, '未启用', 'Disabled') : text(zh, '读取中', 'Loading')}</span></summary>
    <button className="bot-maintenance-settings-refresh" type="button" onClick={() => void load()}>{text(zh, '重新读取设置', 'Reload settings')}</button>{draft && <form onChange={() => { dirty.current = true; }} onSubmit={event => { event.preventDefault(); if (valid) void save(); }}><div className="bot-maintenance-settings-form">
      <label className="is-toggle"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{text(zh, '启用周期后台维护', 'Enable background maintenance')}</label>
      <label>{text(zh, '后台类型', 'Background mode')}<select aria-label={text(zh, '后台类型', 'Background mode')} value={draft.kind} disabled={busy} onChange={event => setDraft({ ...draft, kind: event.target.value as BotMaintenanceKind })}><option value="organize">{text(zh, '整理', 'Organization')}</option><option value="dream">{text(zh, '梦境', 'Dream')}</option></select></label>
      <label>{text(zh, '应用策略', 'Application policy')}<select aria-label={text(zh, '应用策略', 'Application policy')} value={draft.autoApply} disabled={busy} onChange={event => setDraft({ ...draft, autoApply: event.target.value as 'never' | 'lossless' })}><option value="never">{text(zh, '全部逐项批准', 'Review every candidate')}</option><option value="lossless">{text(zh, '仅无损整理可自动应用', 'Auto-apply lossless organization only')}</option></select></label>
      {(['intervalHours', 'idleMinutes', 'minNotes'] as const).map((key, index) => <label key={key}>{[text(zh, '最短间隔（小时）', 'Minimum interval (hours)'), text(zh, '空闲至少（分钟）', 'Minimum idle time (minutes)'), text(zh, '最少日记数', 'Minimum note count')][index]}<input type="number" aria-label={[text(zh, '最短间隔（小时）', 'Minimum interval (hours)'), text(zh, '空闲至少（分钟）', 'Minimum idle time (minutes)'), text(zh, '最少日记数', 'Minimum note count')][index]} min={[24, 5, 4][index]} max={[720, 1440, 1000][index]} value={draft[key]} disabled={busy} onChange={event => setDraft({ ...draft, [key]: Number(event.target.value) })} /></label>)}
    </div><div className="bot-maintenance-settings-footer"><p>{text(zh, '模型改写、归档和梦境感悟仍需批准。每批最多24篇、每天自动最多1个计划；还须满足空闲与日记数量条件，不保证准点执行。', 'Model rewrites, archiving, and dream insights still require approval. Batches contain at most 24 notes, with at most one automatic plan daily. Idle time and note count conditions also apply; this is not an exact timer.')}<br />{value?.enabled ? `${text(zh, '最早检查时间：', 'Earliest check: ')}${stamp(value.nextEligibleAt, locale)}` : text(zh, '未开启后台计划，仍可手动生成候选。', 'Background scheduling is off; manual planning remains available.')}{value?.blockedReason && <><br />{value.blockedReason}</>}</p><button className="is-primary" type="submit" disabled={busy || !valid}>{busy ? text(zh, '保存中…', 'Saving…') : text(zh, '保存后台设置', 'Save schedule')}</button></div></form>}
  </details>;
}

function JobPlan({ job, call, scope, locale, changed }: { job: BotMaintenanceJob; call: Call; scope: Scope; locale: Locale; changed(): void }) {
  const zh = locale === 'zh-CN', [tab, setTab] = useState<'candidates' | 'diagnostics'>('candidates');
  if (job.phase === 'source_withdrawn') return <div className="bot-maintenance-safety" role="status"><strong>{text(zh, '来源资料已撤回', 'Sources withdrawn')}</strong>{text(zh, '旧候选和诊断正文已停止显示。请依据当前可用日记生成新方案。', 'Old candidates and diagnostic text are no longer displayed. Generate a fresh plan from the currently available notes.')}</div>;
  return <><nav className="bot-maintenance-detail-tabs" aria-label={text(zh, '任务内容', 'Task contents')}><button aria-pressed={tab === 'candidates'} onClick={() => setTab('candidates')}>{text(zh, '候选方案', 'Candidates')}</button><button aria-pressed={tab === 'diagnostics'} onClick={() => setTab('diagnostics')}>{text(zh, '梦境与诊断', 'Dreams and diagnostics')}</button></nav>
    <p className="bot-maintenance-guidance"><strong>{job.kind === 'dream' ? text(zh, '梦境不是用户事实。', 'Dreams are not user facts. ') : text(zh, '候选不等于已改写。', 'A candidate is not an applied change. ')}</strong>{text(zh, '每批最多检查24篇；请逐项核对来源后批准。', 'Batches contain at most 24 notes; check sources before approving each action.')}</p>
    {tab === 'candidates' ? <CandidateList job={job} call={call} scope={scope} locale={locale} changed={changed} /> : <Diagnostics job={job} call={call} scope={scope} locale={locale} />}
  </>;
}

function CandidateList({ job, call, scope, locale, changed }: { job: BotMaintenanceJob; call: Call; scope: Scope; locale: Locale; changed(): void }) {
  const zh = locale === 'zh-CN', [page, setPage] = useState<BotMaintenanceCandidates>({ items: [] }), [cursor, setCursor] = useState<string>(), [previous, setPrevious] = useState<Array<string | undefined>>([]), [selected, setSelected] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const revision = useRef(0);
  const retire = useCallback(() => { ++revision.current; }, []);
  useEffect(() => { const current = ++revision.current; void call({ type: 'memory.maintenance.candidates', ...scope, jobId: job.id, cursor, limit: 12 }).then(raw => { const value = object(raw); if (!Array.isArray(value.items)) throw new Error(text(zh, '未取得候选列表。', 'No candidate list was returned.')); if (current === revision.current) setPage({ ...value, items: value.items.slice(0, 12) } as unknown as BotMaintenanceCandidates); }).catch(reason => { if (current === revision.current) setError(errorText(reason, zh)); }).finally(() => { if (current === revision.current) setLoading(false); }); return retire; }, [call, scope, job.id, job.updatedAt, cursor, zh, retire]);
  return <>{error && <p className="bot-memory-alert" role="alert">{error}</p>}<div className="bot-maintenance-candidates" aria-busy={loading}>{loading && !page.items.length ? <Empty title={text(zh, '正在读取候选…', 'Loading candidates…')} /> : !page.items.length ? <Empty title={text(zh, '还没有候选方案', 'No candidates yet')} hint={text(zh, '任务完成扫描后，会在这里列出可审阅方案。', 'Reviewable plans appear here after scanning.')} /> : page.items.map(item => <article className="bot-maintenance-candidate" key={item.id} data-maintenance-candidate={item.id}>
    <button className="bot-maintenance-candidate-open" aria-expanded={selected === item.id} onClick={() => setSelected(selected === item.id ? '' : item.id)}><div><strong>{actionName(item.type, zh)}</strong><Status value={item.status} zh={zh} /></div><p>{item.title}</p><footer><span>{item.sourceCount} {text(zh, '篇来源', 'sources')}</span><span>{item.uncertaintyCount} {text(zh, '处不确定', 'uncertainties')}</span></footer></button>
    {selected === item.id && <CandidateDetail key={`${item.id}:${item.revision}`} summary={item} call={call} scope={scope} locale={locale} changed={changed} />}
  </article>)}</div><Pagination previous={!!previous.length} next={!!page.nextCursor} page={previous.length + 1} busy={loading} locale={locale} onPrevious={() => { setSelected(''); setLoading(true); setCursor(previous.at(-1)); setPrevious(value => value.slice(0, -1)); }} onNext={() => { setSelected(''); setLoading(true); setPrevious(value => [...value, cursor]); setCursor(page.nextCursor); }} /></>;
}

function CandidateDetail({ summary, call, scope, locale, changed }: { summary: BotMaintenanceCandidateSummary; call: Call; scope: Scope; locale: Locale; changed(): void }) {
  const zh = locale === 'zh-CN', [detail, setDetail] = useState<BotMaintenanceCandidateDetail>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [attempt, setAttempt] = useState(0), [sourceChanged, setSourceChanged] = useState(false);
  const alive = useRef(true), locked = useRef(false), readRevision = useRef(0), requestIds = useRef(new Map<string, string>());
  const approvalButton = useRef<HTMLButtonElement>(null), confirmationBox = useRef<HTMLDivElement>(null);
  const retire = useCallback(() => { alive.current = false; ++readRevision.current; }, []);
  useLayoutEffect(() => {
    if (!confirm) return;
    const box = confirmationBox.current, trigger = approvalButton.current, opener = box?.closest('.bot-maintenance-candidate')?.querySelector<HTMLButtonElement>('.bot-maintenance-candidate-open');
    box?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => { if (box?.contains(document.activeElement)) { if (trigger?.isConnected) trigger.focus(); else if (opener?.isConnected) opener.focus(); } };
  }, [confirm]);
  const closeConfirmation = () => { approvalButton.current?.focus(); setConfirm(false); };
  useEffect(() => { alive.current = true; const current = ++readRevision.current; void call({ type: 'memory.maintenance.candidate', ...scope, jobId: summary.jobId, candidateId: summary.id }).then(raw => { const value = object(raw); if (value.id !== summary.id || !completeCandidate(value)) throw new Error(text(zh, '未取得完整候选。', 'No complete candidate was returned.')); if (alive.current && current === readRevision.current) { setDetail(value as unknown as BotMaintenanceCandidateDetail); setError(''); } }).catch(reason => { if (alive.current && current === readRevision.current) { setDetail(undefined); setConfirm(false); setError(errorText(reason, zh)); } }); return retire; }, [call, scope, summary.jobId, summary.id, summary.status, summary.updatedAt, attempt, zh, retire]);
  const review = async (decision: 'approve' | 'reject') => { if (!detail || locked.current || decision === 'approve' && sourceChanged) return; locked.current = true; setBusy(true); setError('');
    const key = `${decision}:${detail.revision}`, requestId = requestIds.current.get(key) ?? crypto.randomUUID(); requestIds.current.set(key, requestId);
    try { const value = object(await call({ type: 'memory.maintenance.review', ...scope, jobId: detail.jobId, candidateId: detail.id, revision: detail.revision, decision, requestId }));
      if (value.id !== detail.id || !completeCandidate(value)) throw new Error(text(zh, '未取得完整回执，请重新读取核实。', 'No complete receipt. Reload to verify.'));
      if (alive.current) { setDetail(value as unknown as BotMaintenanceCandidateDetail); setConfirm(false); requestIds.current.delete(key); changed(); }
    } catch (reason) { if (alive.current) setError(errorText(reason, zh)); } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="bot-maintenance-candidate-detail">{error && <div className="bot-memory-alert" role="alert">{error}<button onClick={() => { setError(''); setAttempt(value => value + 1); }}>{text(zh, '重新读取候选', 'Reload candidate')}</button></div>}{!detail ? !error && <p>{text(zh, '正在读取候选…', 'Loading candidate…')}</p> : <>
    <h4>{text(zh, '为什么提出这项改动', 'Why this change is proposed')}</h4><p>{detail.reason || '—'}</p>
    <h4>{detail.type === 'insight' ? text(zh, '拟保存的梦境感悟 · 非用户事实', 'Proposed dream insight · not a user fact') : detail.type === 'archive' ? text(zh, '拟归档内容', 'Content proposed for archiving') : text(zh, '拟写入的完整内容', 'Complete proposed content')}</h4><pre className="bot-maintenance-proposed">{detail.type === 'archive' && !detail.content ? text(zh, '仅归档下方来源原件，不改写正文。', 'Archive only the original sources below; their content is not rewritten.') : detail.content}</pre>
    {!!detail.tags.length && <div className="bot-memory-note-tags">{detail.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
    <h4>{text(zh, '不确定与需核实之处', 'Uncertainties to verify')}</h4>{detail.uncertainties.length ? <ul>{detail.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{text(zh, '方案未列出不确定项；这不表示内容已通过事实核实。', 'No uncertainties were listed; this does not establish factual correctness.')}</p>}
    <h4>{text(zh, '来源与原文对照', 'Sources and original evidence')}</h4><Sources detail={detail} call={call} scope={scope} locale={locale} onSourceChanged={() => setSourceChanged(true)} />
    <p className="bot-maintenance-scores">{text(zh, '此方案未提供原始评分；候选顺序和日记数量不代表事实可信度。', 'No original scores were supplied. Candidate order and note counts are not factual confidence scores.')}</p>
    {detail.receipt && <details className="bot-maintenance-scores"><summary>{text(zh, '执行原始回执', 'Original execution receipt')}</summary><pre>{JSON.stringify(detail.receipt, null, 2)}</pre></details>}
    {sourceChanged && detail.status === 'pending' && <p className="bot-memory-alert" role="alert">{text(zh, '来源与方案快照已不同，请重新生成方案后再批准。', 'A source differs from the plan snapshot. Generate a fresh plan before approval.')}</p>}
    <div className="bot-maintenance-review-actions"><Status value={detail.status} zh={zh} />{detail.status === 'pending' && <><button disabled={busy} onClick={() => void review('reject')}>{text(zh, '驳回候选', 'Reject candidate')}</button><button ref={approvalButton} className="is-primary" disabled={busy || sourceChanged} onClick={() => setConfirm(true)}>{text(zh, '审阅并批准', 'Review and approve')}</button></>}</div>
    {confirm && detail.status === 'pending' && <div ref={confirmationBox} className="bot-maintenance-review-confirm" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeConfirmation(); } }}><p>{detail.type === 'archive' ? text(zh, '批准后将归档这项候选指定的冗余日记：退出召回、保留原件，不撤回同源的其他事实。', 'Approval archives the specified redundant notes: originals remain, and other facts from the same source are not withdrawn.') : detail.type === 'insight' ? text(zh, '批准后仅作为有来源的梦境感悟保存，不作为用户事实。', 'Approval saves a sourced dream insight, not a user fact.') : text(zh, '批准这项候选的完整内容与来源变更？系统会再次核对来源版本；发生冲突不会覆盖新记录。', 'Approve this content and its source changes? Source versions are checked again; conflicts do not overwrite newer notes.')}</p><div><button disabled={busy} onClick={closeConfirmation}>{text(zh, '继续检查', 'Keep reviewing')}</button><button className="is-primary" disabled={busy || sourceChanged} onClick={() => void review('approve')}>{busy ? text(zh, '核实中…', 'Verifying…') : text(zh, '确认批准此项', 'Confirm this approval')}</button></div></div>}
  </>}</div>;
}

function Sources({ detail, call, scope, locale, onSourceChanged }: { detail: BotMaintenanceCandidateDetail; call: Call; scope: Scope; locale: Locale; onSourceChanged(): void }) {
  const zh = locale === 'zh-CN', [selected, setSelected] = useState(''), [note, setNote] = useState<BotMemoryFullNote>(), [error, setError] = useState(''), revision = useRef(0);
  useEffect(() => () => { ++revision.current; }, []);
  const read = async (id: string) => { const current = ++revision.current; setSelected(id); setNote(undefined); setError('');
    try { const value = object(await call({ type: 'memory.note', ...scope, id })); if (value.id !== id || typeof value.content !== 'string') throw new Error(text(zh, '未取得来源原件。', 'No original source was returned.')); if (current === revision.current) { setNote(value as unknown as BotMemoryFullNote); const source = detail.sources.find(item => item.id === id); if (source && value.checksum !== source.checksum) onSourceChanged(); } }
    catch (reason) { if (current === revision.current) setError(errorText(reason, zh)); }
  };
  return <div className="bot-maintenance-source-list">{detail.sources.map((source, index) => <article className="bot-maintenance-source" key={source.id}><div><span>{text(zh, '来源', 'Source')} {index + 1} · {stamp(source.createdAt, locale)}</span><button onClick={() => void read(source.id)}>{text(zh, '查看原日记', 'Read original note')}</button></div>{detail.quotes.filter(quote => quote.sourceId === source.id).map((quote, position) => <blockquote className="bot-maintenance-quote" key={position}>{quote.text}</blockquote>)}{selected === source.id && <>{error && <p role="alert">{error}</p>}{note ? <><p className="bot-memory-hint">{note.checksum !== source.checksum ? text(zh, '来源已变化：下方是当前版本，上方引用保留方案生成时的摘录。', 'Source changed: the text below is the current version; the quotes above retain the excerpts used to generate this plan.') : text(zh, '当前原件全文，与方案来源版本一致。', 'Current original text; its version matches the plan source.')}{note.indexState === 'archived' && ` ${text(zh, '此原件已归档，仍可读取。', 'This original is archived and remains readable.')}`}</p><div className="bot-maintenance-source-body">{note.content}</div></> : !error && <p>{text(zh, '正在读取…', 'Loading…')}</p>}</>}</article>)}</div>;
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
