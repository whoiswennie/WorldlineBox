import type { BotExecutionStep } from '../../shared/companion-bot';
type Locale = 'zh-CN' | 'en';
const labels: Record<string, [string, string]> = {
  read: ['读取文件', 'Read file'], read_file: ['读取文件', 'Read file'], read_image: ['查看图片', 'View image'], write: ['写入文件', 'Write file'], edit: ['编辑文件', 'Edit file'],
  shell: ['运行命令', 'Run command'], pwsh: ['运行命令', 'Run command'], bash: ['运行命令', 'Run command'], web_fetch: ['读取网页', 'Read page'], web_search: ['搜索网页', 'Search web'],
  present: ['交付文件', 'Deliver files'], present_files: ['交付文件', 'Deliver files'], message_peer: ['伙伴协作', 'Collaborate'], companion_contact: ['伙伴私聊', 'Contact companion'],
  sessions_spawn: ['启动子会话', 'Start subagent'], chat_send_sticker: ['发送表情', 'Send sticker'], chat_list_stickers: ['查找表情', 'Find stickers'], memory_search: ['检索记忆', 'Search memories'],
};
const browserLabels: Record<string, [string, string]> = { observe: ['查看页面', 'Inspect page'], read: ['读取网页', 'Read page'], click: ['点击网页元素', 'Click page element'], fill: ['填写网页内容', 'Fill page field'], navigate: ['打开网页', 'Navigate page'], scroll: ['滚动网页', 'Scroll page'], screenshot: ['截取网页', 'Capture page'], tabs: ['查看标签页', 'List tabs'], key: ['发送按键', 'Press key'] };
const clean = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 180) : '';
/** Same native argument descriptions as DSH, rendered as text, not HTML.
 * Do not surface commands/credentials when an action has no safe description. */
export function botExecutionActivity(step: BotExecutionStep, locale: Locale): { title: string; detail: string } {
  const zh = locale === 'zh-CN', language = zh ? 0 : 1;
  if (step.type === 'reasoning') {
    const paragraph = step.text?.split(/\r?\n\s*\r?\n/u).findLast(value => value.trim()) ?? '';
    return { title: zh ? '思考' : 'Thinking', detail: clean(paragraph.split(/\r?\n/u)[0]?.replaceAll('**', '')) };
  }
  if (!['tool_call', 'tool_result'].includes(step.type)) return { title: step.summary || (zh ? '处理进展' : 'Progress'), detail: '' };
  let args: Record<string, unknown> = {};
  try { const value: unknown = JSON.parse(step.text ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) args = value as Record<string, unknown>; } catch { /* Legacy tool payload. */ }
  const name = Object.keys(labels).find(name => step.toolName === name || step.toolName?.endsWith('_' + name));
  let title = name ? labels[name]![language] : zh ? '调用工具' : 'Tool call';
  let detail = clean(args.description) || clean(args.title);
  if (step.toolName === 'browser') {
    const action = clean(args.action); title = browserLabels[action]?.[language] ?? (zh ? '操作内置浏览器' : 'Use built-in browser');
    if (!detail && action === 'fill') detail = `${zh ? '输入' : 'Enter'} ${typeof args.text === 'string' ? args.text.length : typeof args.value === 'string' ? args.value.length : 0} ${zh ? '个字符' : 'characters'}`;
    detail ||= clean(args.selector) || clean(args.query);
  }
  if (step.toolName === 'asset_manager') { title = zh ? '操作资产管理器' : 'Use asset manager'; detail ||= clean(args.name) || clean(args.query) || clean(args.action); }
  detail ||= clean(args.path) || clean(args.file_path) || clean(args.query);
  if (!detail && typeof args.url === 'string') { try { const url = new URL(args.url); detail = url.origin + url.pathname; } catch { /* Invalid source URL is shown only in expanded input. */ } }
  if (!detail && step.summary && !/^(开始调用工具|工具执行完成|工具执行失败)$/u.test(step.summary)) detail = clean(step.summary);
  detail ||= clean(step.toolName);
  return { title, detail };
}

export function latestBotExecutionActivity(steps: readonly BotExecutionStep[]): BotExecutionStep | undefined {
  // Native sequence preserves exact chronology even when timestamps are equal.
  return steps.reduce<BotExecutionStep | undefined>((latest, step) => {
    if (step.outputState === 'abandoned' || ['session_created', 'session_resumed'].includes(step.type)) return latest;
    if (!latest) return step;
    if (step.streamGeneration === latest.streamGeneration && step.sequence !== undefined && latest.sequence !== undefined) return step.sequence > latest.sequence ? step : latest;
    return Date.parse(step.updatedAt ?? step.at) >= Date.parse(latest.updatedAt ?? latest.at) ? step : latest;
  }, undefined);
}
