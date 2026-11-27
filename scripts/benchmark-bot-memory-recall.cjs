#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { fork } = require('node:child_process');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const diary = 'Companion';
const selections = { diaries: [diary], k: 3, engine: 'rivermemo', fallback: 'none' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// No app adapters or test runner are loaded by the reference child.
async function originalChild(reference) {
  const started = performance.now();
  const kb = require(path.join(reference, 'KnowledgeBaseManager.js'));
  kb.config.apiUrl = process.env.MEMORY_DOCUMENT_API_URL;
  const rag = require(path.join(reference, 'Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'));
  await kb.initialize(); await rag.initialize(process.env, { vectorDBManager: kb });
  const nativeQuery = kb.executeNativeRiverQuery;
  const bridge = rag.getContextBridge(), vectors = new Map();
  await kb.listDistinctDiaries();
  process.send({ ready: true, elapsed: performance.now() - started });
  process.on('message', async ({ id, phase, query }) => {
    try {
      if (phase === 'close') {
        await rag.shutdown(); await kb.shutdown(); return process.exit(0);
      }
      const from = performance.now();
      const vector = phase === 'preencoded' ? vectors.get(query) : await bridge.embedText(query);
      assert.equal(vector?.length, 768); vectors.set(query, vector);
      let recallMs;
      if (phase === 'preencoded') kb.executeNativeRiverQuery = async function (...args) {
        const before = performance.now();
        try { return await nativeQuery.apply(this, args); } finally { recallMs = performance.now() - before; }
      };
      try {
        const value = await bridge.retrieveDiary({ diaryNames: [diary], queryVector: vector, queryText: query, k: 3, engine: 'rivermemo', fallback: 'none' });
        process.send({ id, value, elapsed: performance.now() - from, recallMs });
      } finally { if (phase === 'preencoded') kb.executeNativeRiverQuery = nativeQuery; }
    } catch (error) { process.send({ id, error: error.message }); }
  });
}

async function openOriginal(nodePath, reference, env) {
  const before = performance.now();
  const child = fork(__filename, ['--original', reference], { execPath: nodePath, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let tail = '', index = 0;
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { tail = (tail + text).slice(-4000); });
  const pending = new Map();
  const ready = new Promise((resolve, reject) => pending.set('ready', { resolve, reject }));
  const closed = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const waiter of pending.values()) waiter.reject(Error('Original child ended: ' + (signal || code) + ' ' + tail));
    pending.clear(); resolve();
  }));
  child.on('message', result => {
    const key = result.ready ? 'ready' : result.id, waiter = pending.get(key);
    if (!waiter) return;
    pending.delete(key);
    if (result.error) waiter.reject(Error(result.error)); else waiter.resolve(result);
  });
  child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
  const initialized = await ready;
  return { openMs: performance.now() - before, engineOpenMs: initialized.elapsed,
    request: (phase, query) => new Promise((resolve, reject) => { const id = ++index; pending.set(id, { resolve, reject }); child.send({ id, phase, query }); }),
    close: async () => { if (child.connected) child.send({ phase: 'close' }); await closed; } };
}

function distribution(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = fraction => ordered.length ? ordered[Math.ceil(fraction * ordered.length) - 1] : null;
  return { n: ordered.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: ordered.at(-1) ?? null };
}
function grade(queries, rows) {
  const measured = queries.map(question => {
    const row = rows.find(item => item.queryId === question.id);
    const ids = (row?.hits || []).map(hit => hit.id), expected = question.expectedIds;
    const relevant = new Set(ids.filter(id => expected.includes(id))), best = ids.findIndex(id => expected.includes(id));
    return { id: question.id, category: question.category, expected, ids, error: row?.error, relevance: relevant.size,
      top1: best === 0, hit: best >= 0, recall: expected.length ? relevant.size / expected.length : null, reciprocal: best < 0 ? 0 : 1 / (best + 1) };
  });
  const positives = measured.filter(row => row.expected.length), multi = positives.filter(row => row.expected.length > 1);
  const mean = (items, fn) => items.length ? items.reduce((sum, item) => sum + Number(fn(item)), 0) / items.length : null;
  return { positives: positives.length, top1: mean(positives, row => row.top1), hitAt3: mean(positives, row => row.hit), recallAt3: mean(positives, row => row.recall),
    relevantRetrieved: positives.reduce((n, row) => n + row.relevance, 0), relevantTotal: positives.reduce((n, row) => n + row.expected.length, 0),
    mrrAt3: mean(positives, row => row.reciprocal), multisource: multi.length, multisourceAllHit: multi.filter(row => row.recall === 1).length,
    outOfCorpus: measured.filter(row => !row.expected.length).map(({ id, ids, error }) => ({ id, returned: ids.length, ids, error })),
    missed: positives.filter(row => row.recall < 1), top1Failures: positives.filter(row => !row.top1) };
}
function copyIndex(home, target, existingHome = false) {
  fs.mkdirSync(target, { recursive: true });
  if (!existingHome) fs.copyFileSync(path.join(home, 'config.json'), path.join(target, 'config.json'));
  if (existingHome) fs.rmSync(path.join(target, 'VectorStore'), { recursive: true, force: true });
  for (const ext of ['', '-wal', '-shm']) {
    const file = 'bot-adapter.sqlite' + ext;
    if (fs.existsSync(path.join(home, file))) fs.copyFileSync(path.join(home, file), path.join(target, file));
    else if (existingHome) fs.rmSync(path.join(target, file), { force: true });
  }
  fs.cpSync(path.join(home, 'VectorStore'), path.join(target, 'VectorStore'), { recursive: true, preserveTimestamps: true });
  if (existingHome) return;
  // The real source guard requires independently owned regular files.
  fs.cpSync(path.join(home, 'dailynote'), path.join(target, 'dailynote'), { recursive: true, preserveTimestamps: true });
}
function hitList(result, notes) {
  return result.results.map(({ text, score, chunkId, id }) => {
    const matches = notes.filter(note => text.includes(note.content));
    assert.equal(matches.length, 1, 'Each native result must resolve to exactly one unmodified fixture body');
    return { id: matches[0].id, nativeId: chunkId ?? id, score };
  });
}
async function main() {
  const { withIndexedMemory, extractOriginal, originalEnv, memoryDir } = require('./verify-bot-memory-recall.cjs');
  const fixtureFile = path.resolve(process.env.WORLDLINEBOX_BENCH_FIXTURE || 'tests/fixtures/vcp-recall-benchmark.json');
  const output = path.resolve(process.env.WORLDLINEBOX_BENCH_REPORT || 'artifacts/vcp-native-parity/retrieval-benchmark.json');
  const source = fs.readFileSync(fixtureFile), fixture = JSON.parse(source), { notes, queries } = fixture;
  assert.equal(new Set(notes.map(note => note.content)).size, notes.length);
  assert.equal(new Set(queries.map(item => item.query)).size, queries.length);
  const rounds = process.env.WORLDLINEBOX_BENCH_SMOKE === '1' ? 1 : Math.max(6, 2 * Math.ceil(50 / queries.length));
  const orderedNotes = notes.map((note, index) => [diary, '[09:' + String(Math.floor(index / 60)).padStart(2, '0') + ':' + String(index % 60).padStart(2, '0') + ']\n' + note.content, note.tags.join(', ')]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await withIndexedMemory(orderedNotes, async ({ home, nodePath, config, start, queryModelCalls }) => {
    const { reference, revision } = extractOriginal(home, process.env.WORLDLINEBOX_VCP_TOOLBOX);
    const rows = [], opens = [], warmups = [];
    const models = process.env.WORLDLINEBOX_PACKAGE_ROOT ? path.join(process.env.WORLDLINEBOX_PACKAGE_ROOT, 'resources/embedding-models') : path.resolve('resources/embedding-models');
    const weights = JSON.parse(fs.readFileSync(path.join(models, 'manifest.json'), 'utf8'));
    const report = { fixtureSha256: hash(source), revision, package: path.relative(process.cwd(), memoryDir), notes: notes.length, queries: queries.length, rounds,
      runtimeSourceManifestSha256: hash(fs.readFileSync(path.join(memoryDir, 'worldlinebox-integration-manifest.json'))),
      model: weights.modelId, weightFiles: weights.files, dimension: config.dimension, threads: 4, cpu: os.cpus()[0].model, node: nodePath,
      percentileMethod: 'nearest-rank on successful attempts only; errors are counted separately',
      boundaries: { firstSeen: 'parent-to-child transport, query embedding and native readout, once per new process per distinct query',
        warmRepeat: 'same parent round-trip after the query was seen',
        preencoded: 'KnowledgeBaseManager.executeNativeRiverQuery only, original in-process timer / host production telemetry span; both exclude embedding and transport',
        guardedRepeat: 'warm parent round-trip; host includes managedSources=true and source lineage checks, official uses unguarded native reads',
        sourceDirect: 'time inside original child, embedText + retrieveDiary, excludes IPC', modelInputs: 'texts actually routed to CPU query embedding' }, opens, warmups, rows };
    const indexRoot = path.join(home, 'VectorStore');
    const fingerprint = fs.readdirSync(indexRoot, { recursive: true, withFileTypes: true }).filter(file => file.isFile()).map(file => {
      const full = path.join(file.parentPath, file.name); return [path.relative(indexRoot, full), hash(fs.readFileSync(full))];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    report.closedIndexSha256 = hash(JSON.stringify(fingerprint));
    const frozen = path.join(home, 'frozen');
    copyIndex(home, frozen);
    try {
      for (let round = 0; round < rounds; round++) {
        const root = path.join(home, 'round-' + round), rawHome = path.join(root, 'original');
        copyIndex(frozen, rawHome);
        // Retain the original physical diary files and the real workspace
        // address for managed source, ownership and withdrawal checks.
        if (round) copyIndex(frozen, home, true);
        let raw, host;
        const order = (swap) => swap ? ['host', 'official'] : ['official', 'host'];
        try {
          for (const side of order(round % 2)) {
            const before = performance.now();
            if (side === 'official') raw = await openOriginal(nodePath, reference, originalEnv(reference, rawHome, config));
            else { host = start(home); await host.request('invoke', { target: 'knowledge', method: 'listDistinctDiaries', args: [] }, { timeoutMs: 120000 }); }
            opens.push({ side, round, ms: performance.now() - before, ...(side === 'official' ? { engineOnlyMs: raw.engineOpenMs } : {}) });
          }
          async function measure(side, phase, item) {
            const beforeCalls = queryModelCalls(), before = performance.now();
            try {
              let result, elapsedMs, coreMs, rpcMs, sourceDirectMs;
              if (side === 'official') {
                const rawReply = await raw.request(phase, item.query);
                rpcMs = performance.now() - before; elapsedMs = rpcMs; sourceDirectMs = rawReply.elapsed; coreMs = rawReply.recallMs; result = rawReply.value;
              } else {
                const observe = phase === 'preencoded';
                const reply = await host.request('retrieve', { ...selections, query: item.query, managedSources: phase === 'guardedRepeat' }, { timeoutMs: 120000, withTelemetry: observe });
                rpcMs = performance.now() - before; elapsedMs = rpcMs; result = observe ? reply.result : reply;
                if (observe) coreMs = reply.telemetry.vcp.spans.find(span => span.stage === 'knowledge.river-query')?.hostTiming.durationMs;
              }
              const modelCalls = queryModelCalls() - beforeCalls;
              if (phase === 'preencoded') {
                assert.equal(modelCalls, 0, 'Preencoded arm made a new model call'); assert(Number.isFinite(coreMs)); elapsedMs = coreMs;
              }
              return { side, phase, round, queryId: item.id, elapsedMs, rpcMs, coreMs, sourceDirectMs, modelInputs: modelCalls, hits: hitList(result, notes),
                nativeJointQueryUsed: result.meta.nativeJointQueryUsed, fallbackReason: result.meta.fallbackReason, artifactSig: result.meta.artifactSig };
            } catch (error) { return { side, phase, round, queryId: item.id, elapsedMs: performance.now() - before, modelInputs: queryModelCalls() - beforeCalls, error: error.message }; }
          }
          for (const side of order(round % 2)) warmups.push(await measure(side, 'warmup', { id: 'warmup', query: '这些日记里记录了哪些日常安排？' }));
          for (const phase of ['firstSeen', 'warmRepeat', 'preencoded', 'guardedRepeat']) {
            const ordered = [...queries.slice(round), ...queries.slice(0, round)];
            for (const item of ordered) for (const side of order((queries.indexOf(item) + round + (phase === 'warmRepeat' ? 1 : 0)) % 2)) {
              rows.push(await measure(side, phase, item));
            }
          }
          fs.writeFileSync(output, JSON.stringify(report) + '\n');
          console.log('Completed matched round ' + (round + 1) + '/' + rounds + ' with ' + rows.length + ' observations.');
        } finally { await Promise.allSettled([raw?.close(), host?.close()]); fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }); }
      }
      const summary = {};
      for (const side of ['official', 'host']) {
        const sideRows = rows.filter(row => row.side === side);
        summary[side] = { coldOpen: distribution(opens.filter(row => row.side === side).map(row => row.ms)),
          quality: grade(queries, sideRows.filter(row => row.phase === 'firstSeen' && row.round === 0)) };
        for (const phase of ['firstSeen', 'warmRepeat', 'preencoded', 'guardedRepeat']) {
          const subset = sideRows.filter(row => row.phase === phase), good = subset.filter(row => !row.error);
          summary[side][phase] = { ...distribution(good.map(row => row.elapsedMs)), rpc: distribution(good.map(row => row.rpcMs)),
            ...(side === 'official' ? { sourceDirect: distribution(good.map(row => row.sourceDirectMs)) } : {}),
            attempts: subset.length, errors: subset.length - good.length, actualModelInputs: good.reduce((n, row) => n + row.modelInputs, 0),
            jointUses: good.filter(row => row.nativeJointQueryUsed).length };
        }
      }
      const pairs = new Map();
      for (const row of rows) {
        const key = row.round + '/' + row.phase + '/' + row.queryId;
        if (!pairs.has(key)) pairs.set(key, {});
        pairs.get(key)[row.side] = row;
      }
      const mismatches = [...pairs.values()].filter(({ host, official }) => host.error || official.error || host.artifactSig !== official.artifactSig ||
        JSON.stringify(host.hits) !== JSON.stringify(official.hits));
      report.summary = summary; report.pairedComparisons = pairs.size; report.pairDifferences = mismatches.map(({ host, official }) => ({ round: host.round, phase: host.phase, queryId: host.queryId, host: host.hits || host.error, official: official.hits || official.error }));
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ pairedComparisons: pairs.size, differences: mismatches.length, summary }));
      if (mismatches.length || rows.some(row => !row.nativeJointQueryUsed || row.fallbackReason)) process.exitCode = 1;
    } finally { fs.unlinkSync(path.join(reference, 'node_modules')); }
  }, { managed: true });
}
(process.argv[2] === '--original' ? originalChild(process.argv[3]) : main()).catch(error => { console.error(error); process.exitCode = 1; if (process.send) process.exit(1); });
