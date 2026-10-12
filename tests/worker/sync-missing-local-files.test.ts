import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryService } from '../../src/worker/library-service';
import { parseManifest, serializeManifest } from '../../src/worker/sync/manifest';
import { createLibrarySyncPort } from '../../src/worker/sync/library-port';
import { SyncEngine } from '../../src/worker/sync/sync-engine';
import { startMockWebDAVServer } from './webdav-fixture-server';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-sync-missing-'));
  roots.push(root);
  return root;
}

function importFile(service: LibraryService, libraryId: string, filePath: string): void {
  const prepared = service.prepareOrExecuteImport({
    libraryId,
    sourceKind: 'files',
    sourcePaths: [filePath],
  });
  if ('importId' in prepared) {
    service.resolveImport({
      importId: prepared.importId,
      suspectedDuplicate: 'create-copy',
      nameConflict: 'keep-both',
    });
  }
}

function liveAssets(service: LibraryService, libraryId: string) {
  return service.listAssets({ libraryId, recursive: true }).filter((asset) => asset.deletedAt === null);
}

/**
 * 模拟「换了本地资源库路径」：把库身份（.worldlinebox）拷到新目录，Assets 留空。
 * 调用前必须 close 源库，避免 WAL 未落盘。
 */
function copyLibraryIdentityWithoutAssets(sourceLibraryPath: string): string {
  const destinationParent = tempRoot();
  const destination = path.join(destinationParent, path.basename(sourceLibraryPath));
  mkdirSync(destination);
  mkdirSync(path.join(destination, 'Assets'));
  cpSync(path.join(sourceLibraryPath, '.worldlinebox'), path.join(destination, '.worldlinebox'), { recursive: true });
  return destination;
}

describe('sync when previously synced files are missing locally', () => {
  it('restores missing local files from the remote instead of treating them as a user deletion', async () => {
    const server = await startMockWebDAVServer();
    const root = { id: 'server', baseUrl: server.baseUrl };
    const service = new LibraryService();
    const created = service.createLibrary({ displayName: '缺文件库', selectedParentPath: tempRoot() });
    const libraryId = created.libraryId;
    const source = path.join(tempRoot(), 'photo.txt');
    writeFileSync(source, 'keep-me-on-cloud');
    importFile(service, libraryId, source);
    const asset = liveAssets(service, libraryId)[0]!;
    const absolutePath = service.resolveAssetPath(libraryId, asset.assetId);

    const engine = new SyncEngine(createLibrarySyncPort(service), { deviceId: 'device-a' });
    const first = await engine.syncOnce(libraryId, root);
    expect(first.report.uploads).toBeGreaterThanOrEqual(1);
    expect(existsSync(absolutePath)).toBe(true);

    unlinkSync(absolutePath);
    expect(existsSync(absolutePath)).toBe(false);

    const second = await engine.syncOnce(libraryId, root);
    const remoteFiles = [...server.files().keys()].filter((key) => key.includes('/assets/'));
    const restored = liveAssets(service, libraryId).find((item) => item.assetId === asset.assetId);

    expect(second.report.remoteDeletes).toBe(0);
    expect(second.report.localRecycles).toBe(0);
    expect(second.report.downloads).toBeGreaterThanOrEqual(1);
    expect(service.listTrash(libraryId)).toEqual([]);
    expect(existsSync(absolutePath)).toBe(true);
    expect(restored?.availability).toBe('available');
    expect(remoteFiles.length).toBeGreaterThan(0);

    service.closeAll();
    await server.close();
  });

  it('restores leftover remote files after a false tombstone dropped the manifest entry', async () => {
    const server = await startMockWebDAVServer();
    const root = { id: 'server', baseUrl: server.baseUrl };
    const service = new LibraryService();
    const created = service.createLibrary({ displayName: '墓碑残留库', selectedParentPath: tempRoot() });
    const libraryId = created.libraryId;
    const source = path.join(tempRoot(), 'photo.txt');
    writeFileSync(source, 'still-on-cloud');
    importFile(service, libraryId, source);
    const asset = liveAssets(service, libraryId)[0]!;
    const absolutePath = service.resolveAssetPath(libraryId, asset.assetId);

    const engine = new SyncEngine(createLibrarySyncPort(service), { deviceId: 'device-a' });
    await engine.syncOnce(libraryId, root);

    const remote = server.files();
    const manifestKey = [...remote.keys()].find((key) => key.endsWith('manifest.json'));
    expect(manifestKey).toBeTruthy();
    const stored = remote.get(manifestKey!)!;
    const parsed = parseManifest(stored.body.toString('utf-8'));
    const syncId = Object.keys(parsed.entries)[0]!;
    delete parsed.entries[syncId];
    remote.set(manifestKey!, { ...stored, body: Buffer.from(serializeManifest(parsed)) });
    service.writeSyncManifestCache(libraryId, serializeManifest(parsed));
    unlinkSync(absolutePath);

    const second = await engine.syncOnce(libraryId, root);
    expect(second.report.remoteDeletes).toBe(0);
    expect(second.report.localRecycles).toBe(0);
    expect(second.report.downloads).toBeGreaterThanOrEqual(1);
    expect(existsSync(absolutePath)).toBe(true);
    expect(service.listTrash(libraryId)).toEqual([]);

    service.closeAll();
    await server.close();
  });

  it('does not recycle the original library after a relocated copy syncs without Assets', async () => {
    const server = await startMockWebDAVServer();
    const root = { id: 'server', baseUrl: server.baseUrl };
    const serviceA = new LibraryService();
    const createdA = serviceA.createLibrary({ displayName: '换路径库', selectedParentPath: tempRoot() });
    const libraryId = createdA.libraryId;
    const source = path.join(tempRoot(), 'photo.txt');
    writeFileSync(source, 'original-bytes');
    importFile(serviceA, libraryId, source);
    const original = liveAssets(serviceA, libraryId)[0]!;
    const originalPath = serviceA.resolveAssetPath(libraryId, original.assetId);

    const engineA = new SyncEngine(createLibrarySyncPort(serviceA), { deviceId: 'device-a' });
    await engineA.syncOnce(libraryId, root);
    expect(existsSync(originalPath)).toBe(true);

    const originalLibraryPath = createdA.libraryPath;
    serviceA.closeAll();
    const relocatedPath = copyLibraryIdentityWithoutAssets(originalLibraryPath);
    expect(readdirSync(path.join(relocatedPath, 'Assets'))).toEqual([]);

    const serviceB = new LibraryService();
    const openedB = serviceB.openLibrary(relocatedPath);
    expect(openedB.libraryId).toBe(libraryId);
    const engineB = new SyncEngine(createLibrarySyncPort(serviceB), { deviceId: 'device-b' });
    const relocatedSync = await engineB.syncOnce(libraryId, root);
    expect(relocatedSync.report.remoteDeletes).toBe(0);
    expect(serviceB.listTrash(libraryId)).toEqual([]);

    const serviceOriginal = new LibraryService();
    serviceOriginal.openLibrary(originalLibraryPath);
    const engineOriginal = new SyncEngine(createLibrarySyncPort(serviceOriginal), { deviceId: 'device-a' });
    const originalSync = await engineOriginal.syncOnce(libraryId, root);

    expect(originalSync.report.localRecycles).toBe(0);
    expect(serviceOriginal.listTrash(libraryId)).toEqual([]);
    expect(existsSync(serviceOriginal.resolveAssetPath(libraryId, original.assetId))).toBe(true);
    expect(liveAssets(serviceOriginal, libraryId).some((item) => item.assetId === original.assetId)).toBe(true);

    serviceB.closeAll();
    serviceOriginal.closeAll();
    await server.close();
  });
});
