import { useState } from 'react';
import type { DshOperation } from '../../shared/dsh-launcher';
import { Button, Progress } from '../ui';
import { useT } from '../i18n';
import { formatBytes } from '../format-file-meta';
import type { LauncherRunRequest } from './DshLauncher';

export function OperationControls({ operation, run }: { operation: DshOperation; run: LauncherRunRequest }) {
  const t = useT(); const [pending, setPending] = useState(false);
  const control = async (type: 'operation.pause' | 'operation.resume' | 'operation.cancel' | 'operation.retry') => {
    if (pending) return; setPending(true);
    try { await run({ type, operationId: operation.id }); } finally { setPending(false); }
  };
  const running = operation.status === 'running';
  const stats = operation.download;
  const phaseKey = `launcher.phases.${operation.phase.split(':', 1)[0]}`;
  const phase = t(phaseKey) === phaseKey ? operation.phase : t(phaseKey);
  const label = stats?.paused ? t('launcher.downloadPaused') : phase;
  const downloadPercent = stats?.canPause && stats.totalBytes ? Math.min(100, stats.transferredBytes / stats.totalBytes * 100) : undefined;
  return <>
    <div className="launcher-operation-tools">
      {running && stats?.canPause ? <Button disabled={pending} onClick={() => void control(stats.paused ? 'operation.resume' : 'operation.pause')} size="sm" variant="secondary">{t(stats.paused ? 'launcher.resumeDownload' : 'launcher.pauseDownload')}</Button> : null}
      {running ? <Button disabled={pending || operation.phase === 'cancelling'} onClick={() => void control('operation.cancel')} size="sm" variant="quiet">{t(operation.phase === 'cancelling' ? 'launcher.cancellingOperation' : 'launcher.cancelOperation')}</Button>
        : operation.retryRequest && operation.status !== 'succeeded' ? <Button disabled={pending} iconName="refresh" onClick={() => void control('operation.retry')} size="sm">{t('launcher.retryOperation')}</Button> : null}
    </div>
    {running ? <Progress label={label} showValue value={downloadPercent ?? operation.progress} /> : <p className="launcher-help">{label}</p>}
    {stats ? <div className="launcher-download-stats"><span>{formatBytes(stats.transferredBytes)}{stats.totalBytes ? ` / ${formatBytes(stats.totalBytes)}` : ''}</span><span>{stats.paused ? t('launcher.downloadPaused') : `${formatBytes(stats.speedBytesPerSecond)}/s`}</span></div> : null}
  </>;
}
