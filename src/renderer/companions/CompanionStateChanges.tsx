import { useState } from 'react';
import type { CompanionRuntimeState } from '../../shared/companion-state';
import { Icon } from '../Icons';

type Change = NonNullable<CompanionRuntimeState['recentChanges']>[number];
const kinds: Record<Change['kind'], string> = { appraisal: '互动理解', task: '任务结果', world: '生活经历', interruption: '被打扰后', memory: '记忆整合' };
const affectLabels = { pleasure: '愉悦', arousal: '活跃', dominance: '自主' };
const relationshipLabels = { affinity: '好感', trust: '信任', respect: '尊重' };
const expressionLabels: Record<string, string> = { gentle: '温柔', direct: '直率', playful: '轻快', reserved: '安静' };
function signed(value: number) { return (value > 0 ? '+' : '') + (Math.abs(value) < .0001 ? value.toExponential(2) : Number(value.toFixed(4)).toString()); }
function at(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未记录'; }
function values(change: Change) {
  return [
    ...Object.entries(affectLabels).map(([key, label]) => ({ label, value: change.affectDelta[key as keyof typeof affectLabels] })),
    ...Object.entries(relationshipLabels).map(([key, label]) => ({ label, value: change.relationshipDelta[key as keyof typeof relationshipLabels] })),
    { label: '精力', value: change.energyDelta },
  ].filter(item => Number.isFinite(item.value) && item.value !== 0);
}
type SourceProps = { change: Change; onLocateSource?(conversationId: string, messageId: string): void; onOpenMemory?(noteId: string): void };
function StateChangeSources({ change, onLocateSource, onOpenMemory }: SourceProps) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(0);
  const items = [...change.sourceMessageIds.map((id, index) => ({ id, index, kind: 'message' as const })), ...(change.memoryIds ?? []).map((id, index) => ({ id, index, kind: 'memory' as const }))];
  const lastPage = Math.max(0, Math.ceil(items.length / 10) - 1), current = Math.min(page, lastPage);
  return <details className="companions-state-change-sources" onToggle={event => setOpen(event.currentTarget.open)}><summary>查看来源</summary>{open && <>
    {change.occurredAt !== change.appliedAt && <p>来源发生于 <time dateTime={change.occurredAt} title={change.occurredAt}>{at(change.occurredAt)}</time></p>}
    {!items.length ? <p>这条生效记录未提供可展示的消息或记忆来源。</p> : <ul>{items.slice(current * 10, current * 10 + 10).map(item => <li key={item.kind + item.id}>
      {item.kind === 'message' ? onLocateSource && change.sourceConversationId ? <button type="button" onClick={() => onLocateSource(change.sourceConversationId!, item.id)}>查看来源消息 {item.index + 1}<Icon name="arrow-up-right" size={11} /></button> : <span>消息来源 {item.index + 1}</span> : onOpenMemory ? <button type="button" onClick={() => onOpenMemory(item.id)}>查看相关记忆 {item.index + 1}<Icon name="arrow-up-right" size={11} /></button> : <span>相关记忆 {item.index + 1}</span>}
      <code>{item.id}</code></li>)}</ul>}
    {lastPage > 0 && <nav aria-label="状态变化来源分页"><button type="button" disabled={!current} onClick={() => setPage(current - 1)}>上一页来源</button><span>{current + 1} / {lastPage + 1}</span><button type="button" disabled={current === lastPage} onClick={() => setPage(current + 1)}>下一页来源</button></nav>}
  </>}</details>;
}

/** These are host-committed deltas, never an inference from two UI snapshots. */
export function CompanionStateChanges({ changes, onLocateSource, onOpenMemory }: {
  changes?: CompanionRuntimeState['recentChanges'];
  onLocateSource?(conversationId: string, messageId: string): void;
  onOpenMemory?(noteId: string): void;
}) {
  const [open, setOpen] = useState(false);
  return <details className="companions-state-changes" onToggle={event => setOpen(event.currentTarget.open)}><summary><Icon name="activity" size={13} /><span>状态变化的来处</span>{!!changes?.length && <small>最近 {Math.min(changes.length, 5)} 条</small>}<Icon name="chevron" size={12} /></summary>{open && <>
    {!changes?.length ? <p>当前没有可展示的近期生效凭证；不根据数值或记忆数量推断变化。</p> : <><ol aria-label="最近已生效的状态变化">{changes.slice(0, 5).map(change => {
      const deltas = values(change);
      return <li key={change.id} data-state-change={change.id}><header><span>{kinds[change.kind]}</span><time dateTime={change.appliedAt} title={change.appliedAt}>{at(change.appliedAt)}</time></header><p>{change.reason}</p>
        {deltas.length ? <div className="companions-state-change-deltas" aria-label="当时生效的属性变化">{deltas.map(item => <span key={item.label}>{item.label}<b>{signed(item.value)}</b></span>)}</div> : <small>本条记录未包含非零属性增减。</small>}
        {change.expression && change.expression.before !== change.expression.after && <p className="companions-state-change-authored">表达 {expressionLabels[change.expression.before] ?? change.expression.before} → {expressionLabels[change.expression.after] ?? change.expression.after}</p>}
        {change.focus && (change.focus.before ?? '') !== (change.focus.after ?? '') && <p className="companions-state-change-authored">关注 {change.focus.before || '未设置'} → {change.focus.after || '已清空'}</p>}
        <StateChangeSources key={change.id} change={change} onLocateSource={onLocateSource} onOpenMemory={onOpenMemory} />
      </li>;
    })}</ol><p className="companions-state-changes-note">增减值是当时的生效记录；当前状态以上方数值为准。</p></>}
  </>}</details>;
}
