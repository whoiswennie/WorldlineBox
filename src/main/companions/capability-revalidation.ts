import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { verifyCompanionCapabilityEvidence } from './capability-evidence';

/** Repair only a legacy false presentation tombstone after current canonical
 * evidence passes. This never restores notes, retries actions or grants access. */
export async function revalidateCompanionCapabilityPresentation(id: string,
  request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>): Promise<boolean> {
  const response = await request({ type: 'capability.revalidation.read', id });
  if (!response.ok) throw new Error('行动记录的重新核验暂不可用。');
  const candidate = response.capabilityRevalidation;
  if (!candidate) return false;
  const valid = await verifyCompanionCapabilityEvidence(candidate.action, {
    request: command => command.type === 'action.get' && command.id === id
      ? Promise.resolve({ ok: true, action: candidate.action }) : request(command),
    throwTemporaryUnavailable: true,
  });
  if (!valid) return false;
  const committed = await request({ type: 'capability.revalidation.commit', id, invalidation: candidate.invalidation,
    actionDigest: candidate.actionDigest, writeGeneration: candidate.writeGeneration });
  if (!committed.ok) throw new Error('行动记录的重新核验暂不可提交。');
  return committed.capabilityRevalidated === true;
}
