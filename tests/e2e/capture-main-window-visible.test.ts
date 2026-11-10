import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { CaptureToolsRequest, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

async function request(page: Page, input: CaptureToolsRequest) {
  const response = await page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { captureTools: WorldlineBoxCaptureToolsApi }).captureTools.request(input), input);
  if (!response.ok) throw Error(response.error);
  return response;
}
async function closeTool(page: Page) {
  await request(page, { type: 'close' }).catch(error => { if (!page.isClosed()) throw error; });
  await expect.poll(() => page.isClosed()).toBe(true);
}

// Real desktop capture/MediaRecorder and FFmpeg; no stream or window mocks.
// eslint-disable-next-line no-empty-pattern
test('captures and records the visible application, and respects a manually hidden main window', async ({}) => {
  test.setTimeout(150000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-capture-main-visible-'));
  const evidence = path.resolve('artifacts/unified-capture-ui'); await mkdir(evidence, { recursive: true });
  const downloads = path.join(profile, 'Downloads'); await mkdir(downloads);
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
    WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_CAPTURE_DOWNLOAD_PATH: downloads }, { gpu: 'hardware' }) });
  const main = await app.firstWindow(), window = await app.browserWindow(main);
  const visible = () => window.evaluate(window => window.isVisible());
  const toolPage = async () => {
    await expect.poll(() => app.windows().some(page => page.url().includes('window=capture-tools'))).toBe(true);
    const page = app.windows().find(page => page.url().includes('window=capture-tools'))!;
    await expect.poll(() => page.evaluate(() => !!Reflect.get(window, 'worldlinebox')?.captureTools)).toBe(true); return page;
  };
  try {
    await expect(main.locator('[data-application-module="dsh"]')).toBeVisible({ timeout: 30000 });
    await window.evaluate(window => { window.setSize(1040, 760); window.show(); window.webContents.setBackgroundThrottling(false); });
    const sourceId = await window.evaluate(window => window.getMediaSourceId());
    await request(main, { type: 'open', task: 'screenshot' }); let tool = await toolPage(); expect(await visible()).toBe(true);
    const image = (await request(tool, { type: 'screenshot.capture', sourceId })).source!; expect(await visible()).toBe(true);
    const bytes = Buffer.from(image.dataUrl.split(',')[1]!, 'base64'), meta = await sharp(bytes).metadata();
    expect(meta.width).toBeGreaterThan(500); expect(meta.height).toBeGreaterThan(400);
    expect((await sharp(bytes).stats()).channels.some(channel => channel.stdev > 10)).toBe(true);
    await writeFile(path.join(evidence, 'visible-application-screenshot.png'), bytes);
    await closeTool(tool); expect(await visible()).toBe(true);

    await request(main, { type: 'open', task: 'recording' }); tool = await toolPage(); expect(await visible()).toBe(true);
    await request(tool, { type: 'screenshot.capture', sourceId }); await tool.reload();
    await tool.getByRole('combobox', { name: '选择屏幕或窗口', exact: true }).click();
    await tool.locator(`[role="option"][data-value="${sourceId}"]`).click();
    await tool.getByLabel('录制系统声音', { exact: true }).uncheck();
    await tool.getByRole('button', { name: '开始录制', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-recording/u, { timeout: 30000 }); expect(await visible()).toBe(true);
    await expect.poll(async () => (await request(main, { type: 'state' })).state?.recording?.bytes ?? 0, { timeout: 15000 }).toBeGreaterThan(0);
    await tool.getByRole('button', { name: '暂停', exact: true }).click(); await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-paused/u); expect(await visible()).toBe(true);
    await tool.getByRole('button', { name: '继续', exact: true }).click(); await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-recording/u);
    await expect.poll(async () => (await request(main, { type: 'state' })).state?.recording?.bytes ?? 0).toBeGreaterThan(2000);
    await tool.getByRole('button', { name: '停止并保存', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-saved/u, { timeout: 60000 }); expect(await visible()).toBe(true);
    const recording = (await request(main, { type: 'state' })).state!.recording!;
    const ffprobe = spawnSync(path.resolve('resources/ffmpeg/win32-x64/ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', recording.path!], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    expect(ffprobe.status, ffprobe.stderr).toBe(0);
    const metadata = JSON.parse(ffprobe.stdout) as { streams: Array<{ codec_name: string; width: number; height: number }>; format: { duration: string } };
    expect(metadata.streams[0]!.codec_name).toBe('h264'); expect(Number(metadata.format.duration)).toBeGreaterThan(.1);
    const decode = spawnSync(path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-i', recording.path!, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
    expect(decode.status, decode.stderr.toString()).toBe(0);
    expect((await sharp(decode.stdout).stats()).channels.some(channel => channel.stdev > 10)).toBe(true);
    await writeFile(path.join(evidence, 'recorded-application-frame.png'), decode.stdout);
    await closeTool(tool); expect(await visible()).toBe(true);

    await window.evaluate(window => window.hide()); expect(await visible()).toBe(false);
    for (const task of ['screenshot', 'recording'] as const) {
      await request(main, { type: 'open', task }); tool = await toolPage(); expect(await visible()).toBe(false);
      await closeTool(tool); expect(await visible()).toBe(false);
    }
    await writeFile(path.join(evidence, 'capture-window-result.json'), JSON.stringify({ passed: true, profile, sourceId, screenshot: { width: image.width, height: image.height }, recording, metadata, mainVisibleDuringScreenshotAndRecording: true, manualHidePreserved: true }, null, 2));
  } finally { await app.close(); }
});
