import { useState } from 'react';
import type { DshLauncherState, DshNetworkSettings } from '../../shared/dsh-launcher';
import { useT } from '../i18n';
import { Button, Select, TextField } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';

export function LauncherNetworkSettings({ state, run, disabled = false }: {
  readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly disabled?: boolean;
}) {
  const t = useT(); const stored = state.network?.settings;
  const [changes, setChanges] = useState<Partial<DshNetworkSettings>>({});
  const [profileName, setProfileName] = useState('');
  const [testResult, setTestResult] = useState(''); const [testing, setTesting] = useState(false);
  if (!stored) return <div className="launcher-page"><div className="launcher-page-heading"><h1>{t('launcher.networkSettings')}</h1></div><p className="launcher-help">{t('launcher.loading')}</p></div>;
  const draft: DshNetworkSettings = { ...stored, ...changes };
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const update = (patch: Partial<DshNetworkSettings>) => setChanges(previous => ({ ...previous, ...patch }));
  const save = async () => {
    const response = await run({ type: 'network.save', settings: draft });
    if (response.ok) setChanges({}); return response.ok;
  };
  const test = async () => {
    setTesting(true);
    try {
      if (dirty && !await save()) return;
      const result = await run({ type: 'network.test' });
      if (result.ok) setTestResult(result.text ?? t('launcher.networkTestCompleted'));
    } finally { setTesting(false); }
  };
  const addProfile = () => {
    if (!profileName.trim() || !draft.proxyUrl.trim() || draft.proxyProfiles.length >= 30) return;
    update({ proxyProfiles: [...draft.proxyProfiles, { id: `proxy-${crypto.randomUUID()}`, name: profileName.trim(), url: draft.proxyUrl.trim() }] });
    setProfileName('');
  };
  return <div className="launcher-page launcher-network-page" data-dsh-network-settings>
    <div className="launcher-page-heading"><div><h1>{t('launcher.networkSettings')}</h1><p>{t('launcher.networkHotNote')}</p></div><Button disabled={disabled || testing || !dirty} iconName="check" onClick={() => void save()} variant="primary">{t('launcher.saveNetwork')}</Button></div>
    <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.connectionRoute')}</h2><p>{t('launcher.proxyScopeNote')}</p></div><span className="launcher-badge">{t(dirty ? 'launcher.networkUnsaved' : 'launcher.networkSaved')}</span></div><div className="launcher-network-grid"><Select label={t('launcher.proxyMode')} onValueChange={value => update({ proxyMode: value as DshNetworkSettings['proxyMode'] })} options={[{ value: 'system', label: t('launcher.proxySystem') }, { value: 'direct', label: t('launcher.proxyDirect') }, { value: 'custom', label: t('launcher.proxyCustom') }]} value={draft.proxyMode} /><TextField autoComplete="off" disabled={draft.proxyMode !== 'custom'} label={t('launcher.proxyAddress')} onChange={event => update({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7890" value={draft.proxyUrl} /></div>
      <div className="launcher-network-profiles"><div><h3>{t('launcher.proxyProfiles')}</h3><p className="launcher-help">{t('launcher.proxyProfilesNote')}</p></div><div className="launcher-network-profile-add"><TextField aria-label={t('launcher.proxyProfileName')} maxLength={100} onChange={event => setProfileName(event.target.value)} placeholder={t('launcher.proxyProfileName')} value={profileName} /><Button disabled={!profileName.trim() || !draft.proxyUrl.trim() || draft.proxyProfiles.length >= 30} iconName="plus" onClick={addProfile} size="sm">{t('launcher.saveProxyProfile')}</Button></div>{draft.proxyProfiles.length ? <ul className="launcher-proxy-profile-list">{draft.proxyProfiles.map(profile => <li key={profile.id}><strong>{profile.name}</strong><code>{profile.url}</code><div className="launcher-actions"><Button onClick={() => update({ proxyMode: 'custom', proxyUrl: profile.url })} size="sm" variant="quiet">{t('launcher.useProxyProfile')}</Button><Button aria-label={t('launcher.removeProxyProfile', { name: profile.name })} iconName="trash" onClick={() => update({ proxyProfiles: draft.proxyProfiles.filter(item => item.id !== profile.id) })} size="sm" variant="quiet" /></div></li>)}</ul> : <p className="launcher-help">{t('launcher.noProxyProfiles')}</p>}</div>
    </section>
    <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.downloadSources')}</h2><p>{t('launcher.downloadSourcesNote')}</p></div></div><div className="launcher-network-grid"><TextField label={t('launcher.npmRegistry')} onChange={event => update({ npmRegistry: event.target.value })} placeholder="https://registry.npmjs.org" value={draft.npmRegistry} /><TextField label={t('launcher.pythonIndex')} onChange={event => update({ pythonIndex: event.target.value })} placeholder="https://pypi.org/simple" value={draft.pythonIndex} /><Select label={t('launcher.githubMirror')} onValueChange={value => update({ githubMirror: value as DshNetworkSettings['githubMirror'] })} options={[{ value: 'auto', label: t('launcher.mirrorAuto') }, { value: 'direct', label: t('launcher.mirrorDirect') }, { value: 'gh-proxy', label: 'gh-proxy.com' }, { value: 'ghfast', label: 'ghfast.top' }, { value: 'ghproxy', label: 'ghproxy.net' }, { value: 'custom', label: t('launcher.mirrorCustom') }]} value={draft.githubMirror} /><TextField disabled={draft.githubMirror !== 'custom'} label={t('launcher.githubMirrorAddress')} onChange={event => update({ githubMirrorUrl: event.target.value })} placeholder="https://mirror.example/" value={draft.githubMirrorUrl} /></div></section>
    <section className="launcher-card launcher-network-test"><div className="launcher-card-heading"><div><h2>{t('launcher.networkDiagnostics')}</h2><p>{t('launcher.networkTestNote')}</p></div><Button disabled={disabled || testing} loading={testing} iconName="activity" onClick={() => void test()}>{t(dirty ? 'launcher.saveAndTestNetwork' : 'launcher.testNetwork')}</Button></div><pre aria-label={t('launcher.networkDiagnostics')} className="launcher-command-output">{testResult || t('launcher.networkTestEmpty')}</pre></section>
  </div>;
}
