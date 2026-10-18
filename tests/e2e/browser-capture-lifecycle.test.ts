import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('capture service returns safe lifecycle refusals for real closed, detached, navigating and unowned frames', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-browser-capture-lifecycle-'));
  const output = path.join(root, 'build'); await mkdir(output); await mkdir(path.join(root, 'electron-data'));
  await build({ configFile: path.resolve('vite.browser-capture-preload.config.ts'), logLevel: 'error',
    build: { outDir: output, emptyOutDir: false } });
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] },
    build: { ssr: path.resolve('tests/fixtures/browser-capture/capture-lifecycle-main.ts'), outDir: output, emptyOutDir: false, target: 'node24',
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><body>Capture lifecycle fixture'
      + (request.url === '/main' ? '<iframe src="/child"></iframe>' : '') + '</body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture server port');
  try {
    const child = spawn(resolveElectronExecutablePath(), [path.join(output, 'main.cjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: electronLaunchEnv({ WORLDLINEBOX_CAPTURE_LIFECYCLE_ROOT: root, WORLDLINEBOX_CAPTURE_LIFECYCLE_ORIGIN: `http://127.0.0.1:${address.port}` }) });
    let log = ''; child.stdout.on('data', chunk => { log += String(chunk); }); child.stderr.on('data', chunk => { log += String(chunk); });
    const timer = setTimeout(() => child.kill(), 60_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
    await test.info().attach('browser-capture-lifecycle', { body: log, contentType: 'text/plain' });
    expect(code, log + '\nEvidence: ' + root).toBe(0);
    expect(log).toContain('BROWSER_CAPTURE_LIFECYCLE_RESULT');
    expect(log).not.toContain('Error occurred in handler');
    expect(log).not.toContain('UnhandledPromiseRejection');
    console.log(log.split(/\r?\n/u).find(line => line.startsWith('BROWSER_CAPTURE_LIFECYCLE_RESULT ')));
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
