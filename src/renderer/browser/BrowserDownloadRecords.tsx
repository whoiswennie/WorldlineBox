import { useState } from 'react';
import type { BrowserDownload, BrowserRequest } from '../../shared/browser';
import { Icon } from '../Icons';
import { formatBytes } from '../format-file-meta';
import { Button, Select } from '../ui';
import './browser-download-records.css';

const PAGE_SIZE = 20;
const STATUSES: BrowserDownload['status'][] = ['progressing', 'paused', 'completed', 'cancelled', 'interrupted'];
type DownloadAction = Extract<BrowserRequest, { type: 'download.action' }>;

export function BrowserDownloadRecords({ downloads, run, b }: {
  downloads: readonly BrowserDownload[];
  run(request: DownloadAction): unknown;
  b(key: string): string;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const search = query.trim().toLocaleLowerCase();
  const matches = downloads.filter(item => (status === 'all' || item.status === status)
    && (!search || [item.filename, item.url, item.error ?? '', item.status, b(item.status)]
      .some(value => value.toLocaleLowerCase().includes(search))));
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  // Completed records can disappear while this panel is open after a data
  // clear. Keep both the displayed page and the next user action in range.
  if (page > lastPage) setPage(lastPage);
  const visible = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const actions = (item: BrowserDownload): DownloadAction['action'][] => item.status === 'progressing'
    ? ['pause', 'cancel'] : item.status === 'paused' ? ['resume', 'cancel']
      : item.status === 'completed' ? ['open', 'reveal'] : ['retry', 'reveal'];
  return <div className="browser-download-records">
    <label className="browser-bookmark-search"><Icon name="search" size={15} /><input
      aria-label={b('searchDownloads')} placeholder={b('searchDownloads')} type="search" value={query}
      onChange={event => { setQuery(event.target.value); setPage(0); }}
    /></label>
    <Select label={b('downloadStatus')} value={status} onValueChange={value => { setStatus(value); setPage(0); }}
      options={[{ value: 'all', label: b('allDownloads') }, ...STATUSES.map(value => ({ value, label: b(value) }))]} />
    <div className="browser-download-summary" role="status">{b('downloadResultCount')} · {matches.length} / {downloads.length}</div>
    {visible.length ? <ul className="browser-downloads">{visible.map(item => <li key={item.id}>
      <strong>{item.filename}</strong>
      <span>{b(item.status)} · {formatBytes(item.received)}{item.total ? ' / ' + formatBytes(item.total) : ''}</span>
      <small className="browser-download-source" title={item.url}>{item.url}</small>
      {item.total > 0 ? <progress aria-label={item.filename} max={item.total} value={item.received} /> : null}
      {item.error ? <p className="browser-help">{item.error}</p> : null}
      <div className="browser-actions">{actions(item).map(action => <Button key={action} size="sm"
        onClick={() => void run({ type: 'download.action', id: item.id, action })}>{b(action)}</Button>)}</div>
    </li>)}</ul> : <p className="browser-help">{b(downloads.length ? 'noMatchingDownloads' : 'emptyDownloads')}</p>}
    <nav className="browser-download-pages" aria-label={b('downloadPage')}>
      <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{b('previousPage')}</Button>
      <span>{b('downloadPage')} · {currentPage + 1} / {lastPage + 1}</span>
      <Button size="sm" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>{b('nextPage')}</Button>
    </nav>
  </div>;
}
