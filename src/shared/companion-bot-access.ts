import type { BotConversation } from './companion-bot';

/** The app owner may observe a genuine two-companion private conversation.
 * Observation never grants membership or permission to publish into it. */
export function botCanInspectConversation(room: BotConversation | undefined): boolean {
  return !!room && !room.dissolvedAt && (room.memberIds.includes('user') || room.kind === 'peer' && room.userRole === 'observer'
    && room.memberIds.length === 2 && new Set(room.memberIds).size === 2 && !room.memberIds.includes('user'));
}

export function botCanImportConversationMedia(room: BotConversation | undefined): boolean {
  return botCanInspectConversation(room) && !!room?.memberIds.includes('user') && room.kind !== 'peer';
}
