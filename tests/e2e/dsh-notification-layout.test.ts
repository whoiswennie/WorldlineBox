import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DshRuntime } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function geometry(page: Page) {
  return page.locator('.launcher-main').evaluate((main) => {
    const heading = main.querySelector('.launcher-page-heading')!.getBoundingClientRect();
    const card = main.querySelector('.launcher-card')?.getBoundingClientRect();
    return { heading: [heading.x, heading.y, heading.width, heading.height], card: card ? [card.x, card.y, card.width, card.height] : null, scrollTop: main.scrollTop };
  });
}

test('launcher notices do not shift headings, cards or scroll positions', async () => {
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'Launcher adapter is Windows x64.');
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-dsh-notice-'));
  const profile = path.join(root, 'user-data');
  const launcherRoot = path.join(profile, 'dsh-launcher');
  await mkdir(path.join(launcherRoot, 'operations'), { recursive: true });
  const runtimes: DshRuntime[] = Array.from({ length: 10 }, (_, index) => ({
    id: randomUUID(), version: `0.2.0-layout-${index}`, nodeVersion: '24.18.1', electronVersion: '44.0.0',
    platform: 'win32-x64', adapter: 'desktop-cli-web-v1', source: 'layout-test-fixture',
    sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), installedAt: '2026-10-12T00:00:00Z', fileCount: 1, byteLength: 1,
  }));
  // Valid registry entries with absent programs intentionally exercise the real
  // verification failure path; this test does not fetch or launch a DSH client.
  await writeFile(path.join(launcherRoot, 'runtimes.json'), JSON.stringify(runtimes));
  await writeFile(path.join(launcherRoot, 'operations', 'operations.json'), JSON.stringify([{
    id: randomUUID(), kind: 'runtime.verify', label: '旧失败记录', status: 'failed', phase: 'failed',
    startedAt: '2026-10-12T00:00:00Z', error: 'Historical failure stays in history',
  }]));
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
  }) });
  try {
    const page = await application.firstWindow();
    await (await application.browserWindow(page)).evaluate((window) => { window.unmaximize(); window.setSize(1440, 900); window.hide(); });
    const navigation = page.locator('.launcher-navigation');
    await expect(page.locator('[data-dsh-notification]')).toHaveCount(0);
    await navigation.getByRole('button', { name: '运行版本', exact: true }).click();
    await expect(page.locator('[data-dsh-runtime]')).toHaveCount(10);
    await page.evaluate(() => document.fonts.ready);
    const runtimeBefore = await geometry(page);
    await navigation.getByRole('button', { name: '操作记录', exact: true }).click();
    const operationsBefore = await geometry(page);
    const clear = page.getByRole('button', { name: '清理已结束记录', exact: true });
    await clear.click();
    const notification = page.locator('[data-dsh-notification]');
    await expect(notification.getByRole('status')).toContainText('已清理 1 条');
    const operationsAfter = await geometry(page);
    expect(operationsAfter.heading).toEqual(operationsBefore.heading);
    expect(operationsAfter.scrollTop).toBe(operationsBefore.scrollTop);
    expect(await page.locator('.launcher-main [role="status"]').count()).toBe(0);
    const toastBox = (await notification.boundingBox())!;
    const clearBox = (await clear.boundingBox())!;
    expect(toastBox.y).toBeGreaterThan(clearBox.y + clearBox.height);
    await navigation.getByRole('button', { name: '运行版本', exact: true }).click();
    expect(await geometry(page)).toEqual(runtimeBefore);
    await page.mouse.move(0, 0);
    await expect(notification).toHaveCount(0, { timeout: 7_000 });
    expect(await geometry(page)).toEqual(runtimeBefore);

    await page.locator('.launcher-main').evaluate((main) => { main.scrollTop = 128; });
    const beforeFailure = await geometry(page);
    await page.locator('[data-dsh-runtime]').first().getByRole('button', { name: '校验运行文件', exact: true }).click();
    await expect(notification.getByRole('alert')).toBeVisible();
    expect(await geometry(page)).toEqual(beforeFailure);
    expect(await page.locator('.launcher-main [role="alert"]').count()).toBe(0);
    await notification.getByRole('button', { name: '详细信息', exact: true }).click();
    await expect(notification.locator('.launcher-notice-details')).toContainText('ENOENT');
    expect(await geometry(page)).toEqual(beforeFailure);
    await page.screenshot({ path: test.info().outputPath('floating-error-notice.png') });
    await notification.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(notification).toHaveCount(0);
    expect(await geometry(page)).toEqual(beforeFailure);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(notification).toHaveCount(0);
  } finally {
    await application.close();
    if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-dsh-notice-')) await rm(root, { recursive: true, force: true });
  }
});
