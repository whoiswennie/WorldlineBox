import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import type { DshLauncherState } from '../../src/shared/dsh-launcher';
import { DEFAULT_BACKGROUND_PREFERENCES } from '../../src/renderer/theme/background-preferences';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// Real renderer/cascade/theme settings. Only the launcher state is a fixture;
// exercising these styles must never start or stop the user's actual DSH.
// eslint-disable-next-line no-empty-pattern
test('launcher actions, selected instances and network fields share wallpaper surfaces across themes and preserve solid-panel controls', async ({}) => {
  test.setTimeout(150000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-wallpaper-controls-'));
  const evidence = path.resolve('artifacts/wallpaper-control-surfaces'); await mkdir(evidence, { recursive: true });
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_DSH_SILENT: '1' }) });
  const page = await app.firstWindow(), report: unknown[] = [];
  const wallpaper = 'data:image/jpeg;base64,' + (await readFile(path.resolve('assets/backgrounds/shuimo-danqing-poster.jpg'))).toString('base64');
  const fixture: DshLauncherState = { supported: true, rootPath: 'C:\\fixture',
    runtimes: [{ id: 'runtime-fixture', version: '0.2.2-rc.1', adapter: 'node-cli-web-v1', nodeVersion: '24.15.0', platform: 'win32-x64', source: 'official', sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), fileCount: 1, byteLength: 1, installedAt: '' }],
    instances: [{ id: 'instance-fixture', name: '我的 DSH', runtimeId: 'runtime-fixture', profile: 'web', status: 'running', createdAt: '', updatedAt: '', isDefault: true, homePath: 'C:\\fixture\\home', agentsPath: 'C:\\fixture\\agents', workspacePath: 'C:\\fixture\\workspace', browserPartition: 'persist:fixture', pid: 12345, port: 60000 }],
    executionReadiness: { instanceId: 'instance-fixture', status: 'ready', updatedAt: '2026-11-10T06:00:00Z' }, snapshots: [], packs: [], operations: [] };
  const appearance = async (node: Locator) => node.evaluate(node => {
    const style = getComputedStyle(node), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!; context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
    return { alpha: context.getImageData(0, 0, 1, 1).data[3]! / 255, background: style.backgroundColor, foreground: style.color, opacity: style.opacity, outline: style.outlineStyle, disabled: (node as HTMLButtonElement).disabled };
  });
  try {
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.hide(); window.setSize(1400, 950); window.webContents.setBackgroundThrottling(false); });
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await app.evaluate(({ ipcMain, BrowserWindow }, fixture) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents, send = contents.send.bind(contents);
      contents.send = (channel, ...args) => send(channel, ...(channel === 'worldlinebox:dsh-launcher:changed' ? [fixture] : args));
      ipcMain.removeHandler('worldlinebox:dsh-launcher'); ipcMain.handle('worldlinebox:dsh-launcher', () => ({ ok: true, state: fixture }));
      send('worldlinebox:dsh-launcher:changed', fixture);
    }, fixture);
    const cases = [
      { name: 'ink-light', preset: 'shuimo-danqing', theme: 'light', personal: false, panels: true },
      { name: 'ink-dark', preset: 'shuimo-danqing', theme: 'dark', personal: false, panels: true },
      { name: 'fantasy-light', preset: 'whale-fantasy', theme: 'light', personal: false, panels: true },
      { name: 'midnight-wallpaper', preset: 'midnight', theme: 'dark', personal: true, panels: true },
      { name: 'solid-panels', preset: 'shuimo-danqing', theme: 'light', personal: false, panels: false },
      { name: 'plain-theme', preset: 'worldlinebox', theme: 'light', personal: false, panels: true },
    ];
    for (const sample of cases) {
      await page.evaluate(({ sample, defaults, wallpaper }) => {
        localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: sample.theme }));
        localStorage.setItem('worldlinebox.theme-profile.v3', JSON.stringify({ version: 3, preset: sample.preset, overrides: {} }));
        localStorage.setItem('worldlinebox.background-motion.v1', 'false');
        localStorage.setItem('worldlinebox.background-preferences.v3', JSON.stringify({ ...defaults, showInMainPanel: sample.panels, panelVisibilityVersion: 1, panelOpacity: .48, ...(sample.personal ? { imageDataUrl: wallpaper } : {}) }));
      }, { sample, defaults: DEFAULT_BACKGROUND_PREFERENCES, wallpaper });
      await page.reload(); await page.locator('[data-application-module="dsh"]').click(); await expect(page.locator('[data-dsh-instance="instance-fixture"]')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', sample.theme);
      await page.locator('[data-dsh-instance="instance-fixture"]').click();
      const open = page.locator('[data-dsh-open-workbench]'), stop = page.getByRole('button', { name: '停止实例', exact: true }), rename = page.getByRole('button', { name: '重命名', exact: true });
      await expect(open).toBeVisible(); await expect(stop).toBeEnabled(); await expect(rename).toBeEnabled();
      await expect(page.locator('[data-execution-readiness="ready"]')).toContainText('共享 DSH 已就绪');
      const paints = { open: await appearance(open), stop: await appearance(stop), rename: await appearance(rename), selected: await appearance(page.locator('.launcher-instance-item.is-active')) };
      const translucent = sample.panels && sample.name !== 'plain-theme';
      if(!translucent)for (const key of ['stop', 'rename', 'selected'] as const) expect(paints[key].alpha, sample.name + ':' + key).toBe(1);
      if (translucent) {
        expect(paints.stop.alpha).toBeGreaterThan(.1); expect(paints.stop.alpha).toBeLessThan(.7); expect(paints.rename.alpha).toBe(paints.stop.alpha); expect(paints.selected.alpha).toBeLessThan(.75);
        expect(paints.open.alpha).toBeGreaterThan(.8); expect(paints.open.alpha).toBeLessThan(1);
      }
      await page.screenshot({ path: path.join(evidence, sample.name + '-launcher.png') });
      await rename.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(rename).toBeFocused(); expect((await appearance(rename)).outline).toBe('solid');
      await rename.click(); await expect(page.locator('.launcher-dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('.launcher-dialog')).toHaveCount(0);
      await page.locator('[data-application-module="network"]').click();
      const controls = page.locator('[data-application-network] .ui-field__control'); await expect(controls.first()).toBeVisible();
      const field = await appearance(controls.first()); if (translucent) { expect(field.alpha).toBeGreaterThan(.1); expect(field.alpha).toBeLessThan(.7); } else expect(field.alpha).toBe(1);
      await controls.first().click(); await expect(page.getByRole('listbox')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('listbox')).toHaveCount(0);
      await page.screenshot({ path: path.join(evidence, sample.name + '-network.png') }); report.push({ ...sample, paints, field });
    }
    await writeFile(path.join(evidence, 'surfaces-result.json'), JSON.stringify({ passed: true, cases: report }, null, 2));
  } finally { await app.close(); }
});
