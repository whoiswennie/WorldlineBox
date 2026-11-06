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
      const instance: DshInstance = { id: 'notice-only', name: '界面状态夹具', runtimeId: 'not-executed', createdAt: stamp, updatedAt: stamp,
        profile: 'web', status: 'stopped', homePath: profile, agentsPath: profile, workspacePath: profile, browserPartition: 'notice-fixture', isDefault: true };
      for (const status of ['starting', 'stopped', 'failed'] as const) {
        const state = dshLauncherStateSchema.parse({ ...baseline.state, supported: true, instances: [{ ...instance, status, ...(status === 'failed' ? { lastError: 'A presentation-only connection diagnostic.' } : {}) }], executionReadiness: undefined });
        await application.evaluate(({ BrowserWindow }, input) => BrowserWindow.getAllWindows()[0]!.webContents.send(input.channel, input.state), { channel: DSH_LAUNCHER_CHANGED_CHANNEL, state });
        const notice = page.getByRole('complementary', { name: 'DSH 执行器状态' });
        await expect(notice).toBeVisible();
        await expect(notice.locator('.bot-executor-status-label')).toHaveText(status === 'starting' ? 'DSH 正在启动…' : status === 'stopped' ? 'DSH 未启动' : 'DSH 启动失败');
        const geometry = await notice.evaluate(element => { const bounds = element.getBoundingClientRect(), chat = element.closest('.bot-main')!.getBoundingClientRect(), style = getComputedStyle(element);
          return { width: bounds.width, height: bounds.height, chatWidth: chat.width, background: style.backgroundColor, borderRadius: style.borderRadius, overflow: element.scrollWidth > element.clientWidth + 1 }; });
        expect(geometry.height).toBeLessThanOrEqual(40); expect(geometry.width).toBeLessThan(geometry.chatWidth * .8);
        expect(geometry.overflow).toBe(false); expect(geometry.borderRadius).toBe('10px');
        await expect(notice.getByRole('button', { name: '前往启动器' })).toBeVisible();
        if (status === 'starting') await expect(notice.getByRole('button', { name: '启动', exact: true })).toHaveCount(0);
        if (status === 'failed') { await expect(notice).not.toContainText('presentation-only'); await notice.getByRole('button', { name: '详情', exact: true }).click(); await expect(notice).toContainText('presentation-only'); }
        measurements.push({ theme, preset, status, ...geometry });
        if (status === 'failed') {
          await notice.getByRole('button', { name: '详情', exact: true }).click();
          await expect(notice).not.toContainText('presentation-only');
          await expect(notice.getByRole('button', { name: '详情', exact: true })).toHaveAttribute('aria-expanded', 'false');
        }
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
