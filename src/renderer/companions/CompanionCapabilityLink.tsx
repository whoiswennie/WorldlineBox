import type { CompanionAction } from '../../shared/companions';
import { Icon } from '../Icons';
import { elapsedTime } from './CompanionProgress';
import { companionCapabilityFeedback, companionCapabilityTitle } from './companion-capability-presentation';
import { companionDshPendingApproval } from '../../shared/companion-dsh-receipt';

const labels: Record<CompanionAction['status'], string> = {
  queued: '等待中', running: '进行中', succeeded: '已返回', failed: '失败', cancelled: '已停止', interrupted: '已中断',
};

/** The message keeps the chronological entry; the monitor owns logs and process controls. */
export function CompanionCapabilityLink({ action, actionId, now, onOpen }: {
  action?: CompanionAction; actionId: string; now: number; onOpen(id: string): void;
}) {
  const working = action?.status === 'running' || action?.status === 'queued';
  const title = action ? companionCapabilityTitle(action) : '查看这次能力调用', feedback = action?.capability ? companionCapabilityFeedback(action) : undefined;
  return <button type="button" className="companions-capability-link" data-loop-action={actionId} data-status={action?.status}
    aria-label={action ? `查看任务进度 ${title}` : '查看这次能力调用'}
    title={feedback || action?.title || '查看已保存的执行过程'} onClick={() => onOpen(actionId)}>
    <span className="companions-capability-symbol"><Icon name="activity" /></span>
    <span className="companions-capability-copy"><span className="companions-capability-title">{title}</span>{feedback && <small>{feedback}</small>}</span>
    {action && <span className="companions-capability-state">{companionDshPendingApproval(action) ? '等待确认权限' : labels[action.status]}{working && <> · {elapsedTime(action.startedAt || action.attemptCreatedAt || action.createdAt, now)}</>}</span>}
    <Icon name="chevron" />
  </button>;
}
