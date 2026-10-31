import { build } from 'vite';
import { readFile, mkdir, mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url), electron = require('electron');
async function removeBenchmarkRoot(root) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-actual-ipc-memory-')) throw new Error('Unsafe benchmark cleanup path.');
  await rm(root, { recursive: true, force: true });
}
const sourceLibrary = process.argv[2];
if (!sourceLibrary) throw new Error('Pass the source library root; it is opened read-only and backed up before testing.');
const artifacts = path.resolve('artifacts/memory-latency-20261030/epoch-ipc-benchmark');
await mkdir(artifacts, { recursive: true });
const names = ['source-execution-evidence', 'artifact-registry', 'memory-live-files'];
const frozenSources = new Map(), implementationHashes = {};
for (const name of names) {
  const original = path.resolve('src/main/companions', name + '.ts').replaceAll('\\', '/');
  const baseline = await readFile(path.join(artifacts, name + '.baseline.ts'), 'utf8');
  frozenSources.set(original, baseline);
  implementationHashes[name + '.ts'] = { baseline: createHash('sha256').update(baseline).digest('hex'),
    current: createHash('sha256').update(await readFile(original)).digest('hex') };
}
const baselineSha256 = implementationHashes['source-execution-evidence.ts'].baseline;
const currentSha256 = implementationHashes['source-execution-evidence.ts'].current;
await build({ configFile: false, logLevel: 'warn', build: { ssr: 'src/companions/worker.ts', target: 'node24',
  outDir: path.join(artifacts, 'worker'), emptyOutDir: true, minify: false,
  rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'companion_worker.js' } } } });
const reports = [];
const frozenCorpus = await mkdtemp(path.join(tmpdir(), 'wlb-actual-ipc-memory-'));
execFileSync('python', [path.resolve('tests/fixtures/clone-memory-library.py'), sourceLibrary, frozenCorpus], { stdio: 'pipe' });
const corpusSha256 = createHash('sha256').update(await readFile(path.join(frozenCorpus, 'messages.sqlite'))).digest('hex');
try {
for (const algorithm of ['baseline', 'current']) {
  const output = path.join(artifacts, algorithm);
  const overriddenModules = new Set();
  await build({ configFile: false, logLevel: 'warn', plugins: algorithm === 'baseline' ? [{ name: 'frozen-proof-baseline', enforce: 'pre',
    load(id) { const key = id.replaceAll('\\', '/'); if (frozenSources.has(key)) { overriddenModules.add(key); return frozenSources.get(key); } } }] : [],
    build: { ssr: 'tests/fixtures/companion-memory-ipc-performance-main.ts', target: 'node24', outDir: output, emptyOutDir: true, minify: false,
      rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'libarchive-wasm', '7zip-bin', 'sharp'],
        output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  if (algorithm === 'baseline' && overriddenModules.size !== names.length) throw new Error('The baseline did not compile every frozen module.');
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-actual-ipc-memory-'));
  try {
  await cp(frozenCorpus, root, { recursive: true });
  const env = { ...process.env, WORLDLINEBOX_IPC_BENCH_ROOT: root, WORLDLINEBOX_IPC_BENCH_WORKER: path.join(artifacts, 'worker/companion_worker.js'),
    WORLDLINEBOX_IPC_BENCH_ALGORITHM: algorithm }; delete env.ELECTRON_RUN_AS_NODE;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(output, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', () => undefined);
    child.once('error', reject); child.once('exit', resolve);
  });
  const report = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
  Object.assign(report, { baselineSha256, currentSha256, corpusSha256, implementationHashes,
    frozenModuleCount: algorithm === 'baseline' ? overriddenModules.size : 0 });
  report.exitCode = exitCode;
  reports.push(report); await cp(path.join(root, 'result.json'), path.join(artifacts, algorithm + '-result.json'));
  // The temporary backup has private content. Delete only this mkdtemp-owned
  // directory; do not follow arbitrary source paths or shell-built deletes.
  } finally {
  await removeBenchmarkRoot(root);
  }
}
await writeFile(path.join(artifacts, 'comparison.json'), JSON.stringify({ reports, limitations: [
  'Actual utilityProcess IPC, canonical files, profile hydration, source DAG and 500 ms physical world ticks. No model, UI polling, autonomous jobs or background publishers.',
  'Three modules are frozen for the baseline: source-execution-evidence.ts, artifact-registry.ts and memory-live-files.ts. Both runs share the current worker/schema and all other host code.'
] }, null, 2) + '\n');
} finally {
  await removeBenchmarkRoot(frozenCorpus);
}
