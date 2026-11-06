import { useEffect, useRef, useState } from 'react';
import type { BotCompanion, BotCompanionPresence, BotCompanionPresenceEvent, BotConversation } from '../../shared/companion-bot';
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
  const count = presence.counts.activeTasks, suffix = count ? zh ? ` · ${count} 项任务` : ` · ${count} ${count === 1 ? 'task' : 'tasks'}` : '';
  if (count <= 1 && ['stopping', 'stop-unconfirmed', 'stop-request-unknown'].includes(presence.activity?.phase ?? '')) return zh ? '已停止' : 'Stopped';
  if (['pausing', 'pause-unconfirmed', 'pause-request-unknown'].includes(presence.activity?.phase ?? '')) return (zh ? '已暂停' : 'Paused') + suffix;
  if (count && presence.counts.paused === count) return (zh ? '已暂停' : 'Paused') + suffix;
  if (presence.counts.queued && !presence.counts.running && !presence.counts.replying && !presence.counts.waiting && !presence.counts.stopping && !presence.counts.blocked && !presence.counts.paused) return (zh ? '任务排队' : 'Tasks queued') + suffix;
  if (presence.counts.stopping === count && count && !presence.counts.replying && !presence.counts.pendingMessages) return zh ? '已停止' : 'Stopped';
  if (!count && !presence.counts.replying && presence.counts.pendingMessages && !['error', 'needs-attention'].includes(status)) return zh ? '等待回复' : 'Waiting to reply';
  return labels[status][zh ? 0 : 1] + suffix;
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
export function BotPresenceDot({ presence, locale = 'zh-CN' }: { presence: BotCompanionPresence; locale?: Locale }) {
  const now = usePresenceClock(presence);
  return <span className="bot-presence-dot" data-presence={botPresenceStatus(presence, now)} title={botPresenceLabel(presence, locale, now)} aria-hidden="true" />;
}
export function BotPresenceText({ presence, locale }: { presence: BotCompanionPresence; locale: Locale }) {
  const now = usePresenceClock(presence);
  return <span className="bot-presence-text" data-presence={botPresenceStatus(presence, now)}>{botPresenceLabel(presence, locale, now)}</span>;
}
export function BotPresenceSummary({ companions, presence, locale, onOpen }: { companions: readonly BotCompanion[]; presence?: Record<string, BotCompanionPresence>; locale: Locale; onOpen(conversationId?: string, taskId?: string): void }) {
  const order: Status[] = ['needs-attention', 'error', 'working', 'replying', 'waiting', 'idle', 'unconfigured'];
  const entries = companions.flatMap(person => presence?.[person.id] ? [{ person, state: presence[person.id]! }] : []);
  const now = usePresenceClock(entries.find(item => item.state.expiresAt)?.state);
  entries.sort((a, b) => order.indexOf(botPresenceStatus(a.state, now)) - order.indexOf(botPresenceStatus(b.state, now)));
  const first = entries[0];
  if (!first) return null;
  const tasks = entries.reduce((count, item) => count + item.state.counts.activeTasks, 0), zh = locale === 'zh-CN';
  const sum = (key: keyof BotCompanionPresence['counts']) => entries.reduce((count, item) => count + (item.state.counts[key] ?? 0), 0);
  const aggregate = entries.length === 1 ? first.state : { ...first.state, counts: { activeTasks: tasks, queued: sum('queued'), running: sum('running'), waiting: sum('waiting'), stopping: sum('stopping'), blocked: sum('blocked'), replying: sum('replying'), pendingMessages: sum('pendingMessages'), paused: sum('paused') } };
  const activity = first.state.activity ?? entries.find(item => item.state.activity)?.state.activity;
  return <button className="bot-presence-summary" title={zh ? '查看伙伴的真实任务状态' : 'View companion task status'} onClick={() => onOpen(activity?.conversationId, activity?.taskId)}><span className="bot-presence-indicator" data-presence={botPresenceStatus(aggregate, now)} /><BotPresenceText presence={aggregate} locale={locale} />{tasks > 0 && <span aria-hidden="true">↗</span>}</button>;
}

interface TaskUpdatesInput {
  presence?: Record<string, BotCompanionPresence>;
  conversations: readonly BotConversation[];
  /** Set only while this room's task panel is actually visible. */
  readConversationId?: string;
}
const MAX_OBSERVED_TASK_UPDATES = 128;

/** Session-local updates received after the first snapshot, not a durable unread
 * ledger. Main exposes a bounded recent-event window; old history is never
 * replayed as a new notification. Rendering remains at the task entry point. */
export function useBotTaskUpdates({ presence, conversations, readConversationId }: TaskUpdatesInput): { count(conversationId: string): number } {
  const seen = useRef(new Map<string, Set<string>>()), watermarks = useRef(new Map<string, number>()), sequences = useRef(new Map<string, number>());
  const unread = useRef(new Map<string, BotCompanionPresenceEvent>()), revision = useRef(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const generation = ++revision.current;
    let active = true;
    const visible = new Set(conversations.filter(room => room.kind !== 'peer' && room.memberIds.includes('user') && !room.dissolvedAt).map(room => room.id));
    const fresh: BotCompanionPresenceEvent[] = [];
    for (const [companionId, state] of Object.entries(presence ?? {})) {
      const events = state.events ?? (state.lastEvent ? [state.lastEvent] : []), known = seen.current.get(companionId);
      if (!known) {
        seen.current.set(companionId, new Set(events.map(event => event.id)));
        watermarks.current.set(companionId, Math.max(-Infinity, ...events.map(event => Date.parse(event.occurredAt)).filter(Number.isFinite)));
        sequences.current.set(companionId, Math.max(0, ...events.map(event => event.sequence).filter(value => Number.isSafeInteger(value) && value > 0)));
        continue;
      }
      const watermark = watermarks.current.get(companionId) ?? -Infinity;
      const sequenceWatermark = sequences.current.get(companionId) ?? 0;
      let newest = watermark, newestSequence = sequenceWatermark;
      for (const event of events) {
        if (known.has(event.id)) continue;
        known.add(event.id);
        const occurredAt = Date.parse(event.occurredAt);
        // SQL sequence distinguishes same-millisecond new transitions from old
        // records exposed by removal. Time is only for older dev Main snapshots.
        if (Number.isSafeInteger(event.sequence) && event.sequence > 0) {
          if (event.sequence <= sequenceWatermark) continue;
          newestSequence = Math.max(newestSequence, event.sequence);
        } else if (!Number.isFinite(occurredAt) || occurredAt < watermark) continue;
        if (Number.isFinite(occurredAt)) newest = Math.max(newest, occurredAt);
        if (visible.has(event.conversationId)) fresh.push(event);
      }
      watermarks.current.set(companionId, newest);
      sequences.current.set(companionId, newestSequence);
      if (known.size > 128) seen.current.set(companionId, new Set([...known].slice(-64)));
    }
    for (const event of fresh.sort((a, b) => a.sequence && b.sequence ? a.sequence - b.sequence : Date.parse(a.occurredAt) - Date.parse(b.occurredAt))) {
      const key = `${event.conversationId}\0${event.taskId}`, previous = unread.current.get(key);
      if (previous && previous.sequence > event.sequence) continue;
      unread.current.delete(key); unread.current.set(key, event);
    }
    for (const [key, event] of unread.current) if (!visible.has(event.conversationId) || event.conversationId === readConversationId) unread.current.delete(key);
    while (unread.current.size > MAX_OBSERVED_TASK_UPDATES) unread.current.delete(unread.current.keys().next().value!);
    const next: Record<string, number> = {};
    for (const event of unread.current.values()) next[event.conversationId] = (next[event.conversationId] ?? 0) + 1;
    // A newer read/room commit invalidates an older scheduled publish. Clearing
    // the ref above is immediate, so closing a read panel cannot resurrect it.
    void Promise.resolve().then(() => {
      if (!active || revision.current !== generation) return;
      setCounts(current => Object.keys(current).length === Object.keys(next).length && Object.entries(next).every(([id, count]) => current[id] === count) ? current : next);
    });
    return () => { active = false; };
  }, [presence, conversations, readConversationId]);
  return { count: conversationId => counts[conversationId] ?? 0 };
}
