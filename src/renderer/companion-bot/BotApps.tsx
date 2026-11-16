import { useEffect, useRef, useState } from 'react';
import { BotIcon } from './BotIcon';
import type { WorldlineBoxBrowserApi } from '../../shared/browser';
import type { BrowserPageContext } from '../../shared/browser-page-context';
import { BotBrowserTabPicker } from './BotBrowserTabPicker';
import './bot-apps.css';

const topicApps = {
  'asset-manager': { icon: 'assets', zh: '资产库', en: 'Assets', labelZh: '资产管理器', labelEn: 'Asset manager' },
  'cabin-world': { icon: 'cabin', zh: '小屋世界', en: 'Cabin World', labelZh: '小屋世界', labelEn: 'Cabin World' },
} as const;
type TopicApp = keyof typeof topicApps;

export function BotTopicAppCard({ appId, locale, connected = false, onRemove }: { appId: TopicApp; locale: 'zh-CN' | 'en'; connected?: boolean; onRemove?(): void }) {
  const zh = locale === 'zh-CN';
  const app = topicApps[appId], remove = zh ? '移除' + app.labelZh : 'Remove ' + app.labelEn;
  const title = appId === 'cabin-world' ? (zh ? '伙伴会在此话题中感知自己的小屋近况' : 'The companion can sense their surroundings in this topic')
    : connected ? (zh ? '已连接此话题' : 'Connected to this topic') : (zh ? '已附加' : 'Attached');
  return <div className="bot-app-card" data-app-id={appId} title={title}><BotIcon name={app.icon} /><strong>{zh ? app.zh : app.en}</strong>{onRemove && <button type="button" title={remove} aria-label={remove} onClick={onRemove}><BotIcon name="close" /></button>}</div>;
}

export function BotApps({ locale, disabled, browserAvailable, browserApi, browserContext, assetAttached, cabinAttached, onBrowser, onAssets, onCabin, onBrowserActivityChange }: { locale: 'zh-CN' | 'en'; disabled?: boolean; browserAvailable: boolean; browserApi?: WorldlineBoxBrowserApi; browserContext?: BrowserPageContext; assetAttached: boolean; cabinAttached: boolean; onBrowser(context: BrowserPageContext): Promise<void>; onAssets(): Promise<void>; onCabin(): Promise<void>; onBrowserActivityChange?(active: boolean): void }) {
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
        {(['asset-manager', 'cabin-world'] as const).map(id => {
          const app = topicApps[id], attached = id === 'asset-manager' ? assetAttached : cabinAttached, loading = busy === id;
          const label = zh ? app.labelZh : app.labelEn;
          const title = id === 'cabin-world' && attached ? (zh ? '重新连接小屋世界' : 'Reconnect Cabin World') : label;
          return <button key={id} type="button" className={`bot-app-choice${attached ? ' is-connected' : ''}${loading ? ' is-loading' : ''}`} aria-label={label} title={title} aria-pressed={attached} aria-busy={loading} disabled={!!busy || (attached && id === 'asset-manager')} onClick={() => { void attach(id, id === 'asset-manager' ? onAssets : onCabin); }}><BotIcon name={app.icon} /><span className="bot-app-name">{zh ? app.zh : app.en}</span>{loading ? <span className="bot-app-loading" /> : attached && <span className="bot-app-equipped"><BotIcon name="check" /></span>}</button>;
        })}
      </div>
      }
      {error && <p className="bot-apps-error" role="alert">{error}</p>}
    </section>}
  </div>;
}
