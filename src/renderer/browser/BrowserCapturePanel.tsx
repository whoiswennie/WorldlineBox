import { useEffect, useEffectEvent, useId, useState, type KeyboardEvent } from 'react';

import type { BrowserCaptureJob, BrowserCapturePreferences, BrowserCaptureRequest, BrowserCaptureResponse, BrowserCaptureState } from '../../shared/browser-capture';
import { browserCaptureFolderNameSchema } from '../../shared/browser-capture';
import { Icon, type IconName } from '../Icons';
import { formatBytes } from '../format-file-meta';
import { useT } from '../i18n';
import { Button, Select, TextField } from '../ui';
import { BrowserCaptureFolders } from './BrowserCaptureFolders';
import { BrowserCaptureTextSave } from './BrowserCaptureTextSave';

import './capture-panel.css';

type CaptureTab = 'save' | 'history' | 'options';
type HistoryStatus = '' | BrowserCaptureJob['status'];
const HISTORY_PAGE_SIZE = 10;

export function BrowserCapturePanel({ capture, run, onOpenAssets, onScreenshot, documentKey }: {
  capture?: BrowserCaptureState;
  run(request: BrowserCaptureRequest): Promise<BrowserCaptureResponse | undefined>;
  onOpenAssets?(): void;
  onScreenshot?(): void;
  documentKey?: string;
}) {
  const t = useT();
  const b = (key: string) => t('browser.' + key);
  const id = useId();
  const [tab, setTab] = useState<CaptureTab>('save');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<HistoryStatus>('');
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<{ items: BrowserCaptureJob[]; total: number }>({ items: [], total: 0 });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);
  const libraryId = capture?.target?.libraryId ?? capture?.activeLibraryId;
  const library = capture?.libraries.find(item => item.libraryId === libraryId);
  const folders = capture?.folders.filter(folder => folder.libraryId === libraryId) ?? [];
  const targetFolder = folders.find(folder => folder.folderId === capture?.target?.folderId);
  const ready = Boolean(capture?.connected && library && !library.readOnly);
  const saveDisabled = busy || !ready || targetFolder?.available === false;
  const folderNameValid = browserCaptureFolderNameSchema.safeParse(folderName).success;
  const jobs = capture?.jobs ?? [];
  const activeCount = jobs.filter(job => job.status === 'saving').length;
  const latestJob = jobs[0];
  // A state response contains a fresh jobs array; track actual job changes to
  // avoid fetching again for every response to history.list itself.
  const jobRevision = jobs.map(job => [job.id, job.status, job.finishedAt, job.receivedBytes].join(':')).join('|');
  const requestHistory = useEffectEvent((request: BrowserCaptureRequest) => run(request));
  const historyFailure = useEffectEvent(() => b('captureHistoryFailed'));

  useEffect(() => {
    if (tab !== 'history') return;
    let current = true;
    const timer = setTimeout(() => {
      setHistoryLoading(true);
      setHistoryError('');
      void requestHistory({ type: 'history.list', page, pageSize: HISTORY_PAGE_SIZE, query: query.trim(), ...(status ? { status } : {}) })
        .then(result => {
          if (!current) return;
          if (result?.ok && result.history) {
            setHistory({ items: result.history.items, total: result.history.total });
            const lastPage = Math.max(1, Math.ceil(result.history.total / HISTORY_PAGE_SIZE));
            if (page > lastPage) setPage(lastPage);
          } else setHistoryError(result?.ok === false ? result.error : historyFailure());
        })
        .catch(() => { if (current) setHistoryError(historyFailure()); })
        .finally(() => { if (current) setHistoryLoading(false); });
    }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [tab, page, query, status, jobRevision, historyRevision]);

  async function perform(request: BrowserCaptureRequest) {
    setBusy(true);
    setError('');
    try {
      const result = await run(request);
      if (!result?.ok) setError(result?.error ?? b('captureSettingsFailed'));
      return result;
    } catch {
      setError(b('captureSettingsFailed'));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  function updatePreference(key: keyof BrowserCapturePreferences, checked: boolean) {
    if (!capture) return;
    void perform({ type: 'preferences.save', preferences: { ...capture.preferences, [key]: checked } });
  }

  async function createFolder() {
    if (!libraryId || !folderNameValid || saveDisabled) return;
    const result = await perform({ type: 'folder.create', target: { libraryId, folderId: capture?.target?.folderId ?? null }, name: folderName.trim() });
    if (result?.ok && result.folderId) {
      setFolderName('');
      setCreatingFolder(false);
    }
  }

  function tabKeys(event: KeyboardEvent<HTMLButtonElement>) {
    const tabs: CaptureTab[] = ['save', 'history', 'options'];
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setTab(tabs[next]!);
    (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
  }

  const action = (icon: IconName, label: string, request: BrowserCaptureRequest) => <button className="capture-action" disabled={saveDisabled} onClick={() => void perform(request)} type="button"><Icon name={icon} size={19} /><span>{b(label)}</span></button>;
  const jobStatus = (job: Pick<BrowserCaptureJob, 'status'>) => b(job.status === 'saving' ? 'captureSaving' : job.status === 'saved' ? 'captureSaved' : job.status === 'cancelled' ? 'captureCancelled' : 'captureFailed');
  const totalPages = Math.max(1, Math.ceil(history.total / HISTORY_PAGE_SIZE));

  return <div className="browser-capture browser-capture-v2" data-browser-capture>
    <div className="capture-connection"><span className={'capture-connection-dot' + (ready ? ' is-ready' : '')} /><span>{b(capture ? library?.readOnly ? 'captureReadOnlyShort' : ready ? 'captureReady' : 'captureNoLibrary' : 'captureLoading')}</span><Button iconName="refresh" variant="quiet" size="sm" aria-label={b('captureRefresh')} title={b('captureRefresh')} disabled={busy} onClick={() => void perform({ type: 'state' })} /></div>
    <div aria-label={b('captureTitle')} className="capture-tabs" role="tablist">
      {(['save', 'history', 'options'] as const).map(value => <button aria-controls={id + '-panel'} aria-selected={tab === value} id={id + '-' + value} key={value} onClick={() => setTab(value)} onKeyDown={tabKeys} role="tab" tabIndex={tab === value ? 0 : -1} type="button">{b(value === 'save' ? 'captureSaveTab' : value === 'history' ? 'captureHistoryTab' : 'captureOptionsTab')}{value === 'history' && activeCount ? <span className="capture-tab-badge">{activeCount}</span> : null}</button>)}
    </div>
    {error || capture?.error ? <p className="browser-capture-feedback is-error" role="alert">{error || capture?.error}</p> : null}
    <div aria-labelledby={id + '-' + tab} className="capture-tab-content" id={id + '-panel'} role="tabpanel">
      {tab === 'save' ? <>
        <div className="capture-action-grid">
          <button className="capture-action is-primary" disabled={busy || !onScreenshot} onClick={onScreenshot} type="button"><Icon name="camera" size={19} /><span>{b('captureScreenshot')}</span></button>
          {action('globe', 'capturePage', { type: 'page.save' })}
          <BrowserCaptureTextSave key={documentKey} disabled={saveDisabled} busy={busy} run={perform} />
          {action('file', 'captureLocalFile', { type: 'file.open' })}
        </div>
        <p className="capture-inline-hint">{b('captureMediaHint')}</p>
        {capture?.libraries.length ? <section className="capture-destination" aria-label={b('captureDestination')}>
          <Select label={b('captureLibrary')} value={libraryId ?? ''} disabled={busy} onValueChange={value => { setCreatingFolder(false); setFolderName(''); void perform({ type: 'target.set', target: { libraryId: value, folderId: null } }); }} options={capture.libraries.map(item => ({ value: item.libraryId, label: item.displayName, disabled: item.readOnly }))} />
          {library?.readOnly ? <p className="browser-help">{b('captureReadOnly')}</p> : null}
          <div className="capture-section-heading"><h3>{b('captureDestination')}</h3><Button iconName="plus" variant="quiet" size="sm" disabled={saveDisabled} onClick={() => setCreatingFolder(value => !value)}>{b('captureCreateFolder')}</Button></div>
          <p className="capture-target-path" title={targetFolder?.relativePath || b('captureRoot')}><Icon name="folder" size={14} /><span>{targetFolder?.relativePath || targetFolder?.name || b('captureRoot')}</span></p>
          {creatingFolder ? <form className="capture-folder-create" onSubmit={event => { event.preventDefault(); void createFolder(); }}>
            <TextField autoFocus aria-label={b('captureFolderName')} placeholder={b('captureFolderName')} maxLength={200} disabled={saveDisabled} value={folderName} onChange={event => setFolderName(event.target.value)} />
            <div className="browser-actions"><Button size="sm" disabled={saveDisabled || !folderNameValid} type="submit">{b('captureCreateAndSelect')}</Button><Button size="sm" variant="quiet" disabled={busy} onClick={() => { setCreatingFolder(false); setFolderName(''); }}>{b('cancel')}</Button></div>
          </form> : null}
          <BrowserCaptureFolders disabled={busy || !ready} folders={folders} onSelect={folderId => { if (libraryId) void perform({ type: 'target.set', target: { libraryId, folderId } }); }} recentFolderIds={[...capture.recentFolderIds, ...capture.recentBrowsedFolderIds]} selectedFolderId={capture.target?.folderId ?? null} />
        </section> : <div className="capture-empty"><Icon name="collection" size={24} /><p>{b('captureNoLibrary')}</p></div>}
        {latestJob ? <button className={'capture-activity-preview is-' + latestJob.status} onClick={() => setTab('history')} type="button"><Icon name={latestJob.status === 'saved' ? 'check' : latestJob.status === 'failed' ? 'alert-circle' : 'clock'} size={15} /><span><strong>{activeCount ? b('captureActiveCount') + ' ' + activeCount : jobStatus(latestJob)}</strong><span title={latestJob.filename}>{latestJob.filename || b('captureViewHistory')}</span></span><Icon name="chevron-right" size={14} /></button> : null}
        <div className="capture-footer-actions"><Button iconName="grid" size="sm" variant="quiet" disabled={busy} onClick={() => void perform({ type: 'open-assets' }).then(result => { if (result?.ok) onOpenAssets?.(); })}>{b('captureOpenAssets')}</Button><Button iconName="file" size="sm" variant="quiet" disabled={saveDisabled} onClick={() => void perform({ type: 'local.open' })}>{b('captureLocalImage')}</Button></div>
      </> : null}
      {tab === 'history' ? <section className="capture-history" aria-label={b('captureRecentSaves')}>
        <TextField aria-label={b('captureSearchHistory')} placeholder={b('captureSearchHistory')} maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} startAdornment={<Icon name="search" size={15} />} />
        <div className="capture-history-toolbar"><Select aria-label={b('captureStatusFilter')} value={status} onValueChange={value => { setStatus(value as HistoryStatus); setPage(1); }} options={[{ value: '', label: b('captureAllStatuses') }, ...(['saving', 'saved', 'failed', 'cancelled'] as const).map(value => ({ value, label: jobStatus({ status: value }) }))]} /><Button iconName="trash" size="sm" variant="quiet" disabled={busy || historyLoading || !history.total} onClick={() => void perform({ type: 'history.clear' }).then(result => { if (result?.ok) { setPage(1); setHistoryRevision(value => value + 1); } })}>{b('captureClearHistory')}</Button></div>
        <div className="capture-history-count" aria-live="polite">{historyLoading ? b('captureHistoryLoading') : b('captureRecordCount') + ' ' + history.total}</div>
        {historyError ? <p className="browser-capture-feedback is-error" role="alert">{historyError}</p> : null}
        <ol className="capture-history-list" aria-busy={historyLoading}>{history.items.map(job => <li className={'capture-history-item is-' + job.status} key={job.id}>
          <div className="capture-history-item-heading"><span className="capture-job-status">{jobStatus(job)}</span><small>{b('captureKind' + job.kind[0]!.toUpperCase() + job.kind.slice(1))}</small></div>
          <strong className="capture-job-filename" title={job.filename}>{job.filename || b('captureUnnamed')}</strong>
          <span className="capture-job-time">{Number.isFinite(Date.parse(job.startedAt)) ? new Date(job.startedAt).toLocaleString() : ''}</span>
          {job.status === 'saving' && typeof job.receivedBytes === 'number' ? <><progress aria-label={b('captureSaveProgress')} max={job.totalBytes || undefined} value={job.totalBytes ? job.receivedBytes : undefined} /><span className="capture-job-size">{formatBytes(job.receivedBytes)}{job.totalBytes ? ' / ' + formatBytes(job.totalBytes) : ''}</span></> : null}
          {job.message || job.deduplicated ? <details className="capture-job-details"><summary>{b('captureRecordDetails')}</summary>{job.message ? <p>{job.message}</p> : null}{job.deduplicated ? <p>{b('captureDeduplicated')}</p> : null}</details> : null}
          {job.status === 'saving' ? <Button size="sm" variant="quiet" disabled={busy} onClick={() => void perform({ type: 'cancel', id: job.id })}>{b('cancel')}</Button> : null}
        </li>)}</ol>
        {!historyLoading && !history.items.length ? <div className="capture-empty"><Icon name="clock" size={24} /><p>{b(query || status ? 'captureNoMatchingRecords' : 'captureNoRecords')}</p></div> : null}
        <nav className="capture-pagination" aria-label={b('captureHistoryPagination')}><Button iconName="chevron-left" size="sm" variant="quiet" aria-label={b('previousPage')} disabled={historyLoading || page <= 1} onClick={() => setPage(value => value - 1)} /><span>{page} / {totalPages}</span><Button iconName="chevron-right" size="sm" variant="quiet" aria-label={b('nextPage')} disabled={historyLoading || page >= totalPages} onClick={() => setPage(value => value + 1)} /></nav>
      </section> : null}
      {tab === 'options' ? <>
        <fieldset className="browser-capture-settings" disabled={busy || !capture}><legend>{b('captureSettings')}</legend>{([
          ['notificationsEnabled', 'captureNotifications'], ['focusAppAfterSave', 'captureFocusApp'], ['revealInLibrary', 'captureReveal'], ['dragRadialMenuEnabled', 'captureDragMenu'],
        ] as const).map(([key, label]) => <label key={key}><input checked={capture?.preferences[key] ?? true} onChange={event => updatePreference(key, event.target.checked)} type="checkbox" /><span>{b(label)}</span></label>)}</fieldset>
        <section className="capture-help"><h3>{b('captureHowTitle')}</h3><p>{b('captureHowContext')}</p><p>{b('captureHowDrag')}</p><p>{b('capturePageHint')}</p><p>{b('captureTargetHint')}</p></section>
        <p className="capture-inline-hint">{b('captureBuiltIn')}</p>
      </> : null}
    </div>
  </div>;
}
