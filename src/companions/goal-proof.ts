import type { CompanionConnection } from './store';
import { verifyCompanionActionSlots } from './goal-action-proof';

/** A completed parent is supported by its persisted brain loop and every real
 * execution attempt. One successful child alone never completes the parent. */
export function verifyCompanionGoalProof(db: CompanionConnection, input: {
  kind: 'work' | 'schedule'; id: string; companionId: string; conversationId: string; sourceMessageId: string;
  instruction: string; authorizationSourceMessageIds: readonly string[]; goalInvocationId?: string; goalSlot?: string;
  result?: string; actionIds?: readonly string[];
}): void {
  if (input.goalInvocationId !== input.id || !input.goalSlot || !input.result) throw new Error('目标需要独立主脑记录和最终结果。');
  const saved = db.prepare('SELECT value FROM metadata WHERE key=?').get(`loop/${input.sourceMessageId}/${input.companionId}/invocation/${input.goalSlot}`) as { value: string } | undefined;
  if (!saved) throw new Error('现实目标的主脑记录不存在。');
  const loop = JSON.parse(saved.value) as { status: string; companionId: string; conversationId: string; sourceMessageId: string; messageId?: string;
    context?: { user: string }; turns: Array<{ text: string; calls: Array<{ id: string; name: string; arguments: string }> }> };
  const invocation = loop.context ? (JSON.parse(loop.context.user) as { invocation?: { id: string; kind: string; companionId: string;
    conversationId: string; goal: string; authorization?: { externalActions: boolean; sourceMessageIds: string[] } } }).invocation : undefined;
  if (loop.status !== 'done' || loop.companionId !== input.companionId || loop.conversationId !== input.conversationId
    || loop.sourceMessageId !== input.sourceMessageId || !loop.messageId || invocation?.id !== input.id || invocation.kind !== input.kind
    || invocation.companionId !== input.companionId || invocation.conversationId !== input.conversationId
    || !invocation.goal.includes(input.instruction) || !invocation.authorization?.externalActions
    || input.authorizationSourceMessageIds.some(id => !invocation.authorization!.sourceMessageIds.includes(id))
    || loop.turns.at(-1)?.text !== input.result) throw new Error('主脑目标、来源、当前要求或最终结论不匹配。');
  verifyCompanionActionSlots(db, { ...input, parentMessageId: loop.messageId, turns: loop.turns });
}
