import { useEffect, useState } from 'react';
import type { BotMessage, BotReplyProgress } from '../../shared/companion-bot';
import { BotIcon } from './BotIcon';

const phases: Record<'zh-CN' | 'en', Record<BotReplyProgress['phase'], string>> = {
  'zh-CN': {
    'memory-starting': '正在唤醒伙伴记忆', 'memory-verifying': '正在校验内置记忆引擎', 'memory-indexing': '正在同步记忆索引',
    queued: '等待处理', 'recalling-memory': '正在检索记忆', 'preparing-context': '准备上下文',
    'compacting-context': '正在整理长对话', 'waiting-runtime': '等待运行环境', 'waiting-model': '等待模型响应',
    'using-tool': '正在使用工具', generating: '正在生成回复', retrying: '正在恢复连接',
  },
  en: {
    'memory-starting': 'Starting companion memory', 'memory-verifying': 'Verifying the memory engine', 'memory-indexing': 'Synchronizing memory indexes',
    queued: 'Waiting to start', 'recalling-memory': 'Recalling memories', 'preparing-context': 'Preparing context',
    'compacting-context': 'Organizing the conversation', 'waiting-runtime': 'Waiting for runtime', 'waiting-model': 'Waiting for model',
    'using-tool': 'Using a tool', generating: 'Generating a reply', retrying: 'Reconnecting',
  },
};
const tools: Record<string, [string, string]> = {
  memory_search: ['查询长期记忆', 'Searching memories'], memory_recall_details: ['读取记忆原文', 'Reading memory evidence'],
  memory_history: ['查找聊天记录', 'Searching chat history'], memory_read: ['读取历史片段', 'Reading chat history'],
  memory_write: ['保存记忆', 'Saving a memory'], memory_list: ['查找日记', 'Finding diaries'], memory_note: ['读取日记', 'Reading a diary'],
  memory_update: ['更新记忆', 'Updating a memory'], memory_organize: ['整理记忆', 'Organizing memories'], memory_forget: ['撤回记忆', 'Withdrawing a memory'],
  memory_maintenance: ['查看或提交记忆维护', 'Checking or submitting memory maintenance'],
  chat_read_message: ['读取聊天原文', 'Reading an original message'], chat_list_stickers: ['挑选表情', 'Choosing a sticker'],
  chat_send_sticker: ['发送表情', 'Sending a sticker'], chat_list_files: ['查找聊天附件', 'Finding attachments'], chat_send_file: ['发送附件', 'Sending an attachment'],
  dsh_task: ['提交执行任务', 'Submitting a task'], dsh_task_control: ['查看或协调任务', 'Checking or coordinating a task'], dsh_task_result_read: ['读取任务结果', 'Reading the task result'],
  world: ['与虚拟世界交互', 'Interacting with the world'], message_peer: ['联系其他伙伴', 'Messaging another companion'], companion_contact: ['联系其他伙伴', 'Contacting another companion'],
  context_handoff_read: ['读取先前对话摘要', 'Reading earlier context'], agent_read_tool_result: ['读取工具回执', 'Reading a tool receipt'],
};

export function botReplyProgressLabel(status: BotMessage['status'], progress: BotMessage['progress'], locale: 'zh-CN' | 'en'): string {
  const phase = progress?.phase ?? (status === 'queued' ? 'queued' : 'preparing-context');
  const tool = progress?.toolName ? tools[progress.toolName] : undefined;
  // Only host phases and known tool labels are presented. Arguments, model reasoning and
  // arbitrary provider detail must never become the visible activity description.
  return phase === 'using-tool' && tool ? tool[locale === 'zh-CN' ? 0 : 1] : phases[locale][phase];
}

export function BotReplyProgressIndicator({ message, locale, onStop }: {
  message: Pick<BotMessage, 'status' | 'progress' | 'createdAt'>;
  locale: 'zh-CN' | 'en'; onStop(): void;
}) {
  const active = message.status === 'queued' || message.status === 'running';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    // Keep the clock local: a one-second tick must not render the full transcript.
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, message.createdAt]);
  if (!active) return null;
  const started = Date.parse(message.createdAt), seconds = Math.max(0, Math.floor((now - started) / 1000));
  return <div className="bot-reply-progress" data-phase={message.progress?.phase ?? (message.status === 'queued' ? 'queued' : 'preparing-context')}>
    <BotIcon name="clock" />
    <span className="bot-reply-progress-label" role="status">{botReplyProgressLabel(message.status, message.progress, locale)}</span>
    {Number.isFinite(started) && <span className="bot-reply-progress-elapsed" aria-live="off">{locale === 'zh-CN' ? `已用 ${seconds} 秒` : `${seconds}s elapsed`}</span>}
    <button className="bot-stop" onClick={onStop}>{locale === 'zh-CN' ? '停止' : 'Stop'}</button>
  </div>;
}
