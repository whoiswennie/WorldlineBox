import type { CompanionReplyProgress as Progress } from '../../shared/companion-reply-progress';
import { terminalReplyPhases } from '../../shared/companion-reply-progress';
import { Icon } from '../Icons';
import { elapsedTime } from './CompanionProgress';
import { useState } from 'react';
import { CompanionReplyMemoryDetails, type ReplyMemoryScope } from './CompanionReplyMemoryDetails';
import { companionTaskDuration } from './task-duration';
import './companion-reply-progress.css';

const labels: Record<Progress['phase'], string> = { queued: '排队中', waiting: '等待回复', context: '准备上下文', memory: '被动记忆召回', thinking: '正在思考', tools: '正在执行工具', streaming: '正在输出', completed: '回复完成', failed: '回复失败', cancelled: '已取消', interrupted: '回复中断' };

export function CompanionReplyProgress({ progress, now, scope, onCancel, onRetry, onGuide }: {
  progress: Progress; now: number; scope: ReplyMemoryScope; onCancel?(): void; onRetry?(): void; onGuide?(): void;
}) {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const terminal = terminalReplyPhases.has(progress.phase), failure = progress.phase === 'failed';
  const finishedAt = terminal ? progress.finishedAt ?? progress.updatedAt : undefined;
  const duration = companionTaskDuration(progress.startedAt, finishedAt, terminal ? undefined : now);
  const userStopped = progress.stop?.actor === 'user';
  const memory = progress.memory;
  const detail = ['正在输出回复', '正在生成回复', '正在整理本轮上下文', '已加入回复队列', '已重新加入回复队列', '这次回复已取消', '回复已完成'].includes(progress.detail) ? '' : progress.detail;
  const memoryLabel = memory?.status === 'running' ? '正在检索获权记忆'
    : memory?.status === 'unavailable' ? '被动召回暂不可用'
      : memory?.injected ? '已注入话题相关的记忆上下文'
        : memory?.count ? `已筛选 ${memory.count} 条候选 · 未纳入话题上下文` : memory?.pending ? '记忆仍在整理 · 本轮未命中' : '被动召回完成 · 无相关记忆';
  return <div className={'companions-bubble-progress' + (terminal ? ' is-terminal' : '') + (failure ? ' is-failed' : '')} data-reply-stage={progress.phase}>
    <div className="companions-bubble-progress-row" role="status" aria-label="本条回复进度">
      <Icon name={failure ? 'alert-circle' : progress.phase === 'completed' ? 'check' : progress.phase === 'queued' || progress.phase === 'waiting' ? 'clock' : terminal ? 'pause' : 'activity'} size={13} />
      <strong>{userStopped ? '用户已停止' : labels[progress.phase]}</strong>{duration ? <time aria-label="本条回复总用时" dateTime={terminal ? finishedAt : undefined} title={terminal ? '从排队开始到本轮结束，包含上下文、回忆和工具执行' : '当前阶段 ' + elapsedTime(progress.phaseStartedAt ?? progress.startedAt, now)}>总用时 {duration}</time> : terminal && <span className="companions-bubble-duration-unknown">耗时未记录</span>}
      {progress.phase === 'queued' && onGuide && <button onClick={onGuide}>立即引导</button>}
      {!terminal && onCancel && <button aria-label="取消这条回复" onClick={onCancel}>取消</button>}
      {terminal && progress.phase !== 'completed' && onRetry && <button aria-label="重试这条回复" onClick={onRetry}>重试</button>}
    </div>
    {progress.phase !== 'completed' && (detail || !terminal) && <span className="companions-bubble-progress-detail">{detail}</span>}
    {memory && <details className="companions-bubble-memory" open={memoryOpen} onToggle={event => setMemoryOpen(event.currentTarget.open)}><summary>{memoryLabel}<span>查看详情</span></summary>{memoryOpen && (memory.status === 'running' && !terminal
      ? <div className="companions-reply-memory-details" aria-label="本轮回忆详情" aria-busy="true"><header><span><Icon name="sparkles" size={15} /><strong>本轮回忆</strong></span></header><p className="reply-memory-note" role="status">召回仍在进行。完成后会在这里显示本条回复实际收到的记忆与来源。</p></div>
      : <CompanionReplyMemoryDetails key={scope.companionId + ':' + scope.conversationId + ':' + scope.messageId} scope={scope} replyRunning={!terminal} refreshKey={[memory.status, memory.count, memory.injected, memory.pending, terminal ? progress.revision : 'live'].join(':')} />)}</details>}
  </div>;
}
