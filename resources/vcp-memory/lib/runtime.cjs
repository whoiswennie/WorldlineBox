'use strict';

// The host owns lifecycle and transport only. All retrieval, ranking, storage,
// placeholder and memory algorithms run in the preserved upstream modules.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { TelemetryCollector, attachKnowledge, attachPlugin, attachCold, requestSummary } = require('./telemetry.cjs');
const { waitForIndex } = require('./index-wait.cjs');
const { prepareManagedIngestionScheduler } = require('./ingestion-scheduler.cjs');
const { enableSingletonChunkRecovery } = require('./warped-chunk-recovery.cjs');
const { atomicJson } = require('./workspace.cjs');

const TOOLS = Object.freeze({
  DailyNote: 'Plugin/DailyNote/dailynote.js',
  DailyNoteManager: 'Plugin/DailyNoteManager/daily-note-manager.js',
  DailyNoteSearcher: 'Plugin/DailyNoteSearcher/DailyNoteSearcher.js',
  LightMemo: 'Plugin/LightMemo/LightMemo.js',
  AgentDream: 'Plugin/AgentDream/AgentDream.js',
  MagiAgent: 'Plugin/MagiAgent/MagiAgent.js',
});
const ADVANCED = Object.freeze({
  training: ['getTrainingStatus'],
  timeline: ['readConfig', 'saveConfig', 'listAgents', 'getAgentDetail', 'listTimelineFiles', 'generateTimelines', 'generateSummaries', 'saveTimelineFile', 'saveSummary', 'discoverMemories'],
  oneringMemo: ['readMemo', 'updateMemoText', 'listAgentNames', 'generateMemo', 'startGeneration', 'getGenerationStatus', 'isGenerating'],
  knowledge: ['listDistinctDiaries', 'getDiaryChunkCount', 'getDiaryDateIndex', 'getMemoryProfile', 'getTagConsistencyPreviewStatus', 'startTagConsistencyPreview', 'previewTagConsistency', 'applyTagConsistencyPreview', 'requestActiveFullTraining', 'recomputeGeometry', 'getEPAAnalysis', 'getTagMemoArtifactSnapshot', 'getTagMemoV10ArtifactSnapshot', 'getRiverMemoArtifactSnapshot'],
  cold: ['listLibraries', 'search', 'reachable', 'subgraph', 'queryTql', 'pelorusRequest', 'compactLibrary', 'closeLibrary', 'getMemoryProfile'],
  rag: ['getCacheStats', 'getDiaryContent', 'getSingleEmbeddingCached'],
  dream: ['triggerDream', 'getDreamConfig', 'getDreamAgents', 'getDreamLogs', 'tryTriggerDreamFromSleep'],
});

function transferMetadata(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before === after) return after;
  for (const key of Reflect.ownKeys(before)) {
    if (typeof key === 'string' && /^(?:length|\d+)$/.test(key)) continue;
    if (!Object.hasOwn(after, key)) Object.defineProperty(after, key, Object.getOwnPropertyDescriptor(before, key));
  }
  return after;
}
function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
  return content?.text || '';
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class MemoryRuntime {
  constructor({ runtimeDir, home, config = {} }) {
    if (!runtimeDir || !home) throw new TypeError('runtimeDir and home are required');
    this.runtimeDir = path.resolve(runtimeDir);
    this.home = path.resolve(home);
    this.config = config;
    this.modules = new Map();
    this.events = [];
    this.pendingMagi = new Set();
    this.closed = false;
    this.started = false;
    this.vectorReady = false;
    this.localKey = crypto.randomBytes(32).toString('hex');
    this.pushVcpInfo = event => { this.events.push(event); if (this.events.length > 200) this.events.shift(); };
    this.dependencies = { vcpLogFunctions: { pushVcpInfo: this.pushVcpInfo }, sendVcpLog: this.pushVcpInfo };
    this.runtimeConfig = { ...process.env, ...(config.env || config), PROJECT_BASE_PATH: this.runtimeDir };
    this.telemetry = new TelemetryCollector();
    for (const method of ['start','search','preprocess','sync','callTool','invoke','recordResponse','_expandVariables','_completeModel','close']) {
      this.telemetry.wrap(this, method, { stage: `host.${method}`, source: `lib/runtime.cjs#${method}`, output: false,
        input: method === 'search' ? requestSummary : method === 'callTool' ? args => ({ name: args[0], args: args[1] }) : undefined });
    }
  }

  startTrace(options = {}) {
    this.telemetry.start(options);
    this._attachTraceModules();
  }

  finishTrace() { return this.telemetry.finish(); }

  _attachTraceModules() {
    if (this.kb) attachKnowledge(this.telemetry, this.kb);
    if (this.cold) attachCold(this.telemetry, this.cold);
    for (const [name, plugin] of this.modules) {
      if (!['KnowledgeBaseManager','TDBKnowledge'].includes(name)) attachPlugin(this.telemetry, name, plugin);
    }
  }

  _require(relative) { return require(path.join(this.runtimeDir, relative)); }

  async start({ vectors = true } = {}) {
    if (this.closed) throw new Error('This runtime is closed; create a new isolated worker');
    if (!this.started) {
      await fsp.mkdir(path.join(this.home, 'dailynote'), { recursive: true });
      this._installPluginHost();
      this.dailyNote = this._require(TOOLS.DailyNote);
      attachPlugin(this.telemetry, 'DailyNote', this.dailyNote);
      await this.dailyNote.initialize(this.runtimeConfig, this.dependencies);
      this.modules.set('DailyNote', this.dailyNote);
      this.started = true;
    }
    if (vectors && !this.vectorReady) {
      if (!this.vectorStartPromise) this.vectorStartPromise = this._startVectors();
      try { await this.vectorStartPromise; } finally { this.vectorStartPromise = null; }
    }
    return this.status();
  }

  _installPluginHost() {
    const filename = path.join(this.runtimeDir, 'Plugin.js');
    this.previousPluginCache = require.cache[filename];
    const host = {
      messagePreprocessors: new Map(),
      plugins: new Map(),
      getIndividualPluginDescriptions: () => this.toolDescriptions || new Map(),
      getAllPlaceholderValues: () => this.staticPlaceholders || new Map(),
      getResolvedPluginConfigValue: (_name, key) => this.runtimeConfig[key],
      getVCPLogFunctions: () => this.dependencies.vcpLogFunctions,
      processToolCall: (name, args) => this.callTool(name, args),
      executePlugin: (name, args) => this.callTool(name, args),
    };
    require.cache[filename] = { id: filename, filename, loaded: true, exports: host };
    this.pluginHost = host;
    this.toolDescriptions = new Map();
    this.staticPlaceholders = new Map();
    for (const name of [...Object.keys(TOOLS), 'SemanticGroupEditor']) {
      const file = path.join(this.runtimeDir, 'Plugin', name, 'plugin-manifest.json');
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      host.plugins.set(name, manifest);
      const descriptions = (manifest.capabilities?.invocationCommands || []).filter(command => command.description).map(command =>
        `- ${manifest.displayName} (${manifest.name}) - 命令: ${command.command || 'N/A'}:\n${command.description.split('\n').map(line => `    ${line}`).join('\n')}`
        + (command.example ? `\n  调用示例:\n${command.example.split('\n').map(line => `    ${line}`).join('\n')}` : ''));
      if (descriptions.length) this.toolDescriptions.set(`VCP${manifest.name}`, descriptions.join('\n\n'));
    }
  }

  async _startVectors() {
    this.ingestionScheduler = prepareManagedIngestionScheduler(this.runtimeDir);
    this.kb = this._require('KnowledgeBaseManager.js');
    this.modules.set('KnowledgeBaseManager', this.kb);
    this.kb.config.apiUrl = process.env.MEMORY_DOCUMENT_API_URL || this.kb.config.apiUrl;
    if (this.runtimeConfig.WORLDLINEBOX_VCP_MANAGED === '1') {
      // A new notebook has vectors before its tags have sufficient joint
      // coverage. V5 can raise here while preparing the observation, before
      // its built-in degraded readout. Keep the same scoped query vector and
      // mark that readout explicitly for the RAG formatter and diagnostics.
      const nativeQuery = this.kb.executeNativeRiverQuery.bind(this.kb);
      this.kb.executeNativeRiverQuery = async (query, options) => {
        try { return await nativeQuery(query, options); }
        catch (error) {
          if (!/warped insufficient joint coverage/i.test(error.message) || options.fallbackToLegacy === false) throw error;
          const results = await this.kb.searchKnn(options.diaryNames, query.vector, options.topK, options);
          return { results, diagnostics: { reason: 'insufficient-joint-coverage', degraded: true, retrievalEngine: 'warped_ann' } };
        }
      };
      enableSingletonChunkRecovery(this.kb);
    }
    attachKnowledge(this.telemetry, this.kb);
    await this.kb.initialize();
    attachKnowledge(this.telemetry, this.kb);
    this.cold = this._require('TDBKnowledge.js');
    this.modules.set('TDBKnowledge', this.cold);
    this.cold.config.apiUrl = process.env.MEMORY_DOCUMENT_API_URL || this.cold.config.apiUrl;
    attachCold(this.telemetry, this.cold);
    await this.cold.initialize();
    this.jev = this._require('modules/jevClient.js');
    Object.assign(this.dependencies, {
      knowledgeBaseManager: this.kb, vectorDBManager: this.kb, tdbKnowledgeManager: this.cold, jevClient: this.jev,
      getTimelineService: () => this.modules.get('VCPTimeLine'),
      isTimelineManagedByRag: () => true,
    });
    this.dailyNote.setDependencies(this.dependencies);
    this.rag = this._require('Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');
    this.modules.set('RAGDiaryPlugin', this.rag);
    attachPlugin(this.telemetry, 'RAGDiaryPlugin', this.rag);
    await this.rag.initialize(this.runtimeConfig, this.dependencies);
    Object.assign(this.dependencies, {
      contextBridge: this.rag.getContextBridge(),
      aiMemoBridge: this.rag.getAIMemoBridge(),
      getSingleEmbedding: this.rag.getSingleEmbeddingCached.bind(this.rag),
      getBatchEmbeddings: this.rag.getBatchEmbeddingsCached.bind(this.rag),
    });
    this.cold.search = async (queryText, options = {}) => {
      if (!this.cold.initialized) return [];
      const queryVector = await this.rag.getSingleEmbeddingCached(queryText);
      return queryVector ? this.cold.searchWithVector(queryVector, queryText, options) : [];
    };
    attachCold(this.telemetry, this.cold);
    for (const name of ['VCPTimeLine', 'ContextFoldingV2']) {
      const existing = this.modules.get(name);
      if (existing) existing.contextBridge = this.dependencies.contextBridge;
    }
    this.pluginHost.messagePreprocessors.set('RAGDiaryPlugin', this.rag);
    this.vectorReady = true;
    return this.kb;
  }

  async _contextPlugin(name) {
    if (name === 'ContextFoldingV2' || name === 'VCPTimeLine') await this.start({ vectors: true });
    if (this.modules.has(name)) {
      const existing = this.modules.get(name);
      if (this.dependencies.contextBridge && Object.hasOwn(existing, 'contextBridge')) existing.contextBridge = this.dependencies.contextBridge;
      return existing;
    }
    const relative = {
      OneRing: 'Plugin/OneRing/OneRing.js', VCPTimeLine: 'Plugin/VCPTimeLine/VCPTimeLine.js',
      ContextFoldingV2: 'Plugin/ContextFoldingV2/ContextFoldingV2.js',
      MemoryThinkingTray: 'Plugin/MemoryThinkingTray/MemoryThinkingTray.js',
    }[name];
    if (!relative) throw new Error(`Unknown context plugin: ${name}`);
    let pluginConfig = this.runtimeConfig;
    if (name === 'OneRing' || name === 'VCPTimeLine') {
      if (this.runtimeConfig.WORLDLINEBOX_VCP_MANAGED === '1') {
        // Summary plugins send text completions only. Route them directly to
        // the companion model, so background jobs cannot execute diary tools
        // or recursively alter the foreground conversation's RAG context.
        pluginConfig = { ...this.runtimeConfig, PORT: new URL(process.env.MEMORY_CHAT_API_URL).port,
          Key: process.env.MEMORY_CHAT_API_KEY, ONERING_USER_NAME: this.runtimeConfig.ONERING_USER_NAME || '用户' };
      } else await this._ensureModelBridge();
    }
    if (name === 'OneRing') {
      // The memo expander clones the message array after OneRing attaches its
      // durable turn receipt. Carry that receipt through the clone for replies.
      const memo = this._require('Plugin/OneRing/OneRingMemo.js');
      const injectMemo = memo.injectMemo;
      memo.injectMemo = messages => transferMetadata(messages, injectMemo(messages));
    }
    if (this.runtimeConfig.WORLDLINEBOX_VCP_MANAGED === '1' && ['OneRing', 'VCPTimeLine'].includes(name)) {
      const file = path.join(this.runtimeDir, 'Plugin', name, name === 'OneRing' ? 'OneRingConfig.json' : 'config.json');
      const saved = fs.existsSync(file) ? JSON.parse(await fsp.readFile(file, 'utf8')) : {};
      const model = this.runtimeConfig.CHAT_MODEL || '';
      const effective = name === 'OneRing'
        ? { ...saved, memo: { ...saved.memo, model, autoGenerate: Boolean(model) } }
        : { ...saved, model, autoSync: { ...saved.autoSync, enabled: Boolean(model), agents: ['Companion'] } };
      if (JSON.stringify(saved) !== JSON.stringify(effective)) atomicJson(file, effective);
    }
    const plugin = this._require(relative);
    if (name === 'VCPTimeLine' && this.diaryAuthors) {
      const validAuthors = plugin._getValidAuthorNames.bind(plugin);
      plugin._getValidAuthorNames = agent => agent === 'Companion' ? new Set([...validAuthors(agent), ...this.diaryAuthors()]) : validAuthors(agent);
    }
    this.modules.set(name, plugin);
    attachPlugin(this.telemetry, name, plugin);
    await plugin.initialize(pluginConfig, this.dependencies);
    this.pluginHost.messagePreprocessors.set(name, plugin);
    return plugin;
  }

  async _tool(name) {
    if (this.modules.has(name)) return this.modules.get(name);
    if (!Object.hasOwn(TOOLS, name)) throw new Error(`Unsupported memory tool: ${name}`);
    if (['LightMemo', 'AgentDream', 'DailyNoteManager'].includes(name)) {
      // DailyNoteManager requires the KB singleton even for list/organize, but
      // only associate consumes vector retrieval.
      if (name !== 'DailyNoteManager') await this.start({ vectors: true });
    }
    if (name === 'AgentDream') {
      await this._ensureModelBridge();
      // Upstream Dream intentionally parses its own plugin config rather than
      // process.env. Materialize only explicitly configured DREAM_* keys.
      const dreamConfig = path.join(this.runtimeDir, 'Plugin/AgentDream/config.env');
      const configured = Object.entries(this.config).filter(([key]) => /^DREAM_[A-Z0-9_]+$/.test(key));
      if (configured.length) {
        let content = fs.existsSync(dreamConfig) ? await fsp.readFile(dreamConfig, 'utf8') : '';
        for (const [key, value] of configured) {
          const expression = new RegExp(`^${key}=.*$`, 'm');
          const line = `${key}=${JSON.stringify(String(value))}`;
          content = expression.test(content) ? content.replace(expression, () => line) : `${content.trimEnd()}\n${line}\n`;
        }
        await fsp.writeFile(dreamConfig, content);
      }
    }
    if (name === 'MagiAgent') await this._prepareMagiConfiguration();
    const plugin = this._require(TOOLS[name]);
    this.modules.set(name, plugin);
    attachPlugin(this.telemetry, name, plugin);
    let effectiveConfig = this.runtimeConfig;
    if (name === 'DailyNoteSearcher') {
      const port = await this._unusedPort();
      process.env.DAILY_NOTE_SEARCHER_PORT = String(port);
      effectiveConfig = { ...effectiveConfig, DAILY_NOTE_SEARCHER_HOST: '127.0.0.1', DAILY_NOTE_SEARCHER_PORT: port };
    }
    await plugin.initialize?.(effectiveConfig, this.dependencies);
    return plugin;
  }

  async callTool(name, args = {}, context = {}) {
    await this.start({ vectors: false });
    if (name === 'DailyNoteSearcher' && this.runtimeConfig.WORLDLINEBOX_VCP_MANAGED === '1') {
      const root = { dailynote: process.env.KNOWLEDGEBASE_ROOT_PATH, knowledge: process.env.TDB_KNOWLEDGE_ROOT_PATH };
      const selected = args.root_path || 'dailynote';
      if (!Object.hasOwn(root, selected)) throw new TypeError('Expected dailynote or knowledge root');
      if (args.folder) await this._require('modules/safeFilePath.js').safeFilePath(root[selected], args.folder, { singleSegment: true });
      args = { ...args, root_path: root[selected] };
    }
    if (name === 'SemanticGroupEditor') {
      await this.start({ vectors: true });
      const entry = 'Plugin/SemanticGroupEditor/SemanticGroupEditor.js';
      if (args.command === 'QueryGroups' && !Object.keys(args).some(key => /^command\d+$/.test(key))) return this._stdioTool(entry, args);
      await this.rag.semanticGroups._ready;
      await this.rag.semanticGroups.shutdown();
      try {
        const result = await this._stdioTool(entry, args);
        if (result.status !== 'error') {
          await this.rag.semanticGroups.synchronizeFromEditFile();
          await this.rag.semanticGroups.loadGroups();
          await this.modules.get('LightMemo')?.loadSemanticGroups();
          this.rag.cacheManager.clear('query');
        }
        return result;
      } finally { this.rag.semanticGroups.resumeStatsFlush(); }
    }
    if (name === 'DailyNoteManager' && args.command === 'associate') await this.start({ vectors: true });
    const plugin = await this._tool(name);
    if (name === 'LightMemo' || name === 'AgentDream' || name === 'DailyNoteManager' && args.command === 'associate') await this.sync();
    const result = name === 'LightMemo' ? await this.runLightMemo(plugin, args) : await plugin.processToolCall(args, context);
    if (name === 'MagiAgent' && args.command === 'start_meeting') {
      const match = JSON.stringify(result).match(/magi-session-\d+/);
      if (match) this.pendingMagi.add(match[0]);
    }
    return result;
  }

  async search(query, options = {}) {
    await this.start({ vectors: true });
    // Managed hosts may already hold per-content-version ingestion receipts.
    // The default CLI contract retains its original full reconciliation.
    if (options.sync !== false) await this.sync({ timeoutMs: options.timeoutMs });
    const args = { ...options, query, enginemode: options.mode || options.enginemode || 'rivermemo' };
    delete args.mode;
    if (!args.folder && options.diaryNames) args.folder = (Array.isArray(options.diaryNames) ? options.diaryNames : [options.diaryNames]).join(',');
    if (args.k === undefined && options.topK !== undefined) args.k = options.topK;
    delete args.diaryNames; delete args.topK;
    delete args.sync; delete args.timeoutMs;
    if (!args.folder && !args.maid && !args.knowledge_base) args.search_all_knowledge_bases = true;
    return this.runLightMemo(await this._tool('LightMemo'), args);
  }

  async runLightMemo(plugin, args) {
    const result = await plugin.processToolCall(args);
    if (this.runtimeConfig.WORLDLINEBOX_VCP_MANAGED !== '1' || args.fallback === 'none' ||
        !/warped insufficient joint coverage/i.test(result?.plugin_error || '')) return result;
    const retry = await plugin.processToolCall({ ...args, engineMode: 'knn' });
    return { ...retry, retrievalFallback: { engine: 'knn', reason: 'insufficient-joint-coverage' } };
  }

  async retrieve({ query, diaries, k = 10, engine = 'rivermemo', fallback = 'knn', coreTags = [], candidateK }) {
    if (typeof query !== 'string' || !query.trim() || !Array.isArray(diaries) || !diaries.length
        || diaries.some(name => typeof name !== 'string' || !name.trim())) throw new TypeError('A query and explicit diary names are required');
    if (!Number.isSafeInteger(k) || k < 1 || k > 1000 || candidateK !== undefined &&
        (!Number.isSafeInteger(candidateK) || candidateK < 1 || candidateK > 10000)) throw new RangeError('Invalid retrieval limit');
    if (!Array.isArray(coreTags) || coreTags.some(tag => typeof tag !== 'string')) throw new TypeError('Expected a core tag list');
    await this.start({ vectors: true });
    const bridge = this.dependencies.contextBridge;
    const queryVector = await bridge.embedText(query);
    if (!queryVector || queryVector.length !== this.kb.config.dimension || !queryVector.every(Number.isFinite)) {
      throw new Error('The built-in embedding service returned an invalid query vector');
    }
    return bridge.retrieveDiary({ queryText: query, diaryNames: diaries, queryVector, k, engine, fallback, coreTags, candidateK });
  }

  async inspectContext({ messages, threshold = 0.7 }) {
    if (!Array.isArray(messages) || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new TypeError('Invalid semantic context');
    await this.start({ vectors: true });
    const manager = this.rag.contextVectorManager;
    const bridge = this.dependencies.contextBridge;
    const snapshot = await manager.updateContext(messages, { allowApi: true });
    const summary = role => {
      const vector = bridge.getAggregatedVector(role);
      return vector ? { vector: Array.from(vector), logicDepth: bridge.computeLogicDepth(vector), semanticWidth: bridge.computeSemanticWidth(vector) } : null;
    };
    return { user: summary('user'), assistant: summary('assistant'), segments: manager.segmentContext(messages, threshold, snapshot.snapshotVectorByHash) };
  }

  async putKnowledgeDocument({ library, fileName, content }) {
    if (typeof content !== 'string' || !content.trim() || !/\.(md|txt|json|html)$/i.test(fileName)) throw new TypeError('Expected a text document');
    await this.start({ vectors: true });
    if (!this.cold.initialized) throw new Error('Cold knowledge library is unavailable');
    const root = process.env.TDB_KNOWLEDGE_ROOT_PATH;
    const { safeFilePath } = this._require('modules/safeFilePath.js');
    const directory = await safeFilePath(root, library, { singleSegment: true });
    const target = await safeFilePath(directory, fileName, { singleSegment: true });
    await fsp.mkdir(directory, { recursive: true });
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fsp.writeFile(temporary, content, { flag: 'wx' });
      await fsp.rename(temporary, target);
    } finally { await fsp.rm(temporary, { force: true }); }
    return { library, fileName, indexStatus: 'queued' };
  }

  async readColdLibrary(operation, { library, query, k = 8 }) {
    if (typeof query !== 'string' || !query.trim()) throw new TypeError('A library query is required');
    await this.start({ vectors: true });
    if (!this.cold.initialized || !this.cold.listLibraries().includes(library)) throw new Error('Cold library is unavailable');
    let pelorusSearch;
    if (operation === 'cold.pelorusSearch') {
      if (!Number.isSafeInteger(k) || k < 1 || k > 100) throw new RangeError('Invalid Pelorus result count');
      const vector = await this.dependencies.contextBridge.embedText(query);
      if (!vector || vector.length !== this.kb.config.dimension || !vector.every(Number.isFinite)) throw new Error('Invalid query embedding');
      pelorusSearch = JSON.stringify({ operation: 'search', vector: Array.from(vector), options: { top_k: k, exact: true } });
    }
    // The upstream administrative queryTql dispatcher can select tqlMut.
    // Expose only the native read API for model-issued queries.
    return this.cold._withLibraryQueue(library, async () => {
      const handle = this.cold.getOrOpenLibrary(library);
      this.cold._beginLibraryUse(handle);
      try {
        if (!pelorusSearch) return handle.db.tql(query);
        try { return JSON.parse(handle.db.pelorusRequest(pelorusSearch)); }
        catch (error) {
          if (error.code !== 'TDB_IMMUTABLE_ARTIFACT' || !/Pelorus index is missing or requires rebuild/i.test(error.message)) throw error;
          // VCP's fixed-curvature profile admits our unit-normalized vectors.
          // Keep the first build and retry within the same native library lease.
          handle.db.pelorusRequest(JSON.stringify({ operation: 'build', config: { curvature: 0.25, navigation: 'geometry_bq2' } }));
          return JSON.parse(handle.db.pelorusRequest(pelorusSearch));
        }
      } finally { this.cold._endLibraryUse(handle); }
    });
  }

  async preprocess(messages, options = {}) {
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
    await this.start({ vectors: false });
    this.events.length = 0;
    let current = messages;
    if (options.vectors === true || options.folding === true) await this.start({ vectors: true });
    let processingContext;
    if (options.variables !== false) {
      const result = await this._expandVariables(current, options);
      current = result.messages;
      processingContext = result.context;
    }
    const carrier = current.filter(m => m?.role === 'system' || m?.role === 'user').map(m => textContent(m.content)).join('\n');
    const semantic = /\[\[[^\]]*(?:日记本|知识库|VCP元思考)|《《[^》]*(?:日记本|知识库)|<<[^>]*日记本/.test(carrier);
    if (semantic || /(?:\[\[|\{\{)ContextFoldingV2/.test(carrier) || options.vectors === true || options.folding === true) {
      await this.start({ vectors: true });
      if (options.sync !== false) await this.sync({ timeoutMs: options.timeoutMs });
    }
    const run = async (plugin, cfg = options) => {
      const next = await plugin.processMessages(current, { ...this.runtimeConfig, ...cfg });
      current = transferMetadata(current, next);
    };
    // Selected stages retain preprocessor_order.json's source order:
    // static placeholders -> tray -> RAG -> timeline -> OneRing -> folding.
    if (processingContext) {
      const next = await this._require('modules/messageProcessor.js').injectStaticPluginPlaceholdersInMessages(current, processingContext);
      current = transferMetadata(current, next);
    }
    if (options.tray !== false) await run(await this._contextPlugin('MemoryThinkingTray'));
    // The V5 RAG plugin resolves all three timeline declarations together
    // with its diary query. Provide the initialized service before RAG runs.
    if (options.timeline !== false && /\[\[VCPTimeLine(?:Summary|Recall)?::/.test(carrier)) await this._contextPlugin('VCPTimeLine');
    if (this.vectorReady) await run(this.rag);
    else if (/\{\{[^}]*日记本/.test(carrier)) {
      // Reuse the full upstream plugin's direct-only fast path, including
      // RoleValve, BM25, multimodal preservation and real-user sanitization.
      if (!this.directRag) {
        this.directRag = this._require('Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');
        this.modules.set('RAGDiaryPlugin', this.directRag);
        attachPlugin(this.telemetry, 'RAGDiaryPlugin', this.directRag);
        this.directRag.pushVcpInfo = this.pushVcpInfo;
      }
      await run(this.directRag);
    }
    if (options.oneRing !== false && /\[\[OneRing(?:Memo)?::/.test(carrier)) await run(await this._contextPlugin('OneRing'));
    if (options.folding === true || (this.vectorReady && options.folding !== false)) {
      const before = current;
      await run(await this._contextPlugin('ContextFoldingV2'));
      // V5 folding may JSON-clone the messages to replace old assistant text.
      // It preserves order/count, but JSON loses OneRing's private source marks.
      if (current !== before && before.length === current.length) current.forEach((message, index) => {
        for (const key of ['__oneRingInjectedFromDb', '__oneRingTimelineMeta']) {
          const descriptor = Object.getOwnPropertyDescriptor(before[index], key);
          if (descriptor?.enumerable === false && !Object.hasOwn(message, key)) Object.defineProperty(message, key, descriptor);
        }
      });
    }
    if (processingContext) {
      const next = this._require('modules/messageProcessor.js').applyDetectorsToMessages(current, processingContext);
      current = transferMetadata(current, next);
    }
    if (options.roleDivider) current = transferMetadata(current, this._require('modules/roleDivider.js').process(current, typeof options.roleDivider === 'object' ? options.roleDivider : {}));
    if (options.contextTokenLimit) {
      const manager = this._require('modules/contextManager.js');
      const next = await manager.pruneMessagesSmart(current, options.contextTokenLimit, false, { client: this.jev });
      current = transferMetadata(current, next);
    }
    this.lastMessages = current;
    const injectedHistory = current.flatMap((message, index) => {
      const injected = Object.getOwnPropertyDescriptor(message, '__oneRingInjectedFromDb');
      const timeline = Object.getOwnPropertyDescriptor(message, '__oneRingTimelineMeta');
      return injected?.enumerable === false && injected.value === true && timeline?.enumerable === false
        ? [{ index, timeline: timeline.value }] : [];
    });
    return { messages: current, metadata: { oneRing: current.__oneRingMeta || null, injectedHistory },
      injectedHistoryIndices: injectedHistory.map(item => item.index), events: this.events.slice() };
  }

  async _expandVariables(messages, options) {
    // Reload source managers per call without their unowned fs.watch handles.
    // The worker serializes requests; user-authored maps remain in this home.
    const agentManager = this._require('modules/agentManager.js');
    const tvsManager = this._require('modules/tvsManager.js');
    const toolboxManager = this._require('modules/toolboxManager.js');
    const sarManager = this._require('modules/sarPromptManager.js');
    for (const name of ['agent_map.json', 'toolbox_map.json', 'sarprompt.json']) {
      const source = path.join(this.home, name);
      if (fs.existsSync(source)) await fsp.copyFile(source, path.join(this.runtimeDir, name));
    }
    agentManager.setAgentDir(process.env.AGENT_DIR_PATH || path.join(this.home, 'Agent'));
    tvsManager.setTvsDir(process.env.TVSTXT_DIR_PATH || path.join(this.home, 'TVStxt'));
    toolboxManager.setTvsDir(process.env.TVSTXT_DIR_PATH || path.join(this.home, 'TVStxt'));
    await agentManager.loadMap();
    await toolboxManager.loadMap();
    agentManager.promptCache.clear();
    tvsManager.contentCache.clear();
    toolboxManager.contentCache.clear();
    if (fs.existsSync(path.join(this.runtimeDir, 'sarprompt.json'))) await sarManager.loadPrompts();
    else await sarManager.migrateFromEnv();
    if (options.agents) agentManager.agentMap = new Map(Object.entries(options.agents));
    this.staticPlaceholders = new Map(Object.entries(options.staticPlaceholders || {}));
    const context = {
      pluginManager: this.pluginHost,
      cachedEmojiLists: new Map(Object.entries(options.emojiLists || {})),
      detectors: options.detectors || [], superDetectors: options.superDetectors || [],
      DEBUG_MODE: false, messages, deferStaticPluginPlaceholders: true,
      expandedAgentName: null, expandedToolboxes: new Set(), expandedVcpTools: new Set(),
      expandedStaticPlaceholders: new Set(), expandedGlobalPlaceholders: new Set(),
    };
    if (messages.some(message => textContent(message.content).includes('{{VCPDynamicTools}}'))) {
      const registry = this._require('modules/dynamicToolRegistry.js');
      if (!registry.initialized) await registry.initialize({ pluginManager: this.pluginHost, projectBasePath: this.runtimeDir, watchConfigFiles: false });
      await registry.syncFromPluginManager('memory_host');
    }
    const processor = this._require('modules/messageProcessor.js');
    const output = [];
    const overrides = typeof options.variables === 'object' ? options.variables : {};
    const previous = new Map();
    for (const [key, value] of Object.entries(overrides)) {
      if (!/^(?:Var|Tar|SarPrompt|SarModel)[A-Za-z0-9_]+$/.test(key)) throw new Error(`Unsupported prompt variable override: ${key}`);
      previous.set(key, process.env[key]); process.env[key] = String(value);
    }
    try {
      for (const message of messages) {
        const next = { ...message };
        if (typeof message.content === 'string') next.content = await processor.replaceAgentVariables(message.content, options.model || '', message.role, context);
        else if (Array.isArray(message.content)) {
          next.content = [];
          for (const part of message.content) next.content.push(part?.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: await processor.replaceAgentVariables(part.text, options.model || '', message.role, context) } : part);
        }
        output.push(next);
      }
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    return { messages: transferMetadata(messages, output), context };
  }

  async recordResponse({ messages, metadata, text, aiText, completed = true, outcome } = {}) {
    const current = messages || this.lastMessages;
    if (!Array.isArray(current)) throw new TypeError('messages from preprocess are required');
    if (metadata?.oneRing) Object.defineProperty(current, '__oneRingMeta', { value: metadata.oneRing, configurable: true, writable: true, enumerable: false });
    const oneRing = await this._contextPlugin('OneRing');
    await oneRing.recordAIResponseFromMessages(current, text ?? aiText ?? '', outcome || { completed });
    return { recorded: completed, metadata: oneRing.extractMetaFromMessages(current) };
  }

  async _scanDiaries() {
    const root = this.kb.config.rootPath;
    const files = [];
    const walk = async dir => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(root, absolute).split(path.sep);
        const diary = relative.length > 1 ? relative[0] : (entry.isDirectory() ? relative[0] : 'Root');
        if (this.kb.fileWatcher._isIgnored(diary, entry.name)) continue;
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && /\.(?:md|txt)$/i.test(entry.name)) files.push(absolute);
      }
    };
    await walk(root);
    return files;
  }

  async sync({ timeoutMs = 180000, signal } = {}) {
    await this.start({ vectors: true });
    const deadline = Date.now() + timeoutMs;
    await this.kb.databaseCoordinator.waitForExternalMutations();
    const files = await this._scanDiaries();
    const indexedRaw = await this.kb.nativeKnowledgeRuntime.listIndexedFilePaths(this.kb.dbPath);
    const indexed = typeof indexedRaw === 'string' ? JSON.parse(indexedRaw) : indexedRaw;
    const existing = new Set(files.map(p => path.resolve(p)));
    for (const absolute of files) this.kb.pendingFiles.add(absolute);
    for (const relative of indexed || []) {
      const absolute = path.resolve(this.kb.config.rootPath, relative);
      if (!existing.has(absolute)) this.kb.pendingDeletes.add(absolute);
    }
    await waitForIndex({ timeoutMs: Math.max(0, deadline - Date.now()), signal, isClosed: () => this.closed || this.closing,
      message: 'Memory synchronization timed out; queued work remains',
      kick: async () => { await this.kb._flushDeleteBatch(); await this.kb._flushBatch(); await this.kb.ingestionPipeline.drain(); },
      ready: async () => !(this.kb.pendingFiles.size || this.kb.pendingDeletes.size || this.kb.isProcessing || this.kb.isProcessingDeletes) });
    const rows = await this.kb.probeIngestionFiles(files.map(file => path.relative(this.kb.config.rootPath, file).replace(/\\/g, '/')));
    const incomplete = rows.filter(row => !row.exists || row.completeVectors !== true || row.completeTags !== true);
    if (incomplete.length) throw Object.assign(new Error(`Ingestion incomplete for ${incomplete.length} file(s)`), { code: 'MEMORY_SYNC_INCOMPLETE', files: incomplete.map(row => row.path) });
    if (this.cold?.initialized) {
      // Cold queue has its own persistent retry/lease semantics.
      this.cold._scanInitialFiles();
      while (true) {
        await this.cold._runQueueWorker();
        const pending = this.cold.metaDb.prepare("SELECT COUNT(*) AS count FROM ingest_queue WHERE status IN ('pending','processing','retry')").get().count;
        if (!pending && !this.cold.isQueueWorkerRunning) break;
        if (Date.now() > deadline) throw new Error('Cold knowledge synchronization timed out; inspect the ingest queue');
        await delay(50);
      }
      const failed = this.cold.metaDb.prepare("SELECT COUNT(*) AS count FROM ingest_queue WHERE status='failed'").get().count;
      if (failed) throw new Error(`${failed} cold knowledge ingestion job(s) failed`);
    }
    return { synchronized: true, files: files.length, diaries: await this.kb.listDistinctDiaries() };
  }

  async status() {
    const status = { home: this.home, runtimeDir: this.runtimeDir, started: this.started, vectors: this.vectorReady, plugins: [...this.modules.keys()] };
    if (this.kb?.initialized) Object.assign(status, { diaries: await this.kb.listDistinctDiaries(), pendingFiles: this.kb.pendingFiles.size, pendingDeletes: this.kb.pendingDeletes.size, health: this.kb.dbHealthState });
    status.providers = { embeddingConfigured: !!(process.env.API_URL && process.env.API_Key && process.env.WhitelistEmbeddingModel), rerankConfigured: !!(process.env.RerankUrl && process.env.RerankApi && process.env.RerankModel), jevConfigured: this.jev?.isConfigured?.() === true, aiMemoConfigured: this.rag?.aiMemoHandler?.isConfigured?.() === true, coldEnabled: this.cold?.initialized === true };
    return status;
  }

  async invoke(request, positionalMethod, positionalArgs) {
    const { target, method, args = [] } = typeof request === 'string' ? { target: request, method: positionalMethod, args: positionalArgs || [] } : request;
    if (!ADVANCED[target]?.includes(method)) throw new Error(`Unsupported memory operation: ${target}.${method}`);
    await this.start({ vectors: ['knowledge', 'cold', 'rag', 'dream', 'training'].includes(target) });
    let object;
    switch (target) {
      case 'timeline': object = await this._contextPlugin('VCPTimeLine'); break;
      case 'oneringMemo': await this._contextPlugin('OneRing'); object = this._require('Plugin/OneRing/OneRingMemo.js'); break;
      case 'knowledge': object = this.kb; break;
      case 'training': object = this.kb.tagMemoEngine; break;
      case 'cold': object = this.cold; break;
      case 'rag': object = this.rag; break;
      case 'dream': object = await this._tool('AgentDream'); break;
    }
    if (typeof object?.[method] !== 'function') throw new Error(`Upstream capability unavailable: ${target}.${method}`);
    const result = await object[method](...args);
    return result instanceof Map ? Object.fromEntries(result) : result;
  }

  async _stdioTool(relative, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(this.runtimeDir, relative)], { cwd: this.runtimeDir, env: process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Memory tool timed out')); }, 60000);
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        try { resolve(JSON.parse(output.trim())); } catch { reject(new Error(`Memory tool failed (${code}): ${stderr || output.slice(-2000)}`)); }
      });
      child.stdin.end(JSON.stringify(args));
    });
  }

  async _unusedPort() {
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
  }

  async _ensureModelBridge() {
    if (this.modelServer) return;
    this.modelServer = http.createServer(async (request, response) => {
      try {
        const callbackPrefix = `/plugin-callback/${this.localKey}/MagiAgent/`;
        const isCallback = request.method === 'POST' && request.url.startsWith(callbackPrefix);
        if (!isCallback && (request.method !== 'POST' || request.url !== '/v1/chat/completions')) { response.writeHead(404).end(); return; }
        if (!isCallback && request.headers.authorization !== `Bearer ${this.localKey}`) { response.writeHead(401).end(); return; }
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('Model request exceeds 32 MiB'); chunks.push(chunk); }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (isCallback) {
          const identifier = request.url.slice(callbackPrefix.length);
          if (!/^magi-session-\d+$/.test(identifier) || payload.requestId !== identifier) throw new Error('Invalid Magi callback identity');
          const directory = path.join(this.runtimeDir, 'VCPAsyncResults');
          await fsp.mkdir(directory, { recursive: true });
          const file = path.join(directory, `MagiAgent-${identifier}.json`);
          const temporary = `${file}.${crypto.randomUUID()}.tmp`;
          await fsp.writeFile(temporary, JSON.stringify(payload)); await fsp.rename(temporary, file);
          this.pendingMagi.delete(identifier);
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'success' }));
          return;
        }
        const data = await this._completeModel(payload);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      } catch (error) {
        response.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    await new Promise((resolve, reject) => { this.modelServer.once('error', reject); this.modelServer.listen(0, '127.0.0.1', resolve); });
    Object.assign(this.runtimeConfig, { PORT: this.modelServer.address().port, Key: this.localKey });
  }

  async _completeModel(payload) {
    const apiUrl = process.env.MEMORY_CHAT_API_URL || process.env.API_URL;
    const apiKey = process.env.MEMORY_CHAT_API_KEY || process.env.API_Key;
    if (!apiUrl || !apiKey) throw new Error('Configure API_URL and API_Key for model-generated memory');
    const endpoint = `${apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
    const maxRounds = Number(this.config.maxToolRounds) || 8;
    let body = { ...payload, stream: false };
    if (Array.isArray(body.messages)) {
      const processed = await this.preprocess(body.messages, { folding: false, sync: false });
      body.messages = processed.messages;
    }
    const parser = this._require('modules/vcpLoop/toolCallParser.js');
    for (let round = 0; round <= maxRounds; round++) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.MEMORY_MODEL_TIMEOUT_MS) || 180000) });
      const raw = await response.text();
      if (!response.ok) throw new Error(`Memory model provider returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
      const data = JSON.parse(raw);
      const text = data.choices?.[0]?.message?.content;
      const calls = parser.parse(text);
      if (!calls.length) return data;
      if (round === maxRounds) throw new Error('Memory model tool loop exceeded configured limit');
      const results = [];
      for (const call of calls) {
        if (!Object.hasOwn(TOOLS, call.name) && call.name !== 'SemanticGroupEditor') throw new Error(`Model requested unavailable memory tool: ${call.name}`);
        if (call.name === 'AgentDream' && (call.args.command || call.args.action) === 'triggerDream') throw new Error('Recursive dream generation is not supported');
        results.push({ tool_name: call.name, result: await this.callTool(call.name, call.args) });
      }
      body.messages.push({ role: 'assistant', content: text }, { role: 'user', content: `[系统提示:] 记忆工具执行结果\n${JSON.stringify(results)}` });
      if (this.vectorReady) {
        await this.sync();
        if (!this.ragRefresher) this.ragRefresher = require('./rag-refresh.cjs').createRagRefresher(this.runtimeDir);
        const refreshed = await this.ragRefresher(body.messages, { lastAiMessage: text, toolResultsText: JSON.stringify(results) }, this.pluginHost, false);
        body.messages = transferMetadata(body.messages, refreshed);
      }
    }
  }

  async _prepareMagiConfiguration() {
    await this._ensureModelBridge();
    const rootConfig = path.join(this.runtimeDir, 'config.env');
    // Magi reads this file itself and lets it override injected config. A local
    // router gets a fresh port/key each worker lifetime; never retain an old one.
    let rootText = fs.existsSync(rootConfig) ? await fsp.readFile(rootConfig, 'utf8') : '';
    for (const [key, value] of Object.entries({ API_URL: process.env.API_URL || '', API_Key: process.env.API_Key || '',
      CALLBACK_BASE_URL: `http://127.0.0.1:${this.modelServer.address().port}/plugin-callback/${this.localKey}` })) {
      const line = `${key}=${JSON.stringify(value)}`;
      const expression = new RegExp(`^${key}=.*$`, 'm');
      rootText = expression.test(rootText) ? rootText.replace(expression, () => line) : `${rootText.trimEnd()}\n${line}\n`;
    }
    await fsp.writeFile(rootConfig, rootText);
    const local = path.join(this.runtimeDir, 'Plugin/MagiAgent/config.env');
    if (!fs.existsSync(local)) {
      const model = this.runtimeConfig.MEMORY_CHAT_MODEL || this.runtimeConfig.CHAT_MODEL;
      if (!model) throw new Error('MagiAgent requires MEMORY_CHAT_MODEL or Plugin/MagiAgent/config.env');
      const models = this.config.MAGI_MODELS || {};
      const values = { MAGI_SYSTEM_PROMPT: '你是记忆审阅会议的一名独立角色。忠实检查提供的记忆与证据，标注不确定项。服务对象：{{MAIDNAME}}。' };
      const roles = {
        MELCHIOR: '从事实和来源一致性角度审阅，检查遗漏与互相矛盾的陈述。',
        BALTHASAR: '从时间顺序、因果边界和上下文连续性角度审阅，不补造事实。',
        CASPER: '从替代解释和反例角度质疑结论，区分证据、推测和缺失信息。',
      };
      for (const [role, prompt] of Object.entries(roles)) Object.assign(values, {
        [`${role}_Model`]: models[role] || model,
        [`${role}_Model_MAX_TOKENS`]: 4000,
        [`${role}_Model_TEMPERATURE`]: 0.4,
        [`${role}_Model_PROMPT`]: prompt,
        [`${role}_Model_Header`]: `## ${role}`,
        [`${role}_Model_NAME`]: role,
      });
      Object.assign(values, { Magi_Summarize_Model: models.summary || model, Magi_Summarize_Model_MAX_TOKENS: 4000,
        Magi_Summarize_Model_TEMPERATURE: 0.2, Magi_Summarize_Model_PROMPT: '忠实合并三角色讨论，保留分歧、证据和未决事项。',
        Magi_Summarize_Model_Footer: 'Standalone VCP Magi: roles may share one configured model.' });
      await fsp.writeFile(local, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n');
    }
  }

  async drainSummaries() {
    const folding = this.modules.get('ContextFoldingV2');
    const memo = this.modules.has('OneRing') ? this._require('Plugin/OneRing/OneRingMemo.js') : null;
    const backgroundDeadline = Date.now() + (Number(this.config.MEMORY_BACKGROUND_DRAIN_TIMEOUT_MS) || 120000);
    await delay(0); // allow OneRingMemo.scheduleAutoGenerate's setImmediate
    while (true) {
      const foldingBusy = folding && (folding.summaryQueue.length || folding.activeSummaryCount || folding.pendingHashes.size);
      const memoBusy = memo && memo.listAgentNames().some(name => memo.isGenerating(name));
      if (!foldingBusy && !memoBusy) break;
      if (Date.now() > backgroundDeadline) throw new Error('Background memory summaries did not finish before the drain timeout');
      folding?._processSummaryQueue();
      await delay(25);
    }
  }

  async clearDerivedContext(companionId) {
    const { safeFilePath } = this._require('modules/safeFilePath.js');
    const timeline = this._require('Plugin/VCPTimeLine/VCPTimeLine.js');
    // An active auto-sync may already be writing a monthly artifact. Stop
    // scheduling, then wait for all writers before issuing deletion receipts.
    await timeline.shutdown();
    await Promise.allSettled([...timeline.generationLocks.values()]);
    await this.drainSummaries();
    this.rag?.foldingStore?.db?.exec('DELETE FROM folding_entries');
    const groups = this.rag.semanticGroups;
    await groups._ready;
    await groups.shutdown();
    // Group vocabulary and vectors have no upstream per-word source ledger.
    // Reset the projection as a unit before the withdrawal fence is lifted.
    try {
      const groupDirectory = 'Plugin/RAGDiaryPlugin';
      const empty = { config: {}, groups: {} };
      for (const file of ['semantic_groups.edit.json', 'semantic_groups.json']) {
        atomicJson(await safeFilePath(this.runtimeDir, groupDirectory + '/' + file), empty);
      }
      const vectors = await safeFilePath(this.runtimeDir, groupDirectory + '/semantic_vectors');
      for (const file of await fsp.readdir(vectors)) {
        if (/^[a-f\d-]+\.json$/i.test(file)) await fsp.unlink(await safeFilePath(vectors, file, { singleSegment: true }));
      }
      groups.groupVectorCache.clear();
      await groups.loadGroups();
      await this.modules.get('LightMemo')?.loadSemanticGroups();
    } finally { groups.resumeStatsFlush(); }
    const memoName = encodeURIComponent(companionId).replace(/%/g, '_') + '.json';
    const memo = await safeFilePath(this.runtimeDir, 'Plugin/OneRing/memo/' + memoName);
    await fsp.rm(memo, { force: true });
    for (const name of ['timeline_summaries.json', 'auto_sync_state.json']) {
      const file = await safeFilePath(this.runtimeDir, 'Plugin/VCPTimeLine/' + name);
      await fsp.rm(file, { force: true });
    }
    const indexedRaw = await this.kb.nativeKnowledgeRuntime.listIndexedFilePaths(this.kb.dbPath);
    const indexed = typeof indexedRaw === 'string' ? JSON.parse(indexedRaw) : indexedRaw;
    for (const agent of new Set(['Companion', companionId])) {
      const folder = agent + 'timeline';
      const directory = await safeFilePath(this.kb.config.rootPath, folder, { singleSegment: true });
      const names = new Set(fs.existsSync(directory) ? await fsp.readdir(directory) : []);
      // A previous interrupted withdrawal can have removed the files before
      // their native deletion receipts arrived. Reconcile those rows too.
      for (const relative of indexed || []) {
        const parts = relative.replaceAll('\\', '/').split('/');
        if (parts.length === 2 && parts[0].toLowerCase() === folder.toLowerCase()) names.add(parts[1]);
      }
      const paths = [];
      for (const name of names) {
        if (/^\d{4}-(?:0[1-9]|1[0-2])\.md$/i.test(name)) paths.push(await safeFilePath(directory, name, { singleSegment: true }));
      }
      if (paths.length) await this.kb.runExternalFileMutation('WorldlineBoxTimelineWithdrawal', async () => {
        for (const file of paths) await fsp.rm(file, { force: true });
        return { status: 'success', mutationPaths: { deletes: paths, upserts: [] } };
      }, { waitForIndex: true, timeoutMs: 30000 });
    }
  }

  async close() {
    if (this.closed || this.closing) return;
    this.closing = true;
    const errors = [];
    try { await this.drainSummaries(); } catch (error) { errors.push(error.message); }
    if (this.pendingMagi.size) {
      const deadline = Date.now() + (Number(this.config.MEMORY_MAGI_DRAIN_TIMEOUT_MS) || 10 * 60 * 1000);
      while (this.pendingMagi.size && Date.now() < deadline) {
        for (const identifier of this.pendingMagi) {
          if (fs.existsSync(path.join(this.runtimeDir, 'VCPAsyncResults', `MagiAgent-${identifier}.json`))) this.pendingMagi.delete(identifier);
        }
        if (this.pendingMagi.size) await delay(50);
      }
      if (this.pendingMagi.size) errors.push('Magi meetings did not finish before the drain timeout');
    }
    this.closed = true;
    // Stop callers before releasing the shared KB, DB actors and native pools.
    const entries = [...this.modules.entries()].reverse().filter(([name]) => !['KnowledgeBaseManager', 'TDBKnowledge'].includes(name));
    for (const [name, object] of entries) {
      try { await object.shutdown?.(); } catch (error) { errors.push(`${name}: ${error.message}`); }
    }
    for (const name of ['TDBKnowledge', 'KnowledgeBaseManager']) {
      try { await this.modules.get(name)?.shutdown?.(); } catch (error) { errors.push(`${name}: ${error.message}`); }
    }
    if (this.modelServer) { this.modelServer.closeIdleConnections?.(); await new Promise(resolve => this.modelServer.close(resolve)); }
    const filename = path.join(this.runtimeDir, 'Plugin.js');
    if (this.previousPluginCache) require.cache[filename] = this.previousPluginCache;
    else delete require.cache[filename];
    if (errors.length) throw new Error(`Memory shutdown failed: ${errors.join('; ')}`);
  }
}

module.exports = { MemoryRuntime, transferMetadata, TOOLS, ADVANCED };
