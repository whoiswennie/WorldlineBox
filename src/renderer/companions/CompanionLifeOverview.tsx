import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CompanionLifeOverview as LifeOverview, CompanionLifeOverviewItem, CompanionLifeOverviewQuery } from '../../shared/companion-life-overview';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { COMPANION_WEATHER_LABELS, companionWeatherSymbol } from '../../shared/companion-weather';
import { Icon } from '../Icons';
import { Avatar } from './CompanionVisuals';
import { CompanionMemoryLifePlanView } from './CompanionMemoryLifePlan';
import { createCoalescedRefresh } from './coalesced-refresh';
import type { ScheduleRequest } from './companion-schedules';
import './companion-life-overview.css';

export type CompanionLifeOverviewDestination = CompanionLifeOverviewItem['destination']['kind'] | 'chat' | 'learning' | 'memory_processing' | 'world' | 'contacts' | 'trace';
type Filter = NonNullable<CompanionLifeOverviewQuery['filter']>;
type Props = { companions: Companion[]; companionId?: string; active: boolean; api?: WorldlineBoxCompanionsApi; request: ScheduleRequest;
  onOwnerChange(id: string): void; onOpen(kind: CompanionLifeOverviewDestination, item?: CompanionLifeOverviewItem): void; onOpenTrace?(ownerId: string): void; onOpenExperience?(ownerId: string): void };
const filters = [['all', '此刻与接下来'], ['current', '正在进行'], ['upcoming', '接下来'], ['attention', '需关注'], ['events', '最近发生']] as const;
const sections = { current: '正在发生', upcoming: '接下来', attention: '需要关注', events: '最近发生' };
const memoryKinds = { capture: '来源整理', index: '向量收录', tags: '自动标签', timeline: '时间线整理' };
const statuses: Record<string, string> = { queued: '等待中', pending: '待处理', running: '进行中', waiting: '等待条件', offered: '待确认', accepted: '已接下', paused: '已暂停', failed: '需要处理', completed: '已完成', done: '已完成', cancelled: '已取消', terminated: '已结束', active: '已启用', disabled: '未启用', scheduled: '有安排', eligible: '可检查' };
const clockLabel = (clock: 'real' | 'world') => clock === 'world' ? '世界时间' : '现实时间';
const emptyCopy: Record<Filter, { title: string; text: string }> = {
  all: { title: '生活正在慢慢展开', text: '新的安排与真实经历，会在这里留下足迹。' },
  current: { title: '眼下没有正在进行的事情', text: '有新的行动时，这里会随之更新。' },
  upcoming: { title: '接下来暂时没有安排', text: '可以和伙伴聊聊，商量下一件想做的事。' },
  attention: { title: '当前没有需要关注的事项', text: '需要你留意的变化，会在这里出现。' },
  events: { title: '还没有新的生活记录', text: '真实发生的事情，会逐渐保存在这里。' },
};
function formatTime(at: string, timeZone?: string, date = true) {
  const options: Intl.DateTimeFormatOptions = { ...(date ? { month: 'numeric', day: 'numeric' } as const : {}), hour: '2-digit', minute: '2-digit', hour12: false };
  try { return new Intl.DateTimeFormat('zh-CN', { ...options, ...(timeZone && timeZone !== 'system' ? { timeZone } : {}) }).format(new Date(at)); }
  catch { return new Intl.DateTimeFormat('zh-CN', options).format(new Date(at)); }
}
function ItemTiming({ item }: { item: CompanionLifeOverviewItem }) {
  const { timing } = item;
  const label = timing.kind === 'scheduled' ? '计划时间' : timing.kind === 'eligibility' ? '最早可检查' : timing.kind === 'retry' ? '最早可重试' : '条件时间';
  return <span className="life-overview-item-time">{timing.windowStart ? <>可用窗口 <time dateTime={timing.windowStart}>{formatTime(timing.windowStart, timing.timeZone)}</time>{timing.windowEnd && <> — <time dateTime={timing.windowEnd}>{formatTime(timing.windowEnd, timing.timeZone)}</time></>}</>
    : timing.at ? <>{label} <time dateTime={timing.at}>{formatTime(timing.at, timing.timeZone)}</time></> : item.section === 'events' && item.updatedAt ? <time dateTime={item.updatedAt}>{formatTime(item.updatedAt)}</time> : <>{timing.kind === 'conditional' ? '满足条件时检查' : item.section === 'current' ? '正在推进' : '按实际条件推进'}</>}
    <small> · {clockLabel(timing.clock)}</small></span>;
}
function FlowItem({ item, onOpen }: { item: CompanionLifeOverviewItem; onOpen: Props['onOpen'] }) {
  return <li data-life-item={item.id} data-life-section={item.section} data-life-kind={item.kind}>
    <span className="life-overview-thread-dot" aria-hidden="true" />
    <article><div className="life-overview-item-meta"><span>{sections[item.section]}</span><small>{statuses[item.status] ?? (item.section === 'events' ? '已记录' : '按条件推进')}</small></div>
      <h3>{item.title}</h3><ItemTiming item={item} />
      {item.probability !== undefined && <small className="life-overview-probability">概率事件 · {new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 0 }).format(item.probability)} 候选概率</small>}
      <footer><details><summary><Icon name="info" size={12} />{item.section === 'events' ? '查看经过' : '查看条件'}<Icon name="chevron" size={11} /></summary><p>{item.condition}</p></details><button type="button" onClick={() => onOpen(item.destination.kind, item)}>{item.kind === 'life_event' ? '查看相关安排' : '查看与调整'}<Icon name="arrow-up-right" size={12} /></button></footer>
    </article>
  </li>;
}

/** A bounded, owner-scoped read surface. Opening this page never creates a chat or model task. */
export function CompanionLifeOverview({ companions, companionId, active, api, request, onOwnerChange, onOpen, onOpenTrace, onOpenExperience }: Props) {
  const [filter, setFilter] = useState<Filter>('all'), [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1), scope = `${companionId ?? ''}:${filter}:${cursor ?? ''}`;
  const scopeRef = useRef(scope), serial = useRef(0), alive = useRef(false);
  const [snapshot, setSnapshot] = useState<{ scope: string; data: LifeOverview }>(), [failure, setFailure] = useState<{ scope: string; text: string }>();
  useLayoutEffect(() => { scopeRef.current = scope; }, [scope]);
  const data = snapshot?.scope === scope && snapshot.data.companion.id === companionId ? snapshot.data : undefined;
  const error = failure?.scope === scope ? failure.text : '';
  const owner = companions.find(item => item.id === companionId && item.active !== false);
  const hasOwner = !!owner;
  const owners = companions.filter(item => item.active !== false);
  const refresh = useCallback(async () => {
    if (!active || !companionId || scopeRef.current !== scope) return;
    const epoch = ++serial.current;
    try {
      const result = await request({ type: 'life.overview.status', companionId, filter, ...(cursor ? { cursor } : {}), limit: 20 });
      if (!alive.current || epoch !== serial.current || scopeRef.current !== scope) return;
      if (!result?.ok || result.lifeOverview?.companion.id !== companionId || result.lifeOverview.companionId !== companionId
        || result.lifeOverview.memoryLifePlan.companionId !== companionId || result.lifeOverview.memoryProcessing && result.lifeOverview.memoryProcessing.companionId !== companionId) throw new Error();
      setSnapshot({ scope, data: result.lifeOverview }); setFailure(undefined);
    } catch { if (alive.current && epoch === serial.current && scopeRef.current === scope) setFailure({ scope, text: '生活近况暂时无法读取，稍后可以重新查看。' }); }
  }, [active, companionId, request, filter, cursor, scope]);
  useEffect(() => {
    if (!active || !hasOwner) return;
    alive.current = true;
    const sequence = serial;
    const reads = createCoalescedRefresh(refresh, undefined, 1000); void reads.trigger();
    const unsubscribe = api?.onChanged(() => reads.trigger()), timer = setInterval(() => void reads.trigger(), 5000);
    return () => { alive.current = false; sequence.current++; reads.dispose(); unsubscribe?.(); clearInterval(timer); };
  }, [active, hasOwner, refresh, api]);
  const processing = data?.memoryProcessing, pending = processing ? processing.summary.pending + processing.summary.running + processing.summary.failed : 0;
  const memoryRepresentatives = (processing?.jobs ?? []).filter(item => ['running', 'failed', 'pending', 'waiting_model'].includes(item.status))
    .filter((item, index, jobs) => jobs.findIndex(candidate => candidate.kind === item.kind) === index).slice(0, 2);
  if (!active) return <section className="companions-life-overview" role="region" aria-label="伙伴生活总览" hidden />;
  return <section className="companions-life-overview" role="region" aria-label="伙伴生活总览" hidden={!active}>
    <div className="life-overview-scroll"><div className="life-overview-paper">
      <header className="life-overview-heading"><div><span className="life-overview-eyebrow">相伴的每一天</span><h1>生活总览</h1></div><div><button type="button" aria-label="查看共享世界" onClick={() => onOpen('world')}><Icon name="sliders" size={15} /><span>查看世界</span></button><button type="button" aria-label="刷新生活总览" disabled={!owner} onClick={() => void refresh()}><Icon name="refresh" size={15} /></button></div></header>
      <section className="life-overview-environment" aria-label="共享世界时间与天气"><div><span>世界时间</span>{data ? <time dateTime={data.clock.virtualNow}>{formatTime(data.clock.virtualNow, data.clock.timeZone)}</time> : <strong>等待世界近况</strong>}<small>{data ? `${data.clock.timeZone === 'system' ? '本地时区' : data.clock.timeZone} · ${data.clock.backlog ? '世界观测已落后，等待后台继续推进' : '与现实时间同步'}` : '选择一位正在生活的伙伴'}</small></div><div className="life-overview-weather">{data && <><span aria-hidden="true">{companionWeatherSymbol(data.environment.weather, data.environment.light > .3)}</span><div><strong>{COMPANION_WEATHER_LABELS[data.environment.weather]}</strong><small>室外 {Math.round(data.environment.outdoorTemperature)}° · 室内 {Math.round(data.environment.indoorTemperature)}°</small></div></>}</div>{data && <small className="life-overview-observed">现实观测 <time dateTime={data.clock.observedRealAt}>{formatTime(data.clock.observedRealAt, undefined, false)}</time></small>}</section>
      <div className="life-overview-owners" role="group" aria-label="选择生活总览伙伴">{owners.map(item => <button type="button" key={item.id} aria-label={'查看' + item.name + '的生活'} aria-pressed={item.id === companionId} onClick={() => { setCursors([]); onOwnerChange(item.id); }}><Avatar companion={item} /><span>{item.name}</span></button>)}<button type="button" className="life-overview-manage-owners" onClick={() => onOpen('contacts')}><Icon name="plus" size={15} /><span>管理伙伴</span></button></div>
      {!owner ? <div className="life-overview-empty"><Icon name="sparkles" size={27} /><h2>等待一位伙伴开始生活</h2><p>在联系人中激活伙伴后，就能在这里查看她的此刻与接下来。</p><button type="button" onClick={() => onOpen('contacts')}>前往联系人</button></div>
        : <><div className="life-overview-owner-heading"><div><Avatar companion={owner} /><div><h2>{owner.name}的生活</h2><p>{data?.current?.label ?? (data ? '当前没有可显示的生活动作' : '正在读取她的近况…')}</p></div></div><div className="life-overview-owner-tools"><button type="button" onClick={() => onOpen('chat')}><Icon name="send" size={13} />聊一会</button><button type="button" onClick={() => onOpen('schedules')}><Icon name="clock" size={13} />日程</button><button type="button" onClick={() => onOpen('learning')}><Icon name="file-text" size={13} />学习与成长</button></div></div>
          <div className="life-overview-layout"><main className="life-overview-feed"><div className="life-overview-filters" role="tablist" aria-label="生活信息流筛选">{filters.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => { setFilter(value); setCursors([]); }}>{label}</button>)}</div>
            {error ? <div className="life-overview-empty" role="status"><p>{error}</p><button type="button" onClick={() => { if (cursors.length) setCursors([]); else void refresh(); }}>重新查看</button></div> : !data ? <p className="life-overview-loading" role="status">正在读取真实生活近况…</p> : !data.items.length ? <div className="life-overview-empty" role="status"><span className="life-overview-empty-symbol" aria-hidden="true"><Icon name="sparkles" size={22} /></span><div className="life-overview-empty-copy"><h3>{emptyCopy[filter].title}</h3><p>{emptyCopy[filter].text}</p></div></div>
              : <ol className="life-overview-timeline" aria-label="伙伴生活信息流">{data.items.map(item => <FlowItem key={item.id} item={item} onOpen={onOpen} />)}</ol>}
            {data && !error && (cursors.length > 0 || data.hasMore && data.nextCursor) && <footer className="life-overview-pagination"><button type="button" disabled={!cursors.length} onClick={() => setCursors(current => current.slice(0, -1))}>上一页</button><span>第 {cursors.length + 1} 页</span><button type="button" disabled={!data.hasMore || !data.nextCursor} onClick={() => { if (data.nextCursor) setCursors(current => [...current, data.nextCursor!]); }}>下一页</button></footer>}
          </main><aside className="life-overview-rhythm" aria-label="当前伙伴的记忆与生活节奏">{processing && <section className="life-overview-memory-current" aria-label="当前伙伴记忆收录"><header><Icon name="layers" size={15} /><h3>记忆收录</h3><button type="button" aria-label="查看总览伙伴记忆处理进度" onClick={() => onOpen('memory_processing')}><Icon name="arrow-up-right" size={14} /></button></header><p>{pending ? [processing.summary.running ? `${processing.summary.running} 项已领取` : '', processing.summary.pending ? `${processing.summary.pending} 项等待整理` : '', processing.summary.failed ? `${processing.summary.failed} 项需处理` : ''].filter(Boolean).join(' · ') : processing.summary.completed ? '已整理的经历，随时可以回看。' : '新的经历会按记录规则收录。'}</p>{memoryRepresentatives.map(item => <div key={item.kind} data-life-memory-job={item.id} data-life-memory-kind={item.kind}><strong title={item.title}>{memoryKinds[item.kind]}</strong><small>{item.schedule?.condition ?? item.stage}</small></div>)}{processing.schedule && <small className="life-overview-memory-next">{processing.schedule.nextCheckAt ? <>下次检查 <time dateTime={processing.schedule.nextCheckAt}>{formatTime(processing.schedule.nextCheckAt)}</time> · 现实时间</> : processing.schedule.condition}</small>}</section>}{data && <CompanionMemoryLifePlanView plan={data.memoryLifePlan} onOpenMemory={() => onOpen('learning')} />}<div className="life-overview-rhythm-links">{onOpenExperience && <button type="button" onClick={() => onOpenExperience(owner.id)}><Icon name="activity" size={14} />每日经历<Icon name="chevron-right" size={13} /></button>}{onOpenTrace && <button type="button" onClick={() => onOpenTrace(owner.id)}><Icon name="layers" size={14} />成长足迹<Icon name="chevron-right" size={13} /></button>}<button type="button" onClick={() => onOpen('work')}><Icon name="activity" size={14} />工作与委托<Icon name="chevron-right" size={13} /></button><button type="button" onClick={() => onOpen('life_rules')}><Icon name="sparkles" size={14} />自主生活规则<Icon name="chevron-right" size={13} /></button></div></aside></div>
        </>}
    </div></div>
  </section>;
}
