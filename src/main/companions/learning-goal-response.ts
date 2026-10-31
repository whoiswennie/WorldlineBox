import { z } from 'zod';
import { companionLearningGoalPlanSchema, companionLearningAssessmentSchema } from '../../shared/companion-learning-goals';

const quotation = z.object({ sourceId: z.string(), quote: z.string().min(1).max(1000) });

/** Shape checks are shared with provider admission. A well-formed answer still
 * needs the caller's actual quotations, source ownership and practice checks. */
export const companionLearningGoalResponseSchemas = {
  plan: companionLearningGoalPlanSchema,
  learn: z.object({ summary: z.string().min(1).max(6000), claims: z.array(z.object({
    text: z.string().min(1).max(2000), evidence: z.array(quotation).min(1).max(4),
  })).min(1).max(12) }),
  consolidate: z.object({ action: z.enum(['new', 'revise']), noteId: z.string().optional(),
    content: z.string().min(1).max(60000), reason: z.string().min(1).max(2000) }),
  questions: z.object({ questions: z.array(z.string().min(1).max(1500)).min(1).max(3) }),
  answer: z.object({ answers: z.array(z.string().max(3000)).max(5) }),
  assess: companionLearningAssessmentSchema,
};

export type GoalInferenceStage = keyof typeof companionLearningGoalResponseSchemas;
