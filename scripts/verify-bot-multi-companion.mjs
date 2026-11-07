import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw Error('Pass --real to authorize actual configured model requests and an isolated native DSH task.');
const project = process.cwd(), require = createRequire(import.meta.url);
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
let program = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM;
if (!program) {
  const runtimes = JSON.parse(await readFile(path.join(source, 'dsh/runtimes.json'), 'utf8'));
  const runtime = runtimes.filter(value => value.adapter === 'node-cli-web-v1').sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!runtime) throw Error('An installed official DSH Node runtime is required.');
  program = path.join(source, 'dsh/runtimes', runtime.id, 'program');
}
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-multi-companion-'));
const output = path.resolve('artifacts/superagent-bot-development/multi-companion-real', path.basename(root)); await mkdir(output, { recursive: true });
const bundle = path.join(output, 'acceptance.cjs'), roots = new Set([root]);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
let result, child, timer, terminating = Promise.resolve();
try {
  const profile = path.join(root, 'electron-profile'); await mkdir(profile);
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  await build({ configFile: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-multi-companion-real.ts', target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_MULTI_COMPANION_REAL: '1', WORLDLINEBOX_MULTI_COMPANION_ROOT: root, WORLDLINEBOX_MULTI_COMPANION_OUTPUT: output,
    WORLDLINEBOX_MULTI_COMPANION_SCENARIO: process.argv.includes('--peer') ? 'peer' : 'group',
    WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source, WORLDLINEBOX_BOT_DSH_PROGRAM: path.resolve(program) }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', value => {
    if (value?.kind === 'multi-companion-progress') process.stdout.write(JSON.stringify(value) + '\n');
    if (value?.kind === 'multi-companion-owned-root' && typeof value.root === 'string') roots.add(value.root);
    if (value?.kind === 'multi-companion-result') result = value;
  });
  timer = setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    terminating = process.platform === 'win32'
      ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      : Promise.resolve(child.kill('SIGKILL'));
  }, 900000); timer.unref();
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  result ??= { kind: 'multi-companion-result', passed: false, stage: 'process-exited', exitCode };
} catch (error) {
  result ??= { kind: 'multi-companion-result', passed: false, stage: 'runner', errorName: error instanceof Error ? error.name : 'Error' };
} finally {
  clearTimeout(timer); await terminating;
  result ??= { kind: 'multi-companion-result', passed: false, stage: 'interrupted' };
  const retained = []; let removed = 0;
  for (const target of roots) try { await removeAcceptanceRoot(target, process.pid); removed++; }
  catch { retained.push(path.basename(target)); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push(path.basename(bundle)); }
  result.cleanup = { removed, retained };
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, evidence: output })); process.exitCode = result.passed ? 0 : 1;
