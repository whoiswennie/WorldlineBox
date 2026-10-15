import type { DshRuntime } from '../../shared/dsh-launcher';
import { useT } from '../i18n';
import { Icon } from '../Icons';
import { Button } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';

export function RuntimeCompatibilityPanel({ runtime, busy, run }: { runtime: DshRuntime; busy: boolean; run: LauncherRunRequest }) {
  const t = useT(); const report = runtime.compatibility;
  const status = report?.status ?? 'unchecked';
  const passed = report?.checks.filter(check => check.status === 'passed').length ?? 0;
  return <div className="launcher-compatibility" data-dsh-compatibility={status}>
    <div className="launcher-compatibility-heading"><div><strong>{t('launcher.compatibilityTitle')}</strong><p>{t('launcher.compatibilityIsolation')}</p></div>
      <Button disabled={busy || status === 'running'} iconName="activity" onClick={() => void run({ type: 'runtime.compatibility', runtimeId: runtime.id })} size="sm">{t(report ? 'launcher.compatibilityRetry' : 'launcher.compatibilityRun')}</Button></div>
    <details open={status === 'failed' || status === 'interrupted'}><summary><span className={`launcher-compatibility-status is-${status}`}><Icon name={status === 'passed' ? 'check' : status === 'failed' ? 'info' : 'activity'} size={15} />{t(`launcher.compatibilityStatuses.${status}`)}</span><span>{passed} / {report?.checks.length ?? 11}</span><span>{t('launcher.compatibilityDetails')}</span></summary>
      {report ? <><ol>{report.checks.map(check => <li key={check.id} className={`is-${check.status}`}><span className="launcher-compatibility-check-icon"><Icon name={check.status === 'passed' ? 'check' : check.status === 'failed' ? 'info' : 'clock'} size={16} /></span><div><strong>{t(`launcher.compatibilityChecks.${check.id}`)}</strong><p>{check.detail}</p></div><span className="launcher-compatibility-check-status">{t(`launcher.compatibilityCheckStatuses.${check.status}`)}{check.durationMs !== undefined ? <small>{(check.durationMs / 1000).toFixed(1)} s</small> : null}</span></li>)}</ol>
        <p className="launcher-help">{report.finishedAt ? new Date(report.finishedAt).toLocaleString() : new Date(report.startedAt).toLocaleString()} · SHA-256 {report.contentSha256.slice(0, 16)}</p>
        {report.peers.length ? <p className="launcher-help">{t('launcher.compatibilityPeers')} {report.peers.map(peer => `${peer.version} · ${peer.contentSha256.slice(0, 12)}`).join(' / ')}</p> : null}</> : <p className="launcher-help">{t('launcher.compatibilityUnchecked')}</p>}
    </details>
  </div>;
}
