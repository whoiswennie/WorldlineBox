#!/usr/bin/env node
// Windows desktop acceptance check using the shipped CPU model and native worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const ts = require('typescript');

require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true, resolveJsonModule: true },
}).outputText, file);

const { startLlamaEmbeddingSession } = require('../src/main/embedding-llama-session.ts');
const { VcpEmbeddingGateway } = require('../src/main/vcp-embedding-gateway.ts');
const { formatEmbeddingSearchQuery, formatEmbeddingDocument } = require('../src/shared/embedding/profile.ts');
const root = path.resolve(__dirname, '..');
const packaged = process.env.WORLDLINEBOX_PACKAGE_ROOT && path.resolve(process.env.WORLDLINEBOX_PACKAGE_ROOT, 'resources');
const memoryDir = packaged ? path.join(packaged, 'vcp-memory') : path.join(root, '.tools', 'bot-memory-release', 'vcp-memory');
const { createSession } = require(path.join(memoryDir, 'lib', 'client.cjs'));
const modelDir = path.join(packaged || path.join(root, 'resources'), 'embedding-models');
const notes = [
  ['工程', '[09:00:00]\n数据库每天凌晨执行异地备份，恢复流程校验日志完整性。', '数据库, 容灾, 备份, 恢复, 日志, 快照, 运维'],
  ['工程', '[10:00:00]\n会议室绿植养护计划，春季换盆，冬季控制浇水频率。', '园艺, 浇水, 绿植, 花盆, 阳光, 土壤'],
  ['运营', '[11:00:00]\n客户演练需要记录变更历史并验证日志归档完整。', '运维, 日志, 容灾, 演练, 恢复, 验证, 备份'],
];
const query = '数据库备份恢复方案是什么？';
const messages = [{ role: 'system', content: '[[工程日记本]]' }, { role: 'user', content: query }];

async function checkRecall(request) {
  const recall = await request('retrieve', { query, diaries: ['工程'], k: 3, engine: 'rivermemo', fallback: 'none' });
  assert.equal(recall.meta.riverMemoUsed, true);
  assert.match(JSON.stringify(recall.results), /异地备份/);
  const prepared = await request('preprocess', {
    messages,
    options: { folding: false },
  });
  assert.match(JSON.stringify(prepared), /异地备份/);
  return { recall, messages: prepared.messages };
}

// Reopen the same closed fixture index using original upstream source. Run the
// reference in its own process so Node module caches and Vexus handles are separate.
async function runOriginal(reference, home) {
  const kb = require(path.join(reference, 'KnowledgeBaseManager.js'));
  const rag = require(path.join(reference, 'Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'));
  kb.config.apiUrl = process.env.MEMORY_DOCUMENT_API_URL;
  try {
    await kb.initialize();
    await rag.initialize(process.env, { vectorDBManager: kb });
    const bridge = rag.getContextBridge();
    const queryVector = await bridge.embedText(query);
    assert.equal(queryVector.length, 768);
    const recall = await bridge.retrieveDiary({ queryText: query, queryVector, diaryNames: ['工程'], k: 3, engine: 'rivermemo', fallback: 'none' });
    const prepared = await rag.processMessages(structuredClone(messages), process.env);
    fs.writeFileSync(path.join(home, 'original.json'), JSON.stringify({ recall, messages: prepared }));
  } finally { await rag.shutdown(); await kb.shutdown(); }
}

function extractOriginal(home, checkout) {
  const reference = path.join(home, 'original'), archive = path.join(home, 'original.tar');
  const manifest = JSON.parse(fs.readFileSync(path.join(memoryDir, 'upstream/manifest.json'), 'utf8'));
  const revision = manifest.sources.toolbox.commit;
  if (!checkout) {
    checkout = [path.resolve(root, '../vcp/VCPToolBox'), path.resolve(root, '.tools', 'vcp-toolbox-' + revision.slice(0, 7))].find(dir =>
      fs.existsSync(dir) && spawnSync('git', ['-C', dir, 'cat-file', '-e', revision + '^{commit}'], { windowsHide: true }).status === 0);
  }
  assert(checkout, 'Set WORLDLINEBOX_VCP_TOOLBOX to a checkout containing ' + revision);
  const paths = manifest.files.map(item => item.path).filter(file => !file.includes('/') || file.startsWith('modules/') ||
    file.startsWith('Plugin/RAGDiaryPlugin/') || /^rust-vexus-lite\/(?:index\.js|package\.json|vexus-lite\.win32-x64-msvc\.node)$/.test(file));
  fs.mkdirSync(reference);
  execFileSync('git', ['-C', checkout, 'archive', '--format=tar', '--output=' + archive, revision, ...paths], { windowsHide: true });
  execFileSync('tar', ['-xf', archive, '-C', reference], { windowsHide: true });
  fs.symlinkSync(path.join(memoryDir, 'node_modules'), path.join(reference, 'node_modules'), 'junction');
  return { reference, revision };
}
function originalEnv(reference, home, config) {
  const workspaceConfig = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  return { ...process.env, ...Object.fromEntries(Object.entries(workspaceConfig).map(([key, value]) => [key, String(value)])),
    PROJECT_BASE_PATH: reference, KNOWLEDGEBASE_ROOT_PATH: path.join(home, 'dailynote'),
    KNOWLEDGEBASE_STORE_PATH: path.join(home, 'VectorStore'), API_URL: config.queryBaseUrl, API_Key: config.apiKey,
    MEMORY_DOCUMENT_API_URL: config.baseUrl, VECTORDB_DIMENSION: String(config.dimension), WhitelistEmbeddingModel: config.model, EmbeddingModelSig: config.modelSignature };
}
async function compareOriginal(home, nodePath, config, expected, checkout) {
  const { reference, revision } = extractOriginal(home, checkout);
  try {
    await promisify(execFile)(nodePath, [__filename, '--original', reference, home], { windowsHide: true, timeout: 120000,
      env: originalEnv(reference, home, config) });
  } finally { fs.unlinkSync(path.join(reference, 'node_modules')); }
  const original = JSON.parse(fs.readFileSync(path.join(home, 'original.json'), 'utf8'));
  assert.equal(original.recall.meta.riverMemoUsed, true);
  const hits = result => result.recall.results.map(({ id, text, score }) => ({ id, text, score }));
  assert.deepEqual(hits(original), hits(expected));
  assert(original.recall.results.every(item => Number.isFinite(item.score) && typeof item.text === 'string'));
  const visible = result => result.messages.map(({ role, content }) => ({ role, content }));
  assert.deepEqual(visible(original), visible(expected));
  const diagnostics = ({ recall: { meta } }) => ({ engine: meta.engine, riverMemoUsed: meta.riverMemoUsed,
    nativeJointQueryUsed: meta.nativeJointQueryUsed, artifactSig: meta.artifactSig, fallbackReason: meta.fallbackReason });
  assert.deepEqual(diagnostics(original), diagnostics(expected));
  assert.equal(original.recall.meta.nativeJointQueryUsed, true);
  assert.equal(original.recall.meta.fallbackReason, null);
  const report = { revision, notes, query, engine: 'rivermemo', fallback: 'none',
    official: { diagnostics: diagnostics(original), hits: hits(original), messages: visible(original) },
    host: { diagnostics: diagnostics(expected), hits: hits(expected), messages: visible(expected) } };
  if (process.env.WORLDLINEBOX_RECALL_REPORT) {
    const file = path.resolve(process.env.WORLDLINEBOX_RECALL_REPORT);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  }
  console.log('Original and managed strict RiverMemo ranks, scores and semantic RAG messages match (' + report.host.hits.length + ' hits).');
}

async function withIndexedMemory(fixtureNotes, check, { managed = false } = {}) {
  const { resolveBotMemoryNode } = await import('./bot-memory-runtime-lib.mjs');
  const nodePath = packaged ? path.join(packaged, 'resources', 'portable-tools', 'win32-x64', 'node', 'node.exe') : await resolveBotMemoryNode(root);
  const model = await startLlamaEmbeddingSession({
    executable: path.join(modelDir, 'runtime-cpu', 'llama-server.exe'),
    files: { corePath: path.join(modelDir, 'embeddinggemma-2-UD-Q4_K_XL.gguf'), projectorPath: path.join(modelDir, 'mmproj-Q8_0.gguf') },
    gpuLayers: 0, threads: 4, pooling: 'mean', contextSize: 8192, koffiPath: require.resolve('koffi'),
  });
  const profile = { profileKey: 'vcp-acceptance-embeddinggemma-2', dimension: 768, modelName: 'embeddinggemma-2' };
  let queryModelCalls = 0;
  const gateway = new VcpEmbeddingGateway({
    resolveProfile: async () => profile,
    embed: async (texts, options) => {
      if (options.purpose === 'query') queryModelCalls += texts.length;
      const inputs = texts.map(text => options.purpose === 'query' ? formatEmbeddingSearchQuery(text) : formatEmbeddingDocument('', text));
      return { profile, vectors: await model.embedTexts(inputs, options.signal) };
    },
  });
  let home;
  let worker;
  try {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'worldline-vcp5-acceptance-'));
    const config = await gateway.configuration('global', profile);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      WhitelistEmbeddingModel: config.model, EmbeddingModelSig: config.modelSignature, VECTORDB_DIMENSION: config.dimension,
      LOCAL_EMBEDDING_ENABLED: false, TDB_KNOWLEDGE_ENABLED: true, KNOWLEDGEBASE_BATCH_WINDOW_MS: 30, KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS: 100,
    }));
    const start = (workspace = home) => createSession({
      home: workspace, nodePath, env: {
        WORLDLINEBOX_VCP_MANAGED: '1', EMBEDDING_API_URL: config.baseUrl, EMBEDDING_QUERY_API_URL: config.queryBaseUrl,
        EMBEDDING_API_KEY: config.apiKey, EMBEDDING_MODEL: config.model, EmbeddingModelSig: config.modelSignature,
      },
    });
    worker = start();
    const request = (operation, payload) => worker.request(operation, payload, { timeoutMs: 120000 });
    const managedIds = [];
    for (const [index, [folder, Content, Tag]] of fixtureNotes.entries()) {
      const receipt = managed ? await request('bot.remember', { sourceEventId: 'sample-' + index, sourceMessageIds: ['message-' + index], hostAuthor: '记录员', content: Content, tags: Tag }) :
        await request('tool', { name: 'DailyNote', args: { command: 'create', maid: '工程师', folder, Date: '2026-11-26', Content, Tag } });
      assert.notEqual(receipt.status, 'error', JSON.stringify(receipt));
      if (managed) managedIds.push(receipt.id);
    }
    await request('sync', {});
    for (const id of managedIds) {
      const receipts = await request('bot.sync', { id });
      assert.equal(receipts[0]?.state ?? receipts.receipts?.[0]?.state, 'indexed');
    }
    const job = await request('invoke', { target: 'knowledge', method: 'requestActiveFullTraining', args: [{}] });
    const deadline = Date.now() + 180000;
    for (;;) {
      const state = await request('invoke', { target: 'training', method: 'getTrainingStatus', args: [] });
      if (state.taskId === job.taskId && state.finishedAt) {
        assert.equal(state.status, 'completed', JSON.stringify(state));
        break;
      }
      if (Date.now() >= deadline) throw new Error('VCP native training timed out');
      await delay(500);
    }
    if (check) {
      await worker.close(); worker = undefined;
      return await check({ home, nodePath, config, start, queryModelCalls: () => queryModelCalls });
    }
    await checkRecall(request);
    await worker.close();
    worker = start();
    const restored = await checkRecall(request);
    if (process.env.WORLDLINEBOX_VCP_TOOLBOX) {
      await worker.close(); worker = undefined;
      await compareOriginal(home, nodePath, config, restored, process.env.WORLDLINEBOX_VCP_TOOLBOX);
    }
    console.log('Verified strict RiverMemo retrieval and history preprocessing before and after restart with the bundled 768-dimensional model.');
  } finally {
    try { await worker?.close(); } finally {
      try { await Promise.all([gateway.close(), model.close()]); }
      finally { if (home) fs.rmSync(home, { recursive: true, force: true }); }
    }
  }
}

const original = process.argv[2] === '--original';
module.exports = { withIndexedMemory, extractOriginal, originalEnv, memoryDir };
if (require.main === module) (original ? runOriginal(process.argv[3], process.argv[4]) : withIndexedMemory(notes)).then(() => { if (original) process.exit(0); })
  .catch(error => { console.error(error); process.exitCode = 1; if (original) process.exit(1); });
