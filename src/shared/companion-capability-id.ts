import { createHash } from 'node:crypto';

export function companionCapabilityRecordId(scope: { companionId: string; conversationId: string; invocationId: string }, callId: string): string {
  return 'cap_' + createHash('sha256').update(JSON.stringify([scope.companionId, scope.conversationId, scope.invocationId, callId])).digest('hex');
}
