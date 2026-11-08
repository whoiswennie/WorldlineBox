import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw Error('Pass --real explicitly. This isolated model-routing acceptance permits at most 12 configured-provider POST requests.');
const scenario = process.argv.find(value => value.startsWith('--scenario='))?.split('=')[1] ?? 'all';
if (!['all', 'requester-delegates-weather', 'recipient-executes-user-direct', 'recipient-returns-worker-result', 'peer-participant-executes', 'recipient-return-reminder'].includes(scenario)) throw Error('Unknown peer-work scenario.');
const priorResult = process.argv.find(value => value.startsWith('--prior-result='))?.slice('--prior-result='.length);
const maximumPosts = Number(process.argv.find(value => value.startsWith('--max-posts='))?.split('=')[1] ?? 12);
if (!Number.isInteger(maximumPosts) || maximumPosts < 1 || maximumPosts > 12) throw Error('Provider request budget must be within 1..12.');
const project = process.cwd(), require = createRequire(import.meta.url), source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const stamp = new Date().toISOString().replace(/[:.]/g, '-'), output = path.resolve(`artifacts/superagent-bot-development/peer-work-real-${stamp}`);
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-')), profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const bundle = path.join(output, 'peer-work-main.cjs'), digest = value => createHash('sha256').update(value).digest('hex');
let result, child, timer, settingsBefore, terminating = Promise.resolve(); const errorNames = new Set();
try {
  const fixture = path.join(project, 'tests/fixtures/bot-peer-work-real-acceptance.ts');
  await copyFile(fixture, path.join(output, 'fixture.executed.ts')); await copyFile(path.join(project, 'scripts/verify-bot-peer-work.mjs'), path.join(output, 'runner.executed.mjs'));
  settingsBefore = digest(await readFile(path.join(source, 'ai-profiles.json')));
  await writeFile(path.join(output, 'source-provenance.json'), JSON.stringify({ fixtureSha256: digest(await readFile(fixture)), settingsSha256Before: settingsBefore,
    contextSha256: digest(await readFile(path.join(project, 'src/main/companion-bot/context.ts'))), toolsSha256: digest(await readFile(path.join(project, 'src/main/companion-bot/tools.ts'))),
    capturedBeforeBuild: true }, null, 2) + '\n');
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: fixture, target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_BOT_REAL_ROOT: root, WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source,
    WORLDLINEBOX_BOT_PEER_WORK_OUTPUT: output, WORLDLINEBOX_BOT_PEER_WORK_REAL: '1', WORLDLINEBOX_BOT_PEER_WORK_SCENARIO: scenario,
    WORLDLINEBOX_BOT_PEER_WORK_MAX_POSTS: String(maximumPosts), ...(priorResult ? { WORLDLINEBOX_BOT_PEER_WORK_PRIOR_RESULT: path.resolve(priorResult) } : {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { for (const name of chunk.toString().match(/\b[A-Za-z]+Error\b/g) ?? []) errorNames.add(name); });
  child.on('message', value => {
    if (value?.kind === 'bot-peer-work-real-progress') process.stdout.write(JSON.stringify(value) + '\n');
    if (value?.kind === 'bot-peer-work-real-result') result = value;
  });
  timer = setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    terminating = process.platform === 'win32' ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined) : Promise.resolve(child.kill('SIGKILL'));
  }, 360000); timer.unref();
  result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ ...(result ?? {}), processExitCode: code })); });
  if (!result?.kind) result = { ...JSON.parse(await readFile(path.join(output, 'result.partial.json'), 'utf8').catch(() => '{}')), passed: false, errorNames: [...errorNames], processExitCode: result?.processExitCode };
} catch (error) { result = { kind: 'bot-peer-work-real-result', passed: false, failedStage: 'runner', errorNames: [error instanceof Error ? error.name : 'Error'] }; }
finally {
  if (timer) clearTimeout(timer); await terminating;
  result ??= { kind: 'bot-peer-work-real-result', passed: false, failedStage: 'runner-interrupted' };
  const settingsAfter = await readFile(path.join(source, 'ai-profiles.json')).then(digest).catch(() => undefined);
  result.productionSettingsUnchanged = !!settingsBefore && settingsBefore === settingsAfter;
  const retained = []; let removedRoots = 0;
  try { await removeAcceptanceRoot(root, process.pid); removedRoots++; } catch (error) { retained.push({ name: path.basename(root), reason: error instanceof Error ? error.message : 'Ownership cleanup rejected.' }); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push({ name: 'peer-work-main.cjs', reason: error.code ?? 'BUNDLE_CLEANUP_FAILED' }); }
  result.cleanup = { removedRoots, retained }; if (!result.productionSettingsUnchanged || retained.length) result.passed = false;
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ output, passed: result.passed, model: result.model, modelRequests: result.modelRequests, usesRealDsh: result.usesRealDsh,
  scenarios: result.scenarios?.map(value => ({ name: value.name, passed: value.passed, calls: value.calls, text: value.result?.text })),
  errors: result.errors, errorNames: result.errorNames, cleanup: result.cleanup, productionSettingsUnchanged: result.productionSettingsUnchanged }) + '\n');
process.exitCode = result.passed ? 0 : 1;
