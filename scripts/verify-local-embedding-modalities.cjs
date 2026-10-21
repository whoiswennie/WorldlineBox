#!/usr/bin/env node
// Explicit local fixtures only; this validation never changes application settings or user libraries.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true, resolveJsonModule: true },
}).outputText, file);
const { startLlamaEmbeddingSession } = require('../src/main/embedding-llama-session.ts');
const { renderEmbeddingAudioWindows, discardPreparedEmbeddingAudio } = require('../src/main/embedding-audio.ts');
const { prepareEmbeddingVideoWindows } = require('../src/worker/embedding-video.ts');
const { meanPoolEmbeddings } = require('../src/shared/embedding/profile.ts');
const { createCanvas } = require('@napi-rs/canvas');
const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); if (index < 0) throw new Error(`Missing ${name}`); return path.resolve(args[index + 1]); };
const runtime = value('--runtime-dir'), models = value('--models-dir'), media = value('--media-dir'), fixtures = value('--fixtures-dir'), output = value('--output');
const cpu = args.includes('--cpu');
const timings = [], latencySamples = []; let phase = 'text';
const cosine = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0) / Math.hypot(...a) / Math.hypot(...b);
async function measured(fn) { const started = performance.now(); const vector = await fn(); const ms = performance.now() - started; timings.push(ms); latencySamples.push({ phase, ms });
  if (vector.length !== 768 || vector.some(v => !Number.isFinite(v)) || Math.hypot(...vector) === 0) throw new Error('Invalid 768-dimensional vector'); return vector; }
function memory() { try { return execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true, encoding: 'utf8' }).trim(); } catch { return null; } }
function rank(query, corpus) { return corpus.map(item => ({ id: item.id, score: cosine(query, item.vector) })).sort((a, b) => b.score - a.score); }
(async () => {
  const beforeGpuMiB = memory(), started = performance.now();
  const session = await startLlamaEmbeddingSession({ executable: path.join(runtime, 'llama-server.exe'),
    files: { corePath: path.join(models, 'embeddinggemma-2-UD-Q4_K_XL.gguf'), projectorPath: path.join(models, 'mmproj-Q8_0.gguf') },
    gpuLayers: cpu ? 0 : 99, threads: 4, contextSize: 8192, pooling: 'mean', koffiPath: require.resolve('koffi'),
    mediaBinaries: { ffmpegPath: path.join(media, 'ffmpeg.exe'), ffprobePath: path.join(media, 'ffprobe.exe') },
    startupTimeoutMs: 60_000, requestTimeoutMs: 120_000 });
  const result = { generatedAt: new Date().toISOString(), runtime, cpu, startupMs: performance.now() - started, dimension: 768,
    beforeGpuMiB, loadedGpuMiB: memory(), text: {}, image: {}, audio: {}, video: {} };
  try {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/embedding-memory-retrieval.json'), 'utf8'));
    const docs = [];
    if (!args.includes('--video-only')) {
    for (const doc of fixture.documents) docs.push({ id: doc.id, vector: await measured(() => session.embedText(`title: none | text: ${doc.text}`)) });
    result.text.rankings = [];
    for (const query of fixture.queries) result.text.rankings.push({ id: query.id, expected: query.expected,
      results: rank(await measured(() => session.embedText(`task: search result | query: ${query.text}`)), docs).slice(0, 3) });
    result.text.correct = result.text.rankings.filter(q => q.results[0].id === q.expected).length;
    phase = 'image'; const images = [];
    for (const color of ['red', 'blue', 'green']) { const canvas = createCanvas(256, 256), ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 256, 256);
      images.push({ id: color, vector: await measured(() => session.embedImagePayload('image/png', canvas.toBuffer('image/png').toString('base64'))) }); }
    result.image.rankings = [];
    for (const [expected, text] of [['red', '一张红色的正方形图片'], ['blue', 'a blue square image'], ['green', '一张绿色的正方形图片']])
      result.image.rankings.push({ expected, results: rank(await measured(() => session.embedText(`task: search result | query: ${text}`)), images) });
    result.image.correct = result.image.rankings.filter(q => q.results[0].id === q.expected).length;
    phase = 'audio'; const audios = [];
    for (const id of ['dentist', 'library', 'plants']) {
      const prepared = await renderEmbeddingAudioWindows({ ffmpegPath: path.join(media, 'ffmpeg.exe'), sourcePath: path.join(fixtures, `${id}.wav`), maxWindows: 16 });
      try { audios.push({ id, vector: await measured(() => session.embedAudio(prepared.wavPaths[0])) }); } finally { await discardPreparedEmbeddingAudio(prepared); }
    }
    result.audio.rankings = [];
    for (const [expected, text] of [['dentist', '下周二下午三点去看牙医的预约'], ['library', '在图书馆帮小朋友寻找科学和星星的书'], ['plants', '每天早上给阳台的番茄浇水']])
      result.audio.rankings.push({ expected, results: rank(await measured(() => session.embedText(`task: search result | query: ${text}`)), audios) });
    result.audio.correct = result.audio.rankings.filter(q => q.results[0].id === q.expected).length;
    }
    phase = 'video';
    const encodeVideo = async id => {
      const windows = await prepareEmbeddingVideoWindows({ sourcePath: path.join(fixtures, `${id}.mp4`), ffmpegPath: path.join(media, 'ffmpeg.exe'), ffprobePath: path.join(media, 'ffprobe.exe') });
      const vectors = []; for (const window of windows) vectors.push(await measured(() => session.embedVideoPayload(window.bytesBase64, window.audioBase64)));
      return meanPoolEmbeddings(vectors);
    };
    const videos = [];
    for (const id of ['red-blue', 'red-green']) videos.push({ id, vector: await encodeVideo(id) });
    result.video.rankings = [];
    for (const [expected, text] of [['red-blue', 'a video showing a red square changing to blue'], ['red-green', 'a video showing a red square changing to green']])
      result.video.rankings.push({ expected, results: rank(await measured(() => session.embedText(`task: search result | query: ${text}`)), videos) });
    result.video.correct = result.video.rankings.filter(q => q.results[0].id === q.expected).length;
    result.video.sameFirstFrameDifferentContentCosine = cosine(videos[0].vector, videos[1].vector);
    const audiovisual = [];
    for (const id of ['dentist', 'library']) audiovisual.push({ id, vector: await encodeVideo(`red-blue-${id}`) });
    result.video.audioRankings = [];
    for (const [expected, text] of [['dentist', '视频里说要预约下周去看牙医'], ['library', '视频的声音讲在图书馆帮孩子找科学书']])
      result.video.audioRankings.push({ expected, results: rank(await measured(() => session.embedText(`task: search result | query: ${text}`)), audiovisual) });
    result.video.audioCorrect = result.video.audioRankings.filter(q => q.results[0].id === q.expected).length;
    result.text.vectors = docs;
  } catch (error) { result.error = error.message; process.exitCode = 1; }
  finally { result.peakObservedGpuMiB = memory(); await session.close(); result.closedSuccessfully = true; }
  result.requestCount = timings.length; result.latencyMedianMs = [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)];
  result.latencySamples = latencySamples;
  result.totalMs = performance.now() - started; result.afterGpuMiB = memory();
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, text: { correct: result.text.correct }, image: { correct: result.image.correct }, audio: { correct: result.audio.correct }, video: result.video }));
})().catch(error => { console.error(error); process.exitCode = 1; });
