import { useEffect, useState } from 'react';
import type { CompanionActivityTask } from '../../shared/companion-activity-task';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { ScheduleRequest } from './companion-schedules';
import { Icon } from '../Icons';
import { createCoalescedRefresh } from './coalesced-refresh';
import './companion-activity-panel.css';
const labels = { queued: '等待行动', running: '正在规划', waiting: '等待实际结果', succeeded: '已完成', failed: '受阻', cancelled: '已取消' };
export function CompanionActivityPanel({ companionId, conversationId, api, request, initialTaskId }: { companionId: string; conversationId: string; api?: WorldlineBoxCompanionsApi; request: ScheduleRequest; initialTaskId?: string }) {
  const [snapshot, setSnapshot] = useState<{ owner: string; room: string; tasks: CompanionActivityTask[] }>();
  const [failure, setFailure] = useState<{ owner: string; room: string; text: string }>();
  const error = failure?.owner === companionId && failure.room === conversationId ? failure.text : '';
  const tasks = snapshot?.owner === companionId && snapshot.room === conversationId ? snapshot.tasks : [];
  useEffect(() => {
    let alive = true, serial = 0;
    const refresh = async () => {
      const epoch = ++serial;
      try {
        const [result, located] = await Promise.all([request({ type: 'activity.list', companionId, conversationId, limit: 20 }), initialTaskId ? request({ type: 'activity.get', companionId, conversationId, id: initialTaskId }) : undefined]);
        if (!alive || serial !== epoch) return;
        if (result?.activityTasks) {
          const candidate = located?.activityTask;
          const target = candidate && candidate.id === initialTaskId && candidate.companionId === companionId && candidate.conversationId === conversationId ? candidate : undefined;
          setSnapshot({ owner: companionId, room: conversationId, tasks: [...(target ? [target] : []), ...result.activityTasks.filter(task => task.companionId === companionId && task.conversationId === conversationId && task.id !== target?.id)] });
          setFailure(initialTaskId && !target ? { owner: companionId, room: conversationId, text: '这项行动已变化或不再属于当前伙伴，无法定位。' } : undefined);
        }
      } catch { if (alive && serial === epoch) setFailure({ owner: companionId, room: conversationId, text: '行动记录暂时无法读取。' }); }
    };
    const reads = createCoalescedRefresh(refresh, undefined, 500);
    void reads.trigger(); const off = api?.onChanged(() => reads.trigger());
    return () => { alive = false; off?.(); reads.dispose(); };
  }, [companionId, conversationId, api, request, initialTaskId]);
  if (!tasks.length && !initialTaskId) return null;
  const active = tasks.filter(task => ['queued', 'running', 'waiting'].includes(task.status));
  const located = tasks.find(task => task.id === initialTaskId);
  const ordered = [...(located ? [located] : []), ...active.filter(task => task !== located), ...tasks.filter(task => !active.includes(task) && task !== located)].slice(0, 8);
  return <section className="companions-activity-panel" aria-label="持续行动任务"><header><span className="companions-activity-heading"><Icon name="activity" /><strong>行动任务</strong></span><small>{active.length ? active.some(task => task.status === 'running') ? `${active.length} 项进行中` : active.some(task => task.status === 'waiting') ? '等待实际结果' : '等待开始' : '最近的行动记录'}</small></header>
    {error && <p role="alert">{error}</p>}
    {ordered.map(task => <details key={task.id} open={task.id === initialTaskId ? true : undefined} data-activity-task={task.id}><summary><span>{task.title}</span><small data-status={task.status}>{task.status === 'waiting' && task.wait ? task.wait.kind === 'permission' ? '等待房主许可' : task.wait.kind === 'reply' ? '等待对方回复' : task.wait.kind === 'arrival' ? '正在前往目的地' : '稍候继续' : labels[task.status]}</small><Icon name="chevron" /></summary>
      <div className="companions-activity-detail"><p>{task.stage}</p><small>第 {task.step} / 32 步 · <time dateTime={task.updatedAt} title={task.updatedAt}>{new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></small>
      <ol>{task.history.map(step => <li key={step.step}><strong>{step.action}</strong><span>{step.ok ? step.result : '失败：' + step.result}</span></li>)}</ol>
      {!['succeeded','failed','cancelled'].includes(task.status) && <button onClick={async () => {
        const response = await request({ type: 'activity.cancel', companionId, conversationId, id: task.id });
        if (response?.activityTask?.companionId === companionId && response.activityTask.conversationId === conversationId) setSnapshot(current => current?.owner === companionId && current.room === conversationId ? { ...current, tasks: current.tasks.map(row => row.id === task.id ? response.activityTask! : row) } : current);
        else setFailure({ owner: companionId, room: conversationId, text: '取消未完成，请重试。' });
      }}>取消后续行动</button>}</div>
    </details>)}
  </section>;
}
