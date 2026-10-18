import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import type { WorldlineBoxBrowserApi } from '../../src/shared/browser';
import type { BrowserCaptureRequest } from '../../src/shared/browser-capture';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { library: WorldlineBoxLibraryApi; browser: WorldlineBoxBrowserApi };

async function capture(page: Page, request: BrowserCaptureRequest) {
  return page.evaluate(async request => {
    const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.browser.capture(request);
    if (!result.ok) throw new Error(result.error);
    return result;
  }, request);
}

async function assets(page: Page, libraryId: string) {
  return page.evaluate(async libraryId => {
    const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.listAssets({ libraryId, recursive: true });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, libraryId);
}

function cleanup(root: string) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-browser-capture-')) throw Error('Invalid capture fixture cleanup');
  rmSync(target, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
}

// eslint-disable-next-line no-empty-pattern
test('the built-in browser captures authenticated media into real libraries and preserves capture settings', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-browser-capture-'));
  const linked = path.join(root, 'external', 'Collected'); mkdirSync(linked, { recursive: true });
  const local = path.join(root, 'local.png');
  const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: '#2387ff' } }).png().toBuffer();
  const secondPng = await sharp({ create: { width: 48, height: 64, channels: 4, background: '#ff8323' } }).png().toBuffer();
  const localPng = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#23ff87' } }).png().toBuffer();
  writeFileSync(local, localPng);
  const videoPath = path.join(root, 'clip.webm');
  const ffmpeg = path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe');
  const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=2', '-t', '1', '-c:v', 'libvpx-vp9', '-y', videoPath], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  expect(encoded.status, encoded.stderr).toBe(0);
  const video = readFileSync(videoPath);
  let cookieSaves = 0;
  let slowStarted = 0;
  const server = createServer((request, response) => {
    if (request.url === '/gallery') {
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'capture_session=ready; Path=/; SameSite=Lax',
        'content-security-policy': "default-src 'self'; script-src 'none'; style-src 'none'; img-src 'self'; media-src 'self'" });
      response.end('<!doctype html><html><title>Capture gallery</title><body><h1>Authenticated gallery</h1><img id="hero" alt="Protected image" draggable="true" width="160" height="120" src="/protected.png"><video id="video" controls preload="metadata" src="/clip.webm"></video></body></html>');
      return;
    }
    if (request.url === '/protected.png' || request.url === '/retained.png') {
      if (!request.headers.cookie?.includes('capture_session=ready') || !request.headers.referer?.endsWith('/gallery')) { response.writeHead(403); response.end('Cookie and Referer required'); return; }
      cookieSaves++;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': png.length, 'cache-control': 'no-store' }); response.end(png); return;
    }
    if (request.url === '/clip.webm') { response.writeHead(200, { 'content-type': 'video/webm', 'content-length': video.length }); response.end(video); return; }
    if (request.url === '/second.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(secondPng); return; }
    if (request.url === '/oversize.png') { response.writeHead(200, { 'content-type': 'image/png', 'content-length': 500 * 1024 * 1024 + 1 }); response.end(); return; }
    if (request.url === '/slow.png') { slowStarted++; response.writeHead(200, { 'content-type': 'image/png', 'content-length': 100_000 }); response.write(png.subarray(0, 10)); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = path.join(root, 'profile');
  const launch = async () => {
    const instance = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root, WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: path.join(root, 'Capture library'), WORLDLINEBOX_E2E_LINKED_SOURCE: linked }) });
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) await instance.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title ?? '';
        return { canceled: false, filePaths: [/Create Library|创建资源库/iu.test(title) ? paths.root
          : /Open Library|打开资源库/iu.test(title) ? paths.library : paths.linked] };
      };
    }, { root, library: path.join(root, 'Capture library'), linked });
    return instance;
  };
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    let page = await application.firstWindow();
    const native = await application.browserWindow(page);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await page.locator('[data-application-module="assets"]').click();
    await page.getByRole('button', { name: '创建资源库', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('Capture library');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('button', { name: '当前资源库 Capture library' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.library-loading-backdrop')).toBeHidden({ timeout: 30_000 });
    const fixture = await page.evaluate(async () => {
      const api = (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library;
      const opened = await api.listOpen(); if (!opened.ok || !opened.value[0]) throw Error('Missing library');
      const libraryId = opened.value[0].libraryId;
      const folder = await api.createFolder({ libraryId, name: 'Collected' }); if (!folder.ok) throw Error(folder.error.message);
      const child = await api.createFolder({ libraryId, parentFolderId: folder.value.folderId, name: 'Nested' }); if (!child.ok) throw Error(child.error.message);
      return { libraryId, folderId: folder.value.folderId, childId: child.value.folderId };
    });
    await page.locator('[data-application-module="browser"]').click();
    await page.getByRole('textbox', { name: '搜索或输入网址' }).fill(origin + '/gallery');
    await page.getByRole('textbox', { name: '搜索或输入网址' }).press('Enter');
    await expect.poll(() => application!.context().pages().some(candidate => candidate.url() === origin + '/gallery')).toBe(true);
    const web = application.context().pages().find(candidate => candidate.url() === origin + '/gallery')!;
    await expect(web.getByAltText('Protected image')).toHaveJSProperty('naturalWidth', 64);
    expect(await web.evaluate(() => ({ require: typeof Reflect.get(globalThis, 'require'), process: typeof Reflect.get(globalThis, 'process'), bridge: typeof Reflect.get(globalThis, 'worldlinebox') })))
      .toEqual({ require: 'undefined', process: 'undefined', bridge: 'undefined' });
    await capture(page, { type: 'preferences.save', preferences: { notificationsEnabled: false, focusAppAfterSave: false, revealInLibrary: false, dragRadialMenuEnabled: true } });
    await page.getByRole('button', { name: '保存到资产库', exact: true }).click();
    await expect(page.getByRole('tab', { name: '保存', exact: true })).toBeVisible();
    await capture(page, { type: 'target.set', target: { libraryId: fixture.libraryId, folderId: fixture.childId } });
    const save = async (url: string, kind: 'image' | 'video' = 'image') => {
      const result = await capture(page, { type: 'save', kind, mediaUrl: url });
      await expect.poll(async () => (await capture(page, { type: 'state' })).state.jobs.find(job => job.id === result.jobId)?.status, { timeout: 30_000 }).not.toBe('saving');
      return (await capture(page, { type: 'state' })).state.jobs.find(job => job.id === result.jobId)!;
    };
    const first = await save(origin + '/protected.png');
    expect(first.status, first.message).toBe('saved');
    expect(first.target).toEqual({ libraryId: fixture.libraryId, folderId: fixture.childId });
    expect(cookieSaves).toBeGreaterThan(1);
    expect((await assets(page, fixture.libraryId))[0]?.relativeFilePath).toBe('Collected/Nested/protected.png');
    const metadata = await page.evaluate(async ({ libraryId, assetId }) => {
      const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.getAssetMetadata({ libraryId, assetId });
      if (!result.ok) throw Error(result.error.message); return result.value;
    }, { libraryId: fixture.libraryId, assetId: first.assetId! });
    expect(metadata.sourcePageUrl).toBe(origin + '/gallery');
    // Existing IMPORT-007 keeps both for an occupied destination basename;
    // content dedup applies when the destination name is free.
    expect((await save(origin + '/retained.png')).assetId).toBe(first.assetId);
    expect(await assets(page, fixture.libraryId)).toHaveLength(1);
    expect((await save(origin + '/clip.webm', 'video')).status).toBe('saved');
    expect((await assets(page, fixture.libraryId)).some(asset => asset.mediaType === 'video')).toBe(true);
    const oversize = await save(origin + '/oversize.png'); expect(oversize.status).toBe('failed'); expect(oversize.message).toContain('500');
    const slow = await capture(page, { type: 'save', kind: 'image', mediaUrl: origin + '/slow.png' });
    await expect.poll(() => slowStarted).toBe(1);
    await capture(page, { type: 'cancel', id: slow.jobId! });
    await expect.poll(async () => (await capture(page, { type: 'state' })).state.jobs.find(job => job.id === slow.jobId)?.status).toBe('cancelled');
    expect(await assets(page, fixture.libraryId)).toHaveLength(2);

    // Exercise the real native context-menu branch, selecting its root action.
    await application.evaluate(({ Menu }) => {
      const prototype = Menu.prototype as Electron.Menu & { popup: Electron.Menu['popup'] };
      const original = prototype.popup;
      prototype.popup = function(options) {
        const root = this.items.find(item => item.label === '保存到 WorldlineBox');
        const library = root?.submenu?.items.find(item => item.label === 'Capture library');
        const target = library?.submenu?.items.find(item => item.label === '保存到根目录');
        if (target) { prototype.popup = original; target.click(target, undefined, { preventDefault() {} } as Electron.KeyboardEvent); }
        else original.call(this, options);
      };
    });
    await web.getByAltText('Protected image').click({ button: 'right' });
    await expect.poll(async () => (await capture(page, { type: 'state' })).state.jobs.filter(job => job.status === 'saved').length).toBeGreaterThanOrEqual(4);
    // Deduplication keeps the original file even when saved to another destination.
    expect(await assets(page, fixture.libraryId)).toHaveLength(2);

    const linkedFolder = await page.evaluate(async libraryId => {
      const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.importFolderAsLinked({ libraryId });
      if (!result.ok) throw Error(result.error.message); return result.value;
    }, fixture.libraryId);
    const destinations = (await capture(page, { type: 'state' })).state.folders;
    expect(destinations.find(folder => folder.folderId === fixture.folderId)?.relativePath)
      .not.toBe(destinations.find(folder => folder.folderId === linkedFolder.folderId)?.relativePath);
    await capture(page, { type: 'target.set', target: { libraryId: fixture.libraryId, folderId: linkedFolder.folderId } });
    const linkedJob = await save(origin + '/second.png');
    expect(linkedJob.status, linkedJob.message).toBe('saved');
    expect((await assets(page, fixture.libraryId)).find(asset => asset.assetId === linkedJob.assetId)?.locationKind).toBe('linked');
    expect(readFileSync(path.join(linked, 'second.png'))).toEqual(secondPng);
    await capture(page, { type: 'target.set', target: { libraryId: fixture.libraryId, folderId: fixture.childId } });

    await application.evaluate(({ dialog }, local) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [local] }); }, local);
    const localJob = await capture(page, { type: 'local.open' });
    await expect.poll(async () => (await capture(page, { type: 'state' })).state.jobs.find(job => job.id === localJob.jobId)?.status).toBe('saved');
    expect(await assets(page, fixture.libraryId)).toHaveLength(4);
    await capture(page, { type: 'preferences.save', preferences: { notificationsEnabled: false, focusAppAfterSave: false, revealInLibrary: true, dragRadialMenuEnabled: true } });
    await capture(page, { type: 'save', kind: 'image', mediaUrl: origin + '/retained.png' });
    await expect(page.locator('[data-application-module="assets"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator(`[data-asset-id="${first.assetId}"]`)).toBeVisible();
    await application.close(); application = undefined;

    application = await launch(); page = await application.firstWindow();
    await page.locator('[data-application-module="assets"]').click();
    await page.getByRole('button', { name: '打开资源库', exact: true }).click();
    await expect(page.getByRole('button', { name: '当前资源库 Capture library' })).toBeVisible();
    await page.locator('[data-application-module="browser"]').click();
    const restored = (await capture(page, { type: 'state' })).state;
    expect(restored.target).toEqual({ libraryId: fixture.libraryId, folderId: fixture.childId });
    expect(restored.preferences).toMatchObject({ notificationsEnabled: false, focusAppAfterSave: false, revealInLibrary: true, dragRadialMenuEnabled: true });
    expect(restored.recentFolderIds).toContain(fixture.childId);
    expect(await assets(page, fixture.libraryId)).toHaveLength(4);
    await testInfo.attach('capture-summary', { body: JSON.stringify({ authenticatedCookieAndReferer: true, duplicateAssetId: first.assetId, folderId: fixture.childId,
      imageAndVideo: true, oversizeRejected: true, cancellation: true, nativeContextMenu: true, linkedFolderTarget: true, nativeLocalImage: true, revealAcrossActivity: true, settingsRestored: true }), contentType: 'application/json' });
  } finally {
    server.closeAllConnections(); await application?.close();
    const logs = path.join(profile, 'logs');
    if (testInfo.status !== testInfo.expectedStatus && existsSync(logs)) for (const file of readdirSync(logs)) {
      if (file.endsWith('.log')) await testInfo.attach(file, { body: readFileSync(path.join(logs, file)), contentType: 'text/plain' });
    }
    await new Promise<void>(resolve => server.close(() => resolve())); cleanup(root);
  }
});
