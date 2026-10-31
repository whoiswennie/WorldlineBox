import { z } from 'zod';
import { companionUserStopSchema } from './companion-task-stop';
import { companionReplyProgressSchema } from './companion-reply-progress';
import { companionToolImageReferenceSchema } from './companion-file-tool';
import { companionTopicNarrativeApprovalSchema as topicNarrativeApprovalSchema, companionTopicPublicationApprovalSchema } from './companion-topic-canon';
import { COMPANION_SUBMIT_RESULT_TOOL, companionFinalProposalSchema } from './companion-final-proposal';
import { companionPreparedRecallReferenceSchema } from './companion-prepared-recall';
import { companionContextFrameSchema } from './companion-cognition';
import { companionModelUsageStateSchema } from './companion-model-usage';
import { companionReplyReceivedStateSchema } from './companion-reply-observation';
import { companionTaskAssetsBlobSchema } from './companion-task-assets-binding';
import { companionTaskPreparationBlobSchema } from './companion-task-preparation';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionLoopCallSchema = z.object({ id: z.string().min(1).max(200), name: z.string().max(100), arguments: z.string().max(65536),
  // Opaque provider protocol metadata, never thought text or a memory source.
  thoughtSignature: z.string().min(1).max(65536).optional() });
/** Host review of a turn or the complete pending reply. Narrative state is
 * published only with the exact resulting message in the same transaction. */
export const companionTopicNarrativeApprovalSchema = topicNarrativeApprovalSchema.extend({ topicId: id,
  quote: z.string().min(1).max(128), contentScope: z.literal('full_reply').optional() }).strict().refine(value => JSON.stringify(value).length <= 256000);
export const companionLoopTurnSchema = z.object({ text: z.string().max(65536), rawText: z.string().max(65536), calls: z.array(companionLoopCallSchema).max(16), messageId: id.optional(),
  inputRevision: z.number().int().nonnegative().optional(),
  /** Host receipt for the exact prose and call proposal already reviewed. */
  proseReviewChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Host-only final schema binding. Calls and provider body remain intact. */
  finalProposal: companionFinalProposalSchema.optional(),
  /** Host-only repair ledger. Original provider text and calls remain intact;
   * successful repaired bytes are separate data, never native tool authority. */
  structuredRepair: z.strictObject({ originalHash: z.string().regex(/^[a-f0-9]{64}$/u),
    attempts: z.number().int().min(1).max(2), content: z.string().max(65536).optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    rootContext: z.strictObject({ system: z.string().max(512 * 1024), user: z.string().max(512 * 1024), frame: companionContextFrameSchema,
      hash: z.string().regex(/^[a-f0-9]{64}$/u) }).refine(value => JSON.stringify(value).length <= 512 * 1024, '原请求修复凭证超出有界容量。').optional(),
  }).refine(receipt =>
    (receipt.content === undefined) === (receipt.contentHash === undefined), '修复正文与校验必须同时存在。').optional(),
  /** Host digest of actual source/evidence versions; never provider metadata. */
  hostProgressKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  topicNarrativeApproval: companionTopicNarrativeApprovalSchema.optional(),
  topicPublicationApproval: companionTopicPublicationApprovalSchema.optional(),
  /** Host rejection of an uncommitted cached final; original bytes remain in
   * this turn for audit, but are excluded from publication and model history. */
  topicPublicationRejection: z.object({ rawTextChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
    contentChecksum: z.string().regex(/^[a-f0-9]{64}$/u), reason: z.string().min(1).max(16000), rejectedAt: z.string() }).optional(),
  results: z.array(z.object({ callId: z.string().max(200), content: z.string(), images: z.array(companionToolImageReferenceSchema).max(4).optional(), attachmentIds: z.array(id).max(10).optional() })).max(16).optional() })
  .superRefine((turn, context) => {
    if (turn.structuredRepair && turn.calls.length && !turn.finalProposal)
      context.addIssue({ code: 'custom', path: ['structuredRepair'], message: '格式修复只能属于最终提案，不能修补或重放原生作用调用。' });
    if (turn.finalProposal && (!turn.calls.some(call => call.id === turn.finalProposal!.callId && call.name === COMPANION_SUBMIT_RESULT_TOOL)
      || new Set(turn.calls.map(call => call.id)).size !== turn.calls.length))
      context.addIssue({ code: 'custom', path: ['finalProposal'], message: '最终提案标记必须绑定本轮真实保留名调用与唯一调用标识。' });
  });
// Message-count windows and paginated retrieval limit work. Checkpoints preserve
// the actual request instead of imposing a hidden global character quota.
const companionLoopContextSchema = z.object({ system: z.string(), user: z.string() });
export const companionLoopDraftSchema = z.strictObject({ step: z.number().int().nonnegative().safe(), attemptId: id, text: z.string().max(65536) });
export const companionLoopWorkingStateSchema = z.strictObject({
  companionId: id, conversationId: id, sourceMessageId: id, invocationKey: id.optional(), topicId: id.optional(), authorizationGrantId: id.optional(),
  throughTurn: z.number().int().nonnegative().safe(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  memoryThroughStep: z.number().int().nonnegative().safe(), withdrawnThroughStep: z.number().int().nonnegative().safe(),
  summary: z.string().trim().min(1).max(32000), stage: z.string().max(1000), createdAt: z.string(),
});
export const companionLoopCheckpointSchema = z.object({ conversationId: id, sourceMessageId: id, companionId: id, messageId: id.optional(),
  receivedState: companionReplyReceivedStateSchema.optional(),
  taskAssets: companionTaskAssetsBlobSchema.optional(),
  /** Host-only prepared invocation metadata; model messages remain in context. */
  preparedTask: z.string().min(1).max(4 * 1024 * 1024).optional(),
  goalPreparation: companionTaskPreparationBlobSchema.optional(),
  usage: companionModelUsageStateSchema.optional(),
  memoryPreparation: companionPreparedRecallReferenceSchema.optional(),
  authorizationGrantId: id.optional(),
  invocationKey: id.optional(), contextThroughSequence: z.number().int().positive().optional(),
  status: z.enum(['running', 'done']), context: companionLoopContextSchema.optional(), turns: z.array(companionLoopTurnSchema),
  workingState: companionLoopWorkingStateSchema.optional(),
  draft: companionLoopDraftSchema.optional(), progress: companionReplyProgressSchema.optional(), supplements: z.array(z.object({ id, content: z.string().max(16000) })).max(100).default([]) })
  .superRefine((checkpoint, context) => {
    if (checkpoint.memoryPreparation && checkpoint.memoryPreparation.ownerId !== checkpoint.companionId)
      context.addIssue({ code: 'custom', path: ['memoryPreparation'], message: '回忆准备凭证必须属于本任务伙伴。' });
    if (checkpoint.turns.some(turn => turn.finalProposal)) context.addIssue({ code: 'custom', path: ['turns'], message: '普通聊天检查点不能注册领域最终提案。' });
    if (checkpoint.draft && (checkpoint.status !== 'running' || checkpoint.draft.step !== checkpoint.turns.length)) context.addIssue({ code: 'custom', path: ['draft'], message: '流式草稿必须属于当前尚未完成的循环步骤。' });
    if (checkpoint.workingState && (checkpoint.workingState.throughTurn > checkpoint.turns.length
      || checkpoint.workingState.companionId !== checkpoint.companionId || checkpoint.workingState.conversationId !== checkpoint.conversationId
      || checkpoint.workingState.sourceMessageId !== checkpoint.sourceMessageId || checkpoint.workingState.invocationKey !== checkpoint.invocationKey
      || checkpoint.workingState.authorizationGrantId !== checkpoint.authorizationGrantId)) context.addIssue({ code: 'custom', path: ['workingState'], message: '工作摘要必须属于同一伙伴、来源、任务与实际步骤范围。' });
  });
export type CompanionLoopCall = z.infer<typeof companionLoopCallSchema>;
export type CompanionLoopTurn = z.infer<typeof companionLoopTurnSchema>;
export type CompanionLoopCheckpoint = z.infer<typeof companionLoopCheckpointSchema>;
/** Match the actual bubble exactly, including whitespace and tool-bearing
 * turns. Callers enforce the message boundary instead of truncating prose. */
export function companionLoopPublishedText(turns: readonly Pick<CompanionLoopTurn, 'text' | 'topicPublicationRejection'>[], draft?: Pick<z.infer<typeof companionLoopDraftSchema>, 'text'>): string {
  return [...turns.filter(turn => !turn.topicPublicationRejection).map(turn => turn.text), ...(draft ? [draft.text] : [])].filter(Boolean).join('\n\n');
}
/** Withdrawal changes the visible/model projection, never the append-only
 * audit. Text accepted before a proven evidence cutoff cannot be published
 * again merely because its original turn also contains a completed tool. */
export function companionLoopCheckpointPublishedText(checkpoint: Pick<CompanionLoopCheckpoint, 'turns' | 'context' | 'draft'>): string {
  let state: { memoryEvidenceThroughStep?: unknown; withdrawnEvidenceThroughStep?: unknown } = {};
  if (checkpoint.context) {
    try { state = JSON.parse(checkpoint.context.user) ?? {}; }
    catch { /* Legacy opaque input has no host-issued withdrawal cutoff. */ }
  }
  const boundary = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= checkpoint.turns.length ? value : 0;
  const through = Math.max(boundary(state.memoryEvidenceThroughStep), boundary(state.withdrawnEvidenceThroughStep));
  return companionLoopPublishedText(checkpoint.turns.map((turn, index) => index < through ? { ...turn, text: '' } : turn), checkpoint.draft);
}
export const companionWorkSchema = z.object({ id, conversationId: id, sourceMessageId: id, companionId: id,
  receivedState: companionReplyReceivedStateSchema.optional(),
  // Host-owned parent lease; ordinary chat and its tool children use one slot.
  agendaRunId: id.optional(), agendaLeaseToken: id.optional(), agendaAttempt: z.number().int().nonnegative().safe().optional(),
  inputMode: z.enum(['steer', 'queue']).optional(),
  messageId: id.optional(), status: z.enum(['queued', 'running', 'interrupted', 'done', 'cancelled']), ordinal: z.number().int().positive().optional(), proactive: z.boolean().default(false),
  resumeOnRestart: z.boolean().optional(), stop: companionUserStopSchema.optional(),
  startedAt: z.string().optional(), createdAt: z.string(), updatedAt: z.string() });
export type CompanionWork = z.infer<typeof companionWorkSchema>;
