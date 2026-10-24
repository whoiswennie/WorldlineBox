import type { CompanionMessage } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

type ContactRoute = { requiresCollaboration?: boolean };
type SocialOperation = 'message' | 'introduce' | 'create_group' | 'social';

/** Routing feedback never creates, widens or accepts an execution grant. */
export function assertCompanionSocialTaskRoute(contact: ContactRoute, operation: SocialOperation): void {
  if (contact.requiresCollaboration && operation !== 'introduce') throw new Error('本次真人目标要求另一位真实伙伴独立完成现实子任务。普通message/social/create_group只发送社交文字，不创建执行grant，也不会等待DSH产物；不能以activity.social保存为持续电脑工作。请先核实contacts；若尚不认识，query people并introduce实际送达。然后用world(action=collaborate,title,goal,participantIds,sourceMessageId,evidence,assignments:[{companionId,goal}])登记当前原用户明确授权的分工，等待受邀者自主接受和真实结果后再继续汇总。此提示不代表对方已经接受。');
}

/** Every social receipt says exactly which follow-up, if any, was persisted. */
export function companionSocialDeliveryReceipt(operation: SocialOperation, contact: ContactRoute,
  activityTask?: { id: string; status: string }) {
  return { socialOnly: true, operation, executionGrantCreated: false, collaborationCreated: false,
    continuationKind: activityTask ? 'virtual_social_activity' : 'none',
    ...(activityTask ? { continuationId: activityTask.id, continuationStatus: activityTask.status } : {}),
    ...(contact.requiresCollaboration ? { nextAction: 'collaborate' as const, guidance: '本次只完成社交联系。现实分工尚未登记，须以当前真人来源和逐字授权提交collaborate，不能承诺对方已开始或稍后自动交付。' } : {}) } as const;
}

/** Only a semantically verified current human goal can create this continuation.
 * SQLite reads the original source and actual outbox; model prose is no receipt. */
export async function ensureCompanionSocialContinuation(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, input: {
  contact: { allowed: boolean; intent: 'visit' | 'message'; requiresContinuation: boolean; requiresCollaboration?: boolean };
  companionId: string; source: CompanionMessage; deliveryClientId: string; operation: 'message' | 'introduce' | 'create_group';
}) {
  if (!input.contact.allowed || input.contact.requiresCollaboration || !input.contact.requiresContinuation || input.contact.intent !== 'message') return undefined;
  if (input.source.authorId !== 'user' || input.source.status !== 'sent' || input.source.isReplyDraft) throw new Error('持续社交目标必须来自本次真实用户消息。');
  const response = await request({ type: 'activity.social.ensure', companionId: input.companionId,
    conversationId: input.source.conversationId, sourceMessageId: input.source.id,
    deliveryClientId: input.deliveryClientId, operation: input.operation });
  if (!response.ok || !response.activityTask) throw new Error('持续社交目标没有成功保存，不能承诺自动跟进。');
  return response.activityTask;
}
