import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('proxy switch immediately routes existing Chromium and Node connections through proxy/direct/proxy', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-proxy-toggle-')); const output = path.join(root, 'fixture');
  await mkdir(path.join(root, 'electron-data')); await mkdir(output);
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, build: { ssr: path.resolve('tests/fixtures/dsh-network/proxy-toggle.ts'), outDir: output, target: 'node24',
    rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true }, build: { ssr: path.resolve('tests/fixtures/dsh-network/proxy-worker.ts'), outDir: output, emptyOutDir: false, target: 'node24',
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'worker.cjs' } } } });
  const entry = path.join(output, 'entry.cjs'); await writeFile(entry, "try{require('./main.cjs')}catch(error){console.error(error);require('electron').app.exit(1)}");
  const child = spawn(resolveElectronExecutablePath(), [entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: electronLaunchEnv({ WORLDLINEBOX_PROXY_TOGGLE_FIXTURE_ROOT: root }) });
  let log = ''; child.stdout.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); }); child.stderr.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); });
  const timer = setTimeout(() => child.kill(), 75_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  await test.info().attach('proxy-toggle-local', { body: log, contentType: 'text/plain' });
  expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('PROXY_TOGGLE_RESULT');
});
