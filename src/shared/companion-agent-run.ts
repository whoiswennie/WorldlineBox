import { z } from 'zod';
import { companionLoopTurnSchema, companionLoopWorkingStateSchema } from './companion-loop';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Actual cold material read by this inference. File/grant validation is done
 * by the main process; a storage worker must never infer file availability. */
export const companionKnowledgeReadSchema = z.object({
  id: z.string().regex(/^cold_(?:message|memory|learning)_[a-f0-9]{48}$/u), version: digest,
  sourceType: z.enum(['message', 'memory', 'learning']), sourceId: id, sourceVersion: z.string().min(1).max(1024), sourceDigest: digest,
  conversationId: id,
  grantId: id.optional(), grantRevision: z.number().int().positive().safe().optional(), assetId: z.string().min(1).max(255).optional(), assetRevisionId: z.string().min(1).max(255).optional(),
}).superRefine((read, context) => {
  if (read.sourceType === 'learning' && (read.grantId !== read.sourceId || !read.grantRevision || !read.assetId || !read.assetRevisionId))
    context.addIssue({ code: 'custom', message: '学习资料读集必须绑定真实授权及资料版本。' });
  if (read.sourceType === 'memory' && (!/^[1-9]\d*$/u.test(read.sourceVersion) || !Number.isSafeInteger(Number(read.sourceVersion))))
    context.addIssue({ code: 'custom', message: '日记来源版本必须为真实数字修订。' });
  if (read.sourceType === 'message' && !new RegExp(`^[1-9]\\d*:${read.sourceDigest}$`, 'u').test(read.sourceVersion))
    context.addIssue({ code: 'custom', message: '消息来源版本必须绑定实际序号与正文校验。' });
});
export type CompanionKnowledgeRead = z.infer<typeof companionKnowledgeReadSchema>;
export const companionHostObservationChangeSchema = z.strictObject({ kind: z.literal('host_observation_changed'), previousKey: digest, currentKey: digest })
  .refine(value => value.previousKey !== value.currentKey, '宿主观察必须实际变化，不能用相同凭证重开最终提案。');
export type CompanionHostObservationChange = z.infer<typeof companionHostObservationChangeSchema>;
export const companionRejectedFinalSchema = z.strictObject({ step: z.number().int().nonnegative().safe(), proposalChecksum: digest,
  reason: z.string().min(1).max(2000), rejectedAt: z.iso.datetime(), activityTaskId: id,
  activityStep: z.number().int().nonnegative().safe(), leaseTokenChecksum: digest, hostObservation: companionHostObservationChangeSchema.optional() });
export type CompanionRejectedFinal = z.infer<typeof companionRejectedFinalSchema>;
export const companionFinalValidationFailures = (run: { rejectedFinals?: readonly CompanionRejectedFinal[] }) =>
  run.rejectedFinals?.filter(rejection => !rejection.hostObservation).length ?? 0;
export const companionAgentRunSchema = z.object({
  id, companionId: id, conversationId: id, invocationId: z.string().min(1).max(300),
  topicId: id.optional(), requestDigest: digest, revision: z.number().int().nonnegative().safe(),
  status: z.enum(['running', 'done']), turns: z.array(companionLoopTurnSchema),
  rejectedFinals: z.array(companionRejectedFinalSchema).optional(),
  sources: z.array(z.object({ id, conversationId: id, checksum: digest })),
  memories: z.array(z.object({ id, version: z.number().int().positive() })),
  knowledgeReads: z.array(companionKnowledgeReadSchema).optional(),
  /** Immutable authorized checkpoint references, including secondary game ports. */
  topics: z.array(z.strictObject({ conversationId: id, topicId: id, checkpointEventIds: z.array(id).min(1).max(2), sourceMessageIds: z.array(id).max(512) })).optional(),
  effects: z.array(z.object({ step: z.number().int().nonnegative().safe(), callId: z.string().max(200),
    state: z.enum(['dispatched', 'confirmed']), result: z.string().optional() })).default([]),
  workingState: companionLoopWorkingStateSchema.optional(),
}).superRefine((run, context) => {
  if (run.status === 'done' && (!run.turns.length || run.turns.at(-1)!.calls.length)) context.addIssue({ code: 'custom', path: ['status'], message: '持久推理只有真实最终交付才能完成。' });
  const rejectedSteps = new Set<number>();
  if (companionFinalValidationFailures(run) > 3)
    context.addIssue({ code: 'custom', path: ['rejectedFinals'], message: '模型最终提案最多允许三次格式或语义错误。' });
  for (const rejection of run.rejectedFinals ?? []) {
    if (!run.turns[rejection.step] || run.turns[rejection.step]!.calls.length || rejectedSteps.has(rejection.step)
      || run.status === 'done' && rejection.step === run.turns.length - 1)
      context.addIssue({ code: 'custom', path: ['rejectedFinals'], message: '拒绝记录只能引用尚未执行的独立最终提案，不能重复或把已拒提案标为完成。' });
    rejectedSteps.add(rejection.step);
    if (rejection.hostObservation && run.turns[rejection.step]?.hostProgressKey !== rejection.hostObservation.previousKey)
      context.addIssue({ code: 'custom', path: ['rejectedFinals'], message: '旧最终提案的宿主观察凭证不匹配。' });
  }
  const seen = new Set<string>();
  for (const [index, effect] of run.effects.entries()) {
    const key = `${effect.step}:${effect.callId}`;
    if (seen.has(key) || !run.turns[effect.step]?.calls.some(call => call.id === effect.callId)
      || effect.state === 'confirmed' && effect.result === undefined) context.addIssue({ code: 'custom', path: ['effects', index], message: '作用凭证必须属于已提交调用，已确认作用必须保存回执。' });
    seen.add(key);
  }
});
export type CompanionAgentRun = z.infer<typeof companionAgentRunSchema>;
export const companionAgentRunCommands = [
  z.strictObject({ type: z.literal('agent.run.get'), companionId: id, id }),
  z.strictObject({ type: z.literal('agent.run.save'), run: companionAgentRunSchema, expectedRevision: z.number().int().nonnegative().safe() }),
  z.strictObject({ type: z.literal('agent.run.revise_final'), companionId: id, id, expectedRevision: z.number().int().nonnegative().safe(),
    activityTaskId: id, leaseToken: id, expectedStep: z.number().int().nonnegative().safe(), turnStep: z.number().int().nonnegative().safe(),
    proposalChecksum: digest, reason: z.string().trim().min(1).max(2000), hostObservation: companionHostObservationChangeSchema.optional() }),
] as const;
