import type { CompanionReplyProgress as Progress } from '../../shared/companion-reply-progress';
import { companionReplyElapsedMs, terminalReplyPhases } from '../../shared/companion-reply-progress';
import { Icon } from '../Icons';
import { elapsedTime } from './CompanionProgress';
import { useId, useState } from 'react';
import { CompanionReplyMemoryDetails, type ReplyMemoryScope } from './CompanionReplyMemoryDetails';
import { companionDurationMilliseconds } from './task-duration';
import './companion-reply-progress.css';

const labels: Record<Progress['phase'], string> = { queued: '排队中', waiting: '等待回复', context: '准备上下文', memory: '被动记忆召回', thinking: '正在思考', tools: '正在执行工具', streaming: '正在输出', completed: '回复完成', failed: '回复失败', cancelled: '已取消', interrupted: '回复中断' };

type ProgressProps = {
  progress: Progress; now: number; scope: ReplyMemoryScope; onCancel?(): void; onRetry?(): void | Promise<unknown>; onGuide?(): void;
  revealCompleted?: boolean;
};

export function CompanionReplyProgress(props: ProgressProps) {
  if (props.progress.phase === 'completed' && !props.revealCompleted) return null;
  return <ReplyProcess key={props.progress.workId ?? props.progress.startedAt} {...props} />;
}

function ReplyProcess({ progress, now, scope, onCancel, onRetry, onGuide }: ProgressProps) {
  const [expanded, setExpanded] = useState(true);
  const [memoryOpen, setMemoryOpen] = useState(false);
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
  const finishedAt = terminal ? progress.finishedAt ?? progress.updatedAt : undefined;
  const elapsedMs = companionReplyElapsedMs(progress, now);
  const duration = elapsedMs === undefined ? undefined : companionDurationMilliseconds(elapsedMs);
  const userStopped = progress.stop?.actor === 'user';
  const memory = progress.memory;
  const detail = ['正在输出回复', '正在生成回复', '正在整理本轮上下文', '已加入回复队列', '已重新加入回复队列', '这次回复已取消', '回复已完成'].includes(progress.detail) || /^正在调用能力[：:]/u.test(progress.detail) ? '' : progress.detail;
  const memoryLabel = memory?.status === 'running' ? '正在检索获权记忆'
    : memory?.status === 'unavailable' ? '被动召回暂不可用'
      : memory?.injected ? '已注入话题相关的记忆上下文'
        : memory?.count ? `已筛选 ${memory.count} 条候选 · 未纳入话题上下文` : memory?.pending ? '记忆仍在整理 · 本轮未命中' : '被动召回完成 · 无相关记忆';
  return <section className={'companions-bubble-progress' + (terminal ? ' is-terminal' : ' is-running') + (failure ? ' is-failed' : '') + (expanded ? ' is-expanded' : ' is-collapsed')} data-reply-stage={progress.phase} aria-label="回复过程">
    <div className="companions-bubble-progress-row">
      <button type="button" className="companions-reply-process-toggle" aria-expanded={expanded} aria-controls={contentId} aria-label={expanded ? '收起回复过程' : '展开回复过程'} onClick={() => setExpanded(value => !value)}>
      <span className="companions-reply-process-symbol">
      <Icon name={failure ? 'alert-circle' : progress.phase === 'completed' ? 'check' : progress.phase === 'queued' || progress.phase === 'waiting' ? 'clock' : terminal ? 'pause' : 'activity'} size={13} />
      </span><span className="companions-reply-process-heading" role="status" aria-label="本条回复进度"><strong>{userStopped ? '用户已停止' : labels[progress.phase]}</strong>{duration ? <time aria-label="本条回复总用时" dateTime={terminal ? finishedAt : undefined} title={'累计执行时间，不含排队、中断、停止或应用退出期间' + (terminal || progress.phase === 'queued' ? '' : '；当前阶段 ' + elapsedTime(progress.phaseStartedAt ?? progress.startedAt, now))}>总用时 {duration}</time> : terminal && <span className="companions-bubble-duration-unknown">耗时未记录</span>}</span>
      <span className="companions-reply-process-chevron" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}><Icon name="chevron-right" size={12} /></span>
      </button>
      {progress.phase === 'queued' && onGuide && <button onClick={onGuide}>立即引导</button>}
      {!terminal && onCancel && <button aria-label="取消这条回复" onClick={onCancel}>取消</button>}
      {terminal && progress.phase !== 'completed' && onRetry && <button aria-label="重试这条回复" disabled={retrying} aria-busy={retrying} onClick={() => void retry()}>{retrying ? '正在恢复…' : '重试'}</button>}
    </div>
    {terminal && retryError?.revision === progress.revision && <p className="companions-bubble-retry-error" role="alert">{retryError.message}</p>}
    <div className="companions-reply-process-content" id={contentId} hidden={!expanded}>{expanded && <>
    {progress.phase !== 'completed' && detail && <span className="companions-bubble-progress-detail">{detail}</span>}
    {memory && <details className="companions-bubble-memory" open={memoryOpen} onToggle={event => setMemoryOpen(event.currentTarget.open)}><summary>{memoryLabel}<span>查看详情</span></summary>{memoryOpen && (memory.status === 'running' && !terminal
      ? <div className="companions-reply-memory-details" aria-label="本轮回忆详情" aria-busy="true"><header><span><Icon name="sparkles" size={15} /><strong>本轮回忆</strong></span></header><p className="reply-memory-note" role="status">召回仍在进行。完成后会在这里显示本条回复实际收到的记忆与来源。</p></div>
      : <CompanionReplyMemoryDetails key={scope.companionId + ':' + scope.conversationId + ':' + scope.messageId} scope={scope} replyRunning={!terminal} refreshKey={[memory.status, memory.count, memory.injected, memory.pending, terminal ? progress.revision : 'live'].join(':')} />)}</details>}
    </>}</div>
  </section>;
}
