import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { LibraryService } from '../../src/worker/library-service';

const fixtures: Array<{ service: LibraryService; root: string }> = [];
afterEach(() => { for (const { service, root } of fixtures.splice(0)) { service.closeAll(); rmSync(root, { recursive: true, force: true }); } });
it('maps only the fixed companion text directory into its owning asset library', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-library-assets-')), service = new LibraryService(); fixtures.push({ root, service });
  const library = service.createLibrary({ displayName: '伙伴', selectedParentPath: root });
  const memoryRoot = path.join(library.libraryPath, '伙伴记忆');
  mkdirSync(path.join(memoryRoot, 'alice', '日记'), { recursive: true });
  writeFileSync(path.join(memoryRoot, 'alice', '日记', '一次学习.md'), '我读过了资料，这是一篇有实际来源的学习日记。');
  expect(() => service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: memoryRoot })).toThrow();
  const folder = service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: memoryRoot, companionMemory: true, displayName: '伙伴记忆' });
  expect(folder.assetCount).toBe(1);
  expect(service.listLinkedFolders(library.libraryId)).toEqual(expect.arrayContaining([expect.objectContaining({ folderId: folder.folderId, absoluteRootPath: memoryRoot })]));
  const other = path.join(library.libraryPath, '其他资料'); mkdirSync(other);
  expect(() => service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: other, companionMemory: true })).toThrow();
  expect(() => service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: library.libraryPath, companionMemory: true })).toThrow();
});
