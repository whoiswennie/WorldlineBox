import { z } from 'zod';

export const botTaskQuestionSchema = z.strictObject({
  id: z.string().min(1).max(160), question: z.string().min(1).max(6000), header: z.string().max(120).optional(),
  options: z.array(z.strictObject({ label: z.string().min(1).max(300), description: z.string().max(1000).optional() })).optional(),
  multiSelect: z.boolean().optional(),
});
export const botTaskAnswerSchema = z.strictObject({ id: z.string().min(1).max(160), selected: z.array(z.string().max(300)), custom: z.string().max(12000).optional() });
export type BotTaskQuestion = z.infer<typeof botTaskQuestionSchema>;
export type BotTaskAnswer = z.infer<typeof botTaskAnswerSchema>;
/** Missing fields describe only legacy root-Session receipts. */
export interface BotNativeCallRef { nativeSessionId?: string; nativeCallId?: string }
export interface BotWorkerQuestionRequest extends BotNativeCallRef { questionId: string; callId: string; questions: BotTaskQuestion[] }
export type BotWorkerQuestionResult = { state: 'queued'; questionId: string }
  | { state: 'answered'; questionId: string; answers: BotTaskAnswer[] }
  | { state: 'closed'; questionId: string; reason?: string };
export interface BotWorkerEffectStart extends BotNativeCallRef { callId: string; toolName: string; argsHash: string; argumentsPreview: string }
export interface BotWorkerEffectCommit extends BotNativeCallRef { callId: string; toolName: string; argsHash: string; isError: boolean }
export interface BotWorkerEffectDecision { state: 'admitted' | 'already_committed' | 'blocked'; callId: string; reason?: string;
  provenance?: 'native_committed' | 'user_verified_applied' | 'authorized_retry' }
export interface BotWorkerEffectInspection extends BotNativeCallRef { callId: string; state: 'committed' | 'failed' | 'unknown'; toolName?: string; argsHash?: string }
export interface BotAnsweredQuestion extends BotNativeCallRef { questionId: string; callId: string; questions: BotTaskQuestion[]; answers: BotTaskAnswer[] }
export interface BotQuestionAnswerInspection extends BotNativeCallRef { questionId: string; state: 'committed' | 'unknown'; observedThrough?: number }
export interface BotTaskAttention extends BotNativeCallRef { id: string; callId: string; state: 'queued' | 'answered' | 'closed'; questions: BotTaskQuestion[]; answers?: BotTaskAnswer[] }
export interface BotTaskPendingEffect extends BotNativeCallRef { callId: string; toolName: string; argsHash: string; argumentsPreview?: string; state?: 'pending' | 'unknown' }
export const botEffectResolutionSchema = z.strictObject({ callId: z.string().min(1).max(300), decision: z.enum(['already_applied', 'retry']), note: z.string().max(2000).optional() });
export type BotEffectResolution = z.infer<typeof botEffectResolutionSchema>;
