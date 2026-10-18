import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('live temporary downloads follow newly saved proxies and mirrors in Chromium and Node, including restart', async () => {
  test.skip(process.env.WORLDLINEBOX_NETWORK_LIVE !== '1', 'Explicit opt-in for small public internet downloads.');
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-network-live-')); const output = path.join(root, 'fixture');
  await mkdir(path.join(root, 'electron-data')); await mkdir(output);
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, build: { ssr: path.resolve('tests/fixtures/dsh-network-live/main.ts'), outDir: output, target: 'node24',
    rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const entry = path.join(output, 'entry.cjs'); await writeFile(entry, "try{require('./main.cjs')}catch(error){console.error(error);require('electron').app.exit(1)}");
  const child = spawn(resolveElectronExecutablePath(), [entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: electronLaunchEnv({ WORLDLINEBOX_NETWORK_LIVE_ROOT: root }) });
  let log = ''; child.stdout.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); }); child.stderr.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); });
  const timer = setTimeout(() => child.kill(), 225_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  await test.info().attach('network-live-downloads', { body: log, contentType: 'text/plain' });
  expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('NETWORK_LIVE_RESULT');
});
