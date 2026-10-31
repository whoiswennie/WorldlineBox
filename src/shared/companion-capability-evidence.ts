import { createHash } from 'node:crypto';
import type { CompanionAction, CompanionConversation, CompanionMessage } from './companions';
import type { CompanionLoopCheckpoint } from './companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from './companion-storage';
import { normalizeCompanionCapabilityCall } from './companion-capability-tools';
import { companionCapabilityRecordId } from './companion-capability-id';
import { CompanionPermissionDeniedError } from './companion-permission';

export type CompanionCapabilityEvidenceIdentity = Pick<CompanionAction, 'id' | 'companionId' | 'conversationId' | 'capability'>;
export interface CompanionCapabilityEvidencePlanOptions {
  now?(): number; validateParentLoop?: boolean; throwTemporaryUnavailable?: boolean;
}
export type CompanionCapabilityActionView = Pick<CompanionAction, 'id' | 'companionId' | 'conversationId' | 'capability' | 'contentAvailable'
  | 'sourceMessageId' | 'parentMessageId' | 'loopStep' | 'toolCallId' | 'authorizationGrantId'>;
export type CompanionCapabilityLoopView = Pick<CompanionLoopCheckpoint, 'companionId' | 'conversationId' | 'sourceMessageId' | 'messageId' | 'invocationKey'>
  & { turns: Array<Pick<CompanionLoopCheckpoint['turns'][number], 'calls'>>; context?: { user: string } };
export type CompanionCapabilityReadResponse = Omit<CompanionStorageResponse, 'action' | 'state' | 'message' | 'loop'> & {
  action?: CompanionCapabilityActionView;
  state?: { companions: Array<{ id: string }>; conversations: Array<Pick<CompanionConversation, 'id' | 'kind' | 'peerOnly' | 'memberIds'>> };
  message?: Pick<CompanionMessage, 'id' | 'authorId' | 'conversationId' | 'replyToId'>;
  loop?: CompanionCapabilityLoopView;
};
export type CompanionCapabilityEvidenceStep = { kind: 'read'; command: CompanionStorageCommand }
  | { kind: 'parent'; loop: CompanionCapabilityLoopView; action: CompanionCapabilityActionView };
export type CompanionCapabilityEvidenceReply = CompanionCapabilityReadResponse | boolean;
const capabilityIdentity = (value: NonNullable<CompanionAction['capability']>) => JSON.stringify([
  value.name, value.callId, value.invocationId, value.agendaRunId ?? null, value.inputHash, value.audience ?? null,
]);

export class CompanionCapabilityEvidenceUnavailable extends Error {
  constructor(cause?: unknown) { super('能力过程的来源暂不可核验，请稍后重试。', { cause }); this.name = 'CompanionCapabilityEvidenceUnavailable'; }
}

/** Read visibility of one existing presentation record, never execution
 * authority or permission to replay a tool. Capability traces do not own a
 * second DSH executionReadset: their real parent/run supplies that boundary. */
export function* companionCapabilityEvidencePlan(action: CompanionCapabilityEvidenceIdentity,
  options: CompanionCapabilityEvidencePlanOptions = {}): Generator<CompanionCapabilityEvidenceStep, boolean, CompanionCapabilityEvidenceReply> {
  try {
    const read = function* (command: CompanionStorageCommand): Generator<CompanionCapabilityEvidenceStep, CompanionCapabilityReadResponse, CompanionCapabilityEvidenceReply> {
      try {
        const response = (yield { kind: 'read', command }) as CompanionCapabilityReadResponse;
        if (!response.ok) throw new CompanionCapabilityEvidenceUnavailable();
        return response;
      } catch (error) {
        if (error instanceof CompanionPermissionDeniedError) throw error;
        throw error instanceof CompanionCapabilityEvidenceUnavailable ? error : new CompanionCapabilityEvidenceUnavailable(error);
      }
    };
    const stored = (yield* read({ type: 'action.get', id: action.id })).action, capability = stored?.capability;
    if (!stored || !capability || action.capability !== undefined && capabilityIdentity(action.capability) !== capabilityIdentity(capability) || stored.contentAvailable === false || stored.companionId !== action.companionId || stored.conversationId !== action.conversationId
      || stored.id !== companionCapabilityRecordId({ companionId: stored.companionId, conversationId: stored.conversationId, invocationId: capability.invocationId }, capability.callId)
      || stored.toolCallId !== undefined && stored.toolCallId !== capability.callId) return false;
    const state = (yield* read({ type: 'state', companionId: stored.companionId, includeHidden: true })).state;
    const room = state?.conversations.find(room => room.id === stored.conversationId);
    if (!state?.companions.some(owner => owner.id === stored.companionId) || !room?.memberIds.includes(stored.companionId)) return false;
    const humanPrivate = room.kind === 'private' && !room.peerOnly && room.memberIds.length === 1;
    const privatePixels = ['observe', 'think'].includes(capability.name);
    if (privatePixels && (!humanPrivate || !capability.agendaRunId)) return false;
    if (stored.sourceMessageId) {
      const prefix = stored.sourceMessageId + ':' + stored.companionId;
      const invocationKey = capability.invocationId.startsWith(prefix + ':') ? capability.invocationId.slice(prefix.length + 1) : undefined;
      if (capability.invocationId !== prefix && !invocationKey) return false;
      const parent = stored.parentMessageId ? (yield* read({ type: 'message.get', id: stored.parentMessageId })).message : undefined;
      const loop = (yield* read(stored.parentMessageId ? { type: 'loop.for-message', messageId: stored.parentMessageId }
        : { type: 'loop.get', companionId: stored.companionId, sourceMessageId: stored.sourceMessageId, ...(invocationKey ? { invocationKey } : {}) })).loop;
      if (stored.parentMessageId && (!parent || parent.authorId !== stored.companionId || parent.conversationId !== stored.conversationId
        || parent.replyToId !== undefined && parent.replyToId !== stored.sourceMessageId || loop?.messageId !== stored.parentMessageId)
        || !loop || loop.companionId !== stored.companionId || loop.conversationId !== stored.conversationId
        || loop.sourceMessageId !== stored.sourceMessageId
        || capability.invocationId !== loop.sourceMessageId + ':' + loop.companionId + (loop.invocationKey ? ':' + loop.invocationKey : '')) return false;
      const turns = stored.loopStep === undefined ? loop.turns : [loop.turns[stored.loopStep]].filter(turn => turn !== undefined);
      const calls = turns.flatMap(turn => turn.calls).filter(call => call.id === capability.callId);
      // The durable begin is visible while a parent is publishing its turn.
      // Missing call/result history is not a source withdrawal; if the exact
      // call is already present, it must still name this recorded capability.
      if (calls.length && !calls.some(call => {
        try { return call.name === capability.name || normalizeCompanionCapabilityCall(call).name === capability.name; }
        catch { return call.name === capability.name; } // Failed argument calls are still real, visible calls.
      })) return false;
      let sourceOwner = stored.companionId, sourceRoom = stored.conversationId, expectedDigest: string | undefined;
      if (stored.authorizationGrantId) {
        const grant = (yield* read({ type: 'collaboration.read', id: stored.authorizationGrantId, companionId: stored.companionId })).collaboration;
        const participant = grant?.participants.find(participant => participant.companionId === stored.companionId && participant.conversationId === stored.conversationId);
        if (!grant || grant.status === 'cancelled' || grant.sourceMessageId !== stored.sourceMessageId || !participant || participant.accessRevokedAt
          || !['accepted', 'running', 'succeeded', 'failed'].includes(participant.status)) return false;
        sourceOwner = grant.ownerId; sourceRoom = grant.conversationId; expectedDigest = grant.sourceChecksum;
      }
      const source = (yield* read({ type: 'memory.sources.filter', companionId: sourceOwner, conversationId: sourceRoom, ids: [stored.sourceMessageId] })).memorySources
        ?.find(source => source.id === stored.sourceMessageId && source.conversationId === sourceRoom && source.status === 'sent');
      if (!source || privatePixels && source.authorId !== 'user' || expectedDigest && createHash('sha256').update(source.content).digest('hex') !== expectedDigest) return false;
      if (loop.context) {
        const context = JSON.parse(loop.context.user) as { taskRequest?: { sourceMessageId?: string; prompt?: string } };
        if (context.taskRequest?.sourceMessageId === source.id && typeof context.taskRequest.prompt === 'string' && context.taskRequest.prompt !== source.content) return false;
      }
      if (options.validateParentLoop && !(yield { kind: 'parent', loop, action: stored })) return false;
    } else if (!humanPrivate || !capability.agendaRunId || stored.parentMessageId || capability.invocationId !== capability.agendaRunId) return false;
    if (capability.agendaRunId) {
      const run = (yield* read({ type: 'agenda.run.read', companionId: stored.companionId, id: capability.agendaRunId })).agendaRun;
      if (!run || run.id !== capability.agendaRunId || run.companionId !== stored.companionId) return false;
      if (privatePixels && (!run.activeGrantId || !run.activeGrantRevision)) return false;
      if (run.activeGrantId) {
        const grant = (yield* read({ type: 'agenda.grants.read', companionId: stored.companionId })).agendaGrants?.find(grant => grant.id === run.activeGrantId);
        if (!grant || grant.companionId !== stored.companionId || grant.status !== 'active' || grant.revision !== run.activeGrantRevision
          || grant.expiresAt && Date.parse(grant.expiresAt) <= (options.now?.() ?? Date.now())
          || capability.name === 'observe' && !grant.capabilities.includes('observe') || capability.name === 'think' && !grant.capabilities.includes('dsh')) return false;
      }
    }
    return true;
  } catch (error) {
    if (options.throwTemporaryUnavailable && error instanceof CompanionCapabilityEvidenceUnavailable) throw error;
    return false;
  }
}
