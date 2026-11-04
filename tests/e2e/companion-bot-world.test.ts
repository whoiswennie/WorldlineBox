import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

// eslint-disable-next-line no-empty-pattern -- Electron supplies its own window.
test('new physical world renders the real room and park in Three and executes movement through the new domain', async ({}, testInfo) => {
  test.setTimeout(120000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-bot-world-ui-'));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('wlb-bot-world-ui-')) throw new Error('Invalid isolated world profile cleanup');
  const evidence = path.resolve('artifacts/bot-refactor-2026-11-02/ui'); await mkdir(evidence, { recursive: true });
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    ...process.env, WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  try {
    const page = await application.firstWindow(); await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-workspace')).toBeVisible();
    const setup = await page.evaluate(async defaultId => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const state = await api.request({ type: 'state' }), companionId = state.snapshot!.companions.find(item => item.id === defaultId)!.id;
      const created = await api.request({ type: 'conversation.create', title: '世界场景验收', kind: 'world', memberIds: [companionId] });
      return { companionId, conversationId: created.conversationId! };
    }, DEFAULT_BOT_COMPANION_ID);
    await page.locator('.bot-scroll button').filter({ hasText: '世界场景验收' }).click();
    await page.getByRole('button', { name: '世界场景', exact: true }).click();
    await expect(page.locator('svg.bot-world-map')).toBeVisible();
    await page.getByRole('button', { name: '三维场景', exact: true }).click();
    const canvas = page.locator('.bot-world-3d canvas');
    await expect(canvas).toHaveAttribute('data-world-ready', 'true', { timeout: 30000 });
    await expect(canvas).toHaveAttribute('data-world-scene', `home_${setup.companionId}`);
    expect(Number(await canvas.getAttribute('data-world-triangles'))).toBeGreaterThan(1000);
    expect(Number(await canvas.getAttribute('data-world-actors'))).toBe(1);
    await expect(canvas).toHaveAttribute('data-world-art', `${DEFAULT_BOT_COMPANION_ID}:sister`);
    const movement = await page.evaluate(async ({ companionId, conversationId }) => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      return api.request({ type: 'world.act', companionId, conversationId,
        command: { operation: 'move', sceneId: `home_${companionId}`, x: 10, y: 13 }, effectId: crypto.randomUUID() });
    }, setup);
    expect(movement.ok).toBe(true);
    await expect.poll(async () => page.evaluate(async ({ companionId, conversationId }) => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const result = await api.request({ type: 'world.observe', companionId, conversationId });
      return result.world?.actors.find(actor => actor.companionId === companionId)?.position;
    }, setup)).toEqual({ x: 10, y: 13 });
    await page.waitForTimeout(1100);
    const homeImage = testInfo.outputPath('world-3d-home.png'); await page.screenshot({ path: homeImage, fullPage: true });
    await copyFile(homeImage, path.join(evidence, 'world-3d.png')); await testInfo.attach('world-3d-home', { path: homeImage, contentType: 'image/png' });
    await page.getByRole('button', { name: '去公共花园', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-world-view', 'park', { timeout: 30000 });
    await expect.poll(async () => page.evaluate(async ({ companionId, conversationId }) => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const result = await api.request({ type: 'world.observe', companionId, conversationId });
      return result.world?.actors.find(actor => actor.companionId === companionId)?.sceneId;
    }, setup)).toBe('park');
    await expect(canvas).toHaveAttribute('data-world-actors', '1', { timeout: 5000 });
    const parkImage = testInfo.outputPath('world-3d-park.png'); await page.screenshot({ path: parkImage, fullPage: true });
    await copyFile(parkImage, path.join(evidence, 'world-3d-park.png')); await testInfo.attach('world-3d-park', { path: parkImage, contentType: 'image/png' });
    const graphics = await canvas.evaluate((element: HTMLCanvasElement) => {
      const gl = element.getContext('webgl2'), debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return { version: gl?.getParameter(gl.VERSION), vendor: debug && gl?.getParameter(debug.UNMASKED_VENDOR_WEBGL), renderer: debug && gl?.getParameter(debug.UNMASKED_RENDERER_WEBGL), stats: { ...element.dataset } };
    });
    await writeFile(path.join(evidence, 'world-3d-evidence.json'), JSON.stringify({ graphics, observedRealMovement: { x: 10, y: 13 }, enteredScene: 'park' }, null, 2) + '\n');
  } finally {
    await application.close();
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
