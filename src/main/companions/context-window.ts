import type { CompanionMessage } from '../../shared/companions';

/** Dialogue selection is replaceable independently of persona, VCP recall and the reasoning loop. */
export interface CompanionDialogueWindowPolicy { days: number; maxMessages: number; maxChars: number; minimumMessages: number }
export const COMPANION_DIALOGUE_WINDOW: Readonly<CompanionDialogueWindowPolicy> = {
  days: 7, maxMessages: 256, maxChars: 480_000, minimumMessages: 32,
};

/** Keep complete, contiguous recent messages. The current source is retained even when it alone exceeds the window. */
export function selectCompanionDialogue(messages: readonly CompanionMessage[], options: {
  conversationId: string; source?: CompanionMessage; throughSequence?: number; proactive?: boolean; policy?: Readonly<CompanionDialogueWindowPolicy>;
}) {
  const policy = options.policy ?? COMPANION_DIALOGUE_WINDOW;
  const available = messages.filter(message => message.conversationId === options.conversationId && message.status === 'sent'
    && !message.isReplyDraft && !message.replyDraft && (options.proactive || !options.source || message.sequence <= options.source.sequence
      || message.sequence <= (options.throughSequence ?? options.source.sequence) && message.authorId !== 'user' && message.replyToId === options.source.id))
    .sort((left, right) => left.sequence - right.sequence);
  const anchor = Date.parse(options.source?.createdAt ?? available.at(-1)?.createdAt ?? '');
  const earliest = anchor - policy.days * 86_400_000;
  const selected: CompanionMessage[] = [];
  let chars = 0;
  for (const message of [...available].reverse()) {
    const required = message.id === options.source?.id;
    if (!required && selected.length && (selected.length >= policy.maxMessages || chars + message.content.length > policy.maxChars
      || selected.length >= policy.minimumMessages && Number.isFinite(anchor) && Date.parse(message.createdAt) < earliest)) break;
    selected.push(message); chars += message.content.length;
  }
  const pinnedSource = available.find(message => message.id === options.source?.id);
  if (pinnedSource && !selected.some(message => message.id === pinnedSource.id)) { selected.push(pinnedSource); chars += pinnedSource.content.length; }
  selected.sort((left, right) => left.sequence - right.sequence);
  const first = selected[0];
  return { messages: selected, window: { policy, retainedMessages: selected.length, retainedChars: chars,
    omittedAvailableMessages: available.length - selected.length, oldestSequence: first?.sequence, throughSequence: options.throughSequence ?? options.source?.sequence ?? available.at(-1)?.sequence,
    nextBefore: first && first.sequence > 1 ? first.sequence : undefined,
    hasEarlier: !!first && first.sequence > 1, sourceRetainedWhole: !!options.source && selected.some(message => message.id === options.source?.id),
    read: { tool: 'world', action: 'history' }, trust: 'current_message_port_only' } };
}
