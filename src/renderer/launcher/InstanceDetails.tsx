import { useEffect, useState } from 'react';

import type { DshInstance, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { Icon } from '../Icons';
import { useT } from '../i18n';
import { formatBytes } from '../format-file-meta';
import { Button, TextField } from '../ui';
import { formatDate, instanceCanEdit, Meta, type LauncherRunRequest } from './DshLauncher';
import type { LauncherDialogState } from './LauncherDialog';
import { InstancePluginControls } from './InstancePluginControls';

type DetailTab = 'overview' | 'plugins' | 'logs' | 'snapshots';

export function InstanceDetails({ api, busy, instance, state, run, onDialog, onError, preparingStart = false }: {
  readonly api: WorldlineBoxDshLauncherApi;
  readonly busy: boolean;
  readonly instance: DshInstance;
  readonly state: DshLauncherState;
  readonly run: LauncherRunRequest;
  readonly onDialog: (dialog: LauncherDialogState) => void;
  readonly onError?: (message: string) => void;
  readonly preparingStart?: boolean;
}) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>('overview');
  const [logs, setLogs] = useState('');
  const [logError, setLogError] = useState<string | null>(null);
  const [pluginSpec, setPluginSpec] = useState('');
  const [output, setOutput] = useState('');
  useEffect(() => { if (logError) onError?.(logError); }, [logError, onError]);
  const runtime = state.runtimes.find((item) => item.id === instance.runtimeId);
  const editable = instanceCanEdit(instance) && !busy;
  const snapshots = state.snapshots.filter((item) => item.instanceId === instance.id);
  const otherWorkbench = state.instances.find(item => item.id !== instance.id && ['running', 'starting', 'stopping'].includes(item.status));
  const pendingStart = state.operations.find((item) => item.instanceId === instance.id && ['instance.start', 'instance.switch-start'].includes(item.kind) && item.status === 'running');

  useEffect(() => {
    if (tab !== 'logs' && tab !== 'plugins') return;
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api.request({ type: 'instance.logs', instanceId: instance.id });
        if (!active) return;
        if (result.ok) { setLogs(result.text ?? ''); setLogError(null); }
        else setLogError(result.error);
      } catch (cause) {
        if (active) setLogError(cause instanceof Error ? cause.message : String(cause));
      } finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, instance.id, tab]);

  const command = async (action: 'check' | 'list' | 'add' | 'remove') => {
    const result = await run(action === 'check' ? { type: 'instance.check', instanceId: instance.id } : { type: 'instance.plugin', instanceId: instance.id, action, ...(action === 'add' || action === 'remove' ? { spec: pluginSpec.trim() } : {}) });
    if (result.ok && result.text) setOutput(result.text);
  };
  const openFolder = (scope: 'home' | 'agents' | 'workspace' | 'logs' | 'root') => void run({ type: 'instance.folder', instanceId: instance.id, scope });

  return <div className="launcher-page launcher-instance-details">
    <div className="launcher-page-heading"><div><div className="launcher-instance-title"><h1>{instance.name}</h1>{instance.isDefault ? <span className="launcher-badge">{t('launcher.default')}</span> : null}</div><p><span className={`launcher-status-dot is-${instance.status}`} />{t(`launcher.status.${instance.status}`)}<span className="launcher-inline-divider">·</span>DSH {runtime?.version ?? instance.runtimeId}</p></div><div className="launcher-actions">{instance.status === 'running' ? <Button data-dsh-open-workbench iconName="external-link" onClick={() => void run({ type: 'instance.open', instanceId: instance.id })} variant="primary">{t('launcher.open')}</Button> : <Button disabled={!editable} loading={preparingStart} title={otherWorkbench ? t('launcher.switchWorkbenchNote') : undefined} iconName="activity" onClick={() => void run({ type: otherWorkbench ? 'instance.switch-start' : 'instance.start', instanceId: instance.id })} variant="primary">{t(otherWorkbench ? 'launcher.switchAndStart' : 'launcher.start')}</Button>}<Button disabled={!pendingStart && (busy || !['running', 'starting'].includes(instance.status))} iconName="stop" onClick={() => void run(pendingStart ? { type: 'operation.cancel', operationId: pendingStart.id } : { type: 'instance.stop', instanceId: instance.id })}>{t(pendingStart ? 'launcher.cancelOperation' : 'launcher.stop')}</Button></div></div>
    <div aria-label={instance.name} className="launcher-tabs" role="tablist">{(['overview', 'plugins', 'logs', 'snapshots'] as const).map((item, index, tabs) => <button aria-controls={`dsh-detail-${instance.id}-${item}`} aria-selected={tab === item} id={`dsh-tab-${instance.id}-${item}`} key={item} onClick={() => setTab(item)} onKeyDown={(event) => {
      const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
      if (nextIndex === undefined) return;
      event.preventDefault();
      const next = tabs[nextIndex]!;
      setTab(next);
      document.getElementById(`dsh-tab-${instance.id}-${next}`)?.focus();
    }} role="tab" tabIndex={tab === item ? 0 : -1} type="button">{t(`launcher.${item}`)}</button>)}</div>
    <div aria-labelledby={`dsh-tab-${instance.id}-${tab}`} id={`dsh-detail-${instance.id}-${tab}`} role="tabpanel">
      {tab === 'overview' ? <>
        <section className="launcher-card"><dl className="launcher-metadata"><Meta label={t('launcher.runtime')} value={runtime?.version ?? instance.runtimeId} /><Meta label={t('launcher.nodeVersion')} value={runtime?.nodeVersion ?? '—'} /><Meta label={t('launcher.profile')} value={instance.profile} /><Meta label={t('launcher.saveData')} value={t('launcher.sharedDataScope')} /><Meta label={t('launcher.process')} value={instance.pid ?? t('launcher.notRunning')} /><Meta label={t('launcher.port')} value={instance.port ?? '—'} /><Meta label={t('launcher.createdAt')} value={formatDate(instance.createdAt)} />{instance.parentInstanceId ? <Meta label={t('launcher.parent')} value={state.instances.find((item) => item.id === instance.parentInstanceId)?.name ?? instance.parentInstanceId} /> : null}{instance.lastExitCode !== undefined ? <Meta label={t('launcher.exitCode')} value={instance.lastExitCode ?? '—'} /> : null}</dl><p className="launcher-help">{t('launcher.workbenchNote')}</p></section>
        <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.isolated')}</h2><p>{t('launcher.isolatedDescription')}</p></div><Button iconName="folder" onClick={() => openFolder('root')} variant="quiet">{t('launcher.openRoot')}</Button></div><dl className="launcher-paths">{([{ key: 'home', scope: 'home', path: instance.homePath }, { key: 'agents', scope: 'agents', path: instance.agentsPath }] as const).map((item) => <Meta key={item.key} label={t(`launcher.${item.key}`)} mono value={item.path}><button aria-label={`${t('launcher.openFolder')} · ${t(`launcher.${item.key}`)}`} className="launcher-path-button" onClick={() => openFolder(item.scope)} type="button"><Icon name="external-link" size={16} /></button></Meta>)}<Meta label={t('launcher.browser')} mono value={instance.browserPartition} /></dl></section>
        {state.sharedData ? <section className="launcher-card" data-dsh-shared-data><div className="launcher-card-heading"><div><h2>{t('launcher.shared')}</h2><p>{t('launcher.sharedDescription')}</p></div><Button iconName="folder" onClick={() => void run({ type: 'shared.folder', scope: 'root' })} variant="quiet">{t('launcher.openShared')}</Button></div><dl className="launcher-paths">{([{ key: 'sessions', scope: 'sessions', path: state.sharedData.sessionsPath }, { key: 'workspace', scope: 'workspace', path: state.sharedData.workspacePath }] as const).map(item => <Meta key={item.key} label={t(`launcher.${item.key}`)} mono value={item.path}><button aria-label={`${t('launcher.openFolder')} · ${t(`launcher.${item.key}`)}`} className="launcher-path-button" onClick={() => void run({ type: 'shared.folder', scope: item.scope })} type="button"><Icon name="external-link" size={16} /></button></Meta>)}</dl><p className="launcher-help">{t('launcher.workspaceNote')}</p></section> : null}
        <section className="launcher-card launcher-management"><div className="launcher-actions"><Button disabled={busy || (state.cli ? state.cli.selectedInstanceId === instance.id : instance.isDefault)} iconName="star" onClick={() => void run({ type: state.cli ? 'cli.select' : 'instance.default', instanceId: instance.id })}>{t(state.cli ? 'launcher.selectCli' : 'launcher.setDefault')}</Button><Button disabled={busy} iconName="edit" onClick={() => onDialog({ kind: 'rename', instance })}>{t('launcher.rename')}</Button><Button disabled={!editable} iconName="copy" onClick={() => onDialog({ kind: 'clone', instance, name: `${instance.name} · ${t('launcher.copySuffix')}`, runtimeId: instance.runtimeId })}>{t('launcher.clone')}</Button><Button disabled={!editable} iconName="download" onClick={() => onDialog({ kind: 'upgrade', instance, name: `${instance.name} · ${t('launcher.upgradeSuffix')}`, runtimeId: instance.runtimeId })}>{t('launcher.upgrade')}</Button><Button disabled={!editable} iconName="trash" onClick={() => onDialog({ kind: 'delete-instance', instance })} variant="quiet">{t('launcher.deleteInstance')}</Button></div>{!instanceCanEdit(instance) ? <p className="launcher-help">{t('launcher.stopBefore')}</p> : null}</section>
      </> : tab === 'plugins' ? <><InstancePluginControls state={state} instanceId={instance.id} run={run} disabled={busy} />
        <section className="launcher-card"><div className="launcher-actions"><Button disabled={!editable} iconName="check" onClick={() => void command('check')}>{t('launcher.check')}</Button><Button disabled={!editable} iconName="menu" onClick={() => void command('list')}>{t('launcher.pluginList')}</Button></div><p className="launcher-help">{t('launcher.pluginNote')}</p><div className="launcher-plugin-form"><TextField label={t('launcher.pluginSpec')} maxLength={512} onChange={(event) => setPluginSpec(event.target.value)} placeholder={t('launcher.pluginPlaceholder')} value={pluginSpec} /><div className="launcher-actions"><Button disabled={!editable || !pluginSpec.trim()} iconName="plus" onClick={() => void command('add')} variant="primary">{t('launcher.pluginAdd')}</Button><Button disabled={!editable || !pluginSpec.trim()} iconName="trash" onClick={() => void command('remove')}>{t('launcher.pluginRemove')}</Button></div></div>{!instanceCanEdit(instance) ? <p className="launcher-help">{t('launcher.stopBefore')}</p> : null}</section>
        <section className="launcher-card"><h2>{t('launcher.checkOutput')}</h2><pre className="launcher-command-output">{logs || output || t('launcher.pluginEmpty')}</pre></section>
      </> : tab === 'logs' ? <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.logs')}</h2><p>{t('launcher.logHint')}</p></div><Button iconName="folder" onClick={() => openFolder('logs')} variant="quiet">{t('launcher.openFolder')}</Button></div><pre className="launcher-command-output launcher-logs" data-dsh-logs>{logs || t('launcher.noLogs')}</pre></section> : <>
        <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.snapshots')}</h2><p>{t('launcher.snapshotNote')}</p></div><Button disabled={!editable} iconName="archive" onClick={() => onDialog({ kind: 'snapshot', instance, name: `${t('launcher.snapshotDefaultName')} ${new Date().toLocaleDateString()}` })} variant="primary">{t('launcher.snapshotCreate')}</Button></div>{snapshots.length === 0 ? <p className="launcher-inline-empty">{t('launcher.noSnapshots')}</p> : <div className="launcher-snapshot-list">{snapshots.map((snapshot) => <div className="launcher-snapshot-item" key={snapshot.id}><div><strong>{snapshot.name}</strong><span>{formatDate(snapshot.createdAt)} · {formatBytes(snapshot.byteLength)}</span><code>{snapshot.contentSha256}</code></div><div className="launcher-actions"><Button disabled={busy} iconName="undo" onClick={() => onDialog({ kind: 'restore', snapshot, name: `${instance.name} · ${t('launcher.restoredSuffix')}` })}>{t('launcher.snapshotRestore')}</Button><Button aria-label={`${t('launcher.snapshotDelete')} · ${snapshot.name}`} disabled={busy} iconName="trash" onClick={() => onDialog({ kind: 'delete-snapshot', snapshot })} variant="quiet" /></div></div>)}</div>}</section>
        <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.packs')}</h2><p>{t('launcher.packNote')}</p></div><Button disabled={!editable} iconName="box" onClick={() => onDialog({ kind: 'pack-create', instance, name: instance.name })}>{t('launcher.packCreate')}</Button></div><p className="launcher-help">{t('launcher.packPrivacy')}</p></section>
        <section className="launcher-card"><div className="launcher-card-heading"><div><h2>{t('launcher.exportBackup')}</h2><p>{t('launcher.backupNote')}</p></div><Button disabled={!editable} iconName="download" onClick={() => onDialog({ kind: 'export', instance })}>{t('launcher.exportBackup')}</Button></div></section>
      </>}
    </div>
  </div>;
}
