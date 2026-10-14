import type { CompanionWorldArtAction } from './companion-world-actions';
import type { CompanionWorldActor, CompanionWorldEvent } from './companion-world';

/** Brief expressions reflect visible events; sustained expressions reflect the host's PAD and energy. */
export function companionWorldExpression(input: { companionId: string; pose: CompanionWorldArtAction;
  state: CompanionWorldActor['state']; events: readonly CompanionWorldEvent[]; now: number }): { action: CompanionWorldArtAction; startedAtReal?: string } {
  if (input.pose !== 'idle') return { action: input.pose };
  const recent = [...input.events].reverse().find(event => {
    const elapsed = input.now - Date.parse(event.realAt);
    return elapsed >= 0 && elapsed < 2200 && (event.kind === 'visit_request' && event.targetId === input.companionId
      || event.kind.startsWith('social_') && event.kind !== 'social_appraisal' && event.actorId === input.companionId);
  });
  if (recent) return { action: recent.kind === 'visit_request' ? 'surprised' : 'communicate', startedAtReal: recent.realAt };
  const { mood, energy, affect } = input.state;
  if (mood === 'tired' || energy <= 25) return { action: 'tired' };
  if (affect.pleasure <= -.3 && affect.arousal >= .3 && affect.dominance >= .1) return { action: 'angry' };
  if (affect.pleasure <= -.25 && (affect.arousal < .2 || affect.dominance < 0)) return { action: 'sad' };
  if (mood === 'low' || affect.pleasure <= -.2) return { action: 'troubled' };
  if (mood === 'bright' || affect.pleasure >= .3) return { action: 'pleased' };
  return { action: 'idle' };
}
