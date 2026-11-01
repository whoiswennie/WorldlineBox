import { companionTranscriptChangeEventSchema, type CompanionConversation, type CompanionMessage,
  type CompanionTranscriptChangeEvent } from '../../shared/companions';
import { trimMessageWindow } from './message-window';

export interface CompanionTranscriptPageIdentity { conversationId: string; topicId: string | null | undefined }
export type CompanionTranscriptAppendResult = { kind: 'reload' | 'ignore' | 'newer' | 'duplicate' }
  | { kind: 'append'; messages: CompanionMessage[]; trimmed: boolean; sequence: number };

/** Append to an already verified latest page, never amend a previously read row.
 * The caller clears acceptedPage immediately on every hard invalidation. */
export function appendCompanionTranscript(input: {
  event: CompanionTranscriptChangeEvent; conversations: readonly CompanionConversation[];
  selectedId: string | null; topicId: string | null | undefined; history: boolean;
  acceptedPage?: CompanionTranscriptPageIdentity; messages: CompanionMessage[];
}): CompanionTranscriptAppendResult {
  const parsed = companionTranscriptChangeEventSchema.safeParse(input.event);
  if (!parsed.success) return { kind: 'reload' };
  const message = parsed.data.message, room = input.conversations.find(room => room.id === message.conversationId);
  if (!room || message.authorId !== 'user' && !room.memberIds.includes(message.authorId)) return { kind: 'reload' };
  if (input.selectedId !== message.conversationId
    || input.topicId !== undefined && input.topicId !== (message.topicId ?? null)) return { kind: 'ignore' };
  if (input.history) return { kind: 'newer' };
  if (input.acceptedPage?.conversationId !== input.selectedId || input.acceptedPage.topicId !== input.topicId)
    return { kind: 'reload' };
  const previous = input.messages.find(row => row.id === message.id);
  if (previous) {
    if (previous.conversationId !== message.conversationId || previous.topicId !== message.topicId
      || previous.sequence !== message.sequence || previous.authorId !== message.authorId || previous.createdAt !== message.createdAt)
      return { kind: 'reload' };
    if ((previous.revision ?? 1) > (message.revision ?? 1)) return { kind: 'duplicate' };
    if ((previous.revision ?? 1) !== (message.revision ?? 1)) return { kind: 'reload' };
    // A persisted empty draft can arrive after its live stream has advanced.
    // Keep that stream, rather than replacing it with an earlier empty row.
    if (message.isReplyDraft && previous.isReplyDraft && !previous.sourceUnavailable) return { kind: 'duplicate' };
    const semantic = (row: CompanionMessage) => JSON.stringify([row.kind, row.status, row.content, row.attachments, row.replyToId,
      row.toolPolicy, row.audience, row.worldCreatedAt, row.worldTimeZone, row.sourceUnavailable, row.isReplyDraft]);
    return { kind: semantic(previous) === semantic(message) ? 'duplicate' : 'reload' };
  }
  if (input.messages.some(row => row.sequence === message.sequence)) return { kind: 'reload' };
  if (input.messages.length && message.sequence < input.messages[0]!.sequence) return { kind: 'ignore' };
  const merged = [...input.messages, message].sort((left, right) => left.sequence - right.sequence);
  const messages = trimMessageWindow(merged, 'newer');
  return { kind: 'append', messages, trimmed: messages.length < merged.length, sequence: message.sequence };
}
