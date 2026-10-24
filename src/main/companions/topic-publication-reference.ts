import { createHash } from 'node:crypto';
import type { CompanionReplyInput } from './context';

type Frame = Pick<CompanionReplyInput, 'topic' | 'conversation' | 'topicPublicationReference'>;

/** This input is constructed from an exact host publication pointer plus a
 * fresh authorized source read. Sequence is creation order, not publication
 * order: an earlier pending bubble can finish after a newer bubble. */
export function companionTopicLatestPublication(frame: Frame) {
  const reference = frame.topicPublicationReference;
  if (!reference) return undefined;
  const message = reference.message;
  const derived = frame.topic?.lastNarrativePublicationAvailability !== undefined;
  const pointer = derived ? frame.topic?.lastNarrativePublicationRef : frame.topic?.lastPublicationRef;
  const publicationRevision = frame.topic?.lastNarrativePublicationRef?.publicationRevision;
  if (!frame.topic || frame.topic.kind !== 'story' || reference.formalPublicationRevision !== (frame.topic.formalPublicationRevision ?? 0)
    || (derived ? frame.topic.lastNarrativePublicationAvailability : frame.topic.lastPublicationAvailability) !== 'available' || pointer?.messageId !== message.id
    || derived && (!Number.isSafeInteger(publicationRevision) || publicationRevision! < 1 || publicationRevision! > reference.formalPublicationRevision)
    || pointer.authorId !== message.authorId || pointer.contentChecksum !== reference.contentChecksum
    || message.conversationId !== frame.conversation.id || message.topicId !== frame.topic.id
    || message.authorId === 'user' || message.authorId === 'system' || message.status !== 'sent'
    || message.isReplyDraft || message.replyDraft || !message.content.trim()
    || createHash('sha256').update(message.content).digest('hex') !== reference.contentChecksum)
    throw new Error('最新正式话题资料与真实发布版本、来源或正文不一致。');
  return message;
}
