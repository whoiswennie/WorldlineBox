import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { CaptureToolsRequest, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

function cleanup(profile: string) {
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('worldlinebox-capture-latency-')) throw Error('Unexpected test profile');
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

// Measure the real native capture + renderer handshake, with no synthetic image
// or cached desktop. Never write captured desktop pixels to test artifacts.
// eslint-disable-next-line no-empty-pattern
test('screen tools become usable promptly and show only a decoded capture surface', async ({}) => {
  test.setTimeout(120000);
  const profile = mkdtempSync(path.join(tmpdir(), 'worldlinebox-capture-latency-'));
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'hardware' }) });
  try {
    const main = await application.firstWindow();
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    await application.evaluate(({ app, desktopCapturer }) => {
      const trace: Array<Record<string, unknown>> = []; Reflect.set(globalThis, '__captureLatency', trace);
      const getSources = desktopCapturer.getSources.bind(desktopCapturer);
      desktopCapturer.getSources = async options => {
        const start = Date.now(); const result = await getSources(options);
        trace.push({ stage: 'sources', start, duration: Date.now() - start, types: options.types, size: options.thumbnailSize }); return result;
      };
      app.on('browser-window-created', (_event, window) => {
        const start = Date.now();
        window.webContents.once('did-finish-load', () => trace.push({ stage: 'loaded', start, duration: Date.now() - start }));
        window.once('show', () => {
          trace.push({ stage: 'shown', start, duration: Date.now() - start });
          void window.webContents.executeJavaScript(`({shell:!!document.querySelector('#startup-shell,.startup-host,.startup-screen'),surface:!!document.querySelector('.desktop-screenshot-overlay'),decoded:[...document.querySelectorAll('.desktop-screenshot-surface')].every(i=>i.complete&&i.naturalWidth>0)})`).then(frame => trace.push({ stage: 'first-frame', ...frame }));
        });
      });
    });
    const samples = [];
    for (const task of ['screenshot', 'screenshot', 'recording', 'screenshot', 'recording'] as const) {
      const result = await main.evaluate(async task => {
        const api = (globalThis as unknown as { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi } }).worldlinebox.captureTools;
        const start = performance.now(); const result = await api.request({ type: 'open', task });
        return { ok: result.ok, elapsed: performance.now() - start };
      }, task);
      expect(result.ok).toBe(true);
      const tool = application.windows().find(page => page.url().includes('window=capture-tools'))!;
      await expect(tool.locator('.desktop-screenshot-overlay')).toBeVisible();
      const timing = await tool.evaluate(() => ({ navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()), resources: performance.getEntriesByType('resource').filter(entry => entry.duration > 40).map(entry => ({ name: entry.name.split('/').at(-1), duration: entry.duration })) }));
      samples.push({ task, elapsed: Math.round(result.elapsed), timing });
      await tool.evaluate(async () => { await (globalThis as unknown as { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi } }).worldlinebox.captureTools.request({ type: 'close' } satisfies CaptureToolsRequest); }).catch(() => undefined);
      await expect.poll(() => application.windows().some(page => page.url().includes('window=capture-tools'))).toBe(false);
    }
    const trace = await application.evaluate(() => Reflect.get(globalThis, '__captureLatency'));
    const frames = trace.filter((entry: { stage: string }) => entry.stage === 'first-frame');
    expect(frames).toHaveLength(5);
    for (const frame of frames) expect(frame).toMatchObject({ shell: false, surface: true, decoded: true });
    const output = path.resolve('.tools/test-output/capture-startup'); mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, process.env.WORLDLINEBOX_CAPTURE_LATENCY_BASELINE ? 'before.json' : 'after.json'), JSON.stringify({ samples, trace }, null, 2));
    console.log('CAPTURE_STARTUP_MS', JSON.stringify(samples.map(({ task, elapsed }) => ({ task, elapsed }))));
    if (!process.env.WORLDLINEBOX_CAPTURE_LATENCY_BASELINE) {
      expect(samples[0]!.elapsed, 'First invocation includes a cold renderer').toBeLessThan(4500);
      const repeated = samples.slice(1).map(sample => sample.elapsed).sort((a, b) => a - b);
      expect((repeated[1]! + repeated[2]!) / 2, 'Repeated invocation median').toBeLessThan(2000);
      for (const sample of samples.slice(1)) expect(sample.elapsed, sample.task).toBeLessThan(4000);
    }
  } finally {
    await application.close();
    cleanup(profile);
  }
});
