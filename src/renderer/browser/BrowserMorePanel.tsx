import type { BrowserRequest, BrowserTab } from '../../shared/browser';
import { Icon, type IconName } from '../Icons';
import { useLocale } from '../i18n';
import { getShortcutRuntimePlatform } from '../shortcut-runtime';

export function BrowserMorePanel({ tab, run, onFind, b, openPanel }: {
  tab?: BrowserTab; run(request: BrowserRequest): unknown; onFind(): void; b(key: string): string;
  openPanel?(panel: 'bookmarks' | 'downloads' | 'history'): void;
}) {
  const { locale } = useLocale();
  const zh = locale === 'zh-CN';
  const command = getShortcutRuntimePlatform() === 'mac' ? '⌘' : 'Ctrl';
  const words = zh ? { page: '标签页与浏览', display: '页面显示', tools: '工具', pinned: '取消固定标签页', pin: '固定标签页',
    unmute: '恢复页面声音', mute: '静音此标签页', out: '缩小页面', into: '放大页面', reset: '重置为 100%', current: '当前标签页' }
    : { page: 'Tabs & browsing', display: 'Page display', tools: 'Tools', pinned: 'Unpin tab', pin: 'Pin tab', unmute: 'Unmute tab', mute: 'Mute tab',
      out: 'Zoom out', into: 'Zoom in', reset: 'Reset to 100%', current: 'Current tab' };
  const action = (value: Extract<BrowserRequest, { type: 'tab.action' }>['action']) => () => void run({ type: 'tab.action', action: value });
  const row = (icon: IconName, label: string, click: () => void, hint?: string, pressed?: boolean, disabled = false) => <button type="button"
    className="browser-more-action" onClick={click} disabled={disabled} aria-label={label} aria-pressed={pressed}>
    <Icon name={icon} size={17} /><span>{label}</span>{hint ? <kbd>{hint}</kbd> : null}{pressed ? <Icon name="check" size={14} /> : null}
  </button>;
  const zoom = tab?.zoom ?? 1;
  return <nav className="browser-more" aria-label={b('more')}>
    {openPanel ? <div className="browser-menu-shortcuts">{(['bookmarks', 'downloads', 'history'] as const).map(item => <button type="button" key={item} onClick={() => openPanel(item)}><Icon name={item === 'bookmarks' ? 'star' : item === 'downloads' ? 'download' : 'clock'} size={19} /><span>{b(item)}</span></button>)}</div> : null}
    {tab ? <div className="browser-more-current" title={tab.url}><span><Icon name="globe" size={18} /></span><div><small>{words.current}</small><strong>{tab.title}</strong></div></div> : null}
    <section aria-label={words.page}><h3>{words.page}</h3>
      {row('globe', b('home'), action('home'))}
      {row('undo', b('restore'), () => void run({ type: 'tab.restore' }), `${command}+Shift+T`)}
      {row('copy', b('duplicateTab'), () => tab && void run({ type: 'tab.command', id: tab.id, command: 'duplicate' }), undefined, undefined, !tab)}
      {row('pin', tab?.pinned ? words.pinned : words.pin, action('pin'), undefined, tab?.pinned, !tab)}
      {row(tab?.muted ? 'volume-off' : 'volume', tab?.muted ? words.unmute : words.mute, () => tab && void run({ type: 'tab.mute', id: tab.id, muted: !tab.muted }), `${command}+M`, tab?.muted, !tab)}
      {row('search', b('find'), onFind, `${command}+F`, undefined, !tab)}
    </section>
    <section aria-label={words.display}><h3>{words.display}</h3>
      <div className="browser-more-zoom"><span>{b('zoom')}</span><div>
        <button type="button" aria-label={words.out} title={words.out} disabled={!tab || zoom <= .25} onClick={() => void run({ type: 'tab.zoom', factor: Math.max(.25, Math.round((zoom - .1) * 100) / 100) })}><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 12h14" /></svg></button>
        <button type="button" className="browser-more-zoom-reset" aria-label={words.reset} title={words.reset} disabled={!tab} onClick={() => void run({ type: 'tab.zoom', factor: 1 })}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label={words.into} title={words.into} disabled={!tab || zoom >= 5} onClick={() => void run({ type: 'tab.zoom', factor: Math.min(5, Math.round((zoom + .1) * 100) / 100) })}><Icon name="plus" size={17} /></button>
      </div></div>
      {row('fullscreen', b('fullscreen'), action('fullscreen'), undefined, undefined, !tab)}
    </section>
    <section aria-label={words.tools}><h3>{words.tools}</h3>
      {row('save', b('savePage'), () => void run({ type: 'page.save' }), `${command}+S`, undefined, !tab)}
      {row('printer', b('printPage'), () => void run({ type: 'page.print' }), `${command}+P`, undefined, !tab)}
      {row('globe', b('openExternal'), () => void run({ type: 'tab.openExternal', source: 'page' }), undefined, undefined, !tab || !/^https?:\/\//.test(tab.url))}
      {row('code', b('devtools'), action('devtools'), undefined, undefined, !tab)}
    </section>
  </nav>;
}
