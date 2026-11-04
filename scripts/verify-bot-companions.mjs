import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw new Error('Pass --real explicitly. This fourteen-companion acceptance uses the configured paid model.');
const project = process.cwd(), require = createRequire(import.meta.url);
const appRouter = process.argv.includes('--app-router');
const conversationOnly = process.argv.includes('--conversation-only');
const companionOptions = process.argv.filter(value => value.startsWith('--companions='));
if (process.argv.includes('--companions') || companionOptions.length > 1) throw new Error('Use one --companions=id,id option.');
const companionIds = companionOptions[0]?.slice('--companions='.length).split(',').map(value => value.trim());
if ((conversationOnly || companionIds) && !appRouter) throw new Error('--conversation-only and --companions require --app-router.');
if (companionIds && !conversationOnly) throw new Error('--companions requires --conversation-only so subset results cannot replace full-chain acceptance.');
if (companionIds && (!companionIds.length || companionIds.some(value => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) || new Set(companionIds).size !== companionIds.length))
  throw new Error('--companions must contain distinct, nonempty builtin companion IDs.');
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
// The historical mode intentionally keeps its eager native startup for audit.
// App mode must not require even a runtime catalog before an actual worker.
let runtime, program;
if (!appRouter) {
  const catalog = JSON.parse(await readFile(path.join(source, 'dsh/runtimes.json'), 'utf8'));
  runtime = catalog.filter(value => value.adapter === 'node-cli-web-v1').sort((a,b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!runtime) throw new Error('Official installed DSH Node runtime required.');
  program = path.join(source, 'dsh/runtimes', runtime.id, 'program');
}
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-'));
const ownedRoots = new Set([root]), profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const output = path.resolve('artifacts/superagent-bot-development', conversationOnly ? 'companions-app-conversation-acceptance'
  : appRouter ? 'companions-app-real-acceptance' : 'companions-real-acceptance'); await mkdir(output, { recursive: true });
const bundle = path.join(output, 'main-' + path.basename(root) + '.cjs');
let result, child, timer, terminating = Promise.resolve(); const errorNames = new Set();
try {
{
  const localState = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (localState.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }));
}
await build({ configFile: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-companions-real-acceptance.ts', target: 'node24', outDir: output, emptyOutDir: false,
  rollupOptions: { external: ['electron','better-sqlite3','koffi','sharp','libarchive-wasm','7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
const env = { ...process.env, WORLDLINEBOX_BOT_REAL_ROOT: root, WORLDLINEBOX_BOT_REAL_PROJECT: project,
  WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source, WORLDLINEBOX_BOT_APP_ROUTER: appRouter ? '1' : '0',
  WORLDLINEBOX_BOT_CONVERSATION_ONLY: conversationOnly ? '1' : '0',
  WORLDLINEBOX_BOT_COMPANIONS_REAL: '1', WORLDLINEBOX_BOT_BATCH_OUTPUT: output };
delete env.WORLDLINEBOX_BOT_DSH_PROGRAM; delete env.WORLDLINEBOX_BOT_RUNTIME_ID; delete env.ELECTRON_RUN_AS_NODE;
delete env.WORLDLINEBOX_BOT_COMPANION_IDS;
delete env.WORLDLINEBOX_BOT_CASE_LABELS;
if (companionIds) env.WORLDLINEBOX_BOT_COMPANION_IDS = companionIds.join(',');
if (conversationOnly) env.WORLDLINEBOX_BOT_CASE_LABELS = 'conversation,conversation-warm';
if (runtime) { env.WORLDLINEBOX_BOT_DSH_PROGRAM = program; env.WORLDLINEBOX_BOT_RUNTIME_ID = runtime.id; }
child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'] });
child.stderr.on('data', chunk => { for (const value of chunk.toString().match(/\b[A-Za-z]+Error\b/g) ?? []) errorNames.add(value); });
child.on('message', value => { if (value?.kind === 'bot-companions-progress') process.stdout.write(JSON.stringify(value) + '\n');
  if (value?.kind === 'bot-real-owned-root' && typeof value.root === 'string') ownedRoots.add(value.root);
  if (value?.kind === 'bot-companions-result') result = value; });
timer = setTimeout(() => {
  if (child.exitCode !== null || !child.pid) return;
  terminating = process.platform === 'win32'
    ? promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
    : Promise.resolve(child.kill('SIGKILL'));
}, 2700000); timer.unref();
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
if (conversationOnly) Object.assign(result, { acceptanceMode: 'conversation-only', fullChainAcceptance: false,
  expectedCompanions: result.expectedCompanions ?? companionIds?.length ?? 14,
  selectedCompanionIds: result.selectedCompanionIds ?? companionIds, caseLabels: ['conversation', 'conversation-warm'] });
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const summary = { date: new Date().toISOString(), passed: result.passed, completed: result.completedCompanions ?? result.results?.filter(item => item.complete).length ?? 0,
  total: result.expectedCompanions ?? companionIds?.length ?? 14, brainRuntime: appRouter ? 'worldlinebox' : 'dsh', humanReviewRequired: true, model: result.model,
  ...(conversationOnly ? { acceptanceMode: 'conversation-only', fullChainAcceptance: false,
    selectedCompanionIds: result.selectedCompanionIds ?? companionIds, caseLabels: ['conversation', 'conversation-warm'], brainRuns: result.brainRuns } : {}),
  host: result.host, toolEventCounts: result.toolEventCounts, startup: result.phases?.filter(phase => !phase.companionId),
  partners: result.results?.map(item => ({ id: item.id, name: item.name, passed: item.passed, complete: item.complete,
    conversationMs: item.cases?.conversation?.turn?.durationMs, historyStickerMs: item.cases?.['history-and-sticker']?.turn?.durationMs,
    conversationTiming: item.cases?.conversation?.turn?.timing, historyStickerTiming: item.cases?.['history-and-sticker']?.turn?.timing,
    ...(conversationOnly ? { conversationWarmMs: item.cases?.['conversation-warm']?.turn?.durationMs,
      conversationWarmTiming: item.cases?.['conversation-warm']?.turn?.timing } : {}),
    ordinaryAndMemoryNativeIsolation: item.ordinaryAndMemoryNativeIsolation,
    taskMs: item.cases?.['task-and-file']?.taskDurationMs, additionalDeliveryRequests: item.additionalDeliveryRequests,
    errors: Object.entries(item.cases ?? {}).filter(([,value]) => !value.passed).map(([phase,value]) => ({ phase, reason: value.error ?? 'Actual tool or byte assertion failed; see result.json.' })) })),
  cost: result.costs, cleanup: result.cleanup };
await writeFile(path.join(output, 'quality-summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.passed ? 0 : 1;
