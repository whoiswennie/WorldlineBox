import type { CompanionAgendaClaim } from '../../shared/companion-agenda';
import type { CompanionAgendaExecutionContext, CompanionAgendaExecutionResult } from './agenda-service';
import type { CompanionLearningGoalService } from './learning-goal-service';

/** A real knowledge-learning round, not a virtual study animation or a new
 * polling service. Existing source, integration and self-test receipts survive. */
export async function executeAgendaLearning(claim: CompanionAgendaClaim, context: CompanionAgendaExecutionContext, signal: AbortSignal,
  options: { learningGoals?: CompanionLearningGoalService }): Promise<CompanionAgendaExecutionResult> {
  const goalId = claim.rule.referenceId;
  if (!options.learningGoals) return { outcome: 'waiting', stage: '等待学习服务可用', nextCondition: '学习执行能力已配置' };
  if (!goalId) return { outcome: 'waiting', stage: '尚未关联获准材料的真实学习目标', nextCondition: '主脑为长期方向准备具体学习材料' };
  await context.checkpoint('正在接续有来源的学习', { goalId, agendaRunId: claim.run.id });
  const result = await options.learningGoals.processGoal(goalId, signal, { companionId: claim.rule.companionId, agendaRunId: claim.run.id, agendaLeaseToken: claim.leaseToken });
  signal.throwIfAborted();
  await context.checkpoint(result.reason.slice(0, 1000), { goalId, agendaRunId: claim.run.id, roundId: result.round?.id, ordinal: result.round?.ordinal,
    status: result.status, phase: result.round?.phase, memoryIds: result.round?.memoryIds ?? [] });
  return { outcome: result.status, stage: result.reason.slice(0, 1000), ...(result.status === 'waiting' && result.nextAt ? { notBefore: result.nextAt, nextCondition: result.reason.slice(0, 1000) } : {}),
    ...(result.status === 'failed' ? { error: result.reason } : {}),
    result: JSON.stringify({ goalId, roundId: result.round?.id, ordinal: result.round?.ordinal, status: result.status,
      summary: result.round?.summary?.slice(0, 4000), memoryIds: result.round?.memoryIds, gaps: result.round?.gaps.slice(0, 5).map(item => item.slice(0, 800)), nextPlan: result.round?.nextPlan.slice(0, 5).map(item => item.slice(0, 800)),
      selfTest: result.round?.selfTest ? { kind: result.round.selfTest.kind, disclaimer: result.round.selfTest.disclaimer } : undefined }) };
}
