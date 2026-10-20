import type { BrowserRequest, BrowserTab } from '../../shared/browser';
import { Icon } from '../Icons';
import { useLocale } from '../i18n';

export function BrowserTabStrip({ tabs, activeId, run, b }: {
  tabs: readonly BrowserTab[]; activeId?: string; run(request: BrowserRequest): unknown; b(key: string): string;
}) {
  const { locale } = useLocale();
  return <div className="browser-tabs" role="tablist" aria-label={b('title')}>
    {tabs.map((tab, index) => <div className={'browser-tab' + (tab.id === activeId ? ' is-active' : '')} key={tab.id} data-tab-id={tab.id}
      onContextMenu={event => { event.preventDefault(); void run({ type: 'tab.contextMenu', id: tab.id, locale }); }}
      onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void run({ type: 'tab.close', id: tab.id }); } }}
      onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}>
      <button type="button" className="browser-tab-select" role="tab" aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1}
        title={tab.title + '\n' + tab.url} onClick={() => void run({ type: 'tab.select', id: tab.id })}
        onKeyDown={event => {
          if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length;
          const strip = event.currentTarget.closest('.browser-tabs');
          void run({ type: 'tab.select', id: tabs[target]!.id });
          strip?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
        }}>
        <Icon name={tab.loading ? 'loader' : tab.pinned ? 'pin' : 'globe'} size={14} /><span>{tab.title}</span>
      </button>
      {tab.audible || tab.muted ? <button type="button" className={'browser-tab-audio' + (tab.muted ? ' is-muted' : '')}
        aria-label={b(tab.muted ? 'unmuteTab' : 'muteTab') + ' · ' + tab.title} aria-pressed={tab.muted}
        title={b(tab.muted ? 'unmuteTab' : 'muteTab')} onClick={() => void run({ type: 'tab.mute', id: tab.id, muted: !tab.muted })}>
        <span role="img" aria-label={b(tab.muted ? 'tabMuted' : 'tabAudible')}><Icon name={tab.muted ? 'volume-off' : 'volume'} size={14} /></span>
      </button> : null}
      <button type="button" className="browser-tab-close" title={b('closeTab')} aria-label={b('closeTab') + ' ' + tab.title}
        onClick={() => void run({ type: 'tab.close', id: tab.id })}><Icon name="close" size={14} /></button>
    </div>)}
    <button type="button" className="browser-tab-new" title={b('newTab')} aria-label={b('newTab')} onClick={() => void run({ type: 'tab.new' })}><Icon name="plus" size={18} /></button>
  </div>;
}
