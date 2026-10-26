import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { CompanionLearningGoal, CompanionLearningGoalRound, companionLearningTestStepSchema } from '../shared/companion-learning-goals';

export type CompanionLearningTestStep = z.infer<typeof companionLearningTestStepSchema>;
export const learningTestHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function learningTestBasis(goal: CompanionLearningGoal, round: CompanionLearningGoalRound, sources: Record<string, string>): string {
  return learningTestHash(['learning-self-test-v1', goal.id, goal.companionId, goal.revision, goal.text, goal.materials, goal.allowWeb,
    round.id, round.ordinal, round.plan, round.reads, round.summary, round.claims, round.memoryIds, round.integration,
    Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))]);
}
export function learningTestInput(basis: string, round: CompanionLearningGoalRound, stage: CompanionLearningTestStep['stage'], assessment?: { expectedStateRevision?: number; currentFocus?: string }): string {
  const progress = round.selfTestProgress;
  return learningTestHash(['learning-self-test-input-v1', basis, stage,
    stage === 'questions' ? { reads: round.reads, claims: round.claims }
      : stage === 'recall' ? progress?.questions
        : stage === 'answer' ? [progress?.questions, progress?.recall]
          : [progress?.questions, progress?.answer, round.reads, assessment]]);
}
export function learningSelfTestResult(round: CompanionLearningGoalRound): NonNullable<CompanionLearningGoalRound['selfTest']> {
  const progress = round.selfTestProgress;
  if (!progress?.questions || !progress.recall || !progress.answer || !progress.assess) throw new Error('自测缺少逐步完成的实际回执。');
  const questions = progress.questions.value.questions, answers = progress.answer.value.answers, review = progress.assess.value.review;
  const assessed = questions.map((question, index) => {
    const item = review.evaluations[index], answer = answers[index] ?? '';
    const citations = (item?.evidence ?? []).filter(item => round.reads.some(read => read.id === item.sourceId && read.excerpt.includes(item.quote)));
    const notAnswered = !answer.trim() || /^(?:我)?(?:不(?:知道|清楚|了解|确定)|无法(?:回答|确定|确认)|没有(?:足够|可用|实际|获得)|未(?:获取|获|得到|读))/u.test(answer.trim());
    return { question, answer, evaluation: !notAnswered && item && citations.length ? item.evaluation : 'unassessed' as const,
      rationale: notAnswered ? '本题未作答或明确表示未知，不能把材料中存在答案当作已经答对。' : item?.rationale ?? '模型没有提供本题评估。', evidence: citations };
  });
  return { kind: 'self_test', questions: assessed, supportedAnswers: assessed.filter(item => item.evaluation === 'supported').length,
    assessedQuestions: assessed.filter(item => item.evaluation !== 'unassessed').length,
    recall: { query: questions.join('\n').slice(0, 16000), contextHash: createHash('sha256').update(progress.recall.value.text).digest('hex'),
      contextCharacters: progress.recall.value.text.length, candidateMemoryIds: progress.recall.value.candidateMemoryIds },
    disclaimer: '模型自测与自评，仅核验引用来自本轮实际读取材料，不代表客观考试正确率或已经掌握。' };
}
