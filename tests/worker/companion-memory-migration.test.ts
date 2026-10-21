import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionMemoryToolArgumentsSchemas } from '../../src/shared/companion-memory-tool';

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

it('migrates only authorization and retires every fact table without reviving forgotten original text', () => {
  const f = fixture();
  f.db.prepare('INSERT INTO memory_source_blocks VALUES(?,?,?)').run(f.forgotten.id, 'alice', '2026-10-01');
  f.db.close();
  const store = open(f.file);
  expect(store.getMessage(f.forgotten.id).content).toBe(f.forgotten.content);
  expect(store.request({ type: 'memory.sources.filter', ...f.scope, ids: [f.forgotten.id] }).memorySources).toEqual([]);
  expect(() => store.request({ type: 'memory.record', ...f.scope, candidate: draft(f.forgotten) })).toThrow('撤回');
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob?.sourceMessageIds).toEqual([f.common.id]);
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'bob' }).memoryJob).toBeUndefined();
  expect(store.request({ type: 'memory.browse', ...f.scope }).memoryPage?.items).toEqual([]);
  close(store);
  const db = new Database(f.file);
  try {
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name='memories' OR name GLOB 'memory_*' OR name IN('companion_reset_memories','companion_reset_invalidations'))").all();
    expect(legacy).toEqual([]);
    expect(db.prepare('SELECT 1 FROM metadata WHERE key=?').get('vcp-memory-replacement/authorization-v1')).toBeDefined();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
  const reopened = open(f.file);
  expect(reopened.request({ type: 'memory.sources.filter', ...f.scope, ids: [f.forgotten.id] }).memorySources).toEqual([]);
});

it('makes an untranslatable persistent authorization visible and releasable without releasing old source blocks', () => {
  const f = fixture();
  f.db.prepare('INSERT INTO memory_forget_rules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('old_policy', 'alice', f.scope.conversationId, null, JSON.stringify([f.forgotten.id]), 'user', 'address', '旧限制标签', f.forgotten.sequence, 1, f.forgotten.id, '2026-10-01');
  f.db.close();
  const store = open(f.file), future = store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '一段新的普通经历。' });
  const policies = store.request({ type: 'memory.policy.list', companionId: 'alice' }).memoryPolicies!;
  expect(policies).toMatchObject([{ id: 'old_policy', conversationId: f.scope.conversationId, blocked: true, requestSnippet: f.forgotten.content }]);
  expect(() => store.request({ type: 'memory.record', ...f.scope, candidate: draft(future) })).toThrow('记忆管理');
  expect(store.request({ type: 'memory.sources.filter', ...f.scope, ids: [future.id] }).memorySources).toHaveLength(1);
  const publicNote = store.request({ type: 'memory.record', companionId: 'alice', conversationId: f.group.id, candidate: draft(f.common) }).memories![0]!;
  expect(publicNote.status).toBe('queued');
  expect(() => store.request({ type: 'memory.policy.release', companionId: 'bob', id: 'old_policy' })).toThrow('不属于');
  expect(Object.keys(companionMemoryToolArgumentsSchemas).some(name => name.includes('policy'))).toBe(false);
  const released = store.request({ type: 'memory.policy.release', companionId: 'alice', id: 'old_policy' });
  expect(released.memoryPolicies?.[0]?.blocked).toBe(false);
  expect(released.memoryInvalidatedCompanionIds).toEqual(['alice']);
  expect(store.request({ type: 'memory.record', ...f.scope, candidate: { ...draft(future), tags: ['旧限制标签'] } }).memories).toHaveLength(1);
  store.request({ type: 'memory.jobs.backfill' });
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob?.sourceMessageIds).not.toContain(f.forgotten.id);
  expect(() => store.request({ type: 'memory.record', ...f.scope, candidate: draft(f.forgotten) })).toThrow();
});

it('rolls back the whole retirement if an unknown host table still references a legacy fact', () => {
  const f = fixture();
  f.db.exec('CREATE TABLE unexpected_reference(id TEXT PRIMARY KEY,memory_id TEXT REFERENCES memories(id)); INSERT INTO unexpected_reference VALUES(\'host\',\'old_fact\')');
  f.db.close();
  expect(() => open(f.file)).toThrow();
  const db = new Database(f.file);
  try {
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_sources'").get()).toBeDefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_search'").get()).toBeDefined();
    expect(db.prepare('SELECT 1 FROM metadata WHERE key=?').get('vcp-memory-replacement/authorization-v1')).toBeUndefined();
    expect(db.prepare('SELECT * FROM vcp_source_blocks').all()).toEqual([]);
    expect(db.prepare('SELECT content FROM messages WHERE id=?').get(f.forgotten.id)).toMatchObject({ content: f.forgotten.content });
  } finally { db.close(); }
});
