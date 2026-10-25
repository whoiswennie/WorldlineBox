import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type Dialog,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import {
  assetCard,
  openLinkedFolderImportMenu,
  resolveElectronExecutablePath,
  waitForLibraryLoadingToFinish,
} from './electron-test-helpers';

test.describe.configure({ timeout: 120_000 });

test('imports a linked folder, reconciles external changes, and relinks after the root is removed', async () => {
  const testInfo = test.info();
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linked-e2e-'));
  const sourceRoot = path.join(temporaryRoot, 'source');
  const newRoot = path.join(temporaryRoot, 'relocated');
  const libraryName = '链接文件夹验收';
  const libraryPath = path.join(temporaryRoot, libraryName);
  mkdirSync(sourceRoot);
  writeFileSync(path.join(sourceRoot, 'a.png'), Buffer.from('aaa'));
  writeFileSync(path.join(sourceRoot, 'b.png'), Buffer.from('bbbb'));
  writeFileSync(path.join(sourceRoot, 'delete-me.png'), Buffer.from('trash'));
  mkdirSync(path.join(sourceRoot, 'sub'));
  writeFileSync(path.join(sourceRoot, 'sub', 'c.png'), Buffer.from('ccccc'));
  // The relink target exists at launch (env vars are read at process start) but
  // is left empty; it is populated mid-test just before the relink step.
  mkdirSync(newRoot);

  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath,
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, 'user-data'),
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_LINKED_SOURCE: sourceRoot,
      WORLDLINEBOX_E2E_LINKED_NEW_ROOT: newRoot,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.locator('[data-application-module="assets"]').click();
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await expect(window.getByRole('heading', { name: '导入资产以开始整理' })).toBeVisible();
    await waitForLibraryLoadingToFinish(window);

    await openLinkedFolderImportMenu(application, window);
    await expect(window.getByRole('button', { name: 'source', exact: true })).toBeVisible({ timeout: 15_000 });

    await window.getByRole('button', { name: 'source', exact: true }).click();
    await expect(window.getByText('a.png', { exact: true })).toBeVisible();
    await expect(window.getByText('b.png', { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'sub', exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'sub', exact: true }).click();
    await expect(window.getByText('c.png', { exact: true })).toBeVisible();
    await window
      .getByLabel('当前浏览范围')
      .getByRole('button', { name: 'source', exact: true })
      .click();

    await assetCard(window, 'a.png').click({ button: 'right' });
    // 2026-09-15 用户决定：链接资产没有「移入回收站」，只有「强制从硬盘删除…」。
    await expect(window.getByRole('menuitem', { name: '移入回收站' })).toHaveCount(0);
    const forceDeleteMenuItem = window.getByRole('menuitem', { name: '强制从硬盘删除' });
    await expect(forceDeleteMenuItem).toBeVisible();
    await expect(forceDeleteMenuItem).toContainText(
      process.platform === 'darwin' ? '⌥⌘Delete' : 'Shift+Delete',
    );
    await window.keyboard.press('Escape');

    await assetCard(window, 'delete-me.png').click();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Alt+Meta+Delete' : 'Shift+Delete',
    );
    // 链接资产的确认窗应点明源文件会被永久删除，而不是沿用托管资产的通用说法。
    await confirmAssetDiskDelete(application);
    await expect(window.getByText('delete-me.png', { exact: true })).toHaveCount(0);
    expect(existsSync(path.join(sourceRoot, 'delete-me.png'))).toBe(false);

    const before = await listAllAssets(window);
    const aBefore = before.find((asset) => asset.displayName === 'a.png');
    expect(aBefore?.availability).toBe('available');

    // External overwrite of the linked source file (not via WorldlineBox).
    writeFileSync(path.join(sourceRoot, 'a.png'), Buffer.from('aaaaaa'));
    await window.getByRole('button', { name: '刷新磁盘变化' }).click();
    const afterOverwrite = await listAllAssets(window);
    const aAfterOverwrite = afterOverwrite.find((asset) => asset.displayName === 'a.png');
    expect(aAfterOverwrite?.assetId).toBe(aBefore?.assetId);
    expect(aAfterOverwrite?.currentRevisionId).not.toBe(aBefore?.currentRevisionId);
    expect(aAfterOverwrite?.availability).toBe('available');

    // External move inside the linked root: the source identity should keep
    // the catalog row and its metadata instead of creating a second asset.
    const bBeforeMove = afterOverwrite.find((asset) => asset.displayName === 'b.png');
    renameSync(path.join(sourceRoot, 'b.png'), path.join(sourceRoot, 'sub', 'moved-b.png'));
    const refreshAfterMove = window.getByRole('button', { name: '刷新磁盘变化' });
    await refreshAfterMove.click();
    await expect(refreshAfterMove).toBeEnabled({ timeout: 15_000 });
    await window.getByRole('button', { name: 'sub', exact: true }).click();
    await expect(window.getByText('moved-b.png', { exact: true })).toBeVisible();
    await window
      .getByLabel('当前浏览范围')
      .getByRole('button', { name: 'source', exact: true })
      .click();
    // 2026-09-15：外部移动的身份归并在刷新后的后台收敛里完成（前台刷新只保证「已重新
    // 扫描」），所以这里轮询到收敛为止。**已知间歇失败**：watcher 增量路径会先把新路径
    // 落成新资产、旧路径标 missing，此时全量刷新再也并不回来——预存在的 P1 `WorldlineBox-463571`
    // （干净 HEAD 上同样复现，与本次链接文件夹删除改动无关）；轮询失败即说明踩到了它。
    await expect
      .poll(async () => (await listAllAssets(window)).length, { timeout: 20_000 })
      .toBe(3);
    const afterMove = await listAllAssets(window);
    const bAfterMove = afterMove.find((asset) => asset.displayName === 'moved-b.png');
    expect(bAfterMove?.assetId).toBe(bBeforeMove?.assetId);
    expect(bAfterMove?.availability).toBe('available');
    expect(afterMove.some((asset) => asset.displayName === 'b.png')).toBe(false);

    // If the source was removed outside WorldlineBox, the missing linked record can
    // still be cleared from the normal asset menu without reporting a trash
    // failure for a path that no longer exists.
    rmSync(path.join(sourceRoot, 'sub', 'c.png'));
    const refreshAfterExternalDelete = window.getByRole('button', { name: '刷新磁盘变化' });
    await refreshAfterExternalDelete.click();
    await expect(refreshAfterExternalDelete).toBeEnabled({ timeout: 15_000 });
    await window.getByRole('button', { name: 'sub', exact: true }).click();
    const missingC = assetCard(window, 'c.png');
    await expect(missingC).toBeVisible();
    await missingC.click({ button: 'right' });
    // 源文件已被外部删除时，强制删除仍然只清库内记录（不因源文件缺失而失败）。
    await window.getByRole('menuitem', { name: '强制从硬盘删除' }).click();
    await confirmAssetDiskDelete(application);
    await expect(missingC).toHaveCount(0);
    await window
      .getByLabel('当前浏览范围')
      .getByRole('button', { name: 'source', exact: true })
      .click();
    expect(await listAllAssets(window)).toHaveLength(2);

    // Source root removed: folder flips to offline, all linked assets missing.
    rmSync(sourceRoot, { recursive: true, force: true });
    await window.getByRole('button', { name: '刷新磁盘变化' }).click();
    await expect(
      window.locator('.missing-overlay[aria-label="文件丢失"]').first(),
    ).toBeVisible();
    const afterOffline = await listAllAssets(window);
    expect(afterOffline.every((asset) => asset.availability === 'missing')).toBe(true);

    // Relink to the new root that has a.png (different content) but not b.png/c.png.
    writeFileSync(path.join(newRoot, 'a.png'), Buffer.from('aaa-restored'));
    const offlineSource = window
      .locator('button.nav-row[data-nav-folder-kind="linked"]')
      .filter({ hasText: 'source' })
      .first();
    await expect(offlineSource).toHaveAttribute('data-hover-tip', /离线/);
    await offlineSource.click();
    const afterRelink = await listAllAssets(window);
    const aAfterRelink = afterRelink.find((asset) => asset.displayName === 'a.png');
    const bAfterRelink = afterRelink.find((asset) => asset.displayName === 'moved-b.png');
    expect(aAfterRelink?.assetId).toBe(aBefore?.assetId);
    expect(aAfterRelink?.availability).toBe('available');
    expect(aAfterRelink?.currentRevisionId).not.toBe(aAfterOverwrite?.currentRevisionId);
    expect(bAfterRelink?.availability).toBe('missing');

    const screenshot = testInfo.outputPath('linked-relinked.png');
    await window.screenshot({ path: screenshot });
    await testInfo.attach('linked-relinked', { path: screenshot, contentType: 'image/png' });

    // The linked folder's source root now points at newRoot, not the original.
    expect(existsSync(path.join(newRoot, 'a.png'))).toBe(true);
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

// 2026-09-15 用户要求：链接文件夹的动作是「移除链接文件夹…」（只删链接记录）与
// 「强制从硬盘删除…」（永久删除源文件），两者都必须有进度条，且「移除」排在
// 「强制删除」之前；链接文件夹没有「移入回收站」。
test('removes a linked folder without touching sources, then force-deletes it with disk progress', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linked-actions-'));
  const sourceRoot = path.join(temporaryRoot, 'source');
  const libraryName = '链接文件夹动作验收';
  const libraryPath = path.join(temporaryRoot, libraryName);
  mkdirSync(sourceRoot);
  for (const name of ['a.png', 'b.png', 'c.png']) {
    writeFileSync(path.join(sourceRoot, name), Buffer.from(name));
  }
  mkdirSync(path.join(sourceRoot, 'sub'));
  writeFileSync(path.join(sourceRoot, 'sub', 'd.png'), Buffer.from('dddd'));

  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath,
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, 'user-data'),
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_LINKED_SOURCE: sourceRoot,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole('textbox', { name: '名称' }).fill(libraryName);
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await expect(window.getByRole('heading', { name: '导入资产以开始整理' })).toBeVisible();
    await waitForLibraryLoadingToFinish(window);

    await openLinkedFolderImportMenu(application, window);
    const linkedRow = linkedFolderRow(window, 'source');
    await expect(linkedRow).toBeVisible({ timeout: 15_000 });
    expect(await listAllAssets(window)).toHaveLength(4);

    await startDeleteProgressCapture(window);

    // 菜单语义与顺序：没有「移入回收站」，「移除链接文件夹…」在「强制从硬盘删除…」之前。
    await linkedRow.click({ button: 'right' });
    const folderMenu = window.getByRole('menu', { name: '文件夹操作：source', exact: true });
    await expect(folderMenu).toBeVisible();
    await expect(folderMenu.getByRole('menuitem', { name: '移入回收站' })).toHaveCount(0);
    const labels = await folderMenu.getByRole('menuitem').allTextContents();
    const removeIndex = labels.findIndex((label) => label.includes('移除链接文件夹'));
    const forceIndex = labels.findIndex((label) => label.includes('强制从硬盘删除'));
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(forceIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeLessThan(forceIndex);
    // 关掉菜单再操作下一行——右键菜单的 backdrop 会拦截后续点击。
    await window.keyboard.press('Escape');
    await expect(folderMenu).toHaveCount(0);

    // ① 子文件夹「强制从硬盘删除…」：只删这棵子树（源文件永久消失），链接根保留。
    await window.getByRole('button', { name: 'sub', exact: true }).click({ button: 'right' });
    const childMenu = window.getByRole('menu', { name: '文件夹操作：sub', exact: true });
    await expect(childMenu).toBeVisible();
    // 子文件夹没有「移除链接文件夹…」（那是链接根的动作）。
    await expect(childMenu.getByRole('menuitem', { name: '移除链接文件夹' })).toHaveCount(0);
    await childMenu.getByRole('menuitem', { name: '强制从硬盘删除' }).click();
    await confirmLinkedFolderDiskDelete(application);

    await expect(window.getByRole('button', { name: 'sub', exact: true })).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(existsSync(path.join(sourceRoot, 'sub'))).toBe(false);
    for (const name of ['a.png', 'b.png', 'c.png']) {
      expect(existsSync(path.join(sourceRoot, name))).toBe(true);
    }
    await expect(linkedRow).toBeVisible();
    expect(await listAllAssets(window)).toHaveLength(3);

    const childDeleteEvents = await readDeleteProgress(window);
    expect(childDeleteEvents.filter((event) => event.kind === 'disk' && event.phase === 'run').length)
      .toBeGreaterThan(0);
    expect(childDeleteEvents.filter((event) => event.kind === 'disk' && event.phase === 'complete'))
      .toMatchObject([{ filesProcessed: 1, totalFiles: 1 }]);

    // ②「移除链接文件夹…」：确认框只删链接记录，源目录剩下的文件一件不少，进度是 linked-remove。
    await resetDeleteProgress(window);
    await linkedRow.click({ button: 'right' });
    const removeMenu = window.getByRole('menu', { name: '文件夹操作：source', exact: true });
    await expect(removeMenu).toBeVisible();
    const acceptDialogs = (dialog: Dialog) => void dialog.accept();
    window.on('dialog', acceptDialogs);
    await removeMenu.getByRole('menuitem', { name: '移除链接文件夹' }).click();
    await expect(linkedRow).toHaveCount(0, { timeout: 15_000 });
    window.off('dialog', acceptDialogs);

    for (const name of ['a.png', 'b.png', 'c.png']) {
      expect(existsSync(path.join(sourceRoot, name))).toBe(true);
    }
    expect(await listAllAssets(window)).toHaveLength(0);

    const removeEvents = await readDeleteProgress(window);
    expect(removeEvents.filter((event) => event.kind === 'linked-remove' && event.phase === 'complete'))
      .toMatchObject([{ filesProcessed: 3, totalFiles: 3 }]);
    // 移除链接记录不会碰磁盘：整段过程里不能出现任何「从硬盘删除 / 回收站」进度。
    expect(removeEvents.some((event) => event.kind === 'disk' || event.kind === 'trash')).toBe(false);
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

interface AssetSnapshot {
  assetId: string;
  displayName: string;
  currentRevisionId: string;
  availability: 'available' | 'missing';
}

interface DeleteProgressSnapshot {
  kind?: string;
  phase?: string;
  filesProcessed?: number;
  totalFiles?: number;
}

/**
 * 订阅 preload 的进度通道，把 `delete.progress` 事件收进窗口全局数组。
 * 进度条在某些操作上可能一闪而过（几百毫秒），直接断言浮层会变成 flaky；
 * 断言事件流才能稳定证明「操作确实带进度，且语义（kind）正确」。
 */
async function startDeleteProgressCapture(window: Page): Promise<void> {
  await window.evaluate(() => {
    const library = (
      globalThis as typeof globalThis & {
        worldlinebox: {
          library: {
            onProgress(listener: (event: { type?: string }) => void): () => void;
          };
        };
      }
    ).worldlinebox.library;
    const store = globalThis as typeof globalThis & {
      __worldlineboxDeleteProgress?: Array<Record<string, unknown>>;
    };
    store.__worldlineboxDeleteProgress = [];
    library.onProgress((event) => {
      if (event.type !== 'delete.progress') return;
      store.__worldlineboxDeleteProgress!.push(event as Record<string, unknown>);
    });
  });
}

async function readDeleteProgress(
  window: Page,
): Promise<DeleteProgressSnapshot[]> {
  return window.evaluate(() => {
    const store = globalThis as typeof globalThis & {
      __worldlineboxDeleteProgress?: DeleteProgressSnapshot[];
    };
    return store.__worldlineboxDeleteProgress ?? [];
  });
}

async function resetDeleteProgress(window: Page): Promise<void> {
  await window.evaluate(() => {
    const store = globalThis as typeof globalThis & {
      __worldlineboxDeleteProgress?: unknown[];
    };
    store.__worldlineboxDeleteProgress = [];
  });
}

function linkedFolderRow(window: Page, label: string) {
  return window
    .locator('.navigation-pane button.nav-row[data-nav-folder-kind="linked"]')
    .filter({ has: window.locator('.nav-row-label', { hasText: new RegExp(`^${label}$`) }) });
}

/**
 * Main 的确认窗要求测试明确选择“强制删除”，并验证链接资产文案点明源文件会被永久删除。
 */
async function confirmAssetDiskDelete(
  application: ElectronApplication,
): Promise<void> {
  const window = await application.firstWindow();
  const dialog = window.getByRole('dialog', { name: '从磁盘删除这些链接资产的源文件？' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('.dialog-body-copy')).toHaveText(
    '此操作无法撤销：链接文件夹中的源文件会被直接删除，不会进入系统回收站。',
  );
  await dialog
    .getByRole('button', { name: '强制删除', exact: true })
    .click();
}

/**
 * 链接文件夹（根或子目录）的「强制从硬盘删除」同样由 Main 的危险操作确认窗把关，
 * 文案是链接专用的一份（点明会永久删除源文件）。
 */
async function confirmLinkedFolderDiskDelete(
  application: ElectronApplication,
): Promise<void> {
  const window = await application.firstWindow();
  const dialog = window.getByRole('dialog', { name: '从磁盘删除链接文件夹内容？' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('.dialog-body-copy')).toHaveText(
    '此操作无法撤销，文件不会进入应用回收站。',
  );
  await dialog
    .getByRole('button', { name: '强制删除', exact: true })
    .click();
}

async function listAllAssets(window: Page): Promise<AssetSnapshot[]> {
  return window.evaluate(async () => {
    const bridge = globalThis as typeof globalThis & {
      worldlinebox: {
        library: {
          listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
          listAssets(input: {
            libraryId: string;
            recursive: boolean;
          }): Promise<{ ok: boolean; value?: AssetSnapshot[] }>;
        };
      };
    };
    const open = await bridge.worldlinebox.library.listOpen();
    const libraryId = open.value?.[0]?.libraryId;
    if (!open.ok || !libraryId) throw new Error('Expected an open library.');
    const result = await bridge.worldlinebox.library.listAssets({ libraryId, recursive: true });
    if (!result.ok || !result.value) throw new Error('Could not list assets.');
    return result.value;
  });
}

test('restores a linked library after a full app restart', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linked-restart-'));
  const profilePath = path.join(temporaryRoot, 'profile');
  const libraryName = '链接重启恢复';
  const libraryPath = path.join(temporaryRoot, libraryName);
  const sourceRoot = path.join(temporaryRoot, 'source');
  mkdirSync(profilePath);
  mkdirSync(sourceRoot);
  writeFileSync(path.join(sourceRoot, 'a.png'), Buffer.from('aaa'));
  writeFileSync(path.join(sourceRoot, 'b.png'), Buffer.from('bbbb'));
  mkdirSync(path.join(sourceRoot, 'sub'));
  writeFileSync(path.join(sourceRoot, 'sub', 'c.png'), Buffer.from('ccccc'));

  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const launch = () =>
    electron.launch({
      args: [applicationDirectory],
      cwd: applicationDirectory,
      executablePath,
      env: {
        ...process.env,
        WORLDLINEBOX_E2E: '1',
        WORLDLINEBOX_E2E_RESTORE_RECENT: '1',
        WORLDLINEBOX_E2E_USER_DATA_PATH: profilePath,
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
        WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
        WORLDLINEBOX_E2E_LINKED_SOURCE: sourceRoot,
      },
    });

  let application = await launch();
  let assetIds: string[];

  try {
    let window = await application.firstWindow();
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await expect(window.getByRole('heading', { name: '导入资产以开始整理' })).toBeVisible();
    await waitForLibraryLoadingToFinish(window);

    // Link the folder.
    await openLinkedFolderImportMenu(application, window);
    await expect(window.getByRole('button', { name: 'source', exact: true })).toBeVisible({ timeout: 15_000 });
    await window.getByRole('button', { name: 'source', exact: true }).click();

    // The root shows direct files and a virtual child-folder row; nested files
    // appear after entering that row.
    await expect(window.getByText('a.png', { exact: true })).toBeVisible();
    await expect(window.getByText('b.png', { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'sub', exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'sub', exact: true }).click();
    await expect(window.getByText('c.png', { exact: true })).toBeVisible();

    // Remember asset IDs for the restart comparison.
    const beforeRestart = await listAllAssets(window);
    assetIds = beforeRestart.map((asset) => asset.assetId);
    expect(assetIds).toHaveLength(3);
    expect(beforeRestart.every((asset) => asset.availability === 'available')).toBe(true);

    // Close the app.
    await application.close();

    // Restart the app — the library should auto-open because of WORLDLINEBOX_E2E_RESTORE_RECENT.
    application = await launch();
    window = await application.firstWindow();
    await waitForLibraryLoadingToFinish(window);

    // Wait for the library to be restored and the linked folder to be visible.
    const restoredSource = window
      .locator('button.nav-row[data-nav-folder-kind="linked"]')
      .filter({ hasText: 'source' })
      .first();
    await expect(restoredSource).toBeVisible({ timeout: 15_000 });
    await restoredSource.click();

    await expect(window.getByText('a.png', { exact: true })).toBeVisible();
    await expect(window.getByText('b.png', { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'sub', exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'sub', exact: true }).click();
    await expect(window.getByText('c.png', { exact: true })).toBeVisible();

    const afterRestart = await listAllAssets(window);
    expect(afterRestart).toHaveLength(3);
    expect(afterRestart.every((asset) => asset.availability === 'available')).toBe(true);
    // Asset IDs must be stable across restart.
    expect(afterRestart.map((asset) => asset.assetId).sort()).toEqual(assetIds.sort());

    const testInfo = test.info();
    const screenshot = testInfo.outputPath('linked-restart-restored.png');
    await window.screenshot({ path: screenshot });
    await testInfo.attach('linked-restart-restored', { path: screenshot, contentType: 'image/png' });
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('applies default ignore rules — .git and node_modules are not registered as linked assets', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linked-filters-'));
  const sourceRoot = path.join(temporaryRoot, 'source');
  const libraryName = '默认过滤规则';
  const libraryPath = path.join(temporaryRoot, libraryName);

  // Real assets.
  mkdirSync(sourceRoot);
  writeFileSync(path.join(sourceRoot, 'hero.png'), Buffer.from('hero'));
  writeFileSync(path.join(sourceRoot, 'notes.txt'), Buffer.from('notes'));

  // .git directory (should be ignored).
  mkdirSync(path.join(sourceRoot, '.git'));
  writeFileSync(path.join(sourceRoot, '.git', 'config'), Buffer.from('[core]'));
  writeFileSync(path.join(sourceRoot, '.git', 'HEAD'), Buffer.from('ref: refs/heads/main'));
  mkdirSync(path.join(sourceRoot, '.git', 'objects'));
  writeFileSync(path.join(sourceRoot, '.git', 'objects', 'abc123'), Buffer.from('x'));

  // node_modules directory (should be ignored).
  mkdirSync(path.join(sourceRoot, 'node_modules'));
  writeFileSync(path.join(sourceRoot, 'node_modules', 'pkg.json'), Buffer.from('{}'));
  mkdirSync(path.join(sourceRoot, 'node_modules', 'pkg'));
  writeFileSync(path.join(sourceRoot, 'node_modules', 'pkg', 'index.js'), Buffer.from('//'));

  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath,
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, 'user-data'),
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_LINKED_SOURCE: sourceRoot,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await expect(window.getByRole('heading', { name: '导入资产以开始整理' })).toBeVisible();
    await waitForLibraryLoadingToFinish(window);

    await openLinkedFolderImportMenu(application, window);
    await expect(window.getByRole('button', { name: 'source', exact: true })).toBeVisible({ timeout: 15_000 });
    await window.getByRole('button', { name: 'source', exact: true }).click();

    // Only the real assets should be visible.
    await expect(window.getByText('hero.png', { exact: true })).toBeVisible();
    await expect(window.getByText('notes.txt', { exact: true })).toBeVisible();

    // .git and node_modules contents must NOT appear as assets.
    await expect(window.getByText('config', { exact: true })).toHaveCount(0);
    await expect(window.getByText('HEAD', { exact: true })).toHaveCount(0);
    await expect(window.getByText('abc123', { exact: true })).toHaveCount(0);
    await expect(window.getByText('pkg.json', { exact: true })).toHaveCount(0);
    await expect(window.getByText('index.js', { exact: true })).toHaveCount(0);

    const assets = await listAllAssets(window);
    const relativePaths = assets.map((asset) => asset.displayName).sort();
    expect(relativePaths).toEqual(['hero.png', 'notes.txt']);
    expect(assets.every((asset) => asset.availability === 'available')).toBe(true);

    const testInfo = test.info();
    const screenshot = testInfo.outputPath('linked-filter-rules.png');
    await window.screenshot({ path: screenshot });
    await testInfo.attach('linked-filter-rules', { path: screenshot, contentType: 'image/png' });
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

// WorldlineBox-316493: 文件夹右键 →「导入链接文件夹」把磁盘目录链接为该文件夹的子级。
// The import itself is driven through the typed bridge so the assertion is not
// coupled to the native folder picker; the menu entry itself is asserted
// separately (managed only, never on a linked folder).
test('imports a linked folder as a child of a managed folder', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linked-child-e2e-'));
  const sourceRoot = path.join(temporaryRoot, 'source');
  const libraryName = '链接子文件夹验收';
  const libraryPath = path.join(temporaryRoot, libraryName);
  mkdirSync(sourceRoot);
  writeFileSync(path.join(sourceRoot, 'a.png'), Buffer.from('aaa'));
  mkdirSync(path.join(sourceRoot, 'sub'));
  writeFileSync(path.join(sourceRoot, 'sub', 'b.png'), Buffer.from('bbb'));

  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath,
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, 'user-data'),
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_LINKED_SOURCE: sourceRoot,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole('textbox', { name: '名称' }).fill(libraryName);
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await waitForLibraryLoadingToFinish(window);

    await window.waitForTimeout(2500);
    await window.getByRole('button', { name: '添加文件夹' }).click();
    const folderInput = window.locator('.nav-inline-edit input');
    await expect(folderInput).toBeVisible();
    await folderInput.fill('Alpha');
    await folderInput.press('Enter');
    const alphaRow = window.locator(
      '.navigation-pane button.nav-row[data-nav-folder-kind="managed"][title="Alpha"]',
    );
    await expect(alphaRow).toBeVisible({ timeout: 10_000 });
    const alphaId = await alphaRow.getAttribute('data-nav-folder-id');
    expect(alphaId).toBeTruthy();

    // The real user path: right-click the managed folder → 导入链接文件夹.
    await alphaRow.click({ button: 'right' });
    const alphaMenu = window.getByRole('menu', { name: '文件夹操作：Alpha', exact: true });
    await expect(alphaMenu).toBeVisible();
    await alphaMenu.getByRole('menuitem', { name: '导入链接文件夹' }).click();

    // The sidebar renders the link under Alpha (one level deeper than Alpha).
    // Linked rows carry the absolute path in `title`, so match the row label.
    const linkedRow = window
      .locator('.navigation-pane button.nav-row[data-nav-folder-kind="linked"]')
      .filter({ has: window.locator('.nav-row-label', { hasText: /^source$/ }) });
    await expect(linkedRow).toBeVisible({ timeout: 15_000 });

    // …and the worker stored the parent relationship.
    expect(
      await window.evaluate(async (parentId) => {
        const api = (
          globalThis as typeof globalThis & {
            worldlinebox: {
              library: {
                listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
                listLinkedFolders(input: { libraryId: string }): Promise<{
                  ok: boolean;
                  value?: Array<{ relativePath?: string; parentFolderId?: string | null }>;
                }>;
              };
            };
          }
        ).worldlinebox.library;
        const open = await api.listOpen();
        const libraryId = open.value?.[0]?.libraryId;
        if (!libraryId) return null;
        const listed = await api.listLinkedFolders({ libraryId });
        const roots = (listed.value ?? []).filter((folder) => (folder.relativePath ?? '') === '');
        return roots.length === 1 && roots[0]?.parentFolderId === parentId;
      }, alphaId),
    ).toBe(true);
    const depth = await window.evaluate(() => {
      const paddingForLabel = (kind: string, label: string) => {
        const rows = [
          ...document.querySelectorAll<HTMLElement>(
            `.navigation-pane button.nav-row[data-nav-folder-kind="${kind}"]`,
          ),
        ];
        const row = rows.find(
          (candidate) =>
            candidate.querySelector('.nav-row-label')?.textContent?.trim() === label,
        );
        return row?.closest<HTMLElement>('.nav-tree-row')?.style.paddingLeft ?? null;
      };
      return {
        alpha: paddingForLabel('managed', 'Alpha'),
        linked: paddingForLabel('linked', 'source'),
      };
    });
    // Root-level managed folders sit at depth 0; the linked child hangs one
    // level below (14px per level).
    expect(depth).toEqual({ alpha: '0px', linked: '14px' });

    // The menu entry is offered on a managed folder…
    await alphaRow.click({ button: 'right' });
    const menu = window.getByRole('menu', { name: '文件夹操作：Alpha', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '导入链接文件夹' })).toBeVisible();
    await window.keyboard.press('Escape');

    // …and never on a linked folder (linked-in-linked stays unsupported).
    await linkedRow.click({ button: 'right' });
    const linkedMenu = window.getByRole('menu', { name: '文件夹操作：source', exact: true });
    await expect(linkedMenu).toBeVisible();
    await expect(linkedMenu.getByRole('menuitem', { name: '导入链接文件夹' })).toHaveCount(0);
    await window.keyboard.press('Escape');

    // The same directory again is rejected with the dedicated reason.
    const rejection = await window.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          worldlinebox: {
            library: {
              listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
              importFolderAsLinked(input: {
                libraryId: string;
              }): Promise<{ ok: boolean; error?: { code: string; reason?: string } }>;
            };
          };
        }
      ).worldlinebox.library;
      const open = await api.listOpen();
      const libraryId = open.value?.[0]?.libraryId;
      if (!libraryId) return null;
      const result = await api.importFolderAsLinked({ libraryId });
      return result.ok ? null : { code: result.error?.code, reason: result.error?.reason };
    });
    expect(rejection).toEqual({
      code: 'INVALID_IMPORT_SOURCE',
      reason: 'LINKED_SOURCE_ALREADY_LINKED',
    });
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
