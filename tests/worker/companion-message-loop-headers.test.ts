import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionSourceAccess } from '../../src/companions/source-access';
import { initializeCompanionMessageLoopHeaders, readCompanionMessageLoopHeader, readCompanionTaskMessageLoopHeader } from '../../src/companions/message-loop-headers';
import { fencedCompanionConnection } from '../../src/companions/recovery-fence';

const roots: string[] = [], connections: CompanionConnection[] = [], stores: CompanionsStore[] = [];
const table = 'companion_message_loop_headers';
const key = 'message-loop/reply';
const done = JSON.stringify({ status: 'done', sourceMessageId: 'anchor', context: { user: 'large context '.repeat(15000) } });
afterEach(() => {
  vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('loop-headers-')) throw Error('Unexpected fixture root.');
    rmSync(root, { recursive: true, force: true });
  }
});
function connect(filename: string, readonly = false) {
  const db = new (BetterSqlite3 as { new(filename: string, options?: { readonly: boolean }): CompanionConnection })(filename, { readonly });
  connections.push(db); return db;
}
function fixture(initialize = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'loop-headers-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), db = connect(filename);
  db.pragma('journal_mode=WAL'); db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.prepare('INSERT INTO metadata VALUES(?,?)').run(key, done);
  if (initialize) initializeCompanionMessageLoopHeaders(db);
  const reader = connect(filename);
  const header = (requested = key) => readCompanionMessageLoopHeader(reader, requested);
  return { db, reader, filename, header };
}
function changes(db: CompanionConnection) { return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n; }
function source(id = 'reply') { return { id, author_id: 'alice', conversation_id: 'room', kind: 'text', status: 'sent', content: '真实答复。' }; }

it('backfills once at explicit initialization without changing any checkpoint bytes or rewriting stable headers', () => {
  const f = fixture(false);
  f.db.prepare('INSERT INTO metadata VALUES(?,?)').run('message-loop/strings', '{"status":"01","sourceMessageId":"001"}');
  f.db.prepare('INSERT INTO metadata VALUES(?,?)').run('message-loop/legacy-invalid', 'damaged JSON');
  initializeCompanionMessageLoopHeaders(f.db);
  expect(f.header()).toEqual({ status: 'done', sourceMessageId: 'anchor' });
  expect(f.header('message-loop/strings')).toEqual({ status: '01', sourceMessageId: '001' });
  expect(f.header('message-loop/legacy-invalid')).toBeUndefined();
  expect(f.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)).toEqual({ value: done });
  const before = changes(f.db); initializeCompanionMessageLoopHeaders(f.db); expect(changes(f.db)).toBe(before);
  f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ status: 'done', sourceMessageId: 'anchor', progress: { detail: '新增进度' } }), key);
  expect(changes(f.db) - before).toBe(1); expect(f.header()).toEqual({ status: 'done', sourceMessageId: 'anchor' });
});

it('migrates an existing v1 header and its guards atomically, while read-only legacy task reads keep the old path', () => {
  const f = fixture(false), original = JSON.stringify({ status: 'done', sourceMessageId: 'anchor', draft: { text: '尚未正式发布。' } });
  f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(original, key);
  f.db.exec(`CREATE TABLE ${table}(metadata_key TEXT PRIMARY KEY NOT NULL,json_valid INTEGER NOT NULL,root_type TEXT,
    status_type TEXT,source_type TEXT,status_value,source_message_id);
    CREATE TRIGGER companion_message_loop_headers_verify_update BEFORE UPDATE ON ${table}
      WHEN NEW.status_value IS NOT 'done' BEGIN SELECT RAISE(ABORT,'old v1 guard'); END;`);
  f.db.prepare(`INSERT INTO ${table} VALUES(?,1,'object','text','text','done','anchor')`).run(key);
  const legacy = connect(f.filename, true); legacy.pragma('query_only=ON');
  expect(readCompanionMessageLoopHeader(legacy, key)).toEqual({ status: 'done', sourceMessageId: 'anchor' });
  expect(readCompanionTaskMessageLoopHeader(legacy, key)).toBeUndefined();
  expect(legacy.prepare(`PRAGMA table_info(${table})`).all()).toHaveLength(7);
  initializeCompanionMessageLoopHeaders(f.db);
  expect(readCompanionTaskMessageLoopHeader(legacy, key)).toEqual({ status: 'done', sourceMessageId: 'anchor', draftType: 'object' });
  expect(f.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)).toEqual({ value: original });
  expect(() => f.reader.prepare(`UPDATE ${table} SET draft_type=NULL WHERE metadata_key=?`).run(key)).toThrow('does not match');
  const before = changes(f.db); initializeCompanionMessageLoopHeaders(f.db); expect(changes(f.db)).toBe(before);
});

it('tracks exact current draft types from another connection without rewriting headers for unrelated progress fields', () => {
  const f = fixture();
  const drafts = [[undefined, null], [null, 'null'], [false, 'false'], [0, 'integer'], [1.5, 'real'], ['', 'text'], [{ text: 'draft' }, 'object'], [[], 'array']] as const;
  let previousType: string | null = null;
  for (const [draft, type] of drafts) {
    const before = changes(f.reader);
    f.reader.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ status: 'done', sourceMessageId: 'anchor', ...(draft === undefined ? {} : { draft }) }), key);
    expect(changes(f.reader) - before).toBe(previousType === type ? 1 : 2); previousType = type;
    expect(readCompanionTaskMessageLoopHeader(f.db, key)).toEqual({ status: 'done', sourceMessageId: 'anchor', draftType: type });
  }
  const before = changes(f.reader);
  f.reader.prepare("UPDATE metadata SET value=json_set(value,'$.progress',json(?)) WHERE key=?").run('{"revision":12,"phase":"memory"}', key);
  expect(changes(f.reader) - before).toBe(2);
  expect(f.reader.prepare(`SELECT progress_phase_type,progress_phase FROM ${table} WHERE metadata_key=?`).get(key))
    .toEqual({ progress_phase_type: 'text', progress_phase: 'memory' });
  const unchangedPhase = changes(f.reader);
  f.reader.prepare("UPDATE metadata SET value=json_set(value,'$.progress.revision',13,'$.progress.detail','another milestone') WHERE key=?").run(key);
  expect(changes(f.reader) - unchangedPhase).toBe(1);
  expect(() => f.db.prepare(`UPDATE ${table} SET draft_type=NULL WHERE metadata_key=?`).run(key)).toThrow('does not match');
  f.reader.prepare('UPDATE metadata SET key=? WHERE key=?').run('message-loop/renamed-draft', key);
  expect(readCompanionTaskMessageLoopHeader(f.db, key)).toBeUndefined();
  expect(readCompanionTaskMessageLoopHeader(f.db, 'message-loop/renamed-draft')?.draftType).toBe('array');
  f.reader.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('message-loop/renamed-draft', done);
  expect(readCompanionTaskMessageLoopHeader(f.db, 'message-loop/renamed-draft')?.draftType).toBeNull();
  f.reader.prepare('DELETE FROM metadata WHERE key=?').run('message-loop/renamed-draft');
  expect(readCompanionTaskMessageLoopHeader(f.db, 'message-loop/renamed-draft')).toBeUndefined();
});

it('upgrades old draft headers once with compact progress scalars while preserving source bytes and absent-phase semantics', () => {
  const f = fixture(false), original = JSON.stringify({ status: 'done', sourceMessageId: 'anchor', progress: { phase: 'streaming', revision: 2 }, context: { user: 'large '.repeat(12000) } });
  f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(original, key);
  f.db.exec(`CREATE TABLE ${table}(metadata_key TEXT PRIMARY KEY NOT NULL,json_valid INTEGER NOT NULL,root_type TEXT,
    status_type TEXT,source_type TEXT,status_value,source_message_id,draft_type TEXT);`);
  f.db.prepare(`INSERT INTO ${table} VALUES(?,1,'object','text','text','done','anchor',NULL)`).run(key);
  initializeCompanionMessageLoopHeaders(f.db);
  expect(f.db.prepare(`SELECT progress_phase_type,progress_phase FROM ${table} WHERE metadata_key=?`).get(key))
    .toEqual({ progress_phase_type: 'text', progress_phase: 'streaming' });
  expect(f.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)).toEqual({ value: original });
  expect(f.header()).toEqual({ status: 'done', sourceMessageId: 'anchor' });
  const before = changes(f.db); initializeCompanionMessageLoopHeaders(f.db); expect(changes(f.db)).toBe(before);
  expect(() => f.reader.prepare(`UPDATE ${table} SET progress_phase='completed' WHERE metadata_key=?`).run(key)).toThrow('does not match');
  f.reader.prepare('INSERT INTO metadata VALUES(?,?)').run('message-loop/no-progress', '{"status":"done","sourceMessageId":"other"}');
  expect(f.db.prepare(`SELECT progress_phase_type,progress_phase FROM ${table} WHERE metadata_key=?`).get('message-loop/no-progress'))
    .toEqual({ progress_phase_type: null, progress_phase: null });
});

it('keeps current phase types exact across external updates, rename, replace, delete and rollback', () => {
  const f = fixture();
  for (const [phase, type] of [[null, 'null'], [false, 'false'], [2, 'integer'], ['completed', 'text'], [{ nested: 'value' }, 'object']] as const) {
    f.reader.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ status: 'done', sourceMessageId: 'anchor', progress: { phase } }), key);
    const header = f.db.prepare(`SELECT progress_phase_type,progress_phase FROM ${table} WHERE metadata_key=?`).get(key) as { progress_phase_type: string; progress_phase: unknown };
    expect(header.progress_phase_type).toBe(type);
    expect(header.progress_phase).toEqual(typeof phase === 'object' && phase !== null ? JSON.stringify(phase) : phase === false ? 0 : phase);
  }
  const before = f.db.prepare(`SELECT * FROM ${table} WHERE metadata_key=?`).get(key);
  expect(() => f.reader.transaction(() => {
    f.reader.prepare("UPDATE metadata SET value=json_set(value,'$.progress.phase','cancelled') WHERE key=?").run(key);
    throw new Error('rollback phase');
  })()).toThrow('rollback phase');
  expect(f.db.prepare(`SELECT * FROM ${table} WHERE metadata_key=?`).get(key)).toEqual(before);
  f.reader.prepare('UPDATE metadata SET key=? WHERE key=?').run('message-loop/moved-phase', key);
  expect(f.db.prepare(`SELECT 1 FROM ${table} WHERE metadata_key=?`).get(key)).toBeUndefined();
  f.reader.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('message-loop/moved-phase', '{"status":"done","progress":{"phase":"interrupted"}}');
  expect(f.db.prepare(`SELECT progress_phase FROM ${table} WHERE metadata_key=?`).get('message-loop/moved-phase')).toEqual({ progress_phase: 'interrupted' });
  f.reader.prepare('DELETE FROM metadata WHERE key=?').run('message-loop/moved-phase');
  expect(f.db.prepare(`SELECT 1 FROM ${table} WHERE metadata_key=?`).get('message-loop/moved-phase')).toBeUndefined();
});

it('never exposes a rolled-back or corrupt draft projection', () => {
  const f = fixture();
  expect(() => f.db.transaction(() => {
    f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('{"status":"done","sourceMessageId":"anchor","draft":{}}', key);
    expect(readCompanionTaskMessageLoopHeader(f.db, key)?.draftType).toBe('object');
    expect(readCompanionTaskMessageLoopHeader(f.reader, key)?.draftType).toBeNull();
    throw new Error('rollback draft edit');
  })()).toThrow('rollback draft edit');
  expect(readCompanionTaskMessageLoopHeader(f.reader, key)?.draftType).toBeNull();
  f.reader.prepare('UPDATE metadata SET value=? WHERE key=?').run('corrupt JSON', key);
  expect(readCompanionTaskMessageLoopHeader(f.db, key)).toBeUndefined();
});

it('tracks external value edits, replacement, key renames, prefix transitions and deletion atomically', () => {
  const f = fixture();
  expect(f.header()).toEqual({ status: 'done', sourceMessageId: 'anchor' });
  f.reader.prepare('UPDATE metadata SET value=? WHERE key=?').run('{"status":"thinking","sourceMessageId":"new_anchor"}', key);
  expect(readCompanionMessageLoopHeader(f.db, key)).toEqual({ status: 'thinking', sourceMessageId: 'new_anchor' });
  f.db.prepare('UPDATE metadata SET key=? WHERE key=?').run('message-loop/renamed', key);
  expect(f.header()).toBeUndefined(); expect(f.header('message-loop/renamed')?.status).toBe('thinking');
  f.db.prepare('UPDATE metadata SET key=? WHERE key=?').run('outside/prefix', 'message-loop/renamed');
  expect(f.header('message-loop/renamed')).toBeUndefined();
  f.db.prepare('UPDATE metadata SET key=? WHERE key=?').run(key, 'outside/prefix');
  expect(f.header()?.sourceMessageId).toBe('new_anchor');
  f.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(key, done);
  expect(f.header()).toEqual({ status: 'done', sourceMessageId: 'anchor' });
  f.db.prepare('DELETE FROM metadata WHERE key=?').run(key); expect(f.header()).toBeUndefined();
  expect(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
});

it('does not expose rolled-back header changes on either connection', () => {
  const f = fixture();
  expect(() => f.db.transaction(() => {
    f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('{"status":"thinking","sourceMessageId":"different"}', key);
    expect(readCompanionMessageLoopHeader(f.db, key)?.status).toBe('thinking');
    expect(f.header()?.status).toBe('done'); throw new Error('controlled rollback');
  })()).toThrow('controlled rollback');
  expect(readCompanionMessageLoopHeader(f.db, key)).toEqual({ status: 'done', sourceMessageId: 'anchor' });
  expect(f.header()).toEqual({ status: 'done', sourceMessageId: 'anchor' });
});

it('uses the same persisted header through a fenced connection identity without a raw-connection readiness cache', () => {
  const f = fixture(), fenced = fencedCompanionConnection(f.db, operation => operation());
  expect(readCompanionMessageLoopHeader(fenced, key)).toEqual({ status: 'done', sourceMessageId: 'anchor' });
  f.reader.prepare('UPDATE metadata SET value=? WHERE key=?').run('{"status":"thinking","sourceMessageId":"external"}', key);
  expect(readCompanionMessageLoopHeader(fenced, key)).toEqual({ status: 'thinking', sourceMessageId: 'external' });
});

it('rejects direct forged projection writes and uses the original reader after projection deletion', () => {
  const f = fixture(); f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('{"status":"thinking","sourceMessageId":"anchor"}', key);
  expect(() => f.reader.prepare(`UPDATE ${table} SET status_value='done' WHERE metadata_key=?`).run(key)).toThrow('does not match');
  expect(() => f.reader.prepare(`INSERT INTO ${table}(metadata_key,json_valid,root_type,status_type,source_type,status_value,source_message_id)
    VALUES('message-loop/nonexistent',1,'object','text','text','done','anchor')`).run()).toThrow('does not match');
  expect(() => f.reader.prepare(`UPDATE ${table} SET status_type=NULL,status_value=NULL WHERE metadata_key=?`).run(key)).toThrow('does not match');
  f.reader.prepare(`DELETE FROM ${table} WHERE metadata_key=?`).run(key);
  expect(f.header()).toBeUndefined();
  const access = new CompanionSourceAccess(f.reader, () => { throw Error('No message projection is needed.'); });
  expect(access.formal(source())).toBe(false);
});

it.each(['null', '[]', '"root string"', '{"status":null}', '{"status":42}', '{"status":true}',
  '{"status":"done","sourceMessageId":7}', '{"status":"done","sourceMessageId":9223372036854775807}',
  '{"status":"done","sourceMessageId":[]}', '{"status":{},"sourceMessageId":"anchor"}', 'damaged JSON'])(
  'preserves the original scalar/type/error semantics for unsupported JSON: %s', value => {
  const f = fixture(); f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(value, key);
  expect(f.header()).toBeUndefined();
  const access = new CompanionSourceAccess(f.reader, () => { throw Error('No DTO is needed.'); });
  if (value === 'damaged JSON') expect(() => access.formal(source())).toThrow('malformed JSON');
  else {
    const original = f.reader.prepare("SELECT json_extract(value,'$.status') AS status FROM metadata WHERE key=?").get(key) as { status: unknown };
    expect(access.formal(source())).toBe(original.status === 'done');
  }
});

it('keeps uninitialized read-only legacy access pure and preserves the absent-loop fingerprint rule', () => {
  const f = fixture(false), reader = connect(f.filename, true); reader.pragma('query_only=ON');
  const access = new CompanionSourceAccess(reader, () => { throw Error('No DTO is needed.'); });
  expect(readCompanionMessageLoopHeader(reader, key)).toBeUndefined(); expect(access.formal(source())).toBe(true);
  expect(access.formal({ ...source('missing'), request_fingerprint: '{"loopStep":0}' })).toBe(false);
  expect(access.formal(source('missing'))).toBe(true);
  expect(reader.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeUndefined();
});

it('removes both large-JSON authorization reads while preserving fresh formal status, forgotten ancestry and cycle refusal', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'loop-headers-')); roots.push(root);
  const filename = path.join(root, 'state.sqlite'), store = new CompanionsStore(filename, [{ id: 'alice', name: 'alice', description: '',
    persona: '核对真实来源。', avatar: 'sister', model: '', active: true, proactive: false }]); stores.push(store);
  const db = connect(filename), scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const anchor = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '真实起点。', replyDirective: 'none' });
  const reply = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '根据真实起点作答。' });
  const update = (status: string, parent: string) => db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)')
    .run('message-loop/' + reply.id, JSON.stringify({ status, sourceMessageId: parent, context: { user: 'stored context '.repeat(15000) } }));
  update('done', anchor.id);
  const row = db.prepare('SELECT * FROM messages WHERE id=?').get(reply.id) as Record<string, string | number | null>;
  const statementPrototype = Object.getPrototypeOf(db.prepare('SELECT 1')), get = statementPrototype.get, jsonReads: string[] = [];
  vi.spyOn(statementPrototype, 'get').mockImplementation(function(this: object, ...args: unknown[]) {
    const sql = Reflect.get(this, 'source');
    if (sql === "SELECT json_extract(value,'$.status') AS status FROM metadata WHERE key=?"
      || sql === "SELECT json_extract(value,'$.sourceMessageId') AS source_message_id FROM metadata WHERE key=?") jsonReads.push(sql);
    return Reflect.apply(get, this, args);
  });
  const access = new CompanionSourceAccess(db, id => store.getMessage(id));
  // This calls the actual Store-owned SourceAccess initialized by the Store,
  // not just an external reader that was manually given the projection.
  expect(store.request({ type: 'memory.sources.headers', ...scope, ids: [reply.id] }).memorySourceHeaders?.headers[0]?.id).toBe(reply.id);
  expect(access.formal(row)).toBe(true); expect(access.forgotten(scope, row)).toBe(false); expect(jsonReads).toHaveLength(0);
  update('thinking', anchor.id); expect(access.formal(row)).toBe(false);
  update('done', reply.id); expect(access.forgotten(scope, row)).toBe(true);
  update('done', anchor.id); store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [anchor.id] });
  expect(access.forgotten(scope, row)).toBe(true);
});
