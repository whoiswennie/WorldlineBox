import type { CompanionLoopCheckpoint } from '../../shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { terminalReplyPhases } from '../../shared/companion-reply-progress';
import { detachedCompanionExecutionValidation } from './source-execution-evidence';

/** Process control outlives a sealed/aborted body reader. It cannot publish a
 * body, readset or certificate and preserves the task's storage FIFO lane. */
export function saveCompanionReplyProcessFinish(checkpoint: CompanionLoopCheckpoint,
  request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>): Promise<void> {
  const progress = checkpoint.progress;
  if (!progress || !terminalReplyPhases.has(progress.phase) || !progress.finishedAt)
    throw new Error('回复进程尚无真实终态回执。');
  const phase = progress.phase;
  if (phase !== 'completed' && phase !== 'failed' && phase !== 'cancelled' && phase !== 'interrupted')
    throw new Error('回复进程尚未结束。');
  const command: Extract<CompanionStorageCommand, { type: 'loop.progress.finish' }> = {
    type: 'loop.progress.finish', companionId: checkpoint.companionId, conversationId: checkpoint.conversationId,
    sourceMessageId: checkpoint.sourceMessageId, messageId: checkpoint.messageId, invocationKey: checkpoint.invocationKey,
    progress: { ...structuredClone(progress), phase, finishedAt: progress.finishedAt } };
  return detachedCompanionExecutionValidation(async () => {
    const response = await request(command);
    if (!response.ok) throw new Error(response.error ?? '回复终态尚未保存。');
  });
}
