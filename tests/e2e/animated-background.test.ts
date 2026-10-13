import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('global wallpapers retain playback across modules and support decoding, pause and personal images', async () => {
  test.setTimeout(120_000);
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-wallpaper-'));
  const application = await electron.launch({
    executablePath: resolveElectronExecutablePath(),
    args: [resolveElectronAppPath()],
    env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, 'user-data'),
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_DISTRIBUTION: 'development',
    }),
  });

  async function openAppearance(window: Page) {
    const selected = await window.locator('[data-application-module][aria-current="page"]').getAttribute('data-application-module');
    await window.getByRole('button', { name: '设置', exact: true }).click();
    const settings = window.getByRole('dialog', { name: '通用设置' });
    await settings.getByRole('tab', { name: '外观', exact: true }).click();
    await expect(window.locator(`[data-application-module="${selected}"]`)).toHaveAttribute('aria-current', 'page');
    return settings;
  }

  try {
    const window = await application.firstWindow();
    const nativeWindow = await application.browserWindow(window);
    window.setDefaultTimeout(10_000);
    const launcher = window.locator('[data-application-module="dsh"]');
    const assets = window.locator('[data-application-module="assets"]');
    await expect(launcher).toHaveAttribute('aria-current', 'page');

    let settings = await openAppearance(window);
    await settings.getByRole('radio', { name: '暗色', exact: true }).click();
    for (const [id, name, duration, width] of [
      ['whale-fantasy', '鲸鱼娘 · 未至之境', 25.458333, 1664],
      ['shuimo-danqing', '鲸鱼娘 · 水墨丹青', 25.333333, 1920],
    ] as const) {
      await settings.getByRole('radio', { name, exact: true }).click();
      const video = window.locator('.app-animated-background-video');
      await expect(video).toHaveCount(1);
      expect(await window.locator('.app-animated-background').evaluate((element) => getComputedStyle(element).opacity)).toBe('0.7');
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
      expect(await video.evaluate((element: HTMLVideoElement) => element.duration)).toBeCloseTo(duration, 2);
      expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(width);
      expect(await video.evaluate((element: HTMLVideoElement) => element.muted && element.loop)).toBe(true);
      await window.keyboard.press('Escape');
      await expect(launcher).toHaveAttribute('aria-current', 'page');
      expect(await video.evaluate((element) => element.closest('[data-application-view]'))).toBeNull();
      expect(await window.locator('.dsh-launcher').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      await video.evaluate((element: HTMLVideoElement) => {
        element.currentTime = 10;
        const marker = { video: element, source: element.currentSrc, reloads: 0 };
        (window as unknown as Window & { __wallpaperMarker?: typeof marker }).__wallpaperMarker = marker;
        element.addEventListener('emptied', () => { marker.reloads++; });
        element.addEventListener('loadstart', () => { marker.reloads++; });
      });
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(10.1);
      await assets.click();
      await expect(assets).toHaveAttribute('aria-current', 'page');
      if (id === 'whale-fantasy') {
        await window.getByRole('button', { name: '创建资源库', exact: true }).click();
        await window.getByRole('textbox', { name: '名称', exact: true }).fill('Wallpaper Verification');
        await window.getByRole('button', { name: '创建', exact: true }).click();
        await expect(window.locator('.dialog-backdrop')).toHaveCount(0, { timeout: 20_000 });
      }
      await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 6; });
      for (const module of [launcher, assets, launcher]) {
        await module.click();
        await expect(video).toHaveCount(1);
        expect(await video.evaluate((element: HTMLVideoElement) => {
          const marker = (window as unknown as Window & { __wallpaperMarker?: { video: HTMLVideoElement; source: string; reloads: number } }).__wallpaperMarker;
          return marker !== undefined && element === marker.video && element.currentSrc === marker.source && marker.reloads === 0;
        })).toBe(true);
        expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(6);
        expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
      }
      for (const name of ['运行版本', '整合包', '操作记录', '实例']) {
        await window.locator('.launcher-navigation').getByRole('button', { name, exact: true }).click();
        expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(6);
        expect(await video.evaluate((element: HTMLVideoElement) => {
          const marker = (globalThis as typeof globalThis & { __wallpaperMarker?: { video: HTMLVideoElement; reloads: number } }).__wallpaperMarker;
          return marker !== undefined && element === marker.video && marker.reloads === 0;
        })).toBe(true);
      }
      await window.screenshot({ path: test.info().outputPath(`${id}.png`) });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.animatedBackground)).toBe(id);

      await nativeWindow.evaluate((win) => win.minimize());
      await expect.poll(() => nativeWindow.evaluate((win) => win.isMinimized())).toBe(true);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
      await nativeWindow.evaluate((win) => { win.restore(); win.show(); win.focus(); });
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
      settings = await openAppearance(window);
    }

    await settings.getByRole('button', { name: /^应用背景/ }).click();
    const opacity = settings.getByRole('slider', { name: '背景不透明度' });
    await expect(opacity).toHaveValue('0.7');
    await opacity.press('Home');
    for (let step = 0; step < 7; step++) await opacity.press('ArrowRight');
    await expect.poll(() => window.locator('.app-animated-background').evaluate((element) => getComputedStyle(element).opacity)).toBe('0.35');
    expect(await window.evaluate(() => JSON.parse(localStorage.getItem('worldlinebox.background-preferences.v3') ?? '{}').imageOpacity)).toBe(0.35);
    const motion = settings.getByRole('switch', { name: '播放背景动画' });
    await motion.uncheck();
    await expect(window.locator('.app-animated-background-video')).toHaveAttribute('data-ready', 'false');
    expect(await window.locator('.app-animated-background-video').evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    await motion.check();
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await expect(window.locator('.app-animated-background-video')).not.toHaveAttribute('src', /.+/);
    await window.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => window.locator('.app-animated-background-video').evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);

    await settings.locator('.app-settings-background-file-input').setInputFiles(path.resolve('assets/icons/startup-logo.png'));
    const globalBackground = window.locator('.application-root > .app-theme-background');
    await expect(globalBackground).toHaveAttribute('data-wallpaper', 'image');
    await expect(window.locator('.app-animated-background-video')).toHaveCount(0);
    expect(await globalBackground.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain('data:image/');
    await expect(launcher).toHaveAttribute('aria-current', 'page');
    await window.keyboard.press('Escape');
    await assets.click();
    expect(await window.locator('.app-shell').evaluate((element) => getComputedStyle(element).backgroundImage)).toBe('none');
    expect(await window.getByText('导入资产以开始整理', { exact: true }).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await expect(globalBackground).toHaveAttribute('data-wallpaper', 'image');
    await launcher.click();
    expect(await window.locator('.dsh-launcher').evaluate((element) => getComputedStyle(element).backgroundImage)).toBe('none');
    await expect(globalBackground).toHaveAttribute('data-wallpaper', 'image');
    settings = await openAppearance(window);
    await settings.getByRole('button', { name: /^应用背景/ }).click();
    await settings.getByRole('button', { name: '移除图片', exact: true }).click();
    await expect(globalBackground).toHaveAttribute('data-wallpaper', 'animated');
    await expect(window.locator('.app-animated-background-video')).toHaveCount(1);
    await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
    await expect(window.locator('.app-animated-background-video')).toHaveCount(0);
    expect(await window.evaluate(() => document.documentElement.dataset.animatedBackground)).toBeUndefined();
    await expect(launcher).toHaveAttribute('aria-current', 'page');
  } finally {
    await application.close();
    const resolvedRoot = path.resolve(temporaryRoot);
    if (path.dirname(resolvedRoot) === path.resolve(tmpdir()) && path.basename(resolvedRoot).startsWith('worldlinebox-wallpaper-')) {
      rmSync(resolvedRoot, { recursive: true, force: true });
    }
  }
});
