import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

function cleanup(root: string): void {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-upgrade-')) throw new Error('Invalid upgrade fixture cleanup');
  rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

// eslint-disable-next-line no-empty-pattern
test('keeps WorldlineBox modules and persists the upgraded appearance and library cover', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-upgrade-'));
  const image = path.join(root, 'cover.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const launch = async () => {
    const instance = await electron.launch({
    executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile'), WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: path.join(root, 'Upgrade fixture'), WORLDLINEBOX_E2E_IMPORT_FILES: image,
    }),
    });
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) await instance.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title ?? '';
        return { canceled: false, filePaths: [/Create Library|创建资源库/iu.test(title) ? paths.root
          : /Open Library|打开资源库/iu.test(title) ? paths.library : paths.image] };
      };
    }, { root, library: path.join(root, 'Upgrade fixture'), image });
    return instance;
  };
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  const openSettings = async (page: Page) => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '通用设置' });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  try {
    application = await launch();
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    let page = await application.firstWindow();
    expect(await application.evaluate(({ app }) => app.getName())).toBe('WorldlineBox');
    await expect(page.locator('[data-application-module]')).toHaveCount(4);
    expect(await page.locator('[data-application-module]').evaluateAll(elements =>
      elements.map(element => element.getAttribute('data-application-module')))).toEqual(['dsh', 'companions', 'assets', 'browser']);
    await page.locator('[data-application-module="assets"]').click();
    await page.getByRole('button', { name: '创建资源库', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('Upgrade fixture');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('button', { name: '当前资源库 Upgrade fixture' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.library-loading-backdrop')).toBeHidden({ timeout: 30_000 });

    const ids = await page.evaluate(async () => {
      const api = (window as unknown as { worldlinebox: { library: WorldlineBoxLibraryApi } }).worldlinebox.library;
      const opened = await api.listOpen();
      if (!opened.ok || !opened.value[0]) throw new Error('Missing fixture library');
      const libraryId = opened.value[0].libraryId;
      const folder = await api.createFolder({ libraryId, name: 'Cover folder' });
      if (!folder.ok) throw new Error(folder.error.message);
      const imported = await api.importFiles({ libraryId, targetFolderId: folder.value.folderId });
      if (!imported.ok) throw new Error(imported.error.message);
      const assets = await api.listAssets({ libraryId, recursive: true });
      if (!assets.ok || !assets.value[0]) throw new Error('Missing fixture image');
      const assetId = assets.value[0].assetId;
      const cover = await api.setFolderCoverFromAsset({ libraryId, folderIds: [folder.value.folderId], assetId });
      if (!cover.ok) throw new Error(cover.error.message);
      return { libraryId, folderId: folder.value.folderId, assetId };
    });
    const readCover = () => page.evaluate(async ({ libraryId, folderId }) => {
      const api = (window as unknown as { worldlinebox: { library: WorldlineBoxLibraryApi } }).worldlinebox.library;
      const entries = await api.listFolderBrowseEntries({ libraryId, parentFolderId: null });
      return entries.ok ? entries.value.find(folder => folder.folderId === folderId) : null;
    }, ids);
    await expect.poll(readCover).toMatchObject({ hasCustomCover: true, customCoverAssetId: ids.assetId });

    let settings = await openSettings(page);
    await settings.getByRole('tab', { name: '外观', exact: true }).click();
    const newUi = settings.getByRole('switch', { name: '新 UI', exact: true });
    await expect(newUi).toHaveAttribute('aria-checked', 'true');
    await newUi.click();
    await expect(newUi).toHaveAttribute('aria-checked', 'false');
    await newUi.click();
    await settings.getByRole('button', { name: /自定义主题/ }).click();
    await settings.getByRole('button', { name: '保存为新主题', exact: true }).click();
    await page.getByRole('textbox', { name: '主题名称', exact: true }).fill('Worldline upgrade theme');
    await page.getByRole('dialog', { name: '新主题名称' }).getByRole('button', { name: '完成', exact: true }).click();
    await expect(settings.getByText('Worldline upgrade theme', { exact: true })).toBeVisible();
    await settings.getByRole('tab', { name: '浏览', exact: true }).click();
    await settings.getByRole('radiogroup', { name: '卡片文字对齐' }).getByRole('radio', { name: '右对齐', exact: true }).click();
    await expect(settings.getByRole('radio', { name: '右对齐', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    const native = await application.browserWindow(page);
    await native.evaluate(window => {
      window.setOpacity(0);
      window.setFocusable(false);
      window.webContents.setBackgroundThrottling(false);
      window.showInactive();
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const evidence = path.resolve('.tools/test-output/asset-manager-030-qa');
    mkdirSync(evidence, { recursive: true });
    const screenshot = await page.screenshot({ path: path.join(evidence, 'worldlinebox-upgraded-assets.png') });
    await testInfo.attach('worldlinebox-upgraded-assets', { body: screenshot, contentType: 'image/png' });
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    await page.locator('[data-application-module="assets"]').click();
    await page.getByRole('button', { name: '打开资源库', exact: true }).click();
    await expect(page.getByRole('button', { name: '当前资源库 Upgrade fixture' })).toBeVisible();
    await expect.poll(readCover).toMatchObject({ hasCustomCover: true, customCoverAssetId: ids.assetId });
    settings = await openSettings(page);
    await settings.getByRole('tab', { name: '外观', exact: true }).click();
    await expect(settings.getByRole('switch', { name: '新 UI', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(settings.getByText('Worldline upgrade theme', { exact: true })).toBeVisible();
    await settings.getByRole('tab', { name: '浏览', exact: true }).click();
    await expect(settings.getByRole('radio', { name: '右对齐', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    const cleared = await page.evaluate(async ({ libraryId, folderId }) => {
      const api = (window as unknown as { worldlinebox: { library: WorldlineBoxLibraryApi } }).worldlinebox.library;
      return api.clearFolderCover({ libraryId, folderIds: [folderId] });
    }, ids);
    expect(cleared.ok).toBe(true);
    await expect.poll(async () => {
      const folder = await readCover();
      return folder ? { custom: folder.hasCustomCover ?? false, asset: folder.customCoverAssetId ?? null } : null;
    }).toEqual({ custom: false, asset: null });
  } finally {
    await application?.close();
    cleanup(root);
  }
});
