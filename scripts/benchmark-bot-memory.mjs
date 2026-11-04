import { build } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { resolveBotMemoryNode, verifyBotMemory } from './bot-memory-runtime-lib.mjs';
import { removeMemoryScaleRoot } from './bot-memory-scale-cleanup.mjs';

const project = process.cwd(), argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const levels = (argument('--history') || '1000').split(',').map(Number), notes = Number(argument('--notes') || 0), queries = Number(argument('--queries') || 20);
if (levels.some(value => !Number.isSafeInteger(value) || value < 1 || value > 100000) || ![0,720].includes(notes) || !Number.isSafeInteger(queries) || queries < 5 || queries > 100) throw new Error('Use --history=1000,10000,100000 --notes=0|720 --queries=5..100');
const nodePath = await resolveBotMemoryNode(project, argument('--node'));
const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
await verifyBotMemory({ packageRoot, projectRoot: project, nodePath });
const require = createRequire(path.join(packageRoot, 'package.json'));
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-scale-'));
await writeFile(path.join(root, '.worldlinebox-memory-scale.json'), JSON.stringify({ kind: 'memory-scale-fixture', ownerPid: process.pid }));
const output = path.resolve('artifacts/superagent-bot-development/memory-scale-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const children = new Set(); let child, result, timeout;
try {
  await build({ configFile: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-memory-scale.ts', outDir: path.join(root, 'bundle'), target: 'node24',
    rollupOptions: { external: ['better-sqlite3', 'koffi', 'yauzl'], output: { format: 'cjs', entryFileNames: 'main.cjs', paths: {
      'better-sqlite3': require.resolve('better-sqlite3').replaceAll('\\','/'), koffi: require.resolve('koffi').replaceAll('\\','/'),
      yauzl: createRequire(path.join(project, 'package.json')).resolve('yauzl').replaceAll('\\','/'),
    } } } } });
  // No active model profile, API key, NODE_OPTIONS or credential environment is
  // inherited. The fixture only offers a local rejecting chat endpoint.
  const env = Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PATH','PATHEXT','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  Object.assign(env, { WORLDLINEBOX_MEMORY_SCALE_ROOT: root, WORLDLINEBOX_MEMORY_SCALE_PROJECT: project, WORLDLINEBOX_MEMORY_SCALE_LEVELS: JSON.stringify(levels),
    WORLDLINEBOX_MEMORY_SCALE_NOTES: String(notes), WORLDLINEBOX_MEMORY_SCALE_QUERIES: String(queries), WORLDLINEBOX_BOT_NODE: nodePath,
    WORLDLINEBOX_MEMORY_SCALE_PACKAGE: packageRoot });
  child = spawn(nodePath, [path.join(root, 'bundle/main.cjs')], { cwd: project, env, windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'] }); children.add(child.pid);
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); }); child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
  child.on('message', value => {
    if (value?.kind === 'memory-scale-child' && Number.isSafeInteger(value.pid)) children.add(value.pid);
    if (value?.kind === 'memory-scale-progress') process.stdout.write(JSON.stringify(value) + '\n');
    if (value?.kind === 'memory-scale-result') result = value;
  });
  timeout = setTimeout(() => { if (child.exitCode === null && child.pid) void promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined); }, 1800000); timeout.unref();
  const code = await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',resolve); });
  result ??= { passed: false, failure: 'Fixture process exited without a result', exitCode: code };
  await writeFile(path.join(output, 'diagnostics.log'), diagnostics);
} catch (error) { result ??= { passed: false, failure: error instanceof Error ? error.stack : String(error) }; }
finally {
  clearTimeout(timeout);
  try { result ??= { passed: false }; result.cleanup = await removeMemoryScaleRoot(root, process.pid, [...children]); }
  catch (error) { result ??= { passed: false }; result.cleanup = { retained: root, reason: error instanceof Error ? error.message : String(error) }; result.passed = false; }
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ report: path.join(output,'result.json'), ...result })); process.exitCode = result.passed ? 0 : 1;
