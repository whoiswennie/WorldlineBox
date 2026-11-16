import { useEffect, useState, type ReactNode } from 'react';
import type { BotMessage } from '../../shared/companion-bot';
import { botCallProgressIcon, botReplyProgressLabel } from '../../shared/companion-bot-progress';
import { BotIcon } from './BotIcon';

export { botReplyProgressLabel } from '../../shared/companion-bot-progress';

function useReplyElapsed(createdAt: string | undefined, active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !createdAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, createdAt]);
  const started = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : undefined;
}

export function BotReplyProgressIndicator({ message, locale, onStop }: {
  message: Pick<BotMessage, 'status' | 'progress' | 'createdAt'>;
  locale: 'zh-CN' | 'en'; onStop?(): void;
}) {
  const active = message.status === 'queued' || message.status === 'running';
  const seconds = useReplyElapsed(message.createdAt, active);
  if (!active) return null;
  const activity = message.progress?.activity;
  const phase = botReplyProgressLabel(message.status, message.progress, locale);
  return <div className="bot-reply-progress" data-phase={message.progress?.phase ?? (message.status === 'queued' ? 'queued' : 'preparing-context')}>
    <BotIcon name="clock" />
    <span className="bot-reply-progress-label" role="status">
      {activity?.step !== undefined && <>{locale === 'zh-CN' ? `第 ${activity.step} 步` : `Step ${activity.step}`} · </>}{phase}
      {activity?.summary && <span className="bot-reply-progress-summary" title={activity.summary}>{activity.summary}</span>}
    </span>
    {seconds !== undefined && <span className="bot-reply-progress-elapsed" aria-live="off">{locale === 'zh-CN' ? `已用 ${seconds} 秒` : `${seconds}s elapsed`}</span>}
    {onStop && <button className="bot-stop" onClick={onStop}>{locale === 'zh-CN' ? '停止' : 'Stop'}</button>}
  </div>;
}

export function BotCallProgress({ message, zh, action }: {
  message?: Pick<BotMessage, 'status' | 'progress' | 'createdAt'>;
  zh: boolean;
  action?: ReactNode;
}) {
  const seconds = useReplyElapsed(message?.createdAt, true);
  const progress = message?.progress;
  const label = message ? botReplyProgressLabel(message.status, progress, zh ? 'zh-CN' : 'en') : zh ? '正在回应…' : 'Replying…';
  const step = progress?.activity?.step;
  return <div className="bot-call-progress">
    <span className="bot-call-progress-symbol"><BotIcon name={botCallProgressIcon(progress?.phase ?? (message?.status === 'queued' ? 'queued' : message ? 'preparing-context' : undefined))} /></span>
    <div className="bot-call-progress-copy">
      <div className="bot-call-progress-line">
        <span className="bot-reply-progress-label" role="status" title={progress?.activity?.summary}>{label}</span>
        <span className="bot-call-progress-dots" aria-hidden="true"><i /><i /><i /></span>
      </div>
      {(step !== undefined || seconds !== undefined) && <small className="bot-call-progress-meta">
        {step !== undefined && <span>{zh ? `第 ${step} 步` : `Step ${step}`}</span>}
        {seconds !== undefined && <span className="bot-reply-progress-elapsed" aria-live="off">{zh ? `${seconds} 秒` : `${seconds}s`}</span>}
      </small>}
    </div>
    {action}
  </div>;
}
