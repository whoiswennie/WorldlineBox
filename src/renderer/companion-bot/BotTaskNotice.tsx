import type { BotCompanion, BotMessage, BotTask } from '../../shared/companion-bot';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { botTaskStatus, botTaskTitle } from './task-presentation';

export function botTaskNoticeVisible(message: BotMessage, messages: readonly BotMessage[]): boolean {
  const replyId = message.taskNotice?.replyMessageId;
  return !replyId || !messages.some(reply => reply.id === replyId && reply.conversationId === message.conversationId && reply.status === 'sent' && (!!reply.content.trim() || !!reply.attachments?.length));
}

/** Transport receipts are operational facts, not a second character response.
 * Keep the durable original in history and task details without rendering the
 * full executor output a second time in the ordinary conversation. */
export function BotTaskNotice({ message, tasks, companions = [], locale, onOpen }: { message: BotMessage; tasks: BotTask[]; companions?: readonly BotCompanion[]; locale: 'zh-CN' | 'en'; onOpen(taskId?: string): void }) {
  const taskId = message.taskNotice?.taskId;
  const task = tasks.find(item => item.conversationId === message.conversationId && (taskId ? item.id === taskId : message.content.startsWith(`任务 ${item.id} `)));
  const zh = locale === 'zh-CN';
  const ownerId = task?.companionId ?? message.taskNotice?.companionId;
  const companion = companions.find(person => person.id === ownerId);
  const owner = companion?.name ?? task?.companionName ?? message.taskNotice?.companionName;
  const title = task ? botTaskTitle(task) : message.taskNotice?.title;
  const presentation = task ?? (message.taskNotice?.status ? { id: taskId ?? '', conversationId: message.conversationId, companionId: ownerId ?? '', goal: title ?? '', status: message.taskNotice.status } : undefined);
  const name = title ? Array.from(title).slice(0, 32).join('') : zh ? '任务有新进展' : 'Task update received';
  const date = new Date(message.createdAt), validDate = !Number.isNaN(date.getTime());
  return <article className="bot-task-notice" data-bot-message={message.id} data-task-owner={ownerId}>
    {owner ? <BotAvatar companion={companion} name={owner} /> : <span className="bot-task-notice-symbol"><BotIcon name="tasks" /></span>}
    <div className="bot-task-notice-content"><div className="bot-task-notice-meta"><strong>{owner ?? (zh ? '任务动态' : 'Task activity')}</strong><span>{zh ? '任务动态' : 'Task activity'}</span>{validDate && <time dateTime={message.createdAt}>{date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}</time>}</div>
      <button className="bot-task-notice-open" onClick={() => onOpen(taskId ?? task?.id)} aria-label={`${zh ? '查看任务' : 'View task'} · ${title ?? name}`}><span className="bot-task-notice-title">{name}</span><span className="bot-task-notice-state">{presentation ? botTaskStatus(presentation, locale) : zh ? '查看进展' : 'View progress'}</span><BotIcon name="chevron-right" /></button>
    </div>
  </article>;
}
