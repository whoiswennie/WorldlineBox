import type { CompanionReplyInput } from './context';
import { companionIdentity } from './identity';

function escape(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** Reject only explicit identity claims and unambiguous address errors; quoted discussion and domain JSON are not salutations. */
export function companionReplyIdentityIssue(text: string, input: CompanionReplyInput): string | undefined {
  if (!text.trim() || /^[\s`]*[[{]/u.test(text)) return;
  const identity = companionIdentity({ companion: input.companion, conversation: input.conversation, source: input.sourceMessage,
    members: input.members, directory: input.identityDirectory, audience: input.audience, publicProfiles: input.publicProfiles });
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '');
  // Short agreements can legitimately match. A whole substantial peer speech
  // copied as this role's own utterance is an unambiguous author mix-up.
  const copied = normalized.length >= 80 && input.messages.find(message => message.conversationId === input.conversation.id
    && message.topicId === input.sourceMessage?.topicId && message.authorId !== input.companion.id
    && message.authorId !== 'user' && message.authorId !== 'system' && message.status === 'sent'
    && !message.isReplyDraft && message.content.normalize('NFKC').replace(/\s+/gu, '') === normalized);
  if (copied) return `你正在完整复述另一位伙伴（${copied.authorId}）的长段发言并当作自己的话。本轮self固定为${input.companion.name}（${input.companion.id}），当前来信作者是${input.sourceMessage?.authorId ?? '未知'}。请以自己的身份回应这位作者，不能接替其角色、自称对方或原样复制其报名与自述。短句同意、明确标注的引文讨论可自然表达。`;
  for (const person of identity.participants) if (person.id !== input.companion.id && person.name !== input.companion.name
    && new RegExp('^\\s*我(?:是|叫)\\s*[「“"‘]?' + escape(person.name) + '[」”"’]?(?:[，,。.!！\\s]|$)', 'u').test(text)) {
    return `本轮真实发言者固定为${input.companion.name}（${input.companion.id}），不得自称${person.name}（${person.id}）。请依据原目标重新作答。`;
  }
  if (input.sourceMessage?.authorId !== 'user' || input.sourceMessage.conversationId !== input.conversation.id) return;
  const label = /^\s*(姐姐|妹妹)[，,！!：:、\s]/u.exec(text)?.[1];
  if (!label || !identity.characterRelations.some(relation => relation.label === label)) return;
  const player = identity.participants.find(person => person.id === 'user');
  if (player?.name === label) return;
  const nickname = new RegExp('^(?:以后|今后|从现在起)?\\s*(?:请|你可以|你就)?\\s*(?:叫我|称呼我)(?:为)?[「“"‘]?' + label + '(?:[」”"’，,。.!！\\s]|$)', 'u');
  if ([input.sourceMessage, ...input.messages].some(message => message.conversationId === input.conversation.id && message.authorId === 'user'
    && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft && nickname.test(message.content))) return;
  return `本轮回应的是独立真人玩家（user）；${label}是角色设定中另一伙伴的关系称呼，不是玩家身份。请保持自己的身份并重新自然作答。`;
}
