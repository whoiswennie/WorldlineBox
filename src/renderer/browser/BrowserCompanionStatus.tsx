import type { BrowserRequest, BrowserState } from '../../shared/browser';
import { Icon } from '../Icons';

export function BrowserCompanionStatus({ state, run, b }: { state: BrowserState; run(request: BrowserRequest): unknown; b(key: string): string }) {
  const status = state.companions;
  if (!status) return null;
  const active = state.activeTabId;
  const pausedTab = !!active && status.pausedTabIds.includes(active);
  const tabs = [...new Set(status.activities.map(item => item.tabId))];
  if (!status.paused && !pausedTab && !tabs.length) return null;
  return <div className="browser-companion-status" aria-label={b('companionStatus')}>
    <span className="browser-companion-status-label"><Icon name="sparkles" size={14} />{b(status.paused ? 'companionsPaused' : 'companionStatus')}</span>
    {tabs.map(id => {
      const tab = state.tabs.find(tab => tab.id === id);
      const names = [...new Map(status.activities.filter(item => item.tabId === id).map(item => [item.companionId, item.companionName] as const)).values()].join('、');
      return <span className="browser-companion-page" key={id}>
        <button type="button" className="browser-companion-location" title={names + ' · ' + (tab?.url ?? '')} onClick={() => void run({ type: 'tab.select', id })}>{names} · {tab?.title}</button>
        <button type="button" aria-label={b('pauseCompanionTab') + ' · ' + tab?.title} onClick={() => void run({ type: 'companion.pause', paused: true, tabId: id })}>{b('pauseCompanionTab')}</button>
      </span>;
    })}
    {pausedTab ? <button type="button" onClick={() => void run({ type: 'companion.pause', paused: false, tabId: active })}>{b('resumeCompanionTab')}</button> : null}
    <button type="button" className="browser-companion-toggle" onClick={() => void run({ type: 'companion.pause', paused: !status.paused })}>{b(status.paused ? 'resumeCompanions' : 'pauseCompanions')}</button>
  </div>;
}
