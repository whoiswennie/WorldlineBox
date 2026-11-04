import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BotCompanion, BotResponse } from '../../shared/companion-bot';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import './bot-peer-observation.css';

/** Opens an observed pair. This selector never sends a message as either actor. */
export function BotPeerConversationPicker({ companions, locale, onOpen, onClose }: {
  companions: readonly BotCompanion[]; locale: 'zh-CN' | 'en'; onOpen(memberIds: [string, string]): Promise<BotResponse>; onClose(): void;
}) {
  const zh = locale === 'zh-CN', [query, setQuery] = useState(''), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null), pending = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; const previous = document.activeElement; search.current?.focus(); return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')], first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const filtered = companions.filter(person => person.name.normalize('NFKC').toLocaleLowerCase().includes(query.trim().normalize('NFKC').toLocaleLowerCase()));
  const open = async () => {
    if (pending.current || selected.length !== 2) return;
    pending.current = true; setBusy(true); setError('');
    try { const result = await onOpen([selected[0]!, selected[1]!]); if (alive.current && !result.ok) setError(result.error || (zh ? '暂时无法打开伙伴私聊。' : 'Could not open this conversation.')); }
    catch { if (alive.current) setError(zh ? '暂时无法打开伙伴私聊。' : 'Could not open this conversation.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return createPortal(<div className="bot-peer-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-label={zh ? '查看伙伴私聊' : 'Observe companion conversation'} className="bot-peer-picker" ref={dialog} onKeyDown={keyboard}>
    <header><div><h2>{zh ? '伙伴私聊' : 'Companion conversations'}</h2><p>{zh ? '选择两位伙伴，查看他们之间的真实私聊。' : 'Choose two companions to observe their direct conversation.'}</p></div><button type="button" aria-label={zh ? '关闭伙伴私聊选择' : 'Close companion selector'} onClick={onClose}>×</button></header>
    <label className="bot-peer-picker-search"><BotIcon name="search" /><input ref={search} type="search" maxLength={80} aria-label={zh ? '搜索私聊伙伴' : 'Search companions'} placeholder={zh ? '搜索伙伴' : 'Search companions'} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="bot-peer-picker-list" role="group" aria-label={zh ? '选择两位私聊伙伴' : 'Choose two companions'}>{filtered.map(person => <button key={person.id} type="button" aria-pressed={selected.includes(person.id)} aria-label={person.name} disabled={busy || selected.length === 2 && !selected.includes(person.id)} onClick={() => setSelected(current => current.includes(person.id) ? current.filter(id => id !== person.id) : [...current, person.id])}><BotAvatar companion={person} /><span>{person.name}</span><i aria-hidden="true">{selected.includes(person.id) ? '✓' : '+'}</i></button>)}{!filtered.length && <p>{zh ? '没有匹配的伙伴' : 'No matching companions'}</p>}</div>
    <footer><p>{zh ? '仅打开记录，不会代替伙伴发消息。' : 'Opens records only. No message is sent on their behalf.'}<span>{selected.map(id => companions.find(person => person.id === id)?.name).join(' × ') || (zh ? '尚未选择伙伴' : 'No companions selected')}</span></p><button type="button" disabled={selected.length !== 2 || busy} onClick={() => void open()}>{busy ? zh ? '正在打开…' : 'Opening…' : zh ? '查看私聊' : 'Open conversation'}</button></footer>
    {error && <div className="bot-peer-picker-error" role="alert">{error}</div>}
  </section></div>, document.body);
}
