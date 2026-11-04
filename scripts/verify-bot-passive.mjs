import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw new Error('Pass --real explicitly. This controlled App+VCP acceptance uses the configured paid model.');
const project = process.cwd(), require = createRequire(import.meta.url);
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const output = path.resolve('artifacts/superagent-bot-development/passive-app-real-acceptance'); await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-'));
const profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const bundle = path.join(output, 'main-' + path.basename(root) + '.cjs');
let result, child, timer, terminating = Promise.resolve(); const errorNames = new Set();
try {
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  await build({ configFile: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-app-passive-acceptance.ts', target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_BOT_REAL_ROOT: root, WORLDLINEBOX_BOT_REAL_PROJECT: project, WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source,
    WORLDLINEBOX_BOT_PASSIVE_OUTPUT: output, WORLDLINEBOX_BOT_PASSIVE_REAL: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.WORLDLINEBOX_BOT_DSH_PROGRAM; delete env.WORLDLINEBOX_BOT_RUNTIME_ID;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { for (const name of chunk.toString().match(/\b[A-Za-z]+Error\b/g) ?? []) errorNames.add(name); });
  child.on('message', value => {
    if (value?.kind === 'bot-passive-progress') process.stdout.write(JSON.stringify(value) + '\n');
    if (value?.kind === 'bot-passive-result') result = value;
  });
  timer = setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    terminating = process.platform === 'win32' ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      : Promise.resolve(child.kill('SIGKILL'));
  }, 900000); timer.unref();
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
  if (!result) {
    // Keep completed stages and raw evidence if a later stage fails or times out.
    const partial = JSON.parse(await readFile(path.join(output, 'result.partial.json'), 'utf8').catch(() => 'null'));
    result = partial?.runId === path.basename(root) ? partial : { kind: 'bot-passive-result', passed: false, failedStage: 'process-exited', exitCode, errorNames: [...errorNames] };
    result.passed = false; result.processExitCode = exitCode;
  }
} catch (error) { result = { kind: 'bot-passive-result', passed: false, failedStage: 'runner', errorNames: [error instanceof Error ? error.name : 'Error'] }; }
finally {
  if (timer) clearTimeout(timer); await terminating;
  const retained = []; let removedRoots = 0;
  try { await removeAcceptanceRoot(root, process.pid); removedRoots++; }
  catch (error) { retained.push({ name: path.basename(root), reason: error instanceof Error ? error.message : 'Cleanup could not verify ownership.' }); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push({ name: path.basename(bundle), reason: error.code ?? 'BUNDLE_CLEANUP_FAILED' }); }
  result ??= { kind: 'bot-passive-result', passed: false, failedStage: 'runner-interrupted' };
  result.cleanup = { removedRoots, retained };
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const summary = { passed: result.passed, boundary: result.testBoundary, model: result.model, embedding: result.embedding, dshHostsStarted: result.dshHostsStarted,
  appModelRequests: result.appModelRequests, humanQualityReviewRequired: true,
  cases: result.observations?.map(value => ({ label: value.label, passed: value.passed, reply: value.reply, timing: value.timing, proof: value.structuralProof,
    tools: value.tools?.map(call => call.name) })), stages: result.stages, errors: result.errors, cleanup: result.cleanup };
await writeFile(path.join(output, 'quality-summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary) + '\n'); process.exitCode = result.passed ? 0 : 1;
