import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import sharp from 'sharp';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath, resolveSessionLogPath } from './electron-test-helpers';

test('extension collection uploads reach Main and Worker and reject a stale target before import', async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-extension-collection-'));
  const profile = path.join(root, 'profile');
  const assertFixtureRoot = () => {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-extension-collection-')) throw Error('Unexpected fixture cleanup path');
    return resolved;
  };
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(),
      args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root }) });
    await application.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const window = await application.firstWindow();
    await window.locator('[data-application-module="assets"]').click();
    await window.getByRole('button', { name: '创建资源库', exact: true }).click();
    await window.getByRole('textbox', { name: '名称', exact: true }).fill('Extension collections');
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await expect(window.getByRole('button', { name: '当前资源库 Extension collections' })).toBeVisible({ timeout: 30_000 });
    await expect(window.locator('.library-loading-backdrop')).toBeHidden({ timeout: 30_000 });
    const fixture = await window.evaluate(async () => {
      const api = (globalThis as unknown as { worldlinebox: { library: WorldlineBoxLibraryApi } }).worldlinebox.library;
      const open = await api.listOpen(); if (!open.ok || !open.value[0]) throw Error('Missing fixture library');
      const libraryId = open.value[0].libraryId;
      const parent = await api.createCollection({ libraryId, name: '参考/图片' }); if (!parent.ok) throw Error(parent.error.message);
      const child = await api.createCollection({ libraryId, parentId: parent.value.collectionId, name: '草图' }); if (!child.ok) throw Error(child.error.message);
      const folder = await api.createFolder({ libraryId, name: 'Not the collection target' }); if (!folder.ok) throw Error(folder.error.message);
      return { libraryId, collectionId: child.value.collectionId, folderId: folder.value.folderId };
    });
    // Select a managed folder: an explicit collection save must still import
    // into the root, without accidentally inheriting this browse context.
    await window.reload();
    await window.locator('[data-application-module="assets"]').click();
    await expect(window.getByRole('button', { name: '当前资源库 Extension collections' })).toBeVisible({ timeout: 30_000 });
    await expect(window.locator('.library-loading-backdrop')).toBeHidden({ timeout: 30_000 });
    await window.locator(`button.nav-row[data-nav-folder-id="${fixture.folderId}"]`).click();
    const log = resolveSessionLogPath(path.join(profile, 'logs'));
    const port = /Browser extension server started on port (\d+)/u.exec(readFileSync(log, 'utf8'))?.[1];
    if (!port) throw Error('Missing isolated application extension server port');
    const origin = `http://127.0.0.1:${port}`;
    const headers = { Origin: `chrome-extension://${'a'.repeat(32)}` };
    let collectionPayload: unknown;
    await expect.poll(async () => {
      const response = await fetch(origin + '/collections', { headers }); collectionPayload = await response.json(); return response.status;
    }).toBe(200);
    expect(collectionPayload).toMatchObject({ collections: expect.arrayContaining([
      expect.objectContaining({ collectionId: fixture.collectionId, relativePath: '参考／图片/草图' }),
    ]) });
    const png = await sharp({ create: { width: 33, height: 27, channels: 4, background: '#a67bea' } }).png().toBuffer();
    const uploadHeaders = { ...headers, 'Content-Type': 'application/octet-stream', 'X-WorldlineBox-Kind': 'image',
      'X-WorldlineBox-Source-Page-Url': 'https://example.com/collection', 'X-WorldlineBox-Media-Url': 'https://example.com/collection.png',
      'X-WorldlineBox-Content-Type': 'image/png', 'X-WorldlineBox-Filename': 'collection.png',
      'X-WorldlineBox-Target-Collection-Id': encodeURIComponent(fixture.collectionId),
      'X-WorldlineBox-Focus-App-After-Save': 'false', 'X-WorldlineBox-Reveal-In-Library': 'false' };
    const saved = await fetch(origin + '/save-upload', { method: 'POST', headers: uploadHeaders, body: new Uint8Array(png) });
    expect(saved.status, await saved.text()).toBe(202);
    const assets = await window.evaluate(async fixture => {
      const api = (globalThis as unknown as { worldlinebox: { library: WorldlineBoxLibraryApi } }).worldlinebox.library;
      const result = await api.listCollectionAssets({ ...fixture, recursive: false }); if (!result.ok) throw Error(result.error.message); return result.value;
    }, fixture);
    expect(assets).toHaveLength(1); expect(assets[0]?.displayName).toBe('collection.png');
    expect(existsSync(path.join(root, 'Extension collections', 'Assets', 'collection.png'))).toBe(true);
    const missing = await fetch(origin + '/save-upload', { method: 'POST', headers: { ...uploadHeaders,
      'X-WorldlineBox-Target-Collection-Id': 'deleted-fixture-collection', 'X-WorldlineBox-Filename': 'must-not-import.png' }, body: new Uint8Array(png) });
    expect(missing.status).toBe(422);
    expect(existsSync(path.join(root, 'Extension collections', 'Assets', 'must-not-import.png'))).toBe(false);
    console.log('EXTENSION_COLLECTION_MAIN_WORKER_E2E', JSON.stringify({ nestedPath: true, collectionMembership: true, importedAtRoot: true, staleTargetRejectedBeforeImport: true }));
  } finally {
    await application?.close();
    rmSync(assertFixtureRoot(), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
