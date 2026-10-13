import type { Companion, CompanionAction, CompanionMessage } from '../../shared/companions';
import { shouldDelegateUserMessage } from './model';

export interface CompanionTaskIntent { source: CompanionMessage; prompt: string; title: string; addressedId?: string }
const confirmation = /^(?:好(?:的|呀|啊|吧)?|行(?:吧|啊)?|可以|嗯|是(?:的)?|对|看(?:呗|吧)|查(?:呗|吧)|搜(?:呗|吧)|做(?:呗|吧)|都行|随便|你定|继续|开始(?:吧)?|那就(?:做|查|搜|看)(?:吧)?|yes|ok(?:ay)?|sure|go ahead|do it)[。！!～~\s]*$/iu;

/** Short followups resolve only against a recent, unexecuted real user request. */
export function resolveCompanionTaskIntent(messages: readonly CompanionMessage[], companions: readonly Companion[], actions: readonly CompanionAction[]): CompanionTaskIntent | undefined {
  const visible = messages.filter(message => message.status === 'sent').sort((a, b) => a.sequence - b.sequence);
  const latest = [...visible].reverse().find(message => message.authorId === 'user');
  if (!latest) return;
  const resolve = (source: CompanionMessage): CompanionTaskIntent | undefined => {
    const addressed = companions.find(role => source.content.trim().startsWith(role.name) || source.content.includes(`@${role.name}`));
    const content = addressed ? source.content.trim().replace(new RegExp(`^@?${escapeRegex(addressed.name)}[，,:：\\s]*`, 'u'), '') : source.content;
    if (!shouldDelegateUserMessage(content) || actions.some(action => action.sourceMessageId === source.id)) return;
    const title = content.length < 100 && /(?:几点|(?:现在|当前|系统)时间|what time)/iu.test(content) ? '查看当前时间'
      : /(?:新闻|news)/iu.test(content) ? '查看最新新闻' : content.replace(/[\r\n]+/gu, ' ').slice(0, 60);
    return { source, title: title || '处理这件事', addressedId: addressed?.id,
      prompt: source.id === latest.id ? source.content : `原始任务：\n${source.content}\n\n用户补充：\n${latest.content}\n沿用原始目标与限制。未指定新闻类别时按综合新闻处理，不需要再问是否执行。` };
  };
  if (!confirmation.test(latest.content.trim())) return resolve(latest);
  const previous = [...visible].reverse().find(message => message.authorId === 'user' && message.sequence < latest.sequence);
  if (!previous || latest.sequence - previous.sequence > 8 ||
    !visible.some(message => message.authorId !== 'user' && message.kind === 'text' && message.sequence > previous.sequence && message.sequence < latest.sequence)) return;
  return resolve(previous);
}
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
