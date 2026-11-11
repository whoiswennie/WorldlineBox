'use strict';
// Original plugins log to console. Keep stdout a strict machine-readable protocol.
const util = require('node:util');
for (const key of ['log', 'info', 'debug', 'warn', 'error']) {
  console[key] = (...args) => process.stderr.write(util.format(...args) + '\n');
}
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const workspace = require('./workspace.cjs');
const callerEnv = { ...process.env };
const callerCwd = process.cwd();
let runtime, unlock, providerRouter, localEmbedding, chatMemory, botHost;
let activeDiagnostics = false, lastTelemetry, requestStartedAt;
function send(value) { process.stdout.write('\x1eVCP_MEMORY_JSON:' + JSON.stringify(value) + '\n'); }
async function hostStage(stage, operation) {
  if (!lastTelemetry) return operation();
  const startedAt = performance.now();
  const record = { stage, source: 'standalone host boundary', startedAtMs: startedAt, status: 'running' };
  lastTelemetry.host.stages.push(record);
  try { const result = await operation(); record.status = 'success'; return result; }
  catch (error) { record.status = 'error'; throw error; }
  finally { record.durationMs = performance.now() - startedAt; }
}
async function close() {
  const startedAt = performance.now();
  const tracedRuntime = runtime, tracedProvider = providerRouter, tracedChat = chatMemory;
  const runtimeDir = runtime?.runtimeDir;
  const errors = [];
  if (botHost) { try { botHost.close(); } catch (error) { errors.push(error.message); } botHost = null; }
  for (const object of [chatMemory, runtime, providerRouter, localEmbedding]) {
    try { if (object) await object.close(); } catch (error) { errors.push(error.message); }
  }
  runtime = null; providerRouter = null; localEmbedding = null; chatMemory = null;
  if (lastTelemetry) {
    lastTelemetry.host.shutdownDurationMs = performance.now() - startedAt;
    lastTelemetry.host.totalDurationMs = performance.now() - requestStartedAt;
    if (tracedRuntime?.finishTrace) lastTelemetry.vcp = tracedRuntime.finishTrace();
    if (tracedProvider?.getDiagnostics) lastTelemetry.providerTransport = tracedProvider.getDiagnostics();
    if (tracedChat?.finishTrace) lastTelemetry.chat = tracedChat.finishTrace();
  }
  if (runtimeDir) for (const filename of Object.keys(require.cache)) {
    if (filename.startsWith(runtimeDir + path.sep)) delete require.cache[filename];
  }
  if (unlock) { unlock(); unlock = null; }
  if (errors.length) throw new Error(errors.join('; '));
}
async function executeCore({ operation, payload = {}, home: requestedHome }) {
  const home = workspace.resolveHome(requestedHome);
  if (operation === 'init') return workspace.initHome(home, payload);
  if (operation === 'verify') return workspace.verifyUpstream({ all: true });
  if (operation === 'catalog') {
    const callable = new Set(['DailyNote', 'DailyNoteManager', 'DailyNoteSearcher', 'LightMemo', 'AgentDream', 'MagiAgent', 'SemanticGroupEditor']);
    const directory = path.join(workspace.ROOT, 'upstream', 'toolbox', 'Plugin');
    const catalog = [];
    for (const plugin of fs.readdirSync(directory)) {
      const file = ['plugin-manifest.json', 'plugin-manifest.json.block'].map(name => path.join(directory, plugin, name)).find(fs.existsSync);
      if (!file) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      catalog.push({ name: manifest.name, description: manifest.description,
        type: manifest.pluginType, callable: callable.has(manifest.name),
        entry: callable.has(manifest.name) ? 'tool' : ['RAGDiaryPlugin','ContextFoldingV2','MemoryThinkingTray','OneRing','VCPTimeLine'].includes(manifest.name) ? 'preprocess / invoke' : 'upstream fixture or preserved host component',
        capabilities: manifest.capabilities, configSchema: manifest.configSchema });
    }
    for (const name of ['DeepMemo', 'TopicMemo']) {
      const manifest = JSON.parse(fs.readFileSync(path.join(workspace.ROOT, 'upstream', 'chat', 'VCPDistributedServer', 'Plugin', name, 'plugin-manifest.json'), 'utf8'));
      catalog.push({ name, description: manifest.description, type: manifest.pluginType, callable: true, entry: 'tool',
        capabilities: manifest.capabilities, configSchema: manifest.configSchema });
    }
    return catalog;
  }
  const config = workspace.readConfig(home);
  const bot = () => {
    if (!botHost) botHost = new (require('./bot-host.cjs').BotHost)(home);
    return botHost;
  };
  if (['search', 'preprocess', 'context.prepare'].includes(operation) || operation === 'tool' && ['LightMemo', 'DeepMemo', 'TopicMemo'].includes(payload.name)) {
    if (!unlock) unlock = workspace.acquireLock(home);
    bot().managed.assertReadable();
    bot().maintenance.assertReadable();
  }
  if (operation === 'bot.sources.withdraw') {
    if (!unlock) unlock = workspace.acquireLock(home);
    // Durable intent precedes native initialization. Even a failed native
    // startup must leave subsequent managed reads fenced until repair.
    bot().stageWithdrawal(payload);
  }
  if (operation === 'bot.history.append') {
    if (!unlock) unlock = workspace.acquireLock(home);
    const result = await bot().appendHistory(payload);
    chatMemory?.markTopicsDirty(payload.companionId, result.appended.map(item => item.episode)); return result;
  }
  if (operation === 'bot.status') return bot().status();
  if (operation === 'bot.list') return bot().list();
  if (operation === 'bot.catalog') return bot().catalog(payload);
  if (operation === 'bot.maintenance.work') {
    if (!unlock) unlock = workspace.acquireLock(home);
    if (!['stats','claim','complete','release','seed','associate','identity'].includes(payload.action)) throw new TypeError('Unknown maintenance work action.');
    return bot().maintenanceWork[payload.action](payload);
  }
  if (operation === 'bot.note.read') return bot().readNote(payload);
  if (operation === 'bot.operation.get') return bot().operationReceipt(payload);
  if (operation === 'bot.remember.receipt') return bot().rememberReceipt(payload);
  if (operation === 'bot.tombstones') return bot().tombstones();
  if (operation === 'bot.source.filter') return bot().filterSources(payload);
  if (operation === 'bot.prepared.get') { bot().assertWithdrawalsSettled(); return bot().getPrepared(payload.id); }
  if (operation === 'bot.prepared.put') return bot().savePrepared(payload.id, payload.prepared);
  if (operation === 'bot.prepared.complete') return bot().completePrepared(payload.id, payload.completion);
  if (['tool','search','preprocess','response','session.prepare','invoke'].includes(operation) && fs.existsSync(path.join(home, 'bot-adapter.sqlite'))) bot().assertWithdrawalsSettled();
  if (operation === 'config.get') return workspace.sanitizedConfig(config);
  if (operation === 'config.set') {
    if (unlock) await close();
    const release = workspace.acquireLock(home);
    try { return workspace.configSet(home, payload.key, payload.value); } finally { release(); }
  }
  if (operation === 'backup') {
    if (unlock) await close();
    const release = workspace.acquireLock(home);
    try { return workspace.backup(home, payload.label); } finally { release(); }
  }
  if (operation === 'doctor') {
    return require('./integrity.cjs').inspectSnapshot({ root: workspace.ROOT,
      key: callerEnv.WORLDLINEBOX_VCP_INTEGRITY_KEY, seal: payload.integritySeal,
      verify: () => workspace.verifyUpstream() }, snapshot => {
    const native = require('../upstream/toolbox/rust-vexus-lite');
    const index = new native.VexusIndex(Number(config.VECTORDB_DIMENSION), 16);
    const storage = new native.NativeKnowledgeRuntime(index);
    let capabilities;
    try { capabilities = storage.capabilities(); } finally { storage.shutdown(); }
    const { resolveProviders } = require('./providers.cjs');
    const routes = resolveProviders({ ...callerEnv, ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== '' && value !== null && value !== undefined)) });
    const local = config.LOCAL_EMBEDDING_ENABLED === true || config.LOCAL_EMBEDDING_ENABLED === 'true';
    return { home, node: process.version, platform: process.platform, architecture: process.arch,
      snapshot, native: capabilities,
      embeddingConfigured: local || Boolean(routes.embedding.baseURL),
      localEmbedding: local ? { enabled: true, installed: fs.existsSync(path.join(config.LOCAL_EMBEDDING_BUNDLE || path.join(workspace.ROOT, 'vendor', 'local-embedding'), 'manifest.json')), dimension: 768 } : { enabled: false },
      chat: { api: routes.chat.api, model: routes.chat.model, credentialsPresent: Boolean(routes.chat.key) },
      embeddingModel: config.WhitelistEmbeddingModel, dimension: config.VECTORDB_DIMENSION,
      externalValidation: 'Run probe to verify configured providers; doctor checks local prerequisites only.' };
    });
  }
  if (operation === 'runtime-upgrade') {
    if (unlock) await close();
    const release = unlock ? () => {} : workspace.acquireLock(home);
    try {
      const saved = workspace.backup(home, 'before-runtime-upgrade');
      const marker = path.join(home, 'runtime', '.snapshot-version');
      // Do not replace mutable plugin settings/caches. Replace only known source files.
      const manifest = JSON.parse(fs.readFileSync(path.join(workspace.ROOT, 'upstream', 'manifest.json'), 'utf8'));
      for (const file of manifest.files.filter(file => file.project === 'toolbox')) {
        if (file.path.startsWith('tests/') || file.path.startsWith('docs/')) continue;
        const target = path.resolve(home, 'runtime', file.path);
        if (!target.startsWith(path.resolve(home, 'runtime') + path.sep)) throw new Error('Invalid manifest path');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(workspace.ROOT, 'upstream', 'toolbox', file.path), target);
      }
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
      workspace.stageRuntime(home);
      return { ...saved, upgraded: true };
    } finally { release(); }
  }
  if (operation.startsWith('session.') || operation.startsWith('context.')) {
    payload = { ...payload, options: { attachmentBaseDirectory: callerCwd, ...(payload.options || {}) } };
    const context = require('./context.cjs');
    if (typeof context.dispatch !== 'function') throw new Error('Context adapter dispatch is not available');
    const release = unlock ? () => {} : workspace.acquireLock(home);
    let temporaryRouter;
    try {
      if (['context.compact', 'context.auto-compact', 'session.compact', 'session.auto-compact'].includes(operation)
          && !payload.settings?.vcpServerUrl && !Object.hasOwn(payload, 'response') && !Object.hasOwn(payload.options || {}, 'response')) {
        const router = providerRouter || (temporaryRouter = await require('./providers.cjs').startProviderRouter({ ...callerEnv,
          ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== '' && value !== null && value !== undefined)) }));
        payload = { ...payload, settings: { enableContextCompaction: true,
          contextCompactionModel: config.CHAT_MODEL || 'deepseek-flash', ...(payload.settings || {}),
          vcpServerUrl: router.url + '/v1/chat/completions', vcpApiKey: router.key } };
      }
      const result = await context.dispatch(operation, payload, { home });
      if (operation.startsWith('session.') && !['session.get','session.list','session.inspect','session.prepare'].includes(operation)) chatMemory?.markDirty();
      return result;
    } finally {
      if (temporaryRouter) {
        if (lastTelemetry) lastTelemetry.providerTransport = temporaryRouter.getDiagnostics?.();
        await temporaryRouter.close();
      }
      release();
    }
  }
  if (operation === 'tool' && ['DeepMemo', 'TopicMemo'].includes(payload.name)) {
    if (!chatMemory) {
      if (!unlock) unlock = workspace.acquireLock(home);
      const { ChatMemory } = require('./chat-memory.cjs');
      chatMemory = new ChatMemory({ home, config });
      chatMemory.startTrace?.({ enabled: activeDiagnostics });
      await chatMemory.start();
    }
    return chatMemory.callTool(payload.name, payload.args || {}, payload.context || {});
  }
  if (!runtime) {
    if (!unlock) unlock = workspace.acquireLock(home);
    const runtimeDir = await hostStage('sourceSnapshot.stage', () => workspace.stageRuntime(home));
    process.chdir(runtimeDir);
    workspace.applyEnvironment(home, config, runtimeDir);
    const providerConfig = { ...callerEnv, ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== '' && value !== null && value !== undefined)) };
    if (config.LOCAL_EMBEDDING_ENABLED === true || config.LOCAL_EMBEDDING_ENABLED === 'true') {
      const { startLocalEmbedding } = require('./local-embedding.cjs');
      localEmbedding = await hostStage('localEmbedding.start', () => startLocalEmbedding(config));
      Object.assign(providerConfig, { EMBEDDING_API_URL: localEmbedding.documentUrl,
        EMBEDDING_QUERY_API_URL: localEmbedding.queryUrl,
        EMBEDDING_API_KEY: localEmbedding.apiKey, EMBEDDING_MODEL: localEmbedding.model });
      if (Number(config.VECTORDB_DIMENSION) !== localEmbedding.dimension) throw new Error(`Local model dimension ${localEmbedding.dimension} does not match workspace dimension ${config.VECTORDB_DIMENSION}`);
      process.env.EmbeddingModelSig = localEmbedding.modelSignature;
    }
    const { startProviderRouter } = require('./providers.cjs');
    providerRouter = await hostStage('providerRouter.start', () => startProviderRouter(providerConfig));
    Object.assign(process.env, { API_URL: providerRouter.queryUrl, API_Key: providerRouter.key,
      MEMORY_DOCUMENT_API_URL: providerRouter.url,
      MEMORY_CHAT_API_URL: providerRouter.url, MEMORY_CHAT_API_KEY: providerRouter.key });
    // Route all built-in summarizers through the selected chat provider.
    process.env.AIMemoUrl = config.AIMemoUrl || callerEnv.AIMemoUrl || providerRouter.url + '/';
    process.env.AIMemoApi = config.AIMemoApi || callerEnv.AIMemoApi || providerRouter.key;
    process.env.AIMemoModel = config.AIMemoModel || callerEnv.AIMemoModel || config.CHAT_MODEL || 'deepseek-flash';
    const { MemoryRuntime } = require('./runtime.cjs');
    runtime = new MemoryRuntime({ runtimeDir, home, config: { ...config, API_URL: process.env.API_URL, API_Key: process.env.API_Key } });
    runtime.startTrace?.({ enabled: activeDiagnostics });
    const vectorOperation = !['tool', 'preprocess', 'status', 'response', 'probe-chat', 'embed'].includes(operation) || payload.vectors === true;
    await hostStage('memoryRuntime.start', () => runtime.start({ vectors: vectorOperation }));
  }
  switch (operation) {
    case 'tool': {
      return runtime.callTool(payload.name, payload.args || {}, payload.context || {});
    }
    case 'search': return runtime.search(payload.query, payload.options || {});
    case 'bot.remember': return bot().remember(runtime, payload);
    case 'bot.update': return bot().update(runtime, payload);
    case 'bot.organize': return bot().organize(runtime, payload);
    case 'bot.dream.recall': return bot().maintenance.dreamRecall(runtime, payload);
    case 'bot.maintenance.insight': return bot().maintenance.insight(runtime, payload);
    case 'bot.maintenance.archive': return bot().maintenance.archive(runtime, payload);
    case 'bot.sync': return bot().sync(runtime, payload);
    case 'bot.repair': {
      const result = await bot().repairWithdrawals(runtime, payload.companionId);
      if (chatMemory && result.changedEpisodes.length) { chatMemory.markTopicsDirty(payload.companionId, result.changedEpisodes); await chatMemory.sync(); }
      if (result.withdrawalPending) bot().completeWithdrawal();
      return result;
    }
    case 'bot.forget': {
      const result = await bot().forget(runtime, payload);
      if (chatMemory && result.changedEpisodes.length) { chatMemory.markTopicsDirty(payload.companionId, result.changedEpisodes); await chatMemory.sync(); }
      if (result.withdrawalPending) bot().completeWithdrawal();
      return result;
    }
    case 'bot.sources.withdraw': {
      const result = await bot().withdrawSources(runtime, payload);
      if (chatMemory && result.changedEpisodes.length) { chatMemory.markTopicsDirty(payload.companionId, result.changedEpisodes); await chatMemory.sync(); }
      if (result.withdrawalPending) bot().completeWithdrawal();
      return result;
    }
    case 'preprocess': return runtime.preprocess(payload.messages, payload.options || {});
    case 'response': return runtime.recordResponse(payload);
    case 'sync': await runtime.sync(); return runtime.status();
    case 'status': return { ...await runtime.status(), routes: providerRouter.capabilities,
      localEmbedding: localEmbedding?.status(), chatMemory: chatMemory ? await chatMemory.status() : undefined };
    case 'invoke': return runtime.invoke(payload);
    case 'probe': {
      await runtime.start({ vectors: true });
      const vector = await runtime.rag.getSingleEmbeddingCached(payload.text || 'VCP memory embedding capability probe');
      if (!vector || vector.length !== Number(config.VECTORDB_DIMENSION) || !Array.from(vector).every(Number.isFinite)) {
        throw new Error('Embedding service returned invalid or mismatched dimensions');
      }
      return { model: config.WhitelistEmbeddingModel, dimension: vector.length, valid: true };
    }
    case 'probe-chat': {
      const response = await fetch(providerRouter.url + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + providerRouter.key },
        body: JSON.stringify({ model: config.CHAT_MODEL || 'deepseek-flash', stream: false, max_tokens: 256,
          thinking: { type: 'disabled' }, messages: [{ role: 'user', content: payload.text || 'Reply with only: VCP memory connected' }] }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error?.message || 'Chat provider request failed');
      return { model: data.model || config.CHAT_MODEL, content: data.choices?.[0]?.message?.content, usage: data.usage };
    }
    case 'embed': {
      if (!localEmbedding) throw new Error('embed requires LOCAL_EMBEDDING_ENABLED=true');
      let vectors;
      switch (payload.type || 'text') {
        case 'text': vectors = await localEmbedding.embed(payload.texts || [payload.text], { purpose: payload.purpose || 'document' }); break;
        case 'image': vectors = [await localEmbedding.embedImage(path.resolve(payload.path))]; break;
        case 'audio': vectors = [await localEmbedding.embedAudio(path.resolve(payload.path))]; break;
        default: throw new Error('embed supports text, image, and audio file input; video payloads are available via the local-embedding Node API');
      }
      return { model: localEmbedding.model, dimension: localEmbedding.dimension, vectors };
    }
    default: throw new Error(`Unknown operation: ${operation}`);
  }
}
async function execute(request) {
  activeDiagnostics = request.diagnostics === true;
  requestStartedAt = performance.now();
  lastTelemetry = activeDiagnostics ? { schema: 'vcp-cli-diagnostics-v1', operation: request.operation,
    host: { clock: 'performance.now', measurement: 'host boundary wall time; not a VCP score; nested durations overlap', stages: [] },
    vcp: null, chat: null, providerTransport: null } : undefined;
  runtime?.startTrace?.({ enabled: activeDiagnostics });
  chatMemory?.startTrace?.({ enabled: activeDiagnostics });
  providerRouter?.resetDiagnostics?.();
  try { return await executeCore(request); }
  finally {
    if (lastTelemetry) {
      lastTelemetry.host.executionDurationMs = performance.now() - requestStartedAt;
      if (runtime?.finishTrace) lastTelemetry.vcp = runtime.finishTrace();
      if (providerRouter?.getDiagnostics) lastTelemetry.providerTransport = providerRouter.getDiagnostics();
      if (chatMemory?.finishTrace) lastTelemetry.chat = chatMemory.finishTrace();
    }
  }
}
function envelope(error) {
  return { ok: false, error: { code: error.code || 'VCP_MEMORY_ERROR', message: error.message } };
}
async function main() {
  if (process.argv.includes('--serve')) {
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let sessionHome;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        lastTelemetry = undefined;
        let request;
        try {
          request = JSON.parse(line);
          const requested = workspace.resolveHome(request.home);
          if (sessionHome && requested !== sessionHome) throw new Error('A serve process is bound to one memory workspace');
          sessionHome = requested;
          const result = await execute(request);
          send({ id: request.id, ok: true, result, ...(lastTelemetry ? { telemetry: lastTelemetry } : {}) });
        } catch (error) {
          if (!runtime?.started) { try { await close(); } catch {} }
          send({ id: request?.id, ...envelope(error), ...(lastTelemetry ? { telemetry: lastTelemetry } : {}) });
        }
      }
    } finally { await close(); }
  } else {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    let result;
    try { result = { ok: true, result: await execute(JSON.parse(input)) }; }
    catch (error) { result = envelope(error); process.exitCode = 1; }
    try { await close(); } catch (error) { result = envelope(error); process.exitCode = 1; }
    send({ ...result, ...(lastTelemetry ? { telemetry: lastTelemetry } : {}) });
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await close(); process.exit(130); });
main().then(() => { process.exit(process.exitCode || 0); }, async error => {
  try { await close(); } catch {}
  send(envelope(error)); process.exit(1);
});
