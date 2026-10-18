import { describe, expect, it } from 'vitest';
import { buildFolderTree } from '../../extension/radial-menu-model';
import { buildSaveMenuTree, type SaveMenuTreeFolder } from '../../extension/folder-menu';
import { captureLinkedFolderOptions } from '../../src/main/browser/capture-folders';
import type { BrowserCaptureFolder } from '../../src/shared/browser-capture';

const managed: BrowserCaptureFolder[] = [
  { libraryId: 'library', folderId: 'managed', name: 'Collected', relativePath: 'Collected', assetCount: 0, kind: 'managed' },
  { libraryId: 'library', folderId: 'managed-child', name: 'Nested', relativePath: 'Collected/Nested', assetCount: 0, kind: 'managed' },
];
const linked = (folderId: string, name = 'Collected') => ({ folderId, displayName: name, relativePath: '', assetCount: 0, status: 'available' as const });

describe('built-in capture folder display namespaces', () => {
  it('keeps managed and linked folders with the same name selectable in the shared drag, panel and native trees', () => {
    const options = captureLinkedFolderOptions('library', managed, [linked('linked'), { ...linked('linked-child', 'Nested'), linkedFolderId: 'linked', relativePath: 'Nested' }]);
    expect(options.map(folder => folder.relativePath)).toEqual(['Collected（链接）', 'Collected（链接）/Nested']);
    expect(options.map(folder => folder.folderId)).toEqual(['linked', 'linked-child']);
    const folders = [...managed, ...options]; const tree = buildFolderTree(folders);
    expect(tree.byId.get('managed')?.folderId).toBe('managed'); expect(tree.byId.get('linked')?.folderId).toBe('linked');
    expect(tree.byId.get('managed-child')?.folderId).toBe('managed-child'); expect(tree.byId.get('linked-child')?.folderId).toBe('linked-child');
    expect(tree.roots).toHaveLength(2);
    const native = buildSaveMenuTree(folders, { savedRecentIds: [], browsedRecentIds: [] });
    const ids = (folder: SaveMenuTreeFolder): Array<string | null> => [folder.folderId, ...folder.children.flatMap(ids)];
    expect(native.flatMap(item => item.kind === 'folder' ? ids(item.folder) : [])).toEqual(expect.arrayContaining(['managed', 'managed-child', 'linked', 'linked-child']));
  });
  it('also avoids a real managed suffix and two linked roots with the same display name', () => {
    const occupied = [...managed, { ...managed[0]!, folderId: 'literal-suffix', relativePath: 'Collected（链接）' }];
    const options = captureLinkedFolderOptions('library', occupied, [linked('b'), linked('a')]);
    expect(new Set([...occupied, ...options].map(folder => folder.relativePath)).size).toBe(5);
    expect(options.map(folder => folder.relativePath)).toEqual(['Collected（链接 3）', 'Collected（链接 2）']);
    expect(captureLinkedFolderOptions('library', occupied, [linked('a'), linked('b')]).find(folder => folder.folderId === 'a')?.relativePath).toBe('Collected（链接 2）');
  });
  it('preserves an unambiguous linked label and excludes unavailable roots', () => {
    const options = captureLinkedFolderOptions('library', managed, [linked('other', 'Photos'), { ...linked('offline'), status: 'offline' }]);
    expect(options).toEqual([{ libraryId: 'library', folderId: 'other', name: 'Photos', relativePath: 'Photos', assetCount: 0, kind: 'linked', available: true }]);
  });
});
