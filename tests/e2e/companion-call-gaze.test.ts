import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxShellApi } from '../../src/shared/external-url';
import { electronLaunchEnv, preparePackagedCompanionLaunch, resolveElectronLaunchOptions } from './electron-test-helpers';

interface GazeProbe { pointer?: { x: number; y: number }; engine: { getSnapshot(): { live2dParams: Record<string, number> } } }
interface Fiber { return?: Fiber; memoizedState?: { memoizedState?: { current?: GazeProbe }; next?: Fiber['memoizedState'] } }

// eslint-disable-next-line no-empty-pattern -- Isolated Electron owns the page and the actual model.
test('native pointer gaze stays continuous over controls and outside a zoomed window, and releases its sampler on disable/end', async ({}, testInfo) => {
  test.setTimeout(150000);
  const prefix = 'wlb-call-gaze-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith(prefix)) throw Error('Invalid owned gaze profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const evidence: unknown[] = [];
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const initial = await application.evaluate(({ app, BrowserWindow, screen }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Gaze acceptance requires an isolated profile');
      const window = BrowserWindow.getAllWindows()[0]!;
      window.on('show', () => window.hide()); window.hide(); window.setSize(1500, 1000);
      window.webContents.setBackgroundThrottling(false); window.webContents.setZoomFactor(1.25);
      const realCursor = screen.getCursorScreenPoint(), bounds = window.getContentBounds();
      return { realCursor, bounds, packaged: app.isPackaged };
    }, profile);
    evidence.push({ initialNativeCursor: initial });
    await page.locator('[data-application-module="companions"]').click();
    const read = await page.evaluate(async () => (Reflect.get(window, 'worldlinebox') as { shell: WorldlineBoxShellApi }).shell.getCompanionGazePointer!());
    expect(read.ok).toBe(true);
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 60000 });
    await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible();
    await page.evaluate(() => {
      const element = document.querySelector('.bot-call-live2d')!, key = Object.keys(element).find(name => name.startsWith('__reactFiber'))!;
      let probe: GazeProbe | undefined;
      for (let fiber = Reflect.get(element, key) as Fiber | undefined; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        if (typeof hook.memoizedState?.current?.engine?.getSnapshot === 'function') probe = hook.memoizedState.current;
      }
      if (!probe) throw Error('Missing actual mounted gaze engine');
      Reflect.set(window, '__gazeProbe', probe);
    });
    const current = () => page.evaluate(() => {
      const probe = Reflect.get(window, '__gazeProbe') as GazeProbe;
      return { target: probe.pointer, parameters: probe.engine.getSnapshot().live2dParams };
    });
    const sampleAt = async (x: number, y: number, name: string) => {
      const point = await application.evaluate(({ BrowserWindow, screen }, input) => {
        const window = BrowserWindow.getAllWindows()[0]!, bounds = window.getContentBounds(), zoom = window.webContents.getZoomFactor();
        const point = { x: bounds.x + input.x * zoom, y: bounds.y + input.y * zoom };
        // Exercise the real Main IPC/mapping and Live2D with deterministic OS
        // samples. This fixture never moves or captures the user's mouse.
        Reflect.set(globalThis, '__gazeSamples', 0);
        screen.getCursorScreenPoint = () => { Reflect.set(globalThis, '__gazeSamples', Number(Reflect.get(globalThis, '__gazeSamples')) + 1); return point; };
        return point;
      }, { x, y });
      const bounds = await meeting.locator('.bot-call-live2d').boundingBox();
      const expected = { x: Math.max(-1, Math.min(1, (x - bounds!.x) / bounds!.width * 2 - 1)), y: Math.max(-1, Math.min(1, 1 - (y - bounds!.y) / bounds!.height * 2)) };
      await expect.poll(async () => { const value = (await current()).target; return value ? Math.max(Math.abs(value.x - expected.x), Math.abs(value.y - expected.y)) : Infinity; }).toBeLessThan(.0001);
      const frames = await page.evaluate(async () => {
        const probe = Reflect.get(window, '__gazeProbe') as GazeProbe, frames: Array<{ x: number; y: number }> = [];
        for (let index = 0; index < 50; index++) { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); const parameters = probe.engine.getSnapshot().live2dParams; frames.push({ x: parameters.ParamEyeBallX ?? 0, y: parameters.ParamEyeBallY ?? 0 }); }
        return frames;
      });
      const last = frames.at(-1)!;
      if (Math.abs(expected.x) > .5) expect(Math.sign(last.x)).toBe(Math.sign(expected.x));
      if (Math.abs(expected.y) > .5) expect(Math.sign(last.y)).toBe(Math.sign(expected.y));
      expect(frames.every(frame => Number.isFinite(frame.x) && Number.isFinite(frame.y))).toBe(true);
      const tail = frames.slice(-20), jitter = Math.max(...tail.map(frame => frame.x)) - Math.min(...tail.map(frame => frame.x));
      expect(jitter).toBeLessThan(.2);
      evidence.push({ name, viewport: { x, y }, desktopDip: point, expected, last, jitter });
    };
    const stage = (await meeting.locator('.bot-call-live2d').boundingBox())!;
    await sampleAt(stage.x + stage.width * .9, stage.y + stage.height * .3, 'stage-right');
    await meeting.locator('.bot-call-input-entry').click();
    const input = meeting.locator('textarea'); await expect(input).toBeVisible();
    const box = (await input.boundingBox())!;
    await page.mouse.move(box.x + 15, box.y + 10);
    await sampleAt(box.x + 15, box.y + 10, 'composer-overlay');
    await page.evaluate(() => { document.querySelector('.bot-call-live2d')!.dispatchEvent(new PointerEvent('pointerleave')); window.dispatchEvent(new Event('blur')); });
    await sampleAt(-700, 1400, 'outside-window-left-bottom');
    await sampleAt(2600, -500, 'outside-window-right-top');
    await meeting.getByRole('button', { name: '会面菜单', exact: true }).click();
    await meeting.getByRole('button', { name: /场景与互动/ }).click();
    const follow = meeting.getByRole('checkbox', { name: '视线跟随鼠标' });
    await follow.uncheck();
    await expect.poll(async () => (await current()).target).toBeUndefined();
    const stopped = await application.evaluate(() => Number(Reflect.get(globalThis, '__gazeSamples')));
    await page.waitForTimeout(250);
    expect(await application.evaluate(() => Number(Reflect.get(globalThis, '__gazeSamples')))).toBe(stopped);
    await follow.check(); await expect.poll(async () => (await current()).target?.x).toBe(1);
    await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click();
    await expect(meeting).toHaveCount(0);
    const ended = await application.evaluate(() => Number(Reflect.get(globalThis, '__gazeSamples')));
    await page.waitForTimeout(250);
    expect(await application.evaluate(() => Number(Reflect.get(globalThis, '__gazeSamples')))).toBe(ended);
    expect(errors).toEqual([]);
    const directory = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'companion-call-gaze-evidence.json'), JSON.stringify({ passed: true, actualElectronIPC: true, realLive2D: true, cursorFixture: 'controlled OS cursor samples; physical pointer untouched', segments: evidence, samplerStopsOnDisableAndUnmount: true }, null, 2));
    await testInfo.attach('gaze-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  }
});
