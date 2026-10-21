import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../Icons';

/** Keep the composer quiet; exact estimates and budget controls live one click away. */
export function BrowserContextUsage({ used, budget, compacted, zh, settings }: {
  used: number; budget: number; compacted: number; zh: boolean; settings(): void;
}) {
  const [expanded, setExpanded] = useState(false); const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const id = useId(); const percent = Math.min(100, Math.max(0, used / budget * 100));
  const displayPercent = percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [expanded]);
  return <div className="browser-ai-context" ref={root}>
    <button type="button" className={'browser-ai-context-trigger' + (percent >= 85 ? ' is-high' : '')} ref={trigger}
      aria-label={zh ? '上下文用量' : 'Context usage'} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? id : undefined} onClick={() => setExpanded(value => !value)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="7" pathLength="100" strokeDasharray={`${percent} 100`} /></svg>
      <span>{zh ? '上下文' : 'Context'}</span><strong>{displayPercent}</strong>
    </button>
    {expanded ? <section id={id} className="browser-ai-context-details" role="dialog" aria-label={zh ? '上下文用量详情' : 'Context usage details'}>
      <header><Icon name="layers" size={15} /><strong>{zh ? '会话上下文' : 'Conversation context'}</strong><span>{displayPercent}</span></header>
      <div className="browser-ai-context-bar" role="meter" aria-label={zh ? '上下文使用比例' : 'Context utilization'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div>
      <dl><div><dt>{zh ? '预估已用' : 'Estimated used'}</dt><dd>≈ {Math.ceil(used).toLocaleString()}<small>tokens</small></dd></div>
        <div><dt>{zh ? '会话预算' : 'Context budget'}</dt><dd>{budget.toLocaleString()}<small>tokens</small></dd></div></dl>
      <p>{zh ? '包含对话、网页资料与工具说明，预算内预留回复空间。接近上限时整理早期记录。' : 'Includes chat, pages and tools, with room reserved for replies. Older context is compacted near the limit.'}</p>
      {compacted ? <p>{zh ? `本次会话已整理 ${compacted} 次早期上下文。` : `Earlier context compacted ${compacted} times in this conversation.`}</p> : null}
      <button type="button" onClick={() => { setExpanded(false); settings(); }}><Icon name="sliders" size={13} />{zh ? '调整上下文预算' : 'Adjust context budget'}</button>
    </section> : null}
  </div>;
}
