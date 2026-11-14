import { useEffect, useState } from 'react';
import type { BotCompanion, BotCompanionPresence } from '../../shared/companion-bot';
import './bot-presence.css';

type Locale = 'zh-CN' | 'en';
type Status = BotCompanionPresence['status'];
const labels: Record<Status, [string, string]> = {
  idle: ['待命', 'Ready'], replying: ['正在回复', 'Replying'], working: ['执行任务', 'Working'], waiting: ['等待处理', 'Waiting for input'],
  'needs-attention': ['需要处理', 'Needs attention'], error: ['执行异常', 'Execution issue'], unconfigured: ['尚未配置', 'Not configured'],
};
export function botPresenceStatus(presence: BotCompanionPresence, now = Date.now()): Status {
  if (presence.status !== 'error' || !presence.expiresAt || Date.parse(presence.expiresAt) > now) return presence.status;
  return presence.counts.stopping || presence.counts.blocked || presence.counts.waiting ? 'needs-attention' : presence.counts.running ? 'working' : presence.counts.replying ? 'replying' : presence.counts.queued || presence.counts.pendingMessages ? 'waiting' : 'idle';
}
export function botPresenceLabel(presence: BotCompanionPresence, locale: Locale, now?: number): string {
  const status = botPresenceStatus(presence, now), zh = locale === 'zh-CN';
  return labels[status][zh ? 0 : 1];
}
function usePresenceClock(presence?: BotCompanionPresence) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!presence?.expiresAt) return;
    const expiry = Date.parse(presence.expiresAt), delay = expiry - Date.now();
    if (!Number.isFinite(expiry)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(delay + 20, 2147483647)));
    return () => window.clearTimeout(timer);
  }, [presence?.expiresAt]);
  return now;
}
export function BotPresenceDot({ presence, locale = 'zh-CN', enabled = true }: { presence: BotCompanionPresence; locale?: Locale; enabled?: boolean }) {
  const now = usePresenceClock(presence);
  if (!enabled) return <span className="bot-presence-dot" data-presence="disabled" title={locale === 'zh-CN' ? '已关闭' : 'Disabled'} aria-hidden="true" />;
  return <span className="bot-presence-dot" data-presence={botPresenceStatus(presence, now)} title={botPresenceLabel(presence, locale, now)} aria-hidden="true" />;
}
export function BotPresenceText({ presence, locale, enabled = true }: { presence?: BotCompanionPresence; locale: Locale; enabled?: boolean }) {
  const now = usePresenceClock(presence);
  if (!enabled) return <span className="bot-presence-text" data-presence="disabled">{locale === 'zh-CN' ? '已关闭' : 'Disabled'}</span>;
  if (!presence) return null;
  return <span className="bot-presence-text" data-presence={botPresenceStatus(presence, now)}>{botPresenceLabel(presence, locale, now)}</span>;
}
export function BotPresenceSummary({ companions, presence, locale }: { companions: readonly BotCompanion[]; presence?: Record<string, BotCompanionPresence>; locale: Locale }) {
  const order: Status[] = ['needs-attention', 'error', 'working', 'replying', 'waiting', 'idle', 'unconfigured'];
  const entries = companions.flatMap(person => person.enabled !== false && presence?.[person.id] ? [presence[person.id]!] : []);
  const now = usePresenceClock(entries.find(state => state.expiresAt));
  const first = [...entries].sort((a, b) => order.indexOf(botPresenceStatus(a, now)) - order.indexOf(botPresenceStatus(b, now)))[0];
  const status = first ? botPresenceStatus(first, now) : companions.length && companions.every(person => person.enabled === false) ? 'disabled' : undefined;
  if (!status) return null;
  const label = status === 'disabled' ? locale === 'zh-CN' ? '已关闭' : 'Disabled' : labels[status][locale === 'zh-CN' ? 0 : 1];
  return <span className="bot-presence-summary" role="status">
    <span className="bot-presence-indicator" data-presence={status} aria-hidden="true" />
    <span className="bot-presence-text" data-presence={status}>{label}</span>
  </span>;
}
