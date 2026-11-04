import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw new Error('Pass --real explicitly; this isolated maintenance acceptance uses the configured paid model (maximum three requests).');
const project = process.cwd(), require = createRequire(import.meta.url), source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const requested = process.argv.indexOf('--output'), stamp = new Date().toISOString().replace(/[:.]/g, '-');
const kindIndex = process.argv.indexOf('--kind'), kind = kindIndex >= 0 ? process.argv[kindIndex + 1] : undefined;
if (kindIndex >= 0 && !['organize', 'dream'].includes(kind)) throw new Error('--kind must be organize or dream. A focused follow-up permits one model request.');
if (requested >= 0 && (!process.argv[requested + 1] || process.argv[requested + 1].startsWith('--'))) throw new Error('--output requires a new directory.');
const output = path.resolve(requested >= 0 ? process.argv[requested + 1] : `artifacts/superagent-bot-development/maintenance-real-${stamp}`);
if (!output.startsWith(path.resolve(project, 'artifacts') + path.sep)) throw new Error('Acceptance output must stay in this workspace artifacts directory.');
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-')), profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const bundle = path.join(output, `maintenance-${path.basename(root)}.cjs`), digest = bytes => createHash('sha256').update(bytes).digest('hex');
let result, child, timer, settingsBefore, terminating = Promise.resolve(); const errorNames = new Set();
try {
  const fixture = path.join(project, 'tests/fixtures/bot-maintenance-real-acceptance.ts');
  await copyFile(fixture, path.join(output, 'fixture.executed.ts')); await copyFile(path.join(project, 'scripts/verify-bot-maintenance.mjs'), path.join(output, 'runner.executed.mjs'));
  settingsBefore = digest(await readFile(path.join(source, 'ai-profiles.json')));
  await writeFile(path.join(output, 'source-provenance.json'), JSON.stringify({ fixtureSha256: digest(await readFile(fixture)), settingsSha256Before: settingsBefore, capturedBeforeBuild: true }, null, 2) + '\n');
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-maintenance-real-acceptance.ts', target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_BOT_REAL_ROOT: root, WORLDLINEBOX_BOT_REAL_PROJECT: project, WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source,
    WORLDLINEBOX_BOT_MAINTENANCE_OUTPUT: output, WORLDLINEBOX_BOT_MAINTENANCE_REAL: '1', WORLDLINEBOX_BOT_MAINTENANCE_LOSSLESS: process.argv.includes('--apply-lossless') ? '1' : '0' };
  if (kind) env.WORLDLINEBOX_BOT_MAINTENANCE_KIND = kind;
  else delete env.WORLDLINEBOX_BOT_MAINTENANCE_KIND;
  delete env.ELECTRON_RUN_AS_NODE; delete env.WORLDLINEBOX_BOT_DSH_PROGRAM; delete env.WORLDLINEBOX_BOT_RUNTIME_ID;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { for (const name of chunk.toString().match(/\b[A-Za-z]+Error\b/g) ?? []) errorNames.add(name); });
  child.on('message', value => {
    if (value?.kind === 'bot-maintenance-progress') process.stdout.write(JSON.stringify(value) + '\n');
    if (value?.kind === 'bot-maintenance-result') result = value;
  });
  timer = setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    terminating = process.platform === 'win32' ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined) : Promise.resolve(child.kill('SIGKILL'));
  }, 600000); timer.unref();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (!result) {
    const partial = JSON.parse(await readFile(path.join(output, 'result.partial.json'), 'utf8').catch(() => 'null'));
    result = partial?.runId === path.basename(root) ? partial : { kind: 'bot-maintenance-result', passed: false, failedStage: 'process-exited', errorNames: [...errorNames] };
    result.passed = false;
  }
  result.processExitCode = code;
} catch (error) { result = { kind: 'bot-maintenance-result', passed: false, failedStage: 'runner', errorNames: [error instanceof Error ? error.name : 'Error'] }; }
finally {
  if (timer) clearTimeout(timer); await terminating;
  result ??= { kind: 'bot-maintenance-result', passed: false, failedStage: 'runner-interrupted' };
  const settingsAfter = await readFile(path.join(source, 'ai-profiles.json')).then(digest).catch(() => undefined);
  result.productionSettingsUnchanged = !!settingsBefore && settingsAfter === settingsBefore;
  const retained = []; let removedRoots = 0;
  try { await removeAcceptanceRoot(root, process.pid); removedRoots++; } catch (error) { retained.push({ name: path.basename(root), reason: error instanceof Error ? error.message : 'Ownership verification failed.' }); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push({ name: path.basename(bundle), reason: error.code ?? 'BUNDLE_CLEANUP_FAILED' }); }
  result.cleanup = { removedRoots, retained };
  if (!result.productionSettingsUnchanged) result.passed = false;
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const summary = { passed: result.passed, output, model: result.model, modelRequests: result.modelRequests, manualAuthoredFixtureNotes: result.manualAuthoredFixtureNotes,
  checks: result.checks, plans: result.plans?.map(value => ({ kind: value.kind, status: value.job?.status, metrics: value.job?.metrics, timing: value.timing, error: value.error })),
  scopeBoundary: result.boundary, humanReviewRequired: true, errors: result.errors, productionSettingsUnchanged: result.productionSettingsUnchanged, cleanup: result.cleanup };
await writeFile(path.join(output, 'quality-summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary) + '\n'); process.exitCode = result.passed ? 0 : 1;
