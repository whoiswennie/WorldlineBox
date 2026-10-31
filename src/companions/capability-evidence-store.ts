import { companionCapabilityEvidencePlan, type CompanionCapabilityEvidenceIdentity, type CompanionCapabilityReadResponse } from '../shared/companion-capability-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';

/** One worker command owns this synchronous read DAG. No result survives its
 * SQLite snapshot or becomes a permission to execute/replay a capability. */
export function validateCompanionCapabilityAuthorities(actions: readonly CompanionCapabilityEvidenceIdentity[],
  request: (command: CompanionStorageCommand) => CompanionCapabilityReadResponse, now = Date.now()): NonNullable<CompanionStorageResponse['capabilityAuthorityResults']> {
  const reads = new Map<string, CompanionCapabilityReadResponse>();
  const read = (command: CompanionStorageCommand) => {
    const key = JSON.stringify(command);
    if (!reads.has(key)) reads.set(key, request(command));
    return reads.get(key)!;
  };
  return actions.map(action => {
    const plan = companionCapabilityEvidencePlan(action, { now: () => now, throwTemporaryUnavailable: true });
    let step = plan.next();
    while (!step.done) {
      try {
        // Optional parent-loop extensions are Main-owned. The shared core
        // performs every ordinary loop/source/run/grant check in this plan.
        if (step.value.kind !== 'read') throw new Error('Unexpected Main-only capability extension in worker validation.');
        step = plan.next(read(step.value.command));
      } catch (error) { step = plan.throw(error); }
    }
    return { id: action.id, companionId: action.companionId, conversationId: action.conversationId, valid: step.value };
  });
}
