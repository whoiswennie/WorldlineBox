import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (process.argv.includes('--protocol') && process.argv.includes('--real')) throw new Error('Choose one acceptance mode.');
const protocolMode = process.argv.includes('--protocol') || process.env.WORLDLINEBOX_BOT_PROTOCOL_ACCEPTANCE === '1';
if (!protocolMode && !process.argv.includes('--real') && process.env.WORLDLINEBOX_BOT_REAL_ACCEPTANCE !== '1') throw new Error('Pass --protocol or --real, or set the matching WORLDLINEBOX_BOT_*_ACCEPTANCE=1 flag.');
const project = process.cwd(), require = createRequire(import.meta.url);
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const catalog = JSON.parse(await readFile(path.join(source, 'dsh/runtimes.json'), 'utf8'));
const runtime = catalog.filter(value => value.adapter === 'node-cli-web-v1').sort((a,b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
if (!runtime) throw new Error('Official installed DSH Node runtime required.');
const program = path.join(source, 'dsh/runtimes', runtime.id, 'program');
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-'));
const ownedRoots = new Set([root]), profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const output = path.resolve('artifacts/superagent-bot-development/' + (protocolMode ? 'protocol-acceptance' : 'real-acceptance')); await mkdir(output, { recursive: true });
const bundle = path.join(output, 'main-' + path.basename(root) + '.cjs');
let result, child, timer, terminating = Promise.resolve(); const errorNames = new Set();
try {
if (!protocolMode) {
  const localState = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (localState.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }));
}
await build({ configFile: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-real-acceptance.ts', target: 'node24', outDir: output, emptyOutDir: false,
  rollupOptions: { external: ['electron','better-sqlite3','koffi','sharp','libarchive-wasm','7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
const env = { ...process.env, WORLDLINEBOX_BOT_REAL_ROOT: root, WORLDLINEBOX_BOT_REAL_PROJECT: project,
  WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source, WORLDLINEBOX_BOT_DSH_PROGRAM: program,
  WORLDLINEBOX_BOT_PROTOCOL_ACCEPTANCE: protocolMode ? '1' : '0', WORLDLINEBOX_BOT_REAL_ACCEPTANCE: protocolMode ? '0' : '1' }; delete env.ELECTRON_RUN_AS_NODE;
child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'] });
child.stderr.on('data', chunk => { for (const value of chunk.toString().match(/\b[A-Za-z]+Error\b/g) ?? []) errorNames.add(value); });
child.on('message', value => { if (value?.kind === 'bot-real-progress') process.stdout.write(JSON.stringify(value) + '\n');
  if (value?.kind === 'bot-real-owned-root' && typeof value.root === 'string') ownedRoots.add(value.root);
  if (value?.kind === 'bot-real-result') result = value; });
timer = setTimeout(() => {
  if (child.exitCode !== null || !child.pid) return;
  terminating = process.platform === 'win32'
    ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
    : Promise.resolve(child.kill('SIGKILL'));
}, 900000); timer.unref();
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); }); clearTimeout(timer);
if (!result) result = { kind: 'bot-real-result', passed: false, failedStage: 'process-exited', exitCode, errorNames: [...errorNames] };
} catch (error) {
  result ??= { kind: 'bot-real-result', passed: false, failedStage: 'runner', errorNames: [error instanceof Error ? error.name : 'Error'] };
} finally {
  if (timer) clearTimeout(timer); await terminating;
  const retained = []; let removedRoots = 0;
  for (const target of ownedRoots) try { await removeAcceptanceRoot(target, process.pid); removedRoots++; }
  catch (error) { retained.push({ name: path.basename(target), reason: error instanceof Error ? error.message : 'Cleanup could not verify process termination.' }); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push({ name: path.basename(bundle), reason: error.code ?? 'BUNDLE_CLEANUP_FAILED' }); }
  result ??= { kind: 'bot-real-result', passed: false, failedStage: 'runner-interrupted' };
  result.cleanup = { removedRoots, retained };
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.passed ? 0 : 1;
