import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('companions use shared native tabs with live presence, independent refs and user cancellation', async () => {
  test.skip(Boolean(process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE), 'Uses a dedicated source fixture.');
  test.setTimeout(120000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-companion-browser-')), output = path.join(root, 'fixture');
  await mkdir(output); await mkdir(path.join(root, 'electron-data'));
  const clipPath = path.join(root, 'clip.mp4');
  const encoded = spawnSync(path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=12',
    '-t', '3', '-c:v', 'libopenh264', '-b:v', '128k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', clipPath], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  expect(encoded.status, encoded.stderr).toBe(0); const clip = await readFile(clipPath);
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, build: { ssr: path.resolve('tests/fixtures/browser/companions.ts'), outDir: output,
    target: 'node24', rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const server = http.createServer((request, response) => {
    if (request.url === '/clip.mp4') {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? ''), start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
      response.writeHead(range ? 206 : 200, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${clip.length}` } : {}) }); response.end(clip.subarray(start, end + 1)); return;
    }
    if (request.url === '/captions.vtt') { response.writeHead(200, { 'content-type': 'text/vtt' }); response.end('WEBVTT\n\n00:00.000 --> 00:03.000\nExisting site subtitle, no ASR.\n'); return; }
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    if (request.url === '/video') { response.end('<!doctype html><title>Video fixture</title><video controls muted src="/clip.mp4"><track default kind="subtitles" srclang="en" src="/captions.vtt"></video>'); return; }
    response.end('<!doctype html><title>Shared native page</title><body style="background:' + (request.url === '/companion' ? '#234' : '#912') + ';color:white"><h1>' + request.url + '</h1><p>Signed in: ' + (request.headers.cookie ?? 'none') + '</p><input aria-label="Search"><p>Real shared browser pixels</p><a href="/popup" target="_blank">New tab</a>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No loopback port');
  try {
    const child = spawn(resolveElectronExecutablePath(), [path.join(output, 'main.cjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: electronLaunchEnv({ WORLDLINEBOX_BROWSER_FIXTURE_ROOT: root, WORLDLINEBOX_BROWSER_FIXTURE_ORIGIN: `http://127.0.0.1:${address.port}` }) });
    let log = ''; child.stdout.on('data', chunk => { log += String(chunk); }); child.stderr.on('data', chunk => { log += String(chunk); });
    const timer = setTimeout(() => child.kill(), 60000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
    await test.info().attach('native-companion-browser', { body: log, contentType: 'text/plain' });
    expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('COMPANION_BROWSER_RESULT');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
