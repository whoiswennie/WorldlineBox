import type { CompanionReplyProgress as Progress } from '../../shared/companion-reply-progress';
import { terminalReplyPhases } from '../../shared/companion-reply-progress';
import { Icon } from '../Icons';
import { elapsedTime } from './CompanionProgress';
import { useState } from 'react';
import { CompanionReplyMemoryDetails, type ReplyMemoryScope } from './CompanionReplyMemoryDetails';
import './companion-reply-progress.css';

const labels: Record<Progress['phase'], string> = { queued: '排队中', waiting: '等待回复', context: '准备上下文', memory: '被动记忆召回', thinking: '正在思考', tools: '正在执行工具', streaming: '正在输出', completed: '回复完成', failed: '回复失败', cancelled: '已取消', interrupted: '回复中断' };

export function CompanionReplyProgress({ progress, now, scope, onCancel, onRetry, onGuide }: {
  progress: Progress; now: number; scope: ReplyMemoryScope; onCancel?(): void; onRetry?(): void; onGuide?(): void;
}) {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const terminal = terminalReplyPhases.has(progress.phase), failure = progress.phase === 'failed';
  const memory = progress.memory;
  const detail = ['正在输出回复', '正在生成回复', '正在整理本轮上下文', '已加入回复队列', '已重新加入回复队列', '这次回复已取消', '回复已完成'].includes(progress.detail) ? '' : progress.detail;
  const memoryLabel = memory?.status === 'running' ? '正在检索获权记忆'
    : memory?.status === 'unavailable' ? '被动召回暂不可用'
      : memory?.injected ? '已注入话题相关的记忆上下文'
        : memory?.count ? `已筛选 ${memory.count} 条候选 · 未纳入话题上下文` : memory?.pending ? '记忆仍在整理 · 本轮未命中' : '被动召回完成 · 无相关记忆';
  return <div className={'companions-bubble-progress' + (terminal ? ' is-terminal' : '') + (failure ? ' is-failed' : '')} data-reply-stage={progress.phase}>
    <div className="companions-bubble-progress-row" role="status" aria-label="本条回复进度">
      <Icon name={failure ? 'alert-circle' : progress.phase === 'completed' ? 'check' : progress.phase === 'queued' || progress.phase === 'waiting' ? 'clock' : terminal ? 'pause' : 'activity'} size={13} />
      <strong>{labels[progress.phase]}</strong>{!terminal && <time>{elapsedTime(progress.startedAt, now)}</time>}
      {progress.phase === 'queued' && onGuide && <button onClick={onGuide}>立即引导</button>}
      {!terminal && onCancel && <button aria-label="取消这条回复" onClick={onCancel}>取消</button>}
      {terminal && progress.phase !== 'completed' && onRetry && <button aria-label="重试这条回复" onClick={onRetry}>重试</button>}
    </div>
    {progress.phase !== 'completed' && detail && <span className="companions-bubble-progress-detail">{detail}</span>}
    {memory && <details className="companions-bubble-memory" onToggle={event => setMemoryOpen(event.currentTarget.open)}><summary>{memoryLabel}<span>查看详情</span></summary>{memoryOpen && <CompanionReplyMemoryDetails key={scope.companionId + ':' + scope.conversationId + ':' + scope.messageId} scope={scope} refreshKey={[memory.status, memory.count, memory.injected, memory.pending, terminal ? progress.revision : 'live'].join(':')} />}</details>}
  </div>;
}
