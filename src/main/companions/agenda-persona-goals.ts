import { createHash } from 'node:crypto';
import { companionAgendaGoalSchema, type CompanionAgendaGoal } from '../../shared/companion-agenda';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

export type CompanionAgendaPersonaGoalReadset = Array<{ id: string; definitionHash: string }>;
export interface CompanionAgendaPersonaDirection {
  id: string; title: string; intent: string; successCriteria: string[]; nextQuestions: string[];
  origin: CompanionAgendaGoal['origin']; conversationId: string; definitionHash: string;
  meaning: 'proposed_future_direction_not_established_personality';
}
type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A user direction is a proposal. Progress reports and revision counters are
 * not new evidence and cannot silently change this semantic definition. */
export function companionAgendaPersonaGoalDefinitionHash(goal: CompanionAgendaGoal): string {
  return hash([goal.id, goal.companionId, goal.domain, goal.status, goal.origin, goal.conversationId ?? null,
    goal.title, goal.intent, goal.successCriteria, goal.nextQuestions, goal.grantId ?? null, goal.materials, goal.allowWeb]);
}
export const companionAgendaPersonaGoalSetHash = (readset: CompanionAgendaPersonaGoalReadset): string => hash([...readset].sort((a, b) => a.id.localeCompare(b.id)));

/** Read the authoritative agenda definitions directly. No shadow goals, human
 * messages or already-formed traits are synthesized for the old growth table. */
export async function readCompanionAgendaPersonaDirections(companionId: string, conversationId: string, request: Request): Promise<{
  directions: CompanionAgendaPersonaDirection[]; readset: CompanionAgendaPersonaGoalReadset; revision: string;
}> {
  const directions: CompanionAgendaPersonaDirection[] = []; let afterId: string | undefined;
  do {
    const page = await request({ type: 'agenda.goals.read', companionId, limit: 100, ...(afterId ? { afterId } : {}) });
    if (!page.ok || !page.agendaGoals) throw new Error(page.error ?? '当前人格培养方向不可读取，未采用旧方向继续。');
    for (const value of page.agendaGoals) {
      const goal = companionAgendaGoalSchema.parse(value);
      if (goal.companionId !== companionId || afterId && goal.id <= afterId) throw new Error('人格培养方向的伙伴归属或分页顺序无效。');
      if (goal.domain !== 'persona' || goal.status !== 'active' || goal.conversationId !== conversationId) continue;
      directions.push({ id: goal.id, title: goal.title, intent: goal.intent, successCriteria: goal.successCriteria, nextQuestions: goal.nextQuestions,
        origin: goal.origin, conversationId, definitionHash: companionAgendaPersonaGoalDefinitionHash(goal), meaning: 'proposed_future_direction_not_established_personality' });
    }
    if (!page.agendaHasMore) break;
    if (!page.agendaNextId || page.agendaNextId === afterId || afterId && page.agendaNextId < afterId) throw new Error('人格培养方向分页没有前进，未截断后冒充完整定义。');
    afterId = page.agendaNextId;
  } while (afterId !== undefined);
  directions.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(directions.map(value => value.id)).size !== directions.length) throw new Error('人格培养方向包含冲突的重复定义。');
  const readset = directions.map(({ id, definitionHash }) => ({ id, definitionHash }));
  return { directions, readset, revision: companionAgendaPersonaGoalSetHash(readset) };
}

export async function validateCompanionAgendaPersonaDirections(companionId: string, conversationId: string, readset: CompanionAgendaPersonaGoalReadset,
  expectedRevision: string, request: Request): Promise<void> {
  if (companionAgendaPersonaGoalSetHash(readset) !== expectedRevision) throw new Error('人格培养方向的固定读集不完整。');
  const current = await readCompanionAgendaPersonaDirections(companionId, conversationId, request);
  if (current.revision !== expectedRevision) throw new Error('人格培养方向已调整、暂停、结束或改变来源域，旧提议不能继续发布。');
}
