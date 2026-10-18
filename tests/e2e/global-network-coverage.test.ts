import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('global proxy switches actual library AI, companion providers and semantic HTTP without restarting modules', async () => {
  test.setTimeout(120_000);
  await mkdir(path.resolve('.tools/global-network-coverage'), { recursive: true });
  // Keep the isolated Worker underneath the project so its native external
  // modules resolve exactly as they do from the real application bundle.
  const root = await mkdtemp(path.resolve('.tools/global-network-coverage/run-')); const output = path.join(root, 'fixture');
  await mkdir(path.join(root, 'electron-data')); await mkdir(output);
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, build: { ssr: path.resolve('tests/fixtures/global-network-coverage/main.ts'), outDir: output, target: 'node24',
    rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const workerExternals = ['electron', 'better-sqlite3', 'sqlite-vec', 'koffi', 'sharp', 'trash', 'exifr', '@napi-rs/canvas'];
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: workerExternals },
    build: { ssr: path.resolve('src/worker/index.ts'), outDir: output, emptyOutDir: false, target: 'node24',
      rollupOptions: { external: workerExternals, output: { format: 'cjs', entryFileNames: 'library_worker.js' } } } });
  const entry = path.join(output, 'entry.cjs'); await writeFile(entry, "try{require('./main.cjs')}catch(error){console.error(error);require('electron').app.exit(1)}");
  const child = spawn(resolveElectronExecutablePath(), [entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: electronLaunchEnv({ WORLDLINEBOX_GLOBAL_NETWORK_COVERAGE_ROOT: root }) });
  let log = ''; child.stdout.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); }); child.stderr.on('data', chunk => { log += String(chunk); console.log(String(chunk).trim()); });
  const timer = setTimeout(() => child.kill(), 90_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  await test.info().attach('global-network-real-modules', { body: log, contentType: 'text/plain' });
  expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('GLOBAL_NETWORK_COVERAGE_RESULT');
});
