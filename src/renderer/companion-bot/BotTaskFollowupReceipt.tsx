import type { BotTaskFollowupReceipt as Receipt } from '../../shared/companion-bot';
import { BotIcon } from './BotIcon';
import './bot-task-followup.css';

export function BotTaskFollowupReceipt({ receipt, locale, onOpen }: { receipt: Receipt; locale: 'zh-CN' | 'en'; onOpen(taskId: string): void }) {
  const zh = locale === 'zh-CN';
  const labels: Record<Receipt['state'], string> = zh ? {
    queued: '正在交给原任务', delivered: '已交给原任务', 'needs-attention': '还需补充回答', failed: '未能交给原任务', cancelled: '此次跟进已取消',
  } : { queued: 'Sending to the task', delivered: 'Sent to the original task', 'needs-attention': 'An answer is still needed', failed: 'Could not deliver to the task', cancelled: 'Follow-up cancelled' };
  return <div className={`bot-followup-receipt is-${receipt.state}`} role="status">
    <button type="button" onClick={() => onOpen(receipt.taskId)} aria-label={`${labels[receipt.state]} · ${receipt.title ?? (zh ? '查看任务' : 'View task')}`}
      title={receipt.state === 'delivered' ? zh ? '补充要求已交给原任务，结果会在这里继续反馈。' : 'Your guidance was delivered. Results will follow in this chat.' : undefined}>
      <BotIcon name={receipt.state === 'delivered' ? 'tasks' : receipt.state === 'queued' ? 'clock' : 'notice'} />
      <span>{labels[receipt.state]}</span>{receipt.title && <small>{receipt.title}</small>}<BotIcon name="chevron-right" />
    </button>
  </div>;
}
