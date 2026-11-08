import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { DSH_LAUNCHER_CHANGED_CHANNEL, dshLauncherStateSchema, type DshLauncherState, type WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

// Actual renderer, preload validation and IPC. Launcher events below are explicit
// presentation fixtures; they do not claim to launch a real DSH or execute a model.
// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('requires deliberate private-instance setup and keeps group chat blocked until every member is bound', async ({}, testInfo) => {
  test.setTimeout(100000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-companion-binding-ui-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const evidence = path.resolve('artifacts/companion-binding-ui'); await mkdir(evidence, { recursive: true });
  try {
    await preparePackagedCompanionLaunch(app, profile);
    const page = await app.firstWindow();
    await app.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Binding UI acceptance requires its isolated profile.');
      const window = BrowserWindow.getAllWindows()[0]!;
      if (!window.webContents.isOffscreen()) throw Error('Binding UI acceptance requires offscreen rendering.');
      window.on('show', () => window.hide()); window.hide(); window.setMinimumSize(0, 0); window.setSize(1440, 900); window.webContents.setBackgroundThrottling(false);
    }, profile);
    await page.locator('[data-application-module="companions"]').click();
    const dialog = page.getByRole('dialog', { name: '为伙伴绑定 DSH' });
    await expect(dialog).toBeVisible(); await expect(dialog).toContainText('先安装一个 DSH 版本');
    await expect(page.locator('.bot-composer')).toHaveCount(0); await expect(page.getByRole('button', { name: '拨打伙伴电话' })).toBeDisabled();
    const source = await page.evaluate(async () => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi; dshLauncher: WorldlineBoxDshLauncherApi };
      const [botState, launcher] = await Promise.all([bridge.companionBot.request({ type: 'state' }), bridge.dshLauncher.request({ type: 'state' })]);
      if (!botState.ok || !botState.snapshot || !launcher.ok || !launcher.state) throw Error('Binding UI requires the native state APIs.');
      return { companions: botState.snapshot.companions, launcher: launcher.state };
    });
    const fish = source.companions.find(value => value.id === 'builtin-dafeiyu')!, gpt = source.companions.find(value => value.name === 'GPT')!;
    expect(fish).toBeDefined(); expect(gpt).toBeDefined();
    const runtime = { id: 'binding-ui-runtime', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64', adapter: 'node-cli-web-v1', source: 'ui-fixture', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: '', fileCount: 0, byteLength: 0 };
    const base = { id: 'binding-ui-default', name: '默认实例不代表角色绑定', runtimeId: runtime.id, profile: 'web', status: 'running', isDefault: true, homePath: profile, agentsPath: profile, workspacePath: profile, browserPartition: 'binding-ui-only', createdAt: '', updatedAt: '' };
    const supplied = dshLauncherStateSchema.parse({ ...source.launcher, supported: true, runtimes: [runtime], instances: [base], executionReadiness: undefined });
    const publish = async (state: DshLauncherState) => app.evaluate(({ BrowserWindow }, payload) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send(payload.channel, payload.state); }, { channel: DSH_LAUNCHER_CHANGED_CHANNEL, state });
    await publish(supplied); await expect(dialog.getByLabel('选择 DSH 版本')).toHaveValue(''); await expect(dialog.getByRole('button', { name: '确认创建并绑定' })).toBeDisabled();
    const measurements: unknown[] = [];
    for (const [width, height] of [[1440, 900], [850, 620], [640, 560]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), { width, height });
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
      const geometry = await dialog.evaluate(node => { const box = node.getBoundingClientRect(), footer = node.querySelector('footer')!.getBoundingClientRect(), main = node.querySelector('.bot-binding-main')!.getBoundingClientRect(), intro = node.querySelector('.bot-binding-intro')!.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, footerBottom: footer.bottom, introInset: intro.left - main.left, overflowX: node.scrollWidth > node.clientWidth + 1 }; });
      expect(geometry.x).toBeGreaterThanOrEqual(0); expect(geometry.y).toBeGreaterThanOrEqual(0); expect(geometry.width).toBeLessThanOrEqual(geometry.viewportWidth); expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportHeight); expect(geometry.overflowX).toBe(false);
      expect(geometry.introInset).toBeGreaterThanOrEqual(20);
      measurements.push(geometry);
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = path.join(evidence, `binding-dialog-${width}.png`); await writeFile(file, Buffer.from(png, 'base64')); await testInfo.attach(`binding-dialog-${width}`, { path: file, contentType: 'image/png' });
    }
    await dialog.getByRole('button', { name: '稍后设置' }).click(); await expect(dialog).toHaveCount(0); await expect(page.locator('.bot-composer')).toHaveCount(0);
    await page.getByRole('button', { name: '绑定实例', exact: true }).click(); await expect(dialog).toBeVisible();
    await dialog.getByLabel('选择 DSH 版本').selectOption(runtime.id); await expect(dialog.getByRole('button', { name: '确认创建并绑定' })).toBeEnabled();
    await dialog.getByRole('button', { name: '稍后设置' }).click();
    const group = await page.evaluate(async members => {
      const bot = Reflect.get(Reflect.get(window, 'worldlinebox'), 'companionBot') as WorldlineBoxBotApi;
      return bot.request({ type: 'conversation.create', title: '独立实例群聊验收', kind: 'group', memberIds: members });
    }, [fish.id, gpt.id]);
    expect(group.ok).toBe(true); await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: '独立实例群聊验收' }).click();
    await publish(supplied); await expect(dialog).toContainText('还需绑定 2 位伙伴');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 768));
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const groupPng = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await writeFile(path.join(evidence, 'binding-dialog-group.png'), Buffer.from(groupPng, 'base64'));
    const privateInstance = (owner: typeof fish) => ({ ...supplied.instances[0]!, id: `binding-ui-${owner.id.replaceAll('_', '-')}`, isDefault: false, status: 'stopped' as const, companionId: owner.id, companionName: owner.name });
    await publish({ ...supplied, instances: [...supplied.instances, privateInstance(fish)] });
    await expect(dialog).toContainText('还需绑定 1 位伙伴'); await expect(dialog.locator('.bot-binding-character>strong')).toHaveText(gpt.name); await expect(page.locator('.bot-composer')).toHaveCount(0);
    await publish({ ...supplied, instances: [...supplied.instances, privateInstance(fish), privateInstance(gpt)] });
    await expect(dialog).toHaveCount(0); await expect(page.locator('.bot-composer')).toBeVisible();
    await writeFile(path.join(evidence, 'evidence.json'), JSON.stringify({ actualElectron: true, presentationOnlyLauncherEvents: true, privateChatBlocked: true, explicitRuntimeChoice: true, cancelRemainsBlocked: true, groupAllMembersRequired: true, measurements }, null, 2));
  } finally { await app.close(); removeCompanionTestDirectory(profile); }
});
