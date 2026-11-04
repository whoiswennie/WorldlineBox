import { useEffect, useState } from 'react';
import type { BotTask } from '../../shared/companion-bot';
import { BotIcon } from './BotIcon';
import { botTaskActive, botTaskActivity, botTaskPhase, botTaskTool, botTaskState, botTaskStopping, botTaskPausing, botTaskHint } from './task-presentation';
import { formatBotReplyDuration } from './BotReplyTiming';

export function BotTaskActivity({ task, locale, busy, onInspect, onRetryStop, onRetryPause, onRecords }: { task: BotTask; locale: 'zh-CN' | 'en'; busy?: boolean; onInspect?(): void; onRetryStop?(): void; onRetryPause?(): void; onRecords?(): void }) {
  const [now, setNow] = useState(Date.now), active = botTaskActive(task), zh = locale === 'zh-CN', stopping = botTaskStopping(task), pausing = botTaskPausing(task);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, task.id]);
  const start = task.createdAt ? Date.parse(task.createdAt) : NaN;
  const updated = task.updatedAt ? Date.parse(task.updatedAt) : NaN;
  const elapsed = Number.isFinite(start) ? Math.max(0, (active ? now : updated) - start) : NaN;
  const stopAt = task.stopRequestedAt ? Date.parse(task.stopRequestedAt) : NaN;
  const stopElapsed = Number.isFinite(stopAt) ? Math.max(0, now - stopAt) : NaN;
  const pauseAt = task.pauseRequestedAt ? Date.parse(task.pauseRequestedAt) : NaN, pauseElapsed = Number.isFinite(pauseAt) ? Math.max(0, now - pauseAt) : NaN;
  const age = Math.max(0, Math.floor((now - Date.parse(task.progress?.updatedAt ?? task.updatedAt ?? '')) / 1000));
  const unconfirmed = ['stop-unconfirmed', 'stop-request-unknown'].includes(task.progress?.phase ?? ''), slowStop = unconfirmed || stopping && Number.isFinite(stopElapsed) && stopElapsed >= 30000;
  const slowPause = pausing && (['pause-unconfirmed', 'pause-request-unknown'].includes(task.progress?.phase ?? '') || Number.isFinite(pauseElapsed) && pauseElapsed >= 30000);
  return <section className="bot-task-activity" data-task-phase={stopping ? task.progress?.phase === 'stop-unconfirmed' ? 'stop-unconfirmed' : 'stopping' : task.progress?.phase ?? task.status} data-state={botTaskState(task)}>
    <div className="bot-task-activity-current"><span className="bot-task-state-icon"><BotIcon name={task.status === 'succeeded' ? 'tasks' : 'clock'} /></span><div><span className="bot-task-eyebrow">{zh ? '当前状态' : 'Current activity'}</span><strong role="status">{botTaskActivity(task, locale)}</strong></div></div>
    <p>{botTaskHint(task, locale)}</p>
    <div className="bot-task-metrics">{Number.isFinite(elapsed) && <span><span>{zh ? '任务用时' : 'Elapsed'}</span><b aria-live="off">{formatBotReplyDuration(elapsed, locale)}</b></span>}
      {stopping && Number.isFinite(stopAt) ? <span><span>{zh ? '等待停止确认' : 'Awaiting stop acknowledgement'}</span><b aria-live="off">{formatBotReplyDuration(stopElapsed, locale)}</b></span>
        : pausing && Number.isFinite(pauseAt) ? <span><span>{zh ? '等待暂停确认' : 'Awaiting pause acknowledgement'}</span><b aria-live="off">{formatBotReplyDuration(pauseElapsed, locale)}</b></span>
        : active && Number.isFinite(age) && age >= 30 ? <span><span>{zh ? '距最近反馈' : 'Last update'}</span><b aria-live="off">{formatBotReplyDuration(age * 1000, locale)}</b></span> : null}
    </div>
    {slowStop && <div className="bot-task-stop-help"><p>{zh ? '暂时没有收到停止确认。已有记录仍在，可以核对当前状态或重新连接以确认停止。' : 'A stop acknowledgement has not arrived. Existing records are preserved; check the current state or reconnect to confirm stopping.'}</p><div>{onInspect && <button disabled={busy} onClick={onInspect}>{zh ? '核对当前状态' : 'Check status'}</button>}{onRetryStop && <button disabled={busy} onClick={onRetryStop}>{zh ? '重新核实停止' : 'Recheck stop'}</button>}{onRecords && <button disabled={busy} onClick={onRecords}>{zh ? '查看原因' : 'View details'}</button>}</div></div>}
    {slowPause && <div className="bot-task-stop-help"><p>{zh ? '尚未确认暂停，执行器可能仍在运行。核实前不会显示为可恢复的暂停。' : 'Pausing is not yet confirmed; the executor may still be running. Resuming is offered only after a confirmed pause.'}</p><div>{onInspect && <button disabled={busy} onClick={onInspect}>{zh ? '核对当前状态' : 'Check status'}</button>}{onRetryPause && <button disabled={busy} onClick={onRetryPause}>{zh ? '重新核实暂停' : 'Recheck pause'}</button>}{onRecords && <button disabled={busy} onClick={onRecords}>{zh ? '查看原因' : 'View details'}</button>}</div></div>}
  </section>;
}

export function BotTaskEvents({ task, locale }: { task: BotTask; locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN', activity = task.activity?.slice(-40) ?? [];
  const stages: Record<string, [string, string]> = { host: ['连接共享实例', 'Shared instance'], attach: ['接入原会话', 'Original session'], cancel: ['确认停止', 'Stop acknowledgement'], pause: ['确认暂停', 'Pause acknowledgement'], turn: ['提交执行请求', 'Execution request'], stream: ['接收执行事件', 'Execution events'] };
  return <div className="bot-task-records">
    {task.diagnostic && <section className="bot-task-diagnostic"><header><h5>{zh ? '最近的连接诊断' : 'Latest connection diagnostic'}</h5><span>{zh ? `已尝试 ${task.diagnostic.attempts} 次` : `${task.diagnostic.attempts} attempts`}</span></header><p>{stages[task.diagnostic.stage ?? '']?.[zh ? 0 : 1] ?? (zh ? '执行器连接' : 'Executor connection')}</p><pre>{task.diagnostic.message}</pre></section>}
    <section className="bot-task-event-section"><header><h5>{zh ? '执行记录' : 'Execution activity'}</h5><span>{zh ? `最近 ${activity.length} 条` : `${activity.length} recent events`}</span></header>{activity.length ? <ol className="bot-task-event-list">{activity.map(entry => <li key={entry.id}><span className="bot-task-event-mark" /><div><strong>{botTaskPhase(entry.phase, locale)}</strong>{botTaskTool(entry.toolName) && <span>{entry.toolName}</span>}</div><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></li>)}</ol> : <div className="bot-task-records-empty"><BotIcon name="history" /><p>{zh ? '还没有执行反馈' : 'No executor events yet'}</p><span>{zh ? '连接、工具调用和结果返回后，实际记录会显示在这里。' : 'Connection, tool and outcome events will appear here when received.'}</span></div>}</section>
  </div>;
}
