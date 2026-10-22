import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionCharacterDevelopment } from '../../shared/companion-character-development';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { ScheduleRequest } from './companion-schedules';
import { createCoalescedRefresh } from './coalesced-refresh';
import { Icon } from '../Icons';

const kinds = { preference: '喜欢', aversion: '不喜欢', value: '价值取向', voice: '表达方式' };
type Props = { companionId: string; conversationId: string; request: ScheduleRequest; api?: WorldlineBoxCompanionsApi; onOpenMemory?(id: string): void };
export function CompanionCharacterDevelopment(props: Props) { return <CharacterDevelopmentBody key={props.companionId + '/' + props.conversationId} {...props} />; }
function CharacterDevelopmentBody({ companionId, conversationId, request, api, onOpenMemory }: Props) {
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<CompanionCharacterDevelopment>(), [error, setError] = useState('');
  const alive = useRef(false), serial = useRef(0);
  const load = useCallback(async () => {
    const epoch = ++serial.current;
    try {
      const result = await request({ type: 'character.development', companionId, conversationId, limit: 12 });
      if (!alive.current || epoch !== serial.current) return;
      if (!result?.ok || result.characterDevelopment?.companionId !== companionId || result.characterDevelopment.conversationId !== conversationId) throw new Error(result?.error || '当前自我认识暂时无法核实。');
      setSnapshot(result.characterDevelopment); setError('');
    } catch (cause) { if (alive.current && epoch === serial.current) { setSnapshot(undefined); setError(cause instanceof Error ? cause.message : '当前自我认识暂时无法核实。'); } }
  }, [request, companionId, conversationId]);
  const stop = useCallback(() => { alive.current = false; ++serial.current; }, []);
  useEffect(() => {
    if (!open) return; alive.current = true; const reads = createCoalescedRefresh(load, undefined, 1000); void reads.trigger();
    const unsubscribe = api?.onChanged(() => reads.trigger());
    return () => { stop(); reads.dispose(); unsubscribe?.(); };
  }, [open, api, load, stop]);
  return <details className="companions-character-development" onToggle={event => { const expanded = event.currentTarget.open; setOpen(expanded); if (!expanded) { setSnapshot(undefined); setError(''); } }}><summary><Icon name="heart" size={13} /><span>现在的喜好与自我认识</span><Icon name="chevron" size={12} /></summary>{open && <>
    <p>来自当前有效、保留出处的自我认识。它们是伙伴的表达与反思，沿用原文的适用范围。</p>
    {error ? <p className="companions-state-sync-error" role="status">{error}<button type="button" onClick={() => void load()}>重新核对认识</button></p> : snapshot ? snapshot.items.length ? <ol aria-label="当前有效的自我认识">{snapshot.items.slice(0, 12).map(item => <li key={item.memoryId + ':' + item.memoryVersion + ':' + item.kind + ':' + item.topic} data-development-note={item.memoryId}><header><span>{kinds[item.kind]}</span><small>{item.basis === 'self_expression' ? '本人表达' : '经历反思'}</small></header><strong>{item.topic}</strong><p>{item.statement}</p>{item.qualification && <p className="companions-character-qualification">{item.qualification}</p>}<footer><small>版本 {item.memoryVersion} · {item.sourceMessageIds.length} 条来源</small>{onOpenMemory ? <button type="button" onClick={() => onOpenMemory(item.memoryId)}>查看认识原文<Icon name="arrow-up-right" size={11} /></button> : <code>{item.memoryId}</code>}</footer></li>)}</ol> : <p>还没有可在当前范围展示的有效自我认识，不推断固定喜好或价值观。</p> : <p role="status">正在核对当前有效的认识…</p>}
    {snapshot && (snapshot.truncated || snapshot.items.length > 12) && <p>这里只显示本次读取的一部分认识，其余内容仍可在记忆库查阅。</p>}
  </>}</details>;
}
