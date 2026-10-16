import { useEffect, useRef, useState } from 'react';
import type { CompanionSchedule } from '../../shared/companion-schedule';
import { companionScheduleEntrySchema } from '../../shared/companion-schedule';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { Avatar } from './CompanionVisuals';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { companionTimestamp } from '../../shared/companion-time';
import { RECURRENCE_LABELS, scheduleStatus, scheduleTime, useCompanionSchedules, type ScheduleRequest } from './companion-schedules';
import { CompanionRoutineEditor } from './CompanionRoutineEditor';
import { CompanionLifeEvents } from './CompanionLifeEvents';

interface ScheduleDraft { title: string; prompt: string; kind: CompanionSchedule['kind']; runAt: string; timeZone: string; recurrence: CompanionSchedule['recurrence']; intervalMinutes: number; weekDays: number[]; flexible: boolean }
function inputDateTime(value: string) { const date = new Date(value); const pad = (part: number) => String(part).padStart(2, '0'); return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()); }
function emptyDraft(): ScheduleDraft { return { title: '', prompt: '', kind: 'reminder', runAt: inputDateTime(new Date(Date.now() + 3600_000).toISOString()), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, recurrence: 'once', intervalMinutes: 60, weekDays: [new Date().getDay()], flexible: false }; }
const DAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function CompanionScheduleManager({ companion, companions = [companion], conversationId, conversationKind = 'private', request, api, onClose, requestError, onDismissError }: { readonly companion: Companion; readonly companions?: Companion[]; readonly conversationId: string; readonly conversationKind?: 'private' | 'group'; readonly request: ScheduleRequest; readonly api?: WorldlineBoxCompanionsApi; readonly onClose: () => void; readonly requestError?: string; readonly onDismissError: () => void }) {
  useDialogFocusTrap(true, '伙伴日程');
  const { schedules, occurrences, error: loadError, loading, refresh } = useCompanionSchedules(companion.id, conversationId, request, api);
  const [draft, setDraft] = useState<ScheduleDraft>(emptyDraft);
  const [editing, setEditing] = useState<CompanionSchedule>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'upcoming' | 'completed' | 'all'>('upcoming');
  const [confirmCancel, setConfirmCancel] = useState<string>();
  const [page, setPage] = useState<'plans' | 'routine' | 'life'>('plans');
  const clientId = useRef(crypto.randomUUID());
  const submittedEntry = useRef<string | undefined>(undefined);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [onClose]);
  function begin(schedule?: CompanionSchedule) {
    setEditing(schedule); setCreating(true); setError(''); clientId.current = crypto.randomUUID(); submittedEntry.current = undefined;
    setDraft(schedule ? { title: schedule.title, prompt: schedule.prompt, kind: schedule.kind, runAt: inputDateTime(schedule.runAt), timeZone: schedule.timeZone, recurrence: schedule.recurrence, intervalMinutes: schedule.intervalMinutes ?? 60, weekDays: schedule.weekDays ?? [new Date(schedule.runAt).getDay()], flexible: schedule.flexible ?? false } : emptyDraft());
  }
  async function save() {
    const parsed = companionScheduleEntrySchema.safeParse({ title: draft.title, prompt: draft.prompt, kind: draft.kind, runAt: editing && draft.runAt === inputDateTime(editing.runAt) ? editing.runAt : Number.isFinite(new Date(draft.runAt).getTime()) ? new Date(draft.runAt).toISOString() : '', timeZone: draft.timeZone, recurrence: draft.recurrence, flexible: draft.flexible, ...(draft.recurrence === 'interval' ? { intervalMinutes: draft.intervalMinutes } : {}), ...(draft.recurrence === 'weekly' ? { weekDays: draft.weekDays } : {}) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '请检查时间与安排内容。'); return; }
    if (!editing && new Date(parsed.data.runAt).getTime() < Date.now() - 60_000) { setError('首次执行时间需要安排在未来。'); return; }
    setBusy(true); setError('');
    const entry = parsed.data;
    const entrySignature = JSON.stringify(entry);
    if (submittedEntry.current !== undefined && submittedEntry.current !== entrySignature) clientId.current = crypto.randomUUID();
    submittedEntry.current = entrySignature;
    const result = editing ? await request({ type: 'schedule.update', companionId: companion.id, conversationId, id: editing.id, expectedRevision: editing.revision, patch: { ...entry, intervalMinutes: entry.intervalMinutes ?? null, weekDays: entry.weekDays ?? null } }) : await request({ type: 'schedule.create', companionId: companion.id, conversationId, clientId: clientId.current, entries: [entry] });
    setBusy(false);
    if (!result?.ok) { setError('安排未保存。可能已发生变化，请刷新后重新编辑。'); return; }
    setCreating(false); setEditing(undefined); clientId.current = crypto.randomUUID(); await refresh();
  }
  async function act(schedule: CompanionSchedule, operation: 'pause' | 'run-now' | 'cancel') {
    setBusy(true); setError('');
    const scope = { companionId: companion.id, conversationId, id: schedule.id, expectedRevision: schedule.revision };
    const response = operation === 'pause' ? await request({ type: 'schedule.pause', ...scope, paused: schedule.status !== 'paused' }) : operation === 'cancel' ? await request({ type: 'schedule.cancel', ...scope }) : await request({ type: 'schedule.run-now', ...scope });
    setBusy(false);
    if (!response?.ok) { setError('操作未完成，请刷新后重试。'); return; }
    setConfirmCancel(undefined); await refresh();
  }
  const visible = schedules.filter(schedule => filter === 'all' || (filter === 'completed' ? scheduleStatus(schedule) === '已完成' || schedule.status === 'cancelled' : schedule.status !== 'cancelled' && scheduleStatus(schedule) !== '已完成'));
  return <div className="companions-modal-backdrop companions-workspace-backdrop" onClick={onClose}>
    <section className="companions-schedule-manager" role="dialog" aria-modal="true" aria-label="伙伴日程" onClick={event => event.stopPropagation()}>
      <header><div className="companions-workspace-title"><span className="companions-workspace-symbol"><Icon name="clock" /></span><div><h2>一起安排接下来的日子</h2><p>守时的约定，也有自由生长的日常</p></div></div><div className="companions-memory-manager-owner"><Avatar companion={companion} showPresence={false} /><span>{companion.name}</span><button className="companion-icon-button" aria-label="关闭伙伴日程" onClick={onClose}>×</button></div></header>
      {requestError && <div className="companions-workspace-request-error" role="alert"><span>{requestError}</span><button aria-label="关闭错误提示" onClick={onDismissError}>×</button></div>}
      <nav className="companions-workspace-tabs" aria-label="伙伴日程内容"><button aria-pressed={page === 'plans'} onClick={() => setPage('plans')}><Icon name="clipboard" />日历与待办</button><button aria-pressed={page === 'routine'} onClick={() => setPage('routine')}><Icon name="clock" />作息与习惯</button><button aria-pressed={page === 'life'} onClick={() => setPage('life')}><Icon name="message-circle" />日常事件</button></nav>
      {page === 'life' ? <CompanionLifeEvents companion={companion} companions={companions} request={request} api={api} /> : page === 'routine' ? <CompanionRoutineEditor companionId={companion.id} conversationId={conversationId} readOnly={conversationKind === 'group'} request={request} api={api} /> : <div className="companions-schedule-workspace"><div className="companions-schedule-list">
        <div className="companions-schedule-toolbar"><nav aria-label="日程筛选"><button className={filter === 'upcoming' ? 'is-active' : ''} onClick={() => setFilter('upcoming')}>接下来的安排</button><button className={filter === 'completed' ? 'is-active' : ''} onClick={() => setFilter('completed')}>已结束</button><button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>全部</button></nav><button className="companion-primary-button" onClick={() => begin()}><Icon name="plus" />添加安排</button></div>
        {(error || loadError) && <p className="companions-memory-error" role="alert">{error || loadError} <button onClick={() => void refresh()}>刷新</button></p>}
        {loading && <p className="companions-subtle">正在读取日程…</p>}
        {!loading && !visible.length && <div className="companions-schedule-empty"><Icon name="clipboard" /><h3>给未来留一张便签</h3><p>可以直接在聊天里告诉伙伴，也可以在这里安排提醒或任务。</p><button className="companion-secondary-button" onClick={() => begin()}>添加一件事</button></div>}
        {visible.map(schedule => <article className="companions-schedule-row" key={schedule.id} data-schedule-id={schedule.id}><div className="companions-schedule-row-date"><strong>{new Date(schedule.deferredUntil ?? schedule.nextRunAt ?? schedule.runAt).getDate()}</strong><span>{new Date(schedule.deferredUntil ?? schedule.nextRunAt ?? schedule.runAt).toLocaleDateString('zh-CN', { month: 'short' })}</span></div><div className="companions-schedule-row-body"><div><h3>{schedule.title}</h3><span className="companions-schedule-state">{scheduleStatus(schedule)}</span></div><p>{scheduleTime(schedule.deferredUntil ?? schedule.nextRunAt ?? schedule.runAt)} · {RECURRENCE_LABELS[schedule.recurrence]} · {schedule.kind === 'task' ? '执行任务' : '提醒'}{schedule.flexible && ' · 时间可调整'}</p>{schedule.blockedReason && <p>{schedule.blockedReason === 'resting' ? '伙伴正在休息，将在可调整的时间处理。' : '正在等待模型连接恢复。'} 原定：{scheduleTime(schedule.nextRunAt ?? schedule.runAt)}</p>}<details><summary>查看完整内容与执行记录</summary><p>{schedule.prompt}</p>{schedule.lastResult && <p>最近结果：{schedule.lastResult}</p>}{schedule.lastError && <p role="alert">{schedule.lastError}</p>}{occurrences.filter(item => item.scheduleId === schedule.id).slice(0, 5).map(item => <small key={item.id}>{companionTimestamp(item.scheduledAt)} · {item.status === 'done' ? '已完成' : item.status === 'failed' ? '失败' : item.status === 'running' || item.status === 'dispatching' ? '执行中' : item.status === 'cancelled' ? '已取消' : '等待执行'}{item.result && ' · ' + item.result}</small>)}</details>
          {schedule.status !== 'cancelled' && <div className="companions-schedule-row-actions"><button disabled={busy} onClick={() => begin(schedule)}>编辑</button><button disabled={busy} onClick={() => void act(schedule, 'pause')}>{schedule.status === 'paused' ? '恢复安排' : '暂停'}</button><button disabled={busy} onClick={() => void act(schedule, 'run-now')}>立即执行</button><button disabled={busy} onClick={() => setConfirmCancel(schedule.id)}>取消安排</button></div>}
          {confirmCancel === schedule.id && <div className="companions-schedule-cancel"><p>取消后停止后续安排及正在进行的任务，已产生的结果保留。</p><button onClick={() => setConfirmCancel(undefined)}>保留安排</button><button disabled={busy} onClick={() => void act(schedule, 'cancel')}>确认取消安排</button></div>}</div></article>)}
      </div><aside className="companions-schedule-editor"><span className="companions-note-tape" aria-hidden="true" />{creating ? <form onSubmit={event => { event.preventDefault(); void save(); }}><div className="companions-schedule-editor-heading"><h3>{editing ? '修改这张便签' : '写一张新便签'}</h3><button type="button" aria-label="关闭日程编辑" onClick={() => { setCreating(false); setEditing(undefined); }}>×</button></div><label>标题<input aria-label="安排标题" maxLength={160} required value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} placeholder="例如：周末一起整理照片" /></label><label>要做什么<textarea aria-label="安排内容" rows={5} maxLength={16000} required value={draft.prompt} onChange={event => setDraft(current => ({ ...current, prompt: event.target.value }))} placeholder="完整写下提醒内容，或希望伙伴执行的任务" /></label><div className="companions-schedule-field-row"><label>类型<select aria-label="安排类型" value={draft.kind} onChange={event => setDraft(current => ({ ...current, kind: event.target.value as ScheduleDraft['kind'] }))}><option value="reminder">到时提醒</option><option value="activity">伙伴行动（持续任务）</option><option value="task">到时执行任务</option></select></label><label>重复<select aria-label="安排重复" value={draft.recurrence} onChange={event => setDraft(current => ({ ...current, recurrence: event.target.value as ScheduleDraft['recurrence'] }))}>{Object.entries(RECURRENCE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div><label>首次执行时间<input aria-label="首次执行时间" type="datetime-local" step={1} required value={draft.runAt} onChange={event => setDraft(current => ({ ...current, runAt: event.target.value }))} /></label><small>时间以本地显示 · 日程时区：{draft.timeZone}</small>{draft.recurrence === 'interval' && <label>每隔多少分钟<input aria-label="执行间隔分钟" type="number" min={1} max={525600} required value={draft.intervalMinutes} onChange={event => setDraft(current => ({ ...current, intervalMinutes: Number(event.target.value) }))} /></label>}{draft.recurrence === 'weekly' && <fieldset className="companions-schedule-weekdays"><legend>每周执行日</legend>{DAYS.map((day, index) => <label key={day}><input type="checkbox" aria-label={'星期' + day} checked={draft.weekDays.includes(index)} onChange={event => setDraft(current => ({ ...current, weekDays: event.target.checked ? [...current.weekDays, index].sort() : current.weekDays.filter(value => value !== index) }))} /><span>{day}</span></label>)}</fieldset>}<label className="companions-checkbox"><input type="checkbox" checked={draft.flexible} onChange={event => setDraft(current => ({ ...current, flexible: event.target.checked }))} />时间可调整</label><small>开启后，伙伴可以根据当前状态调整执行时间。应用运行时会执行安排；关闭期间不会启动电脑任务。</small><footer><button type="button" className="companion-secondary-button" onClick={() => setCreating(false)}>暂不保存</button><button className="companion-primary-button" disabled={busy} type="submit">{busy ? '正在保存…' : editing ? '保存安排修改' : '保存安排'}</button></footer></form> : <div className="companions-schedule-editor-empty"><Icon name="edit" /><h3>写下计划，安心去忙</h3><p>一次提醒、每天的习惯，或一项需要伙伴执行的任务。</p><button className="companion-primary-button" onClick={() => begin()}>写一张便签</button></div>}</aside></div>
      }
    </section>
  </div>;
}
