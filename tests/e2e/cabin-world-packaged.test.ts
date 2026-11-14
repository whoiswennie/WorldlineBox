import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

test.skip(process.platform !== 'win32' || !process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE, 'Requires the packaged Windows application.');

// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('launches and stops the packaged Cabin World from an empty user profile', async ({}) => {
  test.setTimeout(90000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'wlb-cabin-packaged-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1',
    WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await app.firstWindow();
    await page.locator('[data-application-module="dsh"]').click();
    await page.getByRole('navigation', { name: '应用', exact: true }).getByRole('button', { name: '小屋世界', exact: true }).click();
    await page.getByRole('button', { name: '启动小屋世界', exact: true }).click();
    const status = page.getByRole('status').filter({ hasText: 'V1.0.0' });
    await expect(status).toContainText('游戏在线', { timeout: 35000 });
    const config = JSON.parse(await readFile(path.join(profile, 'cabin-world/bridge.json'), 'utf8')) as { url: string; pid: number };
    const response = await fetch(config.url + '/v1/health', { signal: AbortSignal.timeout(5000) });
    expect(await response.json()).toMatchObject({ ok: true, game: true, resident: 'xiaojingyu' });
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(status).toContainText('已停止');
    await expect.poll(async () => fetch(config.url + '/v1/health', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)).toBe(false);
  } finally { await app.close(); removeCompanionTestDirectory(profile); }
});
