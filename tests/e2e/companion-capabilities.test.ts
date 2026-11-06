import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { DshLauncherRequest, DshLauncherResponse, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { dshRuntimeSchema } from '../../src/shared/dsh-launcher';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';
import { seedNativeRuntime } from './fixtures/dsh-native-runtime';

async function request(page: Page, input: DshLauncherRequest) {
  return page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { dshLauncher: WorldlineBoxDshLauncherApi }).dshLauncher.request(input), input);
}
async function state(page: Page): Promise<DshLauncherState> { const result = await request(page, { type: 'state' }); if (!result.ok || !result.state) throw Error(result.ok ? 'No native launcher state' : result.error); return result.state; }
function removeProfile(root: string) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('wlb-capabilities-ui-')) throw Error('Unexpected capability fixture directory');
  removeCompanionTestDirectory(root);
}

// Actual Electron, Main, native plugin manager and native registry. No model
// turn, account copy, mocked Host event, or fabricated capability is used.
// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('manages a companion’s private native plugins and callable capabilities through the box', async ({}, testInfo) => {
  test.setTimeout(900000);
  const program = process.env.WORLDLINEBOX_CAPABILITIES_NATIVE_PROGRAM;
  test.skip(!program, 'Needs a real staged native DSH program directory.');
  const manifest = JSON.parse(await readFile(path.join(program!, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')) as { version: string };
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-capabilities-ui-')), profile = path.join(root, 'profile'), plugin = path.join(root, 'fixture-plugin');
  const manager = path.resolve(program!, '../../..');
  const runtimes = (JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')) as unknown[]).map(value => dshRuntimeSchema.parse(value));
  const runtime = runtimes.find(runtime => path.resolve(manager, 'runtimes', runtime.id, 'program').toLowerCase() === path.resolve(program!).toLowerCase());
  if (!runtime) throw Error('Capabilities acceptance needs a real admitted sealed runtime.');
  await seedNativeRuntime(manager, runtime, profile);
  await mkdir(plugin, { recursive: true });
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: '@wlb-test/ui-private-probe', version: '1.0.0', type: 'module', main: 'index.js', engines: { dsh: '>=0.2.0-0 <0.3.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(path.join(plugin, 'cordis.patch.yml'), "- insert:\n    - id: ui-private-probe\n      name: '@wlb-test/ui-private-probe'\n");
  await writeFile(path.join(plugin, 'index.js'), `export const name='ui-private-probe'; export const inject=['tools']; export function apply(ctx){ctx.tools.register({name:'wlb_private_probe',description:'UI_NATIVE_PRIVATE_PROBE',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',properties:{marker:{type:'string'}},required:['marker'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.marker}]},execute:async()=>({marker:'UI_NATIVE_PRIVATE_PROBE'})});}`);
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
    WORLDLINEBOX_E2E_DSH_DIRECTORY: program!, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  let latestCatalog: DshLauncherResponse | undefined;
  const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
  const capture = async (filename: string) => {
    await application.windows()[0]!.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    const image = testInfo.outputPath(filename); await writeFile(image, Buffer.from(png, 'base64')); await copyFile(image, path.join(evidence, filename));
  };
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow();
    await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => { const owned = BrowserWindow.getAllWindows()[0]!; owned.on('show', () => owned.hide()); owned.hide(); owned.setMinimumSize(0, 0); owned.setSize(1440, 960); owned.webContents.setBackgroundThrottling(false); });
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    await page.getByRole('button', { name: '能力', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '大肥鱼的能力', exact: true });
    await expect(dialog.getByText('使用共享能力', { exact: true })).toBeVisible({ timeout: 60000 });
    const before = await state(page);
    await dialog.getByRole('button', { name: '配置独立能力', exact: true }).click();
    await expect(dialog.getByText('独立能力环境', { exact: true })).toBeVisible({ timeout: 60000 });
    const binding = await request(page, { type: 'companion.environment.state', companionId: 'builtin-dafeiyu', name: '大肥鱼' });
    if (!binding.ok || !binding.companionEnvironment) throw Error('No private binding');
    const privateInstance = binding.companionEnvironment.instance;
    expect(binding.companionEnvironment.mode).toBe('private');
    expect(before.instances.some(instance => instance.id === privateInstance.id)).toBe(false);
    expect(before.runtimes.some(runtime => runtime.id === privateInstance.runtimeId && runtime.version === manifest.version)).toBe(true);
    await expect.poll(async () => {
      const instance = (await state(page)).instances.find(instance => instance.id === privateInstance.id);
      if (instance?.status === 'failed') throw Error(instance.lastError || 'Private native Host failed');
      return instance?.status;
    }, { timeout: 360000 }).toBe('running');
    await expect(dialog.locator('.companion-native-capabilities')).toBeVisible({ timeout: 120000 });
    await dialog.getByRole('button', { name: '原生插件与技能', exact: true }).click();
    await expect(dialog.locator('[data-installed-plugins]')).toHaveAttribute('data-installed-plugins', privateInstance.id);
    await dialog.getByRole('textbox', { name: '插件地址', exact: true }).fill('file:' + plugin.replaceAll('\\', '/'));
    await dialog.getByRole('button', { name: '安装插件', exact: true }).click();
    await expect.poll(async () => {
      const operation = (await state(page)).operations.filter(item => item.instanceId === privateInstance.id && item.kind === 'instance.plugin')[0];
      if (operation?.status === 'failed') throw Error(operation.error);
      return operation?.status;
    }, { timeout: 180000 }).toBe('succeeded');
    const installed = dialog.locator('[data-installed-plugin="@wlb-test/ui-private-probe"]');
    await expect(installed).toBeVisible({ timeout: 60000 });
    latestCatalog = await request(page, { type: 'companion.environment.capabilities', companionId: 'builtin-dafeiyu', name: '大肥鱼', query: { kind: 'catalog', category: 'tool', query: 'wlb_private_probe', offset: 0, limit: 30 } });
    await dialog.getByRole('button', { name: '可调用能力', exact: true }).click();
    await dialog.getByRole('textbox', { name: '搜索可调用能力', exact: true }).fill('wlb_private_probe');
    await expect(dialog.locator('[data-callable-capability="wlb_private_probe"]')).toBeVisible({ timeout: 120000 });
    await capture('companion-capabilities-dialog-native.png');
    await dialog.getByRole('button', { name: '原生插件与技能', exact: true }).click();
    await installed.getByRole('button', { name: '停用', exact: true }).click();
    await expect(installed.getByRole('button', { name: '启用', exact: true })).toBeVisible({ timeout: 120000 });
    await dialog.getByRole('button', { name: '可调用能力', exact: true }).click();
    await dialog.getByRole('textbox', { name: '搜索可调用能力', exact: true }).fill('wlb_private_probe');
    await expect(dialog.locator('[data-callable-capability="wlb_private_probe"]')).toHaveCount(0);
    await expect(dialog.getByText('没有匹配的可调用能力。', { exact: true })).toBeVisible({ timeout: 120000 });
    await dialog.getByRole('button', { name: '运行环境', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /保持连接/ }).check();
    await expect.poll(async () => (await state(page)).instances.find(instance => instance.id === privateInstance.id)?.keepAlive).toBe(true);
    await dialog.getByRole('button', { name: '关闭伙伴', exact: true }).click();
    await expect(dialog.getByText('伙伴已关闭', { exact: true })).toBeVisible();
    await expect.poll(async () => (await state(page)).instances.find(instance => instance.id === privateInstance.id)?.status, { timeout: 30000 }).toBe('stopped');
    await dialog.getByRole('button', { name: '刷新能力', exact: true }).click();
    await expect(dialog.locator('.companion-native-capabilities')).toHaveCount(0);
    await expect.poll(async () => (await state(page)).instances.find(instance => instance.id === privateInstance.id)?.status).toBe('stopped');
    await dialog.getByRole('button', { name: '关闭能力管理', exact: true }).click();
    await expect(page.locator('.bot-companion-disabled')).toContainText('大肥鱼已关闭');
    await expect(page.locator('.bot-composer')).toHaveCount(0);
    await expect(page.locator('.bot-chat-title-status')).toContainText('已关闭');
    await capture('companion-disabled-native.png');
    await page.locator('.bot-companion-disabled').getByRole('button', { name: '启用伙伴', exact: true }).click();
    await expect(page.locator('.bot-composer')).toBeVisible({ timeout: 60000 });
    await page.locator('[data-application-module="dsh"]').click();
    await page.getByRole('button', { name: '伙伴能力', exact: true }).click();
    await expect(page.locator('.companion-capabilities-page [data-companion-capabilities="builtin-dafeiyu"]')).toBeVisible();
    await expect(page.getByRole('combobox', { name: '选择伙伴', exact: true })).toBeVisible();
    await capture('companion-capabilities-native.png');
    const bot = await page.evaluate(async () => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' }));
    await writeFile(path.join(evidence, 'companion-capabilities-native-evidence.json'), JSON.stringify({ actualElectron: true, nativePluginManager: true, nativeRegistry: true, modelTurnsSubmitted: 0, runtimeVersion: manifest.version, privateInstanceId: privateInstance.id, sharedRuntimeId: privateInstance.runtimeId,
      installedByNativeAddress: true, callableRegistered: true, toggleRemovedCallable: true, disabledRefreshDidNotStartHost: true, boxRuntimeToggle: true, companionEnabled: bot.ok && bot.snapshot?.companions.find(person => person.id === 'builtin-dafeiyu')?.enabled !== false }, null, 2));
  } catch (failure) {
    const page = application.windows()[0];
    if (page) {
      await capture('companion-capabilities-failure.png').catch(() => undefined);
      const current = await state(page).catch(error => ({ error: String(error), instances: [] }));
      await testInfo.attach('native-launcher-state', { body: JSON.stringify(current, null, 2), contentType: 'application/json' });
      await testInfo.attach('native-post-install-catalog', { body: JSON.stringify(latestCatalog ?? {}, null, 2), contentType: 'application/json' });
      await testInfo.attach('capabilities-ui-text', { body: await page.locator('[data-companion-capabilities]').innerText().catch(() => 'Capabilities view is not open'), contentType: 'text/plain' });
      for (const instance of current.instances) {
        const log = await request(page, { type: 'instance.logs', instanceId: instance.id }).catch(error => ({ error: String(error) }));
        await testInfo.attach(`native-${instance.id}-log`, { body: JSON.stringify(log, null, 2), contentType: 'application/json' });
      }
    }
    throw failure;
  } finally {
    await application.close();
    removeProfile(root);
  }
});
