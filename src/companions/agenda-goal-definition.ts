import { createHash } from 'node:crypto';
import type { CompanionAgendaGoal } from '../shared/companion-agenda';

/** Scope and learning definition only. UI progress/status/revision changes do
 * not invalidate a still-identical completed source binding. */
export function companionAgendaGoalDefinitionHash(goal: CompanionAgendaGoal): string {
  return createHash('sha256').update(JSON.stringify([goal.companionId, goal.id, goal.title, goal.intent, goal.domain, goal.successCriteria,
    goal.nextQuestions, goal.grantId ?? null, goal.conversationId ?? null, goal.materials, goal.allowWeb])).digest('hex');
}
export function companionAgendaLearningIntent(goal: CompanionAgendaGoal): string {
  const text = [goal.title, goal.intent, '完成判断依据：\n' + goal.successCriteria.map(value => '- ' + value).join('\n'),
    ...(goal.nextQuestions.length ? ['当前尚未解决的问题：\n' + goal.nextQuestions.map(value => '- ' + value).join('\n')] : []),
    ...(goal.domain === 'procedure' ? ['本目标是有条件的方法练习方向；阅读、自测及虚拟动作不代表已经熟练，掌握需要真实练习与产物核验。'] : []),
  ].join('\n\n');
  if (text.length > 12000) throw new Error('完整学习方向、验收要求和未解问题超过当前单目标容量，请拆分方向；没有截断或省略原始要求。');
  return text;
}
