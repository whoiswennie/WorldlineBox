import { useState } from 'react';

import type { BrowserCapturePreferences, BrowserCaptureRequest, BrowserCaptureResponse, BrowserCaptureState } from '../../shared/browser-capture';
import { Icon } from '../Icons';
import { formatBytes } from '../format-file-meta';
import { useT } from '../i18n';
import { Button, Select } from '../ui';
import { BrowserCaptureFolders } from './BrowserCaptureFolders';

export function BrowserCapturePanel({ capture, run, onOpenAssets }: {
  capture?: BrowserCaptureState;
  run(request: BrowserCaptureRequest): Promise<BrowserCaptureResponse | undefined>;
  onOpenAssets?(): void;
}) {
  const t = useT();
  const b = (key: string) => t('browser.' + key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const libraryId = capture?.target?.libraryId ?? capture?.activeLibraryId;
  const library = capture?.libraries.find(item => item.libraryId === libraryId);
  const folders = capture?.folders.filter(folder => folder.libraryId === libraryId) ?? [];
  const targetFolder = folders.find(folder => folder.folderId === capture?.target?.folderId);
  const ready = Boolean(capture?.connected && library && !library.readOnly);
  const saveDisabled = busy || !ready;

  async function perform(request: BrowserCaptureRequest) {
    setBusy(true);
    setError('');
    try {
      const result = await run(request);
      if (!result?.ok) setError(result?.error ?? b('captureSettingsFailed'));
      return result?.ok === true;
    } finally {
      setBusy(false);
    }
  }

  function updatePreference(key: keyof BrowserCapturePreferences, checked: boolean) {
    if (!capture) return;
    void perform({ type: 'preferences.save', preferences: { ...capture.preferences, [key]: checked } });
  }

  return <div className="browser-capture" data-browser-capture>
    <p className="browser-capture-built-in">{b('captureBuiltIn')}</p>
    <div className="browser-capture-library">
      <Icon name="collection" size={20} />
      <div><strong>{library?.displayName ?? b(capture ? 'captureNoLibrary' : 'captureLoading')}</strong><span>{library?.readOnly ? b('captureReadOnly') : ready ? b('captureReady') : b('captureNoLibrary')}</span></div>
    </div>
    <div className="browser-actions">
      <Button iconName="file" size="sm" disabled={saveDisabled} onClick={() => void perform({ type: 'local.open' })}>{b('captureLocalImage')}</Button>
      <Button iconName="grid" size="sm" disabled={busy} onClick={() => void perform({ type: 'open-assets' }).then(ok => { if (ok) onOpenAssets?.(); })}>{b('captureOpenAssets')}</Button>
      <Button iconName="refresh" variant="quiet" size="sm" aria-label={b('captureRefresh')} title={b('captureRefresh')} disabled={busy} onClick={() => void perform({ type: 'state' })} />
    </div>
    {capture?.libraries.length ? <section className="browser-capture-section">
      <Select label={b('captureLibrary')} value={libraryId ?? ''} disabled={busy} onValueChange={id => void perform({ type: 'target.set', target: { libraryId: id, folderId: null } })} options={capture.libraries.map(item => ({ value: item.libraryId, label: item.displayName, disabled: item.readOnly }))} />
      <h3>{b('captureDestination')}{targetFolder ? ' · ' + (targetFolder.relativePath || targetFolder.name) : ' · ' + b('captureRoot')}</h3>
      <BrowserCaptureFolders
        disabled={saveDisabled}
        folders={folders}
        onSelect={folderId => { if (libraryId) void perform({ type: 'target.set', target: { libraryId, folderId } }); }}
        recentFolderIds={[...capture.recentFolderIds, ...capture.recentBrowsedFolderIds]}
        selectedFolderId={capture.target?.folderId ?? null}
      />
      <p className="browser-help">{b('captureTargetHint')}</p>
    </section> : null}
    <section className="browser-capture-section">
      <h3>{b('captureHowTitle')}</h3>
      <p className="browser-help">{b('captureHowContext')}</p>
      <p className="browser-help">{b('captureHowDrag')}</p>
    </section>
    <fieldset className="browser-capture-settings" disabled={busy || !capture}>
      <legend>{b('captureSettings')}</legend>
      {([
        ['notificationsEnabled', 'captureNotifications'],
        ['focusAppAfterSave', 'captureFocusApp'],
        ['revealInLibrary', 'captureReveal'],
        ['dragRadialMenuEnabled', 'captureDragMenu'],
      ] as const).map(([key, label]) => <label key={key}><input checked={capture?.preferences[key] ?? true} onChange={event => updatePreference(key, event.target.checked)} type="checkbox" /><span>{b(label)}</span></label>)}
    </fieldset>
    {error || capture?.error ? <p className="browser-capture-feedback is-error" role="alert">{error || capture?.error}</p> : null}
    {capture?.jobs.length ? <section className="browser-capture-section" aria-label={b('captureRecentSaves')} aria-live="polite">
      <h3>{b('captureRecentSaves')}</h3>
      {capture.jobs.slice(0, 6).map(job => <div className={'browser-capture-feedback' + (job.status === 'failed' ? ' is-error' : '')} key={job.id}>
        <strong>{b(job.status === 'saving' ? 'captureSaving' : job.status === 'saved' ? 'captureSaved' : job.status === 'cancelled' ? 'captureCancelled' : 'captureFailed')}{job.filename ? ' · ' + job.filename : ''}</strong>
        {job.message ? <span>{job.message}</span> : null}
        {job.deduplicated ? <span>{b('captureDeduplicated')}</span> : null}
        {job.status === 'saving' && typeof job.receivedBytes === 'number' ? <span>{formatBytes(job.receivedBytes)}{job.totalBytes ? ' / ' + formatBytes(job.totalBytes) : ''}</span> : null}
        {job.status === 'saving' ? <Button size="sm" variant="quiet" disabled={busy} onClick={() => void perform({ type: 'cancel', id: job.id })}>{b('cancel')}</Button> : null}
      </div>)}
    </section> : null}
  </div>;
}
