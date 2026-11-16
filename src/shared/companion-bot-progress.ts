import type { BotMessage, BotReplyProgress } from './companion-bot';

type Locale = 'zh-CN' | 'en';
const labels: Record<string, [string, string]> = {
  read: ['读取文件', 'Read file'], read_file: ['读取文件', 'Read file'], read_image: ['查看图片', 'View image'], write: ['写入文件', 'Write file'], edit: ['编辑文件', 'Edit file'],
  shell: ['运行命令', 'Run command'], pwsh: ['运行命令', 'Run command'], bash: ['运行命令', 'Run command'], web_fetch: ['读取网页', 'Read page'], web_search: ['搜索网页', 'Search web'],
  present: ['交付文件', 'Deliver files'], present_files: ['交付文件', 'Deliver files'], message_peer: ['伙伴协作', 'Collaborate'], companion_contact: ['伙伴私聊', 'Contact companion'],
  sessions_spawn: ['启动子会话', 'Start subagent'], chat_send_sticker: ['发送表情', 'Send sticker'], chat_list_stickers: ['查找表情', 'Find stickers'], memory_search: ['检索记忆', 'Search memories'],
};
export function botExecutionToolLabel(toolName: string | undefined, locale: Locale): string | undefined {
  if (toolName === 'browser') return locale === 'zh-CN' ? '操作内置浏览器' : 'Use built-in browser';
  if (toolName === 'asset_manager') return locale === 'zh-CN' ? '操作资产管理器' : 'Use asset manager';
  const name = Object.keys(labels).find(name => toolName === name || toolName?.endsWith('_' + name));
  return name ? labels[name]?.[locale === 'zh-CN' ? 0 : 1] : undefined;
}

const phases: Record<'zh-CN' | 'en', Record<BotReplyProgress['phase'], string>> = {
  'zh-CN': {
    'memory-starting': '正在唤醒伙伴记忆', 'memory-verifying': '正在校验内置记忆引擎', 'memory-indexing': '正在同步记忆索引',
    queued: '等待处理', 'recalling-memory': '正在检索记忆', 'preparing-context': '准备上下文',
    'compacting-context': '正在整理长对话', 'waiting-runtime': '等待运行环境', 'waiting-model': '等待模型响应',
    'using-tool': '正在使用工具', generating: '正在生成回复', retrying: '正在恢复连接', reconciling: '正在核实先前操作', 'waiting-answer': '等待你的回复',
  },
  en: {
    'memory-starting': 'Starting companion memory', 'memory-verifying': 'Verifying the memory engine', 'memory-indexing': 'Synchronizing memory indexes',
    queued: 'Waiting to start', 'recalling-memory': 'Recalling memories', 'preparing-context': 'Preparing context',
    'compacting-context': 'Organizing the conversation', 'waiting-runtime': 'Waiting for runtime', 'waiting-model': 'Waiting for model',
    'using-tool': 'Using a tool', generating: 'Generating a reply', retrying: 'Reconnecting', reconciling: 'Checking prior actions', 'waiting-answer': 'Waiting for your reply',
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
  call_stage: ['查看会面表情和动作', 'Checking meeting expressions and motions'],
  call_present: ['安排会面片段', 'Queuing meeting dialogue'],
};

export function botReplyProgressLabel(status: BotMessage['status'], progress: BotMessage['progress'], locale: 'zh-CN' | 'en'): string {
  const phase = progress?.phase ?? (status === 'queued' ? 'queued' : 'preparing-context');
  const toolName = progress?.toolName;
  const tool = toolName && Object.hasOwn(tools, toolName) ? tools[toolName] : undefined;
  // Only host phases and known tool labels are presented. Arguments, model reasoning and
  // arbitrary provider detail must never become the visible activity description.
  return phase === 'using-tool' && toolName
    ? tool?.[locale === 'zh-CN' ? 0 : 1] ?? botExecutionToolLabel(toolName, locale) ?? phases[locale][phase]
    : phases[locale][phase];
}

export function botCallProgressIcon(phase?: BotReplyProgress['phase']) {
  switch (phase) {
    case 'memory-starting': case 'memory-verifying': case 'memory-indexing': case 'recalling-memory': return 'memory';
    case 'preparing-context': case 'compacting-context': case 'reconciling': return 'tasks';
    case 'queued': case 'waiting-runtime': case 'waiting-model': return 'clock';
    case 'using-tool': return 'settings';
    case 'retrying': return 'replay';
    case 'waiting-answer': return 'quote';
    default: return 'sparkles';
  }
}
