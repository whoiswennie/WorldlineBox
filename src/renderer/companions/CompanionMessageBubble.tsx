import { memo, useCallback, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CompanionAction, CompanionAttachment, CompanionMessage } from '../../shared/companions';
import { ChatGlyph } from './CompanionVisuals';
import { CompanionCapabilityLink } from './CompanionCapabilityLink';
import { MessageContent } from './MessageContent';
import { type CompanionReplyStreamStore, projectCompanionReply } from './reply-stream';
import { CompanionAttachments } from './CompanionAttachments';
import { CompanionReplyProgress } from './CompanionReplyProgress';
import { terminalReplyPhases } from '../../shared/companion-reply-progress';
import { Icon } from '../Icons';

export const CompanionMessageBubble = memo(function CompanionMessageBubble({ message, replied, quoteAuthor, actions, now, streamStore, interrupted, onOpenAction, onOpenUrl, onOpenAttachment, onLocateQuote, onStreamLayout, onCancelReply, onRetryReply, onGuideReply, tools }: {
  readonly message: CompanionMessage; readonly replied?: CompanionMessage; readonly quoteAuthor?: string; readonly actions: CompanionAction[]; readonly now: number;
  readonly streamStore: CompanionReplyStreamStore; readonly interrupted: boolean;
  readonly onOpenAction: (id: string) => void; readonly onOpenUrl: (url: string) => void; readonly onOpenAttachment: (attachment: CompanionAttachment, images?: readonly CompanionAttachment[]) => void;
  readonly onLocateQuote: (id: string) => void; readonly onStreamLayout: (conversationId: string) => void;
  readonly onCancelReply?: (workId: string) => void; readonly onRetryReply?: (workId: string) => void | Promise<unknown>;
  readonly onGuideReply?: (sourceMessageId: string) => void;
  readonly tools?: ReactNode;
}) {
  const [inspectedProcess, setInspectedProcess] = useState<string>();
  const subscribe = useCallback((listener: () => void) => streamStore.subscribe(message.id, listener), [streamStore, message.id]);
  const getSnapshot = useCallback(() => streamStore.snapshot(message.id), [streamStore, message.id]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { segments, phase, progress } = projectCompanionReply(message, snapshot);
  const partial = phase === 'interrupted' || interrupted && !!message.replyDraft && !snapshot.discarded.has(message.replyDraft.attemptId);
  useLayoutEffect(() => { if (snapshot.overlays.length) onStreamLayout(message.conversationId); }, [snapshot, message.conversationId, onStreamLayout]);
  const lastStreamingStep = progress && terminalReplyPhases.has(progress.phase) ? undefined : snapshot.overlays.filter(frame => frame.phase === 'streaming').at(-1)?.step;
  const hasText = segments?.some(segment => segment.text.trim());
  const processVersion = progress ? `${message.id}:${progress.workId ?? ''}:${progress.startedAt}:${progress.revision}` : undefined;
  const revealCompleted = progress?.phase === 'completed' && inspectedProcess === processVersion;
  const capabilities = (ids: string[], step: number, hasBody: boolean) => <div className={'companions-loop-capabilities' + (hasBody ? ' is-attached' : ' is-standalone')} aria-label={'第 ' + (step + 1) + ' 步能力调用'}>{ids.map(id => <CompanionCapabilityLink key={id} action={actions.find(value => value.id === id)} actionId={id} now={now} onOpen={onOpenAction} />)}</div>;
  return <div className="companions-reply-thread" data-reply-phase={phase ?? (partial ? 'interrupted' : undefined)} aria-busy={progress ? !terminalReplyPhases.has(progress.phase) : phase === 'streaming'}>
    {message.sourceUnavailable ? <div className="companions-message-bubble"><small className="companions-reply-stream-status" role="status">此消息引用的资料已变化，内容暂不可用。</small></div>
    : message.kind === 'action' && message.actionId ? capabilities([message.actionId], 0, false) : segments ? <>
      {!progress && !hasText && !segments.some(segment => segment.actionIds.length) && lastStreamingStep === undefined && <p className="companions-loop-pending"><Icon name="activity" size={13} />正在回复…</p>}
      {segments.map((segment, step) => {
        const visibleText = !!segment.text.trim(), streaming = lastStreamingStep === step;
        const showCursor = streaming && (visibleText || !progress && !segment.actionIds.length);
        // Keep the original step identity, but never manufacture an empty
        // speech bubble for a native tool-only turn or a progress-opening frame.
        if (!visibleText && !showCursor && !segment.actionIds.length) return null;
        return <section className="companions-reply-part" key={step} data-loop-step={step}>
          {visibleText ? <div className="companions-message-bubble"><MessageContent content={segment.text} onOpenUrl={onOpenUrl} />{showCursor && <span className="companions-reply-cursor" aria-label="伙伴正在输出" />}</div> : showCursor && <span className="companions-reply-cursor" aria-label="伙伴正在输出" />}
          {!!segment.actionIds.length && capabilities(segment.actionIds, step, visibleText)}
        </section>;
      })}
    </> : (message.content || message.attachments.length || message.replyToId && !progress) ? <div className="companions-message-bubble">
      {message.replyToId && !replied?.memoryEvidenceOnly && <button className="companions-reply-quote" aria-label={`查看引用消息 ${message.replyToId}`} onClick={() => onLocateQuote(message.replyToId!)}><span className="companions-reply-quote-heading"><ChatGlyph name="reply" /><strong>{quoteAuthor ?? '引用消息'}</strong></span><span className="companions-reply-quote-excerpt">{replied?.content || (replied ? replied.attachments.map(item => item.name).join('、') : '点击查看引用的消息')}</span></button>}
      {message.content && (message.authorId === 'user' ? <p>{message.content}</p> : <MessageContent content={message.content} onOpenUrl={onOpenUrl} />)}
      {!!message.attachments.length && <CompanionAttachments ownerId={message.authorId} conversationId={message.conversationId} attachments={message.attachments} onOpen={onOpenAttachment} />}
    </div> : null}
    {!message.sourceUnavailable && segments && !!message.attachments.length && <div className="companions-message-bubble"><CompanionAttachments ownerId={message.authorId} conversationId={message.conversationId} attachments={message.attachments} onOpen={onOpenAttachment} /></div>}
    {partial && !progress && <small className="companions-reply-stream-status">回复已中断</small>}
    {progress && <CompanionReplyProgress progress={progress} now={now} revealCompleted={revealCompleted} scope={{ companionId: message.authorId, conversationId: message.conversationId, messageId: message.id }} onCancel={progress.workId && onCancelReply ? () => onCancelReply(progress.workId!) : undefined} onRetry={progress.workId && onRetryReply ? () => onRetryReply(progress.workId!) : undefined} onGuide={progress.sourceMessageId && onGuideReply ? () => onGuideReply(progress.sourceMessageId!) : undefined} />}
    {(tools || progress?.phase === 'completed') && <div className="companions-message-tools">{tools}{progress?.phase === 'completed' && <button type="button" aria-label="查看回复过程" title="查看回复过程" aria-expanded={revealCompleted} onClick={() => setInspectedProcess(value => value === processVersion ? undefined : processVersion)}><Icon name="activity" /></button>}</div>}
  </div>;
});
