import { useEffect, useState } from 'react';
import type { BotTask } from '../../shared/companion-bot';
import { botTaskElapsedMs } from '../../shared/companion-bot-task-clock';
import { BotIcon } from './BotIcon';
import { botTaskActivity, botTaskPhase, botTaskTool, botTaskState, botTaskTimerRunning, botTaskHint } from './task-presentation';
import { formatBotReplyDuration } from './BotReplyTiming';

export function BotTaskActivity({ task, locale }: { task: BotTask; locale: 'zh-CN' | 'en' }) {
  const [now, setNow] = useState(Date.now), ticking = botTaskTimerRunning(task), zh = locale === 'zh-CN';
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking, task.id]);
  const elapsed = botTaskElapsedMs(task, now);
  const age = Math.max(0, Math.floor((now - Date.parse(task.progress?.updatedAt ?? task.updatedAt ?? '')) / 1000));
  const state = botTaskState(task);
  return <section className="bot-task-activity" data-task-phase={['cancelled', 'paused'].includes(state) ? state : task.progress?.phase ?? state} data-state={state}>
    <div className="bot-task-activity-current"><span className="bot-task-state-icon"><BotIcon name={state === 'succeeded' ? 'tasks' : 'clock'} /></span><div><span className="bot-task-eyebrow">{zh ? '当前状态' : 'Current activity'}</span><strong role="status">{botTaskActivity(task, locale)}</strong></div></div>
    <p>{botTaskHint(task, locale)}</p>
    <div className="bot-task-metrics">{Number.isFinite(elapsed) && <span><span>{zh ? '执行用时' : 'Execution time'}</span><b aria-live="off">{formatBotReplyDuration(elapsed, locale)}</b></span>}
      {ticking && Number.isFinite(age) && age >= 30 && <span><span>{zh ? '距最近反馈' : 'Last update'}</span><b aria-live="off">{formatBotReplyDuration(age * 1000, locale)}</b></span>}
    </div>
  </section>;
}

export function BotTaskEvents({ task, locale }: { task: BotTask; locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN', activity = task.activity?.slice(-40) ?? [];
  const stages: Record<string, [string, string]> = { host: ['连接共享实例', 'Shared instance'], attach: ['接入原会话', 'Original session'], cancel: ['停止任务', 'Stop task'], pause: ['暂停任务', 'Pause task'], turn: ['提交执行请求', 'Execution request'], stream: ['接收执行事件', 'Execution events'] };
  return <div className="bot-task-records">
    {task.diagnostic && <section className="bot-task-diagnostic"><header><h5>{zh ? '最近的连接诊断' : 'Latest connection diagnostic'}</h5><span>{zh ? `已尝试 ${task.diagnostic.attempts} 次` : `${task.diagnostic.attempts} attempts`}</span></header><p>{stages[task.diagnostic.stage ?? '']?.[zh ? 0 : 1] ?? (zh ? '执行器连接' : 'Executor connection')}</p><pre>{task.diagnostic.message}</pre></section>}
    <section className="bot-task-event-section"><header><h5>{zh ? '执行记录' : 'Execution activity'}</h5><span>{zh ? `最近 ${activity.length} 条` : `${activity.length} recent events`}</span></header>{activity.length ? <ol className="bot-task-event-list">{activity.map(entry => <li key={entry.id}><span className="bot-task-event-mark" /><div><strong>{botTaskPhase(entry.phase, locale)}</strong>{botTaskTool(entry.toolName) && <span>{entry.toolName}</span>}</div><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></li>)}</ol> : <div className="bot-task-records-empty"><BotIcon name="history" /><p>{zh ? '还没有执行反馈' : 'No executor events yet'}</p><span>{zh ? '连接、工具调用和结果返回后，实际记录会显示在这里。' : 'Connection, tool and outcome events will appear here when received.'}</span></div>}</section>
  </div>;
}
