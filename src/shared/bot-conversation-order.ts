import type { BotConversation, BotConversationActivity } from './companion-bot';

/** Pins form a separate group; both groups follow the latest chat activity. */
export function orderBotConversations<T extends Pick<BotConversation, 'id' | 'createdAt' | 'pinned'>>(
  conversations: readonly T[], activity?: Record<string, BotConversationActivity>,
): T[] {
  const time = (conversation: T) => Date.parse(activity?.[conversation.id]?.updatedAt ?? conversation.createdAt) || 0;
  return [...conversations].sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned)
    || time(right) - time(left)
    || (activity?.[right.id]?.sequence ?? 0) - (activity?.[left.id]?.sequence ?? 0));
}
