import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';

import {
  DSH_OFFICIAL_WINDOWS_URL,
  type DshInstance,
  type DshPack,
  type DshLauncherRequest,
  type DshLauncherResponse,
  type DshLauncherState,
  type DshRuntime,
  type WorldlineBoxDshLauncherApi,
} from '../../shared/dsh-launcher';
import { Icon, type IconName } from '../Icons';
import { useT, type TranslateFn } from '../i18n';
import { formatBytes } from '../format-file-meta';
import { Button } from '../ui';
import { InstanceDetails } from './InstanceDetails';
import { LauncherDialog, type LauncherDialogState } from './LauncherDialog';
import { initialOperationNotifications, operationNotificationsReducer } from './operation-notifications';
import { LauncherNotification } from './LauncherNotification';
import { OfficialVersionPicker } from './OfficialVersionPicker';
import { LauncherOperationsPage } from './LauncherOperationsPage';
import { LauncherTaskAccess } from './LauncherTaskAccess';
import { LauncherMarketplace } from './LauncherMarketplace';
import { PackSharing, PackUrlImport } from './PackSharing';
import { RuntimeCompatibilityPanel } from './RuntimeCompatibilityPanel';
import { runtimeReferences } from '../../shared/dsh-runtime-references';
import './launcher.css';

export type LauncherRunRequest = (request: DshLauncherRequest) => Promise<DshLauncherResponse>;
type LauncherPage = 'instances' | 'runtimes' | 'packs' | 'operations' | 'plugin-market' | 'skill-market' | 'task-access';
const navigation: readonly { page: LauncherPage; label: string; icon: IconName }[] = [
  { page: 'instances', label: 'instances', icon: 'box' }, { page: 'runtimes', label: 'runtimes', icon: 'download' },
  { page: 'packs', label: 'packs', icon: 'archive' }, { page: 'plugin-market', label: 'pluginMarket', icon: 'grid' },
  { page: 'skill-market', label: 'skillMarket', icon: 'smart' },
  { page: 'task-access', label: 'taskAccess', icon: 'sliders' },
  { page: 'operations', label: 'operations', icon: 'activity' },
];

export function DshLauncher({ api }: { readonly api?: WorldlineBoxDshLauncherApi }): ReactNode {
  const t = useT();
  const [state, setState] = useState<DshLauncherState | null>(null);
  const [page, setPage] = useState<LauncherPage>('instances');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<LauncherDialogState | null>(null);
  const [connected, setConnected] = useState(false);
  const stateRef = useRef<DshLauncherState | null>(null);
  const cliRequest = useRef<{ instanceId: string; promise: Promise<DshLauncherResponse> } | null>(null);
  const cliEpoch = useRef(0);
  const [preparingCli, setPreparingCli] = useState<string | null>(null);
  const [queuedStart, setQueuedStart] = useState<string | null>(null);
  const [notifications, dispatchNotification] = useReducer(operationNotificationsReducer, initialOperationNotifications);
  const acceptState = useCallback((next: DshLauncherState) => {
    stateRef.current = next;
    setState(next);
    dispatchNotification({ type: 'observe', operations: next.operations });
    setConnected(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.request({ type: 'state' });
      if (!result.ok) setError(result.error);
      else if (result.state) {
        acceptState(result.state);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, acceptState]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const unsubscribe = api.onChanged((next) => {
      if (active) acceptState(next);
    });
    void api.request({ type: 'state' }).then((result) => {
      if (!active) return;
      if (!result.ok) setError(result.error);
      else if (result.state) acceptState(result.state);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; unsubscribe(); };
  }, [api, acceptState]);

  const run = useCallback<LauncherRunRequest>(async (request) => {
    if (!api) return { ok: false, error: t('launcher.unavailable') };
    if (request.type === 'terminal.input' || request.type === 'terminal.resize') {
      try { return await api.request(request); }
      catch { return { ok: false, error: t('launcher.errorFallback') }; }
    }
    if (request.type === 'network.inspect') {
      try { const result = await api.request(request); if (result.ok && result.state) acceptState(result.state); return result; }
      catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : t('launcher.errorFallback') }; }
    }
    if (request.type === 'cli.select') {
      if (cliRequest.current?.instanceId === request.instanceId) return cliRequest.current.promise;
      if (!cliRequest.current && stateRef.current?.cli?.selectedInstanceId === request.instanceId) return { ok: true, state: stateRef.current };
      const epoch = ++cliEpoch.current;
      setPreparingCli(request.instanceId);
      const promise = (async (): Promise<DshLauncherResponse> => {
        try {
          const result = await api.request(request);
          if (epoch !== cliEpoch.current) return { ok: true, cancelled: true };
          if (!result.ok) setError(result.error);
          else if (result.state) acceptState(result.state);
          return result;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : t('launcher.errorFallback');
          if (epoch === cliEpoch.current) setError(message);
          return { ok: false, error: message };
        } finally {
          if (epoch === cliEpoch.current) { cliRequest.current = null; setPreparingCli(null); }
        }
      })();
      cliRequest.current = { instanceId: request.instanceId, promise };
      return promise;
    }
    if (request.type.startsWith('terminal.') || request.type.startsWith('operation.')) {
      dispatchNotification({ type: 'request', request });
      try {
        const result = await api.request(request);
        if (!result.ok) setError(result.error);
        else if (result.state) acceptState(result.state);
        else if (request.type.startsWith('operation.')) await refresh();
        if (result.ok && result.removedOperations !== undefined) setNotice(t('launcher.operationsCleared', { count: result.removedOperations }));
        return result;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : t('launcher.errorFallback');
        setError(message); return { ok: false, error: message };
      }
    }
    if (['market.search', 'skill.list', 'skill.inspect', 'pack.inspect-url', 'instance.plugins', 'instance.open'].includes(request.type)) {
      try {
        const result = await api.request(request);
        if (!result.ok) setError(result.error);
        else if (request.type === 'market.search' && result.marketPage) {
          const marketPage = result.marketPage;
          setState(previous => previous ? { ...previous, marketplace: { ...previous.marketplace, [request.kind === 'plugin' ? 'plugins' : 'skills']: marketPage } } : previous);
        }
        return result;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : t('launcher.errorFallback');
        setError(message); return { ok: false, error: message };
      }
    }
    if ((request.type === 'instance.start' || request.type === 'instance.switch-start') && cliRequest.current?.instanceId === request.instanceId) {
      setQueuedStart(request.instanceId);
      const result = await cliRequest.current.promise;
      setQueuedStart(null);
      if (!result.ok || result.cancelled) return result;
    }
    setRequesting(true);
    setError(null);
    setNotice(null);
    dispatchNotification({ type: 'request', request });
    try {
      const result = await api.request(request);
      if (!result.ok) setError(result.error);
      else {
        if (result.state) acceptState(result.state);
        if (result.instanceId) {
          setSelectedId(result.instanceId); setPage('instances');
          const cli = await api.request({ type: 'cli.select', instanceId: result.instanceId });
          if (!cli.ok) setError(cli.error); else if (cli.state) acceptState(cli.state);
        }
        if (result.removedOperations !== undefined) setNotice(t('launcher.operationsCleared', { count: result.removedOperations }));
        else if (!result.cancelled && !result.operationId && !request.type.startsWith('terminal.') && !['cli.select', 'versions.refresh', 'network.test'].includes(request.type)) setNotice(t('launcher.succeeded'));
        await refresh();
      }
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('launcher.errorFallback');
      setError(message);
      return { ok: false, error: message };
    } finally { setRequesting(false); }
  }, [api, t, acceptState, refresh]);

  const selected = state?.instances.find((instance) => instance.id === selectedId)
    ?? state?.instances.find((instance) => instance.id === state.cli?.selectedInstanceId)
    ?? state?.instances.find((instance) => instance.isDefault) ?? state?.instances[0];
  const runningOperations = state?.operations.filter((operation) => operation.status === 'running') ?? [];
  const latestFailure = notifications.failures[0];
  const selectedBusy = requesting || queuedStart === selected?.id || runningOperations.some((operation) => operation.instanceId === selected?.id);
  const disabled = requesting || !state?.supported;
  const openCreate = () => setDialog({ kind: 'create', name: t('launcher.newInstanceName'), runtimeId: state?.runtimes[0]?.id ?? '' });

  return (
    <section aria-label={t('launcher.title')} className="dsh-launcher" data-dsh-launcher>
      <header className="launcher-titlebar">
        <div className="launcher-titlebar-heading"><Icon name="box" size={19} /><strong>{t('launcher.title')}</strong><span>{t('launcher.subtitle')}</span></div>
        <Button disabled={requesting || !api} iconName="refresh" onClick={() => void refresh()} variant="quiet">{t('launcher.refresh')}</Button>
      </header>
      <div className="launcher-layout">
        <aside className="launcher-sidebar">
          <nav aria-label={t('launcher.title')} className="launcher-navigation">
            {navigation.map(item => <button aria-current={page === item.page ? 'page' : undefined} className={page === item.page ? 'is-active' : ''} key={item.page} onClick={() => setPage(item.page)} type="button"><Icon name={item.icon} size={18} /><span>{t(`launcher.${item.label}`)}</span>{item.page === 'operations' && runningOperations.length > 0 ? <span className="launcher-count">{runningOperations.length}</span> : null}</button>)}
          </nav>
          <div className="launcher-sidebar-section"><span>{t('launcher.instanceCount', { count: state?.instances.length ?? 0 })}</span><Button aria-label={t('launcher.create')} disabled={disabled || !state?.runtimes.length} iconName="plus" onClick={openCreate} size="sm" variant="quiet" /></div>
          <div aria-label={t('launcher.instances')} className="launcher-instance-list">
            {state?.instances.map((instance) => <button aria-busy={preparingCli === instance.id} aria-current={page === 'instances' && selected?.id === instance.id ? 'true' : undefined} className={`launcher-instance-item${page === 'instances' && selected?.id === instance.id ? ' is-active' : ''}`} data-dsh-instance={instance.id} key={instance.id} onClick={() => { setSelectedId(instance.id); setPage('instances'); }} type="button"><span className="launcher-instance-avatar"><Icon name="box" size={21} /></span><span className="launcher-instance-label"><strong>{instance.name}</strong><span>DSH {state.runtimes.find((runtime) => runtime.id === instance.runtimeId)?.version ?? instance.runtimeId}</span></span><span aria-label={t(preparingCli === instance.id ? 'launcher.preparingCli' : `launcher.status.${instance.status}`)} className={`launcher-status-dot is-${instance.status}${preparingCli === instance.id ? ' is-preparing' : ''}`} /></button>)}
          </div>
          <div className="launcher-sidebar-footer"><Button disabled={disabled} iconName="upload" onClick={() => setDialog({ kind: 'import', name: t('launcher.importedName') })} variant="quiet">{t('launcher.importBackup')}</Button></div>
        </aside>
        <main className="launcher-main">
          {!api || !connected ? <EmptyState icon="box" title={api && !error ? t('launcher.loading') : t('launcher.unavailable')} /> : !state?.supported ? <EmptyState icon="info" title={t('launcher.unsupported')} /> : <>
            {page === 'runtimes' ? <RuntimePage state={state} disabled={requesting} run={run} onDelete={(runtime) => setDialog({ kind: 'delete-runtime', runtime })} /> : page === 'task-access' ? <LauncherTaskAccess state={state} run={run} disabled={requesting} /> : page === 'plugin-market' || page === 'skill-market' ? <LauncherMarketplace kind={page === 'plugin-market' ? 'plugin' : 'skill'} state={state} run={run} disabled={requesting} /> : page === 'packs' ? <PackPage state={state} disabled={requesting} onDialog={setDialog} run={run} /> : page === 'operations' ? <LauncherOperationsPage state={state} disabled={requesting} run={run} /> : selected ? <InstanceDetails api={api} busy={selectedBusy} instance={selected} key={selected.id} onDialog={setDialog} onError={setError} preparingStart={queuedStart === selected.id} run={run} state={state} /> : <EmptyState icon="box" title={t('launcher.noInstances')} description={t('launcher.noInstancesDescription')}><Button iconName={state.runtimes.length ? 'plus' : 'download'} onClick={state.runtimes.length ? openCreate : () => setPage('runtimes')} variant="primary">{t(state.runtimes.length ? 'launcher.create' : 'launcher.getRuntime')}</Button></EmptyState>}
          </>}
        </main>
      </div>
      {error ? <LauncherNotification error key={`error:${error}`} message={error} onDismiss={() => setError(null)} />
        : latestFailure ? <LauncherNotification error key={latestFailure.id} message={latestFailure.error ?? operationPhase(t, latestFailure.phase)} onDismiss={() => dispatchNotification({ type: 'dismiss', operationId: latestFailure.id })} onViewOperation={() => { dispatchNotification({ type: 'dismiss', operationId: latestFailure.id }); setPage('operations'); }} operationId={latestFailure.id} title={`${latestFailure.label} · ${t(`launcher.operationStatus.${latestFailure.status}`)}`} />
          : notice ? <LauncherNotification key={`notice:${notice}`} message={notice} onDismiss={() => setNotice(null)} /> : page === 'instances' && preparingCli === selected?.id ? <LauncherNotification pending key={`cli:${preparingCli}`} message={`${selected?.name} · DSH ${state?.runtimes.find(runtime => runtime.id === selected?.runtimeId)?.version ?? ''}`} title={t('launcher.preparingCli')} onDismiss={() => undefined} /> : null}
      {dialog && state ? <LauncherDialog busy={requesting} dialog={dialog} onClose={() => setDialog(null)} onSubmit={run} runtimes={state.runtimes} /> : null}
    </section>
  );
}

function EmptyState({ icon, title, description, children }: { icon: 'box' | 'info' | 'download' | 'activity'; title: string; description?: string; children?: ReactNode }) {
  return <div className="launcher-empty"><div className="launcher-empty-icon"><Icon name={icon} size={32} /></div><h1>{title}</h1>{description ? <p>{description}</p> : null}{children}</div>;
}

function RuntimePage({ state, disabled, run, onDelete }: { state: DshLauncherState; disabled: boolean; run: LauncherRunRequest; onDelete: (runtime: DshRuntime) => void }) {
  const t = useT();
  const [view, setView] = useState<'installed' | 'catalog' | 'import'>('installed');
  return <div className="launcher-page">
    <div className="launcher-page-heading"><div><h1>{t('launcher.runtimes')}</h1><p>{t('launcher.installedRuntimeSummary', { count: state.runtimes.length, size: formatBytes(state.runtimes.reduce((sum, item) => sum + item.byteLength, 0)) })}</p></div><Button iconName="plus" onClick={() => setView('catalog')} variant="primary">{t('launcher.addRuntime')}</Button></div>
    <div className="launcher-tabs" role="tablist" aria-label={t('launcher.runtimes')}>{(['installed', 'catalog', 'import'] as const).map(tab => <button type="button" key={tab} role="tab" aria-selected={view === tab} onClick={() => setView(tab)}>{t(`launcher.runtimeViews.${tab}`)}{tab === 'installed' ? ` · ${state.runtimes.length}` : ''}</button>)}</div>
    {view === 'catalog' ? <OfficialVersionPicker state={state} run={run} disabled={disabled} onManage={() => setView('installed')} /> : null}
    {view === 'import' ?
    <section className="launcher-card launcher-acquisition"><div><h2>{t('launcher.localRuntimeImport')}</h2><p>{t('launcher.localRuntimeImportNote')}</p></div><div className="launcher-actions"><Button disabled={disabled} iconName="file" onClick={() => void run({ type: 'runtime.import', sourceKind: 'installer' })}>{t('launcher.importInstaller')}</Button><Button disabled={disabled} iconName="folder" onClick={() => void run({ type: 'runtime.import', sourceKind: 'directory' })}>{t('launcher.importDirectory')}</Button></div><details className="launcher-desktop-runtime"><summary>{t('launcher.desktopCompatibility')}</summary><div className="launcher-actions"><Button disabled={disabled} iconName="download" onClick={() => void run({ type: 'runtime.download' })}>{t('launcher.download')}</Button></div><div className="launcher-runtime-source"><span>{t('launcher.officialSource')}</span><code>{DSH_OFFICIAL_WINDOWS_URL}</code></div></details></section> : null}
    {view === 'installed' ? state.runtimes.length === 0 ? <div className="launcher-inline-empty">{t('launcher.noRuntimes')}</div> : state.runtimes.map((runtime) => {
      const count = state.instances.filter((instance) => instance.runtimeId === runtime.id).length;
      const references = runtimeReferences(state, runtime.id);
      const referenced = references.length > 0;
      const runtimeBusy = state.operations.some((operation) => operation.status === 'running' && operation.kind.startsWith('runtime.'));
      return <section className="launcher-card" data-dsh-runtime={runtime.id} key={runtime.id}><div className="launcher-card-heading"><div className="launcher-heading-icon"><Icon name="archive" size={22} /><div><h2>{t('launcher.runtimeIdentity', { version: runtime.version })}</h2><span>{t('launcher.referenced', { count })}</span></div></div><div className="launcher-actions"><Button disabled={disabled || runtimeBusy} iconName="check" onClick={() => void run({ type: 'runtime.verify', runtimeId: runtime.id })}>{t('launcher.verify')}</Button><Button disabled={disabled || referenced || runtimeBusy} iconName="trash" onClick={() => onDelete(runtime)} variant="quiet">{t('launcher.deleteRuntime')}</Button></div></div><dl className="launcher-metadata"><Meta label={t('launcher.nodeVersion')} value={runtime.nodeVersion} />{runtime.electronVersion ? <Meta label={t('launcher.electronVersion')} value={runtime.electronVersion} /> : null}{runtime.npmVersion ? <Meta label={t('launcher.npmVersion')} value={runtime.npmVersion} /> : null}<Meta label={t('launcher.installedAt')} value={formatDate(runtime.installedAt)} /><Meta label={t('launcher.storage')} value={t('launcher.files', { count: runtime.fileCount, size: formatBytes(runtime.byteLength) })} /></dl><details className="launcher-runtime-details"><summary>{t('launcher.runtimeArtifactDetails')}</summary><dl className="launcher-paths"><Meta label={t('launcher.adapter')} value={t(runtime.adapter === 'node-cli-web-v1' ? 'launcher.nodeAdapterDescription' : 'launcher.adapterDescription')} /><Meta label={t('launcher.source')} value={runtime.source} mono /><Meta label={t('launcher.sourceDigest')} value={runtime.sourceSha256} mono /><Meta label={t('launcher.contentDigest')} value={runtime.contentSha256} mono /></dl></details><RuntimeCompatibilityPanel runtime={runtime} busy={disabled || runtimeBusy} run={run} />{references.length ? <div className="launcher-runtime-references"><strong>{t('launcher.runtimeReferences')}</strong><ul>{references.map((reference, index) => <li key={index}>{t(`launcher.referenceKinds.${reference.kind}`)} - {reference.name}</li>)}</ul></div> : null}</section>;
    }) : null}
  </div>;
}

function PackPage({ state, disabled, run, onDialog }: { state: DshLauncherState; disabled: boolean; run: LauncherRunRequest; onDialog: (dialog: LauncherDialogState) => void }) {
  const t = useT();
  return <div className="launcher-page"><div className="launcher-page-heading"><div><h1>{t('launcher.packs')}</h1><p>{t('launcher.packNote')}</p></div><Button disabled={disabled} iconName="upload" onClick={() => void run({ type: 'pack.import' })} variant="primary">{t('launcher.packImport')}</Button></div><p className="launcher-help launcher-pack-help">{t('launcher.packPrivacy')}</p><PackUrlImport run={run} disabled={disabled} />{state.packs.length === 0 ? <EmptyState icon="box" title={t('launcher.noPacks')} /> : state.packs.map((pack: DshPack) => <section className="launcher-card" data-dsh-pack={pack.id} key={pack.id}><div className="launcher-card-heading"><div className="launcher-heading-icon"><Icon name="archive" size={22} /><div><h2>{pack.name} <span className="launcher-help">{pack.version}</span></h2><span>DSH {pack.runtimeVersion}</span></div></div><div className="launcher-actions"><Button disabled={disabled} iconName="plus" onClick={() => onDialog({ kind: 'pack-install', pack, name: pack.name })} variant="primary">{t('launcher.packInstall')}</Button><Button disabled={disabled} iconName="download" onClick={() => void run({ type: 'pack.export', packId: pack.id })}>{t('launcher.packExport')}</Button><Button disabled={disabled} iconName="trash" onClick={() => onDialog({ kind: 'delete-pack', pack })} variant="quiet">{t('launcher.packDelete')}</Button></div></div><dl className="launcher-metadata"><Meta label={t('launcher.createdAt')} value={formatDate(pack.createdAt)} /><Meta label={t('launcher.storage')} value={t('launcher.files', { count: pack.fileCount, size: formatBytes(pack.byteLength) })} /></dl><dl className="launcher-paths"><Meta label={t('launcher.contentDigest')} mono value={pack.contentSha256} /></dl><PackSharing pack={pack} state={state} run={run} disabled={disabled} /></section>)}</div>;
}

function operationPhase(t: TranslateFn, phase: string): string {
  const key = `launcher.phases.${phase.split(":", 1)[0]}`;
  const translated = t(key);
  return translated === key ? phase : translated;
}

export function Meta({ label, value, mono = false, children }: { readonly label: string; readonly value: ReactNode; readonly mono?: boolean; readonly children?: ReactNode }) {
  return <div><dt>{label}</dt><dd className={mono ? 'launcher-mono' : undefined}>{value}{children}</dd></div>;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function instanceCanEdit(instance: DshInstance): boolean {
  return instance.status === 'stopped' || instance.status === 'failed';
}
