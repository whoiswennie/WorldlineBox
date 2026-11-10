import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { createServer as createPageServer } from 'node:http';
import { _electron as electron, expect, test } from '@playwright/test';
import type { DshRuntime } from '../../src/shared/dsh-launcher';
import type { WorldlineBoxMcpSettingsApi } from '../../src/shared/mcp';
import type { WorldlineBoxBrowserApi } from '../../src/shared/browser';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { seedNativeRuntime } from './fixtures/dsh-native-runtime';

// eslint-disable-next-line no-empty-pattern -- Launches an isolated real Electron application.
test('composer Apps connects assets on demand and attaches/removes independent browser and asset cards', async ({}, testInfo) => {
  test.setTimeout(180000);
  const manager = path.join(process.env.APPDATA!, 'WorldlineBox', 'dsh');
  const runtimes = JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')) as DshRuntime[];
  const runtime = runtimes.find(item => item.version === '0.2.2-rc.1'); test.skip(!runtime, 'Requires a sealed installed DSH runtime.');
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-apps-ui-')); await seedNativeRuntime(manager, runtime!, profile);
  const port = await new Promise<number>((resolve, reject) => { const probe = createServer(); probe.on('error', reject); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)); }); });
  await writeFile(path.join(profile, 'mcp-settings.json'), JSON.stringify({ version: 1, preferences: { enabled: false, autoStart: false, port } }));
  const pageServer = createPageServer((_request, response) => response.end('<!doctype html><title>伙伴应用验收页</title><h1>Owned application page</h1>'));
  await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve)); const pageUrl = 'http://127.0.0.1:' + (pageServer.address() as { port: number }).port;
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1' }) });
  try {
    const page = await application.firstWindow(); const native = await application.browserWindow(page); await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 960); });
    await page.locator('[data-application-module="companions"]').click();
    const setup = page.locator('[data-shared-dsh-setup]'); await setup.getByRole('combobox', { name: '选择 DSH 版本' }).selectOption(runtime!.id);
    await setup.getByRole('button', { name: '创建并共享', exact: true }).click(); await expect(page.locator('.bot-composer textarea')).toBeVisible();
    const mcp = () => page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { mcp: WorldlineBoxMcpSettingsApi }).mcp.request({ type: 'get' }));
    expect((await mcp()).snapshot?.runtime.status).toBe('stopped');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '连接应用', exact: true }); await expect(picker).toBeVisible();
    await expect(picker.locator('.bot-app-choice')).toHaveCount(2); expect((await mcp()).snapshot?.runtime.status).toBe('stopped');
    const bounds = await picker.boundingBox(), viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(bounds!.x).toBeGreaterThan(0); expect(bounds!.y).toBeGreaterThan(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    const evidence = path.resolve('artifacts/companion-apps'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); await testInfo.attach(name, { path: file, contentType: 'image/png' }); };
    await capture('application-picker');
    await picker.getByRole('button', { name: /资产管理器/ }).click(); await expect(page.locator('.bot-composer-dock [data-app-id="asset-manager"]')).toBeVisible();
    const state = await mcp(); expect(state.snapshot?.runtime.status).toBe('running'); expect(state.snapshot?.credentials).toHaveLength(1);
    // A real browser page reference is supplied by the production browser API.
    await page.evaluate(async url => { const api = (Reflect.get(window, 'worldlinebox') as { browser: WorldlineBoxBrowserApi }).browser; const result = await api.request({ type: 'tab.new', url }); if (!result.ok) throw Error(result.error); }, pageUrl);
    await page.getByRole('button', { name: '应用', exact: true }).click(); await page.getByRole('dialog', { name: '连接应用', exact: true }).getByRole('button', { name: /内置浏览器/ }).click();
    await expect(page.getByRole('button', { name: '移除网页上下文', exact: true })).toBeVisible();
    await capture('applications-attached');
    await page.getByRole('button', { name: '移除网页上下文', exact: true }).click(); await expect(page.locator('.bot-composer-dock [data-app-id="asset-manager"]')).toBeVisible();
    await page.getByRole('button', { name: '移除资产管理器', exact: true }).click(); await expect(page.locator('.bot-composer-dock [data-app-id="asset-manager"]')).toHaveCount(0);
    await expect(page.locator('.bot-composer-dock [data-browser-context-tab]')).toHaveCount(0);
    await writeFile(path.join(evidence, 'ui-result.json'), JSON.stringify({ passed: true, realElectron: true, profile, autoStartedOnlyOnSelection: true, noCredentialCopy: true, independentAppRemoval: true }, null, 2));
  } finally { await application.close(); pageServer.closeAllConnections(); await new Promise<void>(resolve => pageServer.close(() => resolve())); }
});
