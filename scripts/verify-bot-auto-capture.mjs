import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw new Error('Pass --real explicitly; this opt-in automatic-memory acceptance uses the configured paid model (maximum ten requests).');
const project = process.cwd(), require = createRequire(import.meta.url);
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const requested = process.argv.indexOf('--output'), stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (requested >= 0 && (!process.argv[requested + 1] || process.argv[requested + 1].startsWith('--'))) throw new Error('--output requires a new directory.');
const output = path.resolve(requested >= 0 ? process.argv[requested + 1] : `artifacts/superagent-bot-development/auto-capture-v2-real-${stamp}`);
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output); // Existing reports must never be overwritten.
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-'));
const profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const bundle = path.join(output, `auto-${path.basename(root)}.cjs`);
let result, child, timer, terminating = Promise.resolve(); const errorNames = new Set();
try {
  const fixtureSource = path.join(project, 'tests/fixtures/bot-app-auto-capture-acceptance.ts');
  await copyFile(fixtureSource, path.join(output, 'fixture.executed.ts'));
  await copyFile(path.join(project, 'scripts/verify-bot-auto-capture.mjs'), path.join(output, 'runner.executed.mjs'));
  await writeFile(path.join(output, 'source-provenance.json'), JSON.stringify({ fixtureSha256: createHash('sha256').update(await readFile(fixtureSource)).digest('hex'), capturedBeforeBuild: true }, null, 2) + '\n');
  // Copy only the OS encryption envelope; application configuration and key
  // files remain read-only in the explicitly selected source profile.
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-app-auto-capture-acceptance.ts', target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_BOT_REAL_ROOT: root, WORLDLINEBOX_BOT_REAL_PROJECT: project,
    WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source, WORLDLINEBOX_BOT_AUTO_CAPTURE_OUTPUT: output, WORLDLINEBOX_BOT_AUTO_CAPTURE_REAL: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.WORLDLINEBOX_BOT_DSH_PROGRAM; delete env.WORLDLINEBOX_BOT_RUNTIME_ID;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { for (const name of chunk.toString().match(/\b[A-Za-z]+Error\b/g) ?? []) errorNames.add(name); });
  child.on('message', value => {
    if (value?.kind === 'bot-auto-capture-progress') process.stdout.write(JSON.stringify(value) + '\n');
    if (value?.kind === 'bot-auto-capture-result') result = value;
  });
  timer = setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    terminating = process.platform === 'win32'
      ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      : Promise.resolve(child.kill('SIGKILL'));
  }, 900000); timer.unref();
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  if (!result) {
    const partial = JSON.parse(await readFile(path.join(output, 'result.partial.json'), 'utf8').catch(() => 'null'));
    result = partial?.runId === path.basename(root) ? partial : { kind: 'bot-auto-capture-result', passed: false, failedStage: 'process-exited', errorNames: [...errorNames] };
    result.passed = false; result.processExitCode = exitCode;
  }
} catch (error) { result = { kind: 'bot-auto-capture-result', passed: false, failedStage: 'runner', errorNames: [error instanceof Error ? error.name : 'Error'] }; }
finally {
  if (timer) clearTimeout(timer); await terminating;
  const retained = []; let removedRoots = 0;
  try { await removeAcceptanceRoot(root, process.pid); removedRoots++; }
  catch (error) { retained.push({ name: path.basename(root), reason: error instanceof Error ? error.message : 'Ownership could not be verified.' }); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push({ name: path.basename(bundle), reason: error.code ?? 'BUNDLE_CLEANUP_FAILED' }); }
  result ??= { kind: 'bot-auto-capture-result', passed: false, failedStage: 'runner-interrupted' };
  result.cleanup = { removedRoots, retained };
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const summary = { passed: result.passed, output, model: result.model, modelRequests: result.modelRequests, policyVersion: result.policyVersion,
  automaticNotes: result.automaticNotes, coldRestart: result.coldRestart, checks: result.checks, errors: result.errors, cleanup: result.cleanup,
  replies: result.turns?.map(turn => ({ input: turn.input, reply: turn.reply, capture: turn.capture, timing: turn.timing })),
  coldReplies: result.cold?.map(value => ({ mode: value.mode, query: value.query, reply: value.reply, evidenceHits: value.report?.hits?.length, proof: value.proof })),
  humanReviewRequired: true };
await writeFile(path.join(output, 'quality-summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary) + '\n'); process.exitCode = result.passed ? 0 : 1;
