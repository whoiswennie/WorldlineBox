import type { CompanionWorldArtAction } from './companion-world-actions';
import type { CompanionWorldEvent } from './companion-world';
import type { CurrentExperience } from './companion-current-experience';

/** Visible events, actual fatigue or an explicit source-backed expression. */
export function companionWorldExpression(input: { companionId: string; pose: CompanionWorldArtAction;
  state: { energy: number; experience?: CurrentExperience }; events: readonly CompanionWorldEvent[]; now: number }): { action: CompanionWorldArtAction; startedAtReal?: string } {
  if (input.pose !== 'idle') return { action: input.pose };
  const recent = [...input.events].reverse().find(event => {
    const elapsed = input.now - Date.parse(event.realAt);
    return elapsed >= 0 && elapsed < 2200 && (event.kind === 'visit_request' && event.targetId === input.companionId
      || ['social_phone', 'social_talk', 'social_face_to_face'].includes(event.kind) && event.actorId === input.companionId);
  });
  if (recent) return { action: recent.kind === 'visit_request' ? 'surprised' : 'communicate', startedAtReal: recent.realAt };
  if (input.state.energy <= 25) return { action: 'tired' };
  const experience = input.state.experience;
  if (experience?.companionId === input.companionId && experience.sourceMessageIds.length && experience.visibleExpression
    && Date.parse(experience.occurredAt) <= input.now && (!experience.validUntil || Date.parse(experience.validUntil) > input.now))
    return { action: experience.visibleExpression, startedAtReal: experience.recordedAt };
  return { action: 'idle' };
}
