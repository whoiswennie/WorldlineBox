import { createHash } from 'node:crypto';
import type { CompanionMessage } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

export const COMPANION_ACTIVITY_HANDOFF_RULES = `activityHandoff只由宿主核验同一当前真人source、实际owner与有效非终态持久任务后给出。executor=background_activity表示该完整虚拟目标已有实际后台执行器；当前chat应查询必要的实际进展、诚实汇报已发生与未完成部分，然后结束本轮以释放执行lane，不继续作为第二个规划者发送邀约、改规则、建群或重复移动。它不表示原完整目标已经完成，不代表某次消息已送达。先前确认作用保留，不能重放；existingEffect只指准确稳定调用已有的实际旧回执，不是新授权。不同新真人source、真实DSH/协作、只读查询和取消管理仍按各自来源与权限处理。没有这个宿主凭证时不能编造已交接或声称后台在执行。`;
type Handoff = NonNullable<CompanionStorageResponse['activityHandoff']>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export const companionNativeSocialClientId = (callIdentity: string) => 'native_' + sha(callIdentity).slice(0, 48);

/** This is a host route, never a tool which the model can use to manufacture
 * a delegation. The worker rechecks the original checksum and task closure. */
export async function resolveCompanionActivityHandoff(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, input: {
  companionId: string; conversationId: string; source: CompanionMessage; clientId?: string;
}): Promise<Handoff | undefined> {
  const { source } = input;
  if (source.authorId !== 'user' || source.status !== 'sent' || source.isReplyDraft || source.replyDraft
    || source.conversationId !== input.conversationId) return;
  const result = await request({ type: 'activity.handoff', companionId: input.companionId, conversationId: input.conversationId,
    sourceMessageId: source.id, sourceChecksum: sha(source.content), ...(input.clientId ? { clientId: input.clientId } : {}) });
  const handoff = result.activityHandoff, task = handoff?.task;
  if (!result.ok || !handoff || !task || task.companionId !== input.companionId || task.conversationId !== input.conversationId
    || task.sourceMessageId !== source.id || task.historyAvailable !== true || !['queued', 'running', 'waiting'].includes(task.status)) return;
  return handoff;
}

export function companionMainVirtualMutation(name: string, input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const action = (input as { action?: unknown }).action;
  if (name === 'topic') return typeof action === 'string' && !['read', 'list'].includes(action);
  return name === 'world' && typeof action === 'string'
    && ['introduce', 'create_group', 'leave', 'move', 'travel', 'share_entrance', 'interact', 'visit', 'respond', 'social', 'message'].includes(action);
}
