import type { CompanionConnection } from './store';

/** Check every persisted DSH task slot, including failed attempts before a repair. */
export function verifyCompanionActionSlots(db: CompanionConnection, input: {
  companionId: string; conversationId: string; sourceMessageId: string; parentMessageId: string;
  turns: readonly { calls: readonly { id: string; name: string; arguments: string }[] }[];
  actionIds?: readonly string[]; authorizationGrantId?: string;
}): void {
  const slots = new Set<string>();
  input.turns.forEach((turn, index) => turn.calls.forEach(call => {
    if (call.name !== 'dsh') return;
    const args = JSON.parse(call.arguments) as { operation?: string; tasks?: unknown[] };
    if (args.operation === 'run') for (let task = 0; task < Math.max(1, args.tasks?.length ?? 0); task++) slots.add(`${index}:${call.id}:${task}`);
  }));
  if (slots.size && !input.actionIds?.length) throw new Error('目标调用了现实执行能力，但没有提供子任务证据。');
  const supported = new Set<string>(); let succeeded = 0;
  for (const id of new Set(input.actionIds ?? [])) {
    const saved = db.prepare('SELECT data,status FROM actions WHERE id=?').get(id) as { data: string; status: string } | undefined;
    const action = saved ? JSON.parse(saved.data) as { companionId: string; conversationId: string; sourceMessageId: string;
      parentMessageId?: string; toolCallId?: string; taskId?: string; authorizationGrantId?: string } : undefined;
    if (!action || !saved || !['succeeded', 'failed', 'cancelled'].includes(saved.status)
      || saved.status === 'succeeded' && !action.taskId
      || action.companionId !== input.companionId || action.conversationId !== input.conversationId
      || action.sourceMessageId !== input.sourceMessageId || action.parentMessageId !== input.parentMessageId
      || input.authorizationGrantId !== undefined && action.authorizationGrantId !== input.authorizationGrantId
      || !action.toolCallId || !slots.has(action.toolCallId)) throw new Error('现实子任务缺少同一目标内的真实终态证据。');
    supported.add(action.toolCallId); if (saved.status === 'succeeded') succeeded++;
  }
  if ([...slots].some(slot => !supported.has(slot))) throw new Error('目标仍有缺少实际结果的执行步骤。');
  if (slots.size && !succeeded) throw new Error('目标的所有现实执行尝试均未成功，不能完成。');
}
