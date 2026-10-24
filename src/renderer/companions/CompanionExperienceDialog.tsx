import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionExperienceDayPage, CompanionExperienceDetail, CompanionExperienceEntry, CompanionExperienceEntryPage, CompanionExperienceKind, CompanionExperienceStatus } from '../../shared/companion-experience';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { Avatar } from './CompanionVisuals';
import { createCoalescedRefresh } from './coalesced-refresh';
import { localDateKey, type ScheduleRequest } from './companion-schedules';
import './companion-experience.css';

const kinds: Record<CompanionExperienceKind, string> = { dsh: '行动与思考', activity: '自主行动', learning: '学习', schedule: '日程', life: '生活', memory: '记忆整理', dream: '做梦' };
const statuses: Record<CompanionExperienceStatus, string> = { queued: '等待开始', running: '进行中', completed: '已完成', failed: '未能完成', cancelled: '已取消', paused: '已暂停', withdrawn: '已撤回' };
function timeLabel(at: string, timeZone: string, full = false) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { ...(timeZone !== 'system' ? { timeZone } : {}), ...(full ? { year: 'numeric', month: '2-digit', day: '2-digit' } as const : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  } catch { return new Date(at).toLocaleString('zh-CN'); }
}
function shiftDay(day: string, delta: number) {
  const date = new Date(day + 'T12:00:00'); date.setDate(date.getDate() + delta); return localDateKey(date.getTime());
}

/** Long reports are read on demand, with a bounded text page even for large CLI sessions. */
function RecordSection({ title, text, initiallyOpen }: { title: string; text: string; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen), [page, setPage] = useState(0);
  const size = 24_000, pages = Math.max(1, Math.ceil(text.length / size));
  return <details className="experience-record-section" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{title}<Icon name="chevron" size={13} /></summary>
    {open && <><pre>{text.slice(page * size, (page + 1) * size) || '暂无记录内容。'}</pre>{pages > 1 && <nav aria-label={`${title}内容分页`}><button type="button" disabled={!page} onClick={() => setPage(value => value - 1)}>上一段</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>下一段</button></nav>}</>}
  </details>;
}

export function CompanionExperienceDialog({ companion, api, request, onClose, onOpenAction }: {
  companion: Companion; api?: WorldlineBoxCompanionsApi; request: ScheduleRequest; onClose(): void; onOpenAction?(id: string): void;
}) {
  const [day, setDay] = useState(() => localDateKey(Date.now())), [cursors, setCursors] = useState<string[]>([]);
  const [days, setDays] = useState<CompanionExperienceDayPage>(), [olderDays, setOlderDays] = useState<CompanionExperienceDayPage['days']>([]);
  const [dayCursor, setDayCursor] = useState<string>(), [dayBusy, setDayBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<{ scope: string; page: CompanionExperienceEntryPage }>(), [error, setError] = useState<{ scope: string; text: string }>();
  const [selectedId, setSelectedId] = useState<string>(), [detail, setDetail] = useState<CompanionExperienceDetail>(), [detailError, setDetailError] = useState('');
  const [renaming, setRenaming] = useState(false), [title, setTitle] = useState(''), [saving, setSaving] = useState(false);
  const cursor = cursors.at(-1), scope = `${companion.id}:${day}:${cursor ?? ''}`;
  const scopeRef = useRef(scope), sequence = useRef(0), detailSequence = useRef(0), alive = useRef(false), loadedDetail = useRef('');
  useLayoutEffect(() => { scopeRef.current = scope; }, [scope]);
  useDialogFocusTrap(true, 'companion-experiences-' + companion.id);
  const page = snapshot?.scope === scope ? snapshot.page : undefined;
  const selected = page?.items.find(item => item.id === selectedId);
  const shownDetail = selected && detail?.entry.id === selected.id && detail.entry.companionId === companion.id && detail.entry.revision === selected.revision && detail.entry.status === selected.status ? detail : undefined;
  const timeZone = page?.timeZone ?? days?.timeZone ?? 'system';
  const dayItems = [...new Map([...(days?.days ?? []), ...olderDays].map(item => [item.day, item])).values()].sort((a, b) => b.day.localeCompare(a.day));

  const refresh = useCallback(async () => {
    const epoch = ++sequence.current;
    try {
      const [entries, calendar] = await Promise.all([
        request({ type: 'experience.list', companionId: companion.id, day, limit: 30, ...(cursor ? { cursor } : {}) }),
        request({ type: 'experience.days', companionId: companion.id, limit: 31 }),
      ]);
      if (!alive.current || epoch !== sequence.current || scopeRef.current !== scope) return;
      if (!entries?.ok || entries.experiencePage?.companionId !== companion.id || entries.experiencePage.day !== day || !calendar?.ok || calendar.experienceDays?.companionId !== companion.id) throw new Error('暂时无法读取经历，请稍后重试。');
      setSnapshot({ scope, page: entries.experiencePage }); setDays(calendar.experienceDays); setError(undefined);
    } catch (cause) {
      if (alive.current && epoch === sequence.current && scopeRef.current === scope) setError({ scope, text: cause instanceof Error ? cause.message : '暂时无法读取经历。' });
    }
  }, [companion.id, day, cursor, request, scope]);
  useEffect(() => {
    alive.current = true;
    const currentSequence = sequence, currentDetailSequence = detailSequence;
    const reads = createCoalescedRefresh(refresh, undefined, 1500); void reads.trigger();
    const unsubscribe = api?.onChanged(() => reads.trigger());
    const timer = setInterval(() => void reads.trigger(), 15_000);
    return () => { alive.current = false; currentSequence.current++; currentDetailSequence.current++; reads.dispose(); unsubscribe?.(); clearInterval(timer); };
  }, [refresh, api]);

  const readDetail = useCallback(async (force = false) => {
    if (!selected) return;
    const key = `${scope}:${selected.id}:${selected.revision}:${selected.status}`;
    if (!force && loadedDetail.current === key) return;
    const epoch = ++detailSequence.current;
    try {
      const result = await request({ type: 'experience.read', companionId: companion.id, id: selected.id });
      if (!alive.current || epoch !== detailSequence.current || scopeRef.current !== scope) return;
      if (!result?.ok || result.experienceDetail?.entry.companionId !== companion.id || result.experienceDetail.entry.id !== selected.id) throw new Error('这条经历的详情暂时无法读取。');
      const received = result.experienceDetail;
      loadedDetail.current = `${scope}:${received.entry.id}:${received.entry.revision}:${received.entry.status}`;
      if (received.entry.revision !== selected.revision || received.entry.status !== selected.status)
        setSnapshot(current => current?.scope === scope ? { ...current, page: { ...current.page, items: current.page.items.map(item => item.id === received.entry.id ? received.entry : item) } } : current);
      setDetail(received); setDetailError('');
    } catch (cause) { if (alive.current && epoch === detailSequence.current && scopeRef.current === scope) setDetailError(cause instanceof Error ? cause.message : '详情暂时无法读取。'); }
  }, [selected, companion.id, request, scope]);
  useEffect(() => { const currentSequence = detailSequence; void Promise.resolve().then(() => readDetail()); return () => { currentSequence.current++; }; }, [readDetail]);

  function chooseDay(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return;
    loadedDetail.current = '';
    setDay(value); setCursors([]); setSelectedId(undefined); setDetail(undefined); setDetailError(''); setRenaming(false);
  }
  function select(entry: CompanionExperienceEntry) {
    if (selectedId === entry.id) return;
    loadedDetail.current = '';
    setSelectedId(entry.id); setDetail(undefined); setDetailError(''); setRenaming(false); setTitle(entry.title);
  }
  async function loadOlderDays() {
    if (dayBusy) return;
    const next = dayCursor ?? days?.nextCursor;
    if (!next) return;
    setDayBusy(true);
    try {
      const result = await request({ type: 'experience.days', companionId: companion.id, cursor: next, limit: 31 });
      if (!alive.current) return;
      if (!result?.ok || result.experienceDays?.companionId !== companion.id) throw new Error();
      setOlderDays(current => [...new Map([...current, ...result.experienceDays!.days].map(item => [item.day, item])).values()].slice(-335));
      setDayCursor(result.experienceDays.hasMore ? result.experienceDays.nextCursor : '');
    } catch { if (alive.current) setError({ scope: scopeRef.current, text: '较早的日期暂时无法读取，请重试。' }); }
    finally { if (alive.current) setDayBusy(false); }
  }
  async function rename() {
    if (!shownDetail || saving || !title.trim()) return;
    const entry = shownDetail.entry, currentScope = scope;
    setSaving(true); setDetailError('');
    try {
      const result = await request({ type: 'experience.rename', companionId: companion.id, id: entry.id, title: title.trim(), expectedRevision: entry.revision });
      if (!alive.current || scopeRef.current !== currentScope) return;
      if (!result?.ok || result.experienceEntry?.id !== entry.id || result.experienceEntry.companionId !== companion.id) throw new Error(result?.error || '命名未保存，经历可能已更新，请刷新后重试。');
      setDetail(current => current?.entry.id === entry.id ? { ...current, entry: result.experienceEntry! } : current);
      setSnapshot(current => current?.scope === currentScope ? { ...current, page: { ...current.page, items: current.page.items.map(item => item.id === entry.id ? result.experienceEntry! : item) } } : current);
      setRenaming(false);
    } catch (cause) { if (alive.current && scopeRef.current === currentScope) setDetailError(cause instanceof Error ? cause.message : '命名未保存，请重试。'); }
    finally { if (alive.current) setSaving(false); }
  }

  return <div className="companions-modal-backdrop experience-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); onClose(); } }}>
    <section className="companion-experience-dialog" role="dialog" aria-modal="true" aria-label={`${companion.name}的每日经历`}>
      <header className="experience-heading"><div className="experience-identity"><Avatar companion={companion} showPresence={false} /><div><span>相伴的每一天</span><h2>{companion.name}的经历</h2></div></div><div className="experience-heading-tools"><span>与现实同步 · {timeZone === 'system' ? '本地时间' : timeZone}</span><button type="button" className="companion-icon-button" aria-label="刷新经历" onClick={() => { void refresh(); void readDetail(true); }}><Icon name="refresh" size={16} /></button><button type="button" className="companion-icon-button" aria-label="关闭经历窗口" onClick={onClose}><Icon name="close" /></button></div></header>
      <div className="experience-layout">
        <aside className="experience-calendar" aria-label="按天查看经历"><div className="experience-calendar-title"><Icon name="clock" size={14} /><strong>日积月累</strong></div><label>选择日期<input type="date" aria-label="经历日期" value={day} onChange={event => chooseDay(event.target.value)} /></label><button type="button" className="experience-today" onClick={() => chooseDay(localDateKey(Date.now()))}>回到今天</button><nav aria-label="有记录的日期">{dayItems.map(item => <button type="button" key={item.day} aria-current={day === item.day ? 'date' : undefined} onClick={() => chooseDay(item.day)}><span>{item.day}</span><small>{item.count.toLocaleString()} 条</small></button>)}</nav>{(dayCursor === undefined ? days?.hasMore : !!dayCursor) && <button type="button" className="experience-older" disabled={dayBusy} onClick={() => void loadOlderDays()}>{dayBusy ? '正在读取…' : '更早的日期'}</button>}<p>每一次行动、学习与整理，都留在自己的日子里。可直接选择任意日期。</p></aside>
        <main className="experience-feed"><header><div><span>这一天的足迹</span><h3>{day}</h3></div><div className="experience-day-switch"><button type="button" aria-label="前一天" onClick={() => chooseDay(shiftDay(day, -1))}><Icon name="chevron" size={14} /></button><button type="button" aria-label="后一天" onClick={() => chooseDay(shiftDay(day, 1))}><Icon name="chevron-right" size={14} /></button></div></header><div className="experience-legend"><span data-origin="action">主动行动</span><span data-origin="system">生活与系统事件</span><small>按发生时间排列</small></div>
          <div className="experience-feed-scroll">
            {error?.scope === scope ? <div className="experience-empty" role="status"><Icon name="info" size={25} /><p>{error.text}</p><button type="button" onClick={() => void refresh()}>重新读取</button></div> : !page ? <div className="experience-empty" role="status"><Icon name="clock" size={25} /><p>正在翻开这一天…</p></div> : !page.items.length ? <div className="experience-empty"><Icon name="sparkles" size={30} /><h4>这一天还没有留下经历</h4><p>行动、学习、日程和记忆整理发生后，会自动出现在这里。</p></div> : <ol className="experience-timeline" aria-label={`${day}经历时间线`}>{page.items.map(entry => <li key={entry.id} data-origin={entry.origin} data-status={entry.status} data-experience-id={entry.id}><time dateTime={entry.occurredAt} title={entry.occurredAt}>{timeLabel(entry.occurredAt, entry.timeZone)}</time><span className="experience-timeline-dot" aria-hidden="true" /><button type="button" aria-pressed={entry.id === selectedId} onClick={() => select(entry)}><div className="experience-entry-meta"><span>{kinds[entry.kind]}</span><small>{statuses[entry.status]}</small></div><h4>{entry.title}</h4>{entry.summary && <p>{entry.summary}</p>}<span className="experience-entry-open">查看经过<Icon name="arrow-up-right" size={12} /></span></button></li>)}</ol>}
          </div>
          <footer className="experience-pagination"><button type="button" disabled={!cursors.length} onClick={() => { setCursors(current => current.slice(0, -1)); setSelectedId(undefined); setRenaming(false); }}>上一页</button><span>第 {cursors.length + 1} 页 · 每页最多 30 条</span><button type="button" disabled={!page?.hasMore || !page.nextCursor} onClick={() => { if (page?.nextCursor) setCursors(current => [...current, page.nextCursor!]); setSelectedId(undefined); setRenaming(false); }}>下一页</button></footer>
        </main>
        <aside className="experience-detail" aria-label="经历详情">{!selected ? <div className="experience-detail-placeholder"><Icon name="file-text" size={32} /><h3>每段经历，都有来处</h3><p>选择时间线上的一条记录，查看经过、汇报与留存的资料。</p></div> : <><header><span>{selected.origin === 'action' ? '主动行动' : '生活与系统事件'} · {kinds[selected.kind]}</span><h3>{shownDetail?.entry.title ?? selected.title}</h3><time dateTime={selected.occurredAt} title={selected.occurredAt}>{timeLabel(selected.occurredAt, selected.timeZone, true)}</time><small data-status={selected.status}>{statuses[selected.status]}</small></header><div className="experience-detail-scroll">{detailError && <p className="experience-error" role="alert">{detailError}<button type="button" onClick={() => void readDetail(true)}>重新读取</button></p>}{!shownDetail ? !detailError && <p className="experience-detail-loading" role="status">正在读取完整记录…</p> : <>
              <div className="experience-name">{renaming ? <form onSubmit={event => { event.preventDefault(); void rename(); }}><label>给这段经历起名<input aria-label="经历名称" value={title} maxLength={160} disabled={saving} onChange={event => setTitle(event.target.value)} autoFocus /></label><div><button type="button" disabled={saving} onClick={() => setRenaming(false)}>取消</button><button type="submit" disabled={saving || !title.trim()}>{saving ? '正在保存…' : '保存名称'}</button></div></form> : <button type="button" disabled={shownDetail.entry.status === 'withdrawn'} onClick={() => { setTitle(shownDetail.entry.title); setRenaming(true); }}>为这段经历命名<Icon name="chevron-right" size={13} /></button>}</div>
              {shownDetail.entry.summary && <p className="experience-detail-summary">{shownDetail.entry.summary}</p>}
              {shownDetail.sections.map((section, index) => <RecordSection key={`${shownDetail.entry.id}:${shownDetail.entry.revision}:${index}`} title={section.title} text={section.text} initiallyOpen={index === 0} />)}
              {shownDetail.artifacts.length > 0 && <section className="experience-artifacts"><h4>留存资料</h4>{shownDetail.artifacts.map((artifact, index) => <div key={index}><strong>{artifact.label}</strong><code>{artifact.relativePath}</code></div>)}</section>}
              <details className="experience-source"><summary>记录信息</summary><dl><dt>记录编号</dt><dd>{shownDetail.entry.id}</dd><dt>归档位置</dt><dd>{shownDetail.entry.archiveRelativePath}</dd><dt>最后更新</dt><dd>{timeLabel(shownDetail.entry.updatedAt, shownDetail.entry.timeZone, true)}</dd></dl></details>
              {shownDetail.entry.source.kind === 'action' && onOpenAction && shownDetail.entry.status !== 'withdrawn' && <button type="button" className="experience-task-link" onClick={() => onOpenAction(shownDetail.entry.source.id)}>查看原始任务记录<Icon name="arrow-up-right" size={13} /></button>}
            </>}</div></>}
        </aside>
      </div>
    </section>
  </div>;
}
