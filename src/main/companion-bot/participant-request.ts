import type { BotConversation, BotEvent } from './types';

/** Chat participants have equal task privileges. System notices, observations
 * and text claiming to be a participant are not participant requests. Callers
 * still verify the durable event, room ACL and withdrawal lineage. */
export function isBotParticipantRequest(event: BotEvent, room: BotConversation | undefined): boolean {
  return !!room && room.memberIds.includes(event.senderId) && (event.source === 'user' && event.senderType === 'user' && event.senderId === 'user'
    || ['companion', 'group'].includes(event.source) && event.senderType === 'companion' && event.senderId !== event.companionId);
}
