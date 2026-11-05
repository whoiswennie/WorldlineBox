import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- The test owns an isolated, hidden Electron window.
test('skin opacity is visible in Appearance, changes only artwork, survives reload and preserves personal image settings', async ({}, testInfo) => {
  test.setTimeout(120000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-opacity-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1' }) });
  try {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.hide(); window.webContents.setBackgroundThrottling(false); window.setSize(1400, 950); } });
    const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    let settings = page.getByRole('dialog', { name: '通用设置' }); await settings.getByRole('tab', { name: '外观', exact: true }).click();
    await settings.getByRole('radio', { name: '亮色', exact: true }).click();
    await settings.getByRole('radio', { name: '鲸鱼娘 · 水墨丹青', exact: true }).click();
    let opacity = settings.getByRole('slider', { name: '皮肤不透明度', exact: true });
    await expect(opacity).toBeVisible(); await expect(opacity).toHaveValue('0.4');
    const strength = () => page.locator('.app-animated-background').evaluate(element => getComputedStyle(element).opacity);
    expect(await strength()).toBe('0.4');
    await mkdir(path.resolve('artifacts/appearance-opacity'), { recursive: true });
    await page.screenshot({ path: path.resolve('artifacts/appearance-opacity/settings.png') });
    await opacity.press('Home'); expect(await strength()).toBe('0');
    expect(await settings.locator('.app-settings-row-copy strong').first().evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await opacity.press('End'); expect(await strength()).toBe('1');
    await opacity.press('Home'); for (let i = 0; i < 5; i++) await opacity.press('ArrowRight');
    expect(await strength()).toBe('0.25');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('worldlinebox.background-preferences.v3')!).themeOpacity)).toBe(.25);
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click(); settings = page.getByRole('dialog', { name: '通用设置' });
    await settings.getByRole('tab', { name: '外观', exact: true }).click(); opacity = settings.getByRole('slider', { name: '皮肤不透明度', exact: true });
    await expect(opacity).toHaveValue('0.25'); expect(await strength()).toBe('0.25');
    await settings.getByRole('button', { name: /^应用背景/ }).click();
    await settings.locator('.app-settings-background-file-input').setInputFiles(path.resolve('assets/icons/startup-logo.png'));
    const imageOpacity = settings.getByRole('slider', { name: '背景不透明度', exact: true });
    await expect(imageOpacity).toHaveValue('0.4');
    await imageOpacity.press('End');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('worldlinebox.background-preferences.v3')!));
    expect(saved.themeOpacity).toBe(.25); expect(saved.imageOpacity).toBe(1);
    await settings.getByRole('button', { name: '移除图片', exact: true }).click();
    await expect(settings.getByRole('slider', { name: '皮肤不透明度', exact: true })).toHaveValue('0.25');
    await opacity.press('Home'); for (let i = 0; i < 8; i++) await opacity.press('ArrowRight');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.resolve('artifacts/appearance-opacity/launcher-default.png') });
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-composer textarea')).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: path.resolve('artifacts/appearance-opacity/companions-default.png') });
    await writeFile(testInfo.outputPath('opacity-evidence.json'), JSON.stringify({ defaultOpacity: .4, saved, cssOpacity: await strength() }, null, 2));
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
});
