import { memo, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import type { CompanionAction, CompanionAttachment, CompanionMessage } from '../../shared/companions';
import { ChatGlyph } from './CompanionVisuals';
import { CompanionCapabilityLink } from './CompanionCapabilityLink';
import { MessageContent } from './MessageContent';
import { type CompanionReplyStreamStore, projectCompanionReply } from './reply-stream';
import { CompanionAttachments } from './CompanionAttachments';
import { CompanionReplyProgress } from './CompanionReplyProgress';
import { terminalReplyPhases } from '../../shared/companion-reply-progress';

export const CompanionMessageBubble = memo(function CompanionMessageBubble({ message, replied, quoteAuthor, actions, now, streamStore, interrupted, onOpenAction, onOpenUrl, onOpenAttachment, onLocateQuote, onStreamLayout, onCancelReply, onRetryReply, onGuideReply }: {
  readonly message: CompanionMessage; readonly replied?: CompanionMessage; readonly quoteAuthor?: string; readonly actions: CompanionAction[]; readonly now: number;
  readonly streamStore: CompanionReplyStreamStore; readonly interrupted: boolean;
  readonly onOpenAction: (id: string) => void; readonly onOpenUrl: (url: string) => void; readonly onOpenAttachment: (attachment: CompanionAttachment, images?: readonly CompanionAttachment[]) => void;
  readonly onLocateQuote: (id: string) => void; readonly onStreamLayout: (conversationId: string) => void;
  readonly onCancelReply?: (workId: string) => void; readonly onRetryReply?: (workId: string) => void;
  readonly onGuideReply?: (sourceMessageId: string) => void;
}) {
  const subscribe = useCallback((listener: () => void) => streamStore.subscribe(message.id, listener), [streamStore, message.id]);
  const getSnapshot = useCallback(() => streamStore.snapshot(message.id), [streamStore, message.id]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { segments, phase, progress } = projectCompanionReply(message, snapshot);
  const partial = phase === 'interrupted' || interrupted && !!message.replyDraft && !snapshot.discarded.has(message.replyDraft.attemptId);
  useLayoutEffect(() => { if (snapshot.overlays.length) onStreamLayout(message.conversationId); }, [snapshot, message.conversationId, onStreamLayout]);
  const lastStreamingStep = progress && terminalReplyPhases.has(progress.phase) ? undefined : snapshot.overlays.filter(frame => frame.phase === 'streaming').at(-1)?.step;
  const hasText = segments?.some(segment => segment.text.trim());
  const capabilityOnly = message.kind === 'action' || segments && !hasText && !progress;
  return <div className={`companions-message-bubble${message.kind === 'action' ? ' is-action' : ''}${capabilityOnly ? ' is-capability-only' : ''}`} data-reply-phase={phase ?? (partial ? 'interrupted' : undefined)} aria-busy={progress ? !terminalReplyPhases.has(progress.phase) : phase === 'streaming'}>
    {message.replyToId && !segments && !replied?.memoryEvidenceOnly && <button className="companions-reply-quote" aria-label={`查看引用消息 ${message.replyToId}`} onClick={() => onLocateQuote(message.replyToId!)}><span className="companions-reply-quote-heading"><ChatGlyph name="reply" /><strong>{quoteAuthor ?? '引用消息'}</strong></span><span className="companions-reply-quote-excerpt">{replied?.content || (replied ? replied.attachments.map(item => item.name).join('、') : '点击查看引用的消息')}</span></button>}
    {message.kind === 'action' && message.actionId ? <CompanionCapabilityLink action={actions.find(action => action.id === message.actionId)} actionId={message.actionId} now={now} onOpen={onOpenAction} /> : segments ? <div className="companions-loop-segments">
      {!progress && !hasText && !segments.some(segment => segment.actionIds.length) && lastStreamingStep === undefined && <p className="companions-loop-pending">正在回复…</p>}
      {segments.map((segment, step) => {
        const visibleText = !!segment.text.trim(), streaming = lastStreamingStep === step;
        // Native tool-only turns have no chat content. Keep their original step
        // indices for stream reconciliation without allocating empty flex gaps.
        if (!visibleText && !segment.actionIds.length && !streaming) return null;
        return <section className="companions-loop-segment" key={step} data-loop-step={step}>
          {visibleText && <MessageContent content={segment.text} onOpenUrl={onOpenUrl} />}
          {streaming && <span className="companions-reply-cursor" aria-label="伙伴正在输出" />}
          {!!segment.actionIds.length && <div className="companions-loop-capabilities" aria-label={'第 ' + (step + 1) + ' 步能力调用'}>{segment.actionIds.map(id => <CompanionCapabilityLink key={id} action={actions.find(value => value.id === id)} actionId={id} now={now} onOpen={onOpenAction} />)}</div>}
        </section>;
      })}
    </div> : message.content && (message.authorId === 'user' ? <p>{message.content}</p> : <MessageContent content={message.content} onOpenUrl={onOpenUrl} />)}
    {progress && <CompanionReplyProgress progress={progress} now={now} scope={{ companionId: message.authorId, conversationId: message.conversationId, messageId: message.id }} onCancel={progress.workId && onCancelReply ? () => onCancelReply(progress.workId!) : undefined} onRetry={progress.workId && onRetryReply ? () => onRetryReply(progress.workId!) : undefined} onGuide={progress.sourceMessageId && onGuideReply ? () => onGuideReply(progress.sourceMessageId!) : undefined} />}
    {partial && !progress && <small className="companions-reply-stream-status">回复已中断</small>}
    {!!message.attachments.length && <CompanionAttachments attachments={message.attachments} onOpen={onOpenAttachment} />}
  </div>;
});
