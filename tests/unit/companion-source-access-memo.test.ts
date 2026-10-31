import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { nodeCompanionConnection } from '../fixtures/node-companion-connection';
import { CompanionSourceAccess, companionSourceChecksum } from '../../src/companions/source-access';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';

type Row = Record<string, string | number | null>;
const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0).reverse()) cleanup(); });
const scope = { companionId: 'alice', conversationId: 'room_a' };
const readset = (patch: Partial<CompanionExecutionReadset> = {}): CompanionExecutionReadset => ({ schema: 'worldlinebox.companion-execution-readset-v1',
  ...scope, complete: true, memories: [], sources: [], knowledgeReads: [], contexts: [], topics: [], ...patch });
function fixture(file = false, memoryValid?: () => boolean) {
  const root = file ? mkdtempSync(path.join(tmpdir(), 'wlb-source-memo-')) : undefined;
  if (root) close.push(() => rmSync(root, { recursive: true, force: true }));
  const filename = root ? path.join(root, 'sources.sqlite') : ':memory:';
  const { db, connection } = nodeCompanionConnection(filename); close.push(() => db.close());
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const traced: CompanionConnection = { ...connection, prepare(sql) { const statement = connection.prepare(sql); return {
    get(...args) { queries.push({ sql, args }); return statement.get(...args); },
    all(...args) { queries.push({ sql, args }); return statement.all(...args); }, run: (...args) => statement.run(...args),
  }; } };
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE companions(id TEXT PRIMARY KEY,deleted_at TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,kind TEXT);
    CREATE TABLE conversation_members(conversation_id TEXT,companion_id TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,author_id TEXT,conversation_id TEXT,sequence INTEGER,revision INTEGER,status TEXT,kind TEXT,content TEXT,reply_to_id TEXT,action_id TEXT,request_fingerprint TEXT);
    CREATE TABLE actions(id TEXT PRIMARY KEY,status TEXT,data TEXT);
    CREATE TABLE companion_message_topics(message_id TEXT,topic_id TEXT);
    CREATE TABLE companion_topics(id TEXT PRIMARY KEY,conversation_id TEXT,data TEXT);
    CREATE TABLE companion_reset_jobs(id TEXT,companion_id TEXT,status TEXT);
    CREATE TABLE companion_reset_rooms(job_id TEXT,conversation_id TEXT);
    CREATE TABLE companion_reset_messages(message_id TEXT);
    CREATE TABLE companion_reset_boundaries(companion_id TEXT,through_sequence INTEGER);
    INSERT INTO companions VALUES('alice',NULL),('bob',NULL);
    INSERT INTO conversations VALUES('room_a','private'),('room_b','group'),('foreign','private');
    INSERT INTO conversation_members VALUES('room_a','alice'),('room_b','alice'),('room_b','bob'),('foreign','bob');`);
  const sources = new CompanionSourceAccess(traced, () => { throw new Error('This admission does not fetch response bodies.'); }, memoryValid);
  sources.initialize();
  const message = (id = 'source', patch: Partial<Row> = {}): Row => {
    const value: Row = { id, author_id: 'user', conversation_id: 'room_a', sequence: 20, revision: 1, status: 'sent', kind: 'text', content: 'secret current source', reply_to_id: null, action_id: null, request_fingerprint: null, ...patch };
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(value)); return value;
  };
  const metadata = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(key, JSON.stringify(value));
  const action = (id = 'action_one', patch: Record<string, unknown> = {}) => {
    db.prepare('INSERT OR REPLACE INTO actions VALUES(?,?,?)').run(id, 'succeeded', JSON.stringify({ id, companionId: 'alice', conversationId: 'room_a', result: 'actual result', ...patch }));
    metadata('task-checkpoint/' + id, { executionReadset: readset() });
  };
  const count = (fragment: string) => queries.filter(query => query.sql.includes(fragment)).length;
  return { db, filename, sources, message, metadata, action, queries, count };
}

it('shares formal admission only inside one read, including equivalent detached rows', () => {
  const f = fixture(), source = f.message();
  const derivedReads = () => f.queries.filter(query => query.sql === 'SELECT value FROM metadata WHERE key=?' && query.args[0] === 'message-execution-readset/source').length;
  f.sources.withValidation(() => { expect(f.sources.formal(source)).toBe(true); expect(f.sources.formal({ ...source })).toBe(true); expect(derivedReads()).toBe(1); });
  expect(f.sources.formal(source)).toBe(true); expect(derivedReads()).toBe(2);
});

it('shares forgotten ancestry across one owner entrances and cursors while visible keeps each ACL and cursor', () => {
  const f = fixture(), source = f.message(); f.sources.observe('source', 'alice');
  f.sources.withValidation(() => {
    expect(f.sources.forgotten({ ...scope, beforeSequence: 10 }, source)).toBe(false);
    expect(f.sources.forgotten({ ...scope, conversationId: 'room_b', beforeSequence: 100 }, { ...source })).toBe(false);
    expect(f.count('FROM vcp_source_blocks')).toBe(1);
    expect(f.sources.visible({ ...scope, beforeSequence: 100 }, source)).toBe(true);
    expect(f.sources.visible({ ...scope, beforeSequence: 10 }, source)).toBe(false);
    expect(f.sources.visible({ ...scope, conversationId: 'room_b', beforeSequence: 100 }, source)).toBe(true);
    expect(() => f.sources.visible({ ...scope, conversationId: 'foreign' }, source)).toThrow('不是聊天成员');
  });
});

it('never shares another owner withdrawal result and checks visited cycles before a completed false result', () => {
  const f = fixture(), source = f.message(); f.db.prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run('source', 'bob', 'now');
  f.sources.withValidation(() => {
    expect(f.sources.forgotten(scope, source)).toBe(false);
    expect(f.sources.forgotten({ companionId: 'bob', conversationId: 'room_b' }, source)).toBe(true);
    expect(f.count('FROM vcp_source_blocks')).toBe(2);
    expect(f.sources.forgotten(scope, source, new Set(['source']))).toBe(true);
  });
});

it.each([
  [{ sequence: 20 }, { sequence: 5 }],
  [{ author_id: 'user', reply_to_id: 'ancestor' }, { author_id: 'alice', reply_to_id: 'ancestor' }],
  [{ author_id: 'alice' }, { author_id: 'alice', reply_to_id: 'ancestor' }],
  [{ author_id: 'alice' }, { author_id: 'alice', action_id: 'parent_action' }],
  [{ sequence: 5, conversation_id: 'room_b' }, { sequence: 5, conversation_id: 'room_a' }],
])('binds forgotten memo to every consumed ancestry field (%j → %j)', (initial, changed) => {
  const f = fixture(), source = f.message('source', initial); f.message('ancestor');
  f.db.prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run('ancestor', 'alice', 'now');
  f.db.prepare('INSERT INTO vcp_source_prohibitions VALUES(?,?,?,?,?,?)').run('ban', 'alice', 'room_a', 'secret', 10, 0);
  f.action('parent_action', { sourceMessageId: 'ancestor' });
  f.sources.withValidation(() => { expect(f.sources.forgotten(scope, source)).toBe(false); expect(f.sources.forgotten(scope, { ...source, ...changed })).toBe(true); });
});

it.each(['local', 'external'] as const)('invalidates formal and forgotten memo after a %s SQL write in the same read', writer => {
  const f = fixture(writer === 'external'), source = f.message();
  const external = writer === 'external' ? nodeCompanionConnection(f.filename).db : undefined;
  if (external) close.push(() => external.close());
  f.sources.withValidation(() => {
    expect(f.sources.formal(source)).toBe(true); expect(f.sources.forgotten(scope, source)).toBe(false);
    (external ?? f.db).prepare('INSERT INTO metadata VALUES(?,?)').run('execution-source-invalid/message/source', '{}');
    (external ?? f.db).prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run('source', 'alice', 'now');
    expect(f.sources.formal(source)).toBe(false); expect(f.sources.forgotten({ ...scope, conversationId: 'room_b' }, source)).toBe(true);
  });
});

const changedFormalRows: Row[] = [
  { author_id: 'bob' }, { conversation_id: 'room_b' }, { status: 'pending' }, { kind: 'notice' },
  { action_id: 'missing_action' }, { request_fingerprint: '{"loopStep":0}' },
];
it.each(changedFormalRows)('does not reuse a formal reply under a changed row binding %j', changed => {
  const f = fixture(), source = f.message('source', { author_id: 'alice' }); f.metadata('message-execution-readset/source', readset());
  f.sources.withValidation(() => { expect(f.sources.formal(source)).toBe(true); expect(f.sources.formal({ ...source, ...changed })).toBe(false); });
});

it('keeps manual and observation admission tied to the current exact content', () => {
  const f = fixture(), manual = f.message('manual', { kind: 'notice' }), observation = f.message('observation', { author_id: 'system', kind: 'notice' });
  f.metadata('vcp-manual-input/manual', { checksum: companionSourceChecksum(String(manual.content)) });
  f.metadata('memory-world-observation/observation', { checksum: companionSourceChecksum(String(observation.content)) });
  f.sources.withValidation(() => {
    for (const source of [manual, observation]) { expect(f.sources.formal(source)).toBe(true); expect(f.sources.formal({ ...source, content: 'different body' })).toBe(false); }
  });
});

it('rejects an action row whose stored data names a different checkpoint ID after a warm formal admission', () => {
  const f = fixture(), source = f.message('card', { author_id: 'alice', kind: 'action', action_id: 'action_one' }); f.action(); f.action('another_action');
  f.sources.withValidation(() => {
    expect(f.sources.formal(source)).toBe(true);
    f.db.prepare('UPDATE actions SET data=? WHERE id=?').run(JSON.stringify({ id: 'another_action', companionId: 'alice', conversationId: 'room_a', result: 'unrelated result' }), 'action_one');
    expect(f.sources.formal(source)).toBe(false);
  });
});

it.each(['message', 'action'] as const)('rejects active %s self-dependencies before a warm formal memo can answer true', kind => {
  const f = fixture(false, () => nested()), source = f.message('source', { author_id: 'alice', ...(kind === 'action' ? { kind: 'action', action_id: 'action_one' } : {}) });
  if (kind === 'action') f.action();
  const dependency = readset({ memories: [{ id: 'note', version: 1 }] });
  // Directly drive the internal recursive validator to hold its active path;
  // all source/membership/readset checks still run against real SQLite.
  const recursive = f.sources as unknown as { executionValid(kind: 'message' | 'action', id: string, owner: string, room: string, readset: CompanionExecutionReadset): boolean };
  const nested = () => f.sources.formal(source);
  f.sources.withValidation(() => {
    expect(f.sources.formal(source)).toBe(true);
    expect(recursive.executionValid(kind, kind === 'message' ? 'source' : 'action_one', 'alice', 'room_a', dependency)).toBe(false);
  });
});

it('fails closed on an actual cyclic ancestry graph', () => {
  const f = fixture(), first = f.message('first', { author_id: 'alice', reply_to_id: 'second' }); f.message('second', { author_id: 'alice', reply_to_id: 'first' });
  expect(f.sources.forgotten(scope, first)).toBe(true);
  for (const id of ['first', 'second']) {
    f.sources.observe(id, 'alice');
    f.metadata('message-execution-readset/' + id, readset({ sources: [{ id: id === 'first' ? 'second' : 'first', conversationId: 'room_a', checksum: companionSourceChecksum(String(first.content)) }] }));
  }
  expect(f.sources.formal(first)).toBe(false);
});
