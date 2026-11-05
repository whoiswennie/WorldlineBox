import { useEffect, useRef, useState } from 'react';
import type { BotConversation, BotSnapshot } from '../../shared/companion-bot';

const MAX_UNREAD_CONVERSATIONS = 128;

/** Marks only committed messages observed after this workspace opened. The
 * message sequence prevents old rows revealed by removal from becoming new.
 * This is a bounded session indicator, not a durable unread-message count. */
export function useBotConversationUpdates({ activity, conversations, readConversationId }: {
  activity?: BotSnapshot['conversationActivity']; conversations?: readonly BotConversation[]; readConversationId?: string;
}): { unread(conversationId: string): boolean; hasPeerUpdates: boolean } {
  const watermark = useRef<number | undefined>(undefined), unread = useRef(new Map<string, number>()), revision = useRef(0);
  const [updates, setUpdates] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!activity) return;
    const generation = ++revision.current;
    let active = true;
    const visible = new Set(conversations?.map(room => room.id) ?? []);
    const entries = Object.entries(activity).filter(([id, value]) => visible.has(id) && Number.isSafeInteger(value.sequence) && value.sequence > 0);
    const latest = Math.max(watermark.current ?? 0, ...entries.map(([, value]) => value.sequence));
    if (watermark.current !== undefined) for (const [id, value] of entries) {
      if (value.sequence > watermark.current && id !== readConversationId) { unread.current.delete(id); unread.current.set(id, value.sequence); }
    }
    watermark.current = latest;
    for (const id of unread.current.keys()) if (!visible.has(id) || id === readConversationId) unread.current.delete(id);
    while (unread.current.size > MAX_UNREAD_CONVERSATIONS) unread.current.delete(unread.current.keys().next().value!);
    const next = new Set(unread.current.keys());
    void Promise.resolve().then(() => {
      if (active && revision.current === generation) setUpdates(current => current.size === next.size && [...next].every(id => current.has(id)) ? current : next);
    });
    return () => { active = false; };
  }, [activity, conversations, readConversationId]);
  return { unread: id => updates.has(id), hasPeerUpdates: !!conversations?.some(room => room.kind === 'peer' && updates.has(room.id)) };
}
