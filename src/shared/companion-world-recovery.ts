/** Physiological recovery uses a Schmitt trigger, never a per-tick random roll.
 * The gap avoids alternating between rest and activity at one energy boundary. */
export const COMPANION_WORLD_RECOVERY = { enterEnergy: 20, resumeEnergy: 55 } as const;

export function companionWorldNeedsRecovery(energy: number, recovering: boolean): boolean {
  return Number.isFinite(energy) && energy < (recovering ? COMPANION_WORLD_RECOVERY.resumeEnergy : COMPANION_WORLD_RECOVERY.enterEnergy + 1e-7);
}
