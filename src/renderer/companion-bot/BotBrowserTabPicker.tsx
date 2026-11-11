import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserState, WorldlineBoxBrowserApi } from '../../shared/browser';
import type { BrowserPageContext } from '../../shared/browser-page-context';
import { BotIcon } from './BotIcon';

function pageHost(url: string): string {
  try { const value = new URL(url); return ['http:', 'https:'].includes(value.protocol) && !value.username && !value.password ? value.host : ''; }
  catch { return ''; }
}

/** A deliberate choice replaces the one page attached to the composer. */
export function BotBrowserTabPicker({ api, selectedTabId, locale, onSelect, onBack, onDone, onActivityChange }: {
  api: WorldlineBoxBrowserApi; selectedTabId?: string; locale: 'zh-CN' | 'en';
  onSelect(context: BrowserPageContext): Promise<void>; onBack(): void; onDone(): void;
  onActivityChange?(active: boolean): void;
}) {
  const zh = locale === 'zh-CN', [state, setState] = useState<BrowserState>(), [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const live = useRef(false), pending = useRef(false), epoch = useRef(0), revision = useRef(-1);
  const activity = useRef(onActivityChange);
  useLayoutEffect(() => { activity.current = onActivityChange; }, [onActivityChange]);
  const load = async () => {
    const current = ++epoch.current; setLoading(true); setError('');
    try {
      const result = await api.request({ type: 'state' });
      if (!live.current || current !== epoch.current) return;
      if (!result.ok) throw Error(result.error);
      if (!result.state) throw Error(zh ? '无法获取标签页，请重试。' : 'Unable to load tabs. Try again.');
      if (result.state.revision >= revision.current) { revision.current = result.state.revision; setState(result.state); }
    } catch (failure) { if (live.current && current === epoch.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (live.current && current === epoch.current) setLoading(false); }
  };
  const refresh = useRef(load);
  useLayoutEffect(() => { refresh.current = load; });
  useEffect(() => {
    live.current = true; void refresh.current();
    const unsubscribe = api.onChanged(next => { if (live.current && next.revision >= revision.current) { revision.current = next.revision; setState(next); } });
    return () => { live.current = false; epoch.current += 1; unsubscribe(); activity.current?.(false); };
  }, [api]);
  const choose = async (id: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(id); setError(''); activity.current?.(true);
    try {
      const result = await api.request({ type: 'page.context', id });
      if (!live.current) return;
      if (!result.ok) throw Error(result.error);
      if (!result.pageContext || result.pageContext.tabId !== id) throw Error(zh ? '页面已变化，请重新选择。' : 'The page changed. Select it again.');
      await onSelect(result.pageContext);
      if (live.current) onDone();
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; if (live.current) { setBusy(''); activity.current?.(false); } }
  };
  const needle = query.trim().toLocaleLowerCase();
  const tabs = state?.tabs.filter(tab => pageHost(tab.url) && (!needle || `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(needle))) ?? [];
  return <div className="bot-browser-tab-picker">
    <header><button type="button" aria-label={zh ? '返回应用' : 'Back to apps'} title={zh ? '返回应用' : 'Back to apps'} disabled={!!busy} onClick={onBack}><BotIcon name="arrow-left" /></button><strong>{zh ? '选择标签页' : 'Choose a tab'}</strong><button type="button" aria-label={zh ? '刷新标签页' : 'Refresh tabs'} title={zh ? '刷新标签页' : 'Refresh tabs'} disabled={loading || !!busy} onClick={() => void load()}><BotIcon name="history" /></button></header>
    <label className="bot-browser-tab-search"><BotIcon name="search" /><input autoFocus aria-label={zh ? '搜索标签页' : 'Search tabs'} placeholder={zh ? '搜索标签页' : 'Search tabs'} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="bot-browser-tab-list" role="listbox" aria-label={zh ? '浏览器标签页' : 'Browser tabs'} aria-busy={loading || !!busy}>
      {tabs.map(tab => <button key={tab.id} type="button" role="option" aria-selected={tab.id === selectedTabId} aria-label={`${tab.title || pageHost(tab.url)} · ${pageHost(tab.url)}`} disabled={!!busy} title={tab.url} onClick={() => void choose(tab.id)}>
        <BotIcon name="world" /><span><strong>{tab.title || pageHost(tab.url)}</strong><small>{pageHost(tab.url)}</small></span>
        {busy === tab.id ? <i className="bot-app-loading" aria-label={zh ? '正在附加网页' : 'Attaching page'} /> : tab.id === selectedTabId ? <BotIcon name="check" /> : tab.id === state?.activeTabId ? <i className="bot-browser-current-dot" title={zh ? '当前标签页' : 'Current tab'} /> : null}
      </button>)}
      {!tabs.length && <div className="bot-browser-tab-empty" role="status">{loading ? <i className="bot-app-loading" aria-label={zh ? '正在读取标签页' : 'Loading tabs'} /> : zh ? '没有可选的网页' : 'No pages available'}</div>}
    </div>
    {error && <p className="bot-apps-error" role="alert">{error}</p>}
  </div>;
}
