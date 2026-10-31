import type { CompanionRuntimeProgress, CompanionState } from '../../shared/companions';

/** Runtime polling can update status, never replace canonical contact fields. */
export function applyCompanionRuntimeProgress(state: CompanionState, progress: CompanionRuntimeProgress): CompanionState {
  const owners = new Map(progress.owners.map(owner => [owner.companionId, owner]));
  const resetting = new Set(state.resetJobs?.filter(job => job.status !== 'completed').map(job => job.companionId));
  return { ...state, queue: progress.queue, activities: progress.activities,
    companions: state.companions.map(companion => {
      const owner = owners.get(companion.id);
      const canonicalStatus = companion.active === false || companion.availability === 'offline' || companion.availability === 'dormant'
        || !!companion.assetProfileError || resetting.has(companion.id);
      return { ...companion, activeCount: owner?.activeCount ?? 0, queuedCount: owner?.queuedCount ?? 0,
        availability: canonicalStatus ? companion.availability : owner?.availability ?? 'ready',
        availabilityReason: canonicalStatus ? companion.availabilityReason : owner?.availabilityReason };
    }) };
}
