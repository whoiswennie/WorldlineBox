import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionSourceAccess } from '../../src/companions/source-access';
import { CompanionExecutionSourceStore } from '../../src/companions/execution-source-store';
import type { CompanionMemoryStore } from '../../src/companions/memory-store';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { executionMessageReadsetKey } from '../../src/companions/execution-source-access';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';

const fixtures: Array<{ root: string; db: CompanionConnection; store: CompanionsStore }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); f.store.close(); removeOwnedDirectorySync(f.root); } });
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
type SqlitePrototype = { prepare(sql: string): ReturnType<CompanionConnection['prepare']> };
function fixture(count: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-source-dag-')), file = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(file, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '核对实际来源。', model: '', avatar: 'sister' as const, active: true, proactive: false })));
  const db = new (Database as { new(file: string): CompanionConnection })(file); fixtures.push({ root, db, store });
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const base = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: 'BASE_SOURCE_VALID_427', replyDirective: 'none' });
  const nodes = [base];
  const bind = (message: CompanionMessage, parents: CompanionMessage[]) => {
    const proof = captureCompanionExecutionReadset(alice, { sources: parents.map(source => ({ id: source.id, conversationId: source.conversationId, checksum: hash(source.content) })) });
    db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(executionMessageReadsetKey(message.id), JSON.stringify(proof));
  };
  for (let index = 0; index < count; index++) {
    const message = store.appendMessage({ conversationId: alice.conversationId, authorId: 'alice', content: 'DERIVED_NODE_' + index, replyDirective: 'none' });
    // Each node has the previous two parents: the number of distinct nodes is
    // linear, while revalidating every expanded path grows as Fibonacci.
    bind(message, nodes.slice(-2)); nodes.push(message);
  }
  let queries = 0, onRead: ((id: string) => void) | undefined;
  const counted = { prepare: (sql: string) => { queries++; return db.prepare(sql); } } as unknown as CompanionConnection;
  const access = new CompanionSourceAccess(counted, id => { const value = store.getMessage(id); onRead?.(id); return value; });
  return { root, store, db, alice, bob, base, nodes, bind, access, getQueries: () => queries, resetQueries: () => { queries = 0; },
    onRead: (callback: (id: string) => void) => { onRead = callback; } };
}

it('projects and shares exact action readsets without parsing a large unrelated checkpoint log', () => {
  const f = fixture(0), readset = captureCompanionExecutionReadset(f.alice, { context: { user: JSON.stringify({ messages: [f.base] }) } });
  const action = f.store.request({ type: 'action.create', action: { ...f.alice, sourceMessageId: f.base.id, title: '只核对执行读集', status: 'queued' },
    checkpoint: { prompt: '真实任务输入', executionReadset: readset } }).action!;
  f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '真实动作结果' } });
  const source = f.store.request({ type: 'messages', conversationId: f.alice.conversationId }).messages!.find(message => message.actionId === action.id)!;
  const children = Array.from({ length: 4 }, (_, index) => f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice',
    content: `已读结果的派生回复 ${index}`, replyDirective: 'none',
    executionReadset: captureCompanionExecutionReadset(f.alice, { context: { user: JSON.stringify({ messages: [source] }) } }) }));
  const ids = [source, ...children].map(message => message.id);
  const expected = f.store.request({ type: 'execution.sources', sourceMessageIds: ids }).executionSources!;
  // A valid checkpoint can carry 100 large, unrelated execution supplements.
  // Its source proof must remain byte-for-byte identical and stay a small read.
  f.store.request({ type: 'checkpoint.save', id: action.id, checkpoint: { prompt: '真实任务输入', executionReadset: readset, waitForActionIds: [],
    supplements: Array.from({ length: 100 }, (_, index) => ({ id: 'packet_' + index, mode: 'queue' as const, content: 'UNRELATED_DSH_TRACE_'.repeat(800).slice(0, 15000) })) } });
  let projectedQueries = 0;
  const counted = { prepare: (sql: string) => {
    if (sql.includes("json_extract(value,'$.executionReadset')")) projectedQueries++;
    return f.db.prepare(sql);
  } } as unknown as CompanionConnection;
  const resolver = new CompanionExecutionSourceStore(counted, { sources: f.access } as CompanionMemoryStore);
  const parsed = vi.spyOn(JSON, 'parse');
  try {
    const actual = resolver.resolve(ids);
    expect(actual).toEqual(expected);
    expect(projectedQueries).toBe(1); // Five roots share the same exact action readset.
    expect(parsed.mock.calls.some(([value]) => typeof value === 'string' && value.length > 1_000_000)).toBe(false);
  } finally { parsed.mockRestore(); }
  f.store.request({ type: 'execution.invalidate', kind: 'action', id: action.id, companionId: 'alice' });
  expect(resolver.resolve(ids).find(proof => proof.kind === 'action')?.invalidated).toBe(true);
  expect(projectedQueries).toBe(2); // No metadata or validity cache survives a request.
});

it('reads status and original request from large completed loops without parsing their saved model contexts', () => {
  const f = fixture(8), largeContext = 'UNRELATED_FROZEN_MODEL_CONTEXT_'.repeat(50000);
  for (const message of f.nodes.slice(1)) f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('message-loop/' + message.id,
    JSON.stringify({ status: 'done', sourceMessageId: f.base.id, context: { system: '', user: largeContext } }));
  const parsed = vi.spyOn(JSON, 'parse');
  try {
    expect(f.access.filter(f.alice, f.nodes.slice(-2).map(node => node.id))).toHaveLength(2);
    const resolver = new CompanionExecutionSourceStore(f.db, { sources: f.access } as CompanionMemoryStore);
    expect(resolver.resolve(f.nodes.slice(1).map(node => node.id))).toHaveLength(8);
    expect(parsed.mock.calls.some(([value]) => typeof value === 'string' && value.includes('UNRELATED_FROZEN_MODEL_CONTEXT_'))).toBe(false);
  } finally { parsed.mockRestore(); }
});

it('resolves each shared adjacency once for many roots and retains all roots affected by a withdrawn ancestor', () => {
  const f = fixture(24), roots = f.nodes.slice(1), queries: string[] = [];
  const counted = { prepare: (sql: string) => { queries.push(sql); return f.db.prepare(sql); } } as unknown as CompanionConnection;
  const resolver = new CompanionExecutionSourceStore(counted, { sources: f.access } as CompanionMemoryStore);
  const proofs = resolver.resolve(roots.map(message => message.id));
  expect(proofs).toHaveLength(24);
  expect(queries.filter(sql => sql === 'SELECT action_id,author_id,conversation_id FROM messages WHERE id=?')).toHaveLength(25);
  for (const [index, message] of roots.entries()) {
    expect(proofs.find(proof => proof.id === message.id)?.sourceMessageIds).toEqual(roots.slice(index).map(root => root.id));
  }
  f.store.request({ type: 'execution.invalidate', kind: 'message', id: roots[3]!.id, companionId: 'alice' });
  expect(resolver.resolve(roots.map(message => message.id)).find(proof => proof.id === roots[3]!.id)?.invalidated).toBe(true);
});
function noteFixture(count: number) {
  const f = fixture(0), source = f.base;
  const original = f.store.request({ type: 'memory.record', ...f.alice, candidate: { content: source.content,
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const outbox = f.store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
  const noteIds = [original.id];
  for (let index = 0; index < count; index++) {
    const id = 'note_probe_' + index;
    f.db.prepare('INSERT INTO vcp_memory_notes(id,companion_id,conversation_id,scope_id,identity_key,data) VALUES(?,?,?,?,?,?)')
      .run(id, 'alice', f.alice.conversationId, original.scopeId, id, JSON.stringify({ ...original, id, status: 'indexed', content: 'DERIVED_NOTE_' + index }));
    for (const parent of noteIds.slice(-2)) f.db.prepare('INSERT INTO vcp_note_dependencies(note_id,source_note_id,version) VALUES(?,?,1)').run(id, parent);
    for (const reference of original.sources) f.db.prepare('INSERT INTO vcp_note_sources(note_id,message_id,revision,checksum) VALUES(?,?,?,?)')
      .run(id, reference.messageId, reference.revision, reference.checksum);
    noteIds.push(id);
  }
  return { ...f, original, noteIds, read: () => f.store.request({ type: 'memory.read', ...f.alice, id: noteIds.at(-1)! }).memoryRead!.memory };
}
function topicFixture(count: number) {
  const f = fixture(count), topic = f.store.request({ type: 'topic.create', conversationId: f.alice.conversationId, readerId: 'alice', title: '共享校验范围', kind: 'story' }).topic!;
  const events: string[] = [];
  for (const source of f.nodes) {
    const id = 'scope_event_' + events.length;
    const data = { sourceEventId: id, sourceMessageIds: [source.id], sourceChecksums: { [source.id]: hash(source.content) },
      derivedFromEventIds: events.slice(-2), summary: '实际来源 ' + events.length, updatedAt: source.createdAt, authorId: 'alice', revision: events.length + 1 };
    f.db.prepare('INSERT INTO companion_topic_events(id,topic_id,reader_id,author_id,data) VALUES(?,?,?,?,?)').run(id, topic.id, 'alice', 'alice', JSON.stringify(data));
    events.push(id);
    if (source === f.nodes.at(-1)) f.db.prepare('INSERT INTO companion_topic_state(topic_id,reader_id,data) VALUES(?,?,?)').run(topic.id, 'alice', JSON.stringify(data));
  }
  return { ...f, topic, readTopic: () => f.store.request({ type: 'topic.read', conversationId: f.alice.conversationId, topicId: topic.id, readerId: 'alice' }) };
}
it('validates shared source DAGs with linear SQL growth instead of recursively expanding every ancestry path', () => {
  const measurements = [24, 48].map(count => {
    const f = fixture(count), started = performance.now(); f.resetQueries();
    expect(f.access.filter(f.alice, f.nodes.slice(-2).map(node => node.id))).toHaveLength(2);
    return { nodes: count + 1, edges: count * 2 - 1, queries: f.getQueries(), elapsedMs: performance.now() - started };
  });
  expect(measurements[1]!.queries).toBeLessThan(measurements[0]!.queries * 3);
  expect(measurements[1]!.queries).toBeLessThan(10000);
  mkdirSync('artifacts/vcp-validation', { recursive: true });
  writeFileSync('artifacts/vcp-validation/source-access-dag-memo-performance-2026-10-23.json', JSON.stringify({ actualSQLite: true, measurements }, null, 2));
});
it('reuses compiled statements while every read still observes source edits and actual withdrawal', () => {
  const f = fixture(6), leaf = f.nodes.at(-1)!; let gets = 0;
  const prepare = vi.fn((sql: string) => {
    const statement = f.db.prepare(sql);
    return { get: (...args: unknown[]) => { gets++; return statement.get(...args); },
      all: statement.all.bind(statement), run: statement.run.bind(statement) };
  });
  const access = new CompanionSourceAccess({ prepare } as unknown as CompanionConnection, id => f.store.getMessage(id));
  expect(access.filter(f.alice, [leaf.id])).toHaveLength(1);
  // Delegated readset validators keep their own uncached prepares. Measure
  // only this source-access instance's hot static statements, not all SQL.
  const statements = ['SELECT * FROM messages WHERE id=?', 'SELECT total_changes() AS n', 'PRAGMA data_version'];
  const prepared = () => statements.map(sql => prepare.mock.calls.filter(([query]) => query === sql).length);
  const firstGets = gets;
  expect(prepared()).toEqual([1, 1, 1]);
  expect(access.filter(f.alice, [leaf.id])).toHaveLength(1);
  expect(prepared()).toEqual([1, 1, 1]); expect(gets).toBeGreaterThan(firstGets);
  f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('EDITED_CACHED_STATEMENT_SOURCE', f.base.id);
  expect(access.filter(f.alice, [leaf.id])).toEqual([]);
  f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run(f.base.content, f.base.id);
  expect(access.filter(f.alice, [leaf.id])).toHaveLength(1);
  f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [f.base.id] });
  expect(access.filter(f.alice, [leaf.id])).toEqual([]);
  expect(prepared()).toEqual([1, 1, 1]);
});
it('rechecks same-ID source bytes and owner/cursor ACLs on every top-level read', () => {
  const f = fixture(20), leaf = f.nodes.at(-1)!;
  expect(f.access.filter(f.alice, [leaf.id])).toHaveLength(1);
  expect(f.access.filter(f.bob, [leaf.id])).toEqual([]);
  expect(f.access.filter({ ...f.alice, beforeSequence: leaf.sequence - 1 }, [leaf.id])).toEqual([]);
  f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('CHANGED_SAME_ID_538', f.base.id);
  expect(f.access.filter(f.alice, [leaf.id])).toEqual([]);
});
it('discards completed memo entries after writes from another connection inside one read', () => {
  const f = fixture(20), [first, second] = f.nodes.slice(-2); let blocked = false;
  f.onRead(id => { if (!blocked && id === first!.id) { blocked = true; f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [f.base.id] }); } });
  expect(f.access.filter(f.alice, [first!.id, second!.id]).map(message => message.id)).toEqual([first!.id]);
  expect(f.access.filter(f.alice, [first!.id])).toEqual([]);
});
it('does not turn a real dependency cycle into a successful cached proof', () => {
  const f = fixture(12), first = f.nodes[1]!, last = f.nodes.at(-1)!;
  f.bind(first, [last]); // first -> last -> ... -> first is an actual cycle.
  expect(f.access.filter(f.alice, [last.id])).toEqual([]);
  expect(f.access.filter(f.alice, [f.base.id])).toHaveLength(1);
});
it('validates shared note-version DAGs without expanding their common ancestors repeatedly', () => {
  const measurements = [24, 48].map(count => {
    const f = noteFixture(count);
    let queries = 0, budgetExceeded = false, error: string | undefined;
    const prototype = (Database as { prototype: SqlitePrototype }).prototype;
    const prepare = prototype.prepare;
    const spy = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: typeof prototype, sql) {
      if (++queries > 10000) { budgetExceeded = true; throw new Error('NOTE_DAG_SQL_BUDGET_EXCEEDED'); }
      return prepare.call(this, sql);
    });
    const started = performance.now(); let valid = false;
    try { valid = !!f.read(); }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { spy.mockRestore(); }
    return { nodes: count + 1, queries, elapsedMs: performance.now() - started, budgetExceeded, valid, error };
  });
  const label = process.env.WORLDLINEBOX_NOTE_DAG_PROBE_LABEL === 'before' ? 'before' : 'after';
  mkdirSync('artifacts/vcp-validation', { recursive: true });
  writeFileSync('artifacts/vcp-validation/source-note-dag-' + label + '-2026-10-23.json', JSON.stringify({ actualSQLite: true, queryBudget: 10000, measurements }, null, 2));
  expect(measurements.every(value => value.valid && !value.budgetExceeded)).toBe(true);
  expect(measurements[1]!.queries).toBeLessThan(measurements[0]!.queries * 3);
});
it('keeps note DAG reads bound to owner, cursor and original source bytes', () => {
  const f = noteFixture(16), id = f.noteIds.at(-1)!;
  expect(f.read().id).toBe(id);
  expect(() => f.store.request({ type: 'memory.read', ...f.bob, id })).toThrow('日记来源失效');
  expect(() => f.store.request({ type: 'memory.read', ...f.alice, beforeSequence: f.base.sequence - 1, id })).toThrow('日记来源失效');
  f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('CHANGED_NOTE_SOURCE_631', f.base.id);
  expect(() => f.read()).toThrow('日记来源失效');
});
it('rechecks exact ancestor versions even when every original message still matches', () => {
  const f = noteFixture(16); expect(f.read()).toBeDefined();
  f.db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.version',2) WHERE id=?").run(f.original.id);
  expect(() => f.read()).toThrow('日记来源失效');
});
it('withdraws shared note descendants through the actual memory forget command', () => {
  const f = noteFixture(16); expect(f.read()).toBeDefined();
  f.store.request({ type: 'memory.forget', ...f.alice, id: f.original.id });
  expect(() => f.read()).toThrow('日记来源失效');
});
it('rejects real note dependency cycles while retaining an independent valid original', () => {
  const f = noteFixture(16), first = f.noteIds[1]!, last = f.noteIds.at(-1)!;
  f.db.prepare('INSERT INTO vcp_note_dependencies(note_id,source_note_id,version) VALUES(?,?,1)').run(first, last);
  expect(() => f.read()).toThrow('日记来源失效');
  expect(f.store.request({ type: 'memory.read', ...f.alice, id: f.original.id }).memoryRead?.memory.id).toBe(f.original.id);
});
it('invalidates note memo values after another connection changes an ancestor during the same read', () => {
  const f = noteFixture(16), secondBranch = f.noteIds.at(-2)!;
  const prototype = (Database as { prototype: SqlitePrototype }).prototype;
  const prepare = prototype.prepare; let changed = false;
  const spy = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: typeof prototype, sql) {
    const statement = prepare.call(this, sql);
    if (sql !== 'SELECT data FROM vcp_memory_notes WHERE id=?') return statement;
    return { get: (id: string) => {
      if (id === secondBranch && !changed) {
        changed = true;
        // Keep its version and sources identical: only mutation invalidation,
        // rather than a new cache key, can reject this formerly valid ancestor.
        const found = f.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(f.original.id) as { data: string };
        const note = JSON.parse(found.data) as CompanionMemory;
        f.db.prepare('UPDATE vcp_memory_notes SET data=? WHERE id=?').run(JSON.stringify({ ...note, status: 'invalid' }), note.id);
      }
      return statement.get(id);
    } } as ReturnType<CompanionConnection['prepare']>;
  });
  try { expect(() => f.read()).toThrow('日记来源失效'); expect(changed).toBe(true); }
  finally { spy.mockRestore(); }
});
it('shares one validation session across every checkpoint in a complete topic read command', () => {
  const measurements = [24, 48].map(count => {
    const f = topicFixture(count); let queries = 0;
    const prototype = (Database as { prototype: SqlitePrototype }).prototype, prepare = prototype.prepare;
    const spy = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: SqlitePrototype, sql) {
      if (++queries > 10000) throw new Error('TOPIC_COMMAND_SQL_BUDGET_EXCEEDED');
      return prepare.call(this, sql);
    });
    const started = performance.now();
    try { expect(f.readTopic().topicState?.workingState?.sourceEventId).toBe('scope_event_' + count); }
    finally { spy.mockRestore(); }
    return { nodes: count + 1, queries, elapsedMs: performance.now() - started };
  });
  expect(measurements[1]!.queries).toBeLessThan(measurements[0]!.queries * 3);
  writeFileSync('artifacts/vcp-validation/source-topic-command-scope-performance-2026-10-23.json', JSON.stringify({ actualSQLite: true, measurements }, null, 2));
});
it('shares validation for a whole indexed-note snapshot and starts fresh after a real withdrawal', () => {
  const f = noteFixture(48); let queries = 0;
  const prototype = (Database as { prototype: SqlitePrototype }).prototype, prepare = prototype.prepare;
  const spy = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: SqlitePrototype, sql) {
    if (++queries > 3000) throw new Error('SNAPSHOT_COMMAND_SQL_BUDGET_EXCEEDED');
    return prepare.call(this, sql);
  });
  try { expect(f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot?.notes).toHaveLength(49); }
  finally { spy.mockRestore(); }
  f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [f.base.id] });
  expect(f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot?.notes).toEqual([]);
});
it('attests only current exact stored message readsets in one jointly validated proof batch', () => {
  const f = fixture(24), response = f.store.request({ type: 'execution.sources', sourceMessageIds: f.nodes.slice(-2).map(node => node.id) });
  const proofs = companionStorageResponseSchema.parse(response).executionSources!;
  expect(proofs).toHaveLength(24);
  for (const proof of proofs) expect(proof.storageValidatedReadsetDigest).toBe(hash(JSON.stringify(proof.executionReadset)));
  f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('ATTESTATION_CHANGED_ORIGINAL', f.base.id);
  expect(f.store.request({ type: 'execution.sources', sourceMessageIds: [f.nodes.at(-1)!.id] }).executionSources?.every(proof => !proof.storageValidatedReadsetDigest)).toBe(true);
});
it('attests only a completed action exact checkpoint and rechecks actual source bytes and ownership', () => {
  const f = fixture(4), readset = captureCompanionExecutionReadset(f.alice, { context: { user: JSON.stringify({ messages: f.nodes }) } });
  const action = f.store.request({ type: 'action.create', action: { ...f.alice, sourceMessageId: f.base.id, title: '验证完整动作来源', status: 'queued' },
    checkpoint: { prompt: '真实请求', executionReadset: readset } }).action!;
  expect(f.access.validatedActionReadsetDigest(action.id, readset)).toBeUndefined();
  f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '完成核验' } });
  const result = f.store.request({ type: 'messages', conversationId: f.alice.conversationId }).messages!.find(message => message.actionId === action.id)!;
  const actual = () => f.store.request({ type: 'execution.sources', sourceMessageIds: [result.id] }).executionSources!.find(proof => proof.kind === 'action' && proof.id === action.id)!;
  expect(actual().storageValidatedReadsetDigest).toBe(hash(JSON.stringify(readset)));
  expect(f.access.validatedActionReadsetDigest(action.id, { ...readset, companionId: 'bob' })).toBeUndefined();
  f.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('ACTION_SOURCE_CHANGED', f.base.id);
  expect(actual().storageValidatedReadsetDigest).toBeUndefined();
});
it('keeps action attestations bound to the original memory cursor and source-room entrance', () => {
  const f = noteFixture(0), group = f.store.request({ type: 'conversation.create-group', title: '动作的群聊资料', memberIds: ['alice', 'bob'] }).conversation!;
  const source = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: 'ACTION_GROUP_SOURCE', replyDirective: 'none' });
  const readset = captureCompanionExecutionReadset(f.alice, { context: { user: JSON.stringify({ messages: [source] }) } });
  const action = f.store.request({ type: 'action.create', action: { ...f.alice, sourceMessageId: f.base.id, title: '保持动作来源范围', status: 'queued' },
    checkpoint: { prompt: '真实请求', executionReadset: readset } }).action!;
  f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '实际结果' } });
  expect(f.access.validatedActionReadsetDigest(action.id, readset)).toBeDefined();
  f.store.request({ type: 'conversation.update', id: group.id, memberIds: ['bob'] });
  expect(f.access.validatedActionReadsetDigest(action.id, readset)).toBeUndefined();
  const beyond = captureCompanionExecutionReadset({ ...f.alice, beforeSequence: 0 }, { memories: [{ id: f.original.id, version: f.original.version }] });
  const cursorAction = f.store.request({ type: 'action.create', action: { ...f.alice, sourceMessageId: f.base.id, title: '保持动作记忆游标', status: 'queued' },
    checkpoint: { prompt: '真实请求', executionReadset: beyond } }).action!;
  f.store.request({ type: 'action.update', id: cursorAction.id, patch: { status: 'succeeded', result: '实际结果' } });
  expect(f.access.validatedActionReadsetDigest(cursorAction.id, beyond)).toBeUndefined();
});
it('does not attest a forged expected readset or one withdrawn during its synchronous validation', () => {
  const f = fixture(12), leaf = f.nodes.at(-1)!;
  const proof = f.store.request({ type: 'execution.sources', sourceMessageIds: [leaf.id] }).executionSources!.find(proof => proof.id === leaf.id)!;
  expect(f.access.validatedMessageReadsetDigest(leaf.id, { ...proof.executionReadset!, companionId: 'bob' })).toBeUndefined();
  const formal = f.access.formal; let withdrawn = false;
  const spy = vi.spyOn(f.access, 'formal').mockImplementation(source => {
    const valid = formal.call(f.access, source);
    if (source.id === leaf.id && !withdrawn) { withdrawn = true; expect(valid).toBe(true); f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [f.base.id] }); }
    return valid;
  });
  try { expect(f.access.validatedMessageReadsetDigest(leaf.id, proof.executionReadset!)).toBeUndefined(); expect(withdrawn).toBe(true); }
  finally { spy.mockRestore(); }
});
it('does not certify a memory beyond the original Main dialogue cursor', () => {
  const f = noteFixture(0);
  const readset = captureCompanionExecutionReadset({ ...f.alice, beforeSequence: 0 }, { memories: [{ id: f.original.id, version: f.original.version }] });
  const message = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: 'CURSOR_ATTESTATION_PROBE', replyDirective: 'none', executionReadset: readset });
  expect(f.store.request({ type: 'memory.records.filter', ...f.alice, beforeSequence: 0, ids: [f.original.id] }).memories).toEqual([]);
  expect(f.store.request({ type: 'execution.sources', sourceMessageIds: [message.id] }).executionSources?.find(proof => proof.id === message.id)?.storageValidatedReadsetDigest).toBeUndefined();
});
it('keeps the exact original source-room entrance ACL when its author has left that group', () => {
  const f = fixture(0), group = f.store.request({ type: 'conversation.create-group', title: '旧群来源', memberIds: ['alice', 'bob'] }).conversation!;
  const source = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: 'ORIGINAL_GROUP_WITNESS', replyDirective: 'none' });
  const readset = captureCompanionExecutionReadset(f.alice, { sources: [{ id: source.id, conversationId: group.id, checksum: hash(source.content) }] });
  const message = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: 'GROUP_SOURCE_DERIVATIVE', replyDirective: 'none', executionReadset: readset });
  const proof = () => f.store.request({ type: 'execution.sources', sourceMessageIds: [message.id] }).executionSources?.find(proof => proof.id === message.id);
  expect(proof()?.storageValidatedReadsetDigest).toBeDefined();
  f.store.request({ type: 'conversation.update', id: group.id, memberIds: ['bob'] });
  expect(() => f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: group.id, ids: [source.id] })).toThrow('聊天成员');
  expect(proof()?.storageValidatedReadsetDigest).toBeUndefined();
});
it('keeps the original topic participant-or-invitee ACL for immutable old checkpoints', () => {
  const f = topicFixture(3), state = f.readTopic().topicState!.workingState!;
  const readset = captureCompanionExecutionReadset(f.alice, { topics: [{ conversationId: f.alice.conversationId, topicId: f.topic.id,
    sourceMessageIds: state.sourceMessageIds, checkpointEventIds: [state.sourceEventId] }] });
  const message = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: 'OLD_TOPIC_DERIVATIVE', replyDirective: 'none', executionReadset: readset });
  const proof = () => f.store.request({ type: 'execution.sources', sourceMessageIds: [message.id] }).executionSources?.find(proof => proof.id === message.id);
  expect(proof()?.storageValidatedReadsetDigest).toBeDefined();
  f.store.request({ type: 'topic.join', conversationId: f.alice.conversationId, topicId: f.topic.id, readerId: 'user' });
  const left = f.store.request({ type: 'topic.leave', conversationId: f.alice.conversationId, topicId: f.topic.id, readerId: 'alice' }).topic!;
  f.store.request({ type: 'topic.update', conversationId: f.alice.conversationId, topicId: f.topic.id, readerId: 'user', expectedRevision: left.revision, patch: { invitedIds: [] } });
  expect(() => f.store.request({ type: 'topic.sources.valid', conversationId: f.alice.conversationId, topicId: f.topic.id, readerId: 'alice', sourceMessageIds: [], checkpointEventIds: [state.sourceEventId] })).toThrow('当前读者');
  expect(proof()?.storageValidatedReadsetDigest).toBeUndefined();
});
