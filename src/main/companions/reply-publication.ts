import { createHash } from 'node:crypto';
import { companionReplyPublicationSchema, type CompanionReplyPublication } from '../../shared/companion-reply-publication';
import { companionExecutionReadsetSchema } from '../../shared/companion-execution-evidence';
import { companionLoopCheckpointPublishedText } from '../../shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** This classifies only the exact host command/transaction receipt. A generic
 * read response, model JSON or a running checkpoint cannot authorize prose. */
export function companionReplyPublication(command: CompanionStorageCommand, response: CompanionStorageResponse): CompanionReplyPublication | undefined {
  if (!response.replyPublication) return;
  if (command.type !== 'loop.save' || command.checkpoint.status !== 'done' || !command.checkpoint.messageId || !command.executionReadset)
    throw new Error('正式回复回执不属于本次完整发布命令。');
  const receipt = companionReplyPublicationSchema.parse(response.replyPublication), checkpoint = command.checkpoint;
  const readset = companionExecutionReadsetSchema.parse(command.executionReadset);
  if (!response.ok || receipt.companionId !== checkpoint.companionId || receipt.conversationId !== checkpoint.conversationId
    || receipt.sourceMessageId !== checkpoint.sourceMessageId || receipt.invocationKey !== checkpoint.invocationKey
    || receipt.authorizationGrantId !== checkpoint.authorizationGrantId || receipt.message.id !== checkpoint.messageId
    || receipt.message.authorId !== receipt.companionId || receipt.message.conversationId !== receipt.conversationId
    || receipt.message.status !== 'sent' || receipt.message.kind !== 'text' || receipt.message.isReplyDraft || receipt.message.sourceUnavailable
    || receipt.message.content !== companionLoopCheckpointPublishedText(checkpoint)
    || receipt.source.id !== receipt.sourceMessageId || readset.companionId !== receipt.companionId || readset.conversationId !== receipt.conversationId
    || receipt.executionReadsetDigest !== hash(JSON.stringify(readset))) throw new Error('正式回复回执与实际主体、任务、原文或准确读集不一致。');
  if (!receipt.authorizationGrantId && (receipt.source.conversationId !== receipt.conversationId
    || !readset.sources.some(source => source.id === receipt.source.id && source.conversationId === receipt.source.conversationId
      && source.checksum === receipt.source.checksum))) throw new Error('正式回复缺少当前接收伙伴对原始请求的准确来源准入。');
  return receipt;
}
