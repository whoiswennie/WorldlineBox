import { useCallback, useEffect, useRef, useState } from 'react';
import type { Companion, CompanionAction, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionRuntimeState } from '../../shared/companion-state';
import { Avatar } from './CompanionVisuals';
import { Icon } from '../Icons';
import { localDateKey, scheduleStatus, scheduleTime, useCompanionSchedules, type ScheduleRequest } from './companion-schedules';
import { routineAgenda, routineClock, useCompanionRoutine } from './companion-routines';

const MOODS: Record<CompanionRuntimeState['mood'], string> = { calm: '平静', bright: '心情明亮', focused: '专注', tired: '有点疲惫', low: '情绪低落' };
const EXPRESSIONS: Record<CompanionRuntimeState['expression'], string> = { gentle: '温柔', direct: '直率', playful: '轻快', reserved: '安静' };
const RELATIONSHIPS: Record<CompanionRuntimeState['familiarity']['stage'], string> = { new: '初次相识', acquainted: '渐渐熟悉', close: '彼此亲近' };
const ACTIONS: Record<CompanionAction['status'], string> = { queued: '等待处理', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };

export function CompanionPlanner({ companion, members, conversationId, conversationKind = 'private', actions, request, api, onOwnerChange, onClose, onProfile, onMemory, onTasks, onSchedules, onOpenAction, onWorld }: {
  readonly companion: Companion; readonly members: Companion[]; readonly conversationId: string; readonly conversationKind?: 'private' | 'group'; readonly actions: CompanionAction[];
  readonly request: ScheduleRequest; readonly api?: WorldlineBoxCompanionsApi; readonly onOwnerChange: (id: string) => void;
  readonly onClose: () => void; readonly onProfile: () => void; readonly onMemory: () => void; readonly onTasks: () => void; readonly onSchedules: () => void; readonly onOpenAction: (id: string) => void;
  readonly onWorld?: () => void;
}) {
  const { schedules, occurrences, loading, error, refresh } = useCompanionSchedules(companion.id, conversationId, request, api);
  const { routine } = useCompanionRoutine(companion.id, conversationId, request, api);
  const [runtime, setRuntime] = useState<CompanionRuntimeState>();
  const [stateDetails, setStateDetails] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [selectedDay, setSelectedDay] = useState<string>();
  const [weekOffset, setWeekOffset] = useState(0);
  const epoch = useRef(0);
  const loadState = useCallback(async () => { const current = ++epoch.current; const result = await request({ type: 'state.get', companionId: companion.id, conversationId }); if (current === epoch.current && result?.runtimeState) setRuntime(result.runtimeState); }, [request, companion.id, conversationId]);
  useEffect(() => { const currentEpoch = epoch; void Promise.resolve().then(loadState); const timer = setInterval(() => setNow(Date.now()), 60_000); return () => { clearInterval(timer); currentEpoch.current++; }; }, [loadState]);
  useEffect(() => { let timer: ReturnType<typeof setTimeout> | undefined; const unsubscribe = api?.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => void loadState(), 200); }); return () => { unsubscribe?.(); clearTimeout(timer); }; }, [api, loadState]);
  const today = new Date(now), start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (start.getDay() + 6) % 7 + weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(day.getDate() + index); return day; });
  const upcoming = schedules.filter(schedule => schedule.status === 'active' && scheduleStatus(schedule) !== '已完成').sort((a, b) => (a.deferredUntil ?? a.nextRunAt ?? a.runAt).localeCompare(b.deferredUntil ?? b.nextRunAt ?? b.runAt));
  const visible = selectedDay ? upcoming.filter(schedule => localDateKey(schedule.deferredUntil ?? schedule.nextRunAt ?? schedule.runAt) === selectedDay) : upcoming;
  const currentActions = actions.filter(action => action.companionId === companion.id && ['queued', 'running'].includes(action.status));
  const completed = occurrences.filter(occurrence => occurrence.status === 'done').slice(0, 2);
  const focus = runtime?.focus || currentActions[0]?.title;
  const rhythm = routine && conversationKind === 'private' ? routineAgenda(routine, selectedDay ? new Date(selectedDay + 'T12:00:00') : today).filter(item => selectedDay && selectedDay !== localDateKey(now) || item.at >= routineClock(today, routine.config.timeZone).clock).slice(0, 2) : [];
  return <aside className="companions-relationship-panel companions-planner" aria-label="伙伴手帐">
    <header><div><span>COMPANION JOURNAL</span><h3>今天的小安排</h3></div><button className="companion-icon-button" aria-label="收起我们之间" onClick={onClose}>×</button></header>
    <div className="companions-planner-identity"><Avatar companion={companion} /><div><strong>{companion.name}</strong>{members.length > 1 ? <select aria-label="待办所属伙伴" value={companion.id} onChange={event => onOwnerChange(event.target.value)}>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select> : <span>{runtime ? RELATIONSHIPS[runtime.familiarity.stage] : '读取当前状态…'}</span>}</div><button className="companion-icon-button" aria-label="查看伙伴资料" onClick={onProfile}><Icon name="users" /></button></div>
    <div className="companions-planner-state" data-mood={runtime?.mood ?? 'loading'}>
      <button className="companions-planner-state-chips" aria-label="查看当前伙伴状态详情" aria-expanded={stateDetails} onClick={() => setStateDetails(value => !value)}>{runtime ? <><span>{MOODS[runtime.mood]}</span><span>{EXPRESSIONS[runtime.expression]}</span><span>好感 {Math.round(runtime.relationship.affinity)}</span></> : <span>正在了解当前状态…</span>}<Icon name="chevron" /></button>
      <div className="companions-planner-energy"><span>精力</span><div role="progressbar" aria-label="伙伴精力" aria-valuemin={0} aria-valuemax={100} aria-valuenow={runtime?.energy}><i style={{ width: runtime ? runtime.energy + '%' : '0%' }} /></div><small>{runtime ? Math.round(runtime.energy) + '%' : '…'}</small></div>
      <p className="companions-planner-focus"><i />{focus ? '正在关注 · ' + focus : runtime ? '当下闲暇，等你来聊聊' : '正在读取当前关注'}</p>
      {routine && <button className="companions-planner-routine-current" onClick={onSchedules}><Icon name="clock" /><span>{routine.runtime.activity ?? (routine.runtime.phase === 'sleeping' ? '正在睡觉' : routine.runtime.phase === 'awake' ? '清醒的日常' : '正在休息')}</span><small>{routine.runtime.canRespond ? '可以交流' : '休息后回复'}</small></button>}
      {stateDetails && <div className="companions-planner-state-detail" role="dialog" aria-label="伙伴当前状态"><header><strong>当前状态</strong><button aria-label="关闭当前状态详情" onClick={() => setStateDetails(false)}>×</button></header>{runtime?.reason ? <p>{runtime.reason}</p> : <p>状态会随实际交流、共同经历和执行任务更新。</p>}{runtime && <small>{runtime.familiarity.interactionCount} 次交流 · {runtime.familiarity.sharedEventCount} 次共同经历</small>}{runtime && <div className="companions-planner-state-measures"><p>情绪维度</p>{([['pleasure', '愉悦'], ['arousal', '活跃'], ['dominance', '自主']] as const).map(([key, label]) => <div key={key}><span>{label}</span><meter min={-1} max={1} value={runtime.affect[key]} /><small>{runtime.affect[key].toFixed(2)}</small></div>)}<p>相处状态</p>{([['affinity', '好感'], ['trust', '信任'], ['respect', '尊重']] as const).map(([key, label]) => <div key={key}><span>{label}</span><meter min={0} max={100} value={runtime.relationship[key]} /><small>{Math.round(runtime.relationship[key])}</small></div>)}</div>}<p>这些状态由真实交流与任务经历计算，影响当前表达与可调整安排。固定时间的承诺仍照时执行。</p><button onClick={onProfile}>查看完整角色设定</button></div>}
    </div>
    {onWorld && <button className="companions-world-entry" aria-label="看看伙伴的小屋" onClick={onWorld}><Icon name="globe" /><span><strong>去她的小屋看看</strong><small>窗外的天气，和她此刻的生活</small></span><Icon name="chevron" /></button>}
    <section className="companions-planner-calendar" aria-label="伙伴周历"><div className="companions-planner-date"><span><strong>{today.getDate()}</strong><small>{today.toLocaleDateString('zh-CN', { month: 'long' })}<br />{today.toLocaleDateString('zh-CN', { weekday: 'long' })}</small></span><div><button aria-label="上一周" onClick={() => setWeekOffset(value => value - 1)}><Icon name="chevron-left" /></button><button aria-label="下一周" onClick={() => setWeekOffset(value => value + 1)}><Icon name="chevron-right" /></button></div></div><div className="companions-planner-week">{days.map(day => { const key = localDateKey(day.getTime()), hasPlan = upcoming.some(schedule => localDateKey(schedule.deferredUntil ?? schedule.nextRunAt ?? schedule.runAt) === key); return <button key={key} aria-label={'查看 ' + day.toLocaleDateString('zh-CN') + ' 的安排'} aria-pressed={selectedDay === key} className={(key === localDateKey(now) ? 'is-today ' : '') + (selectedDay === key ? 'is-selected' : '')} onClick={() => setSelectedDay(current => current === key ? undefined : key)}><small>{day.toLocaleDateString('zh-CN', { weekday: 'narrow' })}</small><strong>{day.getDate()}</strong><i className={hasPlan ? 'has-plan' : ''} /></button>; })}</div></section>
    <section className="companions-planner-agenda"><div className="companions-planner-section-title"><h4>{selectedDay ? '这一天的便签' : '接下来的便签'}</h4><button aria-label="管理伙伴日程" onClick={onSchedules}><Icon name="plus" /></button></div>
      {!!rhythm.length && <div className="companions-planner-rhythm" aria-label="今日作息"><header>生活的小节奏 <span>{routine!.config.timeZone === 'system' ? '本地时间' : routine!.config.timeZone}</span></header>{rhythm.map(item => <button key={item.id} onClick={onSchedules}><time>{item.at}</time><i /><span>{item.title}</span></button>)}</div>}
      {error ? <p className="companions-memory-error">{error}<button onClick={() => void refresh()}>刷新</button></p> : loading ? <p className="companions-subtle">正在读取安排…</p> : !visible.length && !currentActions.length ? <div className="companions-planner-empty-note"><span className="companions-note-tape" aria-hidden="true" /><Icon name="clipboard" /><p>{selectedDay ? '这一天，先留一些空白' : '下一件小事，等你来安排'}</p><button onClick={onSchedules}>写一张便签</button></div> : null}
      {currentActions.slice(0, 1).map(action => <button className="companions-todo-note is-working" key={action.id} onClick={() => onOpenAction(action.id)}><span className="companions-todo-note-top"><span><i />{ACTIONS[action.status]}</span><Icon name="activity" /></span><strong>{action.title}</strong><small>点击查看正在进行的任务</small></button>)}
      {visible.slice(0, 3).map((schedule, index) => <button className={'companions-todo-note tone-' + index % 3} key={schedule.id} data-schedule-note={schedule.id} onClick={onSchedules}><span className="companions-todo-note-top"><span><Icon name={schedule.kind === 'task' ? 'clipboard' : 'clock'} />{schedule.kind === 'task' ? '任务' : '提醒'}</span><small>{scheduleStatus(schedule)}</small></span><strong>{schedule.title}</strong><time dateTime={schedule.deferredUntil ?? schedule.nextRunAt ?? schedule.runAt}>{scheduleTime(schedule.deferredUntil ?? schedule.nextRunAt ?? schedule.runAt)}</time>{schedule.blockedReason && <small>{schedule.blockedReason === 'resting' ? '伙伴正在休息，稍后处理' : '等待模型连接恢复'}</small>}</button>)}
      {visible.length > 3 && <button className="companions-planner-more" onClick={onSchedules}>还有 {visible.length - 3} 张便签，查看全部</button>}
      {!!completed.length && <details className="companions-planner-completed"><summary><Icon name="check" />最近完成 · {completed.length}</summary>{completed.map(occurrence => <button key={occurrence.id} onClick={onSchedules}><Icon name="check" /><span>{schedules.find(schedule => schedule.id === occurrence.scheduleId)?.title || '已完成的安排'}</span><small>{scheduleTime(occurrence.finishedAt ?? occurrence.scheduledAt)}</small></button>)}</details>}
    </section>
    <div className="companions-planner-links"><button onClick={onMemory} aria-label="管理共同记忆"><Icon name="archive" /><span>共同记忆<small>查看来处与相处的细节</small></span><Icon name="chevron" /></button><button onClick={onTasks} aria-label="查看任务历史"><Icon name="activity" /><span>任务记录<small>展开执行过程与成果</small></span><Icon name="chevron" /></button></div>
  </aside>;
}
