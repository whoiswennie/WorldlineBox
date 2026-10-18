import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('browser popup native contents preserve link, script, form and background-tab behavior without main-process exceptions', async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-browser-popups-'));
  const output = path.join(root, 'fixture');
  await mkdir(path.join(root, 'electron-data')); await mkdir(output);
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] },
    build: { ssr: path.resolve('tests/fixtures/browser/popups.ts'), outDir: output, target: 'node24',
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const entry = path.join(output, 'entry.cjs');
  await writeFile(entry, "try{require('./main.cjs')}catch(error){console.error(error);require('electron').app.exit(1)}");
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.url === '/posted') {
      const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => response.end(JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString(), referer: request.headers.referer, cookie: request.headers.cookie })));
      return;
    }
    if (request.url === '/opener') {
      response.end('<!doctype html><html><head><title>Popup opener</title></head><body><a id="link" href="/child?kind=link" target="_blank">Open video page</a><br><a id="background" href="/child?kind=background" target="_blank">Background page</a><form id="post" action="/posted" method="POST" target="_blank"><input name="token" value="post-body-preserved"><button type="submit">Submit</button></form></body></html>');
      return;
    }
    response.end('<!doctype html><html><head><title>Popup child</title></head><body>Native browser child page</body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No loopback server port');
  try {
    const child = spawn(resolveElectronExecutablePath(), [entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: electronLaunchEnv({ WORLDLINEBOX_BROWSER_POPUP_ROOT: root, WORLDLINEBOX_BROWSER_POPUP_ORIGIN: `http://127.0.0.1:${address.port}` }) });
    let log = ''; child.stdout.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); }); child.stderr.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); });
    const timer = setTimeout(() => child.kill(), 110_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
    await test.info().attach('browser-popups', { body: log, contentType: 'text/plain' });
    expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('BROWSER_POPUP_RESULT');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
