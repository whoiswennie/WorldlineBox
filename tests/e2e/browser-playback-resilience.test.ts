import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('video links open as real browser tabs, decode H.264/AAC and recover from failed navigation', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-browser-playback-'));
  const clipPath = path.join(root, 'clip.mp4');
  const encoded = spawnSync(path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libopenh264', '-b:v', '128k',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', clipPath,
  ], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  expect(encoded.status, encoded.stderr).toBe(0);
  const clip = await readFile(clipPath);
  let mediaRequests = 0;
  let disconnect = true;
  const server = createServer((request, response) => {
    if (request.url === '/disconnect' && disconnect) { request.socket.destroy(); return; }
    if (request.url === '/clip.mp4') {
      mediaRequests++;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
      response.writeHead(range ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes',
        'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${clip.length}` } : {}) });
      response.end(clip.subarray(start, end + 1)); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'none'; style-src 'none'; media-src 'self'" });
    response.end(request.url === '/video'
      ? '<!doctype html><html><head><title>Playback fixture</title></head><body><video id="clip" controls muted loop src="/clip.mp4"></video><iframe src="about:blank"></iframe></body></html>'
      : '<!doctype html><html><head><title>Video links</title></head><body><a href="/video" target="_blank">播放视频</a></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No playback fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let output = '';
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(),
      args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }) });
    application.process().stderr?.on('data', chunk => { output += String(chunk); });
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const shell = await application.firstWindow();
    const native = await application.browserWindow(shell);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await shell.locator('[data-application-module="browser"]').click();
    await expect(shell.locator('.browser-tabs [role="tab"]')).toHaveCount(1);
    const location = shell.getByRole('textbox', { name: '搜索或输入网址' });
    await location.fill(origin + '/home'); await location.press('Enter');
    await expect.poll(() => application!.context().pages().some(page => page.url() === origin + '/home')).toBe(true);
    const home = application.context().pages().find(page => page.url() === origin + '/home')!;
    await home.getByRole('link', { name: '播放视频' }).click();
    await expect.poll(() => application!.context().pages().some(page => page.url() === origin + '/video')).toBe(true);
    const player = application.context().pages().find(page => page.url() === origin + '/video')!;
    await expect(location).toHaveValue(origin + '/video');
    await player.locator('#clip').evaluate(async element => { const video = element as HTMLVideoElement; video.muted = true; await video.play(); });
    await expect.poll(() => player.locator('#clip').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.25);
    expect(await player.locator('#clip').evaluate(element => {
      const video = element as HTMLVideoElement;
      return { width: video.videoWidth, height: video.videoHeight, error: video.error?.message ?? null, paused: video.paused };
    })).toEqual({ width: 64, height: 48, error: null, paused: false });
    expect(mediaRequests).toBeGreaterThan(0);
    expect(await player.evaluate(() => ({ require: typeof Reflect.get(globalThis, 'require'), bridge: typeof Reflect.get(globalThis, 'worldlinebox') })))
      .toEqual({ require: 'undefined', bridge: 'undefined' });

    // A failed main-frame navigation presents a recoverable browser error;
    // an aborted/stale load must not overwrite the next successful video page.
    await location.fill(origin + '/disconnect'); await location.press('Enter');
    await expect(shell.locator('.browser-failure')).toBeVisible();
    await expect(shell.locator('.browser-failure code')).toContainText('ERR_EMPTY_RESPONSE');
    await expect(shell.locator('.browser-failure').getByRole('button', { name: '全局网络设置' })).toBeVisible();
    disconnect = false;
    await shell.locator('.browser-failure').getByRole('button', { name: '重新加载' }).click();
    await expect(shell.locator('.browser-failure')).toBeHidden();
    await expect.poll(() => application!.context().pages().some(page => page.url() === origin + '/disconnect')).toBe(true);
    await location.fill(origin + '/video'); await location.press('Enter');
    await expect(shell.locator('.browser-failure')).toBeHidden();
    await expect.poll(() => application!.context().pages().some(page => page.url() === origin + '/video')).toBe(true);
    await expect(location).toHaveValue(origin + '/video');
    expect(output).not.toContain('Invalid webContents');
    expect(output).not.toContain("Error occurred in handler for 'worldlinebox:browser:capture:content:request'");
    expect(output).not.toContain('Unable to load preload script');
    await test.info().attach('browser-playback-runtime', { body: output, contentType: 'text/plain' });
  } catch (error) {
    if (application) console.log('PLAYBACK_DIAGNOSTIC', await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => ({ id: contents.id, url: contents.getURL() }))));
    console.log(output.slice(-6000));
    throw error;
  } finally {
    await application?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
