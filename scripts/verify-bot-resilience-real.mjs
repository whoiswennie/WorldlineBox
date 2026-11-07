import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw Error('Pass --real to run the configured provider and an isolated official DSH Host.');
const require = createRequire(import.meta.url), source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const program = path.resolve(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM ?? '.tools/dsh-0.2.2-rc.1-acceptance/staging-retry/program');
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-resilience-'));
const output = path.resolve('artifacts/superagent-bot-development/resilience-real', path.basename(root)); await mkdir(output, { recursive: true });
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const bundle = path.join(output, 'acceptance.cjs'), roots = new Set([root]);
let child, timer, result, terminating = Promise.resolve();
try {
  const profile = path.join(root, 'electron-profile'); await mkdir(profile);
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  await build({ configFile: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-resilience-real.ts', target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_RESILIENCE_REAL: '1', WORLDLINEBOX_RESILIENCE_ROOT: root, WORLDLINEBOX_RESILIENCE_OUTPUT: output,
    WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source, WORLDLINEBOX_BOT_DSH_PROGRAM: program }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [bundle], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', value => {
    if (value?.kind === 'resilience-progress') console.log(JSON.stringify(value));
    if (value?.kind === 'resilience-owned-root' && typeof value.root === 'string') roots.add(value.root);
    if (value?.kind === 'resilience-result') result = value;
  });
  timer = setTimeout(() => {
    if (!child.pid || child.exitCode !== null) return;
    terminating = process.platform === 'win32' ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined) : Promise.resolve(child.kill('SIGKILL'));
  }, 660000); timer.unref();
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  result ??= { kind: 'resilience-result', passed: false, stage: 'process-exited', exitCode };
} catch (error) { result ??= { kind: 'resilience-result', passed: false, stage: 'runner', errorName: error instanceof Error ? error.name : 'Error' }; }
finally {
  clearTimeout(timer); await terminating; result ??= { kind: 'resilience-result', passed: false, stage: 'interrupted' };
  const retained = []; let removed = 0;
  for (const target of roots) try { await removeAcceptanceRoot(target, process.pid); removed++; } catch { retained.push(path.basename(target)); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push(path.basename(bundle)); }
  result.cleanup = { removed, retained };
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, evidence: output })); process.exitCode = result.passed ? 0 : 1;
