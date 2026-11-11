import { useEffect, useRef, useState } from 'react';
import { BotIcon } from './BotIcon';
import type { WorldlineBoxBrowserApi } from '../../shared/browser';
import type { BrowserPageContext } from '../../shared/browser-page-context';
import { BotBrowserTabPicker } from './BotBrowserTabPicker';
import './bot-apps.css';

export function BotAssetAppCard({ locale, connected = false, onRemove }: { locale: 'zh-CN' | 'en'; connected?: boolean; onRemove?(): void }) {
  const zh = locale === 'zh-CN';
  return <div className="bot-app-card" data-app-id="asset-manager" title={connected ? (zh ? '已连接此话题' : 'Connected to this topic') : (zh ? '已附加' : 'Attached')}><BotIcon name="assets" /><strong>{zh ? '资产库' : 'Assets'}</strong>{onRemove && <button type="button" title={zh ? '移除资产管理器' : 'Remove asset manager'} aria-label={zh ? '移除资产管理器' : 'Remove asset manager'} onClick={onRemove}><BotIcon name="close" /></button>}</div>;
}

export function BotApps({ locale, disabled, browserAvailable, browserApi, browserContext, assetAttached, onBrowser, onAssets, onBrowserActivityChange }: { locale: 'zh-CN' | 'en'; disabled?: boolean; browserAvailable: boolean; browserApi?: WorldlineBoxBrowserApi; browserContext?: BrowserPageContext; assetAttached: boolean; onBrowser(context: BrowserPageContext): Promise<void>; onAssets(): Promise<void>; onBrowserActivityChange?(active: boolean): void }) {
  const zh = locale === 'zh-CN', root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [view, setView] = useState<'apps' | 'browser'>('apps');
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); root.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const attach = async (id: string, operation: () => Promise<void>) => {
    setBusy(id); setError('');
    try { await operation(); setOpen(false); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };
  return <div className="bot-apps" ref={root}>
    <button type="button" className="bot-apps-trigger" disabled={disabled || !!busy} aria-label={zh ? '应用' : 'Apps'} title={zh ? '连接应用' : 'Connect apps'} aria-expanded={open} aria-haspopup="dialog" onClick={() => { setOpen(value => !value); setView('apps'); setError(''); }}><BotIcon name="apps" /><span>{zh ? '应用' : 'Apps'}</span></button>
    {open && <section className={`bot-apps-picker${view === 'browser' ? ' is-browser' : ''}`} role="dialog" aria-label={zh ? '连接应用' : 'Connect apps'}>
      {view === 'browser' && browserApi ? <BotBrowserTabPicker api={browserApi} selectedTabId={browserContext?.tabId} locale={locale} onSelect={onBrowser} onActivityChange={onBrowserActivityChange} onBack={() => setView('apps')} onDone={() => setOpen(false)} /> : <div className="bot-app-grid">
        <button type="button" className={`bot-app-choice${browserContext ? ' is-connected' : ''}`} aria-label={zh ? '内置浏览器' : 'Built-in browser'} title={zh ? '内置浏览器' : 'Built-in browser'} disabled={!browserAvailable || !browserApi || !!busy} onClick={() => setView('browser')}><BotIcon name="world" /><span className="bot-app-name">{zh ? '浏览器' : 'Browser'}</span></button>
        <button type="button" className={`bot-app-choice${assetAttached ? ' is-connected' : ''}${busy === 'assets' ? ' is-loading' : ''}`} aria-label={zh ? '资产管理器' : 'Asset manager'} title={zh ? '资产管理器' : 'Asset manager'} aria-pressed={assetAttached} aria-busy={busy === 'assets'} disabled={assetAttached || !!busy} onClick={() => { void attach('assets', onAssets); }}><BotIcon name="assets" /><span className="bot-app-name">{zh ? '资产库' : 'Assets'}</span>{assetAttached && <span className="bot-app-equipped"><BotIcon name="check" /></span>}{busy === 'assets' && <span className="bot-app-loading" />}</button>
      </div>
      }
      {error && <p className="bot-apps-error" role="alert">{error}</p>}
    </section>}
  </div>;
}
