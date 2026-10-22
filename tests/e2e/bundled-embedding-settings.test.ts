import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { removeCompanionTestDirectory, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern
test('shows the bundled embedding model ready without installation and keeps model settings compact in both themes', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-embedding-settings-')), profile = path.join(root, 'profile');
  const packaged = process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ executablePath: packaged ?? resolveElectronExecutablePath(),
      args: packaged ? [] : [resolveElectronAppPath()], cwd: packaged ? path.dirname(packaged) : resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
    if (packaged) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    const output = path.resolve('.tools/test-output/companions'); mkdirSync(output, { recursive: true });
    for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 860]] as const) {
      await native.evaluate((win, width) => win.setSize(width, 960), width);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
      await settings.getByRole('tab', { name: '外观', exact: true }).click();
      await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
      await settings.getByRole('radio', { name: theme === 'dark' ? '暗色' : '亮色', exact: true }).click();
      await settings.getByRole('tab', { name: '全局模型', exact: true }).click();
      const model = settings.getByRole('listitem', { name: '内置多模态向量服务', exact: true });
      await model.scrollIntoViewIfNeeded();
      await expect(model.getByRole('status')).toHaveText('文件已就绪', { timeout: 30_000 });
      await expect(model.getByRole('button', { name: '验证与修复', exact: true })).toBeEnabled();
      expect(await model.getByRole('button', { name: /准备|安装|下载/ }).count()).toBe(0);
      const geometry = await model.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, height: node.getBoundingClientRect().height }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      expect(geometry.height).toBeLessThan(260);
      const devices = settings.getByRole('region', { name: '设备能力', exact: true });
      const vector = devices.getByRole('article', { name: '本地向量设备检测', exact: true });
      await devices.scrollIntoViewIfNeeded();
      await expect(vector.getByRole('status')).toHaveText('未检测');
      await expect(vector.getByRole('button', { name: '检测设备', exact: true })).toBeEnabled();
      const graphics = devices.getByRole('article', { name: '3D 世界设备检测', exact: true });
      await graphics.getByRole('button', { name: /检测设备|重新检测/ }).click();
      await expect(graphics.getByRole('status')).toHaveText(/可以使用|设备受限/);
      if (await graphics.getByRole('status').textContent() === '可以使用') await expect(graphics).toContainText('通过基础检查');
      else await expect(graphics).toContainText('伙伴聊天与世界生活仍可继续');
      // The independent 1x1 graphics check must not start the bundled model.
      await expect(vector.getByRole('status')).toHaveText('未检测');
      const deviceGeometry = await devices.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
      expect(deviceGeometry.scroll).toBeLessThanOrEqual(deviceGeometry.width + 1);
      const screenshot = path.join(output, `verified-embedding-settings-${theme}-${width}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`${theme}-${width}`, { path: screenshot, contentType: 'image/png' });
      await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
    }
    expect(existsSync(path.join(profile, 'companions'))).toBe(false);
    expect(existsSync(path.join(profile, 'embedding-models', 'embeddinggemma-2-UD-Q4_K_XL.gguf'))).toBe(false);
    expect(existsSync(path.join(profile, 'embedding-models', 'mmproj-Q8_0.gguf'))).toBe(false);
  } finally {
    await application?.close().catch(() => undefined);
    cleanup(root);
  }
});
function cleanup(root: string): void {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-embedding-settings-')) throw new Error('Unexpected settings fixture cleanup target.');
  removeCompanionTestDirectory(root);
}
