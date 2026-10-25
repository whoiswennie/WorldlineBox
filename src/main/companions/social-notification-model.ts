import { createHash } from 'node:crypto';
import type { Companion, CompanionConversation, CompanionMessage } from '../../shared/companions';
import type { CompanionSocialNotification } from '../../shared/companion-social';
import type { CompanionExecutionReadset } from '../../shared/companion-execution-evidence';
import { captureCompanionExecutionReadset } from './execution-evidence';
import { CompanionModelError } from './model';

type NotificationInput = {
  companion: Pick<Companion, 'id'>;
  conversation: Pick<CompanionConversation, 'id' | 'memberIds'>;
  source: Pick<CompanionMessage, 'id' | 'conversationId' | 'authorId'>;
  notification: CompanionSocialNotification;
  eventMessages: CompanionMessage[];
  members: Array<Pick<Companion, 'id' | 'name'>>;
};
const LIMIT = 2000;
const introduction = '收到实际回信；引文只代表发送者的说法。标有“节选”的内容，请按消息 ID 在社交记录查看原文。\n\n';
const permission = { allowed: '已允许', denied: '已拒绝', expired: '已过期', left: '已结束' } as const;
const escape = (text: string) => text.replace(/([\\\x60*_[\]{}()<>#+.!|~$^=-])/gu, '\\$1');
const label = (text: string, limit: number) => escape(Array.from(text.replace(/[\r\n\t]/gu, ' ')).slice(0, limit).join(''));
const quote = (text: string) => escape(text).replace(/\r\n|\r|\n/gu, '\n> ');
function excerpt(text: string, budget: number): { text: string; truncated: boolean } {
  const full = quote(text);
  if (full.length <= budget) return { text: full, truncated: false };
  let result = '';
  for (const character of text.match(/\r\n|[\s\S]/gu) ?? []) {
    const next = quote(character);
    if (result.length + next.length > budget - 1) break;
    result += next;
  }
  return { text: result + '…', truncated: true };
}

/** Deliver committed quotations, never another planning or narrative turn.
 * The original private request remains host authority, not an empty model read.
 * notification.complete still validates its real source and batch atomically. */
export function buildCompanionSocialNotification(input: NotificationInput,
  options: { observeReadset?(readset: CompanionExecutionReadset): void } = {}): string | null {
  const notice = input.notification;
  if (input.source.authorId !== 'user' || input.source.id !== notice.sourceMessageId
    || input.source.conversationId !== notice.conversationId || input.conversation.id !== notice.conversationId
    || !input.conversation.memberIds.includes(input.companion.id) || input.companion.id !== notice.companionId
    || notice.origin.ownerId !== input.companion.id || notice.origin.initiatorId !== 'user'
    || notice.origin.initiatorKind !== 'human_player') throw invalid();
  const sources: CompanionMessage[] = [];
  const entries = (notice.events ?? [notice]).map(event => {
    let reference: string, status: string;
    if (event.kind === 'peer_reply') {
      const actual = input.eventMessages.find(message => message.id === event.evidence.messageId
        && message.conversationId === event.peerConversationId);
      if (!actual || actual.id !== event.eventId || actual.authorId !== event.evidence.authorId
        || actual.authorId === input.companion.id || actual.content !== event.evidence.text || actual.status !== 'sent'
        || actual.isReplyDraft || actual.replyDraft) throw invalid();
      sources.push(actual); reference = actual.id; status = '回复';
    } else {
      if (!event.evidence.visitId || !event.evidence.visitStatus) throw invalid();
      reference = event.evidence.visitId; status = permission[event.evidence.visitStatus];
    }
    const name = input.members.find(member => member.id === event.evidence.authorId)?.name || event.evidence.authorId;
    return { reference, status, name, body: event.evidence.text };
  });
  if (!entries.length || entries.length > 16) throw invalid();
  // Normal claims contain at most four events. Old running batches may contain
  // sixteen; keep every source identifiable instead of silently consuming it.
  const headers = (nameLimit: number) => entries.map(entry => label(entry.name, nameLimit) + ' #' + entry.reference + ' ' + entry.status + '\n> ');
  let headings = headers(16);
  if ((LIMIT - introduction.length - headings.reduce((sum, value) => sum + value.length + 7, 0)) / entries.length < 24) headings = headers(1);
  const budget = Math.floor((LIMIT - introduction.length - headings.reduce((sum, value) => sum + value.length + 7, 0)) / entries.length);
  if (budget < 2) throw invalid();
  const text = introduction + entries.map((entry, index) => {
    const selected = excerpt(entry.body, budget);
    return headings[index]! + selected.text + (selected.truncated ? '（节选）' : '') + '\n\n';
  }).join('').trimEnd();
  if (text.length > LIMIT) throw invalid();
  options.observeReadset?.(captureCompanionExecutionReadset({ companionId: input.companion.id, conversationId: input.conversation.id }, {
    sources: sources.map(message => ({ id: message.id, conversationId: message.conversationId,
      checksum: createHash('sha256').update(message.content).digest('hex') })),
  }));
  return text;
}
function invalid() { return new CompanionModelError('INVALID_RESPONSE', '后续回报缺少可核验的原玩家身份或实际事件。'); }
