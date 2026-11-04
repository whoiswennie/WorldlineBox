import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw Error('Pass --real explicitly. This isolated contact acceptance uses a hard configured-provider request budget.');
const capOnly = process.argv.includes('--cap-only');
const requestedBudget = capOnly ? '1' : process.argv.find(value => value.startsWith('--max-posts='))?.split('=')[1] ?? '3';
if (!['1', '3', '8'].includes(requestedBudget) || (!capOnly && requestedBudget === '1')) throw Error('The explicitly authorized acceptance budgets are 3 or 8 contact POST requests, or one cap-only POST.');
const project = process.cwd(), require = createRequire(import.meta.url), source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const stamp = new Date().toISOString().replace(/[:.]/g, '-'), output = path.resolve(`artifacts/superagent-bot-development/${capOnly ? 'model-cap-real' : 'peer-real'}-${stamp}`);
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-')), profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const bundle = path.join(output, 'peer-main.cjs'), digest = value => createHash('sha256').update(value).digest('hex');
let result, child, timer, settingsBefore, terminating = Promise.resolve(); const errorNames = new Set();
try {
  const fixture = path.join(project, capOnly ? 'tests/fixtures/bot-model-cap-real-acceptance.ts' : 'tests/fixtures/bot-peer-real-acceptance.ts');
  await copyFile(fixture, path.join(output, 'fixture.executed.ts')); await copyFile(path.join(project, 'scripts/verify-bot-peer.mjs'), path.join(output, 'runner.executed.mjs'));
  settingsBefore = digest(await readFile(path.join(source, 'ai-profiles.json')));
  await writeFile(path.join(output, 'source-provenance.json'), JSON.stringify({ fixtureSha256: digest(await readFile(fixture)), settingsSha256Before: settingsBefore,
    limitModuleSha256: capOnly ? digest(await readFile(path.join(project, 'src/main/companion-bot/model-limits.ts'))) : undefined, capturedBeforeBuild: true }, null, 2) + '\n');
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: fixture, target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_BOT_REAL_ROOT: root, WORLDLINEBOX_BOT_REAL_PROJECT: project, WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source,
    WORLDLINEBOX_BOT_PEER_OUTPUT: output, WORLDLINEBOX_BOT_PEER_REAL: '1', WORLDLINEBOX_BOT_PEER_MAX_POSTS: requestedBudget,
    WORLDLINEBOX_BOT_PEER_MEMORY_PROTOCOL: process.argv.includes('--memory-protocol') ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.WORLDLINEBOX_BOT_DSH_PROGRAM; delete env.WORLDLINEBOX_BOT_RUNTIME_ID;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { for (const name of chunk.toString().match(/\b[A-Za-z]+Error\b/g) ?? []) errorNames.add(name); });
  child.on('message', value => {
    if (value?.kind === 'bot-peer-real-progress') process.stdout.write(JSON.stringify(value) + '\n');
    if (value?.kind === 'bot-peer-real-result') result = value;
  });
  timer = setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    terminating = process.platform === 'win32' ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined) : Promise.resolve(child.kill('SIGKILL'));
  }, 360000); timer.unref();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (!result) { result = JSON.parse(await readFile(path.join(output, 'result.partial.json'), 'utf8').catch(() => 'null'))
    ?? { kind: 'bot-peer-real-result', passed: false, failedStage: 'process-exited', errorNames: [...errorNames] }; result.passed = false; }
  result.processExitCode = code;
} catch (error) { result = { kind: 'bot-peer-real-result', passed: false, failedStage: 'runner', errorNames: [error instanceof Error ? error.name : 'Error'] }; }
finally {
  if (timer) clearTimeout(timer); await terminating;
  result ??= { kind: 'bot-peer-real-result', passed: false, failedStage: 'runner-interrupted' };
  const settingsAfter = await readFile(path.join(source, 'ai-profiles.json')).then(digest).catch(() => undefined);
  result.productionSettingsUnchanged = !!settingsBefore && settingsBefore === settingsAfter;
  const retained = []; let removedRoots = 0;
  try { await removeAcceptanceRoot(root, process.pid); removedRoots++; } catch (error) { retained.push({ name: path.basename(root), reason: error instanceof Error ? error.message : 'Ownership cleanup rejected.' }); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push({ name: 'peer-main.cjs', reason: error.code ?? 'BUNDLE_CLEANUP_FAILED' }); }
  result.cleanup = { removedRoots, retained }; if (!result.productionSettingsUnchanged || retained.length) result.passed = false;
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const summary = { passed: result.passed, outcome: result.outcome, output, model: result.model, usesRealChatModel: result.usesRealChatModel, embedding: result.embedding,
  modelRequests: result.modelRequests, maximumModelRequests: result.maximumModelRequests, actualProviderUsage: result.actualProviderUsage,
  idle: result.idle, maximumCausalHopObserved: result.maximumCausalHopObserved, checks: result.checks,
  probe: result.probe, modelLimits: result.modelLimits, request: result.request, httpStatus: result.httpStatus, responseText: result.responseText,
  totalContactMs: result.totalContactMs, dshHostAttempts: result.dshHostAttempts, backgroundEncodingBlocked: result.backgroundEncodingBlocked,
  productionSettingsUnchanged: result.productionSettingsUnchanged, errors: result.errors, cleanup: result.cleanup };
await writeFile(path.join(output, 'quality-summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary) + '\n'); process.exitCode = result.passed ? 0 : 1;
