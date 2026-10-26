/* global require, module, process, fetch */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { URL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { compileFunction } = require('node:vm');
const { Buffer } = require('node:buffer');

const PREPROCESS_CACHE_MAX_ENTRIES = 32;
const PREPROCESS_CACHE_MAX_BYTES = 4 * 1024 * 1024;

/** Compile the clock-consuming frozen upstream modules without altering their bytes. Only
 * their module-local dayjs dependency reads this request's host clock; timers,
 * Date, other plugins and concurrent requests retain their own real clocks. */
function createRagQueryClock() {
  const context = new AsyncLocalStorage(), modules = new Map();
  const load = filename => {
    if (modules.has(filename)) return modules.get(filename).exports;
    const nativeRequire = createRequire(filename), dayjs = nativeRequire('dayjs');
    const defaultTimeZone = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
    const inQueryZone = (instance, clock) => new Proxy(instance, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'tz') return (zone, ...rest) => inQueryZone(target.tz(zone === defaultTimeZone ? clock.timeZone : zone, ...rest), clock);
      if (property === 'diff') return (other, unit, floating) => {
        // dayjs/utc falls back to machine-local time when one zoned instance
        // has $u=false and another $u=undefined. Preserve dayjs's civil-day
        // formula explicitly for two dates in this same request timezone.
        if (['day', 'days', 'd'].includes(unit) && target.$x?.$timezone === clock.timeZone && other?.$x?.$timezone === clock.timeZone) {
          const days = (target.valueOf() - other.valueOf() - (other.utcOffset() - target.utcOffset()) * 60000) / 86400000;
          return floating ? days : Math.trunc(days);
        }
        return value.call(target, other, unit, floating);
      };
      return (...args) => {
        let result = value.apply(target, args);
        if (!dayjs.isDayjs(result)) return result;
        const calendar = (property === 'add' || property === 'subtract') && ['day', 'days', 'd', 'week', 'weeks', 'w', 'month', 'months', 'M', 'year', 'years', 'y'].includes(args[1])
          || ['day', 'date', 'month', 'year'].includes(property) && args.length > 0
          || property === 'set' && ['day', 'date', 'month', 'year'].includes(args[0]);
        // The upstream parser performs calendar arithmetic. dayjs otherwise
        // carries yesterday's UTC offset across a DST boundary, moving midnight
        // into the wrong date when it is converted to the timezone again.
        if (calendar && result.$x?.$timezone === clock.timeZone) result = dayjs.tz(result.format('YYYY-MM-DD HH:mm:ss.SSS'), clock.timeZone);
        return inQueryZone(result, clock);
      };
    } });
    const clockedDayjs = new Proxy(dayjs, { apply(target, receiver, arguments_) {
      const clock = context.getStore();
      if (clock && (!arguments_.length || arguments_[0] === undefined)) {
        // Upstream RAG/AIMemo explicitly apply their module default zone after
        // obtaining now. Redirect that default only on this request-local value.
        return inQueryZone(dayjs(clock.now).tz(clock.timeZone), clock);
      }
      // Upstream decay dates are civil YYYY-MM-DD values. Interpret that same
      // civil date in the query zone instead of the machine's unrelated zone.
      if (clock && typeof arguments_[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(arguments_[0])) return inQueryZone(dayjs.tz(arguments_[0], clock.timeZone), clock);
      return Reflect.apply(target, receiver, arguments_);
    }, get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'tz' || typeof value !== 'function') return value;
      return new Proxy(value, { apply(timezone, receiver_, arguments_) {
        const clock = context.getStore();
        // Native diary index dates are host civil-day headers. Keep absolute
        // instants and every non-default explicitly requested zone untouched.
        const args = clock && /^\d{4}-\d{2}-\d{2}$/u.test(arguments_[0]) && arguments_[1] === defaultTimeZone
          ? [arguments_[0], clock.timeZone, ...arguments_.slice(2)] : arguments_;
        return Reflect.apply(timezone, receiver_, args);
      } });
    } });
    const localRequire = request => request === 'dayjs' ? clockedDayjs
      : ['./TimeExpressionParser.js', './AIMemoHandler.js'].includes(request) ? load(path.resolve(path.dirname(filename), request)) : nativeRequire(request);
    Object.assign(localRequire, nativeRequire);
    const module_ = { exports: {} }; modules.set(filename, module_);
    try {
      const execute = compileFunction(readFileSync(filename, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname'], { filename });
      execute(module_.exports, localRequire, module_, filename, path.dirname(filename));
    }
    catch (error) { modules.delete(filename); throw error; }
    return module_.exports;
  };
  return { load, current: () => context.getStore(), run(clock, operation) {
    if (clock !== undefined) {
      if (!clock || typeof clock.now !== 'string' || !Number.isFinite(Date.parse(clock.now)) || typeof clock.timeZone !== 'string' || clock.timeZone.length > 100) throw new Error('Invalid VCP query clock.');
      try { new Intl.DateTimeFormat('en', { timeZone: clock.timeZone }).format(); } catch { throw new Error('Invalid VCP query clock timezone.'); }
      clock = { now: new Date(clock.now).toISOString(), timeZone: clock.timeZone };
    }
    return context.run(clock, operation);
  } };
}

const pluginFiles = { DailyNote: 'DailyNote/dailynote.js', DailyNoteManager: 'DailyNoteManager/daily-note-manager.js',
  LightMemo: 'LightMemo/LightMemo.js', RAGDiaryPlugin: 'RAGDiaryPlugin/RAGDiaryPlugin.js', VCPTimeLine: 'VCPTimeLine/VCPTimeLine.js' };

class VcpMemoryPeripherals {
  constructor(runtime, configuration) {
    this.runtime = runtime;
    this.configuration = configuration;
    this.ragClock = createRagQueryClock();
    this.decayPolicy = new AsyncLocalStorage();
    this.decayObservations = [];
    this.parsedTimeRanges = [];
    this.plugins = new Map();
    this.events = [];
    this.contextReferences = [];
    this.contextSourceRows = new Map();
    this.observedCalls = Object.create(null);
    this.corpusEpoch = 0;
    this.preprocessReceipts = new Map();
    this.preprocessReceiptBytes = 0;
    // Observe the upstream ABI without changing its inputs, results or ranking.
    for (const name of ['executeNativeRiverQuery', 'executeLightMemoQuery']) {
      const original = runtime.kb[name];
      if (typeof original !== 'function') continue;
      const observe = result => {
        for (const row of result?.results || []) {
          const text = typeof row.text === 'string' ? row.text.trim() : '';
          if (!text) continue;
          const key = createHash('sha256').update(text).digest('hex');
          const rows = this.contextSourceRows.get(key) || [];
          rows.push(row); this.contextSourceRows.set(key, rows);
        }
      };
      runtime.kb[name] = async function (...args) {
        // Preserve a scoped facade's `this`, including its pre-query file ACL.
        const result = await original.apply(this, args);
        observe(result);
        return result;
      };
    }
    this.dependenciesPath = path.join(runtime.scopeRoot, 'timeline-dependencies.json');
  }
  invalidateCorpus() {
    this.corpusEpoch++;
    this.preprocessReceipts.clear();
    this.preprocessReceiptBytes = 0;
    this.cacheClockBucket = undefined;
    const rag = this.plugins.get('RAGDiaryPlugin');
    rag?.cacheManager.clear('aimemo');
    rag?.cacheManager.clear('query');
  }
  receiptCacheSnapshot() {
    return { entries: this.preprocessReceipts.size, bytes: this.preprocessReceiptBytes, corpusEpoch: this.corpusEpoch,
      maxEntries: PREPROCESS_CACHE_MAX_ENTRIES, maxBytes: PREPROCESS_CACHE_MAX_BYTES };
  }
  cacheReceipt(key, receipt, epoch) {
    if (epoch !== this.corpusEpoch || receipt.messages.some(message => typeof message.content === 'string'
      && /\[AIMemo[^\]\n]*(?:失败|未配置)|\[AI模型调用失败\]|::AIMemo\+/u.test(message.content))) return;
    // The worker is a JSON transport. Store that same complete receipt, including
    // observed references and trace events, instead of a naked generated answer.
    const serialized = JSON.stringify(receipt), bytes = Buffer.byteLength(serialized, 'utf8') + key.length + 128;
    if (bytes > PREPROCESS_CACHE_MAX_BYTES) return;
    const previous = this.preprocessReceipts.get(key);
    if (previous) { this.preprocessReceiptBytes -= previous.bytes; this.preprocessReceipts.delete(key); }
    while (this.preprocessReceipts.size >= PREPROCESS_CACHE_MAX_ENTRIES || this.preprocessReceiptBytes + bytes > PREPROCESS_CACHE_MAX_BYTES) {
      const oldest = this.preprocessReceipts.keys().next().value;
      this.preprocessReceiptBytes -= this.preprocessReceipts.get(oldest).bytes;
      this.preprocessReceipts.delete(oldest);
    }
    this.preprocessReceipts.set(key, { serialized, bytes });
    this.preprocessReceiptBytes += bytes;
  }
  beginContext() { this.contextReferences = []; this.contextSourceRows = new Map(); this.unmappedContextSources = 0; this.observeRawContextOutput = false; }
  observeContextRows(rows, role) {
    for (const row of rows || []) {
      const sourceFile = String(row.fullPath || row.sourceFile || row.path || '').replaceAll('\\', '/');
      const id = this.runtime.fileIds.get(path.basename(sourceFile));
      if (!id || typeof row.text !== 'string') { this.unmappedContextSources++; continue; }
      const reference = { id, role, sourceFile, textHash: createHash('sha256').update(row.text.trim()).digest('hex') };
      if (!this.contextReferences.some(item => item.id === id && item.role === role && item.textHash === reference.textHash)) this.contextReferences.push(reference);
    }
  }
  observeFocusFiles(files) {
    for (const file of files || []) {
      const text = String(file.content || file.text || '').trim();
      const key = createHash('sha256').update(text).digest('hex');
      const rows = this.contextSourceRows.get(key);
      if (!rows?.length) this.unmappedContextSources++;
      this.observeContextRows(rows, 'focus_input');
    }
  }
  observeMethod(target, name, mode) {
    const original = target?.[name];
    if (typeof original !== 'function') return;
    const counts = this.observedCalls;
    target[name] = function (...args) {
      counts[mode] = (counts[mode] || 0) + 1;
      return original.apply(this, args);
    };
  }
  async queryEnvironment(operation) {
    const previous = process.env.API_URL;
    process.env.API_URL = this.runtime.embedding.queryApiUrl || this.runtime.embedding.apiUrl;
    try { return await operation(); } finally { process.env.API_URL = previous; }
  }
  async load(name) {
    if (this.plugins.has(name)) return this.plugins.get(name);
    if (!pluginFiles[name]) throw new Error('Unknown VCP memory plugin.');
    const filename = path.join(this.runtime.runtimeRoot, 'Plugin', pluginFiles[name]);
    const plugin = name === 'RAGDiaryPlugin' ? this.ragClock.load(filename) : require(filename);
    const config = { PROJECT_BASE_PATH: this.runtime.runtimeRoot };
    const dependencies = { knowledgeBaseManager: this.runtime.kb, vectorDBManager: this.runtime.kb };
    if (name === 'RAGDiaryPlugin') {
      // This is an upstream configuration switch: its formatted/raw query cache
      // has no source revision key. Embedding caches and all retrieval logic stay upstream.
      process.env.RAG_QUERY_CACHE_ENABLED = 'false';
      process.env.RAG_RIVER_THINKING_ENABLED = this.configuration.riverThinkingEnabled ? 'true' : 'false';
      if (this.configuration.chat) {
        const chat = this.configuration.chat;
        const url = new URL(chat.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid VCP chat endpoint.');
        Object.assign(process.env, { AIMemoModel: chat.model, AIMemoApi: chat.apiKey,
          AIMemoUrl: `${url.toString().replace(/\/+$/u, '').replace(/\/v1$/u, '')}/`,
          AIMemoBatch: '2', AIMemoMaxTokensPerBatch: '18000',
          AIMEMO_CACHE_MAX_SIZE: '32', AIMEMO_CACHE_TTL_MS: '60000' });
      }
      await this.queryEnvironment(() => plugin.initialize(config, { ...dependencies,
        vcpLogFunctions: { pushVcpInfo: event => this.events.push(event) } }));
      const parseTime = plugin.timeParser.parse;
      plugin.timeParser.parse = (...args) => {
        const previous = plugin.timeParser.defaultTimezone, clock = this.ragClock.current();
        if (clock) plugin.timeParser.defaultTimezone = clock.timeZone;
        try {
          const result = parseTime.apply(plugin.timeParser, args);
          for (const range of result) {
            const observed = { start: range.start.toISOString(), end: range.end.toISOString() };
            if (!this.parsedTimeRanges.some(range => range.start === observed.start && range.end === observed.end)) this.parsedTimeRanges.push(observed);
          }
          return result;
        }
        finally { plugin.timeParser.defaultTimezone = previous; }
      };
      // _combineFiles is the exact source-material boundary used to construct
      // an AIMemo model prompt. This observes inputs, never claims sentence-level
      // attribution of its generated answer.
      const handler = plugin.aiMemoHandler;
      const combine = handler._combineFiles;
      handler._combineFiles = files => { this.observeFocusFiles(files); return combine.call(handler, files); };
      const plus = handler.processAIMemoPlusAggregated;
      handler.processAIMemoPlusAggregated = (...args) => {
        // A valid upstream cache hit skips prompt construction; the suffix
        // pipeline still supplies the same fingerprinted material explicitly.
        if (Array.isArray(args[5]?.sourceFiles)) this.observeFocusFiles(args[5].sourceFiles);
        return plus.apply(handler, args);
      };
      for (const name of ['formatStandardResults', 'formatCombinedTimeAwareResults', 'formatGroupRAGResults']) {
        const format = plugin[name];
        plugin[name] = (rows, ...args) => {
          const output = format.call(plugin, rows, ...args);
          // AIMemo also formats preliminary material internally. Those calls
          // do not mean the raw rows reached the final context verbatim.
          if (this.observeRawContextOutput) this.observeContextRows(rows, 'returned');
          return output;
        };
      }
      this.observeMethod(plugin.semanticGroups, 'getEnhancedVector', 'semantic_group');
      this.observeMethod(plugin.metaThinkingManager, 'processMetaThinkingChain', 'meta_thinking');
      this.observeMethod(plugin, '_getTimeRangeFilePathsCached', 'time');
      const originalDecay = plugin._applyTimeDecay;
      plugin._applyTimeDecay = (rows, ...args) => {
        const policy = this.decayPolicy.getStore();
        if (!policy) return originalDecay.call(plugin, rows, ...args);
        const protectedIds = new Set(policy.protectedNoteIds), idFor = row => this.runtime.fileIds.get(path.basename(String(row.fullPath || row.sourceFile || row.path || '').replaceAll('\\', '/')));
        const eligible = [], protectedRows = [], priorScores = new Map((rows || []).map(row => [row, row.score]));
        for (const row of rows || []) ((!idFor(row) || protectedIds.has(idFor(row))) ? protectedRows : eligible).push(row);
        // Preserve the original decay math and its explicit-time exemption.
        // Protected durable material retains its exact native score; no row is
        // assigned a fictitious source/time role or dropped because of age.
        const decayed = originalDecay.call(plugin, eligible, ...args);
        const output = [...protectedRows, ...decayed].sort((a, b) => (b.score || 0) - (a.score || 0));
        this.decayObservations.push({ policy: policy.schema, halfLifeDays: policy.halfLifeDays, minScore: policy.minScore,
          eligibleCount: eligible.length, protectedCount: protectedRows.length, results: output.map(row => ({ id: idFor(row), score: row.score,
            originalScore: priorScores.has(row) ? priorScores.get(row) : row.original_score ?? row.score, diffDays: row.diff_days, decayFactor: row.decay_factor,
            protected: protectedRows.includes(row), explicitTime: row.source === 'time' })) });
        return output;
      };
      this.observeMethod(plugin, '_applyTimeDecay', 'time_decay');
      const rerank = plugin._rerankDocuments;
      plugin._rerankDocuments = (...args) => {
        const mode = plugin.rerankConfig.useJev ? 'jev_rerank' : 'external_rerank';
        this.observedCalls[mode] = (this.observedCalls[mode] || 0) + 1;
        return rerank.apply(plugin, args);
      };
      this.observeMethod(plugin, '_expandChunksToFullDocuments', 'expand');
      this.observeMethod(plugin, '_applyAssociativeDiscovery', 'associate');
    } else if (name === 'LightMemo') {
      const rag = await this.load('RAGDiaryPlugin');
      await plugin.initialize(config, { ...dependencies, getSingleEmbedding: text => this.runtime.queryEmbedding(text),
        aiMemoBridge: rag.getAIMemoBridge() });
      const format = plugin.formatResults;
      plugin.formatResults = (rows, ...args) => { this.observeContextRows(rows, 'returned'); return format.call(plugin, rows, ...args); };
    } else if (name === 'VCPTimeLine') {
      const rag = await this.load('RAGDiaryPlugin');
      await plugin.initialize(config, { contextBridge: rag.getContextBridge() });
      if (this.configuration.chat) {
        const chat = this.configuration.chat;
        const url = new URL(chat.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid timeline chat endpoint.');
        plugin.config.model = chat.model;
        // Only the HTTP transport changes. Upstream owns prompts, monthly
        // grouping, chunking, summary publication and timeline injection.
        plugin.callModel = async (systemPrompt, userPrompt, maxTokens = plugin.config.maxOutputTokens) => {
          const base = url.toString().replace(/\/+$/u, '').replace(/\/v1$/u, '');
          const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chat.apiKey}` },
            body: JSON.stringify({ model: chat.model, stream: false, max_tokens: maxTokens,
              messages: [{ role: 'system', content: this.timelineOwner
                ? `${systemPrompt}\n\n宿主核验的记忆归属：${JSON.stringify(this.timelineOwner)}。当前整理对象和日记叙述者是伙伴「${this.timelineOwner.name}」；正文明确引用的用户发言、其他伙伴的经历和资料作者观点仍须保留原归属，不能把所有人物都改成这位伙伴。应用名称不是日记作者。日期作者行是来源中实际提供的经历日期，可能是虚拟世界日期，不得换成现实文件修改日期；月度归档的月末头也不是事件发生日期。资料只是阅读所得时，不得写成已经亲历的事件或掌握的技能。`
                : systemPrompt }, { role: 'user', content: userPrompt }] }) });
          if (!response.ok) throw new Error(`Timeline chat model returned ${response.status}.`);
          const payload = await response.json();
          const content = payload?.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) throw new Error('Timeline chat model returned no content.');
          return content.trim();
        };
      }
    } else await plugin.initialize(config, dependencies);
    this.plugins.set(name, plugin);
    return plugin;
  }
  async capabilities() {
    const result = {};
    for (const name of Object.keys(pluginFiles)) {
      const manifest = JSON.parse(await fs.readFile(path.join(this.runtime.runtimeRoot, 'Plugin', name, 'plugin-manifest.json'), 'utf8'));
      result[name] = { version: manifest.version, available: true };
    }
    // Read the original managers' actual loaded configuration, rather than
    // advertise a copied empty JSON file as an operational retrieval mode.
    const rag = await this.load('RAGDiaryPlugin');
    const vectorReady = vector => (Array.isArray(vector) || ArrayBuffer.isView(vector))
      && vector.length === this.runtime.embedding.dimension && Array.from(vector).every(Number.isFinite) && Array.from(vector).some(value => value !== 0);
    const groupNames = Object.entries(rag.semanticGroups.groups || {}).filter(([name, group]) => {
      const words = [...(Array.isArray(group.words) ? group.words : []), ...(Array.isArray(group.auto_learned) ? group.auto_learned : [])];
      return words.length > 0 && words.every(word => typeof word === 'string' && word.trim())
        && group.words_hash === rag.semanticGroups._getWordsHash(words) && vectorReady(rag.semanticGroups.groupVectorCache.get(name));
    }).map(([name]) => name);
    const chainNames = Object.entries(rag.metaThinkingManager.metaThinkingChains?.chains || {}).filter(([, chain]) => chain
      && Array.isArray(chain.clusters) && chain.clusters.length > 0 && chain.clusters.every(cluster => typeof cluster === 'string' && cluster.trim())
      && Array.isArray(chain.kSequence) && chain.kSequence.length === chain.clusters.length
      && chain.kSequence.every(k => Number.isInteger(k) && k >= 0 && k <= 100)).map(([name]) => name);
    const external = !rag.rerankConfig.useJev && !!(rag.rerankConfig.url && rag.rerankConfig.apiKey && rag.rerankConfig.model);
    const jev = rag.rerankConfig.useJev === true && rag.jevClient?.isConfigured?.() === true && typeof rag.jevClient.decide === 'function';
    const mode = (configured, enabledByDefault, exposure, cost, name, reason, configurations) => ({ available: !!configured, configured: !!configured,
      enabledByDefault, exposure, cost, observedCalls: this.observedCalls[name] || 0,
      ...(!configured && reason ? { reason } : {}), ...(configurations ? { configurations } : {}) });
    const modes = {
      river: mode(true, true, 'native_search_and_context', 'local_native_graph_query', 'river'),
      active: mode(true, true, 'LightMemo', 'query_embedding_and_native_query', 'LightMemo'),
      passive: mode(!!this.configuration.chat, true, 'RAGDiaryPlugin::RiverMemo::AIMemo+', 'query_embedding_and_focusing_model', 'RAGDiaryPlugin', '尚未配置全局聚焦模型。'),
      time: mode(typeof rag._getTimeRangeFilePathsCached === 'function', false, 'preprocess_suffix_only', 'additional_temporal_candidates', 'time', '原版时间候选接口不可用。'),
      time_decay: mode(typeof rag._applyTimeDecay === 'function', true, 'passive_context_policy_or_explicit_suffix', 'local_candidate_postprocessing', 'time_decay', '原版时间衰减接口不可用。'),
      semantic_group: mode(groupNames.length > 0, false, 'preprocess_suffix_only', 'configured_group_vectors_and_query_enhancement', 'semantic_group', '尚无内容与当前向量空间均已就绪的语义组。', groupNames),
      meta_thinking: mode(chainNames.length > 0, false, 'preprocess_marker_only', 'multiple_native_queries_and_theme_vectors', 'meta_thinking', '尚无阶段日记本及 K 序列完整的元思考链。', chainNames),
      expand: mode(typeof rag._expandChunksToFullDocuments === 'function', false, 'preprocess_suffix_only', 'full_source_documents_and_larger_context', 'expand', '原版全文展开接口不可用。'),
      associate: mode(typeof rag._applyAssociativeDiscovery === 'function', false, 'preprocess_suffix_only', 'additional_native_queries_per_seed', 'associate', '原版跨种子共现接口不可用。'),
      external_rerank: mode(external, false, 'preprocess_suffix_or_LightMemo_argument', 'external_reranker_requests', 'external_rerank', '尚未配置原版外部重排服务，或当前选用其他重排引擎。'),
      jev_rerank: mode(jev, false, 'preprocess_suffix_only', 'shared_decision_service_requests', 'jev_rerank', '尚未注入已配置的原版共享 Jev 决策客户端。'),
      timeline: mode(!!this.configuration.chat, false, 'explicit_background_monthly_generation', 'monthly_model_generation', 'timeline', '尚未配置月度时间线生成模型。'),
    };
    return { plugins: result, timelineGenerationConfigured: Boolean(this.configuration.chat), coldKnowledge: false, modes,
      behavior: this.runtime.behavior };
  }
  async call(name, arguments_) {
    if (!['DailyNote', 'DailyNoteManager', 'LightMemo'].includes(name) || !arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error('Invalid VCP memory plugin call.');
    const plugin = await this.load(name);
    if (name !== 'LightMemo') this.invalidateCorpus();
    this.beginContext();
    this.observedCalls[name] = (this.observedCalls[name] || 0) + 1;
    if (name === 'LightMemo') { await this.validateExistingTimelines(); await this.runtime.ensureArtifacts(); }
    const result = await this.queryEnvironment(() => plugin.processToolCall(arguments_));
    const paths = this.runtime.kb.databaseCoordinator.extractMutationPaths(result);
    if (paths.upserts.length || paths.deletes.length) {
      await this.runtime.kb.databaseCoordinator.awaitDeletedFilePaths(paths.deletes, { timeoutMs: 120000 });
      await this.runtime.kb.databaseCoordinator.awaitIndexedFilePaths(paths.upserts, { timeoutMs: 120000 });
      await this.runtime.reconcilePluginMutations(paths);
      this.runtime.artifactsDirty = true;
    }
    return { result, indexed: paths.upserts.length + paths.deletes.length > 0, contextReferences: this.contextReferences,
      contextReferenceCoverage: this.unmappedContextSources ? 'partial' : 'observed' };
  }
  async preprocess(messages, clock, automaticDecay) {
    if (automaticDecay !== undefined && (!automaticDecay || automaticDecay.schema !== 'episodic-v1' || automaticDecay.halfLifeDays !== 180 || automaticDecay.minScore !== 0
      || !Array.isArray(automaticDecay.protectedNoteIds) || automaticDecay.protectedNoteIds.length > this.runtime.records.size
      || new Set(automaticDecay.protectedNoteIds).size !== automaticDecay.protectedNoteIds.length
      || automaticDecay.protectedNoteIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 4096
        || this.runtime.records.get(id)?.indexState !== 'indexed' || this.runtime.records.get(id)?.deleted))) throw new Error('Invalid VCP automatic decay policy.');
    return this.decayPolicy.run(automaticDecay, () => this.ragClock.run(clock, () => this.preprocessWithClock(messages)));
  }
  async preprocessWithClock(messages) {
    if (!Array.isArray(messages) || messages.some(message => !message || typeof message.role !== 'string' || !(typeof message.content === 'string' || Array.isArray(message.content)))) throw new Error('Invalid VCP message input.');
    if (messages.some(message => typeof message.content === 'string' && message.content.includes('::AIMemo+')) && !this.configuration.chat) throw new Error('Passive memory focusing requires the global chat model.');
    this.events = [];
    this.decayObservations = [];
    this.parsedTimeRanges = [];
    const rag = await this.load('RAGDiaryPlugin');
    const timeline = await this.load('VCPTimeLine');
    await this.validateTimelines(timeline);
    // Source fingerprints omit scores and query-relative time. Keep embedding
    // caches intact, but partition generated/focused answers by civil day,
    // timezone and the actual policy. Half-second realtime queries reuse them.
    const clock = this.ragClock.current(), policy = this.decayPolicy.getStore(), timeZone = clock?.timeZone || rag.timeParser.defaultTimezone;
    const timeModifiers = messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    let timeIdentity = [];
    if (/::Time/iu.test(timeModifiers)) {
      // Use the exact upstream latest-user selection and sanitizer. A relative
      // range can move within one civil day, so the day alone is not a key.
      const { findLastRealUserMessage } = require(path.join(this.runtime.runtimeRoot, 'modules/messageProcessor.js'));
      const user = findLastRealUserMessage(messages, { sanitize: rag.sanitizeForEmbedding.bind(rag) });
      timeIdentity = rag.timeParser.parse(user.sanitizedContent || '').map(range => [range.start.toISOString(), range.end.toISOString()]);
      // Unsupported explicit Time syntax must remain conservative. TimeDecay's
      // original day-based age computation alone does not require this fallback.
      if (!timeIdentity.length && /::Time(?!Decay)(?:\d*\.?\d+)?(?=$|::|[^\p{L}\p{N}_.])/iu.test(timeModifiers))
        timeIdentity = [['unparsed-explicit-time', clock?.now || new Date().toISOString()]];
    }
    const clockBucket = JSON.stringify([clock ? 'world' : 'real', new Intl.DateTimeFormat('sv', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(clock?.now || Date.now())), timeZone, policy?.schema || null, [...policy?.protectedNoteIds || []].sort(), timeIdentity]);
    const cacheClockInvalidated = this.cacheClockBucket !== clockBucket;
    if (cacheClockInvalidated) { rag.cacheManager.clear('aimemo'); rag.cacheManager.clear('query'); this.cacheClockBucket = clockBucket; }
    const epoch = this.corpusEpoch;
    const cacheKey = createHash('sha256').update(JSON.stringify({ messages, clockBucket, automaticDecay: policy || null, corpusEpoch: epoch })).digest('hex');
    const cached = this.preprocessReceipts.get(cacheKey);
    if (cached) {
      this.preprocessReceipts.delete(cacheKey); this.preprocessReceipts.set(cacheKey, cached);
      const receipt = JSON.parse(cached.serialized);
      this.events = receipt.events; this.contextReferences = receipt.contextReferences;
      this.decayObservations = receipt.automaticDecay; this.parsedTimeRanges = receipt.parsedTimeRanges;
      return { ...receipt, queryClock: clock, cacheClock: { bucket: clockBucket, invalidated: cacheClockInvalidated },
        receiptCache: { hit: true, corpusEpoch: epoch, ...(receipt.queryClock ? { sourceQueryClock: receipt.queryClock } : {}) } };
    }
    this.beginContext();
    this.observeRawContextOutput = !messages.some(message => typeof message.content === 'string'
      && /::AIMemo\+|\[\[AIMemo\s*=\s*True\]\]/iu.test(message.content));
    this.observedCalls.RAGDiaryPlugin = (this.observedCalls.RAGDiaryPlugin || 0) + 1;
    if ((await this.runtime.kb.listDistinctDiaries()).length) await this.runtime.ensureArtifacts();
    const output = await this.queryEnvironment(async () => {
      const processed = await rag.processMessages(messages, {});
      return timeline.processMessages(processed);
    });
    const receipt = { messages: output, events: this.events, contextReferences: this.contextReferences, queryClock: this.ragClock.current(), automaticDecay: this.decayObservations, parsedTimeRanges: this.parsedTimeRanges,
      cacheClock: { bucket: clockBucket, invalidated: cacheClockInvalidated },
      contextReferenceCoverage: this.unmappedContextSources ? 'partial' : 'observed', receiptCache: { hit: false, corpusEpoch: epoch } };
    this.cacheReceipt(cacheKey, receipt, epoch);
    return receipt;
  }
  async validateExistingTimelines() {
    if ((await this.runtime.kb.listDistinctDiaries()).some(folder => /timeline$/iu.test(folder))) {
      await this.validateTimelines(await this.load('VCPTimeLine'));
    }
  }
  async timeline(request) {
    const operations = ['listAgents', 'getAgentDetail', 'generateTimelines', 'generateSummaries', 'saveTimelineFile', 'saveSummary'];
    if (!request || !operations.includes(request.operation)) throw new Error('Unknown VCP timeline operation.');
    const plugin = await this.load('VCPTimeLine');
    if (request.operation === 'listAgents') return plugin.listAgents();
    if (typeof request.agentName !== 'string' || !request.agentName.trim()) throw new Error('Timeline agent name is required.');
    if (request.owner && (request.owner.version !== 2 || !/^[a-zA-Z0-9_-]{1,100}$/u.test(request.owner.companionId)
      || typeof request.owner.name !== 'string' || !request.owner.name.trim() || request.owner.agentName !== request.agentName)) throw new Error('Timeline owner identity does not match its agent.');
    await this.bindTimelineAgent(plugin, request.agentName);
    if (request.operation.startsWith('generate') && !this.configuration.chat) throw new Error('Timeline generation requires a configured chat model endpoint.');
    if (request.operation === 'getAgentDetail') return plugin.getAgentDetail(request.agentName);
    if (request.operation === 'generateTimelines' || request.operation === 'generateSummaries') {
      this.invalidateCorpus();
      await this.validateTimelines(plugin);
      const sources = await plugin.discoverMemories(request.agentName, request.options?.startMonth, request.options?.endMonth);
      const previousOwner = this.timelineOwner;
      this.timelineOwner = request.owner;
      let result;
      try { result = await plugin[request.operation](request.agentName, request.options || {}); }
      finally { this.timelineOwner = previousOwner; }
      const dependencies = await this.readDependencies();
      dependencies[request.agentName] ||= {};
      for (const month of result.generated || []) dependencies[request.agentName][month] = this.sourcesDigest(request.agentName, month, sources.get(month) || []);
      await this.writeDependencies(dependencies);
      await this.indexTimelineFiles(plugin, request.agentName, result.generated || []);
      return result;
    }
    if (typeof request.month !== 'string' || !/^\d{4}-\d{2}$/u.test(request.month) || typeof request.content !== 'string') throw new Error('Timeline month and content are required.');
    this.invalidateCorpus();
    const result = await plugin[request.operation](request.agentName, request.month, request.content);
    const dependencies = await this.readDependencies();
    dependencies[request.agentName] ||= {};
    dependencies[request.agentName][request.month] = await this.monthDigest(plugin, request.agentName, request.month);
    await this.writeDependencies(dependencies);
    if (request.operation === 'saveTimelineFile') await this.indexTimelineFiles(plugin, request.agentName, [request.month]);
    return result;
  }
  async bindTimelineAgent(plugin, agentName) {
    if (['__proto__', 'constructor', 'prototype'].includes(agentName)) throw new Error('Invalid timeline agent name.');
    plugin.safeAgentName(agentName);
    plugin.config.agentFolders ||= {};
    const folders = await this.runtime.kb.listDistinctDiaries();
    plugin.config.agentFolders[agentName] = [...new Set(folders.filter(folder => typeof folder === 'string' && !/timeline$/iu.test(folder)))];
  }
  sourcesDigest(agentName, month, sources) {
    return createHash('sha256').update(JSON.stringify({ agentName, month, sources })).digest('hex');
  }
  async monthDigest(plugin, agentName, month) {
    await this.bindTimelineAgent(plugin, agentName);
    const sources = await plugin.discoverMemories(agentName, month, month);
    return this.sourcesDigest(agentName, month, sources.get(month) || []);
  }
  async readDependencies() {
    try { return JSON.parse(await fs.readFile(this.dependenciesPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async writeDependencies(value) {
    const temporary = `${this.dependenciesPath}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value), 'utf8'); await fs.rename(temporary, this.dependenciesPath); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async indexTimelineFiles(plugin, agentName, months) {
    const files = months.map(month => path.join(plugin.getTimelineDir(agentName), `${month}.md`));
    if (files.length) {
      await this.runtime.kb.databaseCoordinator.awaitIndexedFilePaths(files, { timeoutMs: 120000 });
      this.runtime.artifactsDirty = true;
    }
  }
  async validateTimelines(plugin) {
    const dependencies = await this.readDependencies();
    const summaries = await plugin.readSummaryStore();
    let changed = false;
    const deletes = [];
    for (const agentName of await plugin.listAgents()) {
      const files = await plugin.listTimelineFiles(agentName);
      const months = new Set([...files.map(file => file.month), ...Object.keys(summaries[agentName] || {})]);
      for (const month of months) {
        if (dependencies[agentName]?.[month] === await this.monthDigest(plugin, agentName, month)) continue;
        if (!changed) this.invalidateCorpus();
        const file = files.find(candidate => candidate.month === month);
        if (file) { await fs.rm(file.fullPath, { force: true }); deletes.push(file.fullPath); }
        if (summaries[agentName]) delete summaries[agentName][month];
        if (dependencies[agentName]) delete dependencies[agentName][month];
        changed = true;
      }
    }
    if (changed) {
      await plugin.writeJsonAtomic(plugin.getSummaryPath(), summaries);
      await this.writeDependencies(dependencies);
      await this.runtime.kb.databaseCoordinator.awaitDeletedFilePaths(deletes, { timeoutMs: 120000 });
      this.runtime.artifactsDirty = true;
    }
  }
  async exportTimelines(sourceRevision) {
    if (typeof sourceRevision !== 'string' || !sourceRevision) throw new Error('Timeline source revision is required.');
    const plugin = await this.load('VCPTimeLine');
    await this.validateTimelines(plugin);
    const dependencies = await this.readDependencies();
    const summaries = await plugin.readSummaryStore();
    const agents = [];
    for (const agentName of await plugin.listAgents()) {
      const files = await plugin.listTimelineFiles(agentName);
      const months = [...new Set([...files.map(file => file.month), ...Object.keys(summaries[agentName] || {})])].sort();
      agents.push({ agentName, months: months.filter(month => dependencies[agentName]?.[month]).map(month => ({ month,
        sourceDigest: dependencies[agentName][month], content: files.find(file => file.month === month)?.content,
        summary: summaries[agentName]?.[month] })) });
    }
    return { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision, calendarTimeZone: this.calendarTimeZone(), agents };
  }
  calendarTimeZone() {
    const zones = new Set([...this.runtime.records.values()].filter(record => record.indexState === 'indexed' && !record.deleted)
      .map(record => record.hostProjection?.timeZone || 'Asia/Shanghai'));
    if (zones.size > 1) throw new Error('A timeline scope must use one projected calendar timezone.');
    return [...zones][0] || 'Asia/Shanghai';
  }
  async importTimelines(sourceRevision, artifacts) {
    if (typeof sourceRevision !== 'string' || !sourceRevision || artifacts?.schema !== 'worldlinebox.vcp-timeline-artifacts' || !Array.isArray(artifacts.agents)) throw new Error('Invalid VCP timeline artifacts.');
    // Month labels and source hashes belong to the projection's civil calendar.
    // Never import a Shanghai January summary into the same event's UTC December.
    if ((artifacts.calendarTimeZone || 'Asia/Shanghai') !== this.calendarTimeZone()) return { acceptedMonths: 0,
      skippedMonths: artifacts.agents.reduce((count, agent) => count + (Array.isArray(agent.months) ? agent.months.length : 0), 0) };
    const plugin = await this.load('VCPTimeLine');
    const dependencies = await this.readDependencies();
    const summaries = await plugin.readSummaryStore();
    let changed = false;
    let acceptedMonths = 0, skippedMonths = 0;
    for (const agent of artifacts.agents) {
      await this.bindTimelineAgent(plugin, agent.agentName);
      if (!Array.isArray(agent.months)) throw new Error('Invalid VCP timeline months.');
      const files = new Map((await plugin.listTimelineFiles(agent.agentName)).map(file => [file.month, file.content]));
      for (const artifact of agent.months) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(artifact.month) || !/^[a-f0-9]{64}$/u.test(artifact.sourceDigest)) throw new Error('Invalid VCP timeline dependency.');
        if (artifact.sourceDigest !== await this.monthDigest(plugin, agent.agentName, artifact.month)) { skippedMonths++; continue; }
        const contentChanged = typeof artifact.content === 'string' && files.get(artifact.month) !== artifact.content;
        const summaryChanged = typeof artifact.summary === 'string' && summaries[agent.agentName]?.[artifact.month] !== artifact.summary;
        const dependencyChanged = dependencies[agent.agentName]?.[artifact.month] !== artifact.sourceDigest;
        if (contentChanged || summaryChanged || dependencyChanged) {
          if (!changed) this.invalidateCorpus();
          changed = true;
          if (contentChanged) { await plugin.saveTimelineFile(agent.agentName, artifact.month, artifact.content); files.set(artifact.month, artifact.content); }
          if (summaryChanged) { await plugin.saveSummary(agent.agentName, artifact.month, artifact.summary); summaries[agent.agentName] ||= {}; summaries[agent.agentName][artifact.month] = artifact.summary; }
        }
        dependencies[agent.agentName] ||= {};
        dependencies[agent.agentName][artifact.month] = artifact.sourceDigest;
        if (contentChanged) await this.indexTimelineFiles(plugin, agent.agentName, [artifact.month]);
        acceptedMonths++;
      }
    }
    if (changed) await this.writeDependencies(dependencies);
    await this.validateTimelines(plugin);
    return { acceptedMonths, skippedMonths };
  }
  async close() {
    this.preprocessReceipts.clear(); this.preprocessReceiptBytes = 0;
    for (const name of ['LightMemo', 'DailyNote', 'DailyNoteManager', 'RAGDiaryPlugin']) await this.plugins.get(name)?.shutdown?.();
    this.plugins.clear();
  }
}

module.exports = { VcpMemoryPeripherals, createRagQueryClock };
