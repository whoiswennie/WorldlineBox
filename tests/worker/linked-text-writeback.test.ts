import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryService } from '../../src/worker/library-service';

const temporaryRoots: string[] = [];
const services: LibraryService[] = [];
function newService(): LibraryService {
  const service = new LibraryService({ observerFactory: () => ({ close() {} }) });
  services.push(service);
  return service;
}
function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linked-text-034-'));
  temporaryRoots.push(root);
  return root;
}
afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('Linked text writeback', () => {
  it('saves text edits back to the linked source file', () => {
    const root = temporaryRoot();
    const sourceRoot = path.join(root, 'source');
    mkdirSync(sourceRoot);
    const notePath = path.join(sourceRoot, 'note.txt');
    writeFileSync(notePath, 'original');

    const service = newService();
    const created = service.createLibrary({ displayName: 'Linked Text', selectedParentPath: root });
    service.importFolderAsLinked({
      libraryId: created.libraryId,
      sourceRootPath: sourceRoot,
    });
    const asset = service.listAssets({ libraryId: created.libraryId, recursive: true })
      .find((item) => item.relativeFilePath === 'note.txt');
    expect(asset?.assetId).toEqual(expect.any(String));

    const read = service.readTextAsset({
      libraryId: created.libraryId,
      assetId: asset!.assetId,
    });
    expect(read.editable).toBe(true);
    expect(read.content).toBe('original');

    service.saveTextAsset({
      libraryId: created.libraryId,
      assetId: asset!.assetId,
      content: 'edited in place',
      expectedRevisionId: read.revisionId,
    });

    expect(readFileSync(notePath, 'utf8')).toBe('edited in place');
    expect(existsSync(path.join(created.libraryPath, 'Assets', 'note.txt'))).toBe(false);
    const again = service.readTextAsset({
      libraryId: created.libraryId,
      assetId: asset!.assetId,
    });
    expect(again.content).toBe('edited in place');
    expect(again.editable).toBe(true);
    service.closeAll();
  });

});
