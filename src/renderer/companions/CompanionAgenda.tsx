import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { companionAgendaRuleDraftSchema, type CompanionAgendaGoal, type CompanionAgendaPublicCommand, type CompanionAgendaResponse,
  type CompanionAgendaRule, type CompanionAgendaRun, type CompanionAgendaTask, type CompanionAgendaView } from '../../shared/companion-agenda';
import { Icon, type IconName } from '../Icons';
import { deferredFeature } from '../deferred-feature';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { createShellPortal } from '../ui/ShellStyleScope';
import { Select } from '../ui/primitives/Select';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { Avatar } from './CompanionVisuals';
import type { CompanionJobFailures as CompanionJobFailuresView } from './CompanionJobFailures';
import { companionCapabilityDiagnostic } from './companion-capability-presentation';
import { createCoalescedRefresh } from './coalesced-refresh';
import { agendaClock, agendaDayKey, agendaDayRange, agendaEntries, agendaEntryDescription, agendaEntryGroups, agendaEntryStatus,
  agendaFullTime, agendaKindLabels, agendaMoveDay, agendaResultText, agendaRuleIntent, agendaRuleTitle, agendaTriggerLabel, type AgendaEntry, type AgendaViewName } from './companion-agenda-presentation';
import './companion-agenda.css';

export type AgendaRequest = (command: CompanionAgendaPublicCommand) => Promise<CompanionAgendaResponse | undefined>;
type Mutation = CompanionAgendaPublicCommand extends infer Command ? Command extends { operationId: string } ? Omit<Command, 'operationId'> : never : never;
export interface AgendaObservationSource { id: string; title: string; displayId?: string }
export interface AgendaCapacity { companionId: string; limit: number; active: number; queued: number }
type Detail = NonNullable<CompanionAgendaResponse['agendaEvent']>;
type Api = Pick<WorldlineBoxCompanionsApi, 'onChanged'>;
const CompanionJobFailures = deferredFeature<Parameters<typeof CompanionJobFailuresView>[0]>(() => import('./CompanionJobFailures').then(module => ({ default: module.CompanionJobFailures })));
const views: Array<{ id: AgendaViewName; label: string; icon: IconName }> = [{ id: 'today', label: '日常', icon: 'clock' }, { id: 'upcoming', label: '任务', icon: 'clipboard' }, { id: 'history', label: '系统事件', icon: 'archive' }];
const kindIcons: Record<CompanionAgendaRule['kind'], IconName> = { self: 'sparkles', chat: 'message-circle', world: 'globe', research: 'search', learning: 'file-text', memory: 'archive', reflection: 'sparkles', rest: 'clock', reminder: 'clock', work: 'clipboard', observation: 'eye', growth: 'heart' };
const originLabel = { user: '用户约定', self: '伙伴自主安排', system: '基础事件' };
const goalDomain = { knowledge: '知识学习', procedure: '方法与练习', persona: '人格培养', project: '持续项目' };
const goalStatus = { active: '正在推进', paused: '已暂停', completed: '已完成', retired: '已结束' };
const stepStatus = { prepared: '准备', dispatched: '已开始', succeeded: '已完成', failed: '未完成', unknown: '待核对' };
const isAttention = (run?: CompanionAgendaRun) => !!run && ['parked', 'unknown'].includes(run.status);

/** The clock never polls storage. Hidden modules/documents do not own a timer. */
function useVisibleAgendaClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === 'hidden') return;
      const current = Date.now(); setNow(current);
      timer = setTimeout(tick, 1000 - current % 1000);
    };
    document.addEventListener('visibilitychange', tick); tick();
    return () => { if (timer !== undefined) clearTimeout(timer); document.removeEventListener('visibilitychange', tick); };
  }, [active]);
  return now;
}


function mergeViews(pages: CompanionAgendaView[]): CompanionAgendaView {
  const first = pages[0]!;
  const merge = <T extends { id: string }>(select: (page: CompanionAgendaView) => T[]) => [...new Map(pages.flatMap(page => select(page)).map(item => [item.id, item])).values()];
  return { ...first, rules: merge(page => page.rules), occurrences: merge(page => page.occurrences), runs: merge(page => page.runs), goals: merge(page => page.goals), grants: merge(page => page.grants), hasMore: pages.at(-1)!.hasMore, nextId: pages.at(-1)!.nextId };
}

function useAgendaData({ owner, day, view, request, api, active, executionStatus = 'active' }: { owner: string; day: string; view: AgendaViewName; request: AgendaRequest; api?: Api; active: boolean; executionStatus?: 'active' | 'ended' }) {
  const key = `${owner}/${day}/${view}/${executionStatus}`;
  const [snapshot, setSnapshot] = useState<{ key: string; data: CompanionAgendaView; tasks: CompanionAgendaTask[]; goalsMore: boolean; goalsNext?: string }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [refreshing, setRefreshing] = useState(false);
  const state = useRef({ key, active, generation: 0, cursors: [undefined] as Array<string | undefined>, goalCursors: [undefined] as Array<string | undefined> });
  const refresh = useRef<ReturnType<typeof createCoalescedRefresh> | undefined>(undefined);
  useLayoutEffect(() => { if (state.current.key !== key) state.current = { key, active, generation: state.current.generation + 1, cursors: [undefined], goalCursors: [undefined] }; else state.current.active = active; }, [key, active]);
  const read = useCallback(async () => {
    if (!active || !owner) return;
    const generation = state.current.generation;
    const current = () => state.current.key === key && state.current.active && generation === state.current.generation;
    setRefreshing(true);
    try {
      const range = view === 'today' ? agendaDayRange(day) : {};
      const commands: CompanionAgendaPublicCommand[] = state.current.cursors.map(afterId => ({ type: 'agenda.read', companionId: owner, compactRecurring: true, ...range, limit: 50, ...(afterId ? { afterId } : {}) }));
      const pages = await Promise.all(commands.map(command => request(command)));
      if (!current()) return;
      if (pages.some(page => !page?.ok || page.agenda?.companionId !== owner)) {
        setSnapshot(undefined); throw new Error(pages.find(page => !page?.ok)?.error || '此伙伴的日程暂不可访问。');
      }
      const data = mergeViews(pages.map(page => page!.agenda!));
      let goalsMore = false, goalsNext: string | undefined; let tasks: CompanionAgendaTask[] = [];
      if (view === 'goals' || view === 'upcoming') {
        const goals = await Promise.all(state.current.goalCursors.map(afterId => request({ type: 'agenda.tasks.read', companionId: owner, limit: 50, executionStatus, ...(afterId ? { afterId } : {}) })));
        if (!current()) return;
        if (goals.some(page => !page?.ok || !page.agendaTasks)) { setSnapshot(undefined); throw new Error(goals.find(page => !page?.ok)?.error || '任务记录暂不可访问。'); }
        tasks = [...new Map(goals.flatMap(page => page!.agendaTasks!).map(task => [task.form === 'scheduled' ? `rule/${task.rule.id}` : task.form === 'longterm' ? `goal/${task.goal.id}` : `execution/${task.execution.id}`, task])).values()]
          .filter(task => task.form === 'scheduled' ? task.rule.companionId === owner && task.rule.category === 'task' : task.form === 'longterm' ? task.goal.companionId === owner : task.execution.companionId === owner);
        data.goals = tasks.flatMap(task => task.form === 'longterm' ? [task.goal] : []);
        data.rules = [...new Map([...data.rules, ...tasks.flatMap(task => task.form === 'scheduled' ? [task.rule] : [])].map(rule => [rule.id, rule])).values()];
        goalsMore = goals.at(-1)!.agendaHasMore ?? false; goalsNext = goals.at(-1)!.agendaNextId;
      }
      if (!current()) return;
      setSnapshot({ key, data, tasks, goalsMore, goalsNext }); setFailure(undefined);
    } catch (error) { if (current()) setFailure({ key, message: error instanceof Error ? error.message : '同步中断，请稍后刷新。' }); }
    finally { if (current()) setRefreshing(false); }
  }, [active, owner, key, day, view, executionStatus, request]);
  useEffect(() => {
    if (!active || !owner) return;
    state.current.active = true;
    const reads = createCoalescedRefresh(read, undefined, 800); refresh.current = reads;
    void reads.trigger(); const unsubscribe = api?.onChanged(() => void reads.trigger());
    return () => { state.current.generation++; state.current.active = false; reads.dispose(); unsubscribe?.(); if (refresh.current === reads) refresh.current = undefined; };
  }, [active, owner, read, api]);
  const data = snapshot?.key === key ? snapshot.data : undefined;
  function more() {
    if (view === 'goals' || view === 'upcoming') { if (snapshot?.key !== key || !snapshot.goalsNext || state.current.goalCursors.includes(snapshot.goalsNext)) return; state.current.goalCursors.push(snapshot.goalsNext); }
    else { if (!data?.nextId || state.current.cursors.includes(data.nextId)) return; state.current.cursors.push(data.nextId); }
    void refresh.current?.trigger();
  }
  return { data, error: failure?.key === key ? failure.message : '', refreshing, refresh: () => refresh.current?.trigger(), more,
    tasks: snapshot?.key === key ? snapshot.tasks : [],
    hasMore: view === 'goals' || view === 'upcoming' ? snapshot?.key === key && snapshot.goalsMore : data?.hasMore };
}

function ExecutionResult({ value }: { value: string }) {
  const result = agendaResultText(value);
  return <>{result.text && <p>{result.text}</p>}{result.raw && <details className="agenda-raw-receipt"><summary>原始执行回执</summary><pre>{result.raw}</pre></details>}</>;
}

function EventDetailDialog({ owner, entry, request, revision, onMutate, busy, onClose, notice }: {
  owner: string; entry: AgendaEntry; request: AgendaRequest; revision: number; onMutate(command: Mutation): Promise<boolean>; busy: boolean; onClose(): void; notice?: string;
}) {
  const [portal] = useState(() => document.createElement('div'));
  useLayoutEffect(() => { document.body.append(portal); return () => portal.remove(); }, [portal]);
  useDialogFocusTrap(true, `agenda-event/${owner}/${entry.key}`);
  return createShellPortal(<div className="agenda-detail-backdrop" onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) onClose(); }} onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); onClose(); } }}><section className="agenda-detail-dialog" role="dialog" aria-modal="true" aria-label={`日程详情：${agendaRuleTitle(entry.rule)}`}>{notice && <p className="agenda-message is-error" role="alert">{notice}</p>}<EventDetail owner={owner} entry={entry} request={request} revision={revision} onMutate={onMutate} busy={busy} onClose={onClose} /></section></div>, portal);
}

function EventDetail({ owner, entry, request, revision, onMutate, busy, onClose }: {
  owner: string; entry: AgendaEntry; request: AgendaRequest; revision: number; onMutate(command: Mutation): Promise<boolean>; busy: boolean; onClose(): void;
}) {
  const key = `${owner}/${entry.rule.id}`, latest = useRef(key);
  const [loaded, setLoaded] = useState<{ key: string; data: Detail }>(), [failure, setFailure] = useState<{ key: string; message: string }>();
  const [confirm, setConfirm] = useState<'retire' | 'abandon'>();
  useLayoutEffect(() => { latest.current = key; }, [key]);
  useEffect(() => {
    let current = true;
    void request({ type: 'agenda.event.read', companionId: owner, id: entry.rule.id }).then(result => {
      if (!current || latest.current !== key) return;
      if (!result?.ok || result.agendaEvent?.rule.companionId !== owner || result.agendaEvent.rule.id !== entry.rule.id) { setLoaded(undefined); setFailure({ key, message: result?.error ?? '这件事的完整记录暂不可访问。' }); return; }
      setLoaded({ key, data: result.agendaEvent }); setFailure(undefined);
    }).catch(() => { if (current && latest.current === key) setFailure({ key, message: '执行记录同步中断。' }); });
    return () => { current = false; };
  }, [owner, entry.rule.id, key, request, revision]);
  const detail = loaded?.key === key ? loaded.data : undefined;
  const rule = detail?.rule ?? entry.rule;
  const run = detail?.runs.find(item => item.id === entry.run?.id) ?? entry.run ?? detail?.runs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const occurrence = detail?.occurrences.find(item => item.id === entry.occurrence?.id) ?? entry.occurrence;
  const error = failure?.key === key ? failure.message : '';
  const trigger = rule.trigger;
  const ruleAct = (action: 'pause' | 'resume' | 'retire') => onMutate({ type: 'agenda.rule.control', companionId: owner, id: rule.id, expectedRevision: rule.revision, action });
  const runAct = (action: 'pause' | 'resume' | 'abandon' | 'cancel') => run && onMutate({ type: 'agenda.run.control', companionId: owner, id: run.id, expectedRevision: run.revision, action });
  const available = !!detail && !error, managed = rule.protected || rule.category === 'event';
  return <section className="agenda-event-detail">
    <header className="agenda-detail-heading"><div><small>{originLabel[rule.origin]} · 修订 {rule.revision}</small><h3>{agendaRuleTitle(rule)}</h3></div><button className="agenda-icon-button" aria-label="关闭日程详情" data-dialog-initial-focus="true" onClick={onClose}><Icon name="close" /></button></header>
    {error && <p role="status" className="agenda-message is-error">{error}</p>}
    <div className="agenda-detail-columns"><section className="agenda-detail-section"><h4>想做什么</h4><p>{agendaRuleIntent(rule)}</p></section><section className="agenda-detail-section"><h4>什么时候考虑</h4><p>{agendaTriggerLabel(rule)}</p>{entry.at && <p>{agendaFullTime(entry.at)}{entry.endAt && ` — ${agendaFullTime(entry.endAt)}`}</p>}<small>{trigger.kind !== 'event' ? `规则时区：${trigger.timeZone === 'system' ? '跟随本机' : trigger.timeZone}` : trigger.topic}{rule.flexible ? ' · 时间可调整' : ' · 固定约定'}</small>{occurrence?.nextCheckAt && <small>下次检查：{agendaFullTime(occurrence.nextCheckAt)}，不是保证开始时间。</small>}</section>
      <section className="agenda-detail-section"><h4>为什么这样安排</h4><p>{rule.reason}</p>{rule.conditions.length ? <ul>{rule.conditions.map(condition => { const actual = occurrence?.conditionResults.find(item => item.key === condition.key); return <li key={condition.key}>{condition.label}{actual ? actual.satisfied ? ' · 当前满足' : ' · 尚未满足' : ' · 等待实际检查'}</li>; })}</ul> : <small>没有附加条件；执行仍需实际能力与资源可用。</small>}</section>
      <section className="agenda-detail-section"><h4>实际进行到了哪里</h4><p>{run?.stage || occurrence?.reason || '尚未开始；这是一项未来安排。'}</p>{run?.nextCondition && <small>{run.nextCondition}</small>}{run?.startedAt && <small>开始：{agendaFullTime(run.startedAt)}</small>}{run?.finishedAt && <small>结束：{agendaFullTime(run.finishedAt)}</small>}{run?.result && <ExecutionResult value={run.result} />}{run?.error && <p role="status">{run.error}</p>}</section></div>
    {detail && <details className="agenda-execution-log"><summary>执行记录与处理依据{detail.steps.length ? ` · ${detail.steps.length} 个步骤` : ''}</summary>{detail.steps.length ? <ol>{detail.steps.map(step => <li key={step.id}><time dateTime={step.updatedAt}>{agendaClock(step.updatedAt)}</time><div><strong>{step.title}</strong><small> · {stepStatus[step.status]}</small>{step.result && <ExecutionResult value={step.result} />}</div></li>)}</ol> : <p>尚无已登记的执行步骤。</p>}{run && <p><small>本次尝试 {run.attemptCount} 次 · 本恢复周期失败 {run.cycleFailureCount} 次 · 累计失败 {run.failureCount} 次。搁置与放弃保留来源及已完成步骤。</small></p>}</details>}
    {detail && detail.runs.length > 1 && <details className="agenda-execution-log"><summary>历次执行 · {detail.runs.length} 条真实记录</summary><ol>{detail.runs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => <li key={item.id}><time dateTime={item.startedAt ?? item.createdAt}>{agendaFullTime(item.startedAt ?? item.createdAt)}</time><div><strong>{agendaEntryStatus({ key: item.id, rule, run: item, planned: false })}</strong><p>{item.stage}</p>{item.result && <ExecutionResult value={item.result} />}{item.error && <p>{item.error}</p>}</div></li>)}</ol></details>}
    <footer className="agenda-detail-actions"><small>{rule.overlapPolicy === 'parallel' ? '允许与其他事项并行，实际资源冲突时等待。' : '同一安排的重叠按已登记规则处理，其他独立事项仍可并行。'}</small>
      {run && ['queued', 'running', 'waiting'].includes(run.status) && <button disabled={busy || !available} onClick={() => void runAct('pause')}>暂停本次</button>}
      {run && ['parked', 'waiting'].includes(run.status) && <button disabled={busy || !available || !!run.pausedByRuleId || !!run.pausedByGoalId} onClick={() => void runAct('resume')}>继续本次</button>}
      {(run?.pausedByRuleId || run?.pausedByGoalId) && <small>{run.pausedByRuleId ? '请先恢复所属日程规则。' : '请先恢复所属长期方向。'}</small>}
      {run && ['parked', 'unknown', 'waiting'].includes(run.status) && <button disabled={busy || !available} onClick={() => setConfirm('abandon')}>放弃本次</button>}
      {rule.status !== 'retired' && <button disabled={busy || !available || managed} title={managed ? '基础事件持续保留，可以单独管理本次执行。' : undefined} onClick={() => void ruleAct(rule.status === 'paused' ? 'resume' : 'pause')}>{rule.status === 'paused' ? '恢复未来安排' : '暂停未来安排'}</button>}
      {rule.status !== 'retired' && <button disabled={busy || !available || managed} title={managed ? '基础事件持续保留，可以单独管理本次执行。' : undefined} onClick={() => setConfirm('retire')}>结束这项安排</button>}
    </footer>
    {confirm && <div className="agenda-detail-actions" role="group" aria-label="确认结束日程"><small>{confirm === 'retire' ? '不再产生这项安排的后续事件，已有记录保留。' : '明确放弃本次处理，不会自动重启；已有来源与结果保留。'}</small><button disabled={busy} onClick={() => setConfirm(undefined)}>保留</button><button className="is-danger" disabled={busy || !available} onClick={() => void Promise.resolve(confirm === 'retire' ? ruleAct('retire') : runAct('abandon')).then(ok => { if (ok) setConfirm(undefined); })}>确认{confirm === 'retire' ? '结束' : '放弃'}</button></div>}
  </section>;
}

function EventRows({ entries, selected, onSelect, now }: { entries: AgendaEntry[]; selected?: string; onSelect(key: string): void; now?: number }) {
  const groups = agendaEntryGroups(entries), before = now === undefined ? -1 : groups.findIndex(group => group.at && Date.parse(group.at) > now);
  const cursorIndex = now === undefined ? -1 : before === -1 ? groups.length : before;
  const marker = now === undefined ? null : <div className="agenda-now-row" data-agenda-now={new Date(now).toISOString()}><div className="agenda-now-time"><span>此刻</span><time dateTime={new Date(now).toISOString()}>{agendaClock(new Date(now).toISOString())}</time></div></div>;
  return <div className="agenda-timeline">{groups.map((group, index) => <div className="agenda-timeline-group" key={group.key}>{cursorIndex === index && marker}<div className={`agenda-time-row${group.parallel ? ' is-parallel' : ''}`}><div className="agenda-time">{group.at ? <time dateTime={group.at}>{agendaClock(group.at)}</time> : <span>条件</span>}{group.parallel && <small>{group.entries.length} 件并行</small>}</div><div className={`agenda-event-grid${group.entries.length === 1 ? ' is-single' : ''}`}>{group.entries.map(entry => <article key={entry.key} className={`agenda-event${entry.rule.trigger.kind === 'window' && !entry.run ? ' is-window' : ''}${entry.run?.status === 'running' ? ' is-running' : ''}${isAttention(entry.run) ? ' is-attention' : ''}${selected === entry.key ? ' is-selected' : ''}`} data-agenda-entry={entry.key}>
    <button type="button" className="agenda-event-button" aria-haspopup="dialog" onClick={() => onSelect(entry.key)}><span className="agenda-event-symbol"><Icon name={kindIcons[entry.rule.kind]} /></span><span className="agenda-event-copy"><span className="agenda-event-title"><strong>{agendaRuleTitle(entry.rule)}</strong><span className="agenda-event-status">{agendaEntryStatus(entry)}</span><Icon name="chevron" /></span><span className="agenda-event-description">{agendaEntryDescription(entry)}</span><span className="agenda-event-foot"><span>{agendaKindLabels[entry.rule.kind]}</span>{entry.rule.clock === 'world' ? <span>{agendaTriggerLabel(entry.rule)}</span> : entry.endAt ? <span>{entry.planned || entry.rule.trigger.kind === 'window' && !entry.run?.finishedAt ? '窗口至' : '结束于'} {agendaClock(entry.endAt)}</span> : entry.rule.trigger.kind === 'interval' ? <span>{agendaTriggerLabel(entry.rule)}</span> : null}{!entry.rule.flexible && <span><Icon name="pin" />固定约定</span>}{entry.rule.goalId && <span><Icon name="sparkles" />长期方向</span>}</span></span></button>
  </article>)}</div></div></div>)}{cursorIndex === groups.length && marker}</div>;
}

function AgendaGoals({ goals, data, owner, busy, onMutate, onDiscuss }: { goals: CompanionAgendaGoal[]; data: CompanionAgendaView; owner: string; busy: boolean; onMutate(command: Mutation): Promise<boolean>; onDiscuss?(): void }) {
  return <div className="agenda-goals">{goals.map(goal => { const next = data.rules.filter(rule => rule.goalId === goal.id && rule.status === 'active').sort((a, b) => (a.nextAt ?? '\uffff').localeCompare(b.nextAt ?? '\uffff'))[0]; return <article className="agenda-goal" key={goal.id} data-agenda-goal={goal.id}><header className="agenda-goal-heading"><Icon name={goal.domain === 'persona' ? 'heart' : 'sparkles'} /><h3>{goal.title}</h3><span className="agenda-event-status">{goalStatus[goal.status]}</span></header><p>{goal.intent}</p>{goal.taskResponse && <p className="agenda-task-response">回应 · {{ accept: '已接受', negotiate: '正在协商', decline: '已婉拒' }[goal.taskResponse.decision]}：{goal.taskResponse.message}</p>}{goal.progress && <p>{goal.progress}</p>}<div className="agenda-goal-meta"><span>{goalDomain[goal.domain]}</span><span>{originLabel[goal.origin]}</span><span>{next ? `下次：${next.nextAt ? agendaFullTime(next.nextAt) : agendaTriggerLabel(next)} · ${agendaRuleTitle(next)}` : '后续安排由主脑结合实际进展继续维护'}</span></div><details><summary>看它如何判断进展</summary><ul>{goal.successCriteria.map((text, index) => <li key={index}>{text}</li>)}</ul>{!!goal.nextQuestions.length && <><p>接下来想弄清楚</p><ul>{goal.nextQuestions.map((text, index) => <li key={index}>{text}</li>)}</ul></>}</details><footer className="agenda-detail-actions"><small>计划与模型自评不代表已经掌握或形成性格。</small>{goal.status !== 'completed' && goal.status !== 'retired' && <button disabled={busy} onClick={() => void onMutate({ type: 'agenda.goal.control', companionId: owner, id: goal.id, expectedRevision: goal.revision, action: goal.status === 'paused' ? 'resume' : 'pause' })}>{goal.status === 'paused' ? '继续这个方向' : '暂停这个方向'}</button>}{onDiscuss && <button onClick={onDiscuss}>和伙伴商量</button>}</footer></article>; })}</div>;
}

function AgendaTasks({ tasks, data, owner, busy, onMutate, onOpen, onOpenAction, onDiscuss, onAddLongterm, executionStatus, onExecutionStatus }: {
  tasks: CompanionAgendaTask[]; data: CompanionAgendaView; owner: string; busy: boolean; onMutate(command: Mutation): Promise<boolean>;
  onOpen(ruleId: string): void; onOpenAction?(id: string): void; onDiscuss?(): void; onAddLongterm(): void;
  executionStatus: 'active' | 'ended'; onExecutionStatus(value: 'active' | 'ended'): void;
}) {
  const scheduled = tasks.flatMap(task => task.form === 'scheduled' ? [task.rule] : []), goals = tasks.flatMap(task => task.form === 'longterm' ? [task.goal] : []);
  const executionLabels = { queued: '等待开始', running: '正在进行', succeeded: '已完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' };
  const executions = tasks.flatMap(task => task.form === 'execution' ? [task.execution] : []).sort((a, b) => Number(['queued', 'running'].includes(b.status)) - Number(['queued', 'running'].includes(a.status)) || b.updatedAt.localeCompare(a.updatedAt));
  return <div className="agenda-task-list"><header className="agenda-task-list-heading"><p>自己立下的任务和收到的委托在这里，日常作息与普通聊天保留在“日常”。</p><button className="agenda-add" onClick={onAddLongterm}>添加长期任务</button></header><div className="agenda-execution-filter" role="group" aria-label="实际执行记录筛选"><button type="button" aria-pressed={executionStatus === 'active'} onClick={() => onExecutionStatus('active')}>进行中的执行</button><button type="button" aria-pressed={executionStatus === 'ended'} onClick={() => onExecutionStatus('ended')}>已结束的执行</button></div>{executions.map(execution => <article className="agenda-task-row" key={`execution:${execution.id}`} data-agenda-task={execution.id} data-agenda-execution={execution.id}>
    <button type="button" disabled={!onOpenAction || !execution.contentAvailable} onClick={() => onOpenAction?.(execution.id)} aria-haspopup="dialog"><span><strong>{execution.contentAvailable ? execution.title : '原执行资料已变化'}</strong><small>实际执行 · {execution.waitingApproval ? '等待你确认权限' : executionLabels[execution.status]} · 更新于 {agendaFullTime(execution.updatedAt)}</small>{execution.contentAvailable && execution.stage && <p>{companionCapabilityDiagnostic(execution.stage)}</p>}</span><Icon name="chevron" /></button>
  </article>)}{scheduled.map(rule => {
    const latest = data.runs.filter(run => run.ruleId === rule.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return <article className="agenda-task-row" key={rule.id} data-agenda-task={rule.id}><button onClick={() => onOpen(rule.id)} aria-haspopup="dialog"><span><strong>{agendaRuleTitle(rule)}</strong><small>{rule.classification?.basis === 'self_task' ? '自主任务' : rule.classification?.basis === 'source_task' ? '收到的委托' : '实际任务'} · {agendaTriggerLabel(rule)}{rule.nextAt && ` · ${rule.nextAt > data.observedAt ? '下次' : '考虑于'} ${agendaFullTime(rule.nextAt)}`}</small><p>{latest?.stage || agendaRuleIntent(rule)}</p></span><Icon name="chevron" /></button>{rule.taskResponse && <p className="agenda-task-response">回应 · {{ accept: '已接受', negotiate: '正在协商', decline: '已婉拒' }[rule.taskResponse.decision]}：{rule.taskResponse.message}</p>}</article>;
  })}{!!goals.length && <><h3 className="agenda-task-subheading">长期任务</h3><AgendaGoals goals={goals} data={data} owner={owner} busy={busy} onMutate={onMutate} onDiscuss={onDiscuss} /></>}{!tasks.length && <EmptyState icon="clipboard" title="还没有已登记的任务" text="可以直接和伙伴商量想做的事。定时安排、委托和持续学习会保留在同一份任务记录中。" />}</div>;
}

function SystemEvents({ data, onOpen }: { data: CompanionAgendaView; onOpen(ruleId: string): void }) {
  return <div className="agenda-system-list">{data.rules.filter(rule => rule.category === 'event').map(rule => {
    const latest = data.runs.filter(run => run.ruleId === rule.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return <details className="agenda-system-rule" key={rule.id}><summary><Icon name="archive" /><strong>{agendaRuleTitle(rule)}</strong><small>{latest?.status === 'running' ? '正在维护' : latest?.status === 'parked' || latest?.status === 'unknown' ? '需要核对' : '系统维护'}</small></summary><p>{rule.reason}</p>{latest && <p>{latest.stage}</p>}<button className="agenda-add" onClick={() => onOpen(rule.id)}>查看实际处理记录</button></details>;
  })}</div>;
}

function composeDate() { const date = new Date(Date.now() + 3600000); return `${agendaDayKey(date.getTime())}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function Compose({ owner, goal, data, busy, onMutate, onClose, onChooseGoals }: {
  owner: string; goal: boolean; data?: CompanionAgendaView; busy: boolean; onMutate(command: Mutation): Promise<boolean>; onClose(): void; onChooseGoals(): void;
}) {
  const [title, setTitle] = useState(''), [intent, setIntent] = useState(''), [at, setAt] = useState(composeDate), [error, setError] = useState('');
  const [kind, setKind] = useState<CompanionAgendaRule['kind']>('self'), [domain, setDomain] = useState<CompanionAgendaGoal['domain']>('knowledge'), [criteria, setCriteria] = useState('');
  const [flexible, setFlexible] = useState(true), [allowWeb, setAllowWeb] = useState(false);
  const [triggerKind, setTriggerKind] = useState<'at' | 'window' | 'interval'>('at'), [repeat, setRepeat] = useState<'once' | 'daily' | 'weekly' | 'monthly'>('once');
  const [windowStart, setWindowStart] = useState('09:00'), [windowEnd, setWindowEnd] = useState('18:00'), [probability, setProbability] = useState('100');
  const [interval, setInterval] = useState('60'), [overlap, setOverlap] = useState<CompanionAgendaRule['overlapPolicy']>('parallel');
  const [grantId, setGrantId] = useState(''), [learningId, setLearningId] = useState('');
  const [routineKind, setRoutineKind] = useState<'sleep' | 'meal' | 'habit'>('sleep');
  const timeZone = kind === 'rest' && data?.worldTime ? data.worldTime.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const grants = data?.grants.filter(grant => grant.companionId === owner && grant.status === 'active' && grant.capabilities.includes('observe')
    && grant.windowIds.length && grant.captureSources.length && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.parse(data.observedAt))) ?? [];
  const learning = (data?.goals ?? []).filter(item => item.companionId === owner && item.status === 'active').flatMap(item => {
    const execution = data?.rules.find(rule => rule.companionId === owner && rule.goalId === item.id && rule.executor === 'learning' && rule.referenceId && rule.status === 'active');
    return execution ? [{ goal: item, execution }] : [];
  });
  async function save(now: number) {
    setError(''); if (!title.trim() || !intent.trim()) { setError('写下名称和完整的想法，再保存。'); return; }
    if (goal) {
      if (!criteria.trim()) { setError('请说明怎样判断这个方向有了进展。'); return; }
      if (await onMutate({ type: 'agenda.goal.create', companionId: owner, goal: { title: title.trim(), intent: intent.trim(), domain, successCriteria: criteria.split('\n').map(item => item.trim()).filter(Boolean), nextQuestions: [], materials: [], allowWeb } })) onClose();
      return;
    }
    const grant = grants.find(item => item.id === grantId), study = learning.find(item => item.goal.id === learningId);
    if (kind === 'observation' && (!grant || grant.expiresAt && Date.parse(grant.expiresAt) <= now)) { setError('请先设置观察范围，并选择这次安排可使用的授权。'); return; }
    if (kind === 'learning' && !study) { setError('请选择已经准备好学习材料的长期方向。'); return; }
    if (triggerKind !== 'window' && (!Number.isFinite(new Date(at).getTime()) || new Date(at).getTime() <= now)) { setError('请选择未来的考虑时间。'); return; }
    const minutes = (value: string) => /^\d{2}:\d{2}$/u.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
    const trigger = triggerKind === 'window'
      ? { kind: 'window', startMinute: minutes(windowStart), endMinute: minutes(windowEnd), timeZone, probability: Number(probability) / 100, checkIntervalMinutes: 15 }
      : triggerKind === 'interval' ? { kind: 'interval', anchorAt: new Date(at).toISOString(), everyMinutes: Number(interval), timeZone, probability: Number(probability) / 100 }
        : { kind: 'at', at: new Date(at).toISOString(), timeZone, repeat, probability: Number(probability) / 100 };
    const executor = kind === 'rest' ? 'routine' : kind === 'reflection' ? 'reflection' : kind === 'observation' ? 'observation' : kind === 'learning' ? 'learning' : kind === 'world' ? 'world' : kind === 'reminder' ? 'reminder' : 'brain';
    const rule = companionAgendaRuleDraftSchema.safeParse({ title: title.trim(), intent: intent.trim(), kind, executor,
      trigger: kind === 'rest' ? { kind: 'window', startMinute: minutes(windowStart), endMinute: minutes(windowEnd), timeZone, probability: 1 } : trigger,
      ...(kind === 'rest' ? { clock: 'world', routine: routineKind === 'sleep' ? { kind: 'sleep' } : routineKind === 'meal' ? { kind: 'meal', name: title.trim() } : { kind: 'habit', habitKind: 'custom' } } : {}),
      flexible, conditions: kind === 'learning' && study ? study.execution.conditions : [], overlapPolicy: overlap,
      resourceKeys: kind === 'learning' && study ? study.execution.resourceKeys : [], reason: '用户在伙伴日程中新增的安排。',
      ...(kind === 'observation' && grant ? { grantId: grant.id, conversationId: grant.conversationId } : {}),
      ...(kind === 'learning' && study ? { goalId: study.goal.id, grantId: study.execution.grantId, referenceId: study.execution.referenceId, conversationId: study.execution.conversationId } : {}) });
    if (!rule.success) { setError(rule.error.issues[0]?.message ?? '安排内容尚不完整。'); return; }
    if (await onMutate({ type: 'agenda.rule.create', companionId: owner, rule: rule.data })) onClose();
  }
  // eslint-disable-next-line react-hooks/purity -- The submit event reads the clock; rendering never invokes it.
  return <form className="agenda-compose" onSubmit={event => { event.preventDefault(); void save(Date.now()); }}>
    <header className="agenda-detail-heading"><div><small>{goal ? '准备长期任务' : '在日程中留下一件事'}</small><h3>{goal ? '新的长期任务' : '添加安排'}</h3></div><button type="button" className="agenda-icon-button" aria-label="关闭新增安排" onClick={onClose} disabled={busy}><Icon name="close" /></button></header>
    <div className="agenda-compose-fields">
      <label>名称<input autoFocus required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder={goal ? '想逐步学会或理解什么' : '这件事叫什么'} /></label>
      <label className="agenda-compose-wide">完整想法<textarea required maxLength={goal ? 12000 : 16000} rows={3} value={intent} onChange={event => setIntent(event.target.value)} placeholder="目标、必要的材料和需要遵守的约定" /></label>
      {goal ? <>
        <Select label="方向" value={domain} options={Object.entries(goalDomain).map(([value, label]) => ({ value, label }))} onValueChange={value => setDomain(value as CompanionAgendaGoal['domain'])} />
        <label className="agenda-compose-wide">怎样判断有进展<textarea required maxLength={6000} rows={2} value={criteria} onChange={event => setCriteria(event.target.value)} placeholder="写下可核对的表现或结果，每行一项" /></label>
        <label className="agenda-compose-check"><input type="checkbox" checked={allowWeb} onChange={event => setAllowWeb(event.target.checked)} />允许为这个方向查阅公开网页</label>
      </> : <>
        <Select label="事项" value={kind} options={(['self', 'research', 'learning', 'world', 'observation', 'reminder', 'reflection', 'rest'] as const).map(value => ({ value, label: agendaKindLabels[value] }))} onValueChange={value => { setKind(value as CompanionAgendaRule['kind']); if (value === 'rest') setTriggerKind('window'); }} />
        {kind === 'rest' ? <Select label="生活安排" value={routineKind} options={[{ value: 'sleep', label: '睡眠与起床' }, { value: 'meal', label: '用餐' }, { value: 'habit', label: '日常习惯' }]} onValueChange={value => setRoutineKind(value as typeof routineKind)} /> : <Select label="时间方式" value={triggerKind} options={[{ value: 'at', label: '约定时间' }, { value: 'window', label: '一段时间内找机会' }, { value: 'interval', label: '间隔一段时间' }]} onValueChange={value => setTriggerKind(value as typeof triggerKind)} />}
        {kind === 'observation' && <div className="agenda-compose-scope agenda-compose-wide">{grants.length ? <><Select label="本次观察范围" placeholder="选择已允许的窗口范围" value={grantId} options={grants.map(item => ({ value: item.id, label: item.title }))} onValueChange={setGrantId} /><p>{grants.find(item => item.id === grantId)?.captureSources.map(item => item.title).join('、') || '只使用明确选中的范围；不会转为观察整个桌面。'}</p></> : <p>还没有有效的观察范围。先收起本表，在日程下方选择可观察的窗口，再添加观察安排。</p>}</div>}
        {kind === 'learning' && <div className="agenda-compose-scope agenda-compose-wide">{learning.length ? <><Select label="继续哪个学习方向" placeholder="选择可接续的长期方向" value={learningId} options={learning.map(item => ({ value: item.goal.id, label: item.goal.title }))} onValueChange={setLearningId} /><p>接续已有的阅读与练习。可用来源由这个方向维护；材料尚未准备好时会等待。</p></> : <><p>先准备一个长期方向，并和伙伴确定可用的学习材料。准备好后，再为它安排具体的学习时间。</p><button type="button" onClick={onChooseGoals}>前往任务</button></>}</div>}
        {triggerKind === 'window' ? <><label>开始时间<input required type="time" value={windowStart} onChange={event => setWindowStart(event.target.value)} /></label><label>结束时间<input required type="time" value={windowEnd} onChange={event => setWindowEnd(event.target.value)} /></label>{kind !== 'rest' && <label>窗口内发生的概率（%）<input required type="number" min={0} max={100} step={1} value={probability} onChange={event => setProbability(event.target.value)} /></label>}<p className="agenda-compose-help">{kind === 'rest' ? '作息使用世界时间，每日遵循这个窗口。身体实际入睡、起床或用餐以世界中的行动记录为准。' : '每天在这段时间内寻找机会，跨夜时间也可以。概率描述整个窗口，不是每次检查都重新抽签；其他条件仍需满足。'}</p></> : <>
          <label>{triggerKind === 'interval' ? '第一次考虑时间' : '考虑时间'}<input required type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /></label>
          {triggerKind === 'interval' ? <label>每隔多少分钟<input required type="number" min={1} max={525600} step={1} value={interval} onChange={event => setInterval(event.target.value)} /></label> : <Select label="重复" value={repeat} options={[{ value: 'once', label: '仅这一次' }, { value: 'daily', label: '每天' }, { value: 'weekly', label: '每周这一天' }, { value: 'monthly', label: '每月这一天' }]} onValueChange={value => setRepeat(value as typeof repeat)} />}
        </>}
        {triggerKind !== 'window' && kind !== 'rest' && <label>每次机会的概率（%）<input required type="number" min={0} max={100} step={1} value={probability} onChange={event => setProbability(event.target.value)} /></label>}
        <Select label="时间重合时" value={overlap} options={[{ value: 'parallel', label: '允许同时进行' }, { value: 'wait', label: '等待前一件结束' }, { value: 'skip', label: '略过本次机会' }, { value: 'merge', label: '合并到未完成的事项' }]} onValueChange={value => setOverlap(value as typeof overlap)} />
        <label className="agenda-compose-check"><input type="checkbox" checked={flexible} onChange={event => setFlexible(event.target.checked)} />允许伙伴调整时间</label>
      </>}
    </div>
    {error && <p className="agenda-message is-error" role="alert">{error}</p>}
    <footer className="agenda-detail-actions"><small>{goal ? '伙伴将根据真实进展安排阅读、练习和回顾。' : `时间按 ${timeZone} 计算。能力范围以有效授权为准；复杂条件可直接和伙伴商量。`}</small><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" disabled={busy || !goal && !data}>{busy ? '正在保存…' : '保存'}</button></footer>
  </form>;
}

function ObservationScope({ owner, data, busy, load, onMutate }: { owner: string; data: CompanionAgendaView; busy: boolean; load?(owner: string): Promise<AgendaObservationSource[]>; onMutate(command: Mutation): Promise<boolean> }) {
  const [sources, setSources] = useState<{ owner: string; items: AgendaObservationSource[] }>(), [selected, setSelected] = useState<string[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const current = useRef(owner); useLayoutEffect(() => { current.current = owner; }, [owner]);
  const grants = data.grants.filter(grant => grant.companionId === owner && grant.capabilities.includes('observe'));
  async function refreshSources() {
    if (!load) return; setLoading(true); setError('');
    try { const items = await load(owner); if (current.current === owner) { setSources({ owner, items }); setSelected([]); } }
    catch { if (current.current === owner) setError('可观察的窗口暂时无法读取。'); }
    finally { if (current.current === owner) setLoading(false); }
  }
  return <details className="agenda-observation"><summary><Icon name="eye" />观察范围<span>{grants.some(grant => grant.status === 'active') ? '已设置持续范围' : '未开启'}</span></summary><div className="agenda-observation-body"><p>只在你选择的范围内观察。打开此处不会获取截图；保存范围后，伙伴才可在日程机会中实际查看。</p>{grants.map(grant => <div className="agenda-observation-grant" key={grant.id}><strong>{grant.title}</strong><span>{grant.status === 'active' ? '有效' : '已撤回'}</span><small>{grant.captureSources.map(source => source.title).join('、') || `${grant.windowIds.length} 个已选来源`}{grant.expiresAt && ` · 至 ${agendaFullTime(grant.expiresAt)}`}</small>{grant.status === 'active' && <button disabled={busy} onClick={() => void onMutate({ type: 'agenda.grant.revoke', companionId: owner, id: grant.id, expectedRevision: grant.revision })}>暂停这份观察授权</button>}</div>)}{load && <><button className="agenda-load-more" type="button" disabled={loading || busy} onClick={() => void refreshSources()}>{loading ? '正在读取窗口…' : '选择可观察的窗口'}</button>{sources?.owner === owner && <div className="agenda-observation-sources">{sources.items.length ? sources.items.map(source => <label key={source.id}><input type="checkbox" checked={selected.includes(source.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, source.id] : previous.filter(id => id !== source.id))} />{source.title}</label>) : <p>当前没有可供选择的来源。</p>}<button type="button" disabled={!selected.length || busy} onClick={() => void onMutate({ type: 'agenda.grant.configure', companionId: owner, grant: { title: '查看选定的电脑画面', capabilities: ['observe'], windowIds: selected, captureSources: sources.items.filter(source => selected.includes(source.id)), fileRoots: [], outputRoots: [], allowPublicWeb: false } }).then(ok => { if (ok) setSelected([]); })}>允许持续查看所选范围</button></div>}</>}{error && <p role="status">{error}</p>}</div></details>;
}

function CapabilityScope({ owner, data, now, busy, onMutate }: { owner: string; data: CompanionAgendaView; now: number; busy: boolean; onMutate(command: Mutation): Promise<boolean> }) {
  const [title, setTitle] = useState('自主探索与学习'), [web, setWeb] = useState(false), [thought, setThought] = useState(false),
    [reading, setReading] = useState(false), [delivery, setDelivery] = useState(false), [learning, setLearning] = useState(false);
  const [fileRoots, setFileRoots] = useState(''), [outputRoots, setOutputRoots] = useState('');
  const [includeObservation, setIncludeObservation] = useState(false), [observationId, setObservationId] = useState(''), [scopeError, setScopeError] = useState('');
  const grants = data.grants.filter(grant => grant.companionId === owner && grant.capabilities.some(capability => capability !== 'observe'));
  const observations = data.grants.filter(grant => grant.companionId === owner && grant.status === 'active' && !grant.goalId && !grant.conversationId
    && grant.capabilities.includes('observe') && (!grant.expiresAt || Date.parse(grant.expiresAt) > now) && grant.windowIds.length > 0
    && grant.captureSources.length === grant.windowIds.length && grant.windowIds.every(id => grant.captureSources.some(source => source.id === id)));
  const observation = includeObservation ? observations.find(grant => grant.id === observationId) : undefined;
  const lines = (text: string) => text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  async function save() {
    setScopeError('');
    if (includeObservation && (!observation || observation.expiresAt && Date.parse(observation.expiresAt) <= now)) { setScopeError('请先选择一份仍有效的通用观察范围，再保存。'); return; }
    const capabilities = [...web ? ['browser' as const] : [], ...thought ? ['dsh' as const] : [], ...reading ? ['files.read' as const] : [],
      ...delivery ? ['files.deliver' as const] : [], ...learning ? ['learning' as const] : [], ...observation ? ['observe' as const] : []];
    await onMutate({ type: 'agenda.grant.configure', companionId: owner, grant: { title: title.trim(), capabilities,
      windowIds: observation ? [...observation.windowIds] : [], captureSources: observation ? observation.captureSources.map(source => ({ ...source })) : [],
      ...(observation?.expiresAt ? { expiresAt: observation.expiresAt } : {}),
      fileRoots: reading ? lines(fileRoots) : [], outputRoots: delivery ? lines(outputRoots) : [], allowPublicWeb: web } });
  }
  return <details className="agenda-observation"><summary><Icon name="shield" />自主行动范围<span>{grants.some(grant => grant.status === 'active') ? '已设置' : '尚未设置'}</span></summary>
    <div className="agenda-observation-body"><p>这些范围供伙伴在自己的日程中使用。允许某种能力，不代表要求它必须执行；它仍会依据自己的想法和实际情况安排。</p>
      {grants.map(grant => <div className="agenda-observation-grant" key={grant.id}><strong>{grant.title}</strong><span>{grant.status === 'active' ? '有效' : '已撤回'}</span><small>{grant.capabilities.map(capability => ({ browser: '公开网页', dsh: '独立思考', 'files.read': '读取资料', 'files.deliver': '交付文件', learning: '持续学习', observe: '观察' })[capability]).join(' · ')}</small>{grant.status === 'active' && <button disabled={busy} onClick={() => void onMutate({ type: 'agenda.grant.revoke', companionId: owner, id: grant.id, expectedRevision: grant.revision })}>撤回这份范围</button>}</div>)}
      <form className="agenda-compose-fields" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="agenda-compose-wide">范围名称<input required value={title} maxLength={160} onChange={event => setTitle(event.target.value)} /></label>
        <label className="agenda-compose-check"><input type="checkbox" checked={web} onChange={event => setWeb(event.target.checked)} />查阅公开网页</label>
        <label className="agenda-compose-check"><input type="checkbox" checked={thought} onChange={event => setThought(event.target.checked)} />使用 DSH 独立思考</label>
        <label className="agenda-compose-check agenda-compose-wide"><input type="checkbox" checked={includeObservation} onChange={event => { setIncludeObservation(event.target.checked); setScopeError(''); }} />同时使用已允许的观察范围</label>
        {includeObservation && <div className="agenda-compose-scope agenda-compose-wide">{observations.length ? <><Select label="选择一份通用观察范围" value={observationId} placeholder="明确选择一份已允许的范围" options={observations.map(grant => ({ value: grant.id, label: grant.title }))} onValueChange={value => { setObservationId(value); setScopeError(''); }} /><p>{observation ? <>仅使用：{observation.captureSources.map(source => source.title).join('、')}{observation.expiresAt && `；有效至 ${agendaFullTime(observation.expiresAt)}`}。保存为一份新的独立授权，可单独撤回。</> : '只合入你选中的这一份窗口范围；不会合并其他授权，也不会扩大到整个屏幕。'}</p></> : <p>还没有有效的通用观察范围。请先在“观察范围”中选择并允许窗口；专门任务或学习目标的范围不会在这里借用。</p>}</div>}
        <label className="agenda-compose-check"><input type="checkbox" checked={learning} onChange={event => setLearning(event.target.checked)} />推进持续学习</label>
        <label className="agenda-compose-check"><input type="checkbox" checked={reading} onChange={event => setReading(event.target.checked)} />读取指定资料目录</label>
        {reading && <label className="agenda-compose-wide">可读取的目录<textarea required rows={2} value={fileRoots} onChange={event => setFileRoots(event.target.value)} placeholder="每行一个已有目录的绝对路径" /></label>}
        <label className="agenda-compose-check"><input type="checkbox" checked={delivery} onChange={event => setDelivery(event.target.checked)} />把指定输出目录的文件交给我</label>
        {delivery && <label className="agenda-compose-wide">可交付的输出目录<textarea required rows={2} value={outputRoots} onChange={event => setOutputRoots(event.target.value)} placeholder="每行一个已有目录的绝对路径" /></label>}
        <p className="agenda-compose-help">独立思考只分析已提供的材料；资料读取与文件交付分别按目录核验。持续范围会保留，可随时撤回。未绑定专门方向的自主事件采用最近签发的一份通用范围。</p>
        {scopeError && <p role="alert" className="agenda-compose-help agenda-compose-wide">{scopeError}</p>}
        <button type="submit" disabled={busy || !title.trim() || ![web, thought, learning, reading, delivery, includeObservation].some(Boolean) || includeObservation && !observation}>保存持续范围</button>
      </form>
    </div>
  </details>;
}

function CapacitySettings({ owner, read, configure }: { owner: string; read(owner: string): Promise<AgendaCapacity>; configure(owner: string, limit: number): Promise<AgendaCapacity> }) {
  const panel = useRef<HTMLDetailsElement>(null), scope = useRef(owner), live = useRef(true);
  const [snapshot, setSnapshot] = useState<AgendaCapacity>(), [draft, setDraft] = useState<number>(), [error, setError] = useState(''), [pending, setPending] = useState(false);
  useLayoutEffect(() => { scope.current = owner; }, [owner]);
  useEffect(() => { live.current = true; const outside = (event: PointerEvent) => { if (panel.current?.open && !panel.current.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('[role="listbox"]'))) panel.current.open = false; }; document.addEventListener('pointerdown', outside); return () => { live.current = false; document.removeEventListener('pointerdown', outside); }; }, []);
  const data = snapshot?.companionId === owner ? snapshot : undefined;
  async function load() { setPending(true); setError(''); try { const result = await read(owner); if (scope.current === owner && live.current && result.companionId === owner) { setSnapshot(result); setDraft(undefined); } } catch { if (scope.current === owner && live.current) setError('并行安排暂不可读取。'); } finally { if (scope.current === owner && live.current) setPending(false); } }
  async function save() { if (draft === undefined) return; setPending(true); setError(''); try { const result = await configure(owner, draft); if (scope.current === owner && live.current && result.companionId === owner) { setSnapshot(result); setDraft(undefined); } } catch { if (scope.current === owner && live.current) setError('尚未确认保存，请重新打开核对。'); } finally { if (scope.current === owner && live.current) setPending(false); } }
  return <details className="agenda-capacity" ref={panel} onToggle={event => { if (event.currentTarget.open) void load(); }} onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); if (panel.current) panel.current.open = false; } }}><summary aria-label="同时进行的事项"><Icon name="sliders" /><span>并行安排</span></summary><div className="agenda-capacity-panel"><h3>同时进行的事项</h3><p>每位伙伴有自己的并发数量，跨聊天与活动共用。</p>{error && <p role="alert">{error}</p>}<Select label="同时进行" aria-label="伙伴并发数量" disabled={!data || pending} value={String(draft ?? data?.limit ?? '')} placeholder="正在读取…" options={Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 件事` }))} onValueChange={value => setDraft(Number(value))} layer="modal" />{data && <small>当前 {data.active} 件进行中 · {data.queued} 件等待</small>}<footer><p>调整后保留正在进行的事，新的事项按空余位置开始。</p><button disabled={pending || draft === undefined || draft === data?.limit} onClick={() => void save()}>{pending ? '正在核对…' : '保存'}</button></footer></div></details>;
}

export interface CompanionAgendaProps {
  companions: Companion[]; initialCompanionId?: string; initialView?: AgendaViewName; initialEventId?: string; request: AgendaRequest; api?: Api; jobsApi?: WorldlineBoxCompanionsApi;
  active?: boolean; modal?: boolean; onClose(): void; onOpenAction?(id: string): void; onDiscuss?(companionId: string): void;
  loadObservationSources?(companionId: string): Promise<AgendaObservationSource[]>;
  readCapacity?(companionId: string): Promise<AgendaCapacity>;
  configureCapacity?(companionId: string, limit: number): Promise<AgendaCapacity>;
}
export function CompanionAgenda({ companions, initialCompanionId, initialView = 'today', initialEventId, request, api, jobsApi, active = true, modal = true, onClose, onOpenAction, onDiscuss, loadObservationSources, readCapacity, configureCapacity }: CompanionAgendaProps) {
  const [ownerId, setOwnerId] = useState(initialCompanionId ?? companions[0]?.id ?? ''), [view, setView] = useState<AgendaViewName>(initialView === 'goals' ? 'upcoming' : initialView);
  const [executionStatus, setExecutionStatus] = useState<'active' | 'ended'>('active');
  const now = useVisibleAgendaClock(active), [selectedDay, setSelectedDay] = useState(() => agendaDayKey(Date.now())), [followingToday, setFollowingToday] = useState(true);
  const day = followingToday ? agendaDayKey(now) : selectedDay;
  const owner = companions.find(companion => companion.id === ownerId), effectiveOwner = owner?.id ?? companions[0]?.id ?? '';
  const [selected, setSelected] = useState<{ owner: string; key: string }>(), [compose, setCompose] = useState<{ owner: string; goal: boolean }>();
  const [notice, setNotice] = useState<{ owner: string; text: string }>(), [busy, setBusy] = useState(false);
  const [failureOwner, setFailureOwner] = useState<string>();
  const source = useAgendaData({ owner: effectiveOwner, day, view, request, api, active, executionStatus });
  const alive = useRef(active), scope = useRef(effectiveOwner), operations = useRef(new Map<string, string>()), [portal] = useState(() => document.createElement('div'));
  useLayoutEffect(() => { alive.current = active; scope.current = effectiveOwner; }, [active, effectiveOwner]);
  useLayoutEffect(() => { if (!active || !modal) return; document.body.append(portal); return () => portal.remove(); }, [active, modal, portal]);
  useEffect(() => () => { alive.current = false; }, []);
  useDialogFocusTrap(active && modal, 'companion-unified-agenda');
  const refresh = source.refresh;
  async function mutate(command: Mutation): Promise<boolean> {
    if (busy) return false;
    const owner = command.companionId, signature = JSON.stringify(command), operationId = operations.current.get(signature) ?? crypto.randomUUID();
    operations.current.set(signature, operationId); setBusy(true); setNotice(undefined);
    try {
      const result = await request({ ...command, operationId } as CompanionAgendaPublicCommand);
      if (!alive.current || scope.current !== owner) return false;
      if (!result?.ok) { setNotice({ owner, text: result?.error ?? '尚未确认保存，请刷新核对后重试。' }); return false; }
      operations.current.delete(signature); await refresh(); return true;
    } catch { if (alive.current && scope.current === owner) setNotice({ owner, text: '保存结果尚未确认。再次提交会沿用本次标识，避免重复建立安排。' }); return false; }
    finally { setBusy(false); }
  }
  if (!active) return null;
  const data = source.data, role = companions.find(companion => companion.id === effectiveOwner);
  const projected = data ? agendaEntries(data, view === 'history' ? 'upcoming' : view, day) : [];
  const entries = projected.filter(entry => entry.rule.category !== 'event');
  const selectable = [...projected, ...(data?.rules ?? []).map(rule => ({ key: `rule:${rule.id}`, rule, planned: true } as AgendaEntry))];
  const systemCount = data?.rules.filter(rule => rule.category === 'event').length ?? 0;
  const openRule = (id: string) => setSelected({ owner: effectiveOwner, key: projected.find(entry => entry.rule.id === id && entry.run?.status === 'running')?.key ?? projected.find(entry => entry.rule.id === id)?.key ?? `rule:${id}` });
  const conditional = entries.filter(entry => !entry.at), timed = entries.filter(entry => !!entry.at);
  const showNow = view === 'today' && day === agendaDayKey(now);
  const groupedDays = [...new Set(timed.map(entry => agendaDayKey(entry.at!)))];
  const chosen = selected?.owner === effectiveOwner ? selected.key : initialEventId ? selectable.find(entry => entry.rule.id === initialEventId)?.key : undefined;
  const showFailures = view === 'history' && failureOwner === effectiveOwner && !!jobsApi?.workspace;
  const content: ReactNode = <section className={`companion-agenda${modal ? '' : ' is-embedded'}`} role={modal ? 'dialog' : 'region'} aria-modal={modal ? true : undefined} aria-label="伙伴日程" onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); if (showFailures) setFailureOwner(undefined); else if (compose?.owner === effectiveOwner) setCompose(undefined); else if (chosen) setSelected({ owner: effectiveOwner, key: '' }); else onClose(); } }}>
    <header className="agenda-header"><div className="agenda-header-identity"><Avatar companion={role} showPresence={false} /><div><h2>{role ? `${role.name}的日程` : '伙伴日程'}</h2><p>一起过日子，慢慢往前走</p></div></div>{companions.length > 1 && <Select appearance="inline" className="agenda-owner-select" aria-label="日程所属伙伴" value={effectiveOwner} options={companions.map(companion => ({ value: companion.id, label: companion.name }))} onValueChange={setOwnerId} layer="modal" />}{readCapacity && configureCapacity && <CapacitySettings key={effectiveOwner} owner={effectiveOwner} read={readCapacity} configure={configureCapacity} />}<>{onDiscuss && <button className="agenda-discuss" onClick={() => onDiscuss(effectiveOwner)}><Icon name="message-circle" /><span>和伙伴商量</span></button>}</><button className="agenda-icon-button" aria-label="刷新伙伴日程" title="刷新" disabled={source.refreshing} onClick={() => void refresh()}><Icon name="refresh" /></button><button className="agenda-icon-button" aria-label="关闭伙伴日程" onClick={onClose}><Icon name="close" /></button></header>
    <div className="agenda-toolbar"><nav className="agenda-tabs" role="tablist" aria-label="日程内容">{views.map(item => <button type="button" key={item.id} role="tab" aria-selected={view === item.id} onClick={() => { setView(item.id); if (item.id === 'today') setFollowingToday(true); setSelected(undefined); }}><Icon name={item.icon} />{item.label}</button>)}</nav>{view === 'today' ? <nav className="agenda-date-navigation" aria-label="选择日程日期"><button className="agenda-icon-button" aria-label="前一天" onClick={() => { setSelectedDay(agendaMoveDay(day, -1)); setFollowingToday(false); setSelected(undefined); }}><Icon name="chevron-left" /></button><time className="agenda-date-heading" dateTime={day}>{new Date(day + 'T12:00:00').toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time><button className="agenda-icon-button" aria-label="后一天" onClick={() => { setSelectedDay(agendaMoveDay(day, 1)); setFollowingToday(false); setSelected(undefined); }}><Icon name="chevron-right" /></button><button className="agenda-today" onClick={() => { setFollowingToday(true); setView('today'); setSelected(undefined); }}>{followingToday ? '今天' : '回到此刻'}</button></nav> : <span className="agenda-view-context">{view === 'history' ? '由系统维护，按需查看过程' : '自主、委托与长期任务'}</span>}{view !== 'history' && <button className="agenda-add" onClick={() => setCompose({ owner: effectiveOwner, goal: false })} disabled={!effectiveOwner || busy}><Icon name="plus" />{view === 'upcoming' ? '添加任务' : '添加安排'}</button>}</div>

    {source.error && <p className="agenda-message is-error" role="status"><Icon name="alert-circle" size={14} /><span>{source.error}{data && ' 当前保留上次核对的内容。'}</span><button onClick={() => void refresh()}>重新核对</button></p>}{notice?.owner === effectiveOwner && <p className="agenda-message is-error" role="alert"><span>{notice.text}</span><button onClick={() => setNotice(undefined)}>关闭提示</button></p>}
    <div className="agenda-scroll">{compose?.owner === effectiveOwner && <Compose key={`${effectiveOwner}/${compose.goal}`} owner={effectiveOwner} goal={compose.goal} data={data} busy={busy} onMutate={mutate} onClose={() => setCompose(undefined)} onChooseGoals={() => { setCompose(undefined); setSelected(undefined); setView('upcoming'); }} />}
      {view === 'history' && jobsApi?.workspace && !showFailures && <div className="agenda-job-failures-entry"><p>核对已失败或搁置的整理、索引等处理，按需决定后续操作。</p><button type="button" onClick={() => { setSelected({ owner: effectiveOwner, key: '' }); setFailureOwner(effectiveOwner); }} disabled={!effectiveOwner}>管理故障作业</button></div>}
      {showFailures ? <CompanionJobFailures key={effectiveOwner} ownerId={effectiveOwner} api={jobsApi} onClose={() => setFailureOwner(undefined)} /> : !data ? <div className="agenda-loading" role="status">{source.error ? '日程尚未核对。' : '正在读取日程…'}</div> : view === 'upcoming' || view === 'goals' ? <AgendaTasks tasks={source.tasks} data={data} executionStatus={executionStatus} onExecutionStatus={setExecutionStatus} owner={effectiveOwner} busy={busy} onMutate={mutate} onOpen={openRule} onOpenAction={onOpenAction} onDiscuss={onDiscuss ? () => onDiscuss(effectiveOwner) : undefined} onAddLongterm={() => setCompose({ owner: effectiveOwner, goal: true })} /> : view === 'history' ? systemCount ? <SystemEvents data={data} onOpen={openRule} /> : <EmptyState icon="archive" title="没有待展示的系统维护" text="记忆整理等维护由系统管理，实际处理记录会保留在这里。" /> : <>
        <div className="agenda-reading-label"><span>伙伴日常</span><span>{entries.length} 项具体安排 · 点开查看条件与过程</span></div>
        {groupedDays.map(key => <section className="agenda-day" key={key}>{groupedDays.length > 1 && <h3 className="agenda-day-heading">{new Date(key + 'T12:00:00').toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</h3>}<EventRows entries={timed.filter(entry => agendaDayKey(entry.at!) === key)} selected={chosen} onSelect={key => setSelected({ owner: effectiveOwner, key })} now={showNow && key === day ? now : undefined} /></section>)}
        {showNow && !groupedDays.includes(day) && <EventRows entries={[]} selected={chosen} onSelect={key => setSelected({ owner: effectiveOwner, key })} now={now} />}
        {!!conditional.length && <><h3 className="agenda-conditional-heading">等待真实条件<p>发生后才进入实际时间线。</p></h3><EventRows entries={conditional} selected={chosen} onSelect={key => setSelected({ owner: effectiveOwner, key })} /></>}
        {!entries.length && <EmptyState icon="clock" title="这一段日子，留着一些空白" text="可以直接和伙伴商量。任务会投影到实际考虑的时间；安排不代表已经发生。" />}
        {!!systemCount && <details className="agenda-system-overview"><summary><Icon name="archive" />系统维护<small>{systemCount} 项，按需查看</small></summary><SystemEvents data={data} onOpen={openRule} /></details>}
      </>}
      {!showFailures && data && source.hasMore && <button className="agenda-load-more" disabled={source.refreshing} onClick={source.more}>{source.refreshing ? '正在读取…' : '查看更多'}</button>}
      {!showFailures && data && <section className="agenda-settings" aria-label="伙伴的行动范围"><ObservationScope key={effectiveOwner} owner={effectiveOwner} data={data} busy={busy} load={loadObservationSources} onMutate={mutate} /><CapabilityScope key={effectiveOwner + '/capabilities'} owner={effectiveOwner} data={data} now={now} busy={busy} onMutate={mutate} /></section>}
    </div>
    {data && selectable.find(entry => entry.key === chosen) && <EventDetailDialog key={`${effectiveOwner}/${chosen}`} owner={effectiveOwner} entry={selectable.find(entry => entry.key === chosen)!} request={request} revision={data.revision} onMutate={mutate} busy={busy} notice={notice?.owner === effectiveOwner ? notice.text : undefined} onClose={() => setSelected({ owner: effectiveOwner, key: '' })} />}
    <footer className="agenda-footer"><span>安排不代表已经发生；条件检查不保证开始时间。</span><span>{data ? `核对于 ${agendaClock(data.observedAt)}${source.refreshing ? ' · 正在同步' : ''}` : '只展示本人真实安排'}</span></footer>
  </section>;
  return modal ? createShellPortal(<div className="companion-agenda-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>{content}</div>, portal) : content;
}

function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }) { return <div className="agenda-empty"><Icon name={icon} /><h3>{title}</h3><p>{text}</p></div>; }

/** The chat sidebar reads the same owner-scoped agenda and opens the same
 * event page. It does not own a second scheduler or ask for technical logs. */
export function CompanionAgendaSummary({ companionId, request, api, active = true, onOpen }: { companionId: string; request: AgendaRequest; api?: Api; active?: boolean; onOpen(eventId?: string): void }) {
  const [day] = useState(() => agendaDayKey(Date.now()));
  const source = useAgendaData({ owner: companionId, day, view: 'upcoming', request, api, active });
  const entries = source.data ? agendaEntries(source.data, 'upcoming', agendaDayKey(source.data.observedAt)).filter(entry => entry.rule.category !== 'event').sort((a, b) => (a.run?.status === 'running' ? 0 : 1) - (b.run?.status === 'running' ? 0 : 1) || (a.at ?? '\uffff').localeCompare(b.at ?? '\uffff')).slice(0, 5) : [];
  return <section className="agenda-sidebar" aria-label="伙伴日程摘要"><header><h4>她的日程</h4><button onClick={() => onOpen()}>查看日程<Icon name="chevron" /></button></header>{!source.data ? <p className="agenda-sidebar-empty">{source.error || '正在读取实际安排…'}</p> : entries.length ? entries.map(entry => <button className="agenda-sidebar-entry" key={entry.key} onClick={() => onOpen(entry.rule.id)}>{entry.at ? <time dateTime={entry.at}>{agendaClock(entry.at)}</time> : <small>条件</small>}<span><strong>{agendaRuleTitle(entry.rule)}</strong><small>{agendaEntryStatus(entry)} · {agendaTriggerLabel(entry.rule)}</small></span></button>) : <p className="agenda-sidebar-empty">还没有接下来的安排，可以直接和伙伴商量。</p>}</section>;
}
