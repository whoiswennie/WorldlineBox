import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw Error('Pass --real for an isolated native DSH and actual configured model acceptance (maximum 18 provider requests).');
const project = process.cwd(), require = createRequire(import.meta.url);
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const runtimes = JSON.parse(await readFile(path.join(source, 'dsh/runtimes.json'), 'utf8'));
const runtime = runtimes.filter(value => value.adapter === 'node-cli-web-v1').sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
const program = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM ?? (runtime && path.join(source, 'dsh/runtimes', runtime.id, 'program'));
if (!program) throw Error('An installed official Node DSH runtime is required.');
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-delivery-'));
const output = path.resolve('artifacts/superagent-bot-development/worker-delivery-real', path.basename(root)); await mkdir(output, { recursive: true });
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const bundle = path.join(output, 'acceptance.cjs'), roots = new Set([root]), digest = value => createHash('sha256').update(value).digest('hex');
let result, child, timer, settingsBefore, terminating = Promise.resolve();
try {
  settingsBefore = digest(await readFile(path.join(source, 'ai-profiles.json')));
  const profile = path.join(root, 'electron-profile'); await mkdir(profile);
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  const fixture = 'tests/fixtures/bot-worker-delivery-real.ts';
  await copyFile(fixture, path.join(output, 'fixture.executed.ts')); await copyFile('scripts/verify-bot-worker-delivery.mjs', path.join(output, 'runner.executed.mjs'));
  await writeFile(path.join(output, 'provenance.json'), JSON.stringify({ fixture: digest(await readFile(fixture)),
    service: digest(await readFile('src/main/companion-bot/service.ts')), report: digest(await readFile('src/main/companion-bot/task-report.ts')),
    bridge: digest(await readFile('resources/dsh-bridge/index.js')), settingsBefore }, null, 2));
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: fixture, target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_WORKER_DELIVERY_REAL: '1', WORLDLINEBOX_WORKER_DELIVERY_ROOT: root,
    WORLDLINEBOX_WORKER_DELIVERY_OUTPUT: output, WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source, WORLDLINEBOX_BOT_DSH_PROGRAM: path.resolve(program) };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const errorNames = new Set(); child.stderr.on('data', chunk => { for (const name of chunk.toString().match(/\b[A-Za-z]+Error\b/g) ?? []) errorNames.add(name); });
  child.on('message', value => {
    if (value?.kind === 'worker-delivery-progress') console.log(JSON.stringify(value));
    if (value?.kind === 'worker-delivery-owned-root' && typeof value.root === 'string') roots.add(value.root);
    if (value?.kind === 'worker-delivery-result') result = value;
  });
  timer = setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    terminating = process.platform === 'win32' ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      : Promise.resolve(child.kill('SIGKILL'));
  }, 360000); timer.unref();
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  result ??= { kind: 'worker-delivery-result', passed: false, failedStage: 'process-exited', exitCode, errorNames: [...errorNames] };
} catch (error) { result = { kind: 'worker-delivery-result', passed: false, failedStage: 'runner', errorName: error instanceof Error ? error.name : 'Error' }; }
finally {
  if (timer) clearTimeout(timer); await terminating;
  result ??= { kind: 'worker-delivery-result', passed: false, failedStage: 'interrupted' };
  result.productionSettingsUnchanged = !!settingsBefore && settingsBefore === await readFile(path.join(source, 'ai-profiles.json')).then(digest).catch(() => undefined);
  const retained = []; let removed = 0;
  for (const target of roots) try { await removeAcceptanceRoot(target, process.pid); removed++; } catch { retained.push(path.basename(target)); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push(path.basename(bundle)); }
  result.cleanup = { removed, retained }; if (retained.length || !result.productionSettingsUnchanged) result.passed = false;
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: result.passed, model: result.model, providerRequests: result.providerRequests,
  task: result.task ? { id: result.task.id, status: result.task.status, resultChars: result.task.summary?.length } : undefined,
  routerAnswer: result.routerAnswer, failedStage: result.failedStage, error: result.error, errorNames: result.errorNames,
  cleanup: result.cleanup, productionSettingsUnchanged: result.productionSettingsUnchanged })); process.exitCode = result.passed ? 0 : 1;
