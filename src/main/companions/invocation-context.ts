import type { CompanionMessage } from '../../shared/companions';

/** One independent reasoning stream. Shared persona and VCP memory never imply a shared message port. */
export interface CompanionInvocationContext {
  id: string;
  kind: 'player' | 'peer' | 'self' | 'schedule' | 'activity' | 'work' | 'collaboration';
  companionId: string;
  conversationId: string;
  topicId?: string;
  sourceMessageId?: string;
  goal: string;
  parentInvocationId?: string;
  status: string;
  createdAt: string;
  participants?: readonly string[];
  messagePort: { kind: 'conversation' } | { kind: 'invocation'; messageIds: readonly string[] };
  authorization: { kind: 'player' | 'peer' | 'self'; sourceMessageIds: readonly string[]; externalActions: boolean; grantId?: string };
}

export interface CompanionInvocationInput {
  companion: { id: string };
  conversation: { id: string };
  messages: readonly CompanionMessage[];
  sourceMessage?: CompanionMessage;
  taskRequest?: { sourceMessageId: string; prompt: string };
  proactive?: boolean;
  invocation?: CompanionInvocationContext;
}

/** Assemble every entry through the same identity and message-port checks before model context is built. */
export function assembleCompanionInvocation(input: CompanionInvocationInput) {
  const supplied = input.invocation;
  if (supplied && (supplied.companionId !== input.companion.id || supplied.conversationId !== input.conversation.id)) {
    throw new Error('伙伴调用身份或消息入口不匹配，不能合并其他伙伴或入口的近期上下文。');
  }
  const portIds = supplied?.messagePort.kind === 'invocation' ? new Set(supplied.messagePort.messageIds) : undefined;
  const topicId = supplied ? supplied.topicId : input.sourceMessage ? input.sourceMessage.topicId
    : (input.taskRequest ? input.messages.find(message => message.id === input.taskRequest!.sourceMessageId) : input.messages.findLast(message => message.conversationId === input.conversation.id && message.authorId !== input.companion.id))?.topicId;
  const messages = input.messages.filter(message => message.conversationId === input.conversation.id && message.topicId === topicId && (!portIds || portIds.has(message.id)));
  const requestedId = supplied?.sourceMessageId ?? input.taskRequest?.sourceMessageId;
  const candidate = input.sourceMessage ?? (requestedId ? messages.find(message => message.id === requestedId) : messages.findLast(message => message.authorId !== input.companion.id));
  const source = candidate?.conversationId === input.conversation.id && (!requestedId || candidate.id === requestedId)
    && candidate.topicId === topicId
    && (!portIds || portIds.has(candidate.id)) && candidate.status === 'sent' && !candidate.isReplyDraft && !candidate.replyDraft ? candidate : undefined;
  const kind = input.proactive ? 'self' : source?.authorId === 'user' ? 'player' : 'peer';
  const invocation: CompanionInvocationContext = supplied ?? {
    id: `${input.companion.id}:${input.conversation.id}:${requestedId ?? source?.id ?? 'opportunity'}`,
    kind, companionId: input.companion.id, conversationId: input.conversation.id, topicId,
    sourceMessageId: source?.id, goal: source && input.taskRequest?.sourceMessageId === source.id ? input.taskRequest.prompt : source?.content ?? '根据当前真实情况自然回应。',
    status: 'running', createdAt: source?.createdAt ?? new Date().toISOString(),
    messagePort: { kind: 'conversation' },
    authorization: { kind: source?.authorId === 'user' && !input.proactive ? 'player' : kind === 'peer' ? 'peer' : 'self',
      sourceMessageIds: source ? [source.id] : [], externalActions: source?.authorId === 'user' && !input.proactive },
  };
  const allowed = invocation.messagePort.kind === 'invocation' ? new Set(invocation.messagePort.messageIds) : undefined;
  return { invocation, source, messages: allowed ? messages.filter(message => allowed.has(message.id)) : messages };
}
