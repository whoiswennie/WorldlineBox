import type { CompanionMessage } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

/** Only a semantically verified current human goal can create this continuation.
 * SQLite reads the original source and actual outbox; model prose is no receipt. */
export async function ensureCompanionSocialContinuation(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, input: {
  contact: { allowed: boolean; intent: 'visit' | 'message'; requiresContinuation: boolean };
  companionId: string; source: CompanionMessage; deliveryClientId: string; operation: 'message' | 'introduce' | 'create_group';
}) {
  if (!input.contact.allowed || !input.contact.requiresContinuation || input.contact.intent !== 'message') return undefined;
  if (input.source.authorId !== 'user' || input.source.status !== 'sent' || input.source.isReplyDraft) throw new Error('持续社交目标必须来自本次真实用户消息。');
  const response = await request({ type: 'activity.social.ensure', companionId: input.companionId,
    conversationId: input.source.conversationId, sourceMessageId: input.source.id,
    deliveryClientId: input.deliveryClientId, operation: input.operation });
  if (!response.ok || !response.activityTask) throw new Error('持续社交目标没有成功保存，不能承诺自动跟进。');
  return response.activityTask;
}
