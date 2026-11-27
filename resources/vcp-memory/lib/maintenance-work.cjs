'use strict';
// Incremental work is separate from the retained diary catalog. Indexed versions
// enter this queue once; archived files and completed versions never page through
// the maintenance selector. Native mutation receipts remain authoritative.
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const validSum = value => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
const fail = message => Object.assign(new Error(message), { code: 'MEMORY_MAINTENANCE_WORK_CONFLICT' });
const { randomUUID } = require('node:crypto');
const { diaryDateSql } = require('./diary-calendar.cjs');
const settlingPeriod = 30 * 24 * 60 * 60 * 1000;
class MaintenanceWork {
  constructor(host) {
    this.host = host; this.db = host.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS maintenance_work(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,note_id TEXT NOT NULL,checksum TEXT NOT NULL,state TEXT NOT NULL,job_id TEXT,available_at INTEGER NOT NULL DEFAULT 0,changed_at TEXT NOT NULL,error TEXT,UNIQUE(kind,note_id));
      CREATE INDEX IF NOT EXISTS maintenance_work_ready ON maintenance_work(kind,state,available_at,sequence);
      CREATE INDEX IF NOT EXISTS maintenance_work_job ON maintenance_work(job_id,state);
      CREATE INDEX IF NOT EXISTS maintenance_work_note ON maintenance_work(note_id,checksum,state);
      CREATE INDEX IF NOT EXISTS maintenance_work_active ON maintenance_work(state,job_id);
      CREATE TABLE IF NOT EXISTS maintenance_batches(job_id TEXT PRIMARY KEY,kind TEXT NOT NULL,revision TEXT NOT NULL,sources_json TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_work_identity(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS maintenance_batches_pending ON maintenance_batches(state,revision);
      CREATE INDEX IF NOT EXISTS mutations_note_path ON mutations(note_path);
      CREATE TRIGGER IF NOT EXISTS maintenance_work_insert AFTER INSERT ON mutations WHEN NEW.state='indexed' AND NEW.checksum IS NOT NULL BEGIN
        INSERT INTO maintenance_work(kind,note_id,checksum,state,changed_at) SELECT value,NEW.id,NEW.checksum,'pending',COALESCE(NEW.updated_at,NEW.created_at) FROM json_each('["organize","dream"]') WHERE 1
        ON CONFLICT(kind,note_id) DO UPDATE SET checksum=excluded.checksum,state='pending',job_id=NULL,available_at=0,changed_at=excluded.changed_at,error=NULL WHERE maintenance_work.checksum<>excluded.checksum OR maintenance_work.state='inactive';
      END;
      CREATE TRIGGER IF NOT EXISTS maintenance_work_indexed AFTER UPDATE OF state,checksum ON mutations WHEN NEW.state='indexed' AND NEW.checksum IS NOT NULL BEGIN
        INSERT INTO maintenance_work(kind,note_id,checksum,state,changed_at) SELECT value,NEW.id,NEW.checksum,'pending',COALESCE(NEW.updated_at,NEW.created_at) FROM json_each('["organize","dream"]') WHERE 1
        ON CONFLICT(kind,note_id) DO UPDATE SET checksum=excluded.checksum,state='pending',job_id=NULL,available_at=0,changed_at=excluded.changed_at,error=NULL WHERE maintenance_work.checksum<>excluded.checksum OR maintenance_work.state='inactive';
      END;
      CREATE TRIGGER IF NOT EXISTS maintenance_work_inactive AFTER UPDATE OF state ON mutations WHEN NEW.state IN('archived','forgotten','withdrawing') BEGIN
        UPDATE maintenance_work SET state='inactive',job_id=NULL WHERE note_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS maintenance_work_removed AFTER DELETE ON mutations BEGIN DELETE FROM maintenance_work WHERE note_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS maintenance_work_organized AFTER UPDATE OF state ON managed_operations WHEN NEW.state='indexed' AND NEW.operation_id LIKE 'maintenance-%' BEGIN
        UPDATE maintenance_work SET state='derived',job_id=NULL,error=NULL WHERE note_id=json_extract(NEW.receipt_json,'$.id') AND checksum=json_extract(NEW.receipt_json,'$.checksum');
      END;
      CREATE TRIGGER IF NOT EXISTS maintenance_work_organized_crystal AFTER UPDATE OF state ON managed_operations
      WHEN NEW.state='indexed' AND NEW.operation_id LIKE 'maintenance-%' AND json_extract(NEW.receipt_json,'$.crystal.indexed')=1 BEGIN
        UPDATE maintenance_work SET state='derived',job_id=NULL,error=NULL WHERE note_id=json_extract(NEW.receipt_json,'$.crystal.id') AND checksum=json_extract(NEW.receipt_json,'$.crystal.checksum');
      END;
      CREATE TRIGGER IF NOT EXISTS maintenance_work_insight AFTER UPDATE OF state ON maintenance_operations WHEN NEW.state='indexed' AND NEW.operation_id LIKE 'maintenance-%' AND NEW.kind='insight' BEGIN
        UPDATE maintenance_work SET state='derived',job_id=NULL,error=NULL WHERE EXISTS(SELECT 1 FROM json_each(NEW.receipt,'$.receipts') r WHERE json_extract(r.value,'$.id')=maintenance_work.note_id AND json_extract(r.value,'$.checksum')=maintenance_work.checksum AND json_extract(r.value,'$.state')='indexed');
      END;`);
    if (!this.db.prepare('PRAGMA table_info(maintenance_batches)').all().some(column => column.name === 'contexts_json')) this.db.exec('ALTER TABLE maintenance_batches ADD COLUMN contexts_json TEXT');
    this.db.prepare('INSERT OR IGNORE INTO maintenance_work_identity VALUES(1,?)').run(randomUUID());
    this.generation = this.db.prepare('SELECT generation FROM maintenance_work_identity WHERE id=1').get().generation;
    if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='maintenance-work-v1'").get()) this.db.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO maintenance_work(kind,note_id,checksum,state,changed_at)
        SELECT k.value,m.id,m.checksum,'pending',COALESCE(m.updated_at,m.created_at) FROM mutations m,json_each('["organize","dream"]') k WHERE m.state='indexed' AND m.checksum IS NOT NULL;`);
      const suppress = this.db.prepare("UPDATE maintenance_work SET state='derived',job_id=NULL WHERE note_id=? AND checksum=?");
      for (const op of this.db.prepare("SELECT receipt_json FROM managed_operations WHERE state='indexed' AND operation_id LIKE 'maintenance-%'").all()) {
        const receipt = JSON.parse(op.receipt_json || '{}'); if (validId(receipt.id) && validSum(receipt.checksum)) suppress.run(receipt.id, receipt.checksum);
        if (receipt.crystal?.indexed && validId(receipt.crystal.id) && validSum(receipt.crystal.checksum)) suppress.run(receipt.crystal.id, receipt.crystal.checksum);
      }
      for (const op of this.db.prepare("SELECT receipt FROM maintenance_operations WHERE state='indexed' AND kind='insight' AND operation_id LIKE 'maintenance-%'").all()) {
        for (const receipt of JSON.parse(op.receipt || '{}').receipts || []) if (receipt.state === 'indexed' && validId(receipt.id) && validSum(receipt.checksum)) suppress.run(receipt.id, receipt.checksum);
      }
      this.db.prepare("INSERT INTO metadata VALUES('maintenance-work-v1',1)").run();
    })();
    this.db.transaction(() => {
      const month = prefix => `substr(${diaryDateSql(prefix)},1,7)`;
      if (!this.db.prepare('PRAGMA table_info(maintenance_work)').all().some(column => column.name === 'diary_month')) {
        this.db.exec(`ALTER TABLE maintenance_work ADD COLUMN diary_month TEXT NOT NULL DEFAULT '';
          UPDATE maintenance_work SET diary_month=COALESCE((SELECT ${month('m')} FROM mutations m WHERE m.id=maintenance_work.note_id),'')`);
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS maintenance_work_month ON maintenance_work(kind,state,diary_month,available_at,sequence);
        CREATE INDEX IF NOT EXISTS maintenance_work_future ON maintenance_work(kind,state,(error IS NULL),available_at,sequence);
        CREATE TRIGGER IF NOT EXISTS maintenance_work_month_insert AFTER INSERT ON maintenance_work BEGIN
          UPDATE maintenance_work SET diary_month=(SELECT ${month('m')} FROM mutations m WHERE m.id=NEW.note_id) WHERE sequence=NEW.sequence;
        END;
        CREATE TRIGGER IF NOT EXISTS maintenance_work_month_changed AFTER UPDATE OF note_path,created_at ON mutations
        WHEN NEW.state='indexed' AND (OLD.note_path IS NOT NEW.note_path OR OLD.created_at IS NOT NEW.created_at) BEGIN
          UPDATE maintenance_work SET diary_month=${month('NEW')} WHERE note_id=NEW.id;
        END;`);
    })();
  }
  identity() { return { generation: this.generation }; }
  validate(input) {
    if (!input || !['organize','dream'].includes(input.kind)) throw new TypeError('A maintenance kind is required.');
    if (input.jobId !== undefined && (typeof input.jobId !== 'string' || !input.jobId || input.jobId.length > 160)) throw new TypeError('A stable maintenance job ID is required.');
  }
  eligible() { return `m.state='indexed' AND m.checksum=w.checksum
    AND NOT EXISTS(SELECT 1 FROM maintenance_work x WHERE x.note_id=m.id AND x.checksum=m.checksum AND x.state IN('processing','review') AND x.job_id IS NOT w.job_id)
    AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.kind='note' AND t.id=m.id)
    AND NOT EXISTS(SELECT 1 FROM mutation_sources s JOIN tombstones t ON t.kind=s.kind AND t.id=s.id WHERE s.note_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM managed_operation_sources s JOIN managed_operations o USING(operation_id) WHERE s.note_id=m.id AND o.state NOT IN('indexed','conflict','withdrawn'))`; }
  restoreContext(kind, jobId, source) {
    this.db.prepare('UPDATE maintenance_work SET state=?,job_id=NULL,available_at=?,error=? WHERE kind=? AND note_id=? AND checksum=? AND job_id=?')
      .run(source.previousState, source.availableAt || 0, source.previousError || null, kind, source.id, source.checksum, jobId);
  }
  expire() {
    const revision = this.host.tombstones().revision;
    this.db.transaction(() => {
      for (const batch of this.db.prepare("SELECT DISTINCT b.job_id,b.kind,b.contexts_json FROM maintenance_work w JOIN maintenance_batches b ON b.job_id=w.job_id WHERE w.state IN('processing','review') AND b.revision<>?").all(revision)) {
        for (const context of JSON.parse(batch.contexts_json || '[]')) this.restoreContext(batch.kind, batch.job_id, context);
        this.db.prepare("UPDATE maintenance_work SET state='pending',job_id=NULL,available_at=0,error='来源已撤回，依据当前可用版本重新分析。' WHERE job_id=? AND state IN('processing','review')").run(batch.job_id);
        this.db.prepare("UPDATE maintenance_batches SET state='released' WHERE job_id=?").run(batch.job_id);
      }
    })();
  }
  next(input) {
    const now = Date.now();
    const hasReady = !!this.db.prepare(`SELECT 1 FROM maintenance_work w JOIN mutations m ON m.id=w.note_id WHERE w.kind=? AND w.state='pending' AND w.available_at<=? AND ${this.eligible()} ORDER BY w.available_at,w.sequence LIMIT 1`).get(input.kind, now);
    const future = this.db.prepare(`SELECT w.available_at FROM maintenance_work w JOIN mutations m ON m.id=w.note_id WHERE w.kind=? AND w.state='pending'
      AND (w.error IS NULL)=? AND w.available_at>? AND ${this.eligible()} ORDER BY w.available_at,w.sequence LIMIT 1`);
    const retry = future.get(input.kind, 0, now), settling = future.get(input.kind, 1, now);
    return { mode: 'incremental-v1', hasReady, ...(retry ? { retryAt: retry.available_at } : {}), ...(settling ? { maturityAt: settling.available_at } : {}) };
  }
  stats(input) {
    this.validate(input); this.expire(); const now = Date.now();
    const ready = this.db.prepare(`SELECT COUNT(*) AS ready,MIN(w.changed_at) AS oldestReadyAt,COALESCE(SUM(w.error IS NOT NULL),0) AS resumable FROM maintenance_work w JOIN mutations m ON m.id=w.note_id WHERE w.kind=? AND w.state='pending' AND w.available_at<=? AND ${this.eligible()}`).get(input.kind, now);
    const waiting = this.db.prepare(`SELECT COUNT(*) FILTER (WHERE w.error IS NOT NULL) AS retrying,MIN(w.available_at) FILTER (WHERE w.error IS NOT NULL) AS retryAt,
      COUNT(*) FILTER (WHERE w.error IS NULL) AS settling,MIN(w.available_at) FILTER (WHERE w.error IS NULL) AS maturityAt
      FROM maintenance_work w JOIN mutations m ON m.id=w.note_id WHERE w.kind=? AND w.state='pending' AND w.available_at>? AND ${this.eligible()}`).get(input.kind, now);
    const processing = this.db.prepare("SELECT COUNT(*) AS processing FROM maintenance_work WHERE kind=? AND state='processing'").get(input.kind).processing;
    return { mode: 'incremental-v1', ...ready, ...waiting, processing };
  }
  claim(input) {
    this.validate(input); if (!input.jobId || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 24) throw new TypeError('A bounded stable maintenance batch is required.');
    return this.db.transaction(() => {
      this.expire();
      let batch = this.db.prepare('SELECT * FROM maintenance_batches WHERE job_id=?').get(input.jobId);
      if (batch && batch.kind !== input.kind) throw fail('The maintenance batch kind changed.');
      if (batch?.state === 'released' && batch.revision === this.host.tombstones().revision) {
        const sources = JSON.parse(batch.sources_json);
        const contexts = JSON.parse(batch.contexts_json || '[]');
        const available = this.db.prepare(`SELECT 1 FROM maintenance_work w JOIN mutations m ON m.id=w.note_id WHERE w.kind=? AND w.note_id=? AND w.checksum=? AND w.state='pending' AND w.job_id IS NULL AND ${this.eligible()}`);
        const contextAvailable = this.db.prepare(`SELECT 1 FROM maintenance_work w JOIN mutations m ON m.id=w.note_id WHERE w.kind=? AND w.note_id=? AND w.checksum=? AND w.state=? AND w.job_id IS NULL AND ${this.eligible()}`);
        if (sources.every(source => available.get(input.kind, source.id, source.checksum)) && contexts.every(source => contextAvailable.get(input.kind, source.id, source.checksum, source.previousState))) {
          for (const source of [...sources, ...contexts]) this.db.prepare("UPDATE maintenance_work SET state='processing',job_id=? WHERE kind=? AND note_id=? AND checksum=?").run(input.jobId, input.kind, source.id, source.checksum);
          this.db.prepare("UPDATE maintenance_batches SET state='processing' WHERE job_id=?").run(input.jobId); batch.state = 'processing';
        }
      }
      if (!batch) {
        const now = Date.now(), monthly = input.kind === 'organize';
        const ready = ` FROM maintenance_work w JOIN mutations m ON m.id=w.note_id WHERE w.kind=? AND w.state='pending' AND w.available_at<=? AND ${this.eligible()}`;
        const order = ' ORDER BY w.available_at,w.sequence';
        const first = monthly && this.db.prepare('SELECT w.diary_month' + ready + order + ' LIMIT 1').get(input.kind, now);
        const sources = monthly && !first ? [] : this.db.prepare('SELECT w.note_id AS id,w.checksum' + ready + (monthly ? ' AND w.diary_month=?' : '') + order + ' LIMIT ?')
          .all(input.kind, now, ...(monthly ? [first.diary_month, Math.min(20, input.limit)] : [input.limit]));
        const take = this.db.prepare("UPDATE maintenance_work SET state='processing',job_id=? WHERE kind=? AND note_id=? AND checksum=? AND state='pending'");
        for (const source of sources) take.run(input.jobId, input.kind, source.id, source.checksum);
        this.db.prepare("INSERT INTO maintenance_batches(job_id,kind,revision,sources_json,state,created_at) VALUES(?,?,?,?,'processing',?)").run(input.jobId, input.kind, this.host.tombstones().revision, JSON.stringify(sources), new Date().toISOString());
        batch = this.db.prepare('SELECT * FROM maintenance_batches WHERE job_id=?').get(input.jobId);
      }
      return { mode: 'incremental-v1', items: JSON.parse(batch.sources_json), revision: batch.revision, state: batch.state,
        ...(this.next(input).hasReady ? { nextCursor: 'incremental-v1' } : {}) };
    })();
  }
  complete(input) {
    this.validate(input); if (!Array.isArray(input.sources) || input.sources.length > 48 || input.sources.some(s => !validId(s.id) || !validSum(s.checksum)) || input.reserved !== undefined && (!Array.isArray(input.reserved) || input.reserved.some(id => !validId(id)))) throw new TypeError('Confirmed maintenance versions are required.');
    return this.db.transaction(() => {
      const batch = this.db.prepare('SELECT * FROM maintenance_batches WHERE job_id=?').get(input.jobId);
      if (!batch || batch.kind !== input.kind) throw fail('The original maintenance batch is missing.');
      const contexts = JSON.parse(batch.contexts_json || '[]'), sources = [...JSON.parse(batch.sources_json), ...contexts];
      if (input.sources.some(source => !sources.some(expected => expected.id === source.id && expected.checksum === source.checksum))) throw fail('Maintenance completion contains an unclaimed version.');
      const accepted = new Set(input.sources.map(source => source.id)), reserved = new Set(input.reserved || []);
      const update = this.db.prepare('UPDATE maintenance_work SET state=?,job_id=?,available_at=?,error=? WHERE kind=? AND note_id=? AND checksum=? AND job_id=?');
      const firstAnalysis = this.db.prepare(`SELECT m.created_at FROM mutations m JOIN maintenance_work w ON w.note_id=m.id AND m.checksum=w.checksum
        WHERE m.id=? AND m.checksum=? AND w.kind='organize' AND w.job_id=? AND w.state='processing'`), now = Date.now();
      for (const source of sources) {
        if (source.previousState && (input.kind === 'dream' || source.previousState === 'pending') && !(accepted.has(source.id) && reserved.has(source.id))) {
          this.restoreContext(input.kind, input.jobId, source); continue;
        }
        const state = accepted.has(source.id) ? reserved.has(source.id) ? 'review' : 'reviewed' : source.previousState || 'pending';
        if (input.kind === 'organize' && !source.previousState && state === 'reviewed') {
          const maturity = Date.parse(firstAnalysis.get(source.id, source.checksum, input.jobId)?.created_at) + settlingPeriod;
          if (maturity > now) { update.run('pending', null, maturity, null, input.kind, source.id, source.checksum, input.jobId); continue; }
        }
        update.run(state, state === 'review' ? input.jobId : null, state === 'pending' ? now + 300000 : 0,
          state === 'pending' ? '本批未完成此版本的有效分析，稍后重试。' : null, input.kind, source.id, source.checksum, input.jobId);
      }
      this.db.prepare("UPDATE maintenance_batches SET state='complete' WHERE job_id=?").run(input.jobId);
      return this.next(input);
    })();
  }
  release(input) {
    this.validate(input);
    this.db.transaction(() => {
      const batch = this.db.prepare('SELECT contexts_json FROM maintenance_batches WHERE job_id=?').get(input.jobId);
      for (const context of JSON.parse(batch?.contexts_json || '[]')) this.restoreContext(input.kind, input.jobId, context);
      if (input.retired === true) {
        // Only release work owned by this retired job. Native mutation receipts
        // and file/graph operations remain under their original identities.
        this.db.prepare("UPDATE maintenance_work SET state='pending',job_id=NULL,available_at=0,error=NULL WHERE kind=? AND job_id=? AND state IN('processing','review')").run(input.kind, input.jobId);
        this.db.prepare("UPDATE maintenance_batches SET state='released' WHERE kind=? AND job_id=?").run(input.kind, input.jobId);
        return;
      }
      this.db.prepare("UPDATE maintenance_work SET state='pending',job_id=NULL,available_at=?,error=? WHERE kind=? AND job_id=? AND state='processing'").run(Date.now() + 300000, String(input.reason || '任务未完成，稍后重试。').slice(0, 1000), input.kind, input.jobId);
      this.db.prepare("UPDATE maintenance_batches SET state='released' WHERE job_id=? AND state='processing'").run(input.jobId);
    })();
    return this.next(input);
  }
  seed(input) {
    if (!Array.isArray(input.records) || input.records.length > 20) throw new TypeError('A bounded historical maintenance page is required.');
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE maintenance_work SET state=?,job_id=?,available_at=?,error=NULL WHERE kind=? AND note_id=? AND checksum=? AND state IN('pending','reviewed','derived')");
      const version = this.db.prepare(`SELECT w.state,w.available_at AS availableAt,w.error AS previousError,m.created_at FROM maintenance_work w JOIN mutations m ON m.id=w.note_id AND m.checksum=w.checksum WHERE w.kind=? AND w.note_id=? AND w.checksum=?`);
      for (const record of input.records) {
        this.validate(record); if (!Array.isArray(record.sources) || record.sources.length > 48 || record.sources.some(s => !validId(s.id) || !validSum(s.checksum))) throw new TypeError('Historical source versions are invalid.');
        const reserved = new Set(record.reserved || []);
        const contexts = [], seeds = [];
        for (const source of record.sources) {
          const current = version.get(record.kind, source.id, source.checksum);
          if (source.contextOnly) {
            const available = current && ['pending','reviewed','derived'].includes(current.state);
            contexts.push({ id: source.id, checksum: source.checksum, previousState: available ? current.state : 'pending', availableAt: current?.availableAt || 0, previousError: current?.previousError || null });
            if (!available || !reserved.has(source.id)) continue;
          } else seeds.push(source);
          if (current?.state === 'derived' && !reserved.has(source.id)) continue;
          const held = reserved.has(source.id), maturity = Date.parse(current?.created_at) + settlingPeriod;
          const young = record.kind === 'organize' && !held && !source.fromCandidate && !source.contextOnly && current?.state === 'pending'
            && Number.isFinite(Date.parse(record.analyzedAt)) && maturity > Date.parse(record.analyzedAt);
          update.run(held ? 'review' : young ? 'pending' : 'reviewed', held ? record.jobId : null,
            young ? maturity : 0, record.kind, source.id, source.checksum);
        }
        if (record.jobId) this.db.prepare("INSERT OR IGNORE INTO maintenance_batches(job_id,kind,revision,sources_json,state,created_at,contexts_json) VALUES(?,?,?,?,'complete',?,?)").run(record.jobId, record.kind, this.host.tombstones().revision, JSON.stringify(seeds), new Date().toISOString(), JSON.stringify(contexts));
      }
    })();
    return { imported: true };
  }
  associate(input) {
    this.validate(input);
    return this.db.transaction(() => {
      const batch = this.db.prepare('SELECT * FROM maintenance_batches WHERE job_id=?').get(input.jobId);
      if (!batch || batch.kind !== input.kind || batch.state !== 'processing') throw fail('Related memory requires the current claimed seed batch.');
      if (batch.revision !== this.host.tombstones().revision) throw fail('The claimed source revision has changed.');
      const dream = input.kind === 'dream', retrieval = input.retrieval;
      if (retrieval?.engine !== (dream ? 'DreamWaveEngine' : 'DailyNoteManager.Associate') || retrieval.sourceRevision !== batch.revision) {
        throw fail('Associated diaries require the current native retrieval and source revision.');
      }
      const hits = dream ? Object.values(retrieval.groups ?? {}).flat() : retrieval.items;
      if (!Array.isArray(hits) || (!dream && hits.length > 10)) throw fail('Expected native diary references.');
      if (batch.contexts_json !== null) return { items: JSON.parse(batch.contexts_json).map(({ id, checksum }) => ({ id, checksum })) };
      const seeds = new Set(JSON.parse(batch.sources_json).map(source => source.id)), contexts = [];
      const query = this.db.prepare(`SELECT m.id,w.checksum,w.state AS previousState,w.available_at AS availableAt,w.error AS previousError
        FROM mutations m JOIN maintenance_work w ON w.note_id=m.id WHERE m.id=? AND w.kind=? AND w.state IN('pending','reviewed','derived')
        AND w.job_id IS NULL AND ${this.eligible()}`);
      for (const hit of hits) {
        if (contexts.length >= 24) break;
        if (!validId(hit?.id) || !validSum(hit.checksum) || seeds.has(hit.id) || contexts.some(source => source.id === hit.id)) continue;
        if (!dream && (!Array.isArray(hit.seedIds) || !hit.seedIds.length || !hit.seedIds.every(id => seeds.has(id)))) continue;
        const note = query.get(hit.id, input.kind);
        if (!note || note.checksum !== hit.checksum) continue;
        this.db.prepare("UPDATE maintenance_work SET state='processing',job_id=? WHERE kind=? AND note_id=? AND checksum=? AND state=? AND job_id IS NULL").run(input.jobId, input.kind, note.id, note.checksum, note.previousState); contexts.push(note);
      }
      this.db.prepare('UPDATE maintenance_batches SET contexts_json=? WHERE job_id=?').run(JSON.stringify(contexts), input.jobId);
      return { items: contexts.map(({ id, checksum }) => ({ id, checksum })) };
    })();
  }
}
module.exports = { MaintenanceWork };
