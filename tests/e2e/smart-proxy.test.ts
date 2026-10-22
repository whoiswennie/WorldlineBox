import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('smart/global policy routes real Chromium and Node requests and loads cross-origin CSS, JS and images', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-smart-proxy-')); const output = path.join(root, 'fixture');
  await mkdir(path.join(root, 'electron-data')); await mkdir(output);
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, build: { ssr: path.resolve('tests/fixtures/dsh-network/smart-proxy.ts'), outDir: output, target: 'node24',
    rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const child = spawn(resolveElectronExecutablePath(), [path.join(output, 'main.cjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: electronLaunchEnv({ WORLDLINEBOX_SMART_PROXY_ROOT: root }) });
  let log = ''; child.stdout.on('data', chunk => { log += String(chunk); }); child.stderr.on('data', chunk => { log += String(chunk); });
  const timer = setTimeout(() => child.kill(), 75_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  await test.info().attach('smart-proxy-transports', { body: log, contentType: 'text/plain' });
  expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('SMART_PROXY_RESULT');
});

test('records real public Pixiv checks and the production browser rendering with the selected local proxy', async () => {
  test.skip(process.env.WORLDLINEBOX_PIXIV_LIVE !== '1', 'Explicit opt-in for real public Pixiv requests.');
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-pixiv-live-')); const output = path.join(root, 'fixture');
  await mkdir(path.join(root, 'electron-data')); await mkdir(output);
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, build: { ssr: path.resolve('tests/fixtures/dsh-network/pixiv-live.ts'), outDir: output, target: 'node24',
    rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const child = spawn(resolveElectronExecutablePath(), [path.join(output, 'main.cjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: electronLaunchEnv({ WORLDLINEBOX_PIXIV_LIVE_ROOT: root }) });
  let log = ''; child.stdout.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); }); child.stderr.on('data', chunk => { log += String(chunk); });
  const timer = setTimeout(() => child.kill(), 160_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  await test.info().attach('pixiv-live', { body: log, contentType: 'text/plain' });
  expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('PIXIV_LIVE_RESULT');
  console.log('PIXIV_LIVE_EVIDENCE ' + root);
});
