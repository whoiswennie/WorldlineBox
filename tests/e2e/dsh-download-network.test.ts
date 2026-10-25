import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('real Electron download transport follows HTTPS redirects, rejects downgrades and cleans failed transfers', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-network-'));
  const output = path.join(root, 'fixture'); await mkdir(output);
  await mkdir(path.join(root, 'electron-data'));
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] }, build: { ssr: path.resolve('tests/fixtures/dsh-network/main.ts'), outDir: output, target: 'node24',
    rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  const entry = path.join(output, 'entry.cjs');
  // Catch load failures before Electron's default handler can open a native error dialog.
  await writeFile(entry, "try { require('./main.cjs'); } catch (error) { console.error(error); require('electron').app.exit(1); }\n");
  const child = spawn(resolveElectronExecutablePath(), [entry], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: electronLaunchEnv({ WORLDLINEBOX_DSH_DOWNLOAD_FIXTURE_ROOT: root }),
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); if (String(chunk).includes('DSH_DOWNLOAD_')) console.log(String(chunk).trim()); });
  child.stderr.on('data', chunk => { stderr += String(chunk); console.log(String(chunk).trim()); });
  const timeout = setTimeout(() => child.kill(), 80_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timeout));
  expect(code, `${stdout}\n${stderr}\nFixture retained at ${root}`).toBe(0);
  const result = JSON.parse(/^DSH_DOWNLOAD_RESULT (.+)$/m.exec(stdout)?.[1] ?? '{}') as Record<string, unknown>;
  expect(result).toMatchObject({ emptyFetchUrlReproduced: true, httpsRedirect: true, downgradeBlocked: true, digestMismatch: true, cancellation: true, incompleteCleanup: true });
  await test.info().attach('electron-download-result', { body: stdout, contentType: 'text/plain' });
});
