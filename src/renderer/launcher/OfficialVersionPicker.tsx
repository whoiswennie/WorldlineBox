import { useMemo, useState } from 'react';
import type { DshLauncherState } from '../../shared/dsh-launcher';
import { useT } from '../i18n';
import { Button, Select, TextField } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';
import { terminalExternalLink } from './terminal-stream';
import { ReleaseNotes } from './ReleaseNotes';

const PAGE_SIZE = 12;

export function OfficialVersionPicker({ state, run, disabled = false, onManage }: {
  readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly disabled?: boolean; readonly onManage?: () => void;
}) {
  const t = useT(); const catalog = state.versions;
  const [query, setQuery] = useState(''); const [channel, setChannel] = useState('all'); const [page, setPage] = useState(0);
  const matching = useMemo(() => (catalog?.entries ?? []).filter(entry => entry.version.toLowerCase().includes(query.toLowerCase().trim()) && (channel === 'all' || (channel === 'stable' ? entry.channel === 'stable' : entry.channel !== 'stable'))), [catalog?.entries, query, channel]);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE)); const visiblePage = Math.min(page, pages - 1);
  const entries = matching.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
  const installingVersions = new Set(state.operations.filter(operation => operation.status === 'running' && operation.retryRequest?.type === 'runtime.install').map(operation => operation.retryRequest?.type === 'runtime.install' ? operation.retryRequest.version : ''));
  const openRelease = (value: string) => {
    const url = terminalExternalLink(value); if (!url) return;
    const shell = (window as Window & { worldlinebox?: { shell?: { openExternalUrl(url: string): Promise<unknown> } } }).worldlinebox?.shell;
    if (shell) void shell.openExternalUrl(url);
  };
  return <section className="launcher-card launcher-official-versions" data-dsh-official-versions>
    <div className="launcher-card-heading"><div><h2>{t('launcher.officialVersions')}</h2><p>{t('launcher.officialVersionsNote')}</p></div><Button disabled={disabled} iconName="refresh" onClick={() => void run({ type: 'versions.refresh' })} variant="quiet">{t('launcher.refreshVersions')}</Button></div>
    <div className="launcher-catalog-toolbar"><TextField aria-label={t('launcher.findVersion')} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder={t('launcher.findVersionPlaceholder')} value={query} /><Select aria-label={t('launcher.versionChannel')} onValueChange={value => { setChannel(value); setPage(0); }} options={[{ value: 'all', label: t('launcher.allVersions') }, { value: 'stable', label: t('launcher.stableVersions') }, { value: 'preview', label: t('launcher.previewVersions') }]} value={channel} /></div>
    <div className="launcher-catalog-meta"><span>{t(catalog?.source === 'github-npm' ? 'launcher.versionSourceVerified' : catalog?.source === 'npm' ? 'launcher.versionSourceNpm' : 'launcher.versionSourceCache')}</span>{catalog?.stale ? <span className="launcher-badge">{t('launcher.versionCacheStale')}</span> : null}<span>{t('launcher.versionMatchCount', { count: matching.length })}</span></div>
    {entries.length ? <div className="launcher-version-list">{entries.map(entry => {
      const installed = state.runtimes.some(runtime => runtime.adapter === 'node-cli-web-v1' && runtime.version === entry.version);
      const installing = installingVersions.has(entry.version);
      return <article className={`launcher-version-row${entry.recommended ? ' is-recommended' : ''}`} data-dsh-version={entry.version} key={entry.version}>
        <div className="launcher-version-info"><div className="launcher-version-title"><strong>DSH {entry.version}</strong>{entry.recommended ? <span className="launcher-badge">{t('launcher.recommendedVersion')}</span> : null}<span className="launcher-version-channel">{t(`launcher.versionChannels.${entry.channel}`)}</span></div><div className="launcher-version-description">{entry.publishedAt ? <time dateTime={entry.publishedAt}>{new Date(entry.publishedAt).toLocaleDateString()}</time> : null}<span>{entry.nodeRange ? `Node ${entry.nodeRange}` : t('launcher.runtimePreparedAutomatically')}</span><span>{t('launcher.nativeWebRuntime')}</span></div></div>
        <div className="launcher-actions"><Button disabled={!entry.releaseUrl} onClick={() => openRelease(entry.releaseUrl)} size="sm" variant="quiet">{t('launcher.releasePage')}</Button>{installed && onManage ? <Button iconName="check" onClick={onManage} size="sm">{t('launcher.manageInstalledRuntime')}</Button> : <Button disabled={disabled || installing || installed} iconName={installed ? 'check' : 'download'} onClick={() => void run({ type: 'runtime.install', version: entry.version })} size="sm" variant={entry.recommended && !installed ? 'primary' : 'secondary'}>{t(installed ? 'launcher.versionInstalled' : 'launcher.installVersion')}</Button>}</div>
        {entry.notes ? <ReleaseNotes notes={entry.notes} onOpenUrl={openRelease} releaseUrl={entry.releaseUrl} /> : null}
      </article>;
    })}</div> : <div className="launcher-catalog-empty"><strong>{t(catalog?.entries.length ? 'launcher.noMatchingVersions' : 'launcher.noOfficialVersions')}</strong><p>{catalog?.error ? t('launcher.versionFeedUnavailable') : t('launcher.versionFeedRefreshNote')}</p>{!catalog?.entries.length ? <Button disabled={disabled} iconName="refresh" onClick={() => void run({ type: 'versions.refresh' })}>{t('launcher.refreshVersions')}</Button> : null}</div>}
    {pages > 1 ? <div className="launcher-catalog-pagination"><Button disabled={visiblePage === 0} onClick={() => setPage(value => Math.max(0, value - 1))} size="sm">{t('launcher.previousPage')}</Button><span>{visiblePage + 1} / {pages}</span><Button disabled={visiblePage + 1 >= pages} onClick={() => setPage(visiblePage + 1)} size="sm">{t('launcher.nextPage')}</Button></div> : null}
    {catalog?.error && entries.length ? <p className="launcher-help">{t('launcher.versionFeedUnavailable')}</p> : null}
  </section>;
}
