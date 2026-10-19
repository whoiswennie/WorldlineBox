import { useState } from 'react';
import type { BrowserDownload, BrowserRequest } from '../../shared/browser';
import { Icon, type IconName } from '../Icons';
import { formatBytes } from '../format-file-meta';
import { Button, IconButton, Select } from '../ui';
import './browser-download-records.css';

const PAGE_SIZE = 20;
const STATUSES: BrowserDownload['status'][] = ['progressing', 'paused', 'completed', 'cancelled', 'interrupted'];
type DownloadAction = Extract<BrowserRequest, { type: 'download.action' }>;
type DownloadRequest = Extract<BrowserRequest, { type: 'download.action' | 'download.records.remove' | 'download.records.clear' }>;
const actionIcons: Record<DownloadAction['action'], IconName> = { pause: 'pause', resume: 'play', cancel: 'close', open: 'external-link', reveal: 'folder', retry: 'refresh' };
const isActive = (item: BrowserDownload) => item.status === 'progressing' || item.status === 'paused';

function downloadIcon(filename: string): IconName {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension && ['mp4', 'webm', 'mov', 'mkv'].includes(extension) ? 'video'
    : extension && ['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(extension) ? 'music'
      : extension && ['zip', '7z', 'rar', 'gz', 'tar'].includes(extension) ? 'archive' : 'file';
}

export function BrowserDownloadRecords({ downloads, run, b }: {
  downloads: readonly BrowserDownload[];
  run(request: DownloadRequest): unknown;
  b(key: string): string;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const search = query.trim().toLocaleLowerCase();
  const matches = downloads.filter(item => (status === 'all' || item.status === status)
    && (!search || [item.filename, item.url, item.error ?? '', item.status, b(item.status)]
      .some(value => value.toLocaleLowerCase().includes(search))));
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  if (page > lastPage) setPage(lastPage);
  const removable = new Set(downloads.filter(item => !isActive(item)).map(item => item.id));
  const selection = selected.filter(id => removable.has(id));
  if (selection.length !== selected.length) setSelected(selection);
  const visible = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const pageIds = visible.filter(item => !isActive(item)).map(item => item.id);
  const pageSelected = pageIds.length > 0 && pageIds.every(id => selection.includes(id));
  const activeCount = downloads.filter(isActive).length;
  const timeFormatter = new Intl.DateTimeFormat(b('downloadTimeLocale'), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const actions = (item: BrowserDownload): DownloadAction['action'][] => item.status === 'progressing'
    ? ['pause', 'cancel'] : item.status === 'paused' ? ['resume', 'cancel']
      : item.status === 'completed' ? ['open', 'reveal'] : ['retry', 'reveal'];
  const remove = async (request: Extract<DownloadRequest, { type: 'download.records.remove' | 'download.records.clear' }>) => {
    if (busy) return;
    setBusy(true);
    try { await run(request); } finally { setBusy(false); }
  };
  return <div className="browser-download-records">
    <label className="browser-bookmark-search browser-download-search"><Icon name="search" size={15} /><input
      aria-label={b('searchDownloads')} placeholder={b('searchDownloads')} type="search" value={query}
      onChange={event => { setQuery(event.target.value); setPage(0); setSelected([]); }}
    /></label>
    <div className="browser-download-filter-row">
      <Select aria-label={b('downloadStatus')} value={status} onValueChange={value => { setStatus(value); setPage(0); setSelected([]); }}
        options={[{ value: 'all', label: b('allDownloads') }, ...STATUSES.map(value => ({ value, label: b(value) }))]} />
      <Button size="sm" variant="quiet" iconName={managing ? 'check' : 'sliders'} aria-pressed={managing}
        onClick={() => { setManaging(!managing); setSelected([]); }}>{b(managing ? 'downloadManageDone' : 'downloadManage')}</Button>
      <IconButton size="sm" variant="quiet" icon={<Icon name="trash" size={15} />} disabled={!removable.size || busy}
        aria-label={b('downloadClearFinished')} title={b('downloadClearFinished')}
        onClick={() => void remove({ type: 'download.records.clear' })} />
    </div>
    <div className="browser-download-summary" role="status"><span>{b('downloadResultCount')} · {matches.length} / {downloads.length}</span>
      {activeCount ? <span className="browser-download-active-count"><i />{b('downloadActiveCount')} {activeCount}</span> : null}</div>
    {managing ? <div className="browser-download-selection">
      <label><input type="checkbox" aria-label={b('downloadSelectPage')} checked={pageSelected} disabled={!pageIds.length || busy}
        ref={node => { if (node) node.indeterminate = !pageSelected && pageIds.some(id => selection.includes(id)); }}
        onChange={() => setSelected(pageSelected ? selection.filter(id => !pageIds.includes(id)) : [...new Set([...selection, ...pageIds])])} />{b('downloadSelectPage')}</label>
      <span>{b('downloadSelected')} {selection.length}</span>
      <Button size="sm" variant="quiet" iconName="trash" disabled={!selection.length || busy}
        onClick={() => void remove({ type: 'download.records.remove', ids: selection })}>{b('downloadRemoveSelected')}</Button>
    </div> : null}
    {visible.length ? <ul className="browser-downloads">{visible.map(item => {
      const date = new Date(item.startedAt); const hasDate = Number.isFinite(date.valueOf());
      const active = isActive(item);
      return <li key={item.id} className={'browser-download-row is-' + item.status}>
        <div className="browser-download-heading">
          {managing ? <input className="browser-download-checkbox" type="checkbox" aria-label={b('downloadSelectRecord') + ': ' + item.filename}
            disabled={active || busy} checked={selection.includes(item.id)}
            onChange={() => setSelected(selection.includes(item.id) ? selection.filter(id => id !== item.id) : [...selection, item.id])} />
            : <div className="browser-download-file-icon"><Icon name={downloadIcon(item.filename)} size={18} /></div>}
          <div className="browser-download-heading-text"><strong title={item.filename}>{item.filename}</strong>
            <small className="browser-download-source" title={item.url}>{item.url}</small></div>
          {!active && !managing ? <IconButton size="sm" variant="quiet" className="browser-download-remove" icon={<Icon name="close" size={14} />}
            disabled={busy} aria-label={b('downloadRemoveRecord') + ': ' + item.filename} title={b('downloadRemoveRecord')}
            onClick={() => void remove({ type: 'download.records.remove', ids: [item.id] })} /> : null}
        </div>
        <div className="browser-download-details"><span className="browser-download-status"><i />{b(item.status)}</span>
          <span>{item.total > 0 ? formatBytes(item.received) + ' / ' + formatBytes(item.total) : item.received > 0 ? formatBytes(item.received) : b('downloadUnknownSize')}</span>
        </div>
        {active ? <progress aria-label={item.filename} max={item.total || 1} value={item.total > 0 ? Math.min(item.received, item.total) : undefined} /> : null}
        {item.error ? <p className="browser-download-error"><Icon name="alert-circle" size={13} />{item.error}</p> : null}
        <div className="browser-download-row-footer">
          {hasDate ? <time dateTime={item.startedAt} title={date.toLocaleString(b('downloadTimeLocale'))}>{timeFormatter.format(date)}</time> : <span />}
          <div className="browser-actions">{actions(item).map(action => <Button key={action} size="sm" variant="quiet" iconName={actionIcons[action]}
            data-download-action={action} disabled={busy || (action === 'reveal' && !item.path)}
            onClick={() => void run({ type: 'download.action', id: item.id, action })}>{b(action)}</Button>)}</div>
        </div>
      </li>;
    })}</ul> : <div className="browser-download-empty"><Icon name={downloads.length ? 'search' : 'download'} size={26} />
      <p>{b(downloads.length ? 'noMatchingDownloads' : 'emptyDownloads')}</p></div>}
    <nav className="browser-download-pages" aria-label={b('downloadPage')}>
      <Button size="sm" variant="quiet" iconName="chevron-left" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{b('previousPage')}</Button>
      <span>{b('downloadPage')} · {currentPage + 1} / {lastPage + 1}</span>
      <Button size="sm" variant="quiet" iconName="chevron-right" iconPosition="after" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>{b('nextPage')}</Button>
    </nav>
    <p className="browser-download-history-note">{b('downloadHistoryNote')}</p>
  </div>;
}
