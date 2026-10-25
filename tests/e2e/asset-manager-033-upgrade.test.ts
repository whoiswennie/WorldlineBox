import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import {
  electronLaunchEnv, importFilesThroughBridge,
  removeCompanionTestDirectory, resolveElectronAppPath, resolveElectronExecutablePath,
} from './electron-test-helpers';

test('drops a file after unfavoriting it in a filtered view and honors customized copy-path keys', async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-033-browse-'));
  const source = path.join(root, 'membership.txt');
  writeFileSync(source, 'WorldlineBox filtered browse regression');
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1',
        WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile'),
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root,
        WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: path.join(root, 'Browse 033'),
        WORLDLINEBOX_E2E_IMPORT_FILES: source,
      }),
    });
    const page = await application.firstWindow();
    await page.locator('[data-application-module="assets"]').click();
    await page.getByRole('button', { name: '创建资源库', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('Browse 033');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await importFilesThroughBridge(page);
    const card = page.locator('.asset-card[data-asset-name="membership.txt"]');
    await expect(card).toBeVisible();
    await card.click();

    const platform = process.platform === 'darwin' ? 'mac' : 'windows';
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
    await settings.getByRole('tab', { name: '快捷键', exact: true }).click();
    await settings.getByRole('searchbox', { name: '搜索动作或按键' }).fill('复制文件路径');
    const row = settings.locator('.shortcut-settings-row').filter({ hasText: '复制文件路径' });
    await row.getByRole('button', { name: '更改', exact: true }).click();
    await page.keyboard.press('Control+Shift+F8');
    await row.getByRole('button', { name: '确认', exact: true }).click();
    await expect(row.locator('.shortcut-keycap')).toContainText('F8');
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await card.click();
    await application.evaluate(({ clipboard }) => clipboard.writeText('custom-path-sentinel'));
    await page.keyboard.press('Control+Shift+F8');
    await expect.poll(() => application!.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(/membership\.txt$/u);
    await application.evaluate(({ clipboard }) => clipboard.writeText('default-path-disabled'));
    await page.keyboard.press(platform === 'mac' ? 'Alt+Meta+C' : 'Control+Shift+C');
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('default-path-disabled');

    await page.getByRole('button', { name: '标记喜欢', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消喜欢', exact: true })).toBeVisible();
    const favoritesOnly = page.getByRole('button', { name: '仅喜欢', exact: true });
    await favoritesOnly.click();
    await expect(card).toBeVisible();
    await card.click();
    await page.getByRole('button', { name: '取消喜欢', exact: true }).click();
    // The local membership update precedes the delayed database reconciliation.
    await expect(card).toHaveCount(0, { timeout: 1_400 });
    await favoritesOnly.click();
    await expect(card).toBeVisible();
  } finally {
    await application?.close();
    removeCompanionTestDirectory(root);
  }
});
