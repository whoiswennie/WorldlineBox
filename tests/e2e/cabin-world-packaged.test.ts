import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import bundledRelease from '../../resources/dsh-runtime-release.json';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';
import type { DshLauncherRequest, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';

test.skip(process.platform !== 'win32' || !process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE, 'Requires the packaged Windows application.');

// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('provisions packaged DSH and runs Cabin World 1.1 without external downloads', async ({}) => {
  test.setTimeout(600000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'wlb-cabin-packaged-'));
  await mkdir(path.join(profile, 'network'));
  await writeFile(path.join(profile, 'network', 'network.json'), JSON.stringify({
    proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:1', proxyRouting: 'global', proxyProfiles: [],
    npmRegistry: 'https://registry.npmjs.org', pythonIndex: 'https://pypi.org/simple', githubMirror: 'direct', githubMirrorUrl: '',
  }));
  const launch = () => electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1',
    WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
    npm_config_offline: 'true', npm_config_store_dir: path.join(profile, 'pnpm-store'),
  }) });
  let app = await launch();
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    let page = await app.firstWindow();
    const request = (input: DshLauncherRequest) => page.evaluate(value => (window as unknown as {
      worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi };
    }).worldlinebox.dshLauncher.request(value), input);
    const state = async () => {
      const result = await request({ type: 'state' });
      if (!result.ok || !result.state) throw new Error(result.ok ? 'No launcher state.' : result.error);
      return result.state;
    };
    await expect.poll(async () => (await state()).operations.find(operation => operation.kind === 'runtime.bundle')?.status,
      { timeout: 360000 }).toBe('succeeded');
    const provisioned = await state();
    expect(provisioned.network?.settings.proxyUrl).toBe('http://127.0.0.1:1');
    expect(provisioned.runtimes).toEqual([expect.objectContaining({ version: bundledRelease.version })]);
    expect(provisioned.instances).toEqual([expect.objectContaining({ isBundled: true, isDefault: true, runtimeId: provisioned.runtimes[0]!.id })]);
    const instance = provisioned.instances[0]!;
    const open = await request({ type: 'instance.open', instanceId: instance.id });
    expect(open.ok).toBe(true);
    await expect.poll(() => app.windows().some(window => window.url().startsWith('http://127.0.0.1:')), { timeout: 120000 }).toBe(true);
    await app.windows().find(window => window.url().startsWith('http://127.0.0.1:'))!.close();

    await page.locator('[data-application-module="dsh"]').click();
    await page.getByRole('navigation', { name: '应用', exact: true }).getByRole('button', { name: '小屋世界', exact: true }).click();
    await page.getByRole('button', { name: '启动小屋世界', exact: true }).click();
    const status = page.getByRole('status').filter({ hasText: 'V1.1.0' });
    await expect(status).toContainText('游戏在线', { timeout: 90000 });
    expect(await request({ type: 'cabin.open' })).toMatchObject({ ok: true });
    const config = JSON.parse(await readFile(path.join(profile, 'cabin-world/bridge.json'), 'utf8')) as { url: string; token: string };
    const response = await fetch(config.url + '/v1/health', { signal: AbortSignal.timeout(5000) });
    expect(await response.json()).toMatchObject({ ok: true, game: true, resident: 'xiaojingyu' });
    const plan = await fetch(config.url + '/v1/tool', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cabin_update_plan', arguments: {} }),
    }).then(result => result.json()) as { modules: Array<{ state: string }> };
    expect(plan.modules).toHaveLength(11);
    expect(plan.modules.every(module => module.state === 'on')).toBe(true);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(status).toContainText('已停止');
    await expect.poll(async () => fetch(config.url + '/v1/health', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)).toBe(false);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    const restarted = await state();
    expect(restarted.instances.map(item => item.id)).toEqual([instance.id]);
    expect(restarted.operations.filter(operation => operation.kind === 'runtime.bundle')).toHaveLength(1);
  } finally { await app.close(); removeCompanionTestDirectory(profile); }
});
