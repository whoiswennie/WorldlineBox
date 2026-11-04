import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

const diagnostic = process.argv.includes('--native-probe');
if ((!diagnostic && !process.argv.includes('--real')) || !process.argv.includes('--app-router') || diagnostic && process.argv.includes('--real'))
  throw new Error('Use --real --app-router for paid acceptance, or --native-probe --app-router for the no-paid native diagnostic.');
const project = process.cwd(), require = createRequire(import.meta.url);
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-'));
const ownedRoots = new Set([root]), profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const output = path.resolve('artifacts/superagent-bot-development/dsh-app-capability-acceptance', path.basename(root)); await mkdir(output, { recursive: true });
const bundle = path.join(output, 'main.cjs');
let result, child, timer, terminating = Promise.resolve(); const errorNames = new Set();
try {
  if (!diagnostic) {
    const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
    if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  }
  await build({ configFile: false, logLevel: 'warn', build: { ssr: diagnostic ? 'tests/fixtures/bot-native-tool-diagnostic.ts' : 'tests/fixtures/bot-app-dsh-capability-acceptance.ts', target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_BOT_REAL_ROOT: root, WORLDLINEBOX_BOT_REAL_PROJECT: project, WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source,
    WORLDLINEBOX_BOT_DSH_CAPABILITY_OUTPUT: output, WORLDLINEBOX_BOT_DSH_CAPABILITY_REAL: diagnostic ? '0' : '1', WORLDLINEBOX_BOT_NATIVE_DIAGNOSTIC: diagnostic ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.WORLDLINEBOX_BOT_DSH_PROGRAM; delete env.WORLDLINEBOX_BOT_RUNTIME_ID;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { for (const name of chunk.toString().match(/\b[A-Za-z]+Error\b/gu) ?? []) errorNames.add(name); });
  child.on('message', value => {
    if (value?.kind === 'bot-dsh-capability-progress') process.stdout.write(JSON.stringify(value) + '\n');
    if (value?.kind === 'bot-real-owned-root' && typeof value.root === 'string') ownedRoots.add(value.root);
    if (value?.kind === 'bot-dsh-capability-result') result = value;
  });
  timer = setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    terminating = process.platform === 'win32' ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      : Promise.resolve(child.kill('SIGKILL'));
  }, 900000); timer.unref();
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
  if (!result) {
    const partial = JSON.parse(await readFile(path.join(output, 'result.partial.json'), 'utf8').catch(() => 'null'));
    result = partial?.runId === path.basename(root) ? partial : { kind: 'bot-dsh-capability-result', passed: false, failedStage: 'process-exited', errorNames: [...errorNames] };
    result.passed = false; result.processExitCode = exitCode;
  }
} catch (error) { result = { kind: 'bot-dsh-capability-result', passed: false, failedStage: 'runner', errorNames: [error instanceof Error ? error.name : 'Error'] }; }
finally {
  if (timer) clearTimeout(timer); await terminating;
  const retained = []; let removedRoots = 0;
  for (const target of ownedRoots) try { await removeAcceptanceRoot(target, process.pid); removedRoots++; }
  catch (error) { retained.push({ name: path.basename(target), reason: error instanceof Error ? error.message : 'Ownership cleanup refused.' }); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push({ name: 'main.cjs', reason: error.code ?? 'BUNDLE_CLEANUP_FAILED' }); }
  result ??= { kind: 'bot-dsh-capability-result', passed: false, failedStage: 'runner-interrupted' };
  result.cleanup = { removedRoots, retained }; if (retained.length) result.passed = false;
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ output, passed: result.passed, appHttpRequests: result.appHttpRequests, hostStarts: result.hostStarts, hostPid: result.hostPid,
  cases: result.cases?.map(value => ({ index: value.index, passed: value.passed, routerElapsedMs: value.routerElapsedMs, workerElapsedMs: value.workerElapsedMs,
    hostStartDelta: value.hostStartDelta, actualNativeToolCalls: value.actualNativeToolCalls, artifact: value.artifact })), errors: result.errors, cleanup: result.cleanup }) + '\n');
process.exitCode = result.passed ? 0 : 1;
