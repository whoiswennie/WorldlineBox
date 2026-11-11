'use strict';
// WorldlineBox's durable adapter. Upstream retrieval/scoring files stay intact.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { dispatch } = require('./context.cjs');
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const md5 = text => crypto.createHash('md5').update(text).digest('hex');
const { waitForIndex } = require('./index-wait.cjs');
const { ManagedNotes, tagsOf } = require('./managed-notes.cjs');
class BotHost {
  constructor(home) {
    this.home = home;
    this.db = new Database(path.join(home, 'bot-adapter.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS mutations(id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL,
      note_path TEXT, checksum TEXT, error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_receipts(id TEXT PRIMARY KEY, hash TEXT NOT NULL, episode INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, prepared TEXT, completion TEXT);
      CREATE TABLE IF NOT EXISTS tombstones(kind TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS mutation_sources(note_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(note_id,kind,id));
      CREATE INDEX IF NOT EXISTS mutation_sources_reverse ON mutation_sources(kind,id,note_id);
      CREATE TABLE IF NOT EXISTS withdrawal_episodes(episode INTEGER PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_withdrawal_modes(note_id TEXT PRIMARY KEY,mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(mutations)').all().map(column => column.name);
    for (const column of ['source_event', 'source_root', 'source_messages', 'content']) {
      if (!columns.includes(column)) this.db.exec(`ALTER TABLE mutations ADD COLUMN ${column} TEXT`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS mutations_source_root ON mutations(source_root); CREATE INDEX IF NOT EXISTS mutations_created ON mutations(created_at); CREATE INDEX IF NOT EXISTS mutations_state ON mutations(state);');
    if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='mutation-sources-v1'").get()) this.db.transaction(() => {
      for (const row of this.db.prepare('SELECT * FROM mutations').all()) this.indexSources(row);
      this.db.prepare("INSERT INTO metadata VALUES('mutation-sources-v1',1)").run();
    })();
    this.managed = new ManagedNotes(this);
    const { MaintenanceHost } = require('./maintenance-host.cjs');
    this.maintenance = new MaintenanceHost(this);
    const { MaintenanceWork } = require('./maintenance-work.cjs');
    this.maintenanceWork = new MaintenanceWork(this);
  }
  indexSources(row) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO mutation_sources VALUES(?,?,?)');
    for (const id of [row.source_root, row.source_event].filter(Boolean)) insert.run(row.id, 'event', id);
    for (const id of JSON.parse(row.source_messages || '[]')) insert.run(row.id, 'message', id);
  }
  async remember(runtime, payload) {
    this.managed.assertSourceRevision(payload);
    const { sourceEventId, content } = payload;
    if (typeof sourceEventId !== 'string' || !sourceEventId || typeof content !== 'string' || !content.trim()) throw new TypeError('sourceEventId and content are required');
    const id = digest(sourceEventId), hash = digest(content);
    const root = payload.sourceRootEventId || sourceEventId;
    const sourceMessages = Array.isArray(payload.sourceMessageIds) ? payload.sourceMessageIds : [];
    if (this.blocked('event', root) || this.blocked('note', id) || sourceMessages.some(id => this.blocked('message', id))) return { id, state: 'forgotten', withdrawn: true };
    let row = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(id);
    if (row) {
      if (row.hash !== hash) throw Object.assign(new Error('Memory idempotency key reused with different content'), { code: 'MEMORY_CONFLICT' });
      if (row.source_root && row.source_root !== root) throw Object.assign(new Error('Memory idempotency key reused with a different source'), { code: 'MEMORY_CONFLICT' });
      if (row.state === 'writing') throw Object.assign(new Error('Previous memory write has an unknown outcome; reconcile it before retrying'), { code: 'MEMORY_OUTCOME_UNKNOWN' });
      return this.receipt(row);
    }
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO mutations(id,hash,state,created_at,source_event,source_root,source_messages,content) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, hash, 'writing', new Date().toISOString(), sourceEventId, root, JSON.stringify(sourceMessages), content);
      this.indexSources({ id, source_root: root, source_event: sourceEventId, source_messages: JSON.stringify(sourceMessages) });
    })();
    const notebook = path.join(this.home, 'dailynote', 'Companion');
    await fs.mkdir(notebook, { recursive: true });
    if ((await fs.lstat(notebook)).isSymbolicLink() || path.resolve(await fs.realpath(notebook)).toLowerCase() !== path.resolve(notebook).toLowerCase()) {
      throw Object.assign(new Error('Managed notebook must be an owned physical directory'), { code: 'MEMORY_OUTCOME_UNKNOWN' });
    }
    const parts = new Intl.DateTimeFormat('en', { timeZone: runtime.config.DEFAULT_TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const date = ['year','month','day'].map(type => parts.find(part => part.type === type).value).join('-');
    const result = await runtime.callTool('DailyNote', { command: 'create', maid: 'Companion', folder: 'Companion',
      Date: date, Content: content, Tag: payload.tags || '对话记录', fileName: id });
    if (result.status === 'error' || !result.result?.fileName) {
      this.db.prepare('UPDATE mutations SET state=?,error=? WHERE id=?').run('failed', JSON.stringify(result), id);
      throw Object.assign(new Error(result.error || 'DailyNote did not return a file receipt'), { code: 'MEMORY_WRITE_FAILED' });
    }
    const relative = path.join(result.result.folder, result.result.fileName).replace(/\\/g, '/');
    const text = await fs.readFile(this.notePath(relative), 'utf8');
    this.db.prepare('UPDATE mutations SET state=?,note_path=?,checksum=? WHERE id=?').run('pending', relative, md5(text), id);
    this.db.prepare('UPDATE mutations SET tags_json=?,updated_at=? WHERE id=?').run(JSON.stringify(tagsOf(payload.tags || '对话记录')), new Date().toISOString(), id);
    row = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(id);
    return this.receipt(row);
  }
  notePath(relative) {
    const root = path.join(this.home, 'dailynote'), absolute = path.resolve(root, relative), part = path.relative(root, absolute);
    if (!part || part === '..' || part.startsWith('..' + path.sep) || path.isAbsolute(part)) throw new Error('Memory path escapes this domain');
    return absolute;
  }
  receipt(row) { return { id: row.id, state: row.state, path: row.note_path, checksum: row.checksum, error: row.error || undefined }; }
  async rememberReceipt(payload) {
    const content = String(payload.content || ''), id = digest(String(payload.sourceEventId || ''));
    let row = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(id);
    if (!row) return { found: false };
    if (row.hash !== digest(content) || row.source_event !== payload.sourceEventId
      || row.source_root !== (payload.sourceRootEventId || payload.sourceEventId)) throw Object.assign(new Error('Memory write receipt differs from its original input'), { code: 'MEMORY_CONFLICT' });
    if (row.state === 'writing') {
      const recovered = await this.recoverUnconfirmedNote(row, { allowMissing: true });
      if (!recovered) return { found: true, receipt: { id, state: 'unknown' } };
      row = recovered;
    }
    if (row.state === 'failed') return { found: true, receipt: { ...this.receipt(row), executed: false } };
    if (!['pending', 'indexed', 'archived', 'forgotten'].includes(row.state)) return { found: true, receipt: { id, state: 'unknown' } };
    return { found: true, receipt: { ...this.receipt(row), durable: true, indexed: row.state === 'indexed', ...(row.state === 'forgotten' ? { withdrawn: true } : {}) } };
  }
  async recoverUnconfirmedNote(row, { allowMissing = false, timezone = 'Asia/Shanghai' } = {}) {
    if (row.note_path) return row;
    const unknown = message => Object.assign(new Error(message), { code: 'MEMORY_OUTCOME_UNKNOWN' });
    if (typeof row.content !== 'string' || digest(row.content) !== row.hash) throw unknown('Unconfirmed memory has no valid original content proof');
    const directory = path.join(this.home, 'dailynote', 'Companion');
    let entries;
    try {
      const info = await fs.lstat(directory), resolved = await fs.realpath(directory);
      if (info.isSymbolicLink() || !info.isDirectory() || path.resolve(resolved).toLowerCase() !== path.resolve(directory).toLowerCase()) throw unknown('Unconfirmed diary directory is not an owned physical directory');
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    // Original DailyNote adds a timestamp and the supplied stable suffix. Only
    // this rare interrupted-create recovery scans the one owned notebook.
    const pattern = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-\\d{2}_\\d{2}_\\d{2}-${row.id}(?:\\(\\d+\\))?\\.(?:txt|md)$`);
    const candidates = entries.filter(entry => pattern.test(entry.name));
    if (!candidates.length && allowMissing) return null;
    if (candidates.length !== 1) throw unknown('Unconfirmed DailyNote creation has no unique owned file receipt');
    const candidate = candidates[0];
    if (!candidate.isFile() || candidate.isSymbolicLink()) throw unknown('Unconfirmed DailyNote candidate is not an owned regular file');
    const absolute = path.join(directory, candidate.name), actual = await fs.realpath(absolute);
    if (actual !== absolute && path.resolve(actual).toLowerCase() !== path.resolve(absolute).toLowerCase()) throw unknown('Unconfirmed DailyNote candidate resolves through a link');
    const text = await fs.readFile(absolute, 'utf8');
    const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(row.created_at));
    const date = ['year','month','day'].map(type => parts.find(part => part.type === type).value).join('-');
    const header = `[${date}] - Companion\n`;
    if (!text.startsWith(header) || !candidate.name.startsWith(date + '-')) throw unknown('Unconfirmed DailyNote date/owner proof differs from its source');
    let body = text.slice(header.length);
    if (!/^\s*\[([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?\](?=\s|$)/.test(row.content)) {
      const timestamp = /^\[\d{2}:\d{2}\]\n/.exec(body);
      if (!timestamp) throw unknown('Unconfirmed DailyNote is missing its original time wrapper');
      body = body.slice(timestamp[0].length);
    }
    const withoutTag = value => { const lines = value.split('\n'); if (/^Tag:\s*.+/i.test(lines.at(-1).trim())) lines.pop(); return lines.join('\n').trimEnd(); };
    // Compare source body hashes, not substring hits. Original DailyNote's
    // generated date/time/Tag wrappers are not user facts. Transformations
    // such as file:// uploads that cannot be proved remain explicitly unknown.
    if (digest(withoutTag(body)) !== digest(withoutTag(row.content))) throw unknown('Unconfirmed DailyNote content hash differs from the original source');
    const relative = path.join('Companion', candidate.name).replace(/\\/g, '/');
    this.db.prepare("UPDATE mutations SET note_path=?,checksum=?,state=CASE WHEN state='writing' THEN 'pending' ELSE state END,error=NULL WHERE id=? AND note_path IS NULL")
      .run(relative, md5(text), row.id);
    return this.db.prepare('SELECT * FROM mutations WHERE id=?').get(row.id);
  }
  async sync(runtime, { id, timeoutMs = 30000, signal } = {}) {
    await runtime.start({ vectors: true });
    const rows = id ? this.db.prepare('SELECT * FROM mutations WHERE id=?').all(id)
      : this.db.prepare("SELECT * FROM mutations WHERE state='pending' ORDER BY created_at LIMIT 8").all();
    const receipts = [];
    for (const row of rows) {
      if (['indexed', 'archived'].includes(row.state)) { receipts.push(this.receipt(row)); continue; }
      if (row.state !== 'pending') throw Object.assign(new Error('Memory mutation is not indexable: ' + row.state), { code: 'MEMORY_OUTCOME_UNKNOWN' });
      const absolute = this.notePath(row.note_path);
      const real = await fs.realpath(absolute), root = await fs.realpath(path.join(this.home, 'dailynote'));
      if (!real.startsWith(root + path.sep)) throw new Error('Memory symlink escapes this domain');
      if (md5(await fs.readFile(absolute, 'utf8')) !== row.checksum) throw Object.assign(new Error('Memory changed before its indexing receipt'), { code: 'MEMORY_VERSION_CHANGED' });
      runtime.kb.pendingFiles.add(absolute);
      let indexed;
      await waitForIndex({ timeoutMs, signal, isClosed: () => runtime.closed || runtime.closing,
        message: 'Memory indexing remains pending',
        kick: async () => { await runtime.kb._flushBatch(); await runtime.kb.ingestionPipeline.drain(); },
        ready: async () => {
          const [probe] = await runtime.kb.probeIngestionFiles([row.note_path]);
          if (!probe?.exists || probe.checksum !== row.checksum || !probe.completeVectors || !probe.completeTags) return false;
          indexed = probe; return true;
        } });
      if (md5(await fs.readFile(absolute, 'utf8')) !== row.checksum) throw Object.assign(new Error('Memory changed during indexing'), { code: 'MEMORY_VERSION_CHANGED' });
      this.db.prepare('UPDATE mutations SET state=? WHERE id=? AND checksum=?').run('indexed', row.id, row.checksum);
      receipts.push({ ...this.receipt(row), state: 'indexed', version: indexed.version });
    }
    return { receipts, ...this.status() };
  }
  async appendHistory({ companionId, messages }) {
    if (typeof companionId !== 'string' || !Array.isArray(messages)) throw new TypeError('History owner and messages required');
    const appended = [], groups = new Map(), seen = new Set();
    this.db.transaction(() => {
      let n = this.db.prepare("SELECT value FROM metadata WHERE key='history-count'").get()?.value || 0;
      for (const message of messages) {
        if (typeof message.id !== 'string' || !['user','assistant'].includes(message.role) || typeof message.content !== 'string') throw new TypeError('Original message id/role/content required');
        if (this.blocked('message', message.id)) continue;
        const hash = digest(JSON.stringify([message.role, message.content, message.timestamp, message.senderId]));
        let row = this.db.prepare('SELECT * FROM history_receipts WHERE id=?').get(message.id);
        if (row && row.hash !== hash) throw Object.assign(new Error('History id reused with different content'), { code: 'MEMORY_CONFLICT' });
        if (row?.state === 'done' || seen.has(message.id)) continue;
        if (!row) { row = { episode: Math.floor(n++ / 100) }; this.db.prepare('INSERT INTO history_receipts VALUES(?,?,?,?)').run(message.id, hash, row.episode, 'pending'); }
        const session = 'episode-' + String(row.episode).padStart(8, '0');
        if (!groups.has(session)) groups.set(session, []);
        groups.get(session).push(message); seen.add(message.id);
      }
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('history-count',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(n);
    })();
    for (const [session, group] of groups) {
      // One original atomic append per bounded episode/page, not one complete
      // episode rewrite per message. After a crash, only this episode is read
      // and already appended IDs are confirmed without duplicating raw text.
      const history = await dispatch('session.get', { agent: companionId, session }, { home: this.home });
      const present = new Set(history.map(message => message.id)), missing = group.filter(message => !present.has(message.id));
      if (missing.length) await dispatch('session.append', { agent: companionId, session, messages: missing }, { home: this.home });
      this.db.transaction(() => { for (const message of group) this.db.prepare('UPDATE history_receipts SET state=? WHERE id=?').run('done', message.id); })();
      for (const message of group) appended.push({ messageId: message.id, episode: session });
    }
    return { appended };
  }
  status() {
    return { pending: this.db.prepare("SELECT COUNT(*) AS n FROM mutations WHERE state='pending'").get().n,
      indexed: this.db.prepare("SELECT COUNT(*) AS n FROM mutations WHERE state='indexed'").get().n,
      uncertain: this.db.prepare("SELECT COUNT(*) AS n FROM mutations WHERE state IN ('writing','failed','withdrawing','unknown')").get().n,
      operationsPending: this.db.prepare("SELECT COUNT(*) AS n FROM managed_operations WHERE state NOT IN ('indexed','conflict','withdrawn')").get().n,
      historyMessages: this.db.prepare('SELECT COUNT(*) AS n FROM history_receipts WHERE state=?').get('done').n };
  }
  blocked(kind, id) { return !!this.db.prepare('SELECT 1 FROM tombstones WHERE kind=? AND id=?').get(kind, id); }
  tombstones() {
    const rows = this.db.prepare('SELECT kind,id FROM tombstones').all();
    return { revision: String(this.db.prepare("SELECT value FROM metadata WHERE key='forget-revision'").get()?.value || 0),
      sourceEventIds: rows.filter(row => row.kind === 'event').map(row => row.id), sourceMessageIds: rows.filter(row => row.kind === 'message').map(row => row.id) };
  }
  filterSources({ messageIds = [], sourceEventId }) {
    return { sourceEventWithdrawn: sourceEventId ? this.blocked('event', sourceEventId) : false,
      blockedMessageIds: messageIds.filter(id => this.blocked('message', id)) };
  }
  list() {
    const unresolved = `m.state='unknown' OR EXISTS(SELECT 1 FROM managed_operation_sources s JOIN managed_operations o USING(operation_id) WHERE s.note_id=m.id AND o.state='unknown')`;
    return this.db.prepare(`SELECT m.id,CASE WHEN m.state='withdrawing' OR ${unresolved} THEN '' ELSE m.content END AS content,
      m.source_event,m.source_root,m.source_messages,CASE WHEN ${unresolved} THEN 'unknown' ELSE m.state END AS state,
      m.checksum,m.tags_json,m.created_at,m.updated_at FROM mutations m WHERE m.state<>'forgotten' ORDER BY m.created_at DESC LIMIT 100`)
      .all().map(row => ({ id: row.id, content: row.content || '', sourceEventId: row.source_root || row.source_event,
        sourceMessageIds: JSON.parse(row.source_messages || '[]'), indexState: row.state, checksum: row.checksum,
        tags: row.tags_json ? JSON.parse(row.tags_json) : [], tagsKnown: row.tags_json !== null, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at }));
  }
  readNote(payload) { return this.managed.readNote(payload); }
  update(runtime, payload) { return this.managed.update(runtime, payload); }
  organize(runtime, payload) { return this.managed.organize(runtime, payload); }
  catalog(payload) { return this.managed.catalog(payload); }
  operationReceipt(payload) { return this.managed.operationReceipt(payload); }
  async forget(runtime, { id, companionId }) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Owned memory id is required; paths are not accepted');
    const found = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(id);
    if (!found) throw new Error('Memory does not exist in this security domain');
    const root = found.source_root || found.source_event;
    const rows = root ? this.db.prepare('SELECT * FROM mutations WHERE source_root=? OR id=?').all(root, id) : [found];
    const result = await this.withdrawSources(runtime, { companionId, noteIds: rows.map(row => row.id),
      sourceEventIds: root ? [root] : [], sourceMessageIds: [...new Set(rows.flatMap(row => JSON.parse(row.source_messages || '[]')))] });
    return { ...result, forgotten: true, id, physicalSourceErasure: false,
      meaning: '已撤回本域日记、索引及受管回查投影；原始DSH日志由宿主屏蔽，未宣称物理擦除。' };
  }
  stageWithdrawal({ sourceEventIds = [], sourceMessageIds = [], noteIds = [], mode }) {
    if (mode !== undefined && mode !== 'isolated-task-notices') throw new TypeError('Unknown trusted source withdrawal mode');
    const exactSources = mode === 'isolated-task-notices';
    for (const values of [sourceEventIds, sourceMessageIds, noteIds]) {
      if (!Array.isArray(values) || values.length > (values === noteIds ? 100000 : 2000) || values.some(id => typeof id !== 'string' || !id || id.length > 512 || id.includes('\0'))) throw new TypeError('Trusted source withdrawal IDs required');
    }
    const pending = [...sourceEventIds.map(id => ['event', id]), ...sourceMessageIds.map(id => ['message', id]), ...noteIds.map(id => ['note', id])];
    const seen = new Set();
    this.db.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?,?)');
      const now = new Date().toISOString();
      let changed = 0, needsCleanup = false;
      for (let index = 0; index < pending.length; index++) {
        const [kind, id] = pending[index], key = kind + ':' + id;
        if (seen.has(key)) continue; seen.add(key);
        const added = insert.run(kind, id, now).changes; changed += added;
        if (kind === 'message') {
          const receipt = this.db.prepare('SELECT episode FROM history_receipts WHERE id=?').get(id);
          if (receipt && (added || this.withdrawalPending() || noteIds.length)) { this.db.prepare("INSERT INTO withdrawal_episodes VALUES(?,'pending') ON CONFLICT(episode) DO UPDATE SET state='pending'").run(receipt.episode); needsCleanup = true; }
        }
        if (kind === 'note') {
          pending.push(...this.db.prepare('SELECT child_id FROM note_dependencies WHERE parent_id=?').all(id).map(row => ['note', row.child_id]));
          const row = this.db.prepare('SELECT * FROM mutations WHERE id=?').get(id);
          if (!row) continue;
          this.db.prepare(`INSERT INTO source_withdrawal_modes(note_id,mode) VALUES(?,?) ON CONFLICT(note_id) DO UPDATE SET mode=
            CASE WHEN source_withdrawal_modes.mode='recursive' OR excluded.mode='recursive' THEN 'recursive' ELSE excluded.mode END`)
            .run(id, exactSources ? 'isolated-task-notices' : 'recursive');
          if (row.state !== 'forgotten') { this.db.prepare("UPDATE mutations SET state='withdrawing' WHERE id=?").run(id); needsCleanup = true; }
          // A legacy private-notice correction removes the contaminated note
          // and its derived notes, not every independent public fact that was
          // cited beside it. Ordinary forget/source withdrawal retains its
          // complete source closure and existing privacy semantics.
          if (!exactSources) {
            pending.push(...[row.source_root, row.source_event].filter(Boolean).map(id => ['event', id]), ...JSON.parse(row.source_messages || '[]').map(id => ['message', id]));
            pending.push(...this.db.prepare('SELECT kind,id FROM mutation_sources WHERE note_id=?').all(id).map(source => [source.kind, source.id]));
          }
        } else {
          for (const row of this.db.prepare('SELECT note_id FROM mutation_sources WHERE kind=? AND id=?').all(kind, id)) pending.push(['note', row.note_id]);
        }
      }
      if (changed) this.db.prepare("INSERT INTO metadata(key,value) VALUES('forget-revision',1) ON CONFLICT(key) DO UPDATE SET value=value+1").run();
      if (changed || needsCleanup) this.db.prepare("INSERT INTO metadata VALUES('withdrawal-pending',1) ON CONFLICT(key) DO UPDATE SET value=1").run();
    })();
    return {
      sourceEventIds: [...new Set(pending.filter(([kind]) => kind === 'event').map(([, id]) => id))],
      sourceMessageIds: [...new Set(pending.filter(([kind]) => kind === 'message').map(([, id]) => id))] };
  }
  async withdrawSources(runtime, payload) {
    const sources = this.stageWithdrawal(payload);
    const result = await this.cleanupWithdrawals(runtime, payload.companionId);
    this.managed.finalizeWithdrawn(); this.maintenance.finalizeWithdrawn();
    return { ...result, ...sources, withdrawn: true, revision: this.tombstones().revision };
  }
  withdrawalPending() { return !!this.db.prepare("SELECT value FROM metadata WHERE key='withdrawal-pending'").get()?.value; }
  assertWithdrawalsSettled() {
    if (this.withdrawalPending() || this.db.prepare("SELECT 1 FROM mutations WHERE state='withdrawing' LIMIT 1").get()) {
      throw Object.assign(new Error('Source withdrawal remains pending; memory queries are blocked until repair completes'), { code: 'MEMORY_SOURCE_WITHDRAWAL_PENDING' });
    }
  }
  completeWithdrawal() {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO metadata VALUES('withdrawal-pending',0) ON CONFLICT(key) DO UPDATE SET value=0").run();
      this.db.prepare('DELETE FROM withdrawal_episodes').run();
    })();
  }
  async cleanupWithdrawals(runtime, companionId) {
    const rows = this.db.prepare("SELECT * FROM mutations WHERE state='withdrawing'").all();
    if (!this.withdrawalPending() && !rows.length) return { changedEpisodes: [], relatedIds: [], withdrawalPending: false };
    await runtime.start({ vectors: true });
    for (let row of rows) {
      if (!row.note_path) row = await this.recoverUnconfirmedNote(row, { timezone: runtime.config.DEFAULT_TIMEZONE || 'Asia/Shanghai' });
      const absolute = this.notePath(row.note_path);
      try {
        const real = await fs.realpath(absolute), rootPath = await fs.realpath(path.join(this.home, 'dailynote'));
        if (!real.startsWith(rootPath + path.sep)) throw new Error('Memory deletion path escapes its security domain');
        if (!row.checksum || md5(await fs.readFile(absolute, 'utf8')) !== row.checksum) throw Object.assign(new Error('Memory deletion content version is unconfirmed'), { code: 'MEMORY_OUTCOME_UNKNOWN' });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await runtime.kb.runExternalFileMutation('WorldlineBoxForget', async () => {
        await fs.rm(absolute, { force: true });
        return { status: 'success', mutationPaths: { deletes: [absolute], upserts: [] } };
      }, { waitForIndex: true, timeoutMs: 30000 });
      const [probe] = await runtime.kb.probeIngestionFiles([row.note_path]);
      if (!probe || probe.path !== row.note_path || probe.exists !== false) throw new Error('Memory deletion has not received its native storage receipt');
      // Persist each acknowledged deletion, so a bounded worker timeout can
      // resume the remaining notes rather than redoing an entire large batch.
      this.db.prepare("UPDATE mutations SET state='forgotten',content=NULL WHERE id=?").run(row.id);
    }
    const changedEpisodes = [];
    for (const { episode, state } of this.db.prepare('SELECT * FROM withdrawal_episodes').all()) {
      const session = 'episode-' + String(episode).padStart(8, '0');
      if (state === 'pending') {
        const history = await dispatch('session.get', { agent: companionId, session }, { home: this.home });
        await dispatch('session.put', { agent: companionId, session, history: history.filter(message => !this.blocked('message', message.id)) }, { home: this.home });
        this.db.prepare("UPDATE withdrawal_episodes SET state='done' WHERE episode=?").run(episode);
      }
      changedEpisodes.push(session);
    }
    // OneRing is a derived recording/projection. Reset its per-domain caches,
    // then only legally filtered source messages may populate it again.
    const oneRingDb = runtime._require('Plugin/OneRing/OneRingDB.js').getDb(companionId, runtime.runtimeDir);
    for (const table of ['messages','postTurns','oneRingPostSnapshots']) {
      if (oneRingDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) oneRingDb.exec(`DELETE FROM ${table}`);
    }
    this.db.prepare('UPDATE requests SET prepared=NULL,completion=?').run(JSON.stringify({ recorded: false, withdrawn: true }));
    for (const name of runtime.rag?.cacheManager?.caches?.keys() || []) runtime.rag.cacheManager.clear(name);
    this.db.transaction(() => { for (const row of rows) this.db.prepare('UPDATE mutations SET state=?,content=NULL WHERE id=?').run('forgotten', row.id); })();
    return { relatedIds: rows.map(row => row.id), changedEpisodes, withdrawalPending: true };
  }
  async repairWithdrawals(runtime, companionId) {
    const pendingWithdrawal = this.withdrawalPending();
    await this.maintenance.reconcileExpired(runtime);
    await this.managed.repair(runtime, { pendingWithdrawal });
    for (const row of this.db.prepare("SELECT * FROM mutations WHERE state='writing' AND note_path IS NULL").all()) {
      const recovered = await this.recoverUnconfirmedNote(row, { allowMissing: true, timezone: runtime.config.DEFAULT_TIMEZONE || 'Asia/Shanghai' });
      if (recovered) await this.sync(runtime, { id: recovered.id });
    }
    const rows = this.db.prepare(`SELECT m.id,COALESCE(w.mode,'recursive') AS mode FROM mutations m
      LEFT JOIN source_withdrawal_modes w ON w.note_id=m.id WHERE m.state='withdrawing'`).all();
    // A crash after staging must retain the exact-source correction policy.
    // Replaying all pending note IDs as ordinary forget would recursively
    // tombstone the unrelated public messages this migration must preserve.
    const batches = rows.length ? ['isolated-task-notices', 'recursive'].map(mode => ({ mode,
      noteIds: rows.filter(row => row.mode === mode).map(row => row.id) })).filter(batch => batch.noteIds.length) : [{ mode: 'recursive', noteIds: [] }];
    const receipts = [];
    for (const batch of batches) receipts.push(await this.withdrawSources(runtime, { companionId, noteIds: batch.noteIds,
      ...(batch.mode === 'isolated-task-notices' ? { mode: batch.mode } : {}) }));
    const result = { ...receipts.at(-1),
      changedEpisodes: [...new Set(receipts.flatMap(receipt => receipt.changedEpisodes || []))],
      relatedIds: [...new Set(receipts.flatMap(receipt => receipt.relatedIds || []))],
      sourceEventIds: [...new Set(receipts.flatMap(receipt => receipt.sourceEventIds || []))],
      sourceMessageIds: [...new Set(receipts.flatMap(receipt => receipt.sourceMessageIds || []))],
      withdrawalPending: receipts.some(receipt => receipt.withdrawalPending) };
    // Only the real cleanup/projection receipts authorize releasing old-plan
    // recall fences. Epoch expiry alone never means a write did not occur.
    this.managed.finalizeWithdrawn(); this.maintenance.finalizeWithdrawn();
    return { ...this.status(), ...result };
  }
  getPrepared(id) { return this.db.prepare('SELECT prepared,completion FROM requests WHERE id=?').get(id) || null; }
  savePrepared(id, prepared) {
    this.db.prepare('INSERT INTO requests(id,prepared) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id, JSON.stringify(prepared));
    return this.getPrepared(id);
  }
  completePrepared(id, completion) {
    this.db.prepare('INSERT INTO requests(id,completion) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET prepared=NULL,completion=excluded.completion')
      .run(id, JSON.stringify(completion));
    return completion;
  }
  close() { this.db.close(); }
}
module.exports = { BotHost };
