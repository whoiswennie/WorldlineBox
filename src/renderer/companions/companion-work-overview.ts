import type { CompanionAction } from '../../shared/companions';

export type CompanionWorkPhase = 'running' | 'queued' | 'confirmation' | 'interrupted';
export function companionWorkPhase(action: CompanionAction): CompanionWorkPhase | undefined {
  if (action.status === 'queued') return 'queued';
  if (action.status === 'running') {
    // Use an explicit host stage/event, never guess from model prose or tool arguments.
    const stage = action.events?.at(-1)?.type ?? action.stage;
    return stage === 'waiting_approval' ? 'confirmation' : 'running';
  }
  if (action.canResume && (action.status === 'interrupted' || action.status === 'failed')) return 'interrupted';
}
export const COMPANION_WORK_PHASE_LABELS: Record<CompanionWorkPhase, string> = { running: '进行中', queued: '等待中', confirmation: '待确认', interrupted: '可继续' };

/** Fixed-size preview; the complete collection and independent selections live in the task monitor. */
export function companionWorkOverview(actions: readonly CompanionAction[], companionId?: string) {
  const counts: Record<CompanionWorkPhase, number> = { running: 0, queued: 0, confirmation: 0, interrupted: 0 };
  const items = actions.filter(action => !companionId || action.companionId === companionId).flatMap(action => {
    const phase = companionWorkPhase(action);
    if (!phase) return [];
    counts[phase]++;
    return [{ action, phase }];
  });
  const rank: Record<CompanionWorkPhase, number> = { confirmation: 0, running: 1, queued: 2, interrupted: 3 };
  items.sort((a, b) => rank[a.phase] - rank[b.phase] || a.action.createdAt.localeCompare(b.action.createdAt) || a.action.id.localeCompare(b.action.id));
  return { counts, items, preview: items.slice(0, 2), total: items.length, active: counts.running + counts.queued + counts.confirmation };
}
