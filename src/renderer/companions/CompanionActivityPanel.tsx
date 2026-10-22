import { useEffect, useState } from 'react';
import type { CompanionActivityTask } from '../../shared/companion-activity-task';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { ScheduleRequest } from './companion-schedules';
import { Icon } from '../Icons';
import { createCoalescedRefresh } from './coalesced-refresh';
import './companion-activity-panel.css';
const labels = { queued: '等待行动', running: '正在规划', waiting: '等待实际结果', succeeded: '已完成', failed: '受阻', cancelled: '已取消' };
export function CompanionActivityPanel({ companionId, conversationId, api, request }: { companionId: string; conversationId: string; api?: WorldlineBoxCompanionsApi; request: ScheduleRequest }) {
  const [snapshot, setSnapshot] = useState<{ owner: string; room: string; tasks: CompanionActivityTask[] }>();
  const [error, setError] = useState('');
  const tasks = snapshot?.owner === companionId && snapshot.room === conversationId ? snapshot.tasks : [];
  useEffect(() => {
    let alive = true, serial = 0;
    const refresh = async () => {
      const epoch = ++serial;
      try {
        const result = await request({ type: 'activity.list', companionId, conversationId, limit: 20 });
        if (!alive || serial !== epoch) return;
        if (result?.activityTasks) { setSnapshot({ owner: companionId, room: conversationId, tasks: result.activityTasks.filter(task => task.companionId === companionId && task.conversationId === conversationId) }); setError(''); }
      } catch { if (alive && serial === epoch) setError('行动记录暂时无法读取。'); }
    };
    const reads = createCoalescedRefresh(refresh, undefined, 500);
    void reads.trigger(); const off = api?.onChanged(() => reads.trigger());
    return () => { alive = false; off?.(); reads.dispose(); };
  }, [companionId, conversationId, api, request]);
  if (!tasks.length) return null;
  const active = tasks.filter(task => ['queued', 'running', 'waiting'].includes(task.status));
  const ordered = [...active, ...tasks.filter(task => !active.includes(task))].slice(0, 8);
  return <section className="companions-activity-panel" aria-label="持续行动任务"><header><span className="companions-activity-heading"><Icon name="activity" /><strong>行动任务</strong></span><small>{active.length ? active.some(task => task.status === 'running') ? `${active.length} 项进行中` : active.some(task => task.status === 'waiting') ? '等待实际结果' : '等待开始' : '最近的行动记录'}</small></header>
    {error && <p role="alert">{error}</p>}
    {ordered.map(task => <details key={task.id} data-activity-task={task.id}><summary><span>{task.title}</span><small data-status={task.status}>{task.status === 'waiting' && task.wait ? task.wait.kind === 'permission' ? '等待房主许可' : task.wait.kind === 'reply' ? '等待对方回复' : task.wait.kind === 'arrival' ? '正在前往目的地' : '稍候继续' : labels[task.status]}</small><Icon name="chevron" /></summary>
      <div className="companions-activity-detail"><p>{task.stage}</p><small>第 {task.step} / 32 步 · <time dateTime={task.updatedAt} title={task.updatedAt}>{new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></small>
      <ol>{task.history.map(step => <li key={step.step}><strong>{step.action}</strong><span>{step.ok ? step.result : '失败：' + step.result}</span></li>)}</ol>
      {!['succeeded','failed','cancelled'].includes(task.status) && <button onClick={async () => {
        const response = await request({ type: 'activity.cancel', companionId, conversationId, id: task.id });
        if (response?.activityTask?.companionId === companionId && response.activityTask.conversationId === conversationId) setSnapshot(current => current?.owner === companionId && current.room === conversationId ? { ...current, tasks: current.tasks.map(row => row.id === task.id ? response.activityTask! : row) } : current);
        else setError('取消未完成，请重试。');
      }}>取消后续行动</button>}</div>
    </details>)}
  </section>;
}
