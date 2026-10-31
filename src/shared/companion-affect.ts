import type { CurrentExperience, RelationshipRecord } from './companion-current-experience';

/** Contextual guidance, without psychological scores or maturity counters. */
export function companionQualitativeBehavior(input: { energy: number; expression: string; focus?: string;
  experience?: CurrentExperience; relationshipRecords?: readonly RelationshipRecord[] }) {
  const needsRest = input.energy <= 25;
  return { responseLength: needsRest ? 'brief' : 'contextual', topicExpansion: needsRest ? 'limited' : 'contextual',
    expression: input.expression, currentFocus: input.experience?.focus ?? input.focus,
    responsePreference: input.experience?.responsePreference, uncertainty: input.experience?.uncertainty,
    initiative: 'consider_current_goals_availability_and_actual_relationship_events',
    boundaryStyle: 'consider_specific_current_agreements_and_boundaries',
    normalRequestsRemainAvailable: true, canDeferOnlyFlexibleTasks: true,
    currentExperienceIsSelfReport: true, relationshipRecordsAreContextSpecific: true };
}
