import type { DshRecordScope } from '../../shared/dsh-task-record';

/** The proof is issued by Main after checking the old source's current ACL and digest. */
export function assertDshResumeScope(previous: DshRecordScope | undefined, current: DshRecordScope | undefined, proof?: DshRecordScope): void {
  if (!previous || !current || previous.companionId !== current.companionId || previous.conversationId !== current.conversationId)
    throw new Error('The requested session belongs to another companion or conversation.');
  for (const field of ['topicId', 'domain', 'authorizationGrantId'] as const) {
    if (previous[field] !== current[field]) throw new Error('The requested session belongs to another topic, domain or authorization. Use explicit handoff into a new session.');
  }
  // Retrying one action cannot replace its captured dependencies. A distinct
  // user-authorized action may continue the same native session with the old
  // verified closure plus new inputs; Main constructs and verifies that union.
  if (previous.actionId === current.actionId && previous.executionReadsetDigest !== current.executionReadsetDigest
    || !!previous.executionReadsetDigest !== !!current.executionReadsetDigest)
    throw new Error('The requested session retains its exact source dependencies. Start a new session after revalidating the current inputs.');
  if (previous.sourceDigest || previous.executionReadsetDigest) {
    if (!proof || Object.keys(previous).some(key => previous[key as keyof DshRecordScope] !== proof[key as keyof DshRecordScope]))
      throw new Error('The original task source must be revalidated before its session can continue.');
  }
}
