'use strict';
// Managed IDs/receipts around the preserved VCP storage and indexing pipeline.
// No model-selected path and no call to the older broad-scan DailyNote.update.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { diaryDateSql, validDate, dateRange } = require('./diary-calendar.cjs');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const checksum = text => crypto.createHash('md5').update(text).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const tagsOf = value => [...new Set((typeof value === 'string' ? value.split(/[,，、\n]/u) : Array.isArray(value) ? value : [])
  .map(tag => String(tag).trim()).filter(Boolean))].slice(0, 32).map(tag => Array.from(tag).slice(0, 64).join(''));
const idOk = id => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id);
const sumOk = value => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
const terminal = state => ['indexed', 'conflict', 'withdrawn'].includes(state);
const unfinishedOperation = "state NOT IN ('indexed','conflict','withdrawn')";
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
class ManagedNotes {
  constructor(host) {
    this.host = host; this.db = host.db; this.tail = Promise.resolve();
    this.db.pragma('synchronous = FULL');
    for (const [name, type] of [['tags_json', 'TEXT'], ['updated_at', 'TEXT']]) {
      if (!this.db.prepare('PRAGMA table_info(mutations)').all().some(column => column.name === name)) this.db.exec(`ALTER TABLE mutations ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS managed_operations(operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,plan_json TEXT NOT NULL,receipt_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS managed_unfinished_operations ON managed_operations(state) WHERE ${unfinishedOperation};
      CREATE TABLE IF NOT EXISTS managed_operation_sources(operation_id TEXT NOT NULL,note_id TEXT NOT NULL,PRIMARY KEY(operation_id,note_id));
      CREATE INDEX IF NOT EXISTS managed_sources_note ON managed_operation_sources(note_id);
      CREATE INDEX IF NOT EXISTS mutations_indexed_catalog ON mutations(created_at DESC,id DESC) WHERE state='indexed';
      CREATE INDEX IF NOT EXISTS mutations_indexed_calendar ON mutations((${diaryDateSql()}) DESC,created_at DESC,id DESC) WHERE state='indexed';
      CREATE TABLE IF NOT EXISTS note_dependencies(parent_id TEXT NOT NULL,child_id TEXT NOT NULL,operation_id TEXT NOT NULL,PRIMARY KEY(parent_id,child_id));
      CREATE INDEX IF NOT EXISTS note_dependencies_child ON note_dependencies(child_id,parent_id);`);
    this.unfinishedOperation = this.db.prepare(`SELECT 1 FROM managed_operations WHERE ${unfinishedOperation} LIMIT 1`);
    this.unknownOperation = this.db.prepare(`SELECT 1 FROM managed_operations WHERE ${unfinishedOperation} AND state='unknown' LIMIT 1`);
  }
  serial(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => undefined); return result; }
  validate(payload, kind) {
    this.assertSourceRevision(payload);
    for (const key of ['operationId', 'sourceEventId']) if (typeof payload[key] !== 'string' || !payload[key] || payload[key].length > 512 || payload[key].includes('\0')) throw new TypeError('Stable operation and source IDs are required.');
    if (typeof payload.content !== 'string' || !payload.content.trim()) throw new TypeError('Managed note content must be a non-empty string.');
    if (payload.tags !== undefined && (typeof payload.tags !== 'string' || payload.tags.length > 4096)) throw new TypeError('Managed tags must be a bounded string.');
    if (payload.crystal !== undefined) {
      const crystal = payload.crystal;
      if (kind !== 'organize' || !crystal || typeof crystal.content !== 'string' || !crystal.content.trim() || !Array.isArray(crystal.tags)
        || !crystal.tags.length || crystal.tags.length > 12 || crystal.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 64 || /[,，、\r\n]/u.test(tag))
        || !tagsOf(payload.tags).some(tag => crystal.tags.includes(tag))) throw new TypeError('A crystal volume must have content and share an event tag with its chronicle.');
    }
    if (payload.sourceRootEventId !== undefined && (typeof payload.sourceRootEventId !== 'string' || !payload.sourceRootEventId || payload.sourceRootEventId.length > 512 || payload.sourceRootEventId.includes('\0'))) throw new TypeError('Invalid source root ID.');
    const messages = payload.sourceMessageIds ?? [];
    if (!Array.isArray(messages) || messages.length > 2000 || messages.some(id => typeof id !== 'string' || !id || id.length > 512 || id.includes('\0'))) throw new TypeError('Invalid source message IDs.');
    if (kind === 'update' && (!idOk(payload.id) || !sumOk(payload.expectedChecksum))) throw new TypeError('Owned note ID and expectedChecksum are required.');
    if (payload.evidenceSources !== undefined && (kind !== 'update' || !Array.isArray(payload.evidenceSources) || payload.evidenceSources.length > 19
      || new Set(payload.evidenceSources.map(ref => ref?.id)).size !== payload.evidenceSources.length || payload.evidenceSources.some(ref => !idOk(ref?.id)
        || ref.id === payload.id || !sumOk(ref.expectedChecksum)))) throw new TypeError('An annotation requires distinct owned evidence versions.');
    if (kind === 'organize' && (!Array.isArray(payload.sources) || !payload.sources.length || payload.sources.length > 20
      || new Set(payload.sources.map(value => value.id)).size !== payload.sources.length || payload.sources.some(value => !idOk(value.id) || !sumOk(value.expectedChecksum)))) throw new TypeError('One to twenty distinct owned source notes and checksums are required.');
  }
  assertSourceRevision(payload) {
    if (payload.expectedSourceRevision === undefined) return;
    if (typeof payload.expectedSourceRevision !== 'string' || !/^(0|[1-9][0-9]{0,15})$/u.test(payload.expectedSourceRevision)) throw new TypeError('Invalid expected source revision.');
    if (payload.expectedSourceRevision !== this.host.tombstones().revision) throw error('MEMORY_SOURCE_WITHDRAWN', 'Memory sources changed after this maintenance plan was prepared.');
  }
  row(id) { if (!idOk(id)) throw new TypeError('Owned note ID is required.'); const row = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(id);
    if (!row || ['forgotten', 'withdrawing'].includes(row.state) || this.host.blocked('note', id)) throw error('MEMORY_NOTE_UNAVAILABLE', 'The owned note is unavailable in this domain.'); return row; }
  async physicalInfo(relative, allowMissing = false) {
    const root = path.join(this.host.home, 'dailynote'), absolute = this.host.notePath(relative);
    const parts = path.relative(root, absolute).split(path.sep); let current = root;
    for (const part of ['', ...parts.slice(0, -1)]) {
      if (part) current = path.join(current, part);
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(current), current)) throw error('MEMORY_OUTCOME_UNKNOWN', 'Managed note directory is not a physical owned directory.');
    }
    let info; try { info = await fs.lstat(absolute); } catch (cause) { if (allowMissing && cause.code === 'ENOENT') return null; throw cause; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || !samePath(await fs.realpath(absolute), absolute)) throw error('MEMORY_OUTCOME_UNKNOWN', 'Managed note is not an owned regular file.');
    return { absolute, info };
  }
  async physical(relative, allowMissing = false) {
    const entry = await this.physicalInfo(relative, allowMissing);
    if (!entry) return null;
    const { absolute, info } = entry;
    const text = await fs.readFile(absolute, 'utf8'), after = await fs.lstat(absolute);
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ino !== after.ino) throw error('MEMORY_OUTCOME_UNKNOWN', 'Managed note changed during verification.');
    return { absolute, text, checksum: checksum(text), info: after };
  }
  async readNote({ id }) {
    const row = this.row(id);
    if (this.db.prepare("SELECT 1 FROM managed_operation_sources s JOIN managed_operations o USING(operation_id) WHERE s.note_id=? AND o.state='unknown' LIMIT 1").get(id)) throw error('MEMORY_OUTCOME_UNKNOWN', 'This note belongs to an unresolved mutation.');
    if (!row.note_path || ['writing', 'failed', 'unknown'].includes(row.state)) throw error('MEMORY_OUTCOME_UNKNOWN', 'This note has no confirmed current file version.');
    const actual = await this.physical(row.note_path);
    if (actual.checksum !== row.checksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'The note file differs from its last confirmed version.');
    let tags = row.tags_json ? JSON.parse(row.tags_json) : null;
    if (!tags) { const line = actual.text.trimEnd().split('\n').at(-1); tags = /^Tag:\s*/iu.test(line) ? tagsOf(line.replace(/^Tag:\s*/iu, '')) : [];
      this.db.prepare('UPDATE mutations SET tags_json=? WHERE id=?').run(JSON.stringify(tags), id); }
    return { id, content: row.content || '', checksum: actual.checksum, indexState: row.state, tags, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at,
      sourceEventId: row.source_root || row.source_event, sourceMessageIds: JSON.parse(row.source_messages || '[]') };
  }
  catalog({ query = '', tag = '', cursor, fromDate, toDate, indexedOnly = false, limit = indexedOnly ? 20 : 30 } = {}) {
    const dated = dateRange(fromDate, toDate);
    if (dated && !indexedOnly) throw new TypeError('Date-filtered maintenance requires the indexed diary catalog.');
    if (typeof indexedOnly !== 'boolean' || typeof query !== 'string' || query.length > 4000 || typeof tag !== 'string' || tag.length > 64 || !Number.isSafeInteger(limit) || limit < 1 || limit > (indexedOnly ? 20 : 60)) throw new TypeError('Invalid memory catalog filter.');
    const escape = value => value.replace(/[\\%_]/gu, '\\$&');
    let boundary; if (cursor) { if (typeof cursor !== 'string' || cursor.length > 1024) throw new TypeError('Invalid memory catalog cursor.');
      try { boundary = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new TypeError('Invalid memory catalog cursor.'); }
      const valid = dated ? Array.isArray(boundary) && boundary.length === 5 && validDate(boundary[0]) && typeof boundary[1] === 'string'
        && idOk(boundary[2]) && boundary[3] === (fromDate ?? null) && boundary[4] === (toDate ?? null)
        : Array.isArray(boundary) && boundary.length === 2 && typeof boundary[0] === 'string' && idOk(boundary[1]);
      if (!valid) throw new TypeError('Invalid memory catalog cursor.'); }
    const where = ["state NOT IN ('forgotten','withdrawing')"], values = [];
    if (query) { where.push("content LIKE ? ESCAPE '\\'"); values.push('%' + escape(query) + '%'); }
    if (tag) { where.push("EXISTS(SELECT 1 FROM json_each(COALESCE(tags_json,'[]')) WHERE value=?)"); values.push(tag); }
    if (indexedOnly) {
      this.host.assertWithdrawalsSettled();
      const day = diaryDateSql('m');
      if (fromDate) { where.push(`(${day})>=?`); values.push(fromDate); }
      if (toDate) { where.push(`(${day})<=?`); values.push(toDate); }
      if (boundary) {
        if (dated) { where.push(`(${day},m.created_at,m.id)<(?,?,?)`); values.push(...boundary.slice(0,3)); }
        else { where.push('(m.created_at,m.id)<(?,?)'); values.push(...boundary); }
      }
      // Full-inventory maintenance reads small, checksum-addressed pages. The
      // planner must open and verify the selected notes before using their text.
      const rows = this.db.prepare(`SELECT m.id,m.checksum,m.tags_json,m.created_at,m.updated_at,${day} AS diary_day FROM mutations m INDEXED BY ${dated ? 'mutations_indexed_calendar' : 'mutations_indexed_catalog'}
        WHERE m.state='indexed' AND length(m.checksum)=32 AND m.note_path GLOB 'Companion/*' AND instr(substr(m.note_path,11),'/')=0
        AND EXISTS(SELECT 1 FROM mutation_sources s WHERE s.note_id=m.id AND s.kind='event')
        AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.kind='note' AND t.id=m.id)
        AND NOT EXISTS(SELECT 1 FROM mutation_sources s JOIN tombstones t ON t.kind=s.kind AND t.id=s.id WHERE s.note_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM managed_operation_sources s JOIN managed_operations o USING(operation_id)
          WHERE s.note_id=m.id AND o.state NOT IN('indexed','conflict','withdrawn'))
        AND ${where.join(' AND ')} ORDER BY ${dated ? 'diary_day DESC,' : ''}m.created_at DESC,m.id DESC LIMIT ?`).all(...values, limit + 1);
      const selected = rows.slice(0, limit), last = selected.at(-1);
      const after = row => Buffer.from(JSON.stringify(dated ? [row.diary_day,row.created_at,row.id,fromDate ?? null,toDate ?? null] : [row.created_at, row.id])).toString('base64url');
      return { items: selected.map(row => ({ id: row.id, checksum: row.checksum, indexState: 'indexed', createdAt: row.created_at, diaryDate: row.diary_day,
        updatedAt: row.updated_at || row.created_at, tags: row.tags_json ? JSON.parse(row.tags_json) : [], afterCursor: after(row) })),
        ...(rows.length > limit ? { nextCursor: after(last) } : {}) };
    }
    const filter = where.join(' AND '), total = this.db.prepare(`SELECT COUNT(*) AS n FROM mutations WHERE ${filter}`).get(...values).n;
    const liveEligibleCount = this.db.prepare(`SELECT COUNT(*) AS n FROM mutations m WHERE m.state='indexed'
      AND NOT EXISTS(SELECT 1 FROM managed_operation_sources s JOIN managed_operations o USING(operation_id) WHERE s.note_id=m.id AND o.state='unknown')
      AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.kind='note' AND t.id=m.id)
      AND NOT EXISTS(SELECT 1 FROM mutation_sources s JOIN tombstones t ON t.kind=s.kind AND t.id=s.id WHERE s.note_id=m.id)`).get().n;
    const tags = this.db.prepare(`SELECT j.value AS name,COUNT(*) AS count FROM mutations m,json_each(COALESCE(m.tags_json,'[]')) j WHERE ${filter}
      GROUP BY j.value ORDER BY count DESC,j.value LIMIT 100`).all(...values);
    if (boundary) { where.push('(created_at<? OR (created_at=? AND id<?))'); values.push(boundary[0], boundary[0], boundary[1]); }
    // Older journals may predate marking the organized output itself unknown.
    // Project the durable operation fence as well as the cached note state.
    const unresolved = `m.state='unknown' OR EXISTS(SELECT 1 FROM managed_operation_sources s JOIN managed_operations o USING(operation_id) WHERE s.note_id=m.id AND o.state='unknown')`;
    const rows = this.db.prepare(`SELECT m.id,CASE WHEN ${unresolved} THEN '' ELSE substr(m.content,1,240) END AS content,m.checksum,
      CASE WHEN ${unresolved} THEN 'unknown' ELSE m.state END AS state,m.tags_json,m.created_at,m.updated_at FROM mutations m
      WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...values, limit + 1);
    const more = rows.length > limit, selected = rows.slice(0, limit), last = selected.at(-1);
    return { liveEligibleCount, items: selected.map(row => ({ id: row.id, content: row.content || '', checksum: row.checksum, indexState: row.state, tags: row.tags_json ? JSON.parse(row.tags_json) : [],
      tagsKnown: row.tags_json !== null, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at })), total, tags,
      ...(more && last ? { nextCursor: Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url') } : {}) };
  }
  operation(id) { return this.db.prepare('SELECT * FROM managed_operations WHERE operation_id=?').get(id); }
  operationReceipt({ operationId, kind, input }) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 512) throw new TypeError('Stable operation ID is required.');
    const op = this.operation(operationId); if (!op) return { found: false };
    if (kind !== undefined && kind !== op.kind || input !== undefined && (input.operationId !== operationId || !['update','organize'].includes(kind) || hash(canonical([kind, input])) !== op.fingerprint))
      throw error('MEMORY_CONFLICT', 'Operation receipt parameters differ from the admitted mutation.');
    if (op.state === 'unknown' || op.state === 'prepared') return { found: true, receipt: { status: 'unknown', state: 'unknown', operationId, journalState: op.state } };
    if (op.receipt_json) return { found: true, receipt: JSON.parse(op.receipt_json) };
    const plan = JSON.parse(op.plan_json), id = op.kind === 'update' ? plan.sources[0].id : plan.newId;
    return { found: true, receipt: { status: op.state === 'archiving' ? 'partial' : 'pending', state: op.state === 'archiving' ? 'partial' : 'pending',
      operationId, id, checksum: plan.newChecksum, indexed: false, fileCommitted: true,
      ...(op.kind === 'organize' ? { archived: plan.sources.filter(source => this.db.prepare("SELECT 1 FROM mutations WHERE id=? AND state='archived'").get(source.id)).map(source => source.id) } : {}) } };
  }
  save(op, state, receipt, message) { this.db.prepare('UPDATE managed_operations SET state=?,receipt_json=?,error=?,updated_at=? WHERE operation_id=?')
    .run(state, receipt ? JSON.stringify(receipt) : null, message || null, new Date().toISOString(), op.operation_id); }
  async makePlan(payload, kind) {
    const prior = this.operation(payload.operationId), fingerprint = hash(canonical([kind, payload]));
    if (prior) { if (prior.fingerprint !== fingerprint || prior.kind !== kind) throw error('MEMORY_CONFLICT', 'Operation ID already belongs to a different mutation.'); return prior; }
    const sources = kind === 'update' ? [{ id: payload.id, expectedChecksum: payload.expectedChecksum }] : payload.sources;
    const snapshots = [];
    const evidence = [];
    for (const source of [...sources, ...(payload.evidenceSources || [])]) {
      const row = this.row(source.id);
      if (!['indexed', 'pending'].includes(row.state)) throw error('MEMORY_NOTE_UNAVAILABLE', 'Only an active confirmed note can be updated or organized.');
      const busy = this.db.prepare(`SELECT o.operation_id FROM managed_operation_sources s JOIN managed_operations o USING(operation_id)
        WHERE s.note_id=? AND o.state NOT IN ('indexed','conflict','withdrawn') LIMIT 1`).get(source.id);
      if (busy) throw error('MEMORY_OUTCOME_UNKNOWN', 'This note has an unresolved earlier mutation.');
      const actual = await this.physical(row.note_path);
      if (actual.checksum !== row.checksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'Owned note differs from its confirmed file version.');
      if (actual.checksum !== source.expectedChecksum) {
        const receipt = { status: 'conflict', state: 'conflict', updated: false, id: source.id,
          expectedChecksum: source.expectedChecksum, actualChecksum: actual.checksum, operationId: payload.operationId }, now = new Date().toISOString();
        this.db.prepare('INSERT INTO managed_operations VALUES(?,?,?,?,?,?,?,?,?)').run(payload.operationId, kind, fingerprint, 'conflict', JSON.stringify({ payload, sources: [] }), JSON.stringify(receipt), null, now, now);
        return { conflict: receipt };
      }
      if (kind === 'update' && source.id !== payload.id) {
        if (row.state !== 'indexed') throw error('MEMORY_NOTE_UNAVAILABLE', 'Annotation evidence must be currently indexed.');
        if (this.db.prepare(`WITH RECURSIVE ancestor(id) AS (SELECT ? UNION SELECT d.parent_id FROM note_dependencies d JOIN ancestor a ON d.child_id=a.id)
          SELECT 1 FROM ancestor WHERE id=? LIMIT 1`).get(source.id, payload.id)) throw error('MEMORY_CONFLICT', 'This annotation would create a circular source dependency.');
        evidence.push({ ...source, path: row.note_path }); continue;
      }
      const lastLine = actual.text.trimEnd().split('\n').at(-1);
      snapshots.push({ ...source, path: row.note_path, oldText: actual.text, oldContent: row.content,
        tags: row.tags_json ? JSON.parse(row.tags_json) : /^Tag:\s*.+/iu.test(lastLine) ? tagsOf(lastLine.replace(/^Tag:\s*/iu, '')) : [] });
    }
    const root = payload.sourceRootEventId || payload.sourceEventId, messages = payload.sourceMessageIds || [];
    if (this.host.blocked('event', root) || this.host.blocked('event', payload.sourceEventId) || messages.some(id => this.host.blocked('message', id))) return { conflict: { status: 'withdrawn', state: 'withdrawn', withdrawn: true, operationId: payload.operationId } };
    const selectedTags = payload.tags === undefined ? snapshots[0].tags : tagsOf(payload.tags), tags = selectedTags.length ? selectedTags : ['对话记录'];
    const plan = { payload, sources: snapshots, ...(evidence.length && { evidence }), tags, revisedAt: new Date().toISOString() };
    if (kind === 'update') {
      const [firstLine, oldTime] = snapshots[0].oldText.split('\n', 2);
      const body = payload.content.trimEnd().split('\n'); if (/^Tag:\s*.+/iu.test(body.at(-1).trim())) body.pop();
      if (/^\[\d{1,2}:\d{2}(?::\d{2})?\]$/u.test(oldTime || '') && !/^\[\d{1,2}:\d{2}(?::\d{2})?\](?:\s|$)/u.test(body[0])) body.unshift(oldTime);
      plan.newText = `${firstLine}\n${body.join('\n').trimEnd()}\n\n受管修订时间：${plan.revisedAt}\n修订来源事件：${payload.sourceEventId}\nTag: ${tags.join(', ') || '对话记录'}`;
      plan.newChecksum = checksum(plan.newText);
    } else {
      plan.newId = hash(payload.sourceEventId);
      if (sources.some(source => source.id === plan.newId)) throw error('MEMORY_CONFLICT', 'Organized output cannot reuse a source identity.');
      if (this.db.prepare('SELECT 1 FROM mutations WHERE id=?').get(plan.newId)) throw error('MEMORY_CONFLICT', 'Organized output identity already belongs to another write.');
      const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
      const part = name => parts.find(value => value.type === name).value, date = ['year','month','day'].map(part).join('-');
      const hour = part('hour') === '24' ? '00' : part('hour');
      plan.newPath = `Companion/${date}-${hour}_${part('minute')}_${part('second')}-${plan.newId}.txt`;
      const body = payload.content.trimEnd().split('\n'); if (/^Tag:\s*.+/iu.test(body.at(-1).trim())) body.pop();
      plan.author = this.host.authorName;
      const origins = sources.map(source => source.id).join(', ');
      const chronicle = payload.crystal ? `[整理合并·脉络卷] 原始来源：${origins}\n` : '';
      plan.newText = `[${date}] - ${plan.author}\n[${hour}:${part('minute')}]\n${chronicle}${body.join('\n').trimEnd()}\n\n整理时间：${plan.revisedAt}\n来源记忆：${origins}\nTag: ${tags.join(', ') || '对话记录'}`;
      plan.newChecksum = checksum(plan.newText);
      if (payload.crystal) {
        const sourceEventId = 'organized-crystal-' + hash(payload.operationId), id = hash(sourceEventId);
        if (id === plan.newId || this.db.prepare('SELECT 1 FROM mutations WHERE id=?').get(id) || this.host.blocked('note', id) || this.host.blocked('event', sourceEventId))
          throw error('MEMORY_CONFLICT', 'Crystal output identity already belongs to another write.');
        const time = `${hour}:${part('minute')}:${part('second')}`;
        const extension = String(process.env.DAILY_NOTE_EXTENSION || 'txt').toLowerCase() === 'md' ? 'md' : 'txt';
        const crystalBody = payload.crystal.content.trimEnd().split('\n');
        if (/^Tag:\s*.+/iu.test(crystalBody.at(-1).trim())) crystalBody.pop();
        const content = `[${time}]\n[整理合并·结晶卷] 原始来源：${origins}\n${crystalBody.join('\n').trimEnd()}`;
        // DailyNote.create canonicalizes its external Tag line, including trailing punctuation.
        const tag = tagsOf(payload.crystal.tags).join(', ').replace(/：/gu, '').replace(/[。.]+$/gu, '').replace(/\s+,/gu, ',').replace(/\s{2,}/gu, ' ').trim();
        plan.crystal = { id, sourceEventId, date, content, tag, path: `Companion/${date}-${time.replaceAll(':', '_')}-${id}.${extension}`,
          checksum: checksum(`[${date}] - ${plan.author}\n${content}\nTag: ${tag}`) };
      }
      for (const source of snapshots) source.archivePath = `已整理/${source.id}-${hash(payload.operationId).slice(0, 16)}${path.extname(source.path)}`;
    }
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO managed_operations VALUES(?,?,?,?,?,?,?,?,?)').run(payload.operationId, kind, fingerprint, 'prepared', JSON.stringify(plan), null, null, now, now);
      for (const source of sources) this.db.prepare('INSERT INTO managed_operation_sources VALUES(?,?)').run(payload.operationId, source.id);
      if (plan.newId) {
        this.db.prepare('INSERT INTO mutations(id,hash,state,note_path,checksum,created_at,source_event,source_root,source_messages,content,tags_json,updated_at,author_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(plan.newId, hash(payload.content), 'writing', plan.newPath, plan.newChecksum, now, payload.sourceEventId,
            payload.sourceRootEventId || payload.sourceEventId, JSON.stringify(payload.sourceMessageIds || []), payload.content, JSON.stringify(plan.tags), now, plan.author);
        this.db.prepare('INSERT INTO managed_operation_sources VALUES(?,?)').run(payload.operationId, plan.newId);
        for (const source of sources) this.db.prepare('INSERT OR IGNORE INTO note_dependencies VALUES(?,?,?)').run(source.id, plan.newId, payload.operationId);
        this.addSources(plan.newId, payload, sources.map(source => source.id));
        if (plan.crystal) {
          const crystal = plan.crystal;
          this.db.prepare('INSERT INTO mutations(id,hash,state,note_path,checksum,created_at,source_event,source_root,source_messages,content,tags_json,updated_at,author_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(crystal.id, hash(payload.crystal.content), 'writing', crystal.path, crystal.checksum, now, crystal.sourceEventId,
              root, JSON.stringify(messages), payload.crystal.content, JSON.stringify(tagsOf(crystal.tag)), now, plan.author);
          this.db.prepare('INSERT INTO managed_operation_sources VALUES(?,?)').run(payload.operationId, crystal.id);
          for (const source of sources) this.db.prepare('INSERT INTO note_dependencies VALUES(?,?,?)').run(source.id, crystal.id, payload.operationId);
          this.addSources(crystal.id, { ...payload, sourceEventId: crystal.sourceEventId, sourceRootEventId: root });
        }
      }
    })();
    return this.operation(payload.operationId);
  }
  addSources(id, payload, parents = []) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO mutation_sources VALUES(?,?,?)');
    for (const source of [payload.sourceEventId, payload.sourceRootEventId].filter(Boolean)) insert.run(id, 'event', source);
    for (const message of payload.sourceMessageIds || []) insert.run(id, 'message', message);
    // Parent lineage is directional in note_dependencies. Do not flatten a
    // parent's event IDs into the child: forgetting A must not walk backwards
    // through merged(A,B) and erase the independent source B.
    void parents;
    const messages = this.db.prepare("SELECT id FROM mutation_sources WHERE note_id=? AND kind='message'").all(id).map(row => row.id);
    this.db.prepare('UPDATE mutations SET source_messages=? WHERE id=?').run(JSON.stringify(messages), id);
  }
  async atomicReplace(source, plan, operationId) {
    const actual = await this.physical(source.path);
    if (actual.checksum === plan.newChecksum) return;
    if (actual.checksum !== source.expectedChecksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'A third file version prevents mutation recovery.');
    const temporary = path.join(path.dirname(actual.absolute), `.wlb-${hash(operationId)}.tmp`);
    let handle;
    try { handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(plan.newText, 'utf8'); await handle.sync(); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause;
      const stat = await fs.lstat(temporary); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || checksum(await fs.readFile(temporary, 'utf8')) !== plan.newChecksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'Mutation temporary file has an unknown version.'); }
    finally { await handle?.close(); }
    const before = await this.physical(source.path);
    if (before.checksum !== source.expectedChecksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'Note changed before atomic mutation commit.');
    await fs.rename(temporary, actual.absolute);
    if ((await this.physical(source.path)).checksum !== plan.newChecksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'Note changed during atomic mutation commit.');
  }
  update(runtime, payload) { return this.serial(() => this.mutate(runtime, payload, 'update')); }
  organize(runtime, payload) { return this.serial(() => this.mutate(runtime, payload, 'organize')); }
  async mutate(runtime, payload, kind) {
    this.validate(payload, kind);
    const op = await this.makePlan(payload, kind); if (op.conflict) return op.conflict;
    if (terminal(op.state)) return JSON.parse(op.receipt_json);
    const plan = JSON.parse(op.plan_json);
    try {
      for (const source of plan.sources) this.row(source.id);
      if (kind === 'update') return await this.applyUpdate(runtime, op, plan);
      return await this.applyOrganize(runtime, op, plan);
    } catch (cause) {
      if (cause.code === 'MEMORY_ANNOTATION_CONFLICT') {
        const receipt = { status: 'conflict', state: 'conflict', updated: false, id: plan.sources[0].id, operationId: op.operation_id };
        this.db.transaction(() => {
          this.db.prepare('DELETE FROM note_dependencies WHERE operation_id=?').run(op.operation_id);
          this.save(op, 'conflict', receipt);
        })();
        return receipt;
      }
      if (cause.code === 'MEMORY_NOTE_UNAVAILABLE') {
        const receipt = { status: 'withdrawn', state: 'withdrawn', withdrawn: true, operationId: op.operation_id };
        this.save(op, 'withdrawn', receipt); return receipt;
      }
      if (cause.code === 'MEMORY_OUTCOME_UNKNOWN') {
        this.save(op, 'unknown', null, cause.code);
        this.db.prepare(`UPDATE mutations SET state='unknown' WHERE id IN (SELECT note_id FROM managed_operation_sources WHERE operation_id=?)
          AND state NOT IN ('forgotten','withdrawing')`).run(op.operation_id);
        throw cause;
      }
      const current = this.db.prepare('SELECT checksum,state FROM mutations WHERE id=?').get(kind === 'update' ? plan.sources[0].id : plan.newId);
      const receipt = { status: op.kind === 'organize' ? 'partial' : 'pending', state: op.kind === 'organize' ? 'partial' : 'pending', operationId: op.operation_id,
        id: kind === 'update' ? plan.sources[0].id : plan.newId, checksum: current?.checksum, plannedChecksum: plan.newChecksum,
        fileCommitted: this.operation(op.operation_id).state !== 'prepared',
        indexed: false, error: { code: cause.code || 'MEMORY_INDEX_PENDING', message: 'Mutation remains durable and requires its original operation to be resumed.' } };
      this.save(op, 'pending', receipt, cause.code || cause.message); return receipt;
    }
  }
  async applyUpdate(runtime, op, plan) {
    await runtime.start({ vectors: true });
    const source = plan.sources[0];
    await runtime.kb.runExternalFileMutation('WorldlineBoxUpdate:' + hash(op.operation_id), async () => {
      if (plan.evidence?.length) {
        if (!(await this.evidenceIntact(runtime, plan))) {
          const file = await this.physical(source.path);
          if (file.checksum !== source.expectedChecksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'Evidence changed after an annotation may have committed.');
          throw error('MEMORY_ANNOTATION_CONFLICT', 'The cited diary changed before the annotation was written.');
        }
        this.assertSourceRevision(plan.payload);
        const link = this.db.prepare('INSERT OR IGNORE INTO note_dependencies VALUES(?,?,?)');
        this.db.transaction(() => { for (const ref of plan.evidence) link.run(ref.id, source.id, op.operation_id); })();
      }
      await this.atomicReplace(source, plan, op.operation_id);
      return { status: 'success', mutationPaths: { upserts: [this.host.notePath(source.path)], deletes: [] } };
    }, { waitForIndex: false });
    this.db.transaction(() => {
      this.db.prepare("UPDATE mutations SET content=?,checksum=?,state='pending',tags_json=?,updated_at=? WHERE id=?")
        .run(plan.payload.content, plan.newChecksum, JSON.stringify(plan.tags), new Date().toISOString(), source.id);
      this.addSources(source.id, plan.payload); this.save(op, 'file_committed');
    })();
    const indexed = await this.host.sync(runtime, { id: source.id });
    if (!indexed.receipts.some(receipt => receipt.id === source.id && receipt.state === 'indexed' && receipt.checksum === plan.newChecksum)) throw error('MEMORY_INDEX_PENDING', 'Mutation index receipt is pending.');
    this.clearCaches(runtime);
    const receipt = { status: 'success', state: 'indexed', indexed: true, operationId: op.operation_id, id: source.id, checksum: plan.newChecksum };
    this.save(op, 'indexed', receipt); return receipt;
  }
  async evidenceIntact(runtime, plan) {
    const refs = plan.evidence || [];
    if (!refs.length) return true;
    const probes = await runtime.kb.probeIngestionFiles(refs.map(ref => ref.path));
    const byPath = new Map(probes.map(probe => [probe.path, probe]));
    for (const ref of refs) {
      const row = this.row(ref.id), probe = byPath.get(ref.path);
      if (row.state !== 'indexed' || row.note_path !== ref.path || row.checksum !== ref.expectedChecksum || !probe?.completeVectors
        || !probe.completeTags || probe.checksum !== ref.expectedChecksum || (await this.physical(ref.path)).checksum !== ref.expectedChecksum) return false;
    }
    return true;
  }
  async applyOrganize(runtime, op, plan) {
    await runtime.start({ vectors: true });
    if (this.host.blocked('note', plan.newId) || plan.crystal && this.host.blocked('note', plan.crystal.id)) throw error('MEMORY_NOTE_UNAVAILABLE', 'Organized output was withdrawn.');
    for (const source of plan.sources) {
      const row = this.row(source.id), physical = await this.physical(row.state === 'archived' ? source.archivePath : source.path, true);
      if (physical && physical.checksum !== source.expectedChecksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'Organization source changed after planning.');
    }
    const outputPath = this.host.notePath(plan.newPath);
    await runtime.kb.runExternalFileMutation('WorldlineBoxOrganizeCreate:' + hash(op.operation_id), async () => {
      const existing = await this.physical(plan.newPath, true);
      if (existing && existing.checksum !== plan.newChecksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'Organized output has an unknown version.');
      if (!existing) { const handle = await fs.open(outputPath, 'wx', 0o600); try { await handle.writeFile(plan.newText, 'utf8'); await handle.sync(); } finally { await handle.close(); } }
      return { status: 'success', mutationPaths: { upserts: [outputPath], deletes: [] } };
    }, { waitForIndex: false });
    this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(plan.newId);
      if (current && (current.checksum !== plan.newChecksum || current.content !== plan.payload.content)) throw error('MEMORY_OUTCOME_UNKNOWN', 'Organized ledger differs from its planned output.');
      if (!current) {
        this.db.prepare('INSERT INTO mutations(id,hash,state,note_path,checksum,created_at,source_event,source_root,source_messages,content,tags_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(plan.newId, hash(plan.payload.content), 'pending', plan.newPath, plan.newChecksum, op.created_at, plan.payload.sourceEventId,
            plan.payload.sourceRootEventId || plan.payload.sourceEventId, JSON.stringify(plan.payload.sourceMessageIds || []), plan.payload.content, JSON.stringify(plan.tags), new Date().toISOString());
      }
      // A resumed pair can outlive a lost or rebuilt native index. Probe both files
      // again before retiring any originals, even if SQLite retained one receipt.
      this.db.prepare("UPDATE mutations SET state='pending' WHERE id=? AND (state IN ('writing','pending','unknown') OR state='indexed' AND ?=1)").run(plan.newId, plan.crystal ? 1 : 0);
      this.addSources(plan.newId, plan.payload, plan.sources.map(source => source.id)); this.save(op, 'file_committed');
    })();
    const indexed = await this.host.sync(runtime, { id: plan.newId });
    if (!indexed.receipts.some(receipt => receipt.id === plan.newId && receipt.state === 'indexed' && receipt.checksum === plan.newChecksum)) throw error('MEMORY_INDEX_PENDING', 'Organized output is not indexed.');
    const crystal = plan.crystal ? await this.indexCrystal(runtime, plan) : undefined;
    const ignored = runtime.kb.config?.ignorePrefixes;
    if (!Array.isArray(ignored) || !ignored.some(prefix => '已整理'.startsWith(prefix))) throw error('MEMORY_ARCHIVE_POLICY_REQUIRED', 'The archive must be excluded from VCP scanning before organization.');
    const archiveDir = path.join(this.host.home, 'dailynote', '已整理'); await fs.mkdir(archiveDir, { recursive: true });
    const info = await fs.lstat(archiveDir);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(archiveDir), archiveDir)) throw error('MEMORY_OUTCOME_UNKNOWN', 'Archive is not a physical owned directory.');
    for (const source of plan.sources) {
      await runtime.kb.runExternalFileMutation('WorldlineBoxOrganizeArchive:' + hash(op.operation_id + source.id), async () => {
        const original = await this.physical(source.path, true), archived = await this.physical(source.archivePath, true);
        if (!original && !archived || original && original.checksum !== source.expectedChecksum || archived && archived.checksum !== source.expectedChecksum)
          throw error('MEMORY_OUTCOME_UNKNOWN', 'Organization archive cannot prove one exact surviving source version.');
        if (original) {
          if (!archived) {
            await fs.copyFile(original.absolute, this.host.notePath(source.archivePath), constants.COPYFILE_EXCL);
            const handle = await fs.open(this.host.notePath(source.archivePath), 'r+'); try { await handle.sync(); } finally { await handle.close(); }
          }
          if ((await this.physical(source.path)).checksum !== source.expectedChecksum || (await this.physical(source.archivePath)).checksum !== source.expectedChecksum)
            throw error('MEMORY_OUTCOME_UNKNOWN', 'Source changed while its exclusive archive copy was committed.');
          await fs.unlink(original.absolute);
        }
        if ((await this.physical(source.archivePath)).checksum !== source.expectedChecksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'Archived source checksum differs.');
        return { status: 'success', mutationPaths: { deletes: [this.host.notePath(source.path)], upserts: [] } };
      }, { waitForIndex: true, timeoutMs: 30000 });
      const [probe] = await runtime.kb.probeIngestionFiles([source.path]);
      if (!probe || probe.path !== source.path || probe.exists !== false) throw error('MEMORY_INDEX_PENDING', 'Archived source still has a native index entry.');
      this.db.prepare("UPDATE mutations SET state='archived',note_path=?,updated_at=? WHERE id=?").run(source.archivePath, new Date().toISOString(), source.id);
      this.save(op, 'archiving');
    }
    this.clearCaches(runtime);
    const receipt = { status: 'success', state: 'indexed', indexed: true, operationId: op.operation_id, id: plan.newId, checksum: plan.newChecksum,
      ...(crystal && { crystal }),
      archived: plan.sources.map(source => source.id) };
    this.save(op, 'indexed', receipt); return receipt;
  }
  async indexCrystal(runtime, plan) {
    const crystal = plan.crystal, row = this.row(crystal.id);
    let file = await this.physical(crystal.path, true);
    if (!file) {
      if (row.state === 'indexed') throw error('MEMORY_OUTCOME_UNKNOWN', 'An indexed crystal volume disappeared.');
      const extension = String(process.env.DAILY_NOTE_EXTENSION || 'txt').toLowerCase() === 'md' ? '.md' : '.txt';
      if (path.extname(crystal.path) !== extension) throw error('MEMORY_OUTCOME_UNKNOWN', 'The native diary extension changed during a split operation.');
      // The pinned DailyNote plugin uses the explicit date, HH:MM:SS prefix and
      // filename suffix. A lost reply therefore has one exact, verifiable path.
      const result = await runtime.callTool('DailyNote', { command: 'create', maid: `[Companion]${plan.author}`, folder: 'Companion',
        Date: crystal.date, Content: crystal.content, Tag: crystal.tag, fileName: crystal.id });
      if (result.status === 'error' || !result.result?.fileName) throw error('MEMORY_WRITE_FAILED', 'DailyNote did not confirm the crystal volume.');
      if (result.result.folder !== 'Companion' || result.result.fileName !== path.posix.basename(crystal.path)) throw error('MEMORY_OUTCOME_UNKNOWN', 'DailyNote returned a different crystal file identity.');
      file = await this.physical(crystal.path);
    }
    if (file.checksum !== crystal.checksum) throw error('MEMORY_OUTCOME_UNKNOWN', 'The crystal volume differs from the approved source text.');
    this.db.prepare("UPDATE mutations SET state='pending' WHERE id=? AND state IN ('writing','unknown','indexed')").run(crystal.id);
    const indexed = await this.host.sync(runtime, { id: crystal.id });
    if (!indexed.receipts.some(receipt => receipt.id === crystal.id && receipt.state === 'indexed' && receipt.checksum === crystal.checksum))
      throw error('MEMORY_INDEX_PENDING', 'The crystal volume is awaiting its index receipt.');
    return { id: crystal.id, checksum: crystal.checksum, indexed: true };
  }
  clearCaches(runtime) { for (const name of runtime.rag?.cacheManager?.caches?.keys() || []) runtime.rag.cacheManager.clear(name); }
  assertReadable() { if (this.unknownOperation.get()) throw error('MEMORY_OUTCOME_UNKNOWN', 'A note mutation requires reconciliation before memory can be queried.'); }
  async reconcileExpired(runtime, op, plan) {
    if (plan.sources.some(source => this.host.blocked('note', source.id)) || plan.newId && this.host.blocked('note', plan.newId) || plan.crystal && this.host.blocked('note', plan.crystal.id)) return;
    let receipt = { state: 'unknown', operationId: op.operation_id, reason: 'source-revision-changed' };
    try {
      const id = op.kind === 'update' ? plan.sources[0].id : plan.newId, targetPath = op.kind === 'update' ? plan.sources[0].path : plan.newPath;
      const actual = await this.physical(targetPath, true), [probe] = await runtime.kb.probeIngestionFiles([targetPath]);
      let confirmed = actual?.checksum === plan.newChecksum && probe?.path === targetPath && probe.checksum === plan.newChecksum && probe.completeVectors && probe.completeTags;
      if (confirmed && plan.evidence?.length) confirmed = await this.evidenceIntact(runtime, plan);
      if (confirmed && plan.crystal) {
        const crystal = plan.crystal, file = await this.physical(crystal.path, true), [index] = await runtime.kb.probeIngestionFiles([crystal.path]);
        confirmed = file?.checksum === crystal.checksum && index?.path === crystal.path && index.checksum === crystal.checksum && index.completeVectors && index.completeTags;
      }
      if (confirmed && op.kind === 'organize') for (const source of plan.sources) {
        const original = await this.physical(source.path, true), archived = await this.physical(source.archivePath, true), [absent] = await runtime.kb.probeIngestionFiles([source.path]);
        if (original || archived?.checksum !== source.expectedChecksum || absent?.path !== source.path || absent.exists !== false) { confirmed = false; break; }
      }
      if (confirmed) {
        this.db.transaction(() => {
          this.db.prepare("UPDATE mutations SET state='indexed',note_path=?,checksum=?,content=?,tags_json=?,updated_at=? WHERE id=? AND state NOT IN ('forgotten','withdrawing')")
            .run(targetPath, plan.newChecksum, plan.payload.content, JSON.stringify(plan.tags), plan.revisedAt, id);
          if (op.kind === 'organize') for (const source of plan.sources) this.db.prepare("UPDATE mutations SET state='archived',note_path=? WHERE id=? AND state NOT IN ('forgotten','withdrawing')").run(source.archivePath, source.id);
          if (plan.crystal) this.db.prepare("UPDATE mutations SET state='indexed' WHERE id=? AND state NOT IN ('forgotten','withdrawing')").run(plan.crystal.id);
          this.addSources(id, plan.payload, op.kind === 'organize' ? plan.sources.map(source => source.id) : []);
        })();
        receipt = { state: 'indexed', indexed: true, id, checksum: plan.newChecksum, operationId: op.operation_id, reconciled: true,
          ...(plan.crystal && { crystal: { id: plan.crystal.id, checksum: plan.crystal.checksum, indexed: true } }),
          ...(op.kind === 'organize' ? { archived: plan.sources.map(source => source.id) } : {}) };
      }
    } catch { /* Reconciliation observes bytes/index only; it never replays a write. */ }
    this.host.maintenance.audit(op, op.kind, receipt); this.save(op, receipt.state, receipt);
    if (receipt.state === 'unknown') this.db.prepare(`UPDATE mutations SET state='unknown' WHERE id IN (SELECT note_id FROM managed_operation_sources WHERE operation_id=?) AND state NOT IN ('forgotten','withdrawing')`).run(op.operation_id);
  }
  finalizeWithdrawn() {
    for (const op of this.db.prepare("SELECT * FROM managed_operations WHERE state NOT IN ('conflict','withdrawn')").all()) {
      const plan = JSON.parse(op.plan_json);
      if (![...plan.sources, ...(plan.evidence || [])].some(source => this.host.blocked('note', source.id)) && !(plan.newId && this.host.blocked('note', plan.newId)) && !(plan.crystal && this.host.blocked('note', plan.crystal.id))) continue;
      const receipt = { state: 'withdrawn', withdrawn: true, operationId: op.operation_id, meaning: 'Sources were withdrawn and real cleanup completed; prior mutation history is retained.' };
      this.host.maintenance.audit(op, op.kind, receipt); this.save(op, 'withdrawn', receipt);
    }
  }
  async repair(runtime, { pendingWithdrawal = false } = {}) {
    const results = [];
    for (const op of this.db.prepare("SELECT * FROM managed_operations WHERE state NOT IN ('indexed','conflict','withdrawn') ORDER BY created_at LIMIT 8").all()) {
      const plan = JSON.parse(op.plan_json);
      if (plan.payload.expectedSourceRevision !== undefined && plan.payload.expectedSourceRevision !== this.host.tombstones().revision) { await this.reconcileExpired(runtime, op, plan); continue; }
      results.push(await this.mutate(runtime, plan.payload, op.kind));
    }
    if (!pendingWithdrawal) this.assertReadable(); return results;
  }
}
module.exports = { ManagedNotes, tagsOf };
