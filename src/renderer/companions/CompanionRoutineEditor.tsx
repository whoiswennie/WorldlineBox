import { useState } from 'react';
import { companionRoutineConfigSchema, type CompanionRoutineConfig } from '../../shared/companion-routine';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import { Icon } from '../Icons';
import { useCompanionRoutine } from './companion-routines';
import type { ScheduleRequest } from './companion-schedules';

const KINDS = { rest: '休息', exercise: '运动', study: '学习', leisure: '兴趣', custom: '自定义' } as const;
const DAYS = ['日', '一', '二', '三', '四', '五', '六'];
export function CompanionRoutineEditor({ companionId, conversationId, request, api, readOnly = false }: { readonly companionId: string; readonly conversationId: string; readonly request: ScheduleRequest; readonly api?: WorldlineBoxCompanionsApi; readonly readOnly?: boolean }) {
  const { routine, error: readError, refresh } = useCompanionRoutine(companionId, conversationId, request, api);
  const [editing, setEditing] = useState<{ config: CompanionRoutineConfig; revision: number }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const config = editing?.config ?? routine?.config;
  function change(patch: Partial<CompanionRoutineConfig>) { if (!routine) return; setEditing(current => ({ revision: current?.revision ?? routine.revision, config: { ...(current?.config ?? routine.config), ...patch } })); }
  async function save() {
    if (!editing) return;
    const parsed = companionRoutineConfigSchema.safeParse(editing.config);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '请检查作息内容。'); return; }
    setBusy(true); setError('');
    const response = await request({ type: 'routine.configure', companionId, conversationId, expectedRevision: editing.revision, patch: parsed.data });
    setBusy(false);
    if (!response?.ok) { setError('作息未保存。请刷新最新设定后重新修改。'); return; }
    setEditing(undefined); await refresh();
  }
  return <div className="companions-routine-workspace"><div className="companions-routine-settings">
    <header><div><h3>给生活留一点节奏</h3><p>睡眠、吃饭、休息，以及属于她的小习惯</p></div><span>{routine ? '设定修订 ' + routine.revision : '正在读取…'}</span></header>
    {(readError || error) && <p role="alert" className="companions-memory-error">{error || readError}<button onClick={() => { setEditing(undefined); setError(''); void refresh(); }}>刷新作息</button></p>}
    {readOnly ? <div className="companions-routine-readonly"><Icon name="clock" /><h4>每位伙伴都有自己的生活节奏</h4><p>在伙伴私聊中调整作息与习惯。群聊仅显示允许公开的当前状态。</p>{routine && <p>{routine.runtime.canRespond ? '当前可以交流' : '正在休息，会在结束后处理普通消息。'}</p>}</div> : config && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <section><h4><Icon name="clock" />睡眠与时区</h4><div className="companions-routine-clock-fields"><label>睡觉时间<input type="time" required aria-label="伙伴睡觉时间" value={config.sleepAt} onChange={event => change({ sleepAt: event.target.value })} /></label><label>醒来时间<input type="time" required aria-label="伙伴醒来时间" value={config.wakeAt} onChange={event => change({ wakeAt: event.target.value })} /></label><label>作息时区<input aria-label="伙伴作息时区" required value={config.timeZone} placeholder="system 或 Asia/Shanghai" onChange={event => change({ timeZone: event.target.value })} /></label></div></section>
      <section><div className="companions-routine-section-heading"><h4><Icon name="clock" />吃饭的小约定</h4><button type="button" onClick={() => change({ meals: [...config.meals, { name: '用餐', at: '18:00', durationMinutes: 30 }] })} disabled={config.meals.length >= 8}><Icon name="plus" />添加用餐</button></div>
        {config.meals.map((meal, index) => <div className="companions-routine-meal" key={index}><input aria-label={'第 ' + (index + 1) + ' 次用餐名称'} required maxLength={60} value={meal.name} onChange={event => change({ meals: config.meals.map((item, row) => row === index ? { ...item, name: event.target.value } : item) })} /><input aria-label={'第 ' + (index + 1) + ' 次用餐时间'} type="time" required value={meal.at} onChange={event => change({ meals: config.meals.map((item, row) => row === index ? { ...item, at: event.target.value } : item) })} /><label><input aria-label={'第 ' + (index + 1) + ' 次用餐分钟'} type="number" min={1} max={180} required value={meal.durationMinutes} onChange={event => change({ meals: config.meals.map((item, row) => row === index ? { ...item, durationMinutes: Number(event.target.value) } : item) })} /><span>分钟</span></label><button type="button" aria-label={'移除第 ' + (index + 1) + ' 次用餐'} onClick={() => change({ meals: config.meals.filter((_, row) => row !== index) })}>×</button></div>)}
        {!config.meals.length && <p className="companions-subtle">还没有用餐安排，可以从一顿早餐开始。</p>}
      </section>
      <section><div className="companions-routine-section-heading"><h4><Icon name="star" />慢慢养成的习惯</h4><button type="button" disabled={config.habits.length >= 20} onClick={() => change({ habits: [...config.habits, { id: crypto.randomUUID(), title: '', at: '17:00', durationMinutes: 20, kind: 'leisure' }] })}><Icon name="plus" />添加习惯</button></div>
        {config.habits.map((habit, index) => { const update = (patch: Partial<typeof habit>) => change({ habits: config.habits.map((item, row) => row === index ? { ...item, ...patch } : item) }); const progress = routine?.habitProgress.find(item => item.id === habit.id); return <article className="companions-routine-habit" key={habit.id}><div><input aria-label={'习惯 ' + (index + 1) + ' 名称'} required maxLength={120} value={habit.title} onChange={event => update({ title: event.target.value })} placeholder="例如：黄昏散步、睡前读书" /><button type="button" aria-label={'移除习惯 ' + (index + 1)} onClick={() => change({ habits: config.habits.filter((_, row) => row !== index) })}>×</button></div><div className="companions-routine-habit-fields"><label>类型<select aria-label={'习惯 ' + (index + 1) + ' 类型'} value={habit.kind} onChange={event => update({ kind: event.target.value as typeof habit.kind })}>{Object.entries(KINDS).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label><label>时间<input type="time" required aria-label={'习惯 ' + (index + 1) + ' 时间'} value={habit.at} onChange={event => update({ at: event.target.value })} /></label><label>时长<input type="number" required min={1} max={240} aria-label={'习惯 ' + (index + 1) + ' 分钟'} value={habit.durationMinutes} onChange={event => update({ durationMinutes: Number(event.target.value) })} /></label></div><fieldset className="companions-schedule-weekdays"><legend>每周的哪几天</legend>{DAYS.map((day, dayIndex) => <label key={day}><input type="checkbox" aria-label={'习惯 ' + (index + 1) + ' 星期' + day} checked={!habit.weekDays || habit.weekDays.includes(dayIndex)} onChange={event => update({ weekDays: event.target.checked ? [...new Set([...(habit.weekDays ?? [0, 1, 2, 3, 4, 5, 6]), dayIndex])].sort() : (habit.weekDays ?? [0, 1, 2, 3, 4, 5, 6]).filter(value => value !== dayIndex) })} /><span>{day}</span></label>)}</fieldset>{progress ? <details className="companions-routine-progress"><summary>养成程度 {Math.round(progress.strength)}% · 连续 {progress.streak} 次</summary><p>已按虚拟作息完成 {progress.completedCount} 次。完成次数和连续性由经过的作息时间计算，不能手工修改。</p></details> : <small>保存后，随作息推进慢慢积累习惯。</small>}</article>; })}
        {!config.habits.length && <div className="companions-routine-empty"><Icon name="star" /><p>把性格中的兴趣，变成生活中的小习惯</p><small>例如喜欢阅读、午后休息，或每天练习绘画。</small></div>}
      </section>
      <footer><span>{editing ? '修改尚未保存' : '当前作息已保存'}</span><button type="button" className="companion-secondary-button" disabled={!editing || busy} onClick={() => { setEditing(undefined); setError(''); }}>撤回修改</button><button type="submit" className="companion-primary-button" disabled={!editing || busy}>{busy ? '正在保存…' : '保存作息与习惯'}</button></footer>
    </form>}
  </div><aside className="companions-routine-about"><span className="companions-note-tape" aria-hidden="true" /><Icon name="clock" /><h3>她也有自己的日常</h3><p>这是虚拟伙伴的作息。睡眠、用餐和习惯会按时钟推进，关闭应用后经过的时间也会计入。</p><p>作息会影响精力、表达和弹性安排；电脑上的实际任务需要应用运行，固定安排仍按承诺执行。</p><p>普通聊天可以等她醒来再回复。需要马上帮忙时，直接说「紧急」「先别睡」或「起床帮我」，可以打断休息。</p>{routine && <div className="companions-routine-live"><small>此刻</small><strong>{routine.runtime.activity ?? (routine.runtime.phase === 'sleeping' ? '正在睡觉' : routine.runtime.phase === 'awake' ? '正在清醒活动' : '正在休息')}</strong><span>{routine.runtime.canRespond ? '可以交流' : '会在休息结束后处理普通消息'}</span></div>}</aside></div>;
}
