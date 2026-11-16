import type { BotExecutionStep } from '../../shared/companion-bot';
import { botToolActivityArgs, botToolActivityDescription, cleanBotActivityText as clean } from '../../shared/companion-bot-execution';
import { botExecutionToolLabel } from '../../shared/companion-bot-progress';

type Locale = 'zh-CN' | 'en';
const browserLabels: Record<string, [string, string]> = { observe: ['查看页面', 'Inspect page'], read: ['读取网页', 'Read page'], click: ['点击网页元素', 'Click page element'], fill: ['填写网页内容', 'Fill page field'], navigate: ['打开网页', 'Navigate page'], scroll: ['滚动网页', 'Scroll page'], screenshot: ['截取网页', 'Capture page'], tabs: ['查看标签页', 'List tabs'], key: ['发送按键', 'Press key'] };
/** Same native argument descriptions as DSH, rendered as text, not HTML.
 * Do not surface commands/credentials when an action has no safe description. */
export function botExecutionActivity(step: BotExecutionStep, locale: Locale): { title: string; detail: string } {
  const zh = locale === 'zh-CN', language = zh ? 0 : 1;
  if (step.type === 'reasoning') {
    const paragraph = step.text?.split(/\r?\n\s*\r?\n/u).findLast(value => value.trim()) ?? '';
    return { title: zh ? '思考' : 'Thinking', detail: clean(paragraph.split(/\r?\n/u)[0]?.replaceAll('**', '')) };
  }
  if (!['tool_call', 'tool_result'].includes(step.type)) return { title: step.summary || (zh ? '处理进展' : 'Progress'), detail: '' };
  const args = botToolActivityArgs(step);
  let title = botExecutionToolLabel(step.toolName, locale) ?? (zh ? '调用工具' : 'Tool call');
  let detail = botToolActivityDescription(args);
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
