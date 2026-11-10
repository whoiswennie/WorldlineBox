import { useEffect, useRef, useState } from 'react';
import type { BrowserPageContext } from '../../shared/browser-page-context';
import type { BotCompanion } from '../../shared/companion-bot';
import { BotIcon } from './BotIcon';
import { BotAvatar } from './BotAvatar';
import './bot-browser-context.css';

export function BotBrowserContextCard({ context, locale, onRemove, onOpen }: { context: BrowserPageContext; locale: 'zh-CN' | 'en'; onRemove?(): void; onOpen?(): void }) {
  const zh = locale === 'zh-CN';
  return <div className="bot-browser-context-card" data-browser-context-tab={context.tabId}><span className="bot-browser-context-symbol"><BotIcon name="world" /></span><div><small>{zh ? '内置浏览器 · 已附加页面' : 'Built-in browser · attached page'}</small><strong title={context.title || context.url}>{context.title || context.url}</strong><span title={context.url}>{context.url}</span></div>{onOpen && <button type="button" aria-label={zh ? '查看所附网页' : 'View attached page'} title={zh ? '查看所附网页' : 'View attached page'} onClick={onOpen}><BotIcon name="external" /></button>}{onRemove && <button type="button" aria-label={zh ? '移除网页上下文' : 'Remove page context'} onClick={onRemove}>×</button>}</div>;
}

export function BotBrowserContextPicker({ context, companions, locale, onSelect, onClose }: { context: BrowserPageContext; companions: readonly BotCompanion[]; locale: 'zh-CN' | 'en'; onSelect(id: string): Promise<void>; onClose(): void }) {
  const zh = locale === 'zh-CN', search = useRef<HTMLInputElement>(null), [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { search.current?.focus(); }, []);
  const needle = query.replace(/^@/u, '').trim().toLocaleLowerCase();
  const items = companions.filter(actor => actor.enabled !== false && (!needle || (actor.name + actor.id).toLocaleLowerCase().includes(needle)));
  return <div className="bot-browser-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}><section role="dialog" aria-modal="true" aria-label={zh ? '呼唤伙伴' : 'Call a companion'} className="bot-browser-picker"><header><div><h2>{zh ? '呼唤伙伴' : 'Call a companion'}</h2><p>{zh ? '选择伙伴，把当前网页带到聊天中。' : 'Choose a companion and attach this page to your chat.'}</p></div><button type="button" aria-label={zh ? '关闭伙伴选择' : 'Close companion picker'} disabled={busy} onClick={onClose}>×</button></header><BotBrowserContextCard context={context} locale={locale} /><label className="bot-browser-picker-search"><BotIcon name="search" /><input ref={search} value={query} disabled={busy} aria-label={zh ? '@伙伴名称' : '@companion name'} placeholder={zh ? '@伙伴名称' : '@companion name'} onChange={event => setQuery(event.target.value)} /></label><div className="bot-browser-picker-list">{items.map(actor => <button type="button" key={actor.id} disabled={busy} onClick={() => { setBusy(true); setError(''); void onSelect(actor.id).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); }}><BotAvatar companion={actor} /><strong>{actor.name}</strong><span>@</span></button>)}{!items.length && <p>{zh ? '没有匹配的伙伴' : 'No matching companions'}</p>}</div><footer>{zh ? '沿用此标签页的登录状态；发送任务后优先操作所附页面。' : 'Uses this tab’s signed-in state. Send your task to work on the attached page.'}</footer>{error && <p role="alert">{error}</p>}</section></div>;
}
