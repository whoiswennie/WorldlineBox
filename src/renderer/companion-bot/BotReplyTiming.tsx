import type { BotMessage } from '../../shared/companion-bot';
import { BotIcon } from './BotIcon';

export function formatBotReplyDuration(milliseconds: number, locale: 'zh-CN' | 'en'): string {
  const zh = locale === 'zh-CN';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ${zh ? '毫秒' : 'ms'}`;
  const seconds = Math.round(milliseconds / 100) / 10;
  if (seconds < 60) return `${seconds} ${zh ? '秒' : 's'}`;
  const minutes = Math.floor(seconds / 60), remainder = Math.round((seconds % 60) * 10) / 10;
  return zh ? `${minutes} 分 ${remainder} 秒` : `${minutes}m ${remainder}s`;
}

export function BotReplyTiming({ timing, locale }: { timing?: BotMessage['timing']; locale: 'zh-CN' | 'en' }) {
  if (!timing || !Number.isFinite(timing.elapsedMs) || timing.elapsedMs < 0) return null;
  const zh = locale === 'zh-CN';
  const labels = zh ? { elapsedMs: '总计', queueMs: '首次排队', prepareMs: '上下文准备', firstTextMs: '收到消息至首字', modelMs: '主脑执行（含连接与工具）', finishMs: '收尾' }
    : { elapsedMs: 'Total', queueMs: 'Initial queue', prepareMs: 'Context preparation', firstTextMs: 'Input to first text', modelMs: 'Brain execution (including connection and tools)', finishMs: 'Finalization' };
  const details = (Object.keys(labels) as Array<keyof typeof labels>).flatMap(key => {
    const duration = timing[key];
    return duration !== undefined && Number.isFinite(duration) && duration >= 0 ? [`${labels[key]} ${formatBotReplyDuration(duration, locale)}`] : [];
  }).join('\n');
  return <span className="bot-message-duration" title={details} aria-label={`${zh ? '回复用时' : 'Response time'} ${formatBotReplyDuration(timing.elapsedMs, locale)}`}><BotIcon name="clock" />{zh ? '用时' : 'Took'} {formatBotReplyDuration(timing.elapsedMs, locale)}</span>;
}
