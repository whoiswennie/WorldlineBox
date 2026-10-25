import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { BrowserStore } from '../../src/main/browser/store';
import type { WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('saved operation, download and browsing histories search all records while rendering only the current page', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-record-pagination-'));
  const profile = path.join(root, 'profile');
  const journal = path.join(profile, 'dsh', 'operations');
  await mkdir(journal, { recursive: true });
  const startedAt = '2026-10-18T00:00:00Z';
  await writeFile(path.join(journal, 'operations.json'), JSON.stringify(Array.from({ length: 55 }, (_, index) => ({
    id: 'fixture-operation-' + index, kind: 'runtime.verify', label: '分页操作 ' + index,
    status: index === 54 ? 'failed' : 'succeeded', phase: index === 54 ? 'failed' : 'completed', startedAt,
    ...(index === 54 ? { error: '唯一的证书检查失败' } : {}),
  }))));
  const store = new BrowserStore(path.join(profile, 'browser')); await store.init();
  store.data.downloads = Array.from({ length: 125 }, (_, index) => ({ id: 'download-' + index,
    url: `https://fixture.invalid/archive-${index}.zip`, filename: `archive-${index}.zip`, path: '', received: 1, total: 1,
    status: index === 124 ? 'interrupted' : 'completed', startedAt }));
  store.data.history = Array.from({ length: 125 }, (_, index) => ({ id: 'history-' + index,
    url: `https://fixture.invalid/page-${index}`, title: 'History ' + index, visitedAt: startedAt }));
  await store.flush();
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(),
    args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
  try {
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await application.firstWindow();
    await (await application.browserWindow(page)).evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    // The navigation rail paints before the lazy launcher finishes preparing
    // its CLI and reading the journal. Wait for real service readiness before
    // checking pagination; the regular UI assertions retain their short waits.
    await expect.poll(() => page.evaluate(async () => {
      const response = await (globalThis as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request({ type: 'state' });
      return response.ok ? { ok: true, operationCount: response.state?.operations.length } : { ok: false, error: response.error };
    }), { timeout: 30_000, message: 'The launcher must load the 55 seeded journal entries before checking rendered pages.' }).toEqual({ ok: true, operationCount: 55 });
    await page.locator('.launcher-navigation').getByRole('button', { name: '操作记录', exact: true }).click();
    await expect(page.locator('[data-dsh-operation]')).toHaveCount(20);
    const operationPages = page.getByRole('navigation', { name: '操作记录分页' });
    await operationPages.getByRole('button', { name: '下一页', exact: true }).click();
    await operationPages.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.locator('[data-dsh-operation]')).toHaveCount(15);
    await page.getByRole('textbox', { name: '搜索操作记录' }).fill('证书检查');
    await expect(page.locator('[data-dsh-operation]')).toHaveCount(1);
    await expect(page.locator('[data-dsh-operation]')).toHaveAttribute('data-dsh-operation', 'fixture-operation-54');
    await page.getByRole('button', { name: '清理已结束记录', exact: true }).click();
    await expect(page.locator('[data-dsh-operation]')).toHaveCount(0);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(operationPages).toBeHidden();

    await page.locator('[data-application-module="browser"]').click();
    await expect(page.locator('.browser-tabs [role="tab"]')).toHaveCount(1);
    await page.getByRole('button', { name: '下载', exact: true }).click();
    await expect(page.locator('.browser-downloads > li')).toHaveCount(20);
    const downloads = page.locator('.browser-download-pages');
    for (let index = 0; index < 6; index++) await downloads.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.locator('.browser-downloads > li')).toHaveCount(5);
    await page.getByRole('searchbox', { name: '搜索文件名、网址或错误' }).fill('archive-124.zip');
    await expect(page.locator('.browser-downloads > li')).toHaveCount(1);
    await expect(page.locator('.browser-downloads > li strong')).toHaveText('archive-124.zip');

    await page.getByRole('button', { name: '历史记录', exact: true }).click();
    await expect(page.locator('.browser-records > li')).toHaveCount(50);
    const history = page.locator('.browser-panel .browser-actions').filter({ has: page.getByRole('button', { name: '下一页', exact: true }) });
    await history.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.locator('.browser-records > li strong').first()).toHaveText('History 50');
    await history.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.locator('.browser-records > li')).toHaveCount(25);
    await page.getByRole('textbox', { name: '搜索历史记录' }).fill('page-124');
    await expect(page.locator('.browser-records > li')).toHaveCount(1);
    await expect(page.locator('.browser-records > li strong')).toHaveText('History 124');
  } finally { await application.close(); }
});
