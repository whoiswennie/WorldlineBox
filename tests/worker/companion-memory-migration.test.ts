import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionStorageCommandSchema } from '../../src/shared/companion-storage';

const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '尊重实际来源', description: '', model: '', avatar: 'sister', proactive: false, active: true }));
const folders: string[] = [], stores = new Set<CompanionsStore>();
const open = (file: string) => { const store = new CompanionsStore(file, seeds); stores.add(store); return store; };
const close = (store: CompanionsStore) => { store.close(); stores.delete(store); };
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'vcp-memory-upgrade-')); folders.push(folder);
  const file = path.join(folder, 'state.db'), store = open(file);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const forgotten = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '旧地址是不可再次收录的原文。' });
  const group = store.createConversation('旧公开经历', ['alice', 'bob']);
  const common = store.appendMessage({ conversationId: group.id, authorId: 'user', content: '只有alice实际读过的旧群消息。' });
  close(store);
  const db = new Database(file);
  db.pragma('foreign_keys=ON');
  db.exec(`DELETE FROM vcp_capture_jobs; DELETE FROM vcp_source_observers;
    DELETE FROM metadata WHERE key='vcp-memory-replacement/authorization-v1';
    CREATE TABLE memories(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),data TEXT NOT NULL);
    CREATE TABLE memory_records(ordinal INTEGER PRIMARY KEY,memory_id TEXT REFERENCES memories(id));
    CREATE TABLE memory_sources(memory_id TEXT REFERENCES memories(id),message_id TEXT REFERENCES messages(id),revision INTEGER,checksum TEXT);
    CREATE TABLE memory_observers(message_id TEXT REFERENCES messages(id),companion_id TEXT REFERENCES companions(id));
    CREATE TABLE memory_source_blocks(message_id TEXT REFERENCES messages(id),companion_id TEXT REFERENCES companions(id),created_at TEXT);
    CREATE TABLE memory_forget_rules(id TEXT PRIMARY KEY,companion_id TEXT,conversation_id TEXT,memory_id TEXT,source_message_ids TEXT,subject TEXT,fact_key TEXT,tag TEXT,through_sequence INTEGER,persistent INTEGER,request_message_id TEXT,created_at TEXT);
    CREATE TABLE memory_tags(id TEXT PRIMARY KEY,companion_id TEXT,name TEXT,aliases TEXT);
    CREATE TABLE memory_tag_links(memory_id TEXT REFERENCES memories(id),tag_id TEXT REFERENCES memory_tags(id));
    CREATE TABLE memory_dependencies(memory_id TEXT REFERENCES memories(id),source_memory_id TEXT REFERENCES memories(id));
    CREATE TABLE memory_relations(from_id TEXT REFERENCES memories(id),to_id TEXT REFERENCES memories(id));
    CREATE TABLE memory_jobs(id TEXT PRIMARY KEY); CREATE TABLE memory_operations(id TEXT PRIMARY KEY);
    CREATE VIRTUAL TABLE memory_search USING fts5(tokens);
    CREATE TABLE companion_reset_memories(memory_id TEXT); CREATE TABLE companion_reset_invalidations(memory_id TEXT);`);
  db.prepare('INSERT INTO memories VALUES(?,?,?)').run('old_fact', 'alice', JSON.stringify({ id: 'old_fact', companionId: 'alice', content: forgotten.content, kind: 'fact', subject: 'user', factKey: 'address', status: 'forgotten', sourceConversationId: scope.conversationId, sourceSequence: forgotten.sequence, sources: [{ messageId: forgotten.id }] }));
  db.prepare('INSERT INTO memory_records VALUES(1,?)').run('old_fact');
  db.prepare('INSERT INTO memory_sources VALUES(?,?,1,?)').run('old_fact', forgotten.id, 'old-checksum');
  db.prepare('INSERT INTO memory_observers VALUES(?,?)').run(common.id, 'alice');
  return { file, scope, forgotten, common, group, db };
}
function draft(message: { id: string; content: string }) { return { content: message.content, sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }] }; }

it('does not import, retire or replay old facts, authorization receipts or messages on startup', () => {
  const f = fixture();
  f.db.prepare('INSERT INTO memory_source_blocks VALUES(?,?,?)').run(f.forgotten.id, 'alice', '2026-10-01');
  f.db.close();
  const store = open(f.file);
  expect(store.getMessage(f.forgotten.id).content).toBe(f.forgotten.content);
  expect(store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob).toBeUndefined();
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'bob' }).memoryJob).toBeUndefined();
  expect(store.request({ type: 'memory.browse', ...f.scope }).memoryPage?.items).toEqual([]);
  close(store);
  const db = new Database(f.file);
  try {
    expect(db.prepare('SELECT id FROM memories').all()).toEqual([{ id: 'old_fact' }]);
    expect(db.prepare('SELECT * FROM vcp_source_blocks').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM vcp_source_observers').all()).toEqual([]);
    expect(db.prepare("SELECT key FROM metadata WHERE key GLOB 'vcp-capture-backfill-*' OR key GLOB 'vcp-peer-episode-backfill-*' OR key GLOB 'vcp-memory-replacement/*'").all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
  const reopened = open(f.file);
  expect(reopened.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob).toBeUndefined();
  expect(reopened.request({ type: 'memory.browse', ...f.scope }).memoryPage?.items).toEqual([]);
});

it('does not translate old selectors into modern policy and captures only a newly received event', () => {
  const f = fixture();
  f.db.prepare('INSERT INTO memory_forget_rules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('old_policy', 'alice', f.scope.conversationId, null, JSON.stringify([f.forgotten.id]), 'user', 'address', '旧限制标签', f.forgotten.sequence, 1, f.forgotten.id, '2026-10-01');
  f.db.close();
  const store = open(f.file), future = store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '一段新的普通经历。' });
  const policies = store.request({ type: 'memory.policy.list', companionId: 'alice' }).memoryPolicies!;
  expect(policies).toEqual([]);
  expect(() => store.request({ type: 'memory.policy.release', companionId: 'alice', id: 'old_policy' })).toThrow('不属于');
  expect(store.request({ type: 'memory.sources.filter', ...f.scope, ids: [future.id] }).memorySources).toHaveLength(1);
  expect(store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob?.sourceMessageIds).toEqual([future.id]);
  expect(store.request({ type: 'memory.record', ...f.scope, candidate: { ...draft(future), tags: ['旧限制标签'] } }).memories).toHaveLength(1);
  expect(companionStorageCommandSchema.safeParse({ type: 'memory.jobs.backfill' }).success).toBe(false);
});

it('leaves unrelated old database tables and references untouched without a retirement transaction', () => {
  const f = fixture();
  f.db.exec('CREATE TABLE unexpected_reference(id TEXT PRIMARY KEY,memory_id TEXT REFERENCES memories(id)); INSERT INTO unexpected_reference VALUES(\'host\',\'old_fact\')');
  f.db.close();
  const store = open(f.file);
  expect(store.request({ type: 'memory.browse', ...f.scope }).memoryPage?.items).toEqual([]);
  close(store);
  const db = new Database(f.file);
  try {
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_sources'").get()).toBeDefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_search'").get()).toBeDefined();
    expect(db.prepare('SELECT 1 FROM metadata WHERE key=?').get('vcp-memory-replacement/authorization-v1')).toBeUndefined();
    expect(db.prepare('SELECT * FROM vcp_source_blocks').all()).toEqual([]);
    expect(db.prepare('SELECT content FROM messages WHERE id=?').get(f.forgotten.id)).toMatchObject({ content: f.forgotten.content });
  } finally { db.close(); }
});

it('resumes the current generation pending capture and immutable notes across restart without scanning older messages', () => {
  const f = fixture(); f.db.close();
  const store = open(f.file), current = store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '本次新系统收到的完整经历。', replyDirective: 'none' });
  close(store);
  const reopened = open(f.file), job = reopened.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
  expect(job.sourceMessageIds).toEqual([current.id]);
  const note = reopened.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [draft(current)] }).memories![0]!;
  close(reopened);
  const again = open(f.file);
  expect(again.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead?.memory).toMatchObject({ content: current.content, contentRevision: 1 });
  expect(again.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob).toBeUndefined();
});
