import { fork, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { NativeMemoryResourceConfig } from '../fixtures/native-memory-resource-run';
import { freezeMemorySoakImplementation } from '../fixtures/frozen-memory-soak';

const enabled = process.env.WORLDLINEBOX_NATIVE_MEMORY_RESOURCES === '1';
const execute = promisify(execFile);
const waitExit = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
  : new Promise<void>(resolve => child.once('exit', () => resolve()));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const percentile = (values: number[], p: number) => { const ordered = values.toSorted((a, b) => a - b); return ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)]; };
async function inventory(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(root, entry.name);
    try { if (entry.isDirectory()) { const nested = await inventory(file); bytes += nested.bytes; files += nested.files; }
      else if (entry.isFile()) { bytes += (await lstat(file)).size; files++; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { bytes, files };
}
async function sourceManifest() {
  const roots = ['src/main/vcp-memory', 'src/main/companions', 'src/companions', 'src/shared', 'tests/fixtures/prepared-recall-host.ts',
    'tests/fixtures/native-memory-resource-run.ts', 'tests/worker/companion-native-memory-resources.test.ts', 'vendor/vcp-memory'];
  const files: Array<{ path: string; hash: string }> = [];
  const visit = async (file: string) => {
    const stat = await lstat(file); if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const entry of await readdir(file)) if (!['node_modules', '.git', 'target'].includes(entry)) await visit(path.join(file, entry)); }
    else if (stat.isFile() && (stat.size < 4 * 1024 * 1024 || /\.(?:node|dll)$/u.test(file))) files.push({ path: path.relative(process.cwd(), file).replaceAll('\\', '/'), hash: createHash('sha256').update(await readFile(file)).digest('hex') });
  };
  for (const root of roots) await visit(path.resolve(root));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
interface Event { stage: string; phase?: string; elapsedMs?: number; limitMs?: number; error?: string; pid?: number; nativePids?: number[]; [key: string]: unknown }
interface OperationTiming { calls: number; totalMs: number; maxMs: number; failures: number; abandoned: number }
interface PhaseOperationTimings {
  schema: 'worldlinebox.native-resource-operation-timings-v1'; hostPid: number; phase: string;
  storage: Record<string, OperationTiming>; native: Record<string, OperationTiming>; nativePending: number; pairingAnomalies: number;
}
async function resourceGitState() {
  const [head, status] = await Promise.all([execute('git', ['rev-parse', 'HEAD'], { windowsHide: true }), execute('git', ['status', '--porcelain', '--untracked-files=normal'], { windowsHide: true })]);
  return { head: head.stdout.trim(), dirty: !!status.stdout.trim(), status: status.stdout.trim() };
}

it.skipIf(!enabled)('measures bounded full-pipeline native synthetic-vector owner scale without reducing candidates', async () => {
  if (process.platform !== 'win32') throw new Error('This resource receipt requires Windows actual OS working-set/IO sampling.');
  const frozenMode = process.env.WORLDLINEBOX_NATIVE_MEMORY_FROZEN === '1';
  const matrix = (process.env.WORLDLINEBOX_NATIVE_MEMORY_MATRIX ?? '1000:1:1,10000:100:4,100000:1000:4').split(',').map(item => {
    const [notes, owners, activeOwners] = item.split(':').map(Number);
    return { notes, owners, activeOwners, samples: Number(process.env.WORLDLINEBOX_NATIVE_MEMORY_SAMPLES ?? 10), phaseLimitMs: 600000,
      dimension: Number(process.env.WORLDLINEBOX_NATIVE_MEMORY_DIMENSION ?? 768) } as NativeMemoryResourceConfig;
  });
  if (matrix.some(config => ![config.notes, config.owners, config.activeOwners, config.samples, config.dimension].every(value => Number.isSafeInteger(value) && value > 0)
    || config.notes > 100000 || config.owners > 1000 || config.activeOwners > config.owners || config.samples > 100 || config.dimension > 4096)) throw new Error('Invalid bounded benchmark matrix.');
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, '-') + '-' + process.pid;
  const artifact = path.resolve('artifacts/vcp-validation/native-memory-resources-' + runId); await mkdir(artifact, { recursive: true });
  const manifestBefore = await sourceManifest(); await writeFile(path.join(artifact, 'sources-before.json'), JSON.stringify(manifestBefore, null, 2));
  const limits = { phaseMs: 600000, treeRssBytes: Math.min(4 * 1024 ** 3, Math.floor(totalmem() * 0.4)), diskBytes: 1024 ** 3,
    externalOsSampleMs: 1000, hostSampleMs: 100, diskInventoryMs: 10000 };
  const gitBefore = await resourceGitState();
  const report: Record<string, unknown> = { runId, startedAt: new Date().toISOString(), mode: frozenMode ? 'frozen-measurement' : 'exploratory-mutable-workspace',
    exploratoryMutableWorkspace: !frozenMode, gitBefore, sourceDigest: manifestBefore.digest,
    actualNativeGraph: true, actualEncoder: false, actualPaidProvider: false, vectorDimension: matrix[0]?.dimension, limits, matrix, cases: [],
    hardware: { platform: process.platform, architecture: process.arch, osRelease: release(), logicalCpus: cpus().length, cpuModel: cpus()[0]?.model, totalMemoryBytes: totalmem() },
    localPreparationDefinition: 'Query entry including durable task setup, memory admission, canonical gate, native IPC/candidate and durable packet proof through the first focus HTTP send; HTTP model/gateway time follows separately. Cache receipts use validated completion and are labelled separately.',
    limitations: ['Deterministic vectors and HTTP model test resource mechanics, not semantic encoder or answer quality.',
      'Concurrent unrelated workspace tests can affect latency; this is not an isolated-machine SLA result.',
      'The isolated host runs the actual SQLite ledger in-process with structured-clone RPC boundaries; production renderer and separate storage-worker overhead are not included.',
      matrix.some(config => config.samples < 100) ? 'Fewer than 100 samples are diagnostic and do not establish the 100-sample performance acceptance target.'
        : 'Each warm and same-task phase records 100 samples; small one-off cold/write/maintenance/revocation phases are reported with their actual sample counts.',
      'OS sampling is measured working set/RSS; sum of per-process OS lifetime peaks is reported separately from simultaneous sampled tree peak.',
      'Canonical materialization and complete native candidate mathematics remain enabled; phases stop at declared limits.'] };
  await writeFile(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
  if (frozenMode && (gitBefore.dirty || matrix.some(config => config.samples !== 100))) {
    report.preflightRejected = gitBefore.dirty ? 'Final resource measurement requires a clean committed HEAD.' : 'Frozen final resource phases require 100 warm/same-task samples.';
    await writeFile(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2)); throw new Error(String(report.preflightRejected));
  }
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-native-resource-'));
  const host = path.join(root, 'resource-host.cjs');
  await build({ configFile: false, logLevel: 'silent', resolve: { conditions: ['node'] }, build: { outDir: root, emptyOutDir: false, target: 'node24', minify: false,
    lib: { entry: path.resolve('tests/fixtures/prepared-recall-host.ts'), formats: ['cjs'], fileName: () => 'resource-host.cjs' },
    rollupOptions: { external: id => !id.startsWith('.') && !path.isAbsolute(id), output: { banner: `module.paths.unshift(${JSON.stringify(path.resolve('node_modules'))});` } } } });
  const compiledHost = await readFile(host);
  report.compiledHostSha256 = createHash('sha256').update(compiledHost).digest('hex');
  await writeFile(path.join(artifact, 'resource-host.cjs'), compiledHost, { flag: 'wx' });
  const cases = report.cases as Array<Record<string, unknown>>;
  let frozen: Awaited<ReturnType<typeof freezeMemorySoakImplementation>> | undefined;
  let integrityFailure: unknown;
  try {
    if (frozenMode) {
      frozen = await freezeMemorySoakImplementation({ fixtureRoot: root, requireClean: true, loadedImplementation: { resourceHost: compiledHost.toString('utf8') } });
      await writeFile(path.join(artifact, 'implementation-manifest.json'), await readFile(frozen.manifestFile), { flag: 'wx' });
      report.frozenImplementation = { manifest: 'implementation-manifest.json', manifestSha256: frozen.manifestSha256, git: frozen.manifest.git,
        dependencies: frozen.manifest.dependencies, compiledHostSha256: report.compiledHostSha256 };
    }
    for (const config of matrix) {
      await frozen?.verifyFrozen(); await frozen?.verifySources();
      const effectiveConfig = { ...config, ...(frozen ? { implementation: { workerPath: frozen.workerPath, vendorRoot: frozen.vendorRoot,
        manifestFile: frozen.manifestFile, manifestSha256: frozen.manifestSha256 } } : {}) };
      const caseRoot = path.join(root, 'case-' + config.notes + '-' + config.owners); await mkdir(caseRoot);
      const caseArtifact = path.join(artifact, config.notes + '-' + config.owners); await mkdir(caseArtifact);
      const events: Event[] = [], nativePids = new Set<number>(), allPids = new Set<number>(), peaks = new Map<number, number>();
      const operationTimingPhases = new Map<string, PhaseOperationTimings & { phaseCompleted: boolean }>();
      const nativeOwners = new Map<number, string>(); let peakNativeProcesses = 0;
      const livePids = new Set<number>(), nativeLaunches = new Map<number, { hostPid: number; workerPath: string; launchedAt: number }>();
      let currentPhase = 'launch', activeChild: ChildProcess | undefined, stopReason: string | undefined, sampledTreePeak = 0, diskPeak = 0,
        documentInputs = 0, queryInputs = 0, embeddingInputBytes = 0, providerInputs = 0, providerInputBytes = 0, osSamples = 0, sampling = false, diskSampling = false;
      const ioPeaks = new Map<number, { read: number; write: number; cpuSeconds: number }>();
      let releaseModel: (() => void) | undefined, modelObserved = false;
      const modelWaiters: Array<() => void> = [];
      const stop = (reason: string) => { if (stopReason) return; stopReason = reason; activeChild?.kill('SIGKILL'); releaseModel?.(); };
      const server = createServer(async (request, response) => {
        try {
          if (request.url === '/control/wait-model') { if (!modelObserved) await new Promise<void>(resolve => modelWaiters.push(resolve)); response.end('{}'); return; }
          if (request.url === '/control/release') { releaseModel?.(); releaseModel = undefined; modelObserved = false; response.end('{}'); return; }
          let text = ''; for await (const chunk of request) text += chunk.toString(); const body = JSON.parse(text); response.setHeader('content-type', 'application/json');
          if (Array.isArray(body.input)) {
            if (request.url?.startsWith('/document')) documentInputs += body.input.length; else queryInputs += body.input.length;
            embeddingInputBytes += Buffer.byteLength(text); response.end(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index,
              embedding: Array.from({ length: config.dimension }, (_, position) => position === 0 ? 1 : 0) })) }));
          } else {
            providerInputs++; providerInputBytes += Buffer.byteLength(text);
            if (['concurrent_write_while_focusing', 'hard_revoke_during_focus'].includes(currentPhase)) {
              const held = new Promise<void>(resolve => { releaseModel = resolve; }); modelObserved = true; modelWaiters.splice(0).forEach(resolve => resolve()); await held;
            }
            const digest = createHash('sha256').update(JSON.stringify(body.messages)).digest('hex');
            response.end(JSON.stringify({ choices: [{ message: { content: `这是我获取的所有相关知识/记忆[[Verified original prompt ${digest}]]` } }] }));
          }
        } catch (error) { if (!response.destroyed) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); } }
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const sampleOs = async () => {
        if (sampling) return; sampling = true;
        try {
          const pids = [...livePids].filter(alive); if (!pids.length) return;
          const filter = pids.map(pid => `ProcessId=${pid}`).join(' OR ');
          const script = `$items=@(); Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){ $items += [pscustomobject]@{pid=$p.Id;rss=$p.WorkingSet64;peak=$p.PeakWorkingSet64;read=[double]$_.ReadTransferCount;write=[double]$_.WriteTransferCount;cpuSeconds=$p.CPU} } }; ConvertTo-Json -InputObject $items -Compress`;
          const output = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
          const processes = JSON.parse(output.stdout || '[]') as Array<{ pid: number; rss: number; peak: number; read: number; write: number; cpuSeconds: number }>;
          const treeRss = processes.reduce((sum, item) => sum + item.rss, 0); sampledTreePeak = Math.max(sampledTreePeak, treeRss); osSamples++;
          for (const item of processes) { peaks.set(item.pid, Math.max(peaks.get(item.pid) ?? 0, item.peak)); ioPeaks.set(item.pid, { read: item.read, write: item.write, cpuSeconds: item.cpuSeconds }); }
          await appendFile(path.join(caseArtifact, 'os-resources.jsonl'), JSON.stringify({ at: Date.now(), phase: currentPhase, treeRss, processes }) + '\n');
          if (treeRss > limits.treeRssBytes) stop('actual_process_tree_working_set_limit');
        } catch (error) { events.push({ stage: 'os-sample-error', error: String(error) }); }
        finally { sampling = false; }
      };
      const sampleDisk = async () => { if (diskSampling) return; diskSampling = true; try { const disk = await inventory(caseRoot); diskPeak = Math.max(diskPeak, disk.bytes);
        await appendFile(path.join(caseArtifact, 'disk.jsonl'), JSON.stringify({ at: Date.now(), phase: currentPhase, ...disk }) + '\n');
        if (disk.bytes > limits.diskBytes) stop('actual_owned_disk_limit'); } finally { diskSampling = false; } };
      const osTimer = setInterval(() => { void sampleOs(); }, limits.externalOsSampleMs), diskTimer = setInterval(() => { void sampleDisk(); }, limits.diskInventoryMs);
      const run = async (stage: 'seed' | 'run') => {
        let phaseTimer: ReturnType<typeof setTimeout> | undefined;
        const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH;
        await frozen?.verifyFrozen(); await frozen?.verifySources();
        if (frozen && createHash('sha256').update(await readFile(host)).digest('hex') !== report.compiledHostSha256) throw new Error('Compiled frozen host bundle changed before launch.');
        const child = fork(host, [caseRoot, endpoint, 'benchmark-' + stage, JSON.stringify(effectiveConfig)], { execPath: process.execPath, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        activeChild = child; allPids.add(child.pid!); livePids.add(child.pid!); child.once('exit', () => livePids.delete(child.pid!)); let completed = false, rejection: string | undefined;
        child.stderr?.on('data', chunk => { void appendFile(path.join(caseArtifact, 'stderr.log'), String(chunk)); });
        phaseTimer = setTimeout(() => stop('host_initialization_phase_deadline'), limits.phaseMs);
        child.on('message', (event: Event) => {
          const timing = event.operationTimings as PhaseOperationTimings | undefined;
          if (timing?.schema === 'worldlinebox.native-resource-operation-timings-v1') {
            const key = `${timing.hostPid}:${timing.phase}`, previous = operationTimingPhases.get(key);
            operationTimingPhases.set(key, { ...timing, phaseCompleted: previous?.phaseCompleted === true || event.stage === 'phase-complete' });
          }
          for (const pid of event.nativePids ?? []) { nativePids.add(pid); allPids.add(pid); }
          if (event.stage === 'native-launch') { peakNativeProcesses = Math.max(peakNativeProcesses, event.nativePids?.length ?? 0);
            if (event.pid !== undefined && typeof event.hostPid === 'number' && typeof event.workerPath === 'string' && typeof event.launchedAt === 'number') {
              nativeLaunches.set(event.pid, { hostPid: event.hostPid, workerPath: event.workerPath, launchedAt: event.launchedAt }); livePids.add(event.pid);
            }
            if (peakNativeProcesses > 4) stop('actual_native_process_limit'); }
          if (event.stage === 'native-exit' && event.pid !== undefined) livePids.delete(event.pid);
          if (event.stage === 'native-owner' && event.pid !== undefined && typeof event.ownerId === 'string') nativeOwners.set(event.pid, event.ownerId);
          if (event.stage === 'resources') { void appendFile(path.join(caseArtifact, 'host-resources.jsonl'), JSON.stringify({ at: Date.now(), phase: currentPhase, ...event }) + '\n'); return; }
          events.push(event); void appendFile(path.join(caseArtifact, 'events.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n');
          if (event.stage === 'phase') { currentPhase = event.phase!; if (phaseTimer) clearTimeout(phaseTimer); phaseTimer = setTimeout(() => stop('phase_deadline:' + currentPhase), config.phaseLimitMs); }
          if (event.stage === 'phase-complete') void sampleDisk();
          if (event.stage === 'benchmark-complete') completed = true;
          if (['fatal', 'rejected', 'phase-failed'].includes(event.stage)) rejection = event.error;
        });
        await waitExit(child); if (phaseTimer) clearTimeout(phaseTimer); activeChild = undefined;
        if (!completed || child.exitCode) throw new Error(stopReason ?? rejection ?? `Benchmark host ${stage} exited ${child.exitCode} without completion.`);
      };
      let failure: string | undefined, complete = false;
      try { await run('seed'); await sampleDisk(); await run('run');
        if ([...nativePids].some(pid => !nativeOwners.has(pid))) throw new Error('A measured native process lacks an actual trusted owner initialization receipt.');
        complete = true; }
      catch (error) { failure = String(error); }
      finally {
        clearInterval(osTimer); clearInterval(diskTimer); releaseModel?.(); modelWaiters.splice(0).forEach(resolve => resolve());
        if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) { activeChild.kill('SIGKILL'); await waitExit(activeChild); }
        await new Promise(resolve => setTimeout(resolve, 1500));
        // Grandchild PIDs may be reused after a host is killed. Require the
        // actual original parent, executable arguments and creation time before
        // stopping an orphan; never kill an unrelated recycled process ID.
        for (const [pid, launch] of nativeLaunches) if (livePids.has(pid) && alive(pid)) {
          const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){ [pscustomobject]@{parent=$p.ParentProcessId;command=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`;
          const output = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
          const current = output.stdout.trim() ? JSON.parse(output.stdout) as { parent: number; command: string; created: string } : undefined;
          if (current?.parent === launch.hostPid && current.command.includes(launch.workerPath) && Math.abs(Date.parse(current.created) - launch.launchedAt) < 5000)
            try { process.kill(pid, 'SIGKILL'); } catch { /* The verified child already exited. */ }
          else events.push({ stage: 'orphan-pid-no-longer-owned', pid });
        }
        await sampleDisk(); while (sampling || diskSampling) await new Promise(resolve => setTimeout(resolve, 100));
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        const samplePhases = [...new Set(events.filter(event => event.stage === 'sample').map(event => event.phase!))];
        const latencies = Object.fromEntries(samplePhases.map(phase => { const values = events.filter(event => event.stage === 'sample' && event.phase === phase).map(event => event.elapsedMs!);
          return [phase, { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), rawMs: values }]; }));
        const localPreparation = Object.fromEntries(samplePhases.map(phase => { const selected = events.filter(event => event.stage === 'sample' && event.phase === phase && typeof event.localPreparationMs === 'number');
          const values = selected.map(event => event.localPreparationMs as number); return [phase, { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
            p99Ms: percentile(values, 0.99), rawMs: values, boundaries: selected.map(event => event.preparationBoundary) }]; }));
        const timingPhaseDeltas = [...operationTimingPhases.values()];
        const aggregateTimings = (kind: 'storage' | 'native') => {
          const totals: Record<string, OperationTiming> = {};
          for (const phase of timingPhaseDeltas) for (const [operation, value] of Object.entries(phase[kind])) {
            const total = totals[operation] ??= { calls: 0, totalMs: 0, maxMs: 0, failures: 0, abandoned: 0 };
            total.calls += value.calls; total.totalMs += value.totalMs; total.maxMs = Math.max(total.maxMs, value.maxMs);
            total.failures += value.failures; total.abandoned += value.abandoned;
          }
          return totals;
        };
        const record = { config, complete, failure, stopReason, lastPhase: currentPhase, sampledTreePeakRssBytes: sampledTreePeak,
          sumPerProcessOsLifetimePeakRssBytes: [...peaks.values()].reduce((sum, value) => sum + value, 0), osSamples, diskPeakBytes: diskPeak,
          actualPids: [...allPids], perProcessIoLastObserved: Object.fromEntries(ioPeaks), documentInputs, queryInputs, embeddingInputBytes, providerInputs, providerInputBytes,
          peakNativeProcesses, actualNativeOwnerByPid: Object.fromEntries(nativeOwners), nativeOwnerIds: [...new Set(nativeOwners.values())],
          latencies, localPreparation, operationTimings: { schema: 'worldlinebox.native-resource-operation-timings-v1', phaseDeltas: timingPhaseDeltas,
            storageTotals: aggregateTimings('storage'), nativeTotals: aggregateTimings('native'), definitions: {
              phaseDelta: 'Zero-based per-host phase totals; requests belong to their start phase. Maxima are phase-local, not differences of cumulative maxima.',
              storage: 'Actual synchronous store.request plus structuredClone. Direct fixture ledger-seeding calls bypass this port and remain unmeasured.',
              native: 'Transport postMessage send through matching requestId response or process exit; includes IPC, worker queue and worker IO/computation. Excludes pre-send broker/ensureScope and does not isolate DailyNote/coordinator/embedding/native commit.',
              terminalCalls: 'Calls and durations include observed success, error and abandoned terminals, distinguished by failures/abandoned. NativePending remains separate; abrupt host death retains only its last 100ms snapshot.',
            } }, completedPhases: events.filter(event => event.stage === 'phase-complete'), failureEvents: events.filter(event => event.stage.includes('fail') || event.stage.includes('error')) };
        cases.push(record); await writeFile(path.join(caseArtifact, 'report.json'), JSON.stringify(record, null, 2));
        await writeFile(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      }
    }
  } finally {
    const manifestAfter = await sourceManifest(); await writeFile(path.join(artifact, 'sources-after.json'), JSON.stringify(manifestAfter, null, 2));
    const gitAfter = await resourceGitState(); report.gitAfter = gitAfter;
    report.sourceChangedDuringRun = manifestAfter.digest !== manifestBefore.digest; report.finishedAt = new Date().toISOString();
    if (frozenMode) try { await frozen?.verifyFrozen(); await frozen?.verifySources();
      if (!frozen || gitAfter.dirty || gitAfter.head !== gitBefore.head || report.sourceChangedDuringRun)
        integrityFailure = new Error('Frozen source/HEAD/cleanliness changed during the resource measurement.');
      else if (createHash('sha256').update(await readFile(host)).digest('hex') !== report.compiledHostSha256)
        integrityFailure = new Error('Compiled frozen host bundle changed during the resource measurement.');
      else report.frozenIntegrityVerified = true;
    } catch (error) { integrityFailure = error; }
    if (integrityFailure) { report.frozenIntegrityVerified = false; report.frozenIntegrityFailure = String(integrityFailure); }
    await writeFile(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2)); await removeOwnedDirectory(root);
  }
  if (integrityFailure) throw integrityFailure;
  expect(cases.every(item => item.complete), 'Exploratory failures and declared limit stops are retained at ' + artifact).toBe(true);
}, 6 * 60 * 60 * 1000);
