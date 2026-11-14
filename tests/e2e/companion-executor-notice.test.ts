import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { DSH_LAUNCHER_CHANGED_CHANNEL, dshLauncherStateSchema, type DshInstance, type WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, preparePackagedCompanionLaunch, resolveElectronLaunchOptions, removeCompanionTestDirectory } from './electron-test-helpers';

// This exercises the actual app view and validated preload subscription. The
// state events are presentation fixtures, not real native Host starts.
// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('executor status remains compact and theme-integrated while starting, stopped and failed', async ({}, testInfo) => {
  test.setTimeout(90000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-executor-notice-'));
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow();
    await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    await application.evaluate(({ BrowserWindow }, expected) => {
      const owned = BrowserWindow.getAllWindows()[0]!;
      if (!owned.webContents.isOffscreen()) throw Error('Executor screenshots require offscreen rendering.');
      Reflect.set(globalThis, '__executorNoticeFrames', { count: 0 });
      owned.on('show', () => owned.hide()); owned.hide(); owned.webContents.setBackgroundThrottling(false);
      owned.webContents.on('paint', () => (Reflect.get(globalThis, '__executorNoticeFrames') as { count: number }).count++);
      if (process.getBuiltinModule('node:path').resolve(expected) !== expected) throw Error('Invalid isolated profile.');
    }, profile);
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const measurements: unknown[] = [];
    for (const [theme, width, height, preset] of [['light', 1440, 900, 'worldlinebox'], ['dark', 850, 620, 'worldlinebox'], ['light', 1440, 900, 'shuimo-danqing']] as const) {
      await application.evaluate(({ BrowserWindow }, size) => { const owned = BrowserWindow.getAllWindows()[0]!; owned.setMinimumSize(0, 0); owned.setSize(size.width, size.height); }, { width, height });
      await page.evaluate(({ theme, preset }) => {
        localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme }));
        localStorage.setItem('worldlinebox.theme-profile.v3', JSON.stringify({ version: 3, preset, overrides: {} }));
      }, { theme, preset });
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
      if (preset === 'shuimo-danqing') {
        await expect(page.locator('html')).toHaveAttribute('data-bg-main-panel', 'on');
        await expect.poll(() => page.locator('.app-animated-background-video').evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
      }
      const baseline = await page.evaluate(async () => (Reflect.get(window, 'worldlinebox') as { dshLauncher: WorldlineBoxDshLauncherApi }).dshLauncher.request({ type: 'state' }));
      if (!baseline.ok || !baseline.state) throw Error('No validated launcher state');
      const stamp = new Date().toISOString();
      const runtime = { id: 'notice-runtime', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64', adapter: 'node-cli-web-v1', source: 'ui-fixture', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: stamp, fileCount: 0, byteLength: 0 };
      const instance: DshInstance = { id: 'notice-only', name: '界面状态夹具', runtimeId: runtime.id, createdAt: stamp, updatedAt: stamp,
        profile: 'web', status: 'stopped', homePath: profile, agentsPath: profile, workspacePath: profile, browserPartition: 'notice-fixture', isDefault: true };
      const header = page.locator('.bot-chat-header'), transcript = page.locator('.bot-transcript');
      const notice = header.getByRole('complementary', { name: 'DSH 执行器状态' });
      const publish = async (status: DshInstance['status']) => {
        const state = dshLauncherStateSchema.parse({ ...baseline.state, supported: true, runtimes: [runtime], instances: [{ ...instance, status, ...(status === 'failed' ? { lastError: 'A presentation-only connection diagnostic.' } : {}) }], executionReadiness: undefined });
        await application.evaluate(({ BrowserWindow }, input) => BrowserWindow.getAllWindows()[0]!.webContents.send(input.channel, input.state), { channel: DSH_LAUNCHER_CHANGED_CHANNEL, state });
      };
      await expect(page.getByRole('dialog', { name: '连接共享 DSH' })).toBeVisible();
      await publish('running');
      await expect(page.locator('.bot-composer')).toBeVisible();
      await expect(notice.locator('.bot-executor-status-label')).toHaveText('尚未配置 DSH');
      await publish('running');
      await expect(notice).toHaveCount(0);
      const presence = header.locator('.bot-presence-summary');
      await expect(presence).toBeVisible();
      await expect(header.locator('.bot-avatar .bot-presence-dot')).toHaveCount(0);
      const dot = (await presence.locator('.bot-presence-indicator').boundingBox())!;
      const presenceText = (await presence.locator('.bot-presence-text').boundingBox())!;
      expect(dot.x + dot.width).toBeLessThan(presenceText.x);
      expect(Math.abs(dot.y + dot.height / 2 - presenceText.y - presenceText.height / 2)).toBeLessThan(1);
      const chatBounds = await transcript.boundingBox();
      for (const status of ['starting', 'stopped', 'failed', 'running'] as const) {
        await publish(status);
        if (status === 'running') {
          await expect(notice).toHaveCount(0);
          expect(await transcript.boundingBox()).toEqual(chatBounds);
          continue;
        }
        await expect(notice).toBeVisible();
        await expect(notice.locator('.bot-executor-status-label')).toHaveText(status === 'starting' ? 'DSH 正在启动…' : status === 'stopped' ? 'DSH 未启动' : 'DSH 启动失败');
        const geometry = (await notice.boundingBox())!;
        const headerBounds = (await header.boundingBox())!;
        expect(geometry.height).toBeLessThanOrEqual(34);
        expect(geometry.x + geometry.width).toBeLessThan(headerBounds.x + headerBounds.width);
        expect(geometry.y + geometry.height).toBeLessThan(headerBounds.y + headerBounds.height);
        expect(await transcript.boundingBox()).toEqual(chatBounds);
        const trigger = notice.locator('summary'), panel = notice.locator('.bot-executor-panel');
        await expect(panel).toBeHidden();
        await trigger.press('Enter');
        await expect(panel.getByRole('button', { name: '前往启动器' })).toBeVisible();
        if (status === 'starting') await expect(panel.getByRole('button', { name: '启动', exact: true })).toHaveCount(0);
        else await expect(panel.getByRole('button', { name: '启动', exact: true })).toBeVisible();
        if (status === 'failed') await expect(panel.locator('.bot-executor-diagnostic')).toBeVisible();
        expect(await transcript.boundingBox()).toEqual(chatBounds);
        await trigger.press('Escape');
        await expect(panel).toBeHidden();
        await trigger.blur();
        measurements.push({ theme, preset, status, ...geometry });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const previous = await application.evaluate(({ BrowserWindow }) => { const count = (Reflect.get(globalThis, '__executorNoticeFrames') as { count: number }).count; BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return count; });
        await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__executorNoticeFrames') as { count: number }).count)).toBeGreaterThan(previous);
        const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
        const filename = `executor-notice-${status}-${theme}${preset === 'worldlinebox' ? '' : `-${preset}`}.png`, target = testInfo.outputPath(filename);
        await writeFile(target, Buffer.from(png, 'base64')); await copyFile(target, path.join(evidence, filename));
      }
    }
    await writeFile(path.join(evidence, 'executor-notice-layout-evidence.json'), JSON.stringify({ actualElectron: true, validatedPreloadStateEvents: true, simulatedHostStates: true, measurements }, null, 2));
  } finally { await application.close(); removeCompanionTestDirectory(profile); }
});
