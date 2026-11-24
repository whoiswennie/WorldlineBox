import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';
import type { WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';

test('renders the Windows desktop pet at physical display resolution and measures real Cubism updates', async () => {
  const testInfo = test.info();
  test.skip(process.platform !== 'win32', 'Requires the Windows desktop pet window.');
  test.setTimeout(120_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-companion-call-quality-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-companion-call-quality-')) {
    throw Error('Unexpected Live2D test profile');
  }
  const launch = resolveElectronLaunchOptions();
  const downloads = path.join(profile, 'Downloads');
  await mkdir(downloads);
  const app = await electron.launch({ ...launch, env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
    WORLDLINEBOX_E2E_CAPTURE_DOWNLOAD_PATH: downloads,
  }, { gpu: 'hardware' }) });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const api = Reflect.get(window, 'worldlinebox') as { llm: WorldlineBoxLlmApi };
      await api.llm.setConfig({ apiFormat: 'openai_chat', model: 'performance-fixture', baseUrl: 'http://127.0.0.1:1', apiKey: 'local-test-only' });
    });
    await app.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Live2D measurements require an isolated profile');
      const window = BrowserWindow.getAllWindows()[0]!;
      window.on('show', () => window.hide()); window.setSize(1440, 940); window.hide();
      window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false);
    }, profile);
    await page.locator('[data-application-module="companions"]').click();
    const call = page.getByRole('button', { name: '拨打伙伴电话', exact: true });
    await expect(async () => {
      await enableCallVisualFixture(app, page);
      await expect(call).toBeEnabled({ timeout: 1200 });
    }).toPass({ timeout: 15_000 });
    await call.click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible({ timeout: 35_000 });
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 35_000 });
    const opened = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为桌宠', exact: true }).click();
    const pet = await opened;
    const canvas = pet.locator('.is-desktop-pet .bot-call-live2d canvas');
    await expect(canvas).toBeVisible();
    const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.width, height: element.height, cssWidth: element.clientWidth, cssHeight: element.clientHeight, dpr: window.devicePixelRatio,
    }));
    await expect.poll(async () => {
      const sample = await pixels();
      return sample.width / sample.cssWidth + .01 >= Math.min(sample.dpr, 3);
    }).toBe(true);
    const sampleSource = (duration = 3_000) => page.evaluate(async duration => {
      const { Model } = Reflect.get(window, 'Live2DCubismCore') as { Model: { prototype: { update(): void } } };
      const update = Model.prototype.update;
      let frames = 0, browserFrames = 0, frame: number;
      let previous = performance.now();
      const gaps: number[] = [];
      Model.prototype.update = function () { const now = performance.now(); gaps.push(now - previous); previous = now; frames++; update.call(this); };
      const browserTick = () => { browserFrames++; frame = requestAnimationFrame(browserTick); };
      frame = requestAnimationFrame(browserTick);
      const start = performance.now();
      try {
        await new Promise(resolve => setTimeout(resolve, duration));
        const seconds = (performance.now() - start) / 1_000;
        const sorted = gaps.slice(1).sort((a, b) => a - b);
        return { fps: Math.round(frames / seconds), p95Ms: Math.round(sorted[Math.floor(sorted.length * .95)] ?? 0), ownerRefresh: Math.round(browserFrames / seconds) };
      } finally {
        cancelAnimationFrame(frame);
        Model.prototype.update = update;
      }
    }, duration);
    const samplePet = () => pet.evaluate(async () => {
      let frames = 0, frame: number;
      const tick = () => { frames++; frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
      const start = performance.now();
      await new Promise(resolve => setTimeout(resolve, 3_000));
      cancelAnimationFrame(frame);
      return Math.round(frames / ((performance.now() - start) / 1_000));
    });
    const [timing, petRefresh] = await Promise.all([sampleSource(), samplePet()]);
    const composer = pet.getByRole('button', { name: '展开会面输入', exact: true });
    if (await composer.isVisible()) await composer.click();
    await pet.getByRole('button', { name: '更多会面功能', exact: true }).click();
    await pet.getByRole('button', { name: '场景与互动', exact: true }).click();
    await pet.getByText('表情与动作', { exact: true }).click();
    await pet.getByLabel('选择模型动作', { exact: true }).selectOption({ label: '默认手切举手' });
    const motion = pet.getByRole('button', { name: '播放动作', exact: true });
    await motion.click();
    const moving = sampleSource();
    for (const label of ['流泪', '脸红', '屑屑眼']) {
      await pet.getByLabel('选择模型表情', { exact: true }).selectOption({ label });
      await motion.click();
    }
    const actionTiming = await moving;
    await pet.getByRole('button', { name: '收起会面面板', exact: true }).click();
    await pet.getByRole('button', { name: '陪伴设置', exact: true }).click();
    await pet.getByRole('combobox', { name: '精力值', exact: true }).selectOption('active');
    await pet.getByRole('button', { name: '开始陪伴', exact: true }).click();
    await expect(pet.locator('.bot-presence-status').getByRole('status')).toHaveText('陪伴中');
    const observing = await sampleSource(4000);
    const openedRecord = await page.evaluate(async () => (Reflect.get(window, 'worldlinebox') as { captureTools: WorldlineBoxCaptureToolsApi }).captureTools.request({ type: 'open', task: 'recording' }));
    expect(openedRecord.ok, openedRecord.ok ? undefined : openedRecord.error).toBe(true);
    await expect.poll(() => app.windows().some(view => view.url().includes('window=capture-tools'))).toBe(true);
    const recording = app.windows().find(view => view.url().includes('window=capture-tools'))!;
    await recording.getByRole('button', { name: '使用整个屏幕', exact: true }).click();
    await recording.getByRole('button', { name: '开始录制', exact: true }).click();
    await expect(recording.locator('.capture-recording-status')).toHaveClass(/is-recording/u, { timeout: 20000 });
    const loaded = sampleSource(8000);
    await pet.getByRole('button', { name: '更多会面功能', exact: true }).click();
    await pet.getByRole('button', { name: '场景与互动', exact: true }).click();
    const loadedMotion = pet.getByRole('button', { name: '播放动作', exact: true });
    await pet.getByText('表情与动作', { exact: true }).click();
    for (const label of ['脸红', '屑屑眼', '流泪']) {
      await pet.getByLabel('选择模型表情', { exact: true }).selectOption({ label });
      await loadedMotion.click();
    }
    const loadedTiming = await loaded;
    const sample = await pixels();
    const graphics = await app.evaluate(({ app }) => app.getGPUFeatureStatus().webgl);
    const metrics = { ...sample, idleFps: timing.fps, motionFps: actionTiming.fps, observing, loaded: loadedTiming, ownerRefresh: timing.ownerRefresh, petRefresh, graphics };
    console.log('Desktop pet performance', JSON.stringify(metrics));
    await testInfo.attach('desktop-pet-rendering', { contentType: 'application/json', body: JSON.stringify(metrics) });
    expect(sample.width / sample.cssWidth + .01).toBeGreaterThanOrEqual(Math.min(sample.dpr, 3));
    expect(sample.height / sample.cssHeight + .01).toBeGreaterThanOrEqual(Math.min(sample.dpr, 3));
    expect(timing.fps, JSON.stringify(metrics)).toBeGreaterThanOrEqual(45);
    expect(actionTiming.fps, JSON.stringify(metrics)).toBeGreaterThanOrEqual(45);
    expect(loadedTiming.fps, JSON.stringify(metrics)).toBeGreaterThanOrEqual(45);
    expect(loadedTiming.p95Ms, JSON.stringify(metrics)).toBeLessThan(43);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
