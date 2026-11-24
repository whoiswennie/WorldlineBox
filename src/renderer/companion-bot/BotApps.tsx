import { useEffect, useRef, useState } from 'react';
import { BotIcon } from './BotIcon';
import type { WorldlineBoxBrowserApi } from '../../shared/browser';
import type { BotAppId } from '../../shared/companion-apps';
import { BotBrowserContextCard } from './BotBrowserContext';
import { BotBrowserTabPicker } from './BotBrowserTabPicker';
import { VideoLoginDialog } from './VideoLoginDialog';
import type { useBotChatApps } from './useBotChatApps';
import { useBotCallDocument } from './call-pet';
import './bot-apps.css';

const topicApps = {
  'asset-manager': { icon: 'assets', zh: '资产库', en: 'Assets', labelZh: '资产管理器', labelEn: 'Asset manager' },
  'cabin-world': { icon: 'cabin', zh: '小屋世界', en: 'Cabin World', labelZh: '小屋世界', labelEn: 'Cabin World' },
  music: { icon: 'music', zh: '音乐', en: 'Music', labelZh: '音乐', labelEn: 'Music' },
  video: { icon: 'video', zh: '视频', en: 'Video', labelZh: '哔哩哔哩视频', labelEn: 'Bilibili video' },
} as const satisfies Record<Exclude<BotAppId, 'browser'>, { icon: Parameters<typeof BotIcon>[0]['name']; zh: string; en: string; labelZh: string; labelEn: string }>;
type TopicApp = keyof typeof topicApps;
const topicAppIds = Object.keys(topicApps) as TopicApp[];
type ChatApps = ReturnType<typeof useBotChatApps>;
type AppChoice = {
  id: TopicApp | 'browser';
  icon: Parameters<typeof BotIcon>[0]['name'];
  name: string;
  label: string;
  title: string;
  attached: boolean;
  disabled: boolean;
  open(): void;
};

export function BotTopicAppCard({ appId, locale, connected = false, onOpen, onRemove }: { appId: TopicApp; locale: 'zh-CN' | 'en'; connected?: boolean; onOpen?(): void; onRemove?(): void }) {
  const zh = locale === 'zh-CN';
  const app = topicApps[appId], remove = zh ? '移除' + app.labelZh : 'Remove ' + app.labelEn;
  const title = appId === 'cabin-world' ? (zh ? '伙伴会在此聊天中感知自己的小屋近况' : 'The companion can sense their surroundings in this chat')
    : connected ? (zh ? '已连接此聊天' : 'Connected to this chat') : (zh ? '已附加' : 'Attached');
  return <div className="bot-app-card" data-app-id={appId} title={title}>{onOpen ? <button type="button" className="bot-app-open-site" title={zh ? '在内置浏览器打开哔哩哔哩' : 'Open Bilibili in the built-in browser'} onClick={onOpen}><BotIcon name={app.icon} /><strong>{zh ? app.zh : app.en}</strong></button> : <><BotIcon name={app.icon} /><strong>{zh ? app.zh : app.en}</strong></>}{onRemove && <button type="button" title={remove} aria-label={remove} onClick={onRemove}><BotIcon name="close" /></button>}</div>;
}

export function BotAppAttachments({ locale, chatApps, onOpenUrl, onOpenBrowserContext, onError }: {
  locale: 'zh-CN' | 'en'; chatApps: ChatApps; onOpenUrl(url: string): void; onOpenBrowserContext?(id: string): void; onError(message: string): void;
}) {
  const { apps, browserContext, loginPrompt, dismissLogin, detach } = chatApps;
  const remove = (appId: BotAppId) => { void detach(appId).catch(error => onError(error instanceof Error ? error.message : String(error))); };
  return <>
    {loginPrompt && <VideoLoginDialog state={loginPrompt} zh={locale === 'zh-CN'} dismiss={dismissLogin} openUrl={onOpenUrl} />}
    {topicAppIds.filter(appId => apps.includes(appId)).map(appId => <BotTopicAppCard key={appId} appId={appId} locale={locale} connected
      onOpen={appId === 'video' ? () => onOpenUrl('https://www.bilibili.com/') : undefined} onRemove={() => remove(appId)} />)}
    {browserContext && <BotBrowserContextCard context={browserContext} locale={locale}
      onOpen={onOpenBrowserContext ? () => onOpenBrowserContext(browserContext.tabId) : undefined} onRemove={() => remove('browser')} />}
  </>;
}

export function BotApps({ locale, disabled, browserApi, chatApps }: {
  locale: 'zh-CN' | 'en'; disabled?: boolean; browserApi?: WorldlineBoxBrowserApi;
  chatApps: Pick<ChatApps, 'apps' | 'browserContext' | 'connect' | 'attachBrowser' | 'onBrowserActivityChange'>;
}) {
  const { apps: attachedApps, browserContext, connect, attachBrowser, onBrowserActivityChange } = chatApps;
  const zh = locale === 'zh-CN', root = useRef<HTMLDivElement>(null);
  const surface = useBotCallDocument();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [view, setView] = useState<'apps' | 'browser'>('apps');
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); root.current?.querySelector('button')?.focus(); } };
    surface.addEventListener('pointerdown', outside); surface.addEventListener('keydown', escape);
    return () => { surface.removeEventListener('pointerdown', outside); surface.removeEventListener('keydown', escape); };
  }, [open, surface]);
  const attach = async (id: string, operation: () => Promise<void>) => {
    setBusy(id); setError('');
    try { await operation(); setOpen(false); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };
  const apps = topicAppIds.map<AppChoice>(id => {
    const attached = attachedApps.includes(id);
    const app = topicApps[id];
    const label = zh ? app.labelZh : app.labelEn;
    return { id, icon: app.icon,
      name: zh ? app.zh : app.en, label, attached, disabled: attached && id !== 'cabin-world',
      title: id === 'cabin-world' && attached ? (zh ? '重新连接小屋世界' : 'Reconnect Cabin World') : label,
      open: () => { void attach(id, () => connect(id)); } };
  });
  const browserLabel = zh ? '内置浏览器' : 'Built-in browser';
  apps.unshift({ id: 'browser', icon: 'world', name: zh ? '浏览器' : 'Browser', label: browserLabel, title: browserLabel,
    attached: attachedApps.includes('browser'), disabled: !browserApi, open: () => setView('browser') });
  const search = query.trim().toLocaleLowerCase();
  const visibleApps = apps.filter(app => (app.name + ' ' + app.label).toLocaleLowerCase().includes(search));
  return <div className="bot-apps" ref={root}>
    <button type="button" className="bot-apps-trigger" disabled={disabled || !!busy} aria-label={zh ? '应用' : 'Apps'} title={zh ? '连接应用' : 'Connect apps'} aria-expanded={open} aria-haspopup="dialog" onClick={() => { setOpen(value => !value); setView('apps'); setQuery(''); setError(''); }}><BotIcon name="apps" /><span>{zh ? '应用' : 'Apps'}</span></button>
    {open && <section className={`bot-apps-picker${view === 'browser' ? ' is-browser' : ''}`} role="dialog" aria-label={zh ? '连接应用' : 'Connect apps'}>
      {view === 'browser' && browserApi ? <BotBrowserTabPicker api={browserApi} selectedTabId={browserContext?.tabId} locale={locale} onSelect={attachBrowser} onActivityChange={onBrowserActivityChange} onBack={() => setView('apps')} onDone={() => setOpen(false)} /> : <>
        {apps.length > 6 && <label className="bot-browser-tab-search bot-app-search"><BotIcon name="search" /><input type="search"
          aria-label={zh ? '搜索应用' : 'Search apps'} placeholder={zh ? '搜索应用' : 'Search apps'} value={query} onChange={event => setQuery(event.target.value)} /></label>}
        <div className="bot-app-list">
          {visibleApps.map(app => {
            const loading = busy === app.id;
            return <button key={app.id} type="button" className={`bot-app-choice${app.attached ? ' is-connected' : ''}`}
              aria-label={app.label} title={app.title} aria-pressed={app.attached} aria-busy={loading}
              disabled={!!busy || app.disabled} onClick={app.open}>
              <BotIcon name={app.icon} /><span className="bot-app-name">{app.name}</span>
              {loading ? <span className="bot-app-loading" /> : (app.attached || app.id === 'browser') && <span className="bot-app-indicator"><BotIcon name={app.attached ? 'check' : 'chevron-right'} /></span>}
            </button>;
          })}
          {!visibleApps.length && <p className="bot-app-empty">{zh ? '找不到应用' : 'No apps found'}</p>}
        </div>
      </>}
      {error && <p className="bot-apps-error" role="alert">{error}</p>}
    </section>}
  </div>;
}
