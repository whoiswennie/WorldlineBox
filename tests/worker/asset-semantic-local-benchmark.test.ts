import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { expect, it } from 'vitest';
import { LibraryService } from '../../src/worker/library-service';
import { executeSemanticIndexWorkerCommand, closeSemanticIndexWorkerLibrary } from '../../src/worker/handlers/semantic-index';
import { EmbeddingTestIndex } from '../../src/main/embedding-test-index';
import { startLlamaEmbeddingSession } from '../../src/main/embedding-llama-session';
import type { WorkerCommand, WorkerRequest } from '../../src/shared/protocol/requests';
import type { WorkerResult, RendererResult } from '../../src/shared/protocol/responses';

const require = createRequire(import.meta.url);
interface FixtureDb { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void }
const Sqlite = require('better-sqlite3') as new (file: string) => FixtureDb;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function gpuMiB(): number | null {
  try { return Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true, encoding: 'utf8' }).trim().split('\n')[0]); }
  catch { return null; }
}
function processInfo() {
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "$items=@(Get-Process -Name llama-server -ErrorAction SilentlyContinue); $items | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress; exit 0"], { windowsHide: true, encoding: 'utf8' }).trim();
  return raw ? (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)]) as Array<{ Id: number; WorkingSet64: number; PeakWorkingSet64: number; PrivateMemorySize64: number; CPU: number }> : [];
}
const enabled = process.env.WORLDLINEBOX_RUN_ASSET_EMBEDDING_BENCHMARK === '1';
it.skipIf(!enabled)('benchmarks real asset activation, four modalities, repeated search, idle residency and explicit runtime-cache release', async () => {
  const bundle = path.resolve('resources/embedding-models'), media = path.resolve('resources/ffmpeg/win32-x64');
  const sourceFixtures = path.join(tmpdir(), 'worldlinebox-gemma-gpu-validation');
  const output = path.resolve('artifacts/vcp-validation/asset-semantic-local-benchmark.json'); mkdirSync(path.dirname(output), { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-asset-semantic-benchmark-'));
  const service = new LibraryService(), library = service.createLibrary({ displayName: 'Semantic benchmark isolated library', selectedParentPath: root });
  const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Fixtures' });
  const assets = new Map<string, string>(), commands: Array<{ type: string; ms: number }> = [], starts: unknown[] = [], samples: Array<{ atMs: number; hostRss: number; gpuMiB: number | null }> = [];
  const beforeProcesses = processInfo(), baselineGpuMiB = gpuMiB(), baselineHostRss = process.memoryUsage().rss, began = performance.now();
  let phase = 'fixtures', index: EmbeddingTestIndex | undefined, sampling = false;
  const timer = setInterval(() => { samples.push({ atMs: performance.now() - began, hostRss: process.memoryUsage().rss, gpuMiB: null }); }, 200);
  const gpuTimer = setInterval(() => { if (sampling) return; sampling = true; try { samples.push({ atMs: performance.now() - began, hostRss: process.memoryUsage().rss, gpuMiB: gpuMiB() }); } finally { sampling = false; } }, 2000);
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), bundle, libraryFixtureOnly: true, realWorkerAndSqlite: true,
    concurrentWorkload: process.env.WORLDLINEBOX_ASSET_BENCHMARK_BACKGROUND ?? 'Not recorded; RSS is measured per benchmark PID and GPU memory is device-wide.',
    beforeProcesses, baselineGpuMiB, baselineHostRss, limitations: ['GPU memory is device-wide observed use; other desktop consumers are included.',
      'Host RSS includes the benchmark harness and in-process LibraryService, not the whole application or system RAM.',
      'The product currently retains its runtime while idle; explicit clear/close releases it. This test does not claim automatic idle eviction.'] };
  try {
    expect(beforeProcesses).toEqual([]);
    const db = new Sqlite(path.join(library.libraryPath, '.worldlinebox/library.db'));
    const add = (name: string, bytes: Buffer) => {
      const assetId = randomUUID(), revisionId = randomUUID(), relative = folder.relativePath + '/' + name, now = new Date().toISOString();
      db.prepare("INSERT INTO assets(asset_id,location_kind,managed_folder_id,linked_folder_id,relative_file_path,current_revision_id,availability,path_identity,created_at,updated_at) VALUES(?,'managed',?,NULL,?,NULL,'available',?,?,?)")
        .run(assetId, folder.folderId, relative, relative, now, now);
      db.prepare("INSERT INTO revisions(revision_id,asset_id,parent_revision_id,byte_size,modified_at,original_filename,origin,accepted_at) VALUES(?,?,NULL,?,?,?,'import',?)")
        .run(revisionId, assetId, bytes.length, now, name, now);
      db.prepare('UPDATE assets SET current_revision_id=? WHERE asset_id=?').run(revisionId, assetId);
      const file = service.resolveAssetPath(library.libraryId, assetId); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); assets.set(name, assetId);
    };
    try {
      for (const [name, text] of [['umbrella.md', '下雨出门记得带蓝色雨伞，雨伞收在门边。'], ['backup.md', '修改聊天保存代码前先备份，以便出错时恢复。'], ['coffee.md', '最近减少晚上喝咖啡，希望睡得更好。']]) add(name!, Buffer.from(text!));
      for (const [name, color] of [['red.png', '#ff0000'], ['red-near.png', '#f00000'], ['blue.png', '#0000ff'], ['green.png', '#008000']]) {
        const canvas = createCanvas(256, 256), context = canvas.getContext('2d'); context.fillStyle = color!; context.fillRect(0, 0, 256, 256); add(name!, canvas.toBuffer('image/png'));
      }
      for (const name of ['dentist.wav', 'library.wav', 'plants.wav', 'red-blue.mp4', 'red-green.mp4', 'red-blue-dentist.mp4', 'red-blue-library.mp4']) add(name, readFileSync(path.join(sourceFixtures, name)));
    } finally { db.close(); }
    const requestWorker = async (command: WorkerCommand): Promise<WorkerResult> => {
      const started = performance.now();
      const result = await executeSemanticIndexWorkerCommand(service, { requestId: randomUUID(), command } as WorkerRequest, { runWithoutAdmission: async work => work() });
      commands.push({ type: command.type, ms: performance.now() - started }); if (!result) throw new Error('Unhandled ' + command.type); return result;
    };
    const makeIndex = () => new EmbeddingTestIndex({ configDirectories: [], requestWorker,
      installedLayout: () => ({ modelDirectory: bundle, runtimePath: path.join(bundle, 'runtime-vulkan/llama-server.exe'), cpuRuntimePath: path.join(bundle, 'runtime-cpu/llama-server.exe') }),
      koffiPath: require.resolve('koffi'), resolveMediaBinaries: () => ({ ffmpegPath: path.join(media, 'ffmpeg.exe'), ffprobePath: path.join(media, 'ffprobe.exe') }),
      startSession: async options => { const start = performance.now(); const session = await startLlamaEmbeddingSession(options);
        starts.push({ executable: options.executable, gpuLayers: options.gpuLayers, ms: performance.now() - start }); return session; } });
    index = makeIndex(); phase = 'activation'; const activation = performance.now();
    const initial = index.handleStatus({ libraryId: library.libraryId, modelId: 'embeddinggemma-2-compact', run: true, restart: false }); report.initialStatus = initial;
    let snapshot: RendererResult = initial;
    while (performance.now() - activation < 120000) {
      snapshot = index.handleStatus({ libraryId: library.libraryId, modelId: 'embeddinggemma-2-compact', run: false, restart: false });
      if (snapshot.ok && snapshot.type === 'embedding.index.status' && ['ready', 'failed', 'unavailable'].includes(snapshot.phase)) break;
      await sleep(100);
    }
    report.activationToReadyMs = performance.now() - activation; report.finalIndex = snapshot; report.runtimeReady = processInfo();
    expect(snapshot).toMatchObject({ ok: true, phase: 'ready', total: assets.size, done: assets.size, failedCount: 0 });
    phase = 'search'; const searches: Array<{ kind: string; query: string; expected: string; ms: number; result: RendererResult; names: Array<string | undefined> }> = [];
    for (const [kind, query, expected, format] of [['text', '下雨出门带的东西放在哪里', 'umbrella.md', 'md'], ['image', '一张红色正方形图片', 'red.png', 'png'],
      ['audio', '下周二下午三点去看牙医的预约', 'dentist.wav', 'wav'], ['video-visual', 'a video showing a red square changing to green', 'red-green.mp4', 'mp4'],
      ['video-audio', '视频的声音讲在图书馆帮孩子找科学书', 'red-blue-library.mp4', 'mp4']]) {
      const start = performance.now(), result = await index.handleSearch({ libraryId: library.libraryId, modelId: 'embeddinggemma-2-compact', query: query!, filters: [{ field: 'format', values: [format!], exclude: false }] });
      searches.push({ kind: kind!, query: query!, expected: expected!, ms: performance.now() - start, result, names: result.ok && 'assetIds' in result ? (result.assetIds ?? []).map(id => [...assets].find(([, value]) => value === id)?.[0]) : [] });
    }
    report.searches = searches;
    report.searchTop1Correct = searches.filter(search => search.names[0] === search.expected || search.kind === 'image' && search.names[0] === 'red-near.png').length;
    const similarStart = performance.now(), similar = await index.handleSimilar({ libraryId: library.libraryId, modelId: 'embeddinggemma-2-compact', assetId: assets.get('red.png')!, filters: [{ field: 'format', values: ['png'], exclude: false }] });
    report.imageSimilar = { ms: performance.now() - similarStart, result: similar, expected: 'red-near.png', names: similar.ok && 'assetIds' in similar ? (similar.assetIds ?? []).map(id => [...assets].find(([, value]) => value === id)?.[0]) : [] };
    expect(similar).toMatchObject({ ok: true, status: 'ready' });
    expect(similar.ok && 'assetIds' in similar && similar.assetIds?.[0]).toBe(assets.get('red-near.png'));
    const writesBeforeRepeat = commands.filter(command => command.type === 'semantic.index.write').length;
    const repeat: unknown[] = [];
    for (let round = 0; round < 5; round++) { const start = performance.now(); const result = await index.handleSearch({ libraryId: library.libraryId, modelId: 'embeddinggemma-2-compact', query: '一张红色正方形图片', filters: [{ field: 'format', values: ['png'], exclude: false }] }); repeat.push({ ms: performance.now() - start, result }); }
    report.repeat = repeat; report.reencodedAssetsDuringRepeat = commands.filter(command => command.type === 'semantic.index.write').length - writesBeforeRepeat;
    phase = 'idle'; report.beforeIdle = { runtime: processInfo(), gpuMiB: gpuMiB(), host: process.memoryUsage() }; await sleep(10000);
    report.afterIdle10Seconds = { runtime: processInfo(), gpuMiB: gpuMiB(), host: process.memoryUsage() };
    phase = 'clear'; const clearStart = performance.now(); await index.close(); report.clearMs = performance.now() - clearStart; await sleep(1000);
    report.afterClear = { runtime: processInfo(), gpuMiB: gpuMiB(), host: process.memoryUsage() };
    expect(processInfo()).toEqual([]); expect(report.reencodedAssetsDuringRepeat).toBe(0); expect(report.searchTop1Correct).toBe(5);
    report.persistedIndexFiles = statSync(path.join(library.libraryPath, '.worldlinebox/semantic')).isDirectory(); report.success = true;
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); report.failedPhase = phase; throw error; }
  finally {
    clearInterval(timer); clearInterval(gpuTimer); await index?.close(); await closeSemanticIndexWorkerLibrary(); service.closeAll();
    report.samples = samples; report.starts = starts; report.commands = commands; report.elapsedMs = performance.now() - began;
    report.peakObservedHostRss = Math.max(baselineHostRss, ...samples.map(sample => sample.hostRss));
    report.peakObservedGpuMiB = Math.max(baselineGpuMiB ?? 0, ...samples.flatMap(sample => sample.gpuMiB === null ? [] : [sample.gpuMiB]));
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('worldlinebox-asset-semantic-benchmark-')) rmSync(root, { recursive: true, force: true });
    else report.cleanupRefused = true;
    writeFileSync(output, JSON.stringify(report, null, 2));
  }
}, 180000);
