import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CompanionMemoryLifePlan as MemoryLifePlan, CompanionMemoryLifePlanItem } from '../../shared/companion-life-plan';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import { Icon, type IconName } from '../Icons';
import type { ScheduleRequest } from './companion-schedules';
import { createCoalescedRefresh } from './coalesced-refresh';
import './companion-memory-life-plan.css';

const stateLabels: Record<CompanionMemoryLifePlanItem['state'], string> = { unconfigured: '未安排', idle: '暂无待办', scheduled: '待检查', eligible: '可供检查', waiting: '等待条件', running: '进行中' };
const icons: Record<CompanionMemoryLifePlanItem['kind'], IconName> = { learning: 'file-text', journal: 'edit', sleep_consolidation: 'layers', dream: 'sparkles' };
const clockLabel = (value: 'real' | 'world') => value === 'world' ? '世界时间' : '现实时间';

function planTime(at: string, timeZone?: string) {
  if (!Number.isFinite(Date.parse(at))) return '时间待核对';
  const options: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  try { return new Intl.DateTimeFormat('zh-CN', { ...options, ...(timeZone && timeZone !== 'system' ? { timeZone } : {}) }).format(new Date(at)); }
  catch { return new Intl.DateTimeFormat('zh-CN', options).format(new Date(at)); }
}
function PlanTiming({ item }: { item: CompanionMemoryLifePlanItem }) {
  const { timing } = item;
  if (item.state === 'unconfigured') return null;
  const atLabel = timing.kind === 'eligibility' ? '最早可检查 ' : timing.kind === 'retry' ? '最早可重试 '
    : timing.kind === 'next_check' ? '下次检查 ' : timing.kind === 'conditional' && item.kind === 'dream' ? '冷却至 ' : '条件时间 ';
  const windowLabel = item.kind === 'dream' ? '候选窗口' : item.kind === 'sleep_consolidation' ? '可整理窗口' : '作息窗口';
  return <span className="memory-life-plan-timing">
    {timing.windowStart ? <><span>{windowLabel} </span><time dateTime={timing.windowStart}>{planTime(timing.windowStart, timing.timeZone)}</time>{timing.windowEnd && <> — <time dateTime={timing.windowEnd}>{planTime(timing.windowEnd, timing.timeZone)}</time></>}</>
      : timing.at ? <><span>{atLabel}</span><time dateTime={timing.at}>{planTime(timing.at, timing.timeZone)}</time></>
        : <span>{timing.kind === 'event_driven' ? '事件触发' : timing.kind === 'window' ? `${windowLabel}内检查` : '满足条件时检查'}</span>}
    <small> · {clockLabel(timing.clock)}</small>
  </span>;
}
function PlanItem({ item }: { item: CompanionMemoryLifePlanItem }) {
  const label = item.kind === 'dream' && item.state === 'scheduled' ? '候选窗口' : stateLabels[item.state];
  return <li data-memory-plan-kind={item.kind} data-memory-plan-state={item.state}>
    <span className="memory-life-plan-icon" aria-hidden="true"><Icon name={icons[item.kind]} size={13} /></span>
    <div><div className="memory-life-plan-title"><strong>{item.title}</strong><span data-state={item.state}>{label}</span></div>
      {item.sourceTitle && <small className="memory-life-plan-source">{item.sourceTitle}</small>}
      <PlanTiming item={item} />
      {item.kind === 'dream' && item.probability !== undefined && <small className="memory-life-plan-probability">概率事件 · {new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 0 }).format(item.probability)} 候选概率</small>}
      <details className="memory-life-plan-reason"><summary><span>{item.reason}</span><Icon name="chevron" size={11} /></summary></details>
    </div>
  </li>;
}

function PlanEntries({ data }: { data: MemoryLifePlan }) {
  const priority = (item: CompanionMemoryLifePlanItem) => ['running', 'eligible', 'waiting', 'scheduled', 'idle', 'unconfigured'].indexOf(item.state);
  const kindOrder = (item: CompanionMemoryLifePlanItem) => ['journal', 'learning', 'sleep_consolidation', 'dream'].indexOf(item.kind);
  const items = [...data.items].sort((a, b) => priority(a) - priority(b) || kindOrder(a) - kindOrder(b)
    || (a.timing.clock === b.timing.clock ? (a.timing.at ?? a.timing.windowStart ?? '\uffff').localeCompare(b.timing.at ?? b.timing.windowStart ?? '\uffff') : 0));
  return !items.length ? <p className="memory-life-plan-placeholder">当前没有记忆与学习安排。</p>
    : <><ul>{items.slice(0, 4).map(item => <PlanItem key={item.id} item={item} />)}</ul>{items.length > 4 && <details className="memory-life-plan-more"><summary>其他 {items.length - 4} 项安排<Icon name="chevron" size={12} /></summary><ul>{items.slice(4).map(item => <PlanItem key={item.id} item={item} />)}</ul></details>}{data.hasMore && <p className="memory-life-plan-placeholder">还有其他授权来源，可在学习来源中查看。</p>}<small className="memory-life-plan-note">检查与候选窗口均不承诺开始或完成时间。</small></>;
}

/** Pure projection for the overview's single bounded response; starts no additional reads. */
export function CompanionMemoryLifePlanView({ plan, onOpenMemory }: { plan: MemoryLifePlan; onOpenMemory?(): void }) {
  return <section className="companions-memory-life-plan" aria-label="当前伙伴记忆与学习安排"><header><h4>记忆与学习</h4>{onOpenMemory && <button type="button" aria-label="查看记忆与学习设置" title="查看记忆与学习设置" onClick={onOpenMemory}><Icon name="sliders" size={13} /></button>}</header><PlanEntries data={plan} /></section>;
}

/** Owner-only read projection. A check or eligible window is never an execution ETA. */
export function CompanionMemoryLifePlan({ companionId, request, api, active = true, onOpenMemory }: {
  companionId: string; request: ScheduleRequest; api?: WorldlineBoxCompanionsApi; active?: boolean; onOpenMemory?(): void;
}) {
  const [snapshot, setSnapshot] = useState<MemoryLifePlan>();
  const [failure, setFailure] = useState<{ owner: string; message: string }>();
  const alive = useRef(false), serial = useRef(0), scope = useRef(companionId);
  useLayoutEffect(() => { scope.current = companionId; }, [companionId]);
  const data = snapshot?.companionId === companionId ? snapshot : undefined;
  const error = failure?.owner === companionId ? failure.message : '';
  const refresh = useCallback(async () => {
    if (!active || scope.current !== companionId) return;
    const epoch = ++serial.current;
    try {
      const result = await request({ type: 'memory.life-plan.status', companionId });
      if (!alive.current || epoch !== serial.current || scope.current !== companionId) return;
      if (!result?.ok || result.memoryLifePlan?.companionId !== companionId) throw new Error('当前安排暂时无法读取。');
      setSnapshot(result.memoryLifePlan); setFailure(undefined);
    } catch { if (alive.current && epoch === serial.current && scope.current === companionId) setFailure({ owner: companionId, message: '当前安排暂时无法读取。' }); }
  }, [active, companionId, request]);
  useEffect(() => {
    if (!active) return;
    alive.current = true;
    const sequence = serial;
    const reads = createCoalescedRefresh(refresh, undefined, 2000);
    void reads.trigger(); const unsubscribe = api?.onChanged(() => reads.trigger());
    const timer = setInterval(() => void reads.trigger(), 30_000);
    return () => { alive.current = false; sequence.current++; clearInterval(timer); unsubscribe?.(); reads.dispose(); };
  }, [active, refresh, api]);
  return <section className="companions-memory-life-plan" aria-label="当前伙伴记忆与学习安排">
    <header><h4>记忆与学习</h4><span>{onOpenMemory && <button type="button" aria-label="查看记忆与学习设置" title="查看记忆与学习设置" onClick={onOpenMemory}><Icon name="sliders" size={13} /></button>}<button type="button" aria-label="刷新当前伙伴记忆安排" title="刷新当前伙伴记忆安排" onClick={() => void refresh()}><Icon name="refresh" size={12} /></button></span></header>
    {error ? <p className="memory-life-plan-placeholder" role="status">{error}</p> : !data ? <p className="memory-life-plan-placeholder" role="status">正在读取实际安排…</p>
      : <PlanEntries data={data} />}
  </section>;
}
