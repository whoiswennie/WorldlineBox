import type { BrowserCaptureFolder } from '../../shared/browser-capture';

interface CaptureLinkedFolder {
  folderId: string;
  linkedFolderId?: string;
  displayName: string;
  relativePath?: string;
  assetCount: number;
  status: 'available' | 'offline';
}
const displayIdentity = (name: string) => name.normalize('NFC').toLocaleLowerCase();

/** The reused extension trees key nodes by display path. Linked root labels
 * must therefore occupy a different namespace from every managed display root.
 * These are presentation paths only: folder ids remain the import authority. */
export function captureLinkedFolderOptions(libraryId: string, managed: readonly BrowserCaptureFolder[], linked: readonly CaptureLinkedFolder[]): BrowserCaptureFolder[] {
  const occupiedRoots = new Set(managed.map(folder => displayIdentity((folder.relativePath || folder.name).split('/')[0]!)));
  const available = linked.filter(folder => folder.status === 'available');
  const rootNames = new Map<string, string>();
  for (const folder of available) if (!folder.relativePath) rootNames.set(folder.linkedFolderId ?? folder.folderId, folder.displayName);
  for (const folder of available) if (!rootNames.has(folder.linkedFolderId ?? folder.folderId)) rootNames.set(folder.linkedFolderId ?? folder.folderId, folder.displayName);
  const rootLabels = new Map<string, string>();
  for (const [rootId, rootName] of [...rootNames].sort(([a], [b]) => a.localeCompare(b))) {
    const base = rootName.replace(/[/\\]/g, '／').trim() || '链接文件夹';
    let label = base;
    for (let index = 1; occupiedRoots.has(displayIdentity(label)); index++) label = `${base}（链接${index === 1 ? '' : ' ' + index}）`;
    rootLabels.set(rootId, label); occupiedRoots.add(displayIdentity(label));
  }
  return available.map(folder => {
    const rootLabel = rootLabels.get(folder.linkedFolderId ?? folder.folderId)!;
    return { libraryId, folderId: folder.folderId, name: folder.displayName,
      relativePath: folder.relativePath ? `${rootLabel}/${folder.relativePath}` : rootLabel,
      assetCount: folder.assetCount, kind: 'linked', available: true };
  });
}
