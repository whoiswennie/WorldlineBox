import { useMemo, useState } from 'react';

import { buildFolderTree, type FolderNode } from '../../../extension/radial-menu-model';
import type { BrowserCaptureFolder } from '../../shared/browser-capture';
import { Icon } from '../Icons';
import { useT } from '../i18n';

/** Native disclosure controls keep the full folder hierarchy usable without
 * opening a popover over the browser's WebContentsView. */
export function BrowserCaptureFolders({ folders, recentFolderIds, selectedFolderId, disabled, onSelect }: {
  folders: readonly BrowserCaptureFolder[];
  recentFolderIds: readonly string[];
  selectedFolderId: string | null;
  disabled: boolean;
  onSelect(folderId: string | null): void;
}) {
  const t = useT();
  const b = (key: string) => t('browser.' + key);
  const [query, setQuery] = useState('');
  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const byId = useMemo(() => new Map(folders.map(folder => [folder.folderId, folder])), [folders]);
  const recent = [...new Set(recentFolderIds)].flatMap(id => {
    const folder = byId.get(id);
    return folder ? [folder] : [];
  }).slice(0, 6);
  const search = query.trim().toLocaleLowerCase();
  const matches = search ? folders.filter(folder => (folder.relativePath || folder.name).toLocaleLowerCase().includes(search)) : [];
  const folderButton = (folderId: string | null, name: string, path: string) => <button
    aria-label={b('captureSelectFolder') + ' ' + path}
    aria-pressed={selectedFolderId === folderId}
    className="browser-capture-folder"
    disabled={disabled || (folderId !== null && byId.get(folderId)?.available === false)}
    onClick={() => onSelect(folderId)}
    title={path}
    type="button"
  ><Icon name="folder" size={14} /><span>{name}</span>{selectedFolderId === folderId ? <Icon name="check" size={13} /> : null}</button>;
  const renderNode = (node: FolderNode) => <li key={node.path}>
    {node.children.length ? <details>
      <summary>{node.name}</summary>
      {node.folderId !== null ? folderButton(node.folderId, b('captureSelectFolder') + ' ' + node.name, node.path) : null}
      <ul>{node.children.map(renderNode)}</ul>
    </details> : node.folderId !== null ? folderButton(node.folderId, node.name, node.path) : <span>{node.name}</span>}
  </li>;
  return <div className="browser-capture-folders">
    {folderButton(null, b('captureRoot'), b('captureRoot'))}
    {recent.length ? <div className="browser-capture-recent"><h3>{b('captureRecent')}</h3>{recent.map(folder => <div key={folder.folderId}>{folderButton(folder.folderId, folder.name, folder.relativePath || folder.name)}</div>)}</div> : null}
    {folders.length ? <>
      <label className="browser-bookmark-search"><Icon name="search" size={15} /><input aria-label={b('captureSearchFolders')} placeholder={b('captureSearchFolders')} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="browser-capture-folder-scroll">
        {search ? <ul className="browser-capture-folder-tree">{matches.map(folder => <li key={folder.folderId}>{folderButton(folder.folderId, folder.relativePath || folder.name, folder.relativePath || folder.name)}</li>)}</ul> : <ul className="browser-capture-folder-tree">{tree.roots.map(renderNode)}</ul>}
        {search && !matches.length ? <p className="browser-help">{b('captureNoMatchingFolders')}</p> : null}
      </div>
    </> : <p className="browser-help">{b('captureNoFolders')}</p>}
  </div>;
}
