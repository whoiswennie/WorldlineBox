import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

if (!process.argv.includes('--real')) throw Error('Pass --real to use the actual configured model, with a hard total budget of six POST requests.');
const project = process.cwd(), require = createRequire(import.meta.url), source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA, 'WorldlineBox');
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-peer-continuity-'));
const output = path.resolve('artifacts/superagent-bot-development/peer-continuity-real', path.basename(root)); await mkdir(output, { recursive: true });
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'acceptance-runner', ownerPid: process.pid }));
const hash = value => createHash('sha256').update(value).digest('hex'), bundle = path.join(output, 'acceptance.cjs');
let result, child, timer, before, terminating = Promise.resolve();
try {
  before = hash(await readFile(path.join(source, 'ai-profiles.json')));
  const profile = path.join(root, 'electron-profile'); await mkdir(profile);
  const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8'));
  if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
  const fixture = 'tests/fixtures/bot-peer-continuity-real.ts';
  await copyFile(fixture, path.join(output, 'fixture.executed.ts')); await copyFile('scripts/verify-bot-peer-continuity.mjs', path.join(output, 'runner.executed.mjs'));
  await writeFile(path.join(output, 'provenance.json'), JSON.stringify({ fixture: hash(await readFile(fixture)), context: hash(await readFile('src/main/companion-bot/context.ts')), service: hash(await readFile('src/main/companion-bot/service.ts')),
    continuity: hash(await readFile('src/main/companion-bot/conversation-continuity.ts')), scopes: hash(await readFile('src/main/companion-bot/agent-memory-scope.ts')),
    store: hash(await readFile('src/main/companion-bot/store.ts')), settingsBefore: before }, null, 2));
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: fixture, target: 'node24', outDir: output, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'sharp', 'libarchive-wasm', '7zip-bin'], output: { format: 'cjs', entryFileNames: path.basename(bundle) } } } });
  const env = { ...process.env, WORLDLINEBOX_PEER_CONTINUITY_REAL: '1', WORLDLINEBOX_PEER_CONTINUITY_ROOT: root, WORLDLINEBOX_PEER_CONTINUITY_OUTPUT: output, WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [bundle], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', value => { if (value?.kind === 'peer-continuity-result') result = value; });
  timer = setTimeout(() => {
    if (!child.pid || child.exitCode !== null) return;
    terminating = promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
  }, 330000); timer.unref();
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  result ??= { passed: false, stage: 'process-exited', exitCode };
} catch (error) { result = { passed: false, stage: 'runner', errorName: error instanceof Error ? error.name : 'Error' }; }
finally {
  clearTimeout(timer); await terminating; result ??= { passed: false, stage: 'interrupted' };
  result.productionSettingsUnchanged = !!before && before === await readFile(path.join(source, 'ai-profiles.json')).then(hash).catch(() => undefined);
  const retained = [];
  try { await removeAcceptanceRoot(root, process.pid); } catch { retained.push(path.basename(root)); }
  try { await unlink(bundle); } catch (error) { if (error.code !== 'ENOENT') retained.push(path.basename(bundle)); }
  result.cleanup = { removed: retained.length === 0, retained };
  if (!result.productionSettingsUnchanged || retained.length) result.passed = false;
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: result.passed, model: result.model, providerRequests: result.providerRequests, cases: result.cases,
  error: result.error, errorName: result.errorName, productionSettingsUnchanged: result.productionSettingsUnchanged, cleanup: result.cleanup }));
process.exitCode = result.passed ? 0 : 1;
