import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronLaunchEnv, openAppSettingsDialog, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('shows one usable pairing code when the remote tunnel is unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-phone-ui-'));
  const app = await electron.launch({
    executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: root,
      WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_MOBILE_PUBLIC_TEST: '1',
      WORLDLINEBOX_MOBILE_TUNNEL_HOSTNAME: 'fixture.invalid', WORLDLINEBOX_MOBILE_TUNNEL_TOKEN: '' }),
  });
  try {
    const page = await app.firstWindow();
    const dialog = await openAppSettingsDialog(app, page);
    await dialog.getByRole('tab', { name: '手机连接' }).click();
    await dialog.getByRole('button', { name: '显示配对二维码' }).click();
    await expect(dialog.getByRole('img', { name: '手机配对二维码' })).toBeVisible();
    await expect(dialog.getByText('远程 · 暂不可用')).toBeVisible();
    await dialog.getByRole('button', { name: '关闭服务' }).click();
    await expect(dialog.getByRole('img', { name: '手机配对二维码' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
