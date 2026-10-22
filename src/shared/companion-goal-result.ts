/** A companion goal finishes only after its brain has checked the execution evidence. */
export interface CompanionGoalResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  result: string;
  actionIds?: string[];
  invocationId?: string;
  goalSlot?: string;
}
