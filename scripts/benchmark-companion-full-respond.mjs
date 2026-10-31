import { build } from 'vite';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const sourceLibrary = process.argv[2];
if (!sourceLibrary) throw new Error('Pass the original library root; only a read-only snapshot is used.');
const project = process.cwd(), artifacts = path.resolve('artifacts/memory-latency-20261030/full-respond-benchmark');
const require = createRequire(import.meta.url), electron = require('electron');
const requestedMessage = process.env.WORLDLINEBOX_RESPOND_MESSAGE;
if (requestedMessage !== undefined && (!requestedMessage.trim() || requestedMessage.length > 4000 || requestedMessage.includes('\0')))
  throw new Error('WORLDLINEBOX_RESPOND_MESSAGE must contain nonblank text of at most 4000 UTF-16 code units without NUL characters.');
const requestedMessageMetadata = requestedMessage === undefined ? undefined : {
  sha256: createHash('sha256').update(requestedMessage).digest('hex'), length: requestedMessage.length,
  byteLength: Buffer.byteLength(requestedMessage), overridden: true,
};
// A normal checkout can measure its current source. A before/after comparison
// explicitly selects baseline,current and supplies its captured frozen source.
const algorithms = (process.env.WORLDLINEBOX_RESPOND_ALGORITHMS ?? 'current').split(',');
if (!algorithms.length || algorithms.some(algorithm => !['baseline', 'current'].includes(algorithm))) throw new Error('Select current or baseline benchmark algorithms.');
await mkdir(artifacts, { recursive: true });
async function clean(root) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-full-respond-')) throw new Error('Unsafe benchmark cleanup.');
  await rm(root, { recursive: true, force: true });
}
const frozen = new Map();
async function walk(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const current = path.join(directory, entry.name), key = path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(current, key);
    else frozen.set(path.resolve(project, 'src', key).replaceAll('\\', '/'), await readFile(current, 'utf8'));
  }
}
if (algorithms.includes('baseline')) {
  try { await walk(path.join(artifacts, 'frozen', 'src')); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error('The requested frozen baseline source snapshot is unavailable. Set WORLDLINEBOX_RESPOND_ALGORITHMS=current to benchmark this checkout, or restore the explicitly captured baseline snapshot.', { cause: error });
  }
  if (!frozen.size) throw new Error('The requested frozen baseline source snapshot is empty.');
}
const corpus = await mkdtemp(path.join(tmpdir(), 'wlb-full-respond-'));
try {
  const clone = execFileSync('python', [path.resolve('tests/fixtures/clone-full-respond-library.py'), sourceLibrary, corpus], { encoding: 'utf8' });
  const corpusSha256 = createHash('sha256').update(await readFile(path.join(corpus, 'messages.sqlite'))).digest('hex');
  const authorityCounters = (...directories) => JSON.parse(execFileSync('python', [path.resolve('tests/fixtures/inspect-full-respond-authority.py'), ...directories], { encoding: 'utf8' }));
  const authorityBefore = authorityCounters(corpus);
  const reports = [];
  for (const algorithm of algorithms) {
    const scenario = process.env.WORLDLINEBOX_RESPOND_SCENARIO ?? 'single';
    const label = process.env.WORLDLINEBOX_RESPOND_LABEL
      ? process.env.WORLDLINEBOX_RESPOND_LABEL + (algorithms.length > 1 ? '-' + algorithm : '') : scenario === 'single' ? algorithm : scenario + '-' + algorithm;
    if (!/^[a-z0-9_-]+$/u.test(label)) throw new Error('Invalid benchmark report label.');
    const output = path.join(artifacts, label), plugin = { name: 'full-service-frozen-baseline', enforce: 'pre', load(id) { return frozen.get(id.replaceAll('\\', '/')); } };
    for (const [entry, name] of [['src/companions/worker.ts', 'companion_worker.cjs'], ['tests/fixtures/companion-full-respond-performance-main.ts', 'main.cjs']])
      await build({ configFile: false, logLevel: 'warn', plugins: algorithm === 'baseline' ? [plugin] : [], build: { ssr: entry, target: 'node24', outDir: output, emptyOutDir: false, minify: false,
        rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'libarchive-wasm', '7zip-bin', 'sharp'], output: { format: 'cjs', entryFileNames: name } } } });
    const root = await mkdtemp(path.join(tmpdir(), 'wlb-full-respond-'));
    let preservePrivateClone = process.env.WORLDLINEBOX_RESPOND_PRESERVE_PRIVATE === '1';
    try {
      await cp(corpus, root, { recursive: true });
      const env = { ...process.env, WORLDLINEBOX_RESPOND_BENCH_ROOT: root, WORLDLINEBOX_RESPOND_BENCH_WORKER: path.join(output, 'companion_worker.cjs'), WORLDLINEBOX_RESPOND_BENCH_PROJECT: project, WORLDLINEBOX_RESPOND_BENCH_ALGORITHM: algorithm }; delete env.ELECTRON_RUN_AS_NODE;
      const processDiagnostics = { stdoutBytes: 0, stderrBytes: 0, errorClasses: [], errorCodes: [], frames: [] };
      let progressBuffer = '';
      const observeOutput = (stream, value) => {
        processDiagnostics[stream + 'Bytes'] += value.length;
        if (stream === 'stdout') {
          progressBuffer = (progressBuffer + value.toString()).slice(-16384);
          const lines = progressBuffer.split('\n'); progressBuffer = lines.pop();
          for (const line of lines) try {
            const value = JSON.parse(line);
            if (value.kind === 'worldlinebox-peer-tool-diagnostic') {
              const safe = Object.fromEntries(['step', 'tool', 'action', 'argumentKeys', 'queryLength', 'queryHash', 'argumentHash', 'ok', 'errorCode', 'publicError', 'resultKeys', 'returnedNoteCount', 'durationMs'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
              process.stdout.write(JSON.stringify({ algorithm, scenario, stage: 'actual_tool_receipt', ...safe }) + '\n');
              continue;
            }
            if (value.kind !== 'worldlinebox-benchmark-progress'
              || !['targets_enqueued', 'provider_dispatch', 'targets_completed', 'waiting', 'related_chains_draining', 'related_chains_drained'].includes(value.stage)
              || !['foreground', 'warm_foreground'].includes(value.phase)) continue;
            const numeric = key => typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined;
            const counts = input => Object.fromEntries(Object.entries(input ?? {}).filter(([key, value]) =>
              ['queued', 'running', 'done', 'pending', 'failed', 'cancelled', 'interrupted', 'parked', 'abandoned', 'stale'].includes(key)
              && typeof value === 'number' && Number.isFinite(value)));
            process.stdout.write(JSON.stringify({ algorithm, scenario, stage: value.stage, phase: value.phase,
              elapsedMs: numeric('elapsedMs'), dispatched: numeric('dispatched'), expected: numeric('expected'),
              providerResponses: numeric('providerResponses'), firstContent: numeric('firstContent'),
              taskCounts: { reply: counts(value.taskCounts?.reply), peer: counts(value.taskCounts?.peer), chain: counts(value.taskCounts?.chain) } }) + '\n');
          } catch { /* Arbitrary child output is never forwarded. */ }
        }
        // Never persist arbitrary Electron output: it can contain credentials
        // or corpus text. Bounded error classes/function names still expose a
        // missing-report startup/cleanup failure without recording its values.
        for (const line of value.toString().split(/\r?\n/u)) {
          for (const name of line.match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:Error|Exception)\b/gu) ?? [])
            if (processDiagnostics.errorClasses.length < 16 && !processDiagnostics.errorClasses.includes(name)) processDiagnostics.errorClasses.push(name);
          for (const code of line.match(/\b(?:CHANGED|ENOENT|EACCES|EPERM|ERR_DLOPEN_FAILED|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/gu) ?? [])
            if (!processDiagnostics.errorCodes.includes(code)) processDiagnostics.errorCodes.push(code);
          const frame = line.match(/^\s*at (?:async )?([A-Za-z_$][A-Za-z0-9_.$<>]*)/u)?.[1];
          if (frame && processDiagnostics.frames.length < 32 && !processDiagnostics.frames.includes(frame)) processDiagnostics.frames.push(frame);
        }
      };
      const processResult = await new Promise(resolve => {
        const child = spawn(electron, [path.join(output, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', value => observeOutput('stdout', value)); child.stderr.on('data', value => observeOutput('stderr', value));
        child.once('error', error => resolve({ exitCode: null, spawnError: error.name }));
        child.once('exit', (exitCode, signal) => resolve({ exitCode, ...(signal ? { signal } : {}) }));
      });
      let report;
      try { report = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8')); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        report = { schema: 'worldlinebox.full-respond-real-library-benchmark-v1', algorithm, scenario,
          failure: 'The isolated Electron process exited before writing its benchmark result.', processDiagnostics };
      }
      const { exitCode } = processResult;
      const compiledEntrySha256 = Object.fromEntries(await Promise.all(['main.cjs', 'companion_worker.cjs'].map(async filename =>
        [filename, createHash('sha256').update(await readFile(path.join(output, filename))).digest('hex')])));
      Object.assign(report, { ...processResult, corpusSha256, corpus: JSON.parse(clone), baselineSourceFiles: frozen.size, compiledEntrySha256,
        authorityBefore, authorityAfter: authorityCounters(root, corpus) });
      if (requestedMessageMetadata) report.requestedMessage = requestedMessageMetadata;
      preservePrivateClone ||= exitCode !== 0 || !!report.failure || !!report.timedOut;
      if (preservePrivateClone) report.privateClone = { path: root,
        databaseSha256: createHash('sha256').update(await readFile(path.join(root, 'messages.sqlite'))).digest('hex'),
        containsPrivateSource: true, retainedOutsideGit: true };
      if (exitCode !== 0 || report.failure || report.timedOut) process.exitCode = 1;
      await writeFile(path.join(artifacts, label + '-result.json'), JSON.stringify(report, null, 2));
      reports.push(report);
      process.stdout.write(JSON.stringify({ algorithm, scenario, exitCode, messageAccepted: report.messageAccepted, toFirstDispatchMs: report.toFirstDispatchMs, warmToFirstDispatchMs: report.warmToFirstDispatchMs, observedDispatches: report.observedDispatches, failure: report.failure, timedOut: report.timedOut }) + '\n');
    } finally { if (!preservePrivateClone) await clean(root); }
  }
  const comparisonLabel = process.env.WORLDLINEBOX_RESPOND_LABEL ?? ((process.env.WORLDLINEBOX_RESPOND_SCENARIO ?? 'single') === 'single' ? '' : process.env.WORLDLINEBOX_RESPOND_SCENARIO);
  await writeFile(path.join(artifacts, comparisonLabel ? comparisonLabel + '-comparison.json' : 'comparison.json'), JSON.stringify({ reports, limitations: ['Unrelated old queue recovery and semantic jobs are paused; foreground message enqueue, chat agenda claims, actual respond/history/native embedding and model transport admission are real.',
    process.env.WORLDLINEBOX_RESPOND_ONLINE === '1' ? 'This separately authorized functional run uses the already configured model provider. Credentials are decrypted only in memory; the source library remains unchanged.' : 'Every selected algorithm uses the same SQLite online snapshot and copied registered artifacts/native caches; no source-library mutation or external model network occurs.',
    'Native cache SQLite files are individually online-backed-up; concurrent source native file publication can require rebuilding a derived clone index.',
    'The real production learning-assets adapter runs its snapshot/validate ports. The copied corpus must have no external grants; an unexpected grant or external asset Worker request fails the run instead of substituting asset data.'
  ] }, null, 2));
} finally { await clean(corpus); }
