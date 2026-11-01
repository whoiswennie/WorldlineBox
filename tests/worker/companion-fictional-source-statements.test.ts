import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import { companionMessageFictionalLineage } from '../../src/companions/fictional-source';
import { fencedCompanionConnection } from '../../src/companions/recovery-fence';

const databases: CompanionConnection[] = [], roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('wlbox-fixed-statements-')) throw new Error('Unexpected fixture directory');
    rmSync(root, { recursive: true, force: true });
  }
});
function connection(filename: string) { const db = new (Database as { new(filename: string): CompanionConnection })(filename); databases.push(db); return db; }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wlbox-fixed-statements-')); roots.push(root);
  const filename = path.join(root, 'fixture.sqlite'), db = connection(filename);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE companion_topics(id TEXT PRIMARY KEY,conversation_id TEXT,data TEXT);
    CREATE TABLE companion_message_topics(message_id TEXT,topic_id TEXT);`);
  db.prepare('INSERT INTO companion_topics VALUES(?,?,?)').run('topic', 'room', JSON.stringify({ kind: 'discussion' }));
  const proof: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true,
    companionId: 'alice', conversationId: 'room', sources: [{ id: 'ancestor', conversationId: 'room', checksum: 'a'.repeat(64) }],
    memories: [], contexts: [], knowledgeReads: [], topics: [{ topicId: 'topic', conversationId: 'room', checkpointEventIds: ['event'], sourceMessageIds: [] }] };
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('message-execution-readset/root', JSON.stringify(proof));
  db.prepare('INSERT INTO companion_message_topics VALUES(?,?)').run('ancestor', 'topic');
  return { db, filename };
}

it('compiles three fixed lineage queries once while re-reading external topic and readset changes', () => {
  const { db, filename } = fixture(), external = connection(filename), prepare = vi.spyOn(db, 'prepare');
  expect(companionMessageFictionalLineage(db, 'root')).toBe(false);
  expect(companionMessageFictionalLineage(db, 'root')).toBe(false);
  expect(prepare).toHaveBeenCalledTimes(3);
  external.prepare("UPDATE companion_topics SET data=json_set(data,'$.kind','game') WHERE id=?").run('topic');
  expect(companionMessageFictionalLineage(db, 'root')).toBe(true);
  external.prepare("UPDATE companion_topics SET data=json_set(data,'$.kind','discussion') WHERE id=?").run('topic');
  external.prepare("UPDATE metadata SET value=json_set(value,'$.sources',json('[]'),'$.topics',json('[]')) WHERE key=?").run('message-execution-readset/root');
  expect(companionMessageFictionalLineage(db, 'root')).toBe(false);
  expect(prepare).toHaveBeenCalledTimes(3); prepare.mockRestore();
});

it('keeps same SQL compiled on separate connections isolated and permits schema reprepare without stale results', () => {
  const a = fixture(), b = fixture(), second = vi.spyOn(b.db, 'prepare');
  expect(companionMessageFictionalLineage(a.db, 'root')).toBe(false);
  b.db.prepare("UPDATE companion_topics SET data=json_set(data,'$.kind','story') WHERE id=?").run('topic'); second.mockClear();
  expect(companionMessageFictionalLineage(b.db, 'root')).toBe(true); expect(second).toHaveBeenCalledTimes(3);
  a.db.exec('ALTER TABLE companion_topics ADD COLUMN independent TEXT');
  a.db.prepare("UPDATE companion_topics SET data=json_set(data,'$.kind','game') WHERE id=?").run('topic');
  expect(companionMessageFictionalLineage(a.db, 'root')).toBe(true);
  a.db.exec('DROP TABLE companion_topics'); expect(() => companionMessageFictionalLineage(a.db, 'root')).toThrow(); second.mockRestore();
});

it('retains the supplied fenced statement behavior and does not cache failed compilation', () => {
  const { db } = fixture(); let blocked = false;
  const read = vi.fn(), guarded = new Proxy(db, { get(target, name) {
    if (name === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(current, member) {
        const value = Reflect.get(current, member, current); if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { if (member === 'get') { read(); if (blocked) throw new Error('Host connection currently unavailable'); } return Reflect.apply(value, current, args); };
      } });
    };
    const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const fenced = fencedCompanionConnection(guarded, operation => operation());
  expect(companionMessageFictionalLineage(fenced, 'root')).toBe(false); blocked = true;
  expect(() => companionMessageFictionalLineage(fenced, 'root')).toThrow('currently unavailable');
  blocked = false; expect(companionMessageFictionalLineage(fenced, 'root')).toBe(false); expect(read).toHaveBeenCalled();
  const missing = connection(':memory:'); expect(() => companionMessageFictionalLineage(missing, 'root')).toThrow();
  missing.exec('CREATE TABLE companion_message_topics(message_id TEXT,topic_id TEXT); CREATE TABLE companion_topics(id TEXT,data TEXT); CREATE TABLE metadata(key TEXT,value TEXT)');
  expect(companionMessageFictionalLineage(missing, 'root')).toBe(false);
});
