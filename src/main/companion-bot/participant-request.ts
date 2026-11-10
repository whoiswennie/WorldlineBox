import type { BotConversation, BotEvent } from './types';
import { BOT_PEER_RETURN_SOURCE } from './peer-returns';

/** Chat participants have equal task privileges. System notices, observations
 * and text claiming to be a participant are not participant requests. Callers
 * still verify the durable event, room ACL and withdrawal lineage. */
export function isBotParticipantRequest(event: BotEvent, room: BotConversation | undefined): boolean {
  const returned = event.sourceInstanceId === BOT_PEER_RETURN_SOURCE && event.source === 'companion' && event.senderType === 'companion'
    && event.payload.peerReturn && room?.memberIds.includes(event.companionId);
  return !!room && (room.memberIds.includes(event.senderId) || !!returned) && (event.source === 'user' && event.senderType === 'user' && event.senderId === 'user'
    || ['companion', 'group'].includes(event.source) && event.senderType === 'companion' && event.senderId !== event.companionId);
}
