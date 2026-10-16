import { useEffect, useState } from 'react';
import type { CompanionActivityTask } from '../../shared/companion-activity-task';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { ScheduleRequest } from './companion-schedules';
import { Icon } from '../Icons';
const labels = { queued: '等待行动', running: '正在规划', waiting: '等待实际结果', succeeded: '已完成', failed: '受阻', cancelled: '已取消' };
export function CompanionActivityPanel({ companionId, conversationId, api, request }: { companionId: string; conversationId: string; api?: WorldlineBoxCompanionsApi; request: ScheduleRequest }) {
  const [tasks, setTasks] = useState<CompanionActivityTask[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true, serial = 0;
    const refresh = async () => { const epoch = ++serial; const result = await request({ type: 'activity.list', companionId, conversationId, limit: 20 }); if (alive && serial === epoch && result?.activityTasks) setTasks(result.activityTasks); };
    void refresh(); const off = api?.onChanged(() => { void refresh(); });
    return () => { alive = false; off?.(); };
  }, [companionId, conversationId, api, request]);
  if (!tasks.length) return null;
  return <section className="companions-activity-panel" aria-label="持续行动任务"><header><Icon name="activity" /><strong>行动任务</strong><small>等待结果后自动继续</small></header>
    {error && <p role="alert">{error}</p>}
    {tasks.slice(0, 8).map(task => <details key={task.id} data-activity-task={task.id}><summary><span>{task.title}</span><small data-status={task.status}>{labels[task.status]}</small></summary>
      <p>{task.stage}</p><small>第 {task.step} / 32 步 · {task.id}</small>
      <ol>{task.history.map(step => <li key={step.step}><strong>{step.action}</strong><span>{step.ok ? step.result : '失败：' + step.result}</span></li>)}</ol>
      {!['succeeded','failed','cancelled'].includes(task.status) && <button onClick={async () => { const response = await request({ type: 'activity.cancel', companionId, conversationId, id: task.id }); if (response?.activityTask) setTasks(rows => rows.map(row => row.id === task.id ? response.activityTask! : row)); else setError('取消未完成，请重试。'); }}>取消后续行动</button>}
    </details>)}
  </section>;
}
