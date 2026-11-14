import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorldlineBoxBotApi } from '../../shared/companion-bot';
import { scheduleUsesCabin, type CompanionScheduleState, type ScheduleCommand, type ScheduleDraft } from '../../shared/companion-schedule';

const emptyDraft: ScheduleDraft = { title: '', prompt: '', recurrence: { kind: 'daily', time: '09:00' }, enabled: true };
const pageSize = 8;

export function BotCompanionSchedules({ api, companionId, locale }: { api: WorldlineBoxBotApi; companionId: string; locale: 'zh-CN' | 'en' }) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [state, setState] = useState<CompanionScheduleState>();
  const [draft, setDraft] = useState<ScheduleDraft>();
  const [editId, setEditId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const mutation = useRef(0);
  useEffect(() => {
    let active = true;
    let loading = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (loading) { dirty = true; return; }
      loading = true; dirty = false;
      const revision = mutation.current;
      try {
        const result = await api.request({ type: 'companion.schedule', companionId, command: { operation: 'list' } });
        if (!active || revision !== mutation.current) return;
        if (result.schedule) setState(result.schedule); else setError(result.error ?? '无法读取日程。');
      } catch { if (active && revision === mutation.current) setError('无法读取日程。'); }
      finally { loading = false; if (active && dirty) refresh(); }
    };
    const refresh = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void load(); }, 350); };
    void load();
    const unsubscribe = api.onEvent(event => { if (event.type === 'changed') refresh(); });
    return () => { active = false; clearTimeout(timer); unsubscribe(); };
  }, [api, companionId]);

  async function change(command: ScheduleCommand): Promise<boolean> {
    mutation.current++; setBusy(true); setError('');
    try {
      const result = await api.request({ type: 'companion.schedule', companionId, command });
      if (!result.ok || !result.schedule) throw Error(result.error || t('日程保存失败。', 'Could not save the schedule.'));
      setState(result.schedule); return true;
    } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); return false; }
    finally { mutation.current++; setBusy(false); }
  }
  const formatter = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }), [locale]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (state?.items ?? []).filter(item => (filter === 'all' || filter === item.recurrence.kind || (filter === 'paused' && !item.enabled))
      && (!term || item.title.toLocaleLowerCase().includes(term) || item.prompt.toLocaleLowerCase().includes(term)))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextAt - b.nextAt);
  }, [state?.items, query, filter]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const stamp = (value: number) => formatter.format(value);
  return <section className="bot-settings-scroll bot-schedule-panel">
    <header className="bot-settings-section-heading"><h3>{t('日程', 'Schedule')}</h3><p>{t('到点后，伙伴会在新的 DSH 会话中按任务提示词执行。WorldlineBox 需要保持运行。', 'At the scheduled time, the companion runs the task prompt in a new DSH session. WorldlineBox must be running.')}</p></header>
    <div className="bot-schedule-toolbar">
      <label><input type="checkbox" role="switch" checked={!!state?.enabled} disabled={!state || busy} onChange={event => void change({ operation: 'settings', enabled: event.target.checked })} />{t('启用这位伙伴的日程', 'Enable this companion’s schedules')}</label>
      <button type="button" onClick={() => { setEditId(undefined); setDraft(emptyDraft); }}>{t('新增日程', 'New schedule')}</button>
    </div>
    {error && <p className="bot-error" role="alert">{error}</p>}
    {draft && <form className="bot-settings-card bot-schedule-form" onSubmit={event => { event.preventDefault(); void change({ operation: 'save', id: editId, draft }).then(saved => { if (saved) setDraft(undefined); }); }}>
      <h4>{editId ? t('编辑日程', 'Edit schedule') : t('新增日程', 'New schedule')}</h4>
      <label>{t('名称', 'Name')}<input autoFocus value={draft.title} required maxLength={80} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>{t('任务提示词', 'Task prompt')}<textarea required rows={6} maxLength={8000} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>
      <div className="bot-schedule-fields">
        <label>{t('触发方式', 'Trigger')}<select value={draft.recurrence.kind} onChange={event => setDraft({ ...draft, recurrence: event.target.value === 'daily' ? { kind: 'daily', time: '09:00' } : { kind: 'interval', minutes: 60 } })}><option value="daily">{t('每日定时', 'Daily at a set time')}</option><option value="interval">{t('固定间隔', 'Fixed interval')}</option></select></label>
        {draft.recurrence.kind === 'daily' ? <label>{t('本地时间', 'Local time')}<input type="time" required value={draft.recurrence.time} onChange={event => setDraft({ ...draft, recurrence: { kind: 'daily', time: event.target.value } })} /></label>
          : <label>{t('间隔分钟', 'Minutes')}<input type="number" min={1} max={10080} required value={draft.recurrence.minutes || ''} onChange={event => setDraft({ ...draft, recurrence: { kind: 'interval', minutes: Number(event.target.value) } })} /></label>}
        <label><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{t('启用', 'Enabled')}</label>
        <label><input type="checkbox" checked={scheduleUsesCabin({ ...draft, cabinWorld: false }) || draft.cabinWorld === true} disabled={scheduleUsesCabin({ ...draft, cabinWorld: false })} onChange={event => setDraft({ ...draft, cabinWorld: event.target.checked })} />{t('需要小屋世界在线', 'Requires Cabin World online')}</label>
      </div>
      <footer><button type="button" onClick={() => setDraft(undefined)}>{t('取消', 'Cancel')}</button><button type="submit" className="bot-editor-primary" disabled={busy}>{t('保存', 'Save')}</button></footer>
    </form>}
    <div className="bot-schedule-toolbar bot-schedule-filters">
      <input type="search" aria-label={t('搜索日程', 'Search schedules')} placeholder={t('搜索名称或任务提示词', 'Search names or prompts')} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <select aria-label={t('筛选日程', 'Filter schedules')} value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }}>
        <option value="all">{t('全部日程', 'All schedules')}</option><option value="daily">{t('每日定时', 'Daily')}</option><option value="interval">{t('固定间隔', 'Interval')}</option><option value="paused">{t('已暂停', 'Paused')}</option>
      </select>
    </div>
    <div className="bot-schedule-list" aria-busy={!state}>
      {state && !visible.length && <p className="bot-schedule-empty">{state.items.length ? t('没有符合条件的日程。', 'No matching schedules.') : t('还没有日程。', 'No schedules yet.')}</p>}
      {visible.map(item => {
        const daily = item.recurrence.kind === 'daily';
        const recurrence = item.recurrence.kind === 'daily' ? t(`每天 ${item.recurrence.time}`, `Daily at ${item.recurrence.time}`) : t(`每 ${item.recurrence.minutes} 分钟`, `Every ${item.recurrence.minutes} minutes`);
        const open = expanded === item.id;
        return <article key={item.id} className="bot-schedule-item">
          <div className="bot-schedule-row-heading">
            <button className="bot-schedule-summary" type="button" aria-expanded={open} onClick={() => setExpanded(open ? undefined : item.id)}><strong>{item.title}</strong><span>{recurrence}</span></button>
            <label className="bot-schedule-toggle"><input type="checkbox" role="switch" aria-label={item.title} checked={item.enabled} disabled={busy} onChange={event => void change({ operation: 'toggle', id: item.id, enabled: event.target.checked })} /><span>{item.enabled ? t('启用', 'Enabled') : t('暂停', 'Paused')}</span></label>
          </div>
          <dl className="bot-schedule-meta">
            <div><dt>{t('下次触发', 'Next run')}</dt><dd>{!item.enabled ? t('此项已暂停', 'Schedule paused') : !state?.enabled ? t('总开关已关闭', 'Schedules are off') : stamp(item.nextAt)}</dd></div>
            {item.lastRun && <div><dt>{t('上次触发', 'Last trigger')}</dt><dd>{stamp(item.lastRun.at)} · {{ queued: t('等待执行', 'Queued'), running: t('执行中', 'Running'), done: t('完成', 'Completed'), failed: t('失败', 'Failed'), cancelled: t('已取消', 'Cancelled'), skipped: t('已跳过 · 小屋世界离线', 'Skipped · Cabin World offline'), unknown: t('状态未知', 'Status unknown') }[item.lastRun.status]}</dd></div>}
          </dl>
          {open ? <div className="bot-schedule-detail"><h5>{t('触发规则', 'Trigger rule')}</h5><p>{daily ? t('按电脑本地时间每天触发。', 'Runs daily at the local time shown above.') : t('每次触发后重新计算间隔。', 'The next interval starts when this run is queued.')}</p><h5>{t('任务提示词', 'Task prompt')}</h5><p className="bot-schedule-prompt">{item.prompt}</p>{scheduleUsesCabin(item) && <p>{t('小屋世界离线时跳过本次日程。', 'This run is skipped if Cabin World is offline.')}</p>}</div>
            : <p className="bot-schedule-preview">{item.prompt.slice(0, 180)}{item.prompt.length > 180 ? '…' : ''}</p>}
          <footer><button type="button" onClick={() => { setEditId(item.id); setExpanded(item.id); setDraft({ title: item.title, prompt: item.prompt, recurrence: item.recurrence, enabled: item.enabled, cabinWorld: item.cabinWorld }); }}>{t('编辑', 'Edit')}</button>
            {removing === item.id ? <><button type="button" onClick={() => setRemoving(undefined)}>{t('取消', 'Cancel')}</button><button type="button" disabled={busy} onClick={() => void change({ operation: 'delete', id: item.id }).then(ok => { if (ok) { setRemoving(undefined); if (editId === item.id) setDraft(undefined); } })}>{t('确认删除', 'Confirm removal')}</button></> : <button type="button" onClick={() => setRemoving(item.id)}>{t('删除', 'Remove')}</button>}</footer>
        </article>;
      })}
    </div>
    {pages > 1 && <nav className="bot-schedule-pagination" aria-label={t('日程分页', 'Schedule pages')}><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('上一页', 'Previous')}</button><span>{t(`第 ${currentPage + 1} / ${pages} 页 · ${filtered.length} 项`, `Page ${currentPage + 1} of ${pages} · ${filtered.length} schedules`)}</span><button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>{t('下一页', 'Next')}</button></nav>}
    <p className="bot-schedule-hint">{t('也可以在私聊中请伙伴创建或修改日程。', 'You can also ask the companion in a private chat to create or edit a schedule.')}</p>
  </section>;
}
