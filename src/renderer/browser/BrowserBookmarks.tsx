import { useState } from 'react';
import type { BrowserBookmark, BrowserRequest, BrowserResponse, BrowserTab } from '../../shared/browser';
import { Icon } from '../Icons';
import { useT } from '../i18n';
import { Button, TextField } from '../ui';

function siteHost(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }
export function SiteMark({ url }: { url: string }) {
  const host = siteHost(url);
  const known = host === 'bilibili.com' ? ['bilibili', '哔'] : host === 'pixiv.net' ? ['pixiv', 'P'] : host === 'github.com' ? ['github', 'G'] : host === 'bing.com' ? ['bing', 'b'] : ['generic', host[0]?.toUpperCase() || '↗'];
  return <span className={'browser-site-mark is-' + known[0]} aria-hidden="true">{known[1]}</span>;
}

export function BrowserBookmarks({ bookmarks, tab, navigate, run }: {
  bookmarks: BrowserBookmark[]; tab?: BrowserTab; navigate(url: string): void;
  run(request: BrowserRequest): Promise<BrowserResponse | undefined>;
}) {
  const t = useT(); const b = (key: string) => t('browser.' + key);
  const [query, setQuery] = useState(''); const [folder, setFolder] = useState(''); const [shown, setShown] = useState(100);
  const [editing, setEditing] = useState<string | null | undefined>(); const [title, setTitle] = useState(''); const [destination, setDestination] = useState(''); const [saving, setSaving] = useState(false);
  const current = bookmarks.find(item => item.url === tab?.url);
  const folders = [...new Set(bookmarks.map(item => item.folder).filter(Boolean))].sort();
  const filtered = bookmarks.filter(item => (!folder || item.folder === folder) && (item.title + ' ' + item.url + ' ' + item.folder).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const edit = (bookmark?: BrowserBookmark) => { setEditing(bookmark?.id ?? null); setTitle(bookmark?.title ?? tab?.title ?? ''); setDestination(bookmark?.folder ?? ''); };
  const save = async () => {
    setSaving(true);
    try { const result = await run({ type: 'bookmark.save', ...(editing ? { id: editing } : {}), title: title.trim(), folder: destination.trim() }); if (result?.ok) setEditing(undefined); }
    finally { setSaving(false); }
  };
  return <div className="browser-bookmarks">
    <div className="browser-bookmark-summary"><span>{bookmarks.length} {b('savedSites')}</span><Button size="sm" iconName={current ? 'edit' : 'plus'} variant="quiet" disabled={!tab?.url.startsWith('http')} onClick={() => edit(current)}>{b(current ? 'editCurrentBookmark' : 'addCurrentBookmark')}</Button></div>
    {editing !== undefined ? <form className="browser-bookmark-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <strong>{b(editing ? 'editBookmark' : 'addBookmark')}</strong><p>{siteHost(editing ? bookmarks.find(item => item.id === editing)?.url ?? '' : tab?.url ?? '')}</p>
      <TextField label={b('bookmarkTitle')} maxLength={500} autoFocus value={title} onChange={event => setTitle(event.target.value)} />
      <TextField label={b('folder')} maxLength={100} placeholder={b('folderOptional')} value={destination} onChange={event => setDestination(event.target.value)} />
      <div className="browser-actions"><Button type="submit" variant="primary" size="sm" loading={saving} disabled={!title.trim() || saving}>{b('save')}</Button><Button size="sm" variant="quiet" disabled={saving} onClick={() => setEditing(undefined)}>{b('cancel')}</Button></div>
    </form> : null}
    <label className="browser-bookmark-search"><Icon name="search" size={15} /><input aria-label={b('searchBookmarks')} placeholder={b('searchBookmarks')} value={query} onChange={event => { setQuery(event.target.value); setShown(100); }} /></label>
    {folders.length ? <div className="browser-bookmark-folders"><button aria-pressed={!folder} onClick={() => { setFolder(''); setShown(100); }}>{b('allBookmarks')}</button>{folders.map(name => <button key={name} aria-pressed={folder === name} onClick={() => { setFolder(name); setShown(100); }}><Icon name="folder" size={12} />{name}</button>)}</div> : null}
    <ul className="browser-bookmark-list">{filtered.slice(0, shown).map(item => <li key={item.id}>
      <button className="browser-bookmark-link" title={item.url} onClick={() => navigate(item.url)}><SiteMark url={item.url} /><span><strong>{item.title}</strong><small>{siteHost(item.url)}{item.folder ? ' · ' + item.folder : ''}</small></span></button>
      <div className="browser-bookmark-row-actions"><Button aria-label={b('editBookmark') + ' ' + item.title} iconName="edit" size="sm" variant="quiet" onClick={() => edit(item)} /><Button aria-label={b('remove') + ' ' + item.title} iconName="trash" size="sm" variant="quiet" onClick={() => void run({ type: 'bookmark.remove', id: item.id })} /></div>
    </li>)}</ul>
    {!filtered.length ? <div className="browser-bookmark-empty"><Icon name="star" size={24} /><p>{b(bookmarks.length ? 'noMatchingBookmarks' : 'emptyBookmarks')}</p></div> : null}
    {filtered.length > shown ? <Button size="sm" onClick={() => setShown(value => value + 100)}>{b('showMore')}</Button> : null}
  </div>;
}
