import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserHistory, BrowserRequest, BrowserState, WorldlineBoxBrowserApi } from '../../shared/browser';
import type { BrowserCaptureRequest, BrowserCaptureState } from '../../shared/browser-capture';
import { Icon, type IconName } from '../Icons';
import { Button, Select, TextField } from '../ui';
import { useT } from '../i18n';
import { formatBytes } from '../format-file-meta';
import { BrowserBookmarks, SiteMark } from './BrowserBookmarks';
import { BrowserCapturePanel } from './BrowserCapturePanel';
import { BrowserDownloadRecords } from './BrowserDownloadRecords';
import { BrowserMorePanel } from './BrowserMorePanel';
import { BrowserLoadFailure } from './BrowserLoadFailure';
import { BrowserTabStrip } from './BrowserTabStrip';
import { browserTabShortcut } from '../../shared/browser-shortcuts';
import { BrowserStartPage } from './BrowserStartPage';
import { BrowserAiPanel } from './BrowserAiPanel';
import { BrowserAiSettings } from './BrowserAiSettings';
import type { BrowserAiRequest } from '../../shared/browser-ai';
import './browser.css';
import './browser-ai.css';
import brandLogo from '../../../assets/icons/startup-logo.png';

type Panel = 'bookmarks' | 'history' | 'downloads' | 'settings' | 'more' | 'capture' | 'ai';
export function BrowserPage({ api, active, onOpenNetwork, onOpenAssets, onScreenshot, onSelection }: { api?: WorldlineBoxBrowserApi; active: boolean; onOpenNetwork(): void; onOpenAssets?(): void; onScreenshot?(): void; onSelection?(): void }) {
  const t = useT(); const b = (key: string) => t('browser.' + key);
  const [snapshot, setSnapshot] = useState<{ browser?: BrowserState; capture?: BrowserCaptureState }>({});
  const state = snapshot.browser; const capture = snapshot.capture;
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [panel, setPanel] = useState<Panel>(); const [location, setLocation] = useState('');
  const locationField = useRef<HTMLInputElement>(null); const locationEditing = useRef(false); const viewport = useRef<HTMLDivElement>(null);
  const lastAddressTab = useRef<string | undefined>(undefined);
  const [findOpen, setFindOpen] = useState(false); const [findText, setFindText] = useState(''); const findField = useRef<HTMLInputElement>(null);
  const [historyQuery, setHistoryQuery] = useState(''); const [history, setHistory] = useState<BrowserHistory[]>([]); const [historyOffset, setHistoryOffset] = useState(0); const [historyTotal, setHistoryTotal] = useState(0);
  const [preferences, setPreferences] = useState<BrowserState['preferences']>();
  const [clear, setClear] = useState({ cache: true, siteData: false, history: false, downloads: false }); const [clearScope, setClearScope] = useState('all'); const [busy, setBusy] = useState(false);
  const [rememberPermission, setRememberPermission] = useState(false);
  const [aiWidth, setAiWidth] = useState(() => { try { return Math.min(800, Math.max(320, Number(localStorage.getItem('worldlinebox.browser.ai-width')) || 420)); } catch { return 420; } });
  const accept = useCallback((next: BrowserState) => setSnapshot(previous => previous.browser && next.revision < previous.browser.revision
    ? previous
    : { browser: next, capture: next.capture ?? previous.capture }), []);
  const setCapture = useCallback((next: BrowserCaptureState) => setSnapshot(previous => ({ ...previous, capture: next })), []);
  const run = useCallback(async (request: BrowserRequest) => {
    if (!api) return undefined;
    try { const response = await api.request(request); if (!response.ok) setError(response.error); else { if (response.state) accept(response.state); if (request.type !== 'layout') setError(''); } return response; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return undefined; }
  }, [api, accept]);
  const runCapture = useCallback(async (request: BrowserCaptureRequest) => {
    if (!api) return undefined;
    try {
      const response = await api.capture(request);
      if (response.state) setCapture(response.state);
      setError(response.ok ? '' : response.error);
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    }
  }, [api, setCapture]);
  const tab = state?.tabs.find(item => item.id === state.activeTabId);
  const bookmarked = state?.bookmarks.find(item => item.url === tab?.url);
  useEffect(() => {
    const changedTab = lastAddressTab.current !== tab?.id; lastAddressTab.current = tab?.id;
    if (changedTab || !locationEditing.current) setLocation(tab?.url === 'about:blank' ? '' : tab?.url ?? '');
    if (changedTab && active && tab?.url === 'about:blank') locationField.current?.focus();
  }, [tab?.id, tab?.url, active]);
  useEffect(() => {
    if (!api) return;
    const stop = api.onChanged(accept);
    const focus = api.onFocus(target => { if (target === 'address') { locationField.current?.focus(); locationField.current?.select(); } else { setFindOpen(true); requestAnimationFrame(() => findField.current?.focus()); } });
    void api.request({ type: 'activate' }).then(response => { if (response.ok && response.state) accept(response.state); else if (!response.ok) setError(response.error); }).catch(cause => setError(String(cause)));
    void api.capture({ type: 'state' }).then(response => { if (response.state) setCapture(response.state); if (!response.ok) setError(response.error); }).catch(cause => setError(String(cause)));
    return () => { stop(); focus(); void api.request({ type: 'layout', visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }).catch(() => undefined); };
  }, [api, accept, setCapture]);
  const ready = state !== undefined;
  useEffect(() => {
    if (!active || !api) return;
    let cancelled = false;
    void api.request({ type: 'state' }).then(response => { if (!cancelled && response.ok && response.state) accept(response.state); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, api, accept]);
  useEffect(() => {
    if (!api || !viewport.current) return;
    let previous = ''; let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        const box = viewport.current?.getBoundingClientRect(); if (!box) return;
        const overlay = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"]')].some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
        const visible = active && !overlay;
        const bounds = { x: Math.max(0, Math.round(box.x)), y: Math.max(0, Math.round(box.y)), width: Math.max(0, Math.round(box.width)), height: Math.max(0, Math.round(box.height)) };
        const key = JSON.stringify({ visible, bounds }); if (key === previous) return; previous = key;
        void api.request({ type: 'layout', visible, bounds }).catch(() => undefined);
      });
    };
    const observer = new ResizeObserver(update); observer.observe(viewport.current);
    const menus = new MutationObserver(update); menus.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'role'] });
    window.addEventListener('resize', update); update();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); menus.disconnect(); window.removeEventListener('resize', update); void api.request({ type: 'layout', visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }).catch(() => undefined); };
  }, [api, active, ready]);
  useEffect(() => {
    if (panel !== 'history') return;
    let cancelled = false;
    const timer = setTimeout(() => { void run({ type: 'history', query: historyQuery, offset: historyOffset, limit: 50 }).then(result => {
      if (!cancelled && result?.ok) {
        const total = result.total ?? 0;
        const lastOffset = Math.max(0, Math.ceil(total / 50) - 1) * 50;
        setHistoryTotal(total);
        if (historyOffset > lastOffset) { setHistoryOffset(lastOffset); setHistory([]); }
        else setHistory(result.history ?? []);
      }
    }); }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [panel, historyQuery, historyOffset, state?.historyCount, run]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!active || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
      const request = browserTabShortcut(event.key, true, event.shiftKey, event.altKey, state?.tabs ?? [], state?.activeTabId);
      if (request) { event.preventDefault(); void run(request); return; }
      if (event.key.toLowerCase() === 'l') { event.preventDefault(); locationField.current?.focus(); locationField.current?.select(); }
      if (event.key.toLowerCase() === 't') { event.preventDefault(); void run({ type: event.shiftKey ? 'tab.restore' : 'tab.new' }); }
      if (event.key.toLowerCase() === 'w' && tab) { event.preventDefault(); void run({ type: 'tab.close', id: tab.id }); }
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); setFindOpen(true); requestAnimationFrame(() => findField.current?.focus()); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [active, run, tab, state?.tabs, state?.activeTabId]);
  const togglePanel = (next: Panel) => {
    setPanel(current => current === next ? undefined : next); setNotice('');
    if (next === 'ai') void run({ type: 'state' });
    if (next === 'settings' && state) { setPreferences({ ...state.preferences }); void run({ type: 'data.info' }); }
    if (next === 'capture') void runCapture({ type: 'state' });
  };
  const action = (value: Extract<BrowserRequest, { type: 'tab.action' }>['action']) => void run({ type: 'tab.action', action: value });
  const iconButton = (name: IconName, label: string, click: () => void, disabled = false, selected = false) => <Button aria-label={label} title={label} aria-pressed={selected || undefined} iconName={name} variant="quiet" size="sm" onClick={click} disabled={disabled} />;
  const clearData = async () => {
    setBusy(true); setNotice('');
    try { const result = await run({ type: 'data.clear', ...clear, ...(clearScope === 'site' && tab ? { origin: tab.url } : {}) }); if (result?.ok) setNotice(b('cleared')); }
    finally { setBusy(false); }
  };
  const navigate = (url: string) => { locationEditing.current = false; setLocation(url); void run({ type: 'tab.navigate', text: url }); };
  const startAi = (mode: Extract<BrowserAiRequest, { type: 'ai.start' }>['mode'], query: string) => {
    if (!state?.activeTabId) return;
    if (mode === 'research' || mode === 'page' || mode === 'followup') setPanel('ai');
    void run({ type: 'ai.start', tabId: state.activeTabId, mode, query });
  };
  const captureLibrary = capture?.libraries.find(item => item.libraryId === (capture.target?.libraryId ?? capture.activeLibraryId));
  const captureReady = Boolean(capture?.connected && captureLibrary && !captureLibrary.readOnly);
  const panelIcon: Record<Panel, IconName> = { bookmarks: 'star', history: 'clock', downloads: 'download', settings: 'settings', more: 'sliders', capture: 'save', ai: 'sparkles' };
  return <section className="web-browser" data-web-browser aria-label={b('title')}>
    <BrowserTabStrip tabs={state?.tabs ?? []} activeId={state?.activeTabId} run={run} b={b} />
    <div className="browser-toolbar">{iconButton('chevron-left', b('back'), () => action('back'), !tab?.canGoBack)}{iconButton('chevron-right', b('forward'), () => action('forward'), !tab?.canGoForward)}{iconButton(tab?.loading ? 'stop' : 'refresh', b(tab?.loading ? 'stop' : 'reload'), () => action(tab?.loading ? 'stop' : 'reload'), !tab)}{iconButton('globe', b('home'), () => action('home'))}
      <form className="browser-address" onSubmit={event => { event.preventDefault(); if (tab && location.trim()) navigate(location); }}><span title={tab?.url.startsWith('https:') ? 'HTTPS' : 'HTTP'}><Icon name="globe" size={15} /></span><input ref={locationField} aria-label={b('address')} autoComplete="off" spellCheck={false} disabled={!tab} value={location} onFocus={() => { locationEditing.current = true; }} onBlur={() => { locationEditing.current = false; }} onChange={event => setLocation(event.target.value)} placeholder={b('address')} /></form>
      <Button aria-label={b('capture')} aria-expanded={panel === 'capture'} aria-controls="browser-capture-panel" className={'browser-capture-trigger' + (captureReady ? ' is-ready' : '')} disabled={!api} iconName="save" onClick={() => togglePanel('capture')} size="sm" title={b('capture') + ' · ' + (captureLibrary?.displayName ?? b('captureNoLibrary'))} variant="quiet"><span className="browser-capture-trigger-label">{b('capture')}</span><span aria-hidden="true" className="browser-capture-dot" /></Button>
      {iconButton('sparkles', b('ai'), () => togglePanel('ai'), false, panel === 'ai')}{onScreenshot ? iconButton('camera', t('appNavigation.screenshot'), onScreenshot) : null}{onSelection ? iconButton('message-circle', t('appNavigation.selection'), onSelection) : null}{iconButton('star', b('favorite'), () => togglePanel('bookmarks'), !tab, !!bookmarked)}{iconButton('download', b('downloads'), () => togglePanel('downloads'), false, panel === 'downloads')}{iconButton('clock', b('history'), () => togglePanel('history'), false, panel === 'history')}{iconButton('settings', b('settings'), () => togglePanel('settings'), false, panel === 'settings')}{iconButton('menu', b('more'), () => togglePanel('more'))}
    </div>
    {state?.bookmarks.length ? <nav className="browser-bookmark-bar" aria-label={b('bookmarkBar')}>{state.bookmarks.slice(0, 10).map(item => <button key={item.id} title={item.title + '\n' + item.url} onClick={() => navigate(item.url)}><SiteMark url={item.url} /><span>{item.title}</span></button>)}<Button aria-label={b('bookmarks')} title={b('bookmarks')} iconName="chevron-right" variant="quiet" size="sm" onClick={() => togglePanel('bookmarks')} /></nav> : null}
    {findOpen ? <div className="browser-find"><input ref={findField} aria-label={b('find')} value={findText} onChange={event => { setFindText(event.target.value); void run({ type: 'find', text: event.target.value }); }} onKeyDown={event => { if (event.key === 'Enter') void run({ type: 'find', text: findText, next: true, forward: !event.shiftKey }); if (event.key === 'Escape') { setFindOpen(false); void run({ type: 'find', text: '' }); } }} /><span>{state?.find ? state.find.activeMatchOrdinal + ' / ' + state.find.matches : ''}</span>{iconButton('chevron-left', b('previous'), () => void run({ type: 'find', text: findText, next: true, forward: false }))}{iconButton('chevron-right', b('next'), () => void run({ type: 'find', text: findText, next: true, forward: true }))}{iconButton('close', b('close'), () => { setFindOpen(false); void run({ type: 'find', text: '' }); })}</div> : null}
    {state?.permissions.map(permission => <div className="browser-permission" key={permission.id}><div><strong>{b('permissionRequest')}</strong><p>{permission.origin} · {t('browser.permission.' + permission.permission, {}) === 'browser.permission.' + permission.permission ? permission.permission : b('permission.' + permission.permission)}</p></div><label><input type="checkbox" checked={rememberPermission} onChange={event => setRememberPermission(event.target.checked)} />{b('remember')}</label><Button onClick={() => void run({ type: 'permission', id: permission.id, allow: false, remember: rememberPermission })}>{b('deny')}</Button><Button variant="primary" onClick={() => void run({ type: 'permission', id: permission.id, allow: true, remember: rememberPermission })}>{b('allow')}</Button></div>)}
    {state?.signIn ? <div className="browser-sign-in" role="note"><Icon name="globe" size={18} /><div><strong>{b('signInTitle')}</strong><p>{b('signInHint')}</p></div><Button size="sm" onClick={() => void run({ type: 'tab.openExternal', source: 'signInSite' })}>{b(state.signIn.siteUrl ? 'openSignInSite' : 'openExternal')}</Button></div> : null}
    {error || state?.error ? <div className="browser-error" role="alert">{error || state?.error}{iconButton('close', b('close'), () => setError(''))}</div> : null}
    <div className="browser-loading-track">{tab?.loading ? <div className="browser-load-indicator" role="progressbar" aria-label={b('loading')} /> : null}</div>
    <div className="browser-body"><div className="browser-viewport" ref={viewport} data-browser-viewport>{!state ? <p>{api ? b('loading') : b('unavailable')}</p> : tab?.error ? <BrowserLoadFailure error={tab.error} onReload={() => action('reload')} onOpenNetwork={onOpenNetwork} /> : tab?.url === 'about:blank' && !tab.nativeBlank ? <BrowserStartPage state={state} navigate={navigate} start={startAi} settings={() => togglePanel('settings')} /> : null}</div>
      {panel === 'ai' ? <div className="browser-ai-resizer" role="separator" aria-label={b('aiResize')} aria-orientation="vertical" aria-valuemin={300} aria-valuemax={900} aria-valuenow={Math.round(aiWidth)} tabIndex={0}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setAiWidth(value => Math.min(900, Math.max(300, value + (event.key === 'ArrowLeft' ? 24 : -24)))); } }}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.startX = String(event.clientX); event.currentTarget.dataset.startWidth = String(aiWidth); }}
        onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const width = Math.max(300, Math.min(900, (event.currentTarget.parentElement?.clientWidth ?? 1200) - 320, Number(event.currentTarget.dataset.startWidth) + Number(event.currentTarget.dataset.startX) - event.clientX)); setAiWidth(width); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); try { localStorage.setItem('worldlinebox.browser.ai-width', String(aiWidth)); } catch { /* Optional layout preference. */ } }} /> : null}
      {panel ? <aside className={'browser-panel browser-panel-' + panel + (panel === 'capture' ? ' browser-capture-panel' : '')} style={panel === 'ai' ? { width: aiWidth } : undefined} id={panel === 'capture' ? 'browser-capture-panel' : panel === 'ai' ? 'browser-ai-panel' : undefined} aria-label={b(panel === 'capture' ? 'captureTitle' : panel)}><header><div className="browser-panel-heading"><span>{panel === 'ai' ? <img className="browser-brand-mark" src={brandLogo} alt="" /> : <Icon name={panelIcon[panel]} size={18} />}</span><h2>{b(panel === 'capture' ? 'captureTitle' : panel)}</h2></div>{iconButton('close', b('close'), () => setPanel(undefined))}</header>
        {panel === 'ai' && state ? <BrowserAiPanel state={state} run={run} settings={() => togglePanel('settings')} /> : null}
        {panel === 'settings' ? <BrowserAiSettings config={state?.ai?.config} run={run} /> : null}
        {panel === 'capture' ? <BrowserCapturePanel capture={capture} run={runCapture} onOpenAssets={onOpenAssets} onScreenshot={onScreenshot} documentKey={tab ? JSON.stringify([tab.id, tab.url, tab.loading]) : ''} /> : null}
        {panel === 'bookmarks' && state ? <BrowserBookmarks bookmarks={state.bookmarks} tab={tab} navigate={navigate} run={run} /> : null}
        {panel === 'history' ? <><TextField label={b('searchHistory')} maxLength={200} value={historyQuery} onChange={event => { setHistoryQuery(event.target.value); setHistoryOffset(0); setHistory([]); }} />{history.length ? <ul className="browser-records">{history.map(item => <li key={item.id}><button className="browser-record-link" onClick={() => navigate(item.url)} title={item.url}><strong>{item.title}</strong><span>{new Date(item.visitedAt).toLocaleString()}</span><span>{item.url}</span></button></li>)}</ul> : <p className="browser-help">{b('emptyHistory')}</p>}<div className="browser-actions"><Button disabled={!historyOffset} onClick={() => setHistoryOffset(value => Math.max(0, value - 50))}>{b('previousPage')}</Button><span>{historyTotal} · {Math.floor(historyOffset / 50) + 1} / {Math.max(1, Math.ceil(historyTotal / 50))}</span><Button disabled={historyOffset + 50 >= historyTotal} onClick={() => setHistoryOffset(value => value + 50)}>{b('nextPage')}</Button></div></> : null}
        {panel === 'downloads' ? <BrowserDownloadRecords downloads={state?.downloads ?? []} run={run} b={b} /> : null}
        {panel === 'more' ? <BrowserMorePanel tab={tab} run={run} b={b} onFind={() => { setFindOpen(true); setPanel(undefined); requestAnimationFrame(() => findField.current?.focus()); }} /> : null}
        {panel === 'settings' && preferences ? <div className="browser-form"><TextField label={b('homepage')} value={preferences.homepage} onChange={event => setPreferences({ ...preferences, homepage: event.target.value })} /><Select label={b('searchEngine')} value={preferences.searchEngine} onValueChange={value => setPreferences({ ...preferences, searchEngine: value as typeof preferences.searchEngine })} options={[{ value: 'bing', label: 'Bing' }, { value: 'baidu', label: '百度' }, { value: 'duckduckgo', label: 'DuckDuckGo' }]} /><label><input type="checkbox" checked={preferences.restoreSession} onChange={event => setPreferences({ ...preferences, restoreSession: event.target.checked })} />{b('restoreSession')}</label><label><input type="checkbox" checked={preferences.askDownloadLocation} onChange={event => setPreferences({ ...preferences, askDownloadLocation: event.target.checked })} />{b('askDownloadLocation')}</label><Button onClick={() => { void run({ type: 'preferences.save', preferences }).then(result => { if (result?.ok) setNotice(b('preferencesSaved')); }); }}>{b('save')}</Button><hr /><h3>{b('clearData')}</h3><p className="browser-help">{b('clearNote')}</p><p className="browser-help">{b('cacheSize')} · {state?.cacheBytes === undefined ? '…' : formatBytes(state.cacheBytes)}</p><Select label={b('clearScope')} value={clearScope} onValueChange={setClearScope} options={[{ value: 'all', label: b('allSites') }, { value: 'site', label: b('currentSite'), disabled: !tab?.url.startsWith('http') }]} />{(['cache', 'siteData', 'history', 'downloads'] as const).map(key => <label key={key}><input type="checkbox" checked={clear[key]} onChange={event => setClear({ ...clear, [key]: event.target.checked })} />{b(key === 'history' ? 'clearHistory' : key === 'downloads' ? 'clearDownloads' : key)}</label>)}<Button disabled={busy || !Object.values(clear).some(Boolean)} loading={busy} onClick={() => void clearData()}>{b('clearSelected')}</Button>{notice ? <p role="status">{notice}</p> : null}<Button iconName="globe" onClick={onOpenNetwork}>{b('network')}</Button></div> : null}
      </aside> : null}
    </div>
  </section>;
}
