import type { CompanionMemoryProcessingJob } from '../../shared/companion-memory-processing';
import type { CompanionTaskItem } from '../../shared/companion-task-overview';

/** Runtime monthly work joins the same cursor before paging. */
export function companionTimelineTasks(owner: string, jobs: readonly CompanionMemoryProcessingJob[]): CompanionTaskItem[] {
  return jobs.map(job => {
    const terminal = ['completed', 'cancelled', 'stale', 'failed'].includes(job.status);
    return { id: job.id, kind: 'memory_timeline', companionId: owner, title: job.title ?? '时间线整理',
      status: job.status === 'running' ? 'running' : job.status === 'pending' ? 'queued' : job.status === 'waiting_model' ? 'waiting'
        : job.status === 'stale' ? 'completed' : job.status,
      rawStatus: job.status, stage: job.stage, updatedAt: job.updatedAt ?? job.createdAt ?? '',
      ...(job.createdAt ? { createdAt: job.createdAt } : {}), ...(terminal && job.updatedAt ? { finishedAt: job.updatedAt } : {}),
      ...(job.conversationId ? { conversationId: job.conversationId } : {}), canStop: false, stoppedByUser: false,
      stopReason: '时间线属于记忆后台维护，当前仅展示实际处理进度。' };
  });
}
