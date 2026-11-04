'use strict';
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');

const PRIVATE_KEY = /^(?:apiKey|api_key|API_Key|authorization|password|secret|authToken|headers|RerankApi)$/i;
const VECTOR_KEY = /^(?:vector|queryVector|originalVector|denoisedVector|localVector|transferVector|ghostVectors|nativeSupplementalVectors|supplementalQueryVectors)$/;
// A transport snapshot, never a scorer. Numeric values and array order are
// copied without normalization, clipping, rounding, merging or sorting.
function snapshot(value, seen = new WeakSet(), key = '') {
  if (PRIVATE_KEY.test(key)) return '[redacted]';
  if (VECTOR_KEY.test(key)) return { omitted: 'embedding-vector' };
  if (value === undefined) return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return /^data:[^,]+;base64,/.test(value) ? '[omitted:base64-media]' : value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return null;
  if (ArrayBuffer.isView(value)) return { omitted: 'binary-or-vector', type: value.constructor.name, length: value.length ?? value.byteLength };
  if (seen.has(value)) return '[omitted:cycle]';
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map(item => snapshot(item, seen));
  else {
    result = {};
    for (const [field, item] of Object.entries(value)) result[field] = snapshot(item, seen, field);
  }
  seen.delete(value);
  return result;
}
function decoded(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function requestSummary(args) {
  const query = args[0];
  const options = args[1];
  return { query: query && typeof query === 'object' ? { text: query.text ?? null } : typeof query === 'string' ? query : null,
    options: snapshot(options && typeof options === 'object' ? Object.fromEntries(Object.entries(options).filter(([key]) =>
      ['scope','engineMode','enginemode','mode','k','topK','candidateK','abMode','useBm25','folder','maid','diaryNames','coreTags','includeTrace','include_trace','minScore','timeRange'].includes(key))) : null) };
}
function nativePlan(args, index = 0) { return snapshot(decoded(args[index])); }
function rankedInput(args) { return { query: args[0], candidates: snapshot(args[1]), requestedK: args[2] ?? null, rrfOptions: snapshot(args[3]) }; }
function nativeTraceArguments(args, index, nested = false) {
  if (typeof args[index] !== 'string') return null;
  const plan = decoded(args[index]);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const target = nested ? plan.riverInput : plan;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const fieldPresent = Object.hasOwn(target, 'includeTrace');
  const original = target.includeTrace;
  const next = { ...target, includeTrace: true };
  const observed = nested ? { ...plan, riverInput: next } : next;
  const effective = args.slice(); effective[index] = JSON.stringify(observed);
  return { args: effective, detail: { sourceFlag: nested ? 'riverInput.includeTrace' : 'includeTrace',
    originalFieldPresent: fieldPresent, originalValue: original ?? null, observedValue: true,
    purpose: 'original-native-serialization-only', scoringParametersChanged: false } };
}

class TelemetryCollector {
  constructor() { this.scope = new AsyncLocalStorage(); this.wrappers = new WeakMap(); this.active = null; }
  start({ enabled = true } = {}) {
    this.active = enabled ? { schema: 'vcp-memory-trace-v1', enabled: true, spans: [], unavailableHooks: [] } : null;
    return this.active;
  }
  finish() {
    const trace = this.active;
    if (!trace) return { schema: 'vcp-memory-trace-v1', enabled: false, spans: [] };
    const native = trace.spans.filter(span => span.stage.startsWith('native.'));
    const latestLight = [...native].reverse().find(span => span.stage === 'native.lightmemo');
    const availability = {};
    for (const [name, matches] of Object.entries({
      bm25: ['native.lightmemo', 'rag.bm25-candidates'], river: ['native.river', 'native.river-hybrid', 'native.river-topology', 'native.lightmemo'],
      rerank: ['native.external-rerank','native.parallel-rerank','lightmemo.rerank','rag.rerank'],
      jev: ['lightmemo.jev','rag.jev'],
    })) availability[name] = { status: trace.spans.some(span => matches.includes(span.stage)) ? 'hook_observed' : 'not_observed', raw: null };
    if (latestLight?.input?.engineMode === 'knn') availability.river.status = 'disabled';
    if (latestLight?.input?.useBm25 === false) availability.bm25.status = 'disabled';
    trace.availability = availability;
    return snapshot(trace);
  }
  wrap(object, method, specification) {
    if (!object || typeof object[method] !== 'function') return false;
    let methods = this.wrappers.get(object);
    if (!methods) { methods = new Map(); this.wrappers.set(object, methods); }
    if (methods.get(method) === object[method]) return true;
    const original = object[method];
    const collector = this;
    function observed(...args) {
      const parent = collector.scope.getStore();
      const trace = parent?.trace || collector.active;
      if (!trace) return Reflect.apply(original, this, args);
      if (specification.when && !specification.when(args, parent)) return Reflect.apply(original, this, args);
      const span = { id: trace.spans.length + 1, parentId: parent?.trace === trace ? parent.id : null,
        stage: specification.stage, source: specification.source, status: 'running',
        hostTiming: { durationMs: null, clock: 'performance.now', scope: 'boundary-inclusive', reportedBy: 'standalone-host' },
        input: null, raw: null };
      trace.spans.push(span);
      try { if (specification.input) span.input = snapshot(specification.input(args)); } catch { span.input = null; }
      let effectiveArgs = args;
      if (specification.diagnosticArgs) {
        try {
          const prepared = specification.diagnosticArgs(args);
          if (prepared) { effectiveArgs = prepared.args; span.diagnosticOptions = snapshot(prepared.detail); }
        } catch { span.diagnosticPreparationError = 'Diagnostic option could not be prepared; original arguments used'; }
      }
      const started = performance.now();
      const success = value => {
        span.hostTiming.durationMs = performance.now() - started;
        span.status = 'completed';
        try { if (specification.output !== false) span.raw = snapshot(specification.output ? specification.output(value, args) : decoded(value)); }
        catch { span.captureError = 'Source result could not be serialized; returned result remains unchanged'; }
        return value;
      };
      const failure = error => {
        span.hostTiming.durationMs = performance.now() - started; span.status = 'failed';
        span.error = { code: error?.code || null, message: error?.message || 'Operation failed' };
        throw error;
      };
      return collector.scope.run({ trace, id: span.id, stage: span.stage }, () => {
        try {
          const result = Reflect.apply(original, this, effectiveArgs);
          return result && typeof result.then === 'function' ? result.then(success, failure) : success(result);
        } catch (error) { return failure(error); }
      });
    }
    try { object[method] = observed; }
    catch {
      if (this.active) this.active.unavailableHooks.push({ source: specification.source, method, reason: 'read-only method' });
      return false;
    }
    if (object[method] !== observed) return false;
    methods.set(method, observed);
    return true;
  }
}

function attachKnowledge(collector, kb) {
  const source = 'upstream/toolbox/KnowledgeBaseManager.js';
  for (const [method, stage] of Object.entries({ initialize: 'knowledge.initialize', executeLightMemoQuery: 'knowledge.lightmemo', executeNativeRiverQuery: 'knowledge.river-query',
    executeExternalRerank: 'knowledge.external-rerank', executeParallelRerank: 'knowledge.parallel-rerank',
    search: 'knowledge.search', searchMany: 'knowledge.search-many', searchKnn: 'knowledge.knn', searchKnnMany: 'knowledge.knn-many',
    _flushBatch: 'ingestion.flush', _flushDeleteBatch: 'ingestion.delete', prepareIngestionText: 'ingestion.prepare',
    probeIngestionFiles: 'ingestion.probe', commitIngestionBatch: 'ingestion.commit', commitDeleteBatch: 'ingestion.delete-commit',
    _getOrLoadDiaryIndex: 'index.load', deduplicateResults: 'retrieval.deduplicate',
  })) collector.wrap(kb, method, { source: `${source}#${method}`, stage, input: requestSummary,
    output: ['initialize','_flushBatch','_flushDeleteBatch','_getOrLoadDiaryIndex','prepareIngestionText'].includes(method) ? false : undefined });
  const native = kb?.nativeKnowledgeRuntime;
  for (const [method, stage, input] of [
    ['executeLightMemoQuery','native.lightmemo', args => nativePlan(args)],
    ['executeRiverQuery','native.river', args => ({ diaryNames: args[3], input: nativePlan(args, 2) })],
    ['executeRiverQueryHybrid','native.river-hybrid', args => ({ diaryNames: args[3], input: nativePlan(args, 2), hybridPlan: nativePlan(args, 6) })],
    ['executeExternalRerank','native.external-rerank', args => nativePlan(args)],
    ['executeParallelRerank','native.parallel-rerank', args => nativePlan(args)],
  ]) collector.wrap(native, method, { source: `upstream/toolbox/rust-vexus-lite/src/${method === 'executeLightMemoQuery' ? 'light_memo.rs' : 'knowledge_runtime.rs'}#${method}`, stage, input,
    diagnosticArgs: method === 'executeLightMemoQuery' ? args => nativeTraceArguments(args, 0, true)
      : ['executeRiverQuery','executeRiverQueryHybrid'].includes(method) ? args => nativeTraceArguments(args, 2) : undefined });
  for (const [method, stage] of [['runMemoPipeline','native.memo-observation'],['rerankRivermemoTopologyV3','native.river-topology']])
    collector.wrap(kb?.tagIndex, method, { source: `upstream/toolbox/rust-vexus-lite/src/lib.rs#${method}`, stage,
      input: args => nativePlan(args, 2), output: value => method === 'runMemoPipeline' ? { metadata: decoded(value?.metadataJson) } : decoded(value),
      diagnosticArgs: method === 'rerankRivermemoTopologyV3' ? args => nativeTraceArguments(args, 2) : undefined });
}

function attachPlugin(collector, name, plugin) {
  const source = `upstream/toolbox/Plugin/${name}`;
  for (const method of ['initialize','processMessages','processToolCall']) collector.wrap(plugin, method, {
    stage: `plugin.${name}.${method}`, source: `${source}#${method}`, output: false,
    input: method === 'processToolCall' ? args => snapshot(args[0]) : undefined,
  });
  if (name === 'LightMemo') {
    collector.wrap(plugin, '_rerankDocuments', { source: `${source}/LightMemo.js#_rerankDocuments`, stage: 'lightmemo.rerank', input: rankedInput });
    collector.wrap(plugin, '_jevRerankDocuments', { source: `${source}/LightMemo.js#_jevRerankDocuments`, stage: 'lightmemo.jev', input: rankedInput });
    collector.wrap(plugin, 'formatResults', { source: `${source}/LightMemo.js#formatResults`, stage: 'lightmemo.final-candidates',
      input: args => ({ query: args[1], candidates: snapshot(args[0]) }), output: false });
    collector.wrap(plugin, '_summarizeWithAIMemo', { source: `${source}/LightMemo.js#_summarizeWithAIMemo`, stage: 'lightmemo.pre-aimemo-candidates',
      input: args => snapshot(args[0]), output: false });
  }
  if (name === 'RAGDiaryPlugin') {
    for (const [method, stage] of [['_rerankDocuments','rag.rerank'],['_rerankDocumentsWithJev','rag.jev']]) collector.wrap(plugin, method, {
      source: `${source}/RAGDiaryPlugin.js#${method}`, stage, input: rankedInput });
    for (const [method, stage] of [['_getBM25FileCandidates','rag.bm25-candidates'],['_rerankRAGCandidatesWithRiverMemo','rag.river-rerank']]) collector.wrap(plugin, method, {
      source: `${source}/RAGDiaryPlugin.js#${method}`, stage, input: args => snapshot(args[0]) });
    collector.wrap(plugin, 'getSingleEmbeddingCached', { source: `${source}/RAGDiaryPlugin.js#getSingleEmbeddingCached`, stage: 'embedding.query-cache-or-provider', output: false });
    const direct = plugin.directDiaryTextProcessor;
    for (const method of ['getBM25DiaryCandidates','processContent']) collector.wrap(direct, method, { source: `${source}/DirectDiaryTextProcessor.js#${method}`,
      stage: `direct-diary.${method}`, output: method === 'processContent' ? false : undefined });
  }
}
function attachCold(collector, cold) {
  for (const method of ['search','searchWithVector','searchLibrary','upsertFile','deleteFile','_runQueueWorker']) collector.wrap(cold, method, {
    source: `upstream/toolbox/TDBKnowledge.js#${method}`, stage: `cold.${method}`,
    input: method === 'search' ? requestSummary : undefined,
    output: ['_runQueueWorker'].includes(method) ? false : undefined,
  });
}
module.exports = { TelemetryCollector, snapshot, attachKnowledge, attachPlugin, attachCold, requestSummary, nativeTraceArguments };
