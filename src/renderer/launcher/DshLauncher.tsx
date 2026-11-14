import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';

import {
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
import { PackSharing, PackUrlImport } from './PackSharing';
import { runtimeReferences } from '../../shared/dsh-runtime-references';
import './launcher.css';

export type LauncherRunRequest = (request: DshLauncherRequest) => Promise<DshLauncherResponse>;
type LauncherPage = 'instances' | 'runtimes' | 'packs' | 'operations' | 'archived';
const applications = [
  { id: 'dsh', label: 'launcher.dshApp', description: 'launcher.dshAppSummary', icon: 'box' },
  { id: 'cabin', label: 'launcher.cabin', description: 'launcher.cabinAppSummary', icon: 'globe' },
] as const satisfies ReadonlyArray<{ id: string; label: string; description: string; icon: IconName }>;
type LauncherApplication = typeof applications[number]['id'];
const navigation: readonly { page: LauncherPage; label: string; icon: IconName }[] = [
  { page: 'instances', label: 'instances', icon: 'box' }, { page: 'runtimes', label: 'runtimes', icon: 'download' },
  { page: 'packs', label: 'packs', icon: 'archive' },
  { page: 'operations', label: 'operations', icon: 'activity' },
];

export function DshLauncher({ api }: { readonly api?: WorldlineBoxDshLauncherApi }): ReactNode {
  const t = useT();
  const [state, setState] = useState<DshLauncherState | null>(null);
  const [page, setPage] = useState<LauncherPage>('instances');
  const [application, setApplication] = useState<LauncherApplication>('dsh');
  const [runtimeView, setRuntimeView] = useState<RuntimeView>('installed');
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
    dispatchNotification({ type: 'observe', operations: next.operations.filter(operation => operation.kind !== 'versions.refresh') });
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
    if (request.type === 'versions.refresh') {
      try { return await api.request(request); }
      catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }; }
    }
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
    if (['pack.inspect-url', 'instance.open'].includes(request.type)) {
      try {
        const result = await api.request(request);
        if (!result.ok) setError(result.error);
        return result;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : t('launcher.errorFallback');
        setError(message); return { ok: false, error: message };
      }
    }
    if (request.type === 'instance.start' && cliRequest.current?.instanceId === request.instanceId) {
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
          setSelectedId(result.instanceId); setApplication('dsh'); setPage('instances');
          const cli = await api.request({ type: 'cli.select', instanceId: result.instanceId });
          if (!cli.ok) setError(cli.error); else if (cli.state) acceptState(cli.state);
        }
        if (result.removedOperations !== undefined) setNotice(t('launcher.operationsCleared', { count: result.removedOperations }));
        else if (!result.cancelled && !result.operationId && !request.type.startsWith('terminal.') && !['cli.select', 'network.test'].includes(request.type)) setNotice(t('launcher.succeeded'));
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
  const openVersions = () => { setRuntimeView('catalog'); setPage('runtimes'); };

  return (
    <section aria-label={t('launcher.title')} className="dsh-launcher" data-dsh-launcher>
      <header className="launcher-titlebar">
        <div className="launcher-titlebar-heading"><Icon name="box" size={19} /><strong>{t('launcher.title')}</strong></div>
        <Button disabled={requesting || !api} iconName="refresh" onClick={() => void refresh()} variant="quiet">{t('launcher.refresh')}</Button>
      </header>
      <div className="launcher-layout">
        <aside className="launcher-sidebar">
          <h2>{t('launcher.applications')}</h2>
          <nav aria-label={t('launcher.applications')} className="launcher-app-list">
            {applications.map(item => <button key={item.id} type="button" aria-label={t(item.label)} aria-current={application === item.id ? 'page' : undefined}
              className="launcher-app-item" onClick={() => setApplication(item.id)}>
              <span className="launcher-app-icon"><Icon name={item.icon} size={20} /></span>
              <span className="launcher-app-label"><strong>{t(item.label)}</strong><span>{t(item.description)}</span></span>
            </button>)}
          </nav>
        </aside>
        <main className="launcher-main">
          {!api || !connected ? <EmptyState icon="box" title={api && !error ? t('launcher.loading') : t('launcher.unavailable')} /> : !state?.supported ? <EmptyState icon="info" title={t('launcher.unsupported')} /> : <>
            {application === 'cabin' ? <CabinPage api={api} run={run} busy={requesting} /> : <div className="launcher-dsh-workspace">
              <nav aria-label={t('launcher.dshManagement')} className="launcher-navigation">
                {navigation.map(item => <button aria-current={page === item.page ? 'page' : undefined} className={page === item.page ? 'is-active' : ''} key={item.page} onClick={() => setPage(item.page)} type="button"><Icon name={item.icon} size={16} /><span>{t(`launcher.${item.label}`)}</span>{item.page === 'operations' && runningOperations.length > 0 ? <span className="launcher-count">{runningOperations.length}</span> : null}</button>)}
                {page === 'archived' || !!state.archivedInstances?.length ? <button aria-current={page === 'archived' ? 'page' : undefined} className={page === 'archived' ? 'is-active' : ''} onClick={() => setPage('archived')} type="button"><Icon name="archive" size={16} />{t('launcher.archivedInstances')}</button> : null}
              </nav>
              {page === 'instances' && <div className="launcher-instance-toolbar">
                {selected && <label>
                  <span>{t('launcher.instanceSelection')}</span>
                  <select value={selected.id} onChange={event => setSelectedId(event.target.value)}>
                    {state.instances.map(instance => <option key={instance.id} value={instance.id}>{instance.name}</option>)}
                  </select>
                </label>}
                <div className="launcher-actions">
                  {selected && <Button disabled={disabled || !state.runtimes.length} iconName="plus" onClick={openCreate} size="sm" variant="quiet">{t('launcher.create')}</Button>}
                  <Button disabled={disabled} iconName="upload" onClick={() => setDialog({ kind: 'import', name: t('launcher.importedName') })} size="sm" variant="quiet">{t('launcher.importBackup')}</Button>
                </div>
              </div>}
              {page === 'runtimes' ? <RuntimePage state={state} disabled={requesting} run={run} view={runtimeView} setView={setRuntimeView} instance={selected} onDelete={(runtime) => setDialog({ kind: 'delete-runtime', runtime })} onUpgrade={setDialog} />
              : page === 'packs' ? <PackPage state={state} disabled={requesting} onDialog={setDialog} run={run} />
              : page === 'operations' ? <LauncherOperationsPage state={state} disabled={requesting} run={run} />
              : page === 'archived' ? <ArchivedInstances state={state} disabled={requesting} run={run} onOpenVersions={openVersions} onDelete={instance => setDialog({ kind: 'delete-instance', instance })} />
              : selected ? <InstanceDetails api={api} busy={selectedBusy} instance={selected} key={selected.id} onDialog={setDialog} onError={setError} onOpenVersions={openVersions} preparingStart={queuedStart === selected.id} run={run} state={state} />
              : <EmptyState icon="box" title={t('launcher.noInstances')} description={t('launcher.noInstancesDescription')}><Button disabled={disabled} iconName={state.runtimes.length ? 'plus' : 'download'} onClick={state.runtimes.length ? openCreate : openVersions} variant="primary">{t(state.runtimes.length ? 'launcher.create' : 'launcher.getRuntime')}</Button></EmptyState>}
            </div>}
          </>}
        </main>
      </div>
      {error ? <LauncherNotification error key={`error:${error}`} message={error} onDismiss={() => setError(null)} />
        : latestFailure ? <LauncherNotification error key={latestFailure.id} message={latestFailure.error ?? operationPhase(t, latestFailure.phase)} onDismiss={() => dispatchNotification({ type: 'dismiss', operationId: latestFailure.id })} onViewOperation={() => { dispatchNotification({ type: 'dismiss', operationId: latestFailure.id }); setApplication('dsh'); setPage('operations'); }} operationId={latestFailure.id} title={`${latestFailure.label} · ${t(`launcher.operationStatus.${latestFailure.status}`)}`} />
          : notice ? <LauncherNotification key={`notice:${notice}`} message={notice} onDismiss={() => setNotice(null)} /> : application === 'dsh' && page === 'instances' && preparingCli === selected?.id ? <LauncherNotification pending key={`cli:${preparingCli}`} message={`${selected?.name} · DSH ${state?.runtimes.find(runtime => runtime.id === selected?.runtimeId)?.version ?? ''}`} title={t('launcher.preparingCli')} onDismiss={() => undefined} /> : null}
      {dialog && state ? <LauncherDialog busy={requesting} dialog={dialog} key={dialog.kind} onClose={() => setDialog(null)} onBackup={instance => setDialog({ kind: 'export', instance })} onSubmit={run} runtimes={state.runtimes} /> : null}
    </section>
  );
}

function CabinPage({ api, run, busy }: { api: WorldlineBoxDshLauncherApi; run: LauncherRunRequest; busy: boolean }) {
  const t = useT();
  const [cabin, setCabin] = useState<Extract<DshLauncherResponse, { ok: true }>['cabin']>();
  useEffect(() => {
    let live = true;
    const update = () => void api.request({ type: 'cabin.state' }).then(result => { if (live && result.ok) setCabin(result.cabin); }).catch(() => undefined);
    update();
    const timer = window.setInterval(update, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [api]);
  const control = async (type: 'cabin.open' | 'cabin.stop') => {
    const result = await run({ type });
    if (result.ok) setCabin(result.cabin);
  };
  const status = !cabin ? 'loading' : cabin.running ? 'cabinRunning' : cabin.available ? 'cabinStopped' : 'cabinUnavailable';
  return <div className="launcher-page">
    <div className="launcher-page-heading"><div><h1>{t('launcher.cabin')}</h1><p>{t('launcher.cabinDescription')}</p></div></div>
    <section className="launcher-card launcher-cabin-card">
      <div className="launcher-cabin-status" role="status">
        <span className={`launcher-status-dot${cabin?.running ? ' is-running' : ''}`} />
        {cabin?.version && <>{cabin.version}<span aria-hidden="true">·</span></>}
        {t(`launcher.${status}`)}
      </div>
      <div className="launcher-actions">
        <Button variant="primary" iconName={cabin?.running ? 'link' : 'play'} disabled={busy || !cabin?.available} onClick={() => void control('cabin.open')}>{t(cabin?.running ? 'launcher.cabinConnect' : 'launcher.cabinOpen')}</Button>
        <Button iconName="stop" disabled={busy || !cabin?.running} onClick={() => void control('cabin.stop')}>{t('launcher.cabinStop')}</Button>
      </div>
    </section>
  </div>;
}

function EmptyState({ icon, title, description, children }: { icon: 'box' | 'info' | 'download' | 'activity' | 'archive'; title: string; description?: string; children?: ReactNode }) {
  return <div className="launcher-empty"><div className="launcher-empty-icon"><Icon name={icon} size={32} /></div><h1>{title}</h1>{description ? <p>{description}</p> : null}{children}</div>;
}

function ArchivedInstances({ state, disabled, run, onOpenVersions, onDelete }: { state: DshLauncherState; disabled: boolean; run: LauncherRunRequest; onOpenVersions: () => void; onDelete: (instance: DshInstance) => void }) {
  const t = useT();
  return <div className="launcher-page">
    <div className="launcher-page-heading"><div><h1>{t('launcher.archivedInstances')}</h1><p>{t('launcher.archivedInstancesDescription')}</p></div></div>
    {state.archivedInstances?.length ? state.archivedInstances.map(instance => {
      const available = state.runtimes.some(runtime => runtime.id === instance.runtimeId || runtime.version === instance.runtimeVersion);
      const busy = disabled || state.operations.some(operation => operation.status === 'running' && operation.instanceId === instance.id);
      return <section className="launcher-card" key={instance.id} data-dsh-archived-instance={instance.id}>
        <div className="launcher-card-heading"><div><h2>{instance.name}</h2><p>DSH {instance.runtimeVersion} · {formatDate(instance.archivedAt)}</p></div>
          <div className="launcher-actions">
            {!instance.purgePending && (available ? <Button disabled={busy} iconName="undo" onClick={() => void run({ type: 'instance.unarchive', instanceId: instance.id })}>{t('launcher.unarchiveInstance')}</Button>
              : <Button disabled={busy} onClick={onOpenVersions}>{t('launcher.getRuntime')}</Button>)}
            <Button disabled={busy} iconName="trash" onClick={() => onDelete(instance)} variant="quiet">{t('launcher.deleteInstancePermanently')}</Button>
          </div>
        </div>
        {instance.purgePending ? <p className="launcher-help" role="status">{t('launcher.archivePurgePending')}</p> : !available ? <p className="launcher-help">{t('launcher.archiveNeedsRuntime', { version: instance.runtimeVersion })}</p> : null}
      </section>;
    }) : <EmptyState icon="archive" title={t('launcher.noArchivedInstances')} />}
  </div>;
}

type RuntimeView = 'installed' | 'catalog' | 'import';
function RuntimePage({ state, disabled, run, instance, onDelete, onUpgrade, view, setView }: { state: DshLauncherState; disabled: boolean; run: LauncherRunRequest; instance?: DshInstance; onDelete: (runtime: DshRuntime) => void; onUpgrade: (dialog: LauncherDialogState) => void; view: RuntimeView; setView: (view: RuntimeView) => void }) {
  const t = useT();
  return <div className="launcher-page">
    <div className="launcher-page-heading"><div><h1>{t('launcher.runtimes')}</h1><p>{t('launcher.installedRuntimeSummary', { count: state.runtimes.length, size: formatBytes(state.runtimes.reduce((sum, item) => sum + item.byteLength, 0)) })}</p></div><Button iconName="plus" onClick={() => setView('catalog')} variant="primary">{t('launcher.addRuntime')}</Button></div>
    <div className="launcher-tabs" role="tablist" aria-label={t('launcher.runtimes')}>{(['installed', 'catalog', 'import'] as const).map(tab => <button type="button" key={tab} role="tab" aria-selected={view === tab} onClick={() => setView(tab)}>{t(`launcher.runtimeViews.${tab}`)}{tab === 'installed' ? ` · ${state.runtimes.length}` : ''}</button>)}</div>
    {view === 'installed' && state.pendingRuntimeDeletions?.length ? <p className="launcher-runtime-cleanup-status" role="status">
      <Icon name="clock" size={16} />{t('launcher.runtimeCleanupPending', { versions: state.pendingRuntimeDeletions.join(', ') })}
    </p> : null}
    {view === 'catalog' ? <OfficialVersionPicker state={state} run={run} disabled={disabled} instance={instance} onManage={() => setView('installed')} onUpgrade={onUpgrade} /> : null}
    {view === 'import' ?
    <section className="launcher-card launcher-acquisition"><div><h2>{t('launcher.localRuntimeImport')}</h2><p>{t('launcher.localRuntimeImportNote')}</p></div><div className="launcher-actions"><Button disabled={disabled} iconName="folder" onClick={() => void run({ type: 'runtime.import', sourceKind: 'directory' })}>{t('launcher.importDirectory')}</Button></div></section> : null}
    {view === 'installed' ? state.runtimes.length === 0 ? <div className="launcher-inline-empty">{t('launcher.noRuntimes')}</div> : state.runtimes.map((runtime) => {
      const count = state.instances.filter((instance) => instance.runtimeId === runtime.id).length;
      const references = runtimeReferences(state, runtime.id);
      const referenced = references.length > 0;
      const runtimeBusy = state.operations.some((operation) => operation.status === 'running' && operation.kind.startsWith('runtime.'));
      return <section className="launcher-card" data-dsh-runtime={runtime.id} key={runtime.id}><div className="launcher-card-heading"><div className="launcher-heading-icon"><Icon name="archive" size={22} /><div><h2>{t('launcher.runtimeIdentity', { version: runtime.version })}</h2><span>{t('launcher.referenced', { count })}</span></div></div><div className="launcher-actions"><Button disabled={disabled || runtimeBusy} iconName="check" onClick={() => void run({ type: 'runtime.verify', runtimeId: runtime.id })}>{t('launcher.verify')}</Button><Button disabled={disabled || referenced || runtimeBusy} iconName="trash" onClick={() => onDelete(runtime)} variant="quiet">{t('launcher.deleteRuntime')}</Button></div></div><dl className="launcher-metadata"><Meta label={t('launcher.nodeVersion')} value={runtime.nodeVersion} />{runtime.npmVersion ? <Meta label={t('launcher.npmVersion')} value={runtime.npmVersion} /> : null}<Meta label={t('launcher.installedAt')} value={formatDate(runtime.installedAt)} /><Meta label={t('launcher.storage')} value={t('launcher.files', { count: runtime.fileCount, size: formatBytes(runtime.byteLength) })} /></dl><details className="launcher-runtime-details"><summary>{t('launcher.runtimeArtifactDetails')}</summary><dl className="launcher-paths"><Meta label={t('launcher.adapter')} value={t('launcher.nodeAdapterDescription')} /><Meta label={t('launcher.source')} value={runtime.source} mono /><Meta label={t('launcher.sourceDigest')} value={runtime.sourceSha256} mono /><Meta label={t('launcher.contentDigest')} value={runtime.contentSha256} mono /></dl></details>{references.length ? <div className="launcher-runtime-references"><strong>{t('launcher.runtimeReferences')}</strong><ul>{references.map((reference, index) => <li key={index}>{t(`launcher.referenceKinds.${reference.kind}`)} - {reference.name}</li>)}</ul></div> : null}</section>;
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
