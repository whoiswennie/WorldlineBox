'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { compileFunction } = require('node:vm');
const { createRequire } = require('node:module');
const { diaryDateSql, dateRange } = require('./diary-calendar.cjs');

const compiled = new Map();
// Give the two original CommonJS modules a scoped dependency view. Their
// query, per-file merge, ranking, exclusion and top-K logic run unmodified.
function loadScoped(runtime, entry, dependencies) {
  const file = path.join(runtime.runtimeDir, entry);
  if (!compiled.has(entry)) compiled.set(entry, compileFunction(fs.readFileSync(file, 'utf8'),
    ['require','module','__dirname'], { filename: file }));
  const local = createRequire(file), definition = { exports: {} };
  compiled.get(entry)(name => Object.hasOwn(dependencies, name) ? dependencies[name] : local(name), definition, path.dirname(file));
  return definition.exports;
}
const unavailable = () => Object.assign(new Error('The native association requires the current indexed diary version.'), { code: 'MEMORY_NOTE_UNAVAILABLE' });
async function verifyIndex(kb, records) {
  if (!records.length) return;
  const probes = await kb.probeIngestionFiles(records.map(source => source.row.note_path));
  const byPath = new Map(probes.map(probe => [probe.path, probe]));
  for (const source of records) {
    const probe = byPath.get(source.row.note_path);
    if (!probe?.completeVectors || !probe.completeTags || probe.checksum !== source.actual.checksum) throw unavailable();
  }
}

async function associateDiaries(maintenance, runtime, payload) {
  return maintenance.host.managed.serial(async () => {
    maintenance.fence(payload);
    const host = maintenance.host;
    host.assertWithdrawalsSettled(); host.managed.assertReadable(); maintenance.assertReadable();
    const { fromDate, toDate } = payload, dated = dateRange(fromDate, toDate);
    if (!Array.isArray(payload.sources)) throw new TypeError('Indexed diary sources are required.');
    const seeds = await maintenance.sources({ sources: payload.sources.map(source => ({ id: source.id, expectedChecksum: source.checksum })) });
    const day = diaryDateSql('m'), bounds = [...(fromDate ? [fromDate] : []), ...(toDate ? [toDate] : [])];
    const find = host.db.prepare(`SELECT id,checksum,${day} AS diaryDate FROM mutations m WHERE m.state='indexed' AND m.note_path=?
      ${fromDate ? 'AND (' + day + ')>=?' : ''} ${toDate ? 'AND (' + day + ')<=?' : ''}
      AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.kind='note' AND t.id=m.id)
      AND NOT EXISTS(SELECT 1 FROM mutation_sources s JOIN tombstones t ON t.kind=s.kind AND t.id=s.id WHERE s.note_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM managed_operation_sources s JOIN managed_operations o USING(operation_id) WHERE s.note_id=m.id AND o.state NOT IN('indexed','conflict','withdrawn'))`);
    if (seeds.some(source => !/^Companion\/[^/\\\r\n]+\.(?:txt|md)$/u.test(source.row.note_path) || find.get(source.row.note_path, ...bounds)?.id !== source.id)) throw unavailable();
    await runtime.start({ vectors: true });
    await verifyIndex(runtime.kb, seeds);
    const byPath = new Map(seeds.map(source => [source.row.note_path, source]));
    const byAbsolute = new Map(seeds.map(source => [path.resolve(source.actual.absolute), source.actual.text]));
    const native = loadScoped(runtime, 'modules/associativeDiscovery.js', {
      '../KnowledgeBaseManager': runtime.kb,
      fs: { promises: { readFile: async file => {
        const body = byAbsolute.get(path.resolve(file));
        if (body === undefined) throw unavailable();
        return body;
      } } },
    });
    const candidates = new Map(), queries = new Map();
    const manager = loadScoped(runtime, 'Plugin/DailyNoteManager/daily-note-manager.js', {
      '../../modules/associativeDiscovery': { discover: async params => {
        const seed = byPath.get(params.sourceFilePath);
        if (!seed || params.range.length !== 1 || params.range[0] !== 'Companion') throw unavailable();
        const knowledge = Object.create(runtime.kb);
        let degradation;
        knowledge.executeNativeRiverQuery = async (query, options) => {
          const result = await runtime.kb.executeNativeRiverQuery(query, options);
          if (result.diagnostics?.degraded) degradation = { reason: result.diagnostics.reason, engine: result.diagnostics.retrievalEngine };
          if (dated) return { ...result, results: (result.results || []).filter(hit => {
            const relative = String(hit.fullPath || hit.sourceFile || '').replaceAll('\\', '/');
            return find.get(relative, ...bounds) !== undefined;
          }) };
          return result;
        };
        const found = await native.discover.call(Object.assign(Object.create(native), { kbm: knowledge }), params);
        const { engine, nativeJointQueryUsed, totalChunksFound, queryId, artifactSig, omega, regime } = found.metadata;
        queries.set(seed.id, { seedId: seed.id, engine, nativeJointQueryUsed, totalChunksFound, queryId, artifactSig, omega, regime, degradation });
        const results = [];
        for (const hit of found.results) {
          const relative = hit.path;
          if (!/^Companion\/[^/\\\r\n]+\.(?:txt|md)$/u.test(relative)) continue;
          const row = find.get(relative, ...bounds);
          if (!row || !Number.isFinite(hit.score)) continue;
          const previous = candidates.get(relative) || { ...row, seedIds: [], score: hit.score, matches: [] };
          previous.seedIds.push(seed.id);
          previous.matches.push({ seedId: seed.id, score: hit.score, matchedTags: hit.matchedTags, tagMatchScore: hit.tagMatchScore, riverMemo: hit.riverMemo });
          previous.score = Math.max(previous.score, hit.score);
          candidates.set(relative, previous);
          // The manager's public return is formatted text. Supply only ranked
          // identities to its formatter so diary previews cannot forge entries.
          results.push({ path: relative, score: hit.score });
        }
        return { ...found, results };
      } },
    });
    manager.initialize(runtime.runtimeConfig, runtime.dependencies);
    let selection;
    try {
      selection = await manager.processToolCall({ command: 'associate', url: [...byPath.keys()].join('\n'), range: 'Companion' });
    } finally { await manager.shutdown(); }
    if (selection.status !== 'success') throw Object.assign(new Error(String(selection.error)), { code: 'MEMORY_ASSOCIATION_FAILED' });
    const items = [], checked = [];
    for (const line of selection.result.split('\n')) {
      if (!line.startsWith('📄 [')) continue;
      const match = /^📄 \[(.+)\] \(相似度: -?[\d.]+\)$/u.exec(line);
      const matchRow = match && candidates.get(match[1]);
      if (!matchRow || byPath.has(match[1])) throw unavailable();
      const [source] = await maintenance.sources({ sources: [{ id: matchRow.id, expectedChecksum: matchRow.checksum }] });
      if (source.row.state !== 'indexed' || source.row.note_path !== match[1]) throw unavailable();
      checked.push(source);
      items.push({ ...matchRow, seedIds: [...new Set(matchRow.seedIds)].sort(), sourceEventId: source.row.source_root || source.row.source_event,
        sourceMessageIds: JSON.parse(source.row.source_messages || '[]') });
    }
    await verifyIndex(runtime.kb, checked);
    maintenance.fence(payload); host.assertWithdrawalsSettled();
    return { engine: 'DailyNoteManager.Associate', sourceRevision: payload.expectedSourceRevision,
      items, queries: seeds.map(source => queries.get(source.id)) };
  });
}
module.exports = { associateDiaries };
