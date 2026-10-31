import { companionIdSchema } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;

/** A task's synthetic message port is not a real relationship scope. Goals
 * enter only its actual member room, or one exact host-authorized live origin.
 * Never infer the owner's private room from a task prefix or owner identity. */
export async function companionModelCultivationScope(owner: string, data: Record<string, unknown>,
  request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>): Promise<string | undefined> {
  const identity = object(data.identity), reply = object(identity?.currentReply), invocation = object(data.invocation);
  const current = reply?.conversationId ?? invocation?.conversationId ?? data.conversationId;
  const actual = async (value: unknown) => {
    const id = companionIdSchema.safeParse(value); if (!id.success) return { exists: false };
    const response = await request({ type: 'state', companionId: owner, conversationId: id.data, includeHidden: true, includeConversations: true });
    if (!response.ok || !response.state?.companions.some(companion => companion.id === owner)) throw new Error('培养方向的实际伙伴范围暂不可核验。');
    const room = response.state.conversations.find(room => room.id === id.data);
    return { exists: !!room, scope: room?.memberIds.includes(owner) ? room.id : undefined };
  };
  const room = await actual(current);
  if (room.exists) return room.scope;
  const source = object(data.source), authorization = object(invocation?.authorization);
  const authorizedIds = authorization?.sourceMessageIds;
  if (!source || typeof source.id !== 'string' || !Array.isArray(authorizedIds) || !authorizedIds.includes(source.id)
    || invocation?.sourceMessageId && invocation.sourceMessageId !== source.id) return;
  const origin = await actual(source.conversationId); if (!origin.scope) return;
  const checked = await request({ type: 'memory.sources.filter', companionId: owner, conversationId: origin.scope, ids: [source.id] });
  if (!checked.ok) throw new Error(checked.error ?? '培养方向的原始任务来源暂不可核验。');
  const live = checked.memorySources?.find(message => message.id === source.id && message.conversationId === origin.scope
    && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft);
  if (!live || typeof source.content === 'string' && source.content !== live.content
    || typeof source.revision === 'number' && source.revision !== live.revision) return;
  return origin.scope;
}
