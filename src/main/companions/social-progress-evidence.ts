import { createHash } from 'node:crypto';
import type { CompanionMessage } from '../../shared/companions';
import { companionStorageResponseSchema } from '../../shared/companion-storage';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';
import type { CompanionSocialNotification } from '../../shared/companion-social';
import type { CompanionActivityTask } from '../../shared/companion-activity-task';

export function socialProgressFingerprint(message: CompanionMessage): string {
  return createHash('sha256').update(JSON.stringify([message.id, message.conversationId, message.topicId ?? null,
    message.authorId, message.content, message.status, message.replyToId ?? null])).digest('hex');
}

/** Only native call/result pairs in the current authorized invocation count as
 * effects. A successful handoff is explicitly not a successful message send.
 * Arguments identify the proposal; only the typed host receipt proves delivery.
 * Only the exact current invocation's confirmed sent body is included; failed
 * proposal bodies and unrelated other-room dialogue never cross this view. */
export function socialProgressActions(turns: readonly CompanionLoopTurn[], proposedCalls: readonly CompanionLoopCall[] = []) {
  const actions: Array<{ callId: string; action: string; proposedRecipientIds: string[];
    delivery: 'proposed' | 'not_dispatched' | 'sent' | 'queued' | 'failed' | 'unconfirmed';
    recipientIds?: string[]; messageId?: string; conversationId?: string; topicId?: string; taskId?: string;
    taskStatus?: CompanionActivityTask['status']; sentContent?: string }> = [];
  const collect = (call: CompanionLoopCall, result?: string, proposed = false) => {
    try {
      const normalized = normalizeCompanionCapabilityCall(call), args = JSON.parse(normalized.arguments);
      if (normalized.name !== 'world' || !['message', 'social', 'introduce', 'create_group'].includes(args.action)) return;
      const parsed = result ? companionStorageResponseSchema.safeParse(JSON.parse(result)) : undefined;
      const receipt = parsed?.success ? parsed.data : undefined;
      const handoff = receipt?.activityHandoff;
      const candidate = receipt?.ok ? receipt.socialMessage : undefined;
      const sent = candidate?.message.status === 'sent' && !candidate.message.isReplyDraft && !candidate.message.replyDraft ? candidate : undefined;
      const notDispatched = handoff?.newVirtualActionDispatched === false && !handoff.existingEffect;
      actions.push({ callId: call.id, action: args.action,
        proposedRecipientIds: args.recipientIds ?? (args.targetCompanionId ? [args.targetCompanionId] : []),
        delivery: proposed ? 'proposed' : notDispatched ? 'not_dispatched' : receipt?.ok === false ? 'failed'
          : sent ? 'sent' : receipt?.socialPending === true ? 'queued' : 'unconfirmed',
        ...(sent && !notDispatched ? { messageId: sent.message.id, recipientIds: sent.recipientIds,
          conversationId: sent.message.conversationId, sentContent: sent.message.content, ...(sent.message.topicId ? { topicId: sent.message.topicId } : {}) } : {}),
        ...(handoff ? { taskId: handoff.task.id, taskStatus: handoff.task.status } : {}) });
    } catch { /* Malformed/external results cannot manufacture native effects. */ }
  };
  for (const turn of turns) for (const call of turn.calls) collect(call, turn.results?.find(result => result.callId === call.id)?.content);
  for (const call of proposedCalls) collect(call, undefined, true);
  return actions;
}

/** Only matching typed host receipts count as having read delegated replies or
 * the exact outgoing body returned by a current native delivery. */
export function socialProgressReads(turns: readonly CompanionLoopTurn[]): Map<string, CompanionMessage> {
  const reads = new Map<string, CompanionMessage>();
  for (const turn of turns) for (const call of turn.calls) {
    try {
      const normalized = normalizeCompanionCapabilityCall(call);
      const action = JSON.parse(normalized.arguments).action;
      const delegated = normalized.name === 'activity' && action === 'progress';
      const ownDelivery = normalized.name === 'world' && ['message', 'social', 'introduce', 'create_group'].includes(action);
      if (!delegated && !ownDelivery) continue;
      const result = turn.results?.find(result => result.callId === call.id);
      if (!result) continue;
      const parsed = companionStorageResponseSchema.safeParse(JSON.parse(result.content));
      if (!parsed.success || !parsed.data.ok) continue;
      if (ownDelivery) {
        const message = parsed.data.socialMessage?.message;
        if (message && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft
          && !(parsed.data.activityHandoff?.newVirtualActionDispatched === false && !parsed.data.activityHandoff.existingEffect)) reads.set(message.id, message);
        continue;
      }
      if (!parsed.data.activityTask || parsed.data.activityTask.id !== JSON.parse(normalized.arguments).id || parsed.data.activityTask.historyAvailable === false) continue;
      const origins = parsed.data.activityMessageOrigins ?? [];
      for (const message of parsed.data.activityMessages ?? []) if (origins.some(origin => origin.messageId === message.id
        && origin.conversationId === message.conversationId && origin.topicId === message.topicId)) reads.set(message.id, message);
    } catch { /* Invalid or external lookalike JSON is never a host read receipt. */ }
  }
  for (const item of socialProgressOutbound(turns)?.outbound ?? []) reads.set(item.message.id, item.message);
  return reads;
}

/** Historical outgoing bodies are evidence only after this invocation actually
 * reads the exact task's typed progress response. They are never new effects. */
export function socialProgressOutbound(turns: readonly CompanionLoopTurn[]): CompanionSocialNotification['progressEvidence'] {
  const receipts: NonNullable<CompanionSocialNotification['progressEvidence']>[] = [];
  for (const turn of turns) for (const call of turn.calls) {
    try {
      const normalized = normalizeCompanionCapabilityCall(call), args = JSON.parse(normalized.arguments);
      if (normalized.name !== 'activity' || args.action !== 'progress') continue;
      const result = turn.results?.find(item => item.callId === call.id);
      if (!result) continue;
      const parsed = companionStorageResponseSchema.safeParse(JSON.parse(result.content));
      if (!parsed.success || !parsed.data.ok) continue;
      const { activityTask: task, activityProgressEvidence: evidence } = parsed.data;
      if (!task || task.id !== args.id || task.historyAvailable === false || !evidence) continue;
      if (evidence.outbound.some(item => item.message.authorId !== task.companionId || item.message.status !== 'sent'
        || item.message.isReplyDraft || item.message.replyDraft)) continue;
      receipts.push(evidence);
    } catch { /* Only an exact, valid native progress receipt grants this view. */ }
  }
  if (!receipts.length) return undefined;
  const outbound = [...new Map(receipts.flatMap(receipt => receipt.outbound).map(item => [item.message.id, item])).values()];
  return { observationChecksum: createHash('sha256').update(JSON.stringify(receipts.map(receipt => receipt.observationChecksum))).digest('hex'),
    outbound: outbound.slice(-100), complete: outbound.length <= 100 && receipts.every(receipt => receipt.complete) };
}

/** Reuse only a group actually created by this invocation, never a global match. */
export function createdSocialPort(turns: readonly CompanionLoopTurn[], owner: string, recipients: readonly string[]) {
  const members = JSON.stringify([owner, ...recipients].sort());
  for (const turn of [...turns].reverse()) for (const call of [...turn.calls].reverse()) {
    try {
      const normalized = normalizeCompanionCapabilityCall(call);
      if (normalized.name !== 'world' || JSON.parse(normalized.arguments).action !== 'create_group') continue;
      const result = turn.results?.find(result => result.callId === call.id);
      if (!result) continue;
      const parsed = companionStorageResponseSchema.safeParse(JSON.parse(result.content));
      const room = parsed.success && parsed.data.ok ? parsed.data.socialConversation : undefined;
      if (room && JSON.stringify([...room.memberIds].sort()) === members) return { roomId: room.id,
        ...(parsed.success && parsed.data.topic ? { topicId: parsed.data.topic.id } : {}) };
    } catch { /* A failed or untyped creation is not a routing receipt. */ }
  }
  return undefined;
}
