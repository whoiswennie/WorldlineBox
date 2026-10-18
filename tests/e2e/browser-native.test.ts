import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('native browser preserves pages and sign-ins across module/process switches and supports fullscreen and real downloads', async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-browser-native-')); const output = path.join(root, 'fixture');
  for (const directory of ['electron-data', 'downloads', 'fixture']) await mkdir(path.join(root, directory));
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, build: { ssr: path.resolve('tests/fixtures/browser/main.ts'), outDir: output, target: 'node24',
    rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const entry = path.join(output, 'entry.cjs'); await writeFile(entry, "try{require('./main.cjs')}catch(error){console.error(error);require('electron').app.exit(1)}");
  // The test runner serves loopback pages; the browser itself only makes outbound requests.
  const payload = Buffer.from('WorldlineBox browser download verification\n'.repeat(100));
  const server = http.createServer((request, response) => {
    if (request.url === '/download') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="sample.bin"', 'content-length': payload.length }); response.end(payload); return; }
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'public, max-age=86400' });
    response.end('<!doctype html><html><head><title>' + (request.url === '/two' ? 'Beta' : 'Alpha') + '</title></head><body><h1>Browser fixture ' + request.url + '</h1><p>searchable fixture text</p><a href="/two" target="_blank">New tab</a><video id="video" controls muted></video></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No loopback server port');
  const origin = `http://127.0.0.1:${address.port}`;
  try { for (const phase of ['initial', 'restore']) {
    const child = spawn(resolveElectronExecutablePath(), [entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: electronLaunchEnv({ WORLDLINEBOX_BROWSER_FIXTURE_ROOT: root, WORLDLINEBOX_BROWSER_FIXTURE_PHASE: phase, WORLDLINEBOX_BROWSER_FIXTURE_ORIGIN: origin }) });
    let log = ''; child.stdout.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); }); child.stderr.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); });
    const timer = setTimeout(() => child.kill(), 65_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
    await test.info().attach('browser-' + phase, { body: log, contentType: 'text/plain' });
    expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('BROWSER_FIXTURE_RESULT');
  } } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
