'use strict';
// Scoped adapter for preserved VCP DreamWaveEngine and reviewed maintenance.
// The upstream engine is unchanged; its data boundary is an owned <=24-note batch.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
class MaintenanceHost {
  constructor(host) {
    this.host = host; this.db = host.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS maintenance_operations(operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,plan TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS maintenance_reconciliations(operation_id TEXT NOT NULL,kind TEXT NOT NULL,revision TEXT NOT NULL,prior_state TEXT NOT NULL,prior_receipt TEXT,result TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(operation_id,kind,revision,prior_state));`);
  }
  fence(payload) {
    if (payload.expectedSourceRevision === undefined) throw new TypeError('Maintenance requires an expected source revision.');
    this.host.managed.assertSourceRevision(payload);
  }
  assertReadable() {
    if (this.db.prepare("SELECT 1 FROM maintenance_operations WHERE state IN ('partial','unknown') LIMIT 1").get()) throw fail('MEMORY_OUTCOME_UNKNOWN', 'An approved maintenance operation still needs its original index receipt reconciled before recall.');
  }
  audit(op, kind, result) {
    this.db.prepare('INSERT OR IGNORE INTO maintenance_reconciliations VALUES(?,?,?,?,?,?,?)').run(op.operation_id, kind, this.host.tombstones().revision, op.state, op.receipt_json || op.receipt || null, JSON.stringify(result), new Date().toISOString());
  }
  async reconcileExpired(runtime) {
    const revision = this.host.tombstones().revision;
    for (const op of this.db.prepare("SELECT * FROM maintenance_operations WHERE state NOT IN ('indexed','archived','conflict','withdrawn') LIMIT 8").all()) {
      const plan = JSON.parse(op.plan);
      if (plan.payload.expectedSourceRevision === revision || plan.sources.some(source => this.host.blocked('note', source.id))) continue;
      let result = { state: 'unknown', operationId: op.operation_id, reason: 'source-revision-changed' };
      try {
        if (op.kind === 'archive') {
          const source = plan.sources[0], original = await this.host.managed.physical(source.path, true), archived = await this.host.managed.physical(plan.archivePath, true);
          const [probe] = await runtime.kb.probeIngestionFiles([source.path]);
          if (!original && archived?.checksum === source.checksum && probe?.path === source.path && probe.exists === false) {
            this.db.prepare("UPDATE mutations SET state='archived',note_path=? WHERE id=? AND state NOT IN ('forgotten','withdrawing')").run(plan.archivePath, source.id);
            result = { state: 'archived', id: source.id, checksum: source.checksum, operationId: op.operation_id, retained: true, reconciled: true };
          } else if (original?.checksum === source.checksum && probe?.checksum === source.checksum && probe.completeVectors && probe.completeTags) {
            this.db.prepare("UPDATE mutations SET state='indexed' WHERE id=? AND state='unknown'").run(source.id);
            result = { state: 'conflict', operationId: op.operation_id, reason: 'expired-before-archive-commit', reconciled: true };
          }
        } else {
          await this.sources({ sources: plan.sources.map(source => ({ id: source.id, expectedChecksum: source.checksum })) }, 16, true);
          const id = crypto.createHash('sha256').update(plan.payload.sourceEventId).digest('hex'), row = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(id);
          if (row?.note_path) {
            const actual = await this.host.managed.physical(row.note_path), [probe] = await runtime.kb.probeIngestionFiles([row.note_path]);
            if (actual.checksum === row.checksum && probe?.checksum === row.checksum && probe.completeVectors && probe.completeTags) {
              this.db.prepare("UPDATE mutations SET state='indexed' WHERE id=? AND state NOT IN ('forgotten','withdrawing')").run(id);
              result = { state: 'indexed', id, checksum: row.checksum, operationId: op.operation_id, reconciled: true };
            }
          }
        }
      } catch { /* No new mutation or inferred success on incomplete evidence. */ }
      this.audit(op, op.kind, result); this.save(op, result.state, result);
    }
  }
  finalizeWithdrawn() {
    for (const op of this.db.prepare("SELECT * FROM maintenance_operations WHERE state NOT IN ('withdrawn','conflict')").all()) {
      if (!JSON.parse(op.plan).sources.some(source => this.host.blocked('note', source.id))) continue;
      const receipt = { state: 'withdrawn', withdrawn: true, operationId: op.operation_id, meaning: 'Sources were withdrawn and the real cleanup completed; prior mutation history is retained.' };
      this.audit(op, op.kind, receipt); this.save(op, 'withdrawn', receipt);
    }
  }
  async sources(payload, maximum = 24, allowArchived = false) {
    if (!Array.isArray(payload.sources) || !payload.sources.length || payload.sources.length > maximum || new Set(payload.sources.map(source => source.id)).size !== payload.sources.length) throw new TypeError('A bounded distinct owned source batch is required.');
    const result = [];
    for (const source of payload.sources) {
      if (!source || typeof source.expectedChecksum !== 'string' || !/^[a-f0-9]{32}$/u.test(source.expectedChecksum)) throw new TypeError('Source checksum is required.');
      const row = this.host.managed.row(source.id);
      if (!['indexed', 'pending', ...(allowArchived ? ['archived'] : [])].includes(row.state)) throw fail('MEMORY_NOTE_UNAVAILABLE', 'Only confirmed eligible notes can be maintained.');
      const actual = await this.host.managed.physical(row.note_path);
      if (actual.checksum !== row.checksum || actual.checksum !== source.expectedChecksum) throw fail('MEMORY_CONFLICT', 'A source changed after the maintenance plan was prepared.');
      result.push({ ...source, row, actual });
    }
    return result;
  }
  dreamRecall(runtime, payload) { return this.host.managed.serial(async () => {
    this.fence(payload); this.host.assertWithdrawalsSettled(); this.host.managed.assertReadable(); this.assertReadable();
    const sources = await this.sources(payload), byPath = new Map(sources.map(source => [path.resolve(source.actual.absolute).toLowerCase(), source]));
    const relative = source => source.row.note_path.replace(/\\/g, '/');
    const byRelative = new Map(sources.map(source => [relative(source), source]));
    const rows = await runtime.kb.getChunksByFilePaths([...byRelative.keys()]);
    const allowedFileIds = [...new Set(rows.map(row => Number(row.fileId)).filter(Number.isFinite))];
    const bounded = Object.create(runtime.kb);
    let filteredCandidates = 0;
    const filter = items => (Array.isArray(items) ? items : []).filter(item => {
      const allowed = byRelative.has(String(item.fullPath || item.path || '').replace(/\\/g, '/')); if (!allowed) filteredCandidates++; return allowed;
    });
    bounded.executeNativeRiverQuery = async (query, options) => {
      const result = await runtime.kb.executeNativeRiverQuery(query, { ...options, diaryNames: ['Companion'], allowedFileIds });
      return { ...result, results: filter(result.results) };
    };
    bounded.getChunksByFilePaths = paths => runtime.kb.getChunksByFilePaths(paths.filter(value => byRelative.has(String(value).replace(/\\/g, '/').replace(/^\//u, ''))));
    bounded.searchKnn = async (indices, vector, count) => filter(await runtime.kb.searchKnn(['Companion'], vector, count));
    const Engine = runtime._require('Plugin/AgentDream/DreamWaveEngine.js'), engine = new Engine(bounded);
    engine._getSearchableIndexNames = () => ['Companion'];
    // Keep upstream elastic 7/90-day bucket semantics, restricting its source
    // loader rather than scanning/reading every diary in the physical home.
    engine._getTimelineBuckets = async () => {
      const parsed = sources.map(source => {
        const date = /^\[(\d{4}-\d{2}-\d{2})\]/u.exec(source.actual.text)?.[1];
        const mtime = date ? Date.parse(date + 'T00:00:00+08:00') : Date.parse(source.row.created_at);
        return { filePath: source.actual.absolute, mtime, size: source.actual.info.size, ageDays: (Date.now() - mtime) / 86400000 };
      }).sort((a, b) => a.ageDays - b.ageDays);
      const count = (min, max) => parsed.filter(item => item.ageDays >= min && item.ageDays <= max).length;
      let recentBoundary = 7, midBoundary = 90;
      while (count(0, recentBoundary) < 3 && recentBoundary < 30) recentBoundary += 7;
      recentBoundary = Math.min(30, recentBoundary);
      while (count(recentBoundary + 1, midBoundary) < 2 && midBoundary < 180) midBoundary += 30;
      midBoundary = Math.min(180, midBoundary);
      return { recent: parsed.filter(item => item.ageDays <= recentBoundary), mid: parsed.filter(item => item.ageDays > recentBoundary && item.ageDays <= midBoundary), deep: parsed.filter(item => item.ageDays > midBoundary), recentBoundary, midBoundary };
    };
    engine._readContent = async absolute => byPath.get(path.resolve(absolute).toLowerCase())?.actual.text || '';
    engine._hydrateSearchResult = async item => {
      const source = byRelative.get(String(item.fullPath || '').replace(/\\/g, '/'));
      return source ? { ...item, filePath: source.actual.absolute, content: source.actual.text } : { content: '' };
    };
    const wave = await engine.generateDreamWave('Companion');
    const groups = {}, omitted = { unowned: 0, empty: 0 };
    for (const [period, value] of Object.entries(wave)) for (const [role, items] of Object.entries(value)) {
      groups[`${period}.${role}`] = [];
      for (const item of items) {
        const source = item.filePath ? byPath.get(path.resolve(item.filePath).toLowerCase()) : byRelative.get(String(item.fullPath || '').replace(/\\/g, '/'));
        if (!source) { omitted.unowned++; continue; }
        if (!item.content && !item.text) { omitted.empty++; continue; }
        const scores = Object.fromEntries(Object.entries(item).filter(([key, value]) => /score|weight|resonance|omega|similarity/iu.test(key) && typeof value === 'number' && Number.isFinite(value)));
        groups[`${period}.${role}`].push({ id: source.id, checksum: source.actual.checksum, ...(typeof item.score === 'number' ? { score: item.score } : {}), scores,
          ...(item.retrievalEngine ? { retrievalEngine: item.retrievalEngine } : {}) });
      }
    }
    this.fence(payload);
    return { engine: 'DreamWaveEngine', namespace: 'Companion', sourceRevision: payload.expectedSourceRevision, groups, examined: sources.length, omitted: { ...omitted, filteredCandidates },
      adaptation: 'Original generateDreamWave with an owned bounded source loader and scoped native retrieval; no dream LLM or diary mutation.' };
  }); }
  plan(payload, kind, sources) {
    if (typeof payload.operationId !== 'string' || !payload.operationId || payload.operationId.length > 512) throw new TypeError('Stable maintenance operation ID is required.');
    const fingerprint = hash(canonical([kind, payload])), prior = this.db.prepare('SELECT * FROM maintenance_operations WHERE operation_id=?').get(payload.operationId);
    if (prior) { if (prior.fingerprint !== fingerprint || prior.kind !== kind) throw fail('MEMORY_CONFLICT', 'Maintenance operation ID already belongs to another input.'); return prior; }
    const plan = { payload, sources: sources.map(source => ({ id: source.id, checksum: source.actual.checksum, path: source.row.note_path })),
      archivePath: kind === 'archive' ? `已整理/${sources[0].id}-maintenance-${hash(payload.operationId).slice(0, 16)}${path.extname(sources[0].row.note_path)}` : undefined };
    this.db.prepare('INSERT INTO maintenance_operations VALUES(?,?,?,?,?,NULL)').run(payload.operationId, kind, fingerprint, JSON.stringify(plan), 'prepared');
    return this.db.prepare('SELECT * FROM maintenance_operations WHERE operation_id=?').get(payload.operationId);
  }
  save(operation, state, receipt) { this.db.prepare('UPDATE maintenance_operations SET state=?,receipt=? WHERE operation_id=?').run(state, JSON.stringify(receipt), operation.operation_id); return receipt; }
  async existing(payload, kind) {
    const op = this.db.prepare('SELECT * FROM maintenance_operations WHERE operation_id=?').get(payload.operationId);
    if (op && (op.fingerprint !== hash(canonical([kind, payload])) || op.kind !== kind)) throw fail('MEMORY_CONFLICT', 'Maintenance operation input changed.');
    return op;
  }
  insight(runtime, payload) { return this.host.managed.serial(async () => {
    this.fence(payload); this.host.managed.validate(payload, 'organize');
    let op = await this.existing(payload, 'insight');
    if (op?.state === 'indexed') return JSON.parse(op.receipt);
    if (!op) op = this.plan(payload, 'insight', await this.sources(payload, 16, true));
    const plan = JSON.parse(op.plan), id = crypto.createHash('sha256').update(payload.sourceEventId).digest('hex');
    // A crash does not freeze a parent file forever. Recheck the actual parent
    // version before resuming any side effect, including retrying index sync.
    await this.sources({ sources: plan.sources.map(source => ({ id: source.id, expectedChecksum: source.checksum })) }, 16, true);
    // Record directional parent edges before admitting any file write. A
    // withdrawal between a crash and resume therefore also suppresses insight.
    for (const source of plan.sources) this.db.prepare('INSERT OR IGNORE INTO note_dependencies VALUES(?,?,?)').run(source.id, id, payload.operationId);
    const body = `梦境感悟（非用户事实）\n这是基于日记的联想与反思，不能作为用户经历、偏好或已完成行动的证据。\n\n${payload.content}\n\n来源记忆：${plan.sources.map(source => source.id).join(', ')}`;
    try {
      const priorNote = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(id);
      if (priorNote?.state === 'unknown' && priorNote.note_path) {
        const actual = await this.host.managed.physical(priorNote.note_path);
        if (actual.checksum !== priorNote.checksum) throw fail('MEMORY_OUTCOME_UNKNOWN', 'Insight file has an unconfirmed version.');
        this.db.prepare("UPDATE mutations SET state='pending' WHERE id=? AND state='unknown'").run(id);
      }
      const tags = [...new Set(['梦境感悟', '非用户事实', ...String(payload.tags || '').split(/[,，、\n]/u).map(value => value.trim()).filter(Boolean)])].slice(0, 12);
      await this.host.remember(runtime, { ...payload, content: body, tags: tags.join(','), sourceMessageIds: [] });
      const receipt = await this.host.sync(runtime, { id });
      if (receipt.receipts?.some(value => value.id === id && value.state === 'indexed')) return this.save(op, 'indexed', { ...receipt, state: 'indexed', id, operationId: payload.operationId });
      return this.save(op, 'pending', { ...receipt, state: 'pending', id, operationId: payload.operationId });
    } catch (cause) { this.db.prepare("UPDATE mutations SET state='unknown' WHERE id=? AND state NOT IN ('forgotten','withdrawing')").run(id);
      return this.save(op, 'unknown', { state: 'unknown', id, operationId: payload.operationId, error: { code: cause.code || 'MEMORY_OUTCOME_UNKNOWN', message: 'Insight write requires reconciliation using this same operation.' } }); }
  }); }
  archive(runtime, payload) { return this.host.managed.serial(async () => {
    this.fence(payload);
    let op = await this.existing(payload, 'archive');
    if (op?.state === 'archived') return JSON.parse(op.receipt);
    if (!op) op = this.plan(payload, 'archive', await this.sources({ sources: [{ id: payload.id, expectedChecksum: payload.expectedChecksum }] }, 1));
    const plan = JSON.parse(op.plan), source = plan.sources[0];
    this.host.managed.row(source.id);
    const ignored = runtime.kb.config?.ignorePrefixes;
    if (!Array.isArray(ignored) || !ignored.some(prefix => '已整理'.startsWith(prefix))) throw fail('MEMORY_ARCHIVE_POLICY_REQUIRED', 'Archive must be excluded from VCP scanning.');
    await fs.mkdir(path.join(this.host.home, 'dailynote', '已整理'), { recursive: true });
    try {
      await runtime.kb.runExternalFileMutation('WorldlineBoxMaintenanceArchive:' + hash(payload.operationId), async () => {
        this.fence(payload);
        const original = await this.host.managed.physical(source.path, true), archived = await this.host.managed.physical(plan.archivePath, true);
        if ((!original && !archived) || (original && original.checksum !== source.checksum) || (archived && archived.checksum !== source.checksum)) throw fail('MEMORY_OUTCOME_UNKNOWN', 'Archive cannot prove one unchanged source version.');
        if (original) {
          if (!archived) { await fs.copyFile(original.absolute, this.host.notePath(plan.archivePath), constants.COPYFILE_EXCL); const handle = await fs.open(this.host.notePath(plan.archivePath), 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
          if ((await this.host.managed.physical(plan.archivePath)).checksum !== source.checksum || (await this.host.managed.physical(source.path)).checksum !== source.checksum) throw fail('MEMORY_OUTCOME_UNKNOWN', 'Source changed during archive.');
          await fs.unlink(original.absolute);
        }
        return { status: 'success', mutationPaths: { deletes: [this.host.notePath(source.path)], upserts: [] } };
      }, { waitForIndex: true, timeoutMs: 30000 });
      const [probe] = await runtime.kb.probeIngestionFiles([source.path]);
      if (!probe || probe.path !== source.path || probe.exists !== false) throw fail('MEMORY_INDEX_PENDING', 'Archived source still has an index entry.');
      this.db.prepare("UPDATE mutations SET state='archived',note_path=?,updated_at=? WHERE id=?").run(plan.archivePath, new Date().toISOString(), source.id);
      this.host.managed.clearCaches(runtime);
      return this.save(op, 'archived', { state: 'archived', id: source.id, checksum: source.checksum, operationId: payload.operationId, indexed: false, retained: true });
    } catch (cause) { this.db.prepare("UPDATE mutations SET state='unknown' WHERE id=? AND state NOT IN ('forgotten','withdrawing')").run(source.id);
      return this.save(op, cause.code === 'MEMORY_OUTCOME_UNKNOWN' ? 'unknown' : 'partial', { state: cause.code === 'MEMORY_OUTCOME_UNKNOWN' ? 'unknown' : 'partial', operationId: payload.operationId, id: source.id,
      error: { code: cause.code || 'MEMORY_INDEX_PENDING', message: 'Archive requires its original operation to resume; the original content is retained.' } }); }
  }); }
}
module.exports = { MaintenanceHost };
