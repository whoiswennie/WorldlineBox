import { useEffect, useMemo, useState } from 'react';
import type { DshInstance, DshLauncherState } from '../../shared/dsh-launcher';
import { compareDshVersions, dshVersionPattern } from '../../shared/dsh-version-order';
import { useT } from '../i18n';
import { Button, Select, TextField } from '../ui';
import { Icon } from '../Icons';
import type { LauncherRunRequest } from './DshLauncher';
import { terminalExternalLink } from './terminal-stream';
import { ReleaseNotes } from './ReleaseNotes';
import { OperationControls } from './OperationControls';
import type { LauncherDialogState } from './LauncherDialog';

const PAGE_SIZE = 12;

export function OfficialVersionPicker({ state, run, disabled = false, onManage, onUpgrade, instance }: {
  readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly disabled?: boolean; readonly onManage?: () => void;
  readonly onUpgrade?: (dialog: Extract<LauncherDialogState, { kind: 'upgrade-official' }>) => void;
  readonly instance?: DshInstance;
}) {
  const t = useT(); const catalog = state.versions;
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string>();
  const latestSync = state.operations.find(operation => operation.kind === 'versions.refresh');
  const syncing = latestSync?.status === 'running';
  const syncError = requestError || catalog?.error;
  const requestSync = async () => {
    setRequestError(undefined);
    setSubmitting(true);
    try {
      const result = await run({ type: 'versions.refresh' });
      if (!result.ok) setRequestError(result.error);
    } finally { setSubmitting(false); }
  };
  const networkRevision = state.network?.revision;
  useEffect(() => {
    let active = true;
    void run({ type: 'versions.refresh', ifStale: true }).then(result => {
      if (active) setRequestError(result.ok ? undefined : result.error);
    });
    return () => { active = false; };
  }, [run, networkRevision]);
  const [query, setQuery] = useState(''); const [channel, setChannel] = useState('all'); const [page, setPage] = useState(0);
  const matching = useMemo(() => (catalog?.entries ?? []).filter(entry => entry.version.toLowerCase().includes(query.toLowerCase().trim()) && (channel === 'all' || (channel === 'stable' ? entry.channel === 'stable' : entry.channel !== 'stable'))), [catalog?.entries, query, channel]);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE)); const visiblePage = Math.min(page, pages - 1);
  const entries = matching.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
  const currentVersion = state.runtimes.find(runtime => runtime.id === instance?.runtimeId)?.version;
  const canCompare = currentVersion && dshVersionPattern.test(currentVersion);
  const instanceBusy = state.operations.some(operation => operation.status === 'running' && operation.instanceId === instance?.id);
  const installingVersions = new Map(state.operations.flatMap(operation =>
    operation.status === 'running' && (operation.retryRequest?.type === 'runtime.install' || operation.retryRequest?.type === 'instance.upgrade-official') ? [[operation.retryRequest.version, operation] as const] : []));
  const openRelease = (value: string) => {
    const url = terminalExternalLink(value); if (!url) return;
    const shell = (window as Window & { worldlinebox?: { shell?: { openExternalUrl(url: string): Promise<unknown> } } }).worldlinebox?.shell;
    if (shell) void shell.openExternalUrl(url);
  };
  return <section className="launcher-card launcher-official-versions" data-dsh-official-versions>
    <div className="launcher-card-heading"><div><h2>{t('launcher.officialVersions')}</h2><p>{t('launcher.officialVersionsNote')}</p></div><Button disabled={disabled || submitting || syncing} iconName="refresh" onClick={() => void requestSync()} variant="quiet">{t(syncing || submitting ? 'launcher.versionSyncing' : 'launcher.refreshVersions')}</Button></div>
    {syncing ? <div className="launcher-catalog-progress" data-dsh-catalogue-sync>
      <OperationControls operation={latestSync} run={run} />
    </div> : syncError ? <div className="launcher-catalog-error" role="status">
      <Icon name="info" size={17} /><div><strong>{t('launcher.versionSyncFailed')}</strong><p>{syncError}</p>{catalog?.entries.length ? <p>{t('launcher.versionSyncCacheRetained')}</p> : null}</div>
    </div> : latestSync?.status === 'cancelled' ? <p className="launcher-help" role="status">{t('launcher.versionSyncCancelled')}</p> : null}
    <div className="launcher-catalog-toolbar"><TextField aria-label={t('launcher.findVersion')} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder={t('launcher.findVersionPlaceholder')} value={query} /><Select aria-label={t('launcher.versionChannel')} onValueChange={value => { setChannel(value); setPage(0); }} options={[{ value: 'all', label: t('launcher.allVersions') }, { value: 'stable', label: t('launcher.stableVersions') }, { value: 'preview', label: t('launcher.previewVersions') }]} value={channel} /></div>
    <div className="launcher-catalog-meta">
      <span>{t('launcher.versionSourceVerified')}</span>
      {catalog?.fetchedAt ? <time dateTime={catalog.fetchedAt}>{t('launcher.versionLastSync', { time: new Date(catalog.fetchedAt).toLocaleString() })}</time> : null}
      {catalog?.stale && !!catalog.entries.length && !syncing ? <span className="launcher-badge">{t('launcher.versionCacheStale')}</span> : null}
      <span>{t('launcher.versionMatchCount', { count: matching.length })}</span>
    </div>
    {entries.length ? <div className="launcher-version-list">{entries.map(entry => {
      const installed = state.runtimes.some(runtime => runtime.adapter === 'node-cli-web-v1' && runtime.version === entry.version);
      const installing = installingVersions.get(entry.version);
      const cleaning = state.pendingRuntimeDeletions?.includes(entry.version);
      const showUpgrade = onUpgrade && instance && canCompare && currentVersion && compareDshVersions(entry.version, currentVersion) > 0;
      return <article className={`launcher-version-row${entry.recommended ? ' is-recommended' : ''}`} data-dsh-version={entry.version} key={entry.version}>
        <div className="launcher-version-info"><div className="launcher-version-title"><strong>DSH {entry.version}</strong>{entry.recommended ? <span className="launcher-badge">{t('launcher.recommendedVersion')}</span> : null}<span className="launcher-version-channel">{t(`launcher.versionChannels.${entry.channel}`)}</span></div><div className="launcher-version-description">{entry.publishedAt ? <time dateTime={entry.publishedAt}>{new Date(entry.publishedAt).toLocaleDateString()}</time> : null}<span>{entry.nodeRange ? `Node ${entry.nodeRange}` : t('launcher.runtimePreparedAutomatically')}</span><span>{t('launcher.nativeWebRuntime')}</span></div></div>
        <div className="launcher-actions">
          <Button disabled={!entry.releaseUrl} onClick={() => openRelease(entry.releaseUrl)} size="sm" variant="quiet">{t('launcher.releasePage')}</Button>
          {installed && onManage ? <Button iconName="check" onClick={onManage} size="sm">{t('launcher.manageInstalledRuntime')}</Button> : <Button disabled={disabled || !!installing || installed || cleaning} iconName={cleaning ? 'clock' : installed ? 'check' : 'download'} onClick={() => void run({ type: 'runtime.install', version: entry.version })} size="sm" variant={entry.recommended && !installed && !cleaning && !showUpgrade ? 'primary' : 'secondary'}>{t(cleaning ? 'launcher.runtimeCleaning' : installed ? 'launcher.versionInstalled' : 'launcher.installVersion')}</Button>}
          {showUpgrade ? <Button disabled={disabled || !!installing || cleaning || instanceBusy || instance.status === 'starting' || instance.status === 'stopping'} onClick={() => onUpgrade({ kind: 'upgrade-official', instance, currentVersion, version: entry.version })} size="sm" variant="primary">{t('launcher.upgradeExisting')}</Button> : null}
        </div>
        {installing ? <div className="launcher-catalog-progress launcher-version-progress"><OperationControls operation={installing} run={run} /></div> : null}
        {entry.notes ? <ReleaseNotes notes={entry.notes} onOpenUrl={openRelease} releaseUrl={entry.releaseUrl} /> : null}
      </article>;
    })}</div> : !syncing && !syncError ? <div className="launcher-catalog-empty"><strong>{t(catalog?.entries.length ? 'launcher.noMatchingVersions' : 'launcher.noOfficialVersions')}</strong></div> : null}
    {pages > 1 ? <div className="launcher-catalog-pagination"><Button disabled={visiblePage === 0} onClick={() => setPage(value => Math.max(0, value - 1))} size="sm">{t('launcher.previousPage')}</Button><span>{visiblePage + 1} / {pages}</span><Button disabled={visiblePage + 1 >= pages} onClick={() => setPage(visiblePage + 1)} size="sm">{t('launcher.nextPage')}</Button></div> : null}
  </section>;
}
