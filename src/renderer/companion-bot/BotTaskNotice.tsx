import { useId } from 'react';
import type { BotCompanion, BotMessage, BotTask } from '../../shared/companion-bot';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { botTaskState, botTaskStatus, botTaskTitle } from './task-presentation';

/** Task activity is a durable part of the conversation, including after the
 * companion reports the result. Keep the compact record instead of repeating
 * raw executor output; model-context filtering is independent of this view. */
export function BotTaskNotice({ message, tasks, companions = [], locale, onOpen }: { message: BotMessage; tasks: BotTask[]; companions?: readonly BotCompanion[]; locale: 'zh-CN' | 'en'; onOpen(taskId?: string): void }) {
  const statusId = useId();
  const taskId = message.taskNotice?.taskId;
  const task = tasks.find(item => item.conversationId === message.conversationId && (taskId ? item.id === taskId : message.content.startsWith(`任务 ${item.id} `)));
  const zh = locale === 'zh-CN';
  const ownerId = task?.companionId ?? message.taskNotice?.companionId;
  const companion = companions.find(person => person.id === ownerId);
  const owner = companion?.name ?? task?.companionName ?? message.taskNotice?.companionName;
  const title = task ? botTaskTitle(task) : message.taskNotice?.title;
  const presentation = task ?? (message.taskNotice?.status ? { id: taskId ?? '', conversationId: message.conversationId, companionId: ownerId ?? '', goal: title ?? '', status: message.taskNotice.status } : undefined);
  const name = title ? Array.from(title).slice(0, 64).join('') : zh ? '任务有新进展' : 'Task update received';
  const state = presentation ? botTaskState(presentation) : 'updated';
  const knownState = ['queued', 'running', 'waiting', 'paused', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(state);
  const status = presentation && knownState ? botTaskStatus(presentation, locale) : zh ? '进度已更新' : 'Progress updated';
  const date = new Date(message.createdAt), validDate = !Number.isNaN(date.getTime());
  return <article className="bot-task-notice" data-bot-message={message.id} data-task-owner={ownerId} data-task-id={taskId ?? task?.id} data-task-state={knownState ? state : 'updated'}>
    {owner ? <BotAvatar companion={companion} name={owner} /> : <span className="bot-task-notice-symbol"><BotIcon name="tasks" /></span>}
    <div className="bot-task-notice-content"><div className="bot-task-notice-meta"><strong>{owner ?? (zh ? '任务动态' : 'Task activity')}</strong><span>{zh ? '任务动态' : 'Task activity'}</span>{validDate && <time dateTime={message.createdAt}>{date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}</time>}</div>
      <button type="button" className="bot-task-notice-open" onClick={() => onOpen(taskId ?? task?.id)} aria-label={`${zh ? '查看任务' : 'View task'} · ${title ?? name}`} aria-describedby={statusId}>
        <span className="bot-task-notice-heading"><span className="bot-task-notice-icon"><BotIcon name="tasks" /></span><span className="bot-task-notice-title" title={title}>{name}</span><span className="bot-task-notice-state" id={statusId}><i aria-hidden="true" />{status}</span></span>
        <span className="bot-task-notice-footer"><span>{zh ? '任务记录' : 'Task record'}</span><span>{zh ? '查看详情' : 'View details'}<BotIcon name="chevron-right" /></span></span>
      </button>
    </div>
  </article>;
}
