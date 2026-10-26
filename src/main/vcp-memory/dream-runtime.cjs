/* global require, module */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const DAY = 86400000;
const normalized = value => String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
const failure = message => Object.assign(new Error(message), { code: 'VCP_MEMORY_DREAM_INVALID' });

/** Original orchestration/math runs unchanged. Only ownership, authoritative
 * event times, file I/O and each query's candidate domain are host adapters. */
async function generateDreamWave(runtime, request) {
  runtime.requireReady();
  if (!request?.owner?.companionId || !request.owner.agentName || !request.sourceRevision
    || !['world', 'real'].includes(request.clockDomain) || !Number.isFinite(Date.parse(request.now)) || !Array.isArray(request.notes)) throw failure('Invalid DreamWave read set.');
  const now = Date.parse(request.now), entries = new Map(), relativePaths = new Map(), absolutePaths = new Map();
  for (const descriptor of request.notes) {
    if (entries.has(descriptor.id)) throw failure('Duplicate DreamWave note identity.');
    const record = runtime.records.get(descriptor.id), owner = record?.metadata?.hostMemoryOwner;
    if (!record || record.deleted || record.indexState !== 'indexed' || owner?.companionId !== request.owner.companionId
      || owner.agentName !== request.owner.agentName || owner.name !== request.owner.name
      || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1
      || record.metadata.hostMemoryVersion !== descriptor.version || record.contentHash !== descriptor.contentHash) throw failure('DreamWave memory owner, version or content has changed.');
    if (!['world', 'real'].includes(descriptor.clockDomain) || !Number.isFinite(Date.parse(descriptor.eventTime))) throw failure('DreamWave memory event time is invalid.');
    if (record.metadata?.dream || descriptor.clockDomain !== request.clockDomain || Date.parse(descriptor.eventTime) > now) continue;
    const filePath = runtime.notePaths.get(descriptor.id);
    if (!filePath) throw failure('DreamWave memory has no indexed path.');
    const relative = normalized(path.relative(runtime.notesRoot, filePath));
    if (!relative || relative.split('/').includes('..') || path.isAbsolute(relative)) throw failure('DreamWave path escaped its authorized graph.');
    const entry = { ...descriptor, filePath, relative, record, ageDays: (now - Date.parse(descriptor.eventTime)) / DAY };
    entries.set(entry.id, entry); relativePaths.set(relative, entry); absolutePaths.set(runtime.sourceKey(filePath), entry);
  }
  const lookup = file => typeof file === 'string' && file ? relativePaths.get(normalized(file)) || absolutePaths.get(runtime.sourceKey(file)) : undefined;
  const kb = runtime.kb;
  if (typeof kb.getChunksByFilePaths !== 'function' || typeof kb.executeNativeRiverQuery !== 'function') throw failure('Original native DreamWave interfaces are unavailable.');
  await runtime.ensureArtifacts();
  // Hydrate metadata in bounded batches, discard non-seed vector payloads, and
  // keep vectors inside this process. No new embedding request is needed.
  const files = [...entries.values()];
  for (let offset = 0; offset < files.length; offset += 100) {
    const chunks = await kb.getChunksByFilePaths(files.slice(offset, offset + 100).map(entry => entry.relative));
    for (const chunk of chunks) {
      const entry = lookup(chunk.fullPath || chunk.sourceFile);
      if (entry && Number.isSafeInteger(Number(chunk.fileId)) && Number(chunk.fileId) > 0) entry.fileId = Number(chunk.fileId);
    }
  }
  const queries = [];
  const OriginalEngine = require(path.join(runtime.runtimeRoot, 'Plugin/AgentDream/DreamWaveEngine.js'));
  let engine;
  const facade = {
    config: kb.config,
    getChunksByFilePaths: async paths => {
      const known = [...new Set(paths.map(lookup).filter(Boolean).map(entry => entry.relative))];
      if (!known.length) return [];
      return (await kb.getChunksByFilePaths(known)).filter(chunk => !!lookup(chunk.fullPath || chunk.sourceFile));
    },
    executeNativeRiverQuery: async (query, options) => {
      const allowed = engine.candidates(), allowedIds = new Set(allowed.map(entry => entry.id));
      const allowedFiles = new Set(allowed.map(entry => entry.fileId));
      let result = { results: [] };
      if (allowed.length) {
        // This upstream revision's native joint branch builds agentContext from
        // getFileIdsByDiaries and does not apply options.allowedFileIds there.
        // Narrow that authoritative getter as well, before ANN and Topology V3.
        // The original method and native math stay byte-for-byte unchanged.
        const scopedKb = Object.create(kb);
        if (typeof kb.getFileIdsByDiaries === 'function') scopedKb.getFileIdsByDiaries = async names =>
          (await kb.getFileIdsByDiaries(names)).filter(id => allowedFiles.has(Number(id)));
        result = await kb.withMemoObservationScope(() => kb.executeNativeRiverQuery.call(scopedKb, query, {
          // The joint ABI applies allowed_file_ids after semantic dedup. Use
          // upstream's complete scoped candidate path, then original native
          // Topology V3, until that ABI supports the temporal scope before ANN.
          ...options, allowedFileIds: [...allowedFiles], enabled: false, fallbackToLegacy: false,
        }));
      }
      const results = (result.results || []).filter(hit => allowedIds.has(lookup(hit.fullPath || hit.sourceFile)?.id));
      const engineName = result.diagnostics?.degraded || result.diagnostics?.retrievalEngine === 'knn' ? 'knn' : 'rivermemo';
      queries.push({ phase: engine.phase, allowedNoteIds: allowed.map(entry => entry.id), returnedNoteIds: results.map(hit => lookup(hit.fullPath || hit.sourceFile).id),
        engine: engineName, candidateMode: engineName === 'rivermemo' ? 'scoped-topology-v3' : 'scoped-knn' });
      return { ...result, results };
    },
    searchKnn: async (indices, vector, k) => {
      const allowed = engine.candidates(), allowedIds = new Set(allowed.map(entry => entry.id));
      if (typeof kb.searchKnn !== 'function') throw failure('Original DreamWave fallback is unavailable.');
      const hits = allowed.length ? await kb.searchKnn(indices, vector, k, { allowedFileIds: allowed.map(entry => entry.fileId) }) : [];
      const results = hits.filter(hit => allowedIds.has(lookup(hit.fullPath || hit.sourceFile)?.id));
      queries.push({ phase: engine.phase, allowedNoteIds: allowed.map(entry => entry.id), returnedNoteIds: results.map(hit => lookup(hit.fullPath || hit.sourceFile).id), engine: 'knn', candidateMode: 'scoped-knn' });
      return results;
    },
  };
  class AuthorizedDreamWave extends OriginalEngine {
    constructor() { super(facade); this.phase = 'recent'; this.vectorOrigins = new WeakSet(); }
    async _getTimelineBuckets() {
      const all = [...entries.values()];
      const count = (from, to) => all.filter(entry => entry.ageDays >= from && entry.ageDays <= to).length;
      let recentBoundary = 7, midBoundary = 90;
      while (count(0, recentBoundary) < 3 && recentBoundary < 30) recentBoundary += 7;
      recentBoundary = Math.min(recentBoundary, 30);
      while (count(recentBoundary + 1, midBoundary) < 2 && midBoundary < 180) midBoundary += 30;
      midBoundary = Math.min(midBoundary, 180);
      const bucket = entries => entries.map(entry => ({ filePath: entry.filePath, mtime: Date.parse(entry.eventTime), size: entry.record.contentBytes, ageDays: entry.ageDays }))
        .sort((a, b) => b.mtime - a.mtime);
      this.buckets = { recent: bucket(all.filter(entry => entry.ageDays <= recentBoundary)),
        mid: bucket(all.filter(entry => entry.ageDays > recentBoundary && entry.ageDays <= midBoundary)),
        deep: bucket(all.filter(entry => entry.ageDays > midBoundary)), recentBoundary, midBoundary };
      return this.buckets;
    }
    _sample(array, count) {
      if (array === this.buckets.recent) this.phase = 'recent';
      else if (array === this.buckets.mid) this.phase = 'mid';
      return super._sample(array, count);
    }
    _getSearchableIndexNames() { return [...new Set([...entries.values()].map(entry => entry.relative.split('/')[0]))]; }
    async _getVectorByRelPath(relative) {
      if (!lookup(relative)) return null;
      const vector = await super._getVectorByRelPath(relative);
      if (vector) this.vectorOrigins.add(vector);
      return vector;
    }
    async _getLocalVector(file) {
      const entry = lookup(file); return entry ? this._getVectorByRelPath(entry.relative) : null;
    }
    async _readContent(file) {
      const entry = lookup(file);
      if (!entry) throw failure('DreamWave attempted to read outside its owner scope.');
      return fs.readFile(entry.filePath, 'utf8');
    }
    async _hydrateSearchResult(hit) {
      const entry = lookup(hit.fullPath || hit.sourceFile);
      if (!entry) throw failure('DreamWave attempted to hydrate outside its owner scope.');
      return { filePath: entry.filePath, fullPath: entry.relative, content: await this._readContent(entry.filePath),
        score: hit.score || 0, sourceFile: hit.sourceFile || path.basename(entry.relative), retrievalEngine: hit.retrievalEngine };
    }
    candidates() {
      return [...entries.values()].filter(entry => entry.fileId && (this.phase === 'recent' ? entry.ageDays <= this.buckets.recentBoundary
        : this.phase === 'mid' ? entry.ageDays > this.buckets.recentBoundary && entry.ageDays <= this.buckets.midBoundary
          : entry.ageDays > this.buckets.midBoundary));
    }
    async _recallForVector(agentName, vector, k, text) {
      // Original phase 3 constructs a new normalized sum vector. Seed and bridge
      // vectors are the exact objects returned by _getVectorByRelPath above.
      if (!this.vectorOrigins.has(vector)) this.phase = 'deep';
      return super._recallForVector(agentName, vector, k, text);
    }
  }
  engine = new AuthorizedDreamWave();
  const wave = await engine.generateDreamWave(request.owner.agentName);
  const project = group => group.map(item => {
    const entry = lookup(item.filePath || item.fullPath);
    if (!entry) throw failure('DreamWave returned an unknown memory.');
    return { id: entry.id, version: entry.version, eventTime: entry.eventTime, clockDomain: entry.clockDomain, text: item._safeText,
      ...(typeof item.score === 'number' ? { score: item.score } : {}), ...(item.retrievalEngine ? { retrievalEngine: item.retrievalEngine } : {}) };
  });
  return { schema: 'worldlinebox.vcp-dream-wave', owner: request.owner, sourceRevision: request.sourceRevision, now: request.now, clockDomain: request.clockDomain,
    boundaries: { recentDays: engine.buckets.recentBoundary, midDays: engine.buckets.midBoundary },
    stages: { recent: { seeds: project(wave.recent.seeds), resonanceL1: project(wave.recent.resonanceL1), cascadeL2: project(wave.recent.cascadeL2) },
      mid: { seeds: project(wave.mid.seeds), cascadeL1: project(wave.mid.cascadeL1) }, deep: { recalls: project(wave.deep.recalls) } },
    diagnostics: { algorithm: 'upstream-DreamWaveEngine', sourceCount: request.notes.length, indexedCount: files.filter(entry => entry.fileId).length, queries } };
}

module.exports = { generateDreamWave };
