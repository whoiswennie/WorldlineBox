import { z } from 'zod';

/** Temporary, cumulative provider output. Reasoning never enters chat history. */
export type CaptureAnswerUpdate = { text: string; reasoning: string };
export const CAPTURE_ANSWER_TEXT_BYTES = 16 * 1024;
export const CAPTURE_ANSWER_REASONING_BYTES = 32 * 1024;
const boundedUtf8 = (bytes: number) => z.string().max(bytes).refine(value => new TextEncoder().encode(value).byteLength <= bytes);
export const captureAnswerProgressSchema = z.strictObject({
  id: z.string().min(1).max(100), sequence: z.number().int().positive(),
  text: boundedUtf8(CAPTURE_ANSWER_TEXT_BYTES), reasoning: boundedUtf8(CAPTURE_ANSWER_REASONING_BYTES),
});
export type CaptureAnswerProgress = z.infer<typeof captureAnswerProgressSchema>;
export const CAPTURE_TOOLS_ANSWER_PROGRESS = 'worldlinebox:capture-tools:answer-progress';
