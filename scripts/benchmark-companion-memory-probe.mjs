import { build } from 'vite';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const sourceLibrary = process.argv[2];
if (!sourceLibrary) throw new Error('Pass the original library root; only read-only copies will be used.');
const project = process.cwd(), require = createRequire(import.meta.url), electron = require('electron');
const artifacts = path.resolve('artifacts/memory-latency-20261030/memory-probe-benchmark');
const label = process.env.WORLDLINEBOX_PROBE_LABEL ?? 'final-default-chain';
if (!/^[a-z0-9_-]+$/u.test(label)) throw new Error('Invalid report label.');
const output = path.join(artifacts, label);
await mkdir(output, { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex');
async function clean(root) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('wlb-memory-probe-')) throw new Error('Unsafe probe cleanup target.');
  await rm(target, { recursive: true, force: true });
}
async function fileManifest(root, relative = '', entries = []) {
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const current = path.join(relative, item.name);
    if (item.isDirectory()) { if (item.name !== '索引') await fileManifest(root, current, entries); }
    else if (item.isFile()) entries.push([current.replaceAll('\\', '/'), digest(await readFile(path.join(root, current)))]);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}
const corpus = await mkdtemp(path.join(tmpdir(), 'wlb-memory-probe-'));
try {
  const clone = JSON.parse(execFileSync('python', [path.resolve('tests/fixtures/clone-full-respond-library.py'), sourceLibrary, corpus], { encoding: 'utf8' }));
  const corpusSha256 = digest(await readFile(path.join(corpus, 'messages.sqlite'))), files = await fileManifest(path.join(corpus, 'owners'));
  const canonicalFileSnapshotSha256 = digest(JSON.stringify(files));
  const rustAddonSha256 = digest(await readFile(path.join(project, 'vendor/vcp-memory/rust-vexus-lite/vexus-lite.win32-x64-msvc.node')));
  for (const [entry, filename] of [['src/companions/worker.ts', 'companion_worker.cjs'], ['tests/fixtures/companion-memory-probe-performance-main.ts', 'main.cjs']]) {
    await build({ configFile: false, logLevel: 'warn', build: { ssr: entry, target: 'node24', outDir: output, emptyOutDir: false, minify: false,
      rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'libarchive-wasm', '7zip-bin', 'sharp'], output: { format: 'cjs', entryFileNames: filename } } } });
  }
  const compiledEntrySha256 = Object.fromEntries(await Promise.all(['main.cjs', 'companion_worker.cjs'].map(async filename => [filename, digest(await readFile(path.join(output, filename)))])));
  const reports = [];
  for (const mode of (process.env.WORLDLINEBOX_PROBE_MODES ?? 'active,passive').split(',')) {
    if (!['active', 'passive'].includes(mode)) throw new Error('Invalid default recall mode.');
    const root = await mkdtemp(path.join(tmpdir(), 'wlb-memory-probe-'));
    try {
      await cp(corpus, root, { recursive: true });
      for (const lifecycle of ['initial_clone', 'same_root_restart']) {
      await rm(path.join(root, 'probe-result.json'), { force: true });
      const env = { ...process.env, WORLDLINEBOX_PROBE_BENCH_ROOT: root, WORLDLINEBOX_PROBE_BENCH_WORKER: path.join(output, 'companion_worker.cjs'),
        WORLDLINEBOX_PROBE_BENCH_PROJECT: project, WORLDLINEBOX_PROBE_BENCH_MODE: mode };
      delete env.ELECTRON_RUN_AS_NODE;
      let diagnostic = '';
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(electron, [path.join(output, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', () => undefined); child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4096); });
        const timeout = setTimeout(() => {
          if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          else child.kill();
        }, 240000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); resolve(code); });
      });
      const report = await readFile(path.join(root, 'probe-result.json'), 'utf8').then(JSON.parse, () => ({ status: 'process_failed', mode, queries: [],
        failure: { name: 'ElectronProcessFailed', exitCode, diagnosticSha256: digest(diagnostic) }, cleanupCompleted: false }));
      Object.assign(report, { lifecycle, sameRootRestart: lifecycle === 'same_root_restart', exitCode, corpusSha256, canonicalFileSnapshotSha256, canonicalFilesHashed: files.length,
        rustAddonSha256, compiledEntrySha256, corpus: clone });
      await writeFile(path.join(artifacts, label + '-' + mode + (lifecycle === 'same_root_restart' ? '-restart' : '') + '.json'), JSON.stringify(report, null, 2) + '\n');
      reports.push(report);
      process.stdout.write(JSON.stringify({ mode, lifecycle, status: report.status, exitCode, initializationMs: report.initializationMs,
        idlePrimingMs: report.idlePrimingMs, idlePrimeCompleted: report.idlePrimeCompleted,
        queries: report.queries.map(value => ({ temperature: value.temperature, durationMs: value.durationMs, hits: value.hits,
          referenceCount: value.referenceCount, degraded: value.degraded, pending: value.pending, stages: value.timing?.stages })),
        modelNetworkCalls: report.modelNetworkCalls, generationAdmissions: report.generationAdmissions, cleanupCompleted: report.cleanupCompleted, failure: report.failure }) + '\n');
      }
    } finally { await clean(root); }
  }
  await writeFile(path.join(artifacts, label + '-comparison.json'), JSON.stringify({ reports, limitations: [
    'The button passes a standalone topic, owner and limit 8; it does not pass recent chat history or explicit focus options.',
    'Each mode begins from the same online backup and copied canonical/native caches; it then restarts Electron in the exact same root without recopying or deleting persistent indexes. Each first query follows real idle preparation, whose physical cost is separately reported.',
    'A relocated copied native graph may reconcile existing records; actual reused/upserted counts are recorded separately from native query time.',
    'The original library is only opened read-only for backup/copy; all actual indexing and world ticks operate in disposable copies.',
    'The copied original verified encoder preference is applied without a synthetic device benchmark; successful explicit GPU selection cannot silently fall back to CPU.',
    'Unrelated queued semantic tasks are paused. The real parent memory-page changed refresh and result-authority debounce remain enabled.',
    'The production learning-assets adapter runs its real Main/SQLite snapshot and validation route. Copied grant/read tables are empty; an unexpected external asset-worker request fails explicitly.'
  ] }, null, 2) + '\n');
} finally { await clean(corpus); }
