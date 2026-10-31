import type { CompanionAction, CompanionMessage } from '../../shared/companions';

export interface CompanionReplyPart {
  step: number;
  text: string;
  actionIds: string[];
  streaming: boolean;
}

/** Keep speech in order and retain every real call once. Consecutive tool-only
 * turns share one process entry instead of manufacturing extra speech cards. */
export function companionReplyParts(segments: NonNullable<CompanionMessage['segments']>, streamingStep?: number): CompanionReplyPart[] {
  const parts: CompanionReplyPart[] = [], seen = new Set<string>();
  for (const [step, segment] of segments.entries()) {
    const actionIds = segment.actionIds.filter(id => { if (seen.has(id)) return false; seen.add(id); return true; });
    const streaming = streamingStep === step;
    if (!segment.text.trim() && !streaming && !actionIds.length) continue;
    const previous = parts.at(-1);
    if (!segment.text.trim() && !streaming && previous && !previous.text.trim() && !previous.streaming) previous.actionIds.push(...actionIds);
    else parts.push({ step, text: segment.text, actionIds, streaming });
  }
  return parts;
}

/** Host audience follows the actual source/loop, never the capability name.
 * Unknown details stay loadable; a different owner's action cannot hide a row. */
export function companionAgendaOnlyMessage(message: CompanionMessage, actions: readonly CompanionAction[] = []): boolean {
  return message.audience === 'agenda' || !!message.actionId && actions.some(action => action.id === message.actionId
    && action.companionId === message.authorId && action.conversationId === message.conversationId && action.capability?.audience === 'agenda');
}
export function companionChatActionIds(message: CompanionMessage, ids: string[], actions: readonly CompanionAction[]): string[] {
  return ids.filter(id => !actions.some(action => action.id === id && action.companionId === message.authorId
    && action.conversationId === message.conversationId && action.capability?.audience === 'agenda'));
}

/** Agenda-only receipts remain in their execution records. Suppress exact
 * duplicates of visible conversation calls; off-page conversation calls stay. */
export function companionTimelineActionEntries(messages: CompanionMessage[], actions: readonly CompanionAction[] = []): CompanionMessage[] {
  messages = messages.filter(message => !companionAgendaOnlyMessage(message, actions));
  const key = (message: CompanionMessage, actionId: string) => JSON.stringify([message.conversationId, message.authorId, message.topicId ?? null, actionId]);
  const attached = new Set(messages.filter(message => !message.sourceUnavailable && message.kind !== 'action')
    .flatMap(message => (message.segments ?? []).flatMap(part => part.actionIds.map(id => key(message, id)))));
  const standalone = new Map<string, CompanionMessage>();
  for (const message of messages) if (message.kind === 'action' && message.actionId) {
    const identity = key(message, message.actionId), previous = standalone.get(identity);
    if (!previous || !message.sourceUnavailable || previous.sourceUnavailable) standalone.set(identity, message);
  }
  return messages.filter(message => message.kind !== 'action' || !message.actionId
    || !attached.has(key(message, message.actionId)) && standalone.get(key(message, message.actionId)) === message);
}
