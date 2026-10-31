import type { CompanionAction } from '../../shared/companions';
import type { CompanionLoopCheckpoint } from '../../shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionCapabilityEvidencePlan, type CompanionCapabilityEvidenceIdentity } from '../../shared/companion-capability-evidence';
export { CompanionCapabilityEvidenceUnavailable } from '../../shared/companion-capability-evidence';

export interface CompanionCapabilityEvidenceOptions {
  /** Raw worker port: using Main.call here would recursively project actions. */
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  now?(): number;
  throwTemporaryUnavailable?: boolean;
  validateParentLoop?(loop: CompanionLoopCheckpoint, action: CompanionAction): Promise<boolean>;
}

/** Main and the synchronous worker execute exactly the same read plan. */
export async function verifyCompanionCapabilityEvidence(action: CompanionCapabilityEvidenceIdentity,
  options: CompanionCapabilityEvidenceOptions): Promise<boolean> {
  const plan = companionCapabilityEvidencePlan(action, { now: options.now,
    validateParentLoop: !!options.validateParentLoop, throwTemporaryUnavailable: options.throwTemporaryUnavailable });
  let step = plan.next();
  while (!step.done) {
    try {
      const value = step.value.kind === 'read' ? await options.request(step.value.command)
        // Only this full Main port enables the optional parent extension.
        : await options.validateParentLoop!(step.value.loop as CompanionLoopCheckpoint, step.value.action as CompanionAction);
      step = plan.next(value);
    } catch (error) { step = plan.throw(error); }
  }
  return step.value;
}
