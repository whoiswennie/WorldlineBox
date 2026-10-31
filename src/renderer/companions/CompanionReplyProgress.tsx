import type { CompanionReplyProgress as Progress } from '../../shared/companion-reply-progress';
import { companionReplyElapsedMs, terminalReplyPhases } from '../../shared/companion-reply-progress';
import { Icon } from '../Icons';
import { elapsedTime } from './CompanionProgress';
import { useEffect, useId, useRef, useState } from 'react';
import { CompanionReplyMemoryDetails, type ReplyMemoryScope } from './CompanionReplyMemoryDetails';
import { companionDurationMilliseconds } from './task-duration';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { companionCapabilityDiagnostic } from './companion-capability-presentation';
import './companion-reply-progress.css';

const labels: Record<Progress['phase'], string> = { queued: '等待伙伴空闲', waiting: '正在等待回复', context: '正在整理这次聊天需要的信息', memory: '正在查找相关回忆', thinking: '正在思考', tools: '正在处理这件事', streaming: '正在回复', completed: '回复已完成', failed: '回复未能完成', cancelled: '已取消', interrupted: '回复已中断' };

type ProgressProps = {
  progress: Progress; now: number; scope: ReplyMemoryScope; onCancel?(): void | Promise<unknown>; onRetry?(): void | Promise<unknown>; onGuide?(): void;
  revealCompleted?: boolean;
  initialBubble?: boolean;
};

export function CompanionReplyProgress(props: ProgressProps) {
  if (props.progress.phase === 'completed' && !props.revealCompleted) return null;
  return <ReplyProcess key={props.progress.workId ?? props.progress.startedAt} {...props} />;
}

function ReplyProcess({ progress, now, scope, onCancel, onRetry, onGuide, initialBubble }: ProgressProps) {
  const [expanded, setExpanded] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  useDialogFocusTrap(memoryOpen, scope.messageId);
  const [retrying, setRetrying] = useState(false), [retryError, setRetryError] = useState<{ message: string; revision: number }>();
  const retry = async () => {
    if (retrying || !onRetry) return;
    setRetrying(true); setRetryError(undefined);
    try { await onRetry(); }
    catch (error) { setRetryError({ message: error instanceof Error ? error.message.slice(0, 500) : '恢复未成功，请重试。', revision: progress.revision }); }
    finally { setRetrying(false); }
  };
  const contentId = useId();
  const terminal = terminalReplyPhases.has(progress.phase), failure = progress.phase === 'failed';
  const [cancelling, setCancelling] = useState(false), [cancelError, setCancelError] = useState<string>();
  const cancelPending = useRef(false);
  useEffect(() => { if (terminal) cancelPending.current = false; }, [terminal]);
  if (terminal && (cancelling || cancelError)) { setCancelling(false); setCancelError(undefined); }
  const cancel = async () => {
    if (cancelPending.current || terminal || !onCancel) return;
    cancelPending.current = true; setCancelling(true); setCancelError(undefined);
    try { await onCancel(); }
    catch (error) {
      cancelPending.current = false; setCancelling(false);
      setCancelError(error instanceof Error ? error.message.slice(0, 500) : '停止请求未获确认，请重试。');
    }
    // An acknowledgement is not a terminal task receipt. Keep the pending
    // state until the host actually reports cancelled/completed/failed.
  };
  const problem = failure || progress.phase === 'interrupted';
  const finishedAt = terminal ? progress.finishedAt ?? progress.updatedAt : undefined;
  const elapsedMs = companionReplyElapsedMs(progress, now);
  const duration = elapsedMs === undefined ? undefined : companionDurationMilliseconds(elapsedMs);
  const userStopped = progress.stop?.actor === 'user';
  const memory = progress.memory;
  const detail = ['正在输出回复', '正在生成回复', '正在整理本轮上下文', '已加入回复队列', '已重新加入回复队列', '这次回复已取消', '回复已完成'].includes(progress.detail) || /^正在调用能力[：:]/u.test(progress.detail) ? '' : progress.detail;
  const memoryLabel = memory?.status === 'running' ? '正在查找相关回忆'
    : memory?.status === 'unavailable' ? '这次暂时没能读取相关回忆'
      : memory?.injected ? '这次回复参考了相关记忆'
        : memory?.count ? terminal ? '找到了相关内容，这次回复没有采用' : '找到了相关内容，尚未用于这次回复' : memory?.pending ? '部分经历还在整理，这次尚未找到相关回忆' : '这次没有找到相关回忆';
  return <section className={'companions-bubble-progress' + (terminal ? ' is-terminal' : ' is-running') + (failure ? ' is-failed' : '') + (expanded ? ' is-expanded' : ' is-collapsed') + (initialBubble ? ' is-first-reply' : '')} data-reply-stage={progress.phase} aria-label="回复过程">
    <div className="companions-bubble-progress-row">
      <button type="button" className="companions-reply-process-toggle" aria-expanded={expanded} aria-controls={contentId} aria-label={expanded ? '收起回复过程' : '展开回复过程'} onClick={() => setExpanded(value => !value)}>
      <span className="companions-reply-process-symbol">
      <Icon name={initialBubble && !terminal ? 'loader' : failure ? 'alert-circle' : progress.phase === 'completed' ? 'check' : progress.phase === 'queued' || progress.phase === 'waiting' ? 'clock' : terminal ? 'pause' : 'activity'} size={13} />
      </span><span className="companions-reply-process-heading" role="status" aria-label="本条回复进度"><strong>{userStopped ? '用户已停止' : cancelling && !terminal ? '正在停止…' : labels[progress.phase]}</strong>{duration ? <time aria-label="本条回复总用时" dateTime={terminal ? finishedAt : undefined} title={'累计执行时间，不含排队、中断、停止或应用退出期间' + (terminal || progress.phase === 'queued' || !progress.phaseStartedAt ? '' : '；当前阶段 ' + elapsedTime(progress.phaseStartedAt, now))}>总用时 {duration}</time> : terminal && <span className="companions-bubble-duration-unknown">耗时未记录</span>}</span>
      <span className="companions-reply-process-chevron" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}><Icon name="chevron-right" size={12} /></span>
      </button>
      {memory?.status === 'unavailable' && <span className="companions-reply-memory-warning" title="相关回忆暂时不可用，可展开查看进展"><Icon name="alert-circle" size={12} />回忆暂不可用</span>}
      {progress.phase === 'queued' && onGuide && <button onClick={onGuide}>立即引导</button>}
      {!terminal && onCancel && <button aria-label="取消这条回复" disabled={cancelling} aria-busy={cancelling} onClick={() => void cancel()}>{cancelling ? '正在停止…' : '取消'}</button>}
      {terminal && progress.phase !== 'completed' && onRetry && <button aria-label="重试这条回复" disabled={retrying} aria-busy={retrying} onClick={() => void retry()}>{retrying ? '正在恢复…' : '重试'}</button>}
    </div>
    {terminal && retryError?.revision === progress.revision && <p className="companions-bubble-retry-error" role="alert">{retryError.message}</p>}
    {!terminal && cancelError && <p className="companions-bubble-cancel-error companions-bubble-retry-error" role="alert">{cancelError}</p>}
    {problem && detail && <p className="companions-bubble-retry-error" role="alert">{companionCapabilityDiagnostic(detail)}</p>}
    <div className="companions-reply-process-content" id={contentId} hidden={!expanded}>{expanded && <>
    {progress.phase !== 'completed' && !problem && detail && <span className="companions-bubble-progress-detail">{detail}</span>}
    {problem && detail && companionCapabilityDiagnostic(detail) !== detail && <details className="companions-reply-diagnostic"><summary>查看原始诊断</summary><pre>{detail}</pre></details>}
    {!terminal && progress.phaseStartedAt && <small className="companions-reply-phase-time">当前阶段已用时 {elapsedTime(progress.phaseStartedAt, now)}</small>}
    {memory && <div className="companions-bubble-memory"><span>{memoryLabel}</span><button type="button" aria-label="查看这次回复的回忆" aria-haspopup="dialog" onClick={() => setMemoryOpen(true)}>查看回忆<Icon name="arrow-up-right" size={11} /></button></div>}
    </>}</div>
    {memoryOpen && memory && <div className="companions-task-backdrop companions-reply-memory-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setMemoryOpen(false); }} onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); setMemoryOpen(false); } }}>
      <section className="companions-reply-memory-dialog" role="dialog" aria-modal="true" aria-label="这次回复的回忆"><header><div><h2>这次回复的回忆</h2><p>查看真正参考的内容与来源</p></div><button type="button" className="companion-icon-button" aria-label="关闭回忆详情" onClick={() => setMemoryOpen(false)}><Icon name="close" /></button></header>
        {memory.status === 'running' && !terminal ? <p className="companions-reply-memory-wait" role="status">这次回忆还在进行，完成后会显示实际使用的内容。</p>
          : <CompanionReplyMemoryDetails key={scope.companionId + ':' + scope.conversationId + ':' + scope.messageId} scope={scope} replyRunning={!terminal} refreshKey={[memory.status, memory.count, memory.injected, memory.pending, terminal ? progress.revision : 'live'].join(':')} />}
      </section>
    </div>}
  </section>;
}
