import { useEffect, useRef, useState } from 'react';
import { BotIcon } from './BotIcon';
import { BotAppArtwork } from './BotAppArtwork';
import './bot-apps.css';

export function BotAssetAppCard({ locale, connected = false, onRemove }: { locale: 'zh-CN' | 'en'; connected?: boolean; onRemove?(): void }) {
  const zh = locale === 'zh-CN';
  return <div className="bot-app-card" data-app-id="asset-manager" title={connected ? (zh ? '已连接此话题' : 'Connected to this topic') : (zh ? '已附加' : 'Attached')}><BotAppArtwork app="assets" /><strong>{zh ? '资产库' : 'Assets'}</strong>{onRemove && <button type="button" title={zh ? '移除资产管理器' : 'Remove asset manager'} aria-label={zh ? '移除资产管理器' : 'Remove asset manager'} onClick={onRemove}><BotIcon name="close" /></button>}</div>;
}

export function BotApps({ locale, disabled, browserAvailable, assetAttached, onBrowser, onAssets }: { locale: 'zh-CN' | 'en'; disabled?: boolean; browserAvailable: boolean; assetAttached: boolean; onBrowser(): Promise<void>; onAssets(): Promise<void> }) {
  const zh = locale === 'zh-CN', root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
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
    <button type="button" className="bot-apps-trigger" disabled={disabled || !!busy} aria-label={zh ? '应用' : 'Apps'} title={zh ? '连接应用' : 'Connect apps'} aria-expanded={open} aria-haspopup="dialog" onClick={() => { setOpen(value => !value); setError(''); }}><BotIcon name="apps" /><span>{zh ? '应用' : 'Apps'}</span></button>
    {open && <section className="bot-apps-picker" role="dialog" aria-label={zh ? '连接应用' : 'Connect apps'}>
      <div className="bot-app-grid">
        <button type="button" className={`bot-app-choice${busy === 'browser' ? ' is-loading' : ''}`} aria-label={zh ? '内置浏览器' : 'Built-in browser'} title={zh ? '内置浏览器' : 'Built-in browser'} aria-busy={busy === 'browser'} disabled={!browserAvailable || !!busy} onClick={() => { void attach('browser', onBrowser); }}><span className="bot-app-tile"><BotAppArtwork app="browser" />{busy === 'browser' && <span className="bot-app-loading" />}</span><span className="bot-app-name">{zh ? '浏览器' : 'Browser'}</span></button>
        <button type="button" className={`bot-app-choice${assetAttached ? ' is-connected' : ''}${busy === 'assets' ? ' is-loading' : ''}`} aria-label={zh ? '资产管理器' : 'Asset manager'} title={zh ? '资产管理器' : 'Asset manager'} aria-pressed={assetAttached} aria-busy={busy === 'assets'} disabled={assetAttached || !!busy} onClick={() => { void attach('assets', onAssets); }}><span className="bot-app-tile"><BotAppArtwork app="assets" />{assetAttached && <span className="bot-app-equipped"><BotIcon name="check" /></span>}{busy === 'assets' && <span className="bot-app-loading" />}</span><span className="bot-app-name">{zh ? '资产库' : 'Assets'}</span></button>
      </div>
      {error && <p className="bot-apps-error" role="alert">{error}</p>}
    </section>}
  </div>;
}
