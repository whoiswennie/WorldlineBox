import { useEffect, useRef, useState } from 'react';
import type { DshNetworkSettings, DshNetworkSourceKind, DshNetworkPatch } from '../../shared/dsh-launcher';
import { LOCAL_HTTP_PROXY_PORTS, NETWORK_SOURCE_PRESETS } from '../../shared/network-presets';
import { useT } from '../i18n';
import { Button, Select, TextField } from '../ui';
import type { ApplicationNetworkState, ApplicationNetworkRequest, ApplicationNetworkResponse } from '../../shared/application-network';
import { RecentNetworkFailures } from './RecentNetworkFailures';

export type NetworkRunRequest = (request: ApplicationNetworkRequest) => Promise<ApplicationNetworkResponse>;

const sourceNames = { npm: 'npm', python: 'Python', github: 'GitHub' };
const officialNpm = 'https://registry.npmjs.org';
const sourcePresets = NETWORK_SOURCE_PRESETS;
function address(value: string): string {
  try { return new URL(value.trim()).href.replace(/\/$/, ''); } catch { return value.trim().replace(/\/$/, ''); }
}
function sourceActive(settings: DshNetworkSettings, kind: DshNetworkSourceKind, url: string): boolean {
  return address(kind === 'npm' ? settings.npmRegistry : kind === 'python' ? settings.pythonIndex : settings.githubMirror === 'custom' ? settings.githubMirrorUrl : '') === address(url);
}
function proxyChoice(settings: DshNetworkSettings): string { return settings.proxyMode === 'custom' ? settings.proxyRouting ?? 'global' : settings.proxyMode; }
function proxyChoicePatch(value: string): DshNetworkPatch {
  return value === 'smart' || value === 'global' ? { proxyMode: 'custom', proxyRouting: value } : { proxyMode: value as 'system' | 'direct' };
}

export function NetworkSettings({ network, run, disabled = false }: {
  readonly network?: ApplicationNetworkState; readonly run: NetworkRunRequest; readonly disabled?: boolean;
}) {
  const t = useT(); const stored = network?.settings;
  const [changes, setChanges] = useState<Partial<DshNetworkSettings>>({});
  const [profileName, setProfileName] = useState(''); const [profileUrl, setProfileUrl] = useState('');
  const [editingProxy, setEditingProxy] = useState<string>();
  const [sourceName, setSourceName] = useState(''); const [sourceUrl, setSourceUrl] = useState('');
  const [sourceKind, setSourceKind] = useState<DshNetworkSourceKind>('npm'); const [editingSource, setEditingSource] = useState<string>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(''); const [testing, setTesting] = useState(false);
  const [testingPixiv, setTestingPixiv] = useState(false);
  const inspected = useRef<number | undefined>(undefined);
  const saving = useRef(false);
  useEffect(() => {
    if (!network || inspected.current === network.revision) return;
    inspected.current = network.revision; void run({ type: 'network.inspect' });
  }, [network, run]);
  if (!stored || !network) return <div className="launcher-page"><h1>{t('appNavigation.network')}</h1><p>{t('launcher.loading')}</p></div>;
  const draft: DshNetworkSettings = { ...stored, ...changes };
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const locked = disabled || busy || testing || testingPixiv;
  const profiles = draft.sourceProfiles ?? [];
  const inspection = network.inspection?.revision === network.revision ? network.inspection : undefined;
  const checks = network.checks?.revision === network.revision ? network.checks : undefined;
  const automaticNpm = stored.npmDownloadRoute === 'auto' && stored.npmRegistry === officialNpm;
  const activeProxy = stored.proxyMode === 'custom' ? stored.proxyProfiles.find(item => address(item.url) === address(stored.proxyUrl)) : undefined;
  const update = (patch: Partial<DshNetworkSettings>) => { setChanges(previous => ({ ...previous, ...patch })); setError(''); };
  const save = async (next = draft): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true); setError('');
    try {
      const response = await run({ type: 'network.save', settings: next });
      if (!response.ok) { setError(response.error); return false; }
      setChanges({}); setTestResult(''); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { saving.current = false; setBusy(false); }
  };
  // Live controls send only the selected applied policy. Other form edits remain drafts.
  const applyLive = async (request: Extract<ApplicationNetworkRequest, { type: 'network.patch' | 'network.proxy.toggle' }>): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setError('');
    try {
      const response = await run(request);
      if (!response.ok) { setError(response.error); return false; }
      if (request.type === 'network.patch') setChanges(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !(key in request.patch))));
      setTestResult(''); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { saving.current = false; setBusy(false); }
  };
  const test = async () => {
    setTesting(true); setError('');
    try {
      if (dirty && !await save()) return;
      const result = await run({ type: 'network.test' });
      if (result.ok) setTestResult(result.text ?? t('launcher.networkTestCompleted'));
      else setError(result.error);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTesting(false); }
  };
  const testPixiv = async () => {
    setTestingPixiv(true); setError('');
    try {
      if (dirty && !await save()) return;
      const response = await run({ type: 'network.pixiv.test' });
      if (!response.ok) setError(response.error);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTestingPixiv(false); }
  };
  const addProxy = async () => {
    if (!profileName.trim() || !profileUrl.trim()) return;
    if (draft.proxyProfiles.some(item => item.id !== editingProxy && address(item.url) === address(profileUrl))) { setError(t('launcher.profileDuplicate')); return; }
    const profile = { id: editingProxy ?? 'proxy-' + crypto.randomUUID(), name: profileName.trim(), url: profileUrl.trim() };
    const next = editingProxy ? draft.proxyProfiles.map(item => item.id === editingProxy ? profile : item) : [...draft.proxyProfiles, profile];
    if (await save({ ...draft, proxyMode: 'custom', proxyUrl: profile.url, proxyProfiles: next })) { setProfileName(''); setProfileUrl(''); setEditingProxy(undefined); }
  };
  const applySource = (kind: DshNetworkSourceKind, url: string): DshNetworkPatch => kind === 'npm' ? { npmRegistry: url, npmDownloadRoute: 'registry' } : kind === 'python' ? { pythonIndex: url } : { githubMirror: 'custom', githubMirrorUrl: url };
  const addSource = async () => {
    if (!sourceName.trim() || !sourceUrl.trim()) return;
    if (profiles.some(item => item.id !== editingSource && item.kind === sourceKind && address(item.url) === address(sourceUrl))) { setError(t('launcher.profileDuplicate')); return; }
    const profile = { id: editingSource ?? 'source-' + crypto.randomUUID(), name: sourceName.trim(), kind: sourceKind, url: sourceUrl.trim() };
    const next = editingSource ? profiles.map(item => item.id === editingSource ? profile : item) : [...profiles, profile];
    if (await save({ ...draft, ...applySource(sourceKind, profile.url), sourceProfiles: next })) { setSourceName(''); setSourceUrl(''); setEditingSource(undefined); }
  };
  const sourcePreset = (kind: 'npm' | 'python') => {
    const url = kind === 'npm' ? draft.npmRegistry : draft.pythonIndex;
    const options = [...sourcePresets[kind], ...profiles.filter(item => item.kind === kind)];
    return <Select label={t('launcher.' + kind + 'SourcePreset')} value={options.some(item => address(item.url) === address(url)) ? address(url) : 'custom'}
      options={[...Array.from(new Map(options.map(item => [address(item.url), { value: address(item.url), label: item.name + ' · ' + item.url }])).values()), { value: 'custom', label: t('launcher.customSource') }]}
      onValueChange={value => { if (value === 'custom') update(kind === 'npm' ? { npmRegistry: '' } : { pythonIndex: '' }); else void applyLive({ type: 'network.patch', patch: applySource(kind, value) }); }} />;
  };
  const proxyOptions = [{ value: 'smart', label: t('launcher.proxySmart') }, { value: 'global', label: t('launcher.proxyGlobal') }, { value: 'system', label: t('launcher.proxySystem') }, { value: 'direct', label: t('launcher.proxyDirect') }];
  const proxyText = stored.proxyMode === 'direct' ? t('launcher.proxyDirect') : stored.proxyMode === 'system' ? t('launcher.proxySystem') : t(stored.proxyRouting === 'smart' ? 'launcher.proxySmart' : 'launcher.proxyGlobal') + (activeProxy ? ' · ' + activeProxy.name : '');
  const proxyFor = (kind: DshNetworkSourceKind) => {
    const route = inspection?.routes.find(item => item.kind === kind);
    return route?.error ?? (route?.proxy === 'DIRECT' ? t('launcher.proxyDirect') : route?.proxy ?? (stored.proxyMode === 'custom' ? stored.proxyUrl : stored.proxyMode === 'direct' ? t('launcher.proxyDirect') : t('launcher.resolvingProxy')));
  };
  const githubPolicy = stored.githubMirror === 'auto' ? t('launcher.githubAutoPolicy') : stored.githubMirror === 'direct' ? t('launcher.githubOfficial') : (stored.githubMirror === 'custom' ? stored.githubMirrorUrl : { 'gh-proxy': 'https://gh-proxy.com/', ghfast: 'https://ghfast.top/', ghproxy: 'https://ghproxy.net/' }[stored.githubMirror]) + ' · ' + t('launcher.fallbackOfficial');
  return <div className="launcher-page launcher-network-page" data-application-network-settings>
    <div className="launcher-page-heading"><div><h1>{t('appNavigation.network')}</h1><p>{t('launcher.networkHotNote')}</p></div><Button disabled={locked || !dirty} loading={busy} iconName="check" onClick={() => void save()} variant="primary">{t('launcher.saveNetwork')}</Button></div>
    {error ? <p className="launcher-network-error" role="alert">{error}</p> : null}
    {network.error && network.error !== error ? <p className="launcher-network-error" role="alert">{network.error}</p> : null}
    <section className="launcher-card launcher-network-active" data-network-active aria-label={t('launcher.networkActive')}>
      <div className="launcher-card-heading"><div><h2>{t('launcher.networkActive')}</h2><p>{t('launcher.networkActiveNote')}</p></div><span className="launcher-badge launcher-badge--success">{t('launcher.appliedConfig')}</span></div>
      {dirty ? <p className="launcher-network-pending" role="status">{t('launcher.networkPendingNote')}</p> : null}
      <div className="launcher-active-proxy" data-proxy-enabled={stored.proxyMode !== 'direct'}><span className="launcher-active-dot" /><div><strong>{proxyText}</strong><p>{stored.proxyMode === 'custom' ? stored.proxyUrl : t(stored.proxyMode === 'system' ? 'launcher.systemProxyPerTarget' : 'launcher.directProxyNote')}</p></div><Button className="launcher-proxy-toggle" role="switch" aria-label={t('launcher.proxyEnabled')} aria-checked={stored.proxyMode !== 'direct'} disabled={locked} onClick={() => void applyLive({ type: 'network.proxy.toggle', enabled: stored.proxyMode === 'direct' })} variant={stored.proxyMode === 'direct' ? 'secondary' : 'primary'}>{t(stored.proxyMode === 'direct' ? 'launcher.enableProxy' : 'launcher.disableProxy')}</Button></div>
      <p className="launcher-help">{t('launcher.proxyToggleNote')}</p>
      <Select disabled={locked} label={t('launcher.activeProxyMode')} value={proxyChoice(stored)} options={proxyOptions} onValueChange={value => void applyLive({ type: 'network.patch', patch: proxyChoicePatch(value) })} />
      <p className="launcher-help">{t(stored.proxyMode === 'custom' && stored.proxyRouting === 'smart' ? 'launcher.proxySmartNote' : stored.proxyMode === 'custom' ? 'launcher.proxyGlobalNote' : 'launcher.proxySystemDirectNote')}</p>
      {stored.proxyMode === 'custom' && stored.proxyRouting === 'smart' ? <div data-smart-cdn-routes><p className="launcher-help">{t('launcher.pixivCdnRoutes')} {network.smartDirectHosts?.length ? network.smartDirectHosts.join(', ') + ' · ' + t('launcher.proxyDirect') : t('launcher.pixivCdnViaProxy')}</p><Button disabled={locked} size="sm" variant="quiet" onClick={() => void applyLive({ type: 'network.patch', patch: { proxyRouting: 'smart' } })}>{t('launcher.recheckSmartRoutes')}</Button></div> : null}
      <Select disabled={locked} label={t('launcher.quickProxyPort')} value={stored.proxyMode === 'custom' && LOCAL_HTTP_PROXY_PORTS.some(port => stored.proxyUrl === `http://127.0.0.1:${port}`) ? stored.proxyUrl : ''} options={[{ value: '', label: t('launcher.chooseProxyPort') }, ...LOCAL_HTTP_PROXY_PORTS.map(port => ({ value: `http://127.0.0.1:${port}`, label: `127.0.0.1:${port}` }))]} onValueChange={value => { if (value) void applyLive({ type: 'network.patch', patch: { proxyMode: 'custom', proxyUrl: value } }); }} />
      <p className="launcher-help">{t('launcher.proxyPortNote')}</p>
      <div className="launcher-active-sources">{(['npm', 'python', 'github'] as const).map(kind => <div className="launcher-active-source" key={kind} data-active-source={kind}>
        <h3>{sourceNames[kind]}</h3><strong>{kind === 'npm' ? t(automaticNpm ? 'launcher.routeAutomatic' : 'launcher.routeSpecified') : kind === 'python' ? t('launcher.routeSpecified') : t(stored.githubMirror === 'auto' ? 'launcher.routeFallback' : 'launcher.routeSpecified')}</strong>
        <p>{kind === 'npm' ? automaticNpm ? officialNpm + ' / https://registry.npmmirror.com' : stored.npmRegistry : kind === 'python' ? stored.pythonIndex : githubPolicy}</p>
        {kind === 'npm' && automaticNpm ? <p className="launcher-help">{inspection?.npmSelection ? t('launcher.lastMetadataRoute') + ' ' + inspection.npmSelection.registry + (inspection.npmSelection.probed ? '' : ' · ' + t('launcher.probeFallback')) : t('launcher.automaticPending')}</p> : null}
        {kind === 'github' && inspection?.githubSelection ? <p className="launcher-help">{t('launcher.lastRequestRoute')} {inspection.githubSelection.url}</p> : null}
        <div className="launcher-route-proxy"><span>{t('launcher.effectiveProxy')}</span><code>{proxyFor(kind)}</code></div>
      </div>)}</div>
      <p className="launcher-help">{t('launcher.networkApplyScope')}</p>
    </section>
    <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.connectionRoute')}</h2><p>{t('launcher.proxyScopeNote')}</p></div><span className="launcher-badge">{t(dirty ? 'launcher.networkUnsaved' : 'launcher.networkSaved')}</span></div>
      <fieldset disabled={locked} className="launcher-network-fields"><div className="launcher-network-grid"><Select label={t('launcher.proxyMode')} onValueChange={value => update(proxyChoicePatch(value))} options={proxyOptions} value={proxyChoice(draft)} /><TextField autoComplete="off" disabled={draft.proxyMode !== 'custom'} label={t('launcher.proxyAddress')} onChange={event => update({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7897" value={draft.proxyUrl} /></div>
      <div className="launcher-network-profiles"><div><h3>{t('launcher.proxyProfiles')}</h3><p className="launcher-help">{t('launcher.proxyProfilesNote')}</p></div>
        <ul className="launcher-proxy-profile-list">{draft.proxyProfiles.map(profile => {
          const active = stored.proxyMode === 'custom' && activeProxy?.id === profile.id;
          return <li key={profile.id} data-profile-active={active}><div><strong>{profile.name}</strong><span className={'launcher-profile-status' + (active ? ' is-active' : '')}>{t(active ? 'launcher.profileActive' : 'launcher.profileSaved')}</span></div><code title={profile.url}>{profile.url}</code><div className="launcher-actions"><Button onClick={() => void applyLive(active ? { type: 'network.proxy.toggle', enabled: false } : { type: 'network.patch', patch: { proxyMode: 'custom', proxyUrl: profile.url } })} size="sm" variant={active ? 'quiet' : 'secondary'}>{t(active ? 'launcher.disableProxy' : 'launcher.activateProfile')}</Button><Button onClick={() => { setEditingProxy(profile.id); setProfileName(profile.name); setProfileUrl(profile.url); }} size="sm" variant="quiet">{t('launcher.editNetworkProfile')}</Button><Button aria-label={t('launcher.removeProxyProfile', { name: profile.name })} iconName="trash" onClick={() => void save({ ...draft, proxyProfiles: draft.proxyProfiles.filter(item => item.id !== profile.id) })} size="sm" variant="quiet" /></div></li>;
        })}</ul>
        <div className="launcher-network-profile-add"><TextField label={t('launcher.proxyProfileName')} maxLength={100} onChange={event => setProfileName(event.target.value)} value={profileName} /><TextField label={t('launcher.newProxyAddress')} autoComplete="off" maxLength={2048} onChange={event => setProfileUrl(event.target.value)} placeholder="http://127.0.0.1:7897" value={profileUrl} /><Button disabled={!profileName.trim() || !profileUrl.trim() || (!editingProxy && draft.proxyProfiles.length >= 30)} iconName="plus" onClick={() => void addProxy()}>{t(editingProxy ? 'launcher.saveAndActivate' : 'launcher.addAndActivate')}</Button>{editingProxy ? <Button variant="quiet" onClick={() => { setEditingProxy(undefined); setProfileName(''); setProfileUrl(''); }}>{t('launcher.cancel')}</Button> : null}</div>
      </div></fieldset>
    </section>
    <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.downloadSources')}</h2><p>{t('launcher.downloadSourcesNote')}</p></div></div>
      <fieldset disabled={locked} className="launcher-network-fields"><div className="launcher-network-grid">{sourcePreset('npm')}{sourcePreset('python')}<TextField label={t('launcher.npmRegistry')} onChange={event => update({ npmRegistry: event.target.value })} value={draft.npmRegistry} /><TextField label={t('launcher.pythonIndex')} onChange={event => update({ pythonIndex: event.target.value })} value={draft.pythonIndex} /><Select label={t('launcher.githubMirror')} onValueChange={value => { if (value === 'custom') update({ githubMirror: 'custom' }); else void applyLive({ type: 'network.patch', patch: { githubMirror: value as DshNetworkSettings['githubMirror'] } }); }} options={[{ value: 'auto', label: t('launcher.mirrorAuto') }, { value: 'direct', label: t('launcher.mirrorDirect') }, { value: 'gh-proxy', label: 'gh-proxy.com' }, { value: 'ghfast', label: 'ghfast.top' }, { value: 'ghproxy', label: 'ghproxy.net' }, { value: 'custom', label: t('launcher.mirrorCustom') }]} value={draft.githubMirror} /><TextField disabled={draft.githubMirror !== 'custom'} label={t('launcher.githubMirrorAddress')} onChange={event => update({ githubMirrorUrl: event.target.value })} placeholder="https://mirror.example/" value={draft.githubMirrorUrl} /></div>
      <div className="launcher-network-policy"><Select disabled={draft.npmRegistry !== officialNpm} label={t('launcher.npmDownloadRoute')} value={draft.npmDownloadRoute} onValueChange={value => update({ npmDownloadRoute: value as DshNetworkSettings['npmDownloadRoute'] })} options={[{ value: 'auto', label: t('launcher.npmDownloadAuto') }, { value: 'registry', label: t('launcher.npmDownloadRegistry') }]} /><p className="launcher-help">{t(draft.npmRegistry === officialNpm ? 'launcher.npmDownloadRouteNote' : 'launcher.customRegistryActive')}</p></div>
      <div className="launcher-network-profiles"><div><h3>{t('launcher.sourceProfiles')}</h3><p className="launcher-help">{t('launcher.sourceProfilesNote')}</p></div>
        <ul className="launcher-proxy-profile-list">{profiles.map(profile => { const active = sourceActive(stored, profile.kind, profile.url); return <li key={profile.id} data-profile-active={active}><div><strong>{profile.name}</strong><span className={'launcher-profile-status' + (active ? ' is-active' : '')}>{sourceNames[profile.kind]} · {t(active ? 'launcher.profileActive' : 'launcher.profileSaved')}</span></div><code title={profile.url}>{profile.url}</code><div className="launcher-actions"><Button disabled={active} onClick={() => void applyLive({ type: 'network.patch', patch: applySource(profile.kind, profile.url) })} size="sm" variant="secondary">{t(active ? 'launcher.profileActive' : 'launcher.activateProfile')}</Button><Button size="sm" variant="quiet" onClick={() => { setEditingSource(profile.id); setSourceName(profile.name); setSourceUrl(profile.url); setSourceKind(profile.kind); }}>{t('launcher.editNetworkProfile')}</Button><Button aria-label={t('launcher.removeSourceProfile', { name: profile.name })} iconName="trash" onClick={() => void save({ ...draft, sourceProfiles: profiles.filter(item => item.id !== profile.id) })} size="sm" variant="quiet" /></div></li>; })}</ul>
        <div className="launcher-source-profile-add"><Select label={t('launcher.sourceProfileKind')} value={sourceKind} options={Object.entries(sourceNames).map(([value, label]) => ({ value, label }))} onValueChange={value => setSourceKind(value as DshNetworkSourceKind)} /><TextField label={t('launcher.sourceProfileName')} maxLength={100} value={sourceName} onChange={event => setSourceName(event.target.value)} /><TextField label={t('launcher.sourceProfileUrl')} maxLength={2048} placeholder="https://" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} /><Button disabled={!sourceName.trim() || !sourceUrl.trim() || (!editingSource && profiles.length >= 30)} iconName="plus" onClick={() => void addSource()}>{t(editingSource ? 'launcher.saveAndActivate' : 'launcher.addAndActivate')}</Button>{editingSource ? <Button variant="quiet" onClick={() => { setEditingSource(undefined); setSourceName(''); setSourceUrl(''); }}>{t('launcher.cancel')}</Button> : null}</div>
      </div></fieldset>
    </section>
    <section className="launcher-card launcher-network-test"><div className="launcher-card-heading"><div><h2>{t('launcher.networkDiagnostics')}</h2><p>{t('launcher.networkTestNote')}</p></div><Button disabled={locked} loading={testing} iconName="activity" onClick={() => void test()}>{t(dirty ? 'launcher.saveAndTestNetwork' : 'launcher.testNetwork')}</Button></div>
      {checks ? <div className="launcher-network-checks">{checks.results.map(result => <div key={result.kind} className="launcher-network-check" data-check-ok={result.ok}><h3>{sourceNames[result.kind]} <span>{t(result.ok ? 'launcher.checkPassed' : 'launcher.checkFailed')}</span></h3>{result.attempts.map((attempt, index) => <div key={index + '-' + attempt.url}><p>{index ? t('launcher.checkFallback') + ' · ' : ''}{attempt.url}</p><code>{attempt.proxy === 'DIRECT' ? t('launcher.proxyDirect') : attempt.proxy} · {Math.round(attempt.elapsedMs)} ms{attempt.status ? ' · HTTP ' + attempt.status : ''}</code>{attempt.error ? <p className="launcher-network-error">{attempt.error}</p> : null}</div>)}</div>)}<p className="launcher-help">{t('launcher.lastChecked')} {new Date(checks.checkedAt).toLocaleString()}</p></div> : <pre aria-label={t('launcher.networkDiagnostics')} className="launcher-command-output">{testResult || t('launcher.networkTestEmpty')}</pre>}
    </section>
    <section className="launcher-card launcher-network-test" data-pixiv-network-check>
      <div className="launcher-card-heading"><div><h2>{t('launcher.pixivCheck')}</h2><p>{t('launcher.pixivCheckNote')}</p></div><Button disabled={locked} loading={testingPixiv} iconName="activity" onClick={() => void testPixiv()}>{t(dirty ? 'launcher.saveAndTestPixiv' : 'launcher.testPixiv')}</Button></div>
      {network.pixivCheck ? <div className="launcher-network-checks">{network.pixivCheck.results.map(result => <div className="launcher-network-check" key={result.kind} data-pixiv-check={result.kind} data-check-ok={result.ok}>
        <h3>{t('launcher.pixivCheck_' + result.kind)} · {t(result.ok ? 'launcher.checkPassed' : 'launcher.checkFailed')}</h3><p>{result.url}</p><code>{result.proxy === 'DIRECT' ? t('launcher.proxyDirect') : result.proxy} · {Math.round(result.elapsedMs)} ms{result.status ? ' · HTTP ' + result.status : ''}{result.bytes ? ' · ' + result.bytes + ' B' : ''}</code>{result.error ? <p className="launcher-network-error">{result.error}</p> : null}
      </div>)}<p className="launcher-help">{t('launcher.lastChecked')} {new Date(network.pixivCheck.checkedAt).toLocaleString()}</p></div> : <p className="launcher-help">{t('launcher.pixivCheckEmpty')}</p>}
      <p className="launcher-help">{t('launcher.pixivUpstreamNote')}</p>
    </section>
    <RecentNetworkFailures network={network} run={run} />
  </div>;
}
