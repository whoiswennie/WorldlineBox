import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import { commitCompanionAgendaMessage } from '../../src/companions/agenda-message-guard';
import type { CompanionConnection } from '../../src/companions/store';
import { boundaryGoal, boundaryGrant, boundaryNow, boundaryOccurrence, boundaryRule, boundaryRun } from './companion-agenda-boundary-fixtures';

const databases: DatabaseSync[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(boundaryNow)); });
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  // Real conversation column names, deliberately without a JSON data column.
  db.exec(`CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT NOT NULL,deleted_at TEXT);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('private','group')),title TEXT NOT NULL,
      private_companion_id TEXT UNIQUE REFERENCES companions(id),pinned INTEGER NOT NULL DEFAULT 0,muted INTEGER NOT NULL DEFAULT 0,
      read_sequence INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,hidden_at TEXT,dissolved_at TEXT,
      CHECK((kind='private' AND private_companion_id IS NOT NULL) OR (kind='group' AND private_companion_id IS NULL)));
    CREATE TABLE conversation_members(conversation_id TEXT NOT NULL REFERENCES conversations(id),companion_id TEXT NOT NULL REFERENCES companions(id),PRIMARY KEY(conversation_id,companion_id));
    CREATE TABLE deliveries(content TEXT NOT NULL);`);
  const connection: CompanionConnection = {
    prepare(sql) { const stmt = db.prepare(sql); return { all: (...args) => stmt.all(...args as SQLInputValue[]), get: (...args) => stmt.get(...args as SQLInputValue[]),
      run: (...args) => { const result = stmt.run(...args as SQLInputValue[]); return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }; } }; },
    exec: sql => { db.exec(sql); }, close: () => db.close(), pragma: sql => db.prepare('PRAGMA ' + sql).get(),
    function: (name, options, fn) => { db.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const action = () => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }; return Object.assign(action, { immediate: action }); },
  };
  new CompanionAgendaStore(connection).initialize();
  for (const id of ['alice', 'bob']) db.prepare('INSERT INTO companions(id,data) VALUES(?,?)').run(id, JSON.stringify({ active: true, proactive: true }));
  db.prepare('INSERT INTO conversations(id,kind,title,private_companion_id,updated_at) VALUES(?,?,?,?,?)').run('own-room', 'private', '本人私聊', 'alice', boundaryNow);
  db.prepare('INSERT INTO conversations(id,kind,title,private_companion_id,updated_at) VALUES(?,?,?,?,?)').run('other-room', 'private', '其他私聊', 'bob', boundaryNow);
  db.prepare('INSERT INTO conversations(id,kind,title,updated_at) VALUES(?,?,?,?)').run('group-room', 'group', '群聊', boundaryNow);
  for (const room of ['own-room', 'other-room', 'group-room']) db.prepare('INSERT INTO conversation_members VALUES(?,?)').run(room, 'alice');
  const rule = boundaryRule(), run = boundaryRun(), occurrence = boundaryOccurrence(), grant = boundaryGrant(), goal = boundaryGoal();
  const persist = () => {
    db.prepare('INSERT OR REPLACE INTO companion_agenda_rules(id,companion_id,revision,status,data) VALUES(?,?,?,?,?)').run(rule.id, rule.companionId, rule.revision, rule.status, JSON.stringify(rule));
    db.prepare('INSERT OR REPLACE INTO companion_agenda_runs(id,companion_id,rule_id,occurrence_id,revision,status,not_before,lease_until,created_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(run.id, run.companionId, run.ruleId, run.occurrenceId, run.revision, run.status, run.notBefore, run.leaseUntil!, run.createdAt, JSON.stringify(run));
    db.prepare('INSERT OR REPLACE INTO companion_agenda_occurrences(id,companion_id,rule_id,scheduled_at,state,rule_data,data) VALUES(?,?,?,?,?,?,?)')
      .run(occurrence.id, occurrence.companionId, occurrence.ruleId, occurrence.scheduledAt, occurrence.state, JSON.stringify(rule), JSON.stringify(occurrence));
    db.prepare('INSERT OR REPLACE INTO companion_agenda_grants(id,companion_id,revision,status,data) VALUES(?,?,?,?,?)').run(grant.id, grant.companionId, grant.revision, grant.status, JSON.stringify(grant));
    db.prepare('INSERT OR REPLACE INTO companion_agenda_goals(id,companion_id,revision,status,data) VALUES(?,?,?,?,?)').run(goal.id, goal.companionId, goal.revision, goal.status, JSON.stringify(goal));
  }; persist();
  const input = { companionId: 'alice', runId: run.id, leaseToken: 'lease', unsolicited: true,
    message: { authorId: 'alice', conversationId: 'own-room', content: '真实事件消息' } };
  const append = vi.fn((message: typeof input.message) => { expect(db.isTransaction).toBe(true); db.prepare('INSERT INTO deliveries(content) VALUES(?)').run(message.content); return 'receipt'; });
  return { db, connection, rule, run, grant, goal, persist, input, append, commit: () => commitCompanionAgendaMessage(connection, input, append) };
}

it('commits the authorized append inside the same SQLite writer transaction', () => {
  const f = fixture(); expect(f.commit()).toBe('receipt'); expect(f.append).toHaveBeenCalledOnce();
  expect(f.db.prepare('SELECT content FROM deliveries').get()!.content).toBe('真实事件消息'); expect(f.db.isTransaction).toBe(false);
});
it.each(['run-paused', 'lease-expired', 'lease-stolen', 'rule-paused', 'proactive-off', 'grant-revoked', 'goal-paused', 'wrong-owner', 'wrong-author', 'wrong-room', 'grant-room', 'room-muted', 'room-dissolved', 'membership-removed', 'recovery'] as const)('does not call append after %s changes before commit', change => {
  const f = fixture();
  if (change === 'run-paused') f.run.status = 'waiting';
  if (change === 'lease-expired') f.run.leaseUntil = boundaryNow;
  if (change === 'lease-stolen') f.run.leaseToken = 'other-lease';
  if (change === 'rule-paused') f.rule.status = 'paused';
  if (change === 'proactive-off') f.db.prepare('UPDATE companions SET data=? WHERE id=?').run(JSON.stringify({ active: true, proactive: false }), 'alice');
  if (change === 'grant-revoked') f.grant.status = 'revoked';
  if (change === 'goal-paused') f.goal.status = 'paused';
  if (change === 'wrong-owner') f.input.companionId = 'bob';
  if (change === 'wrong-author') f.input.message.authorId = 'bob';
  if (change === 'wrong-room') f.input.message.conversationId = 'other-room';
  if (change === 'grant-room') f.grant.conversationId = 'other-room';
  if (change === 'room-muted') f.db.prepare('UPDATE conversations SET muted=1 WHERE id=?').run('own-room');
  if (change === 'room-dissolved') f.db.prepare('UPDATE conversations SET dissolved_at=? WHERE id=?').run(boundaryNow, 'own-room');
  if (change === 'membership-removed') f.db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run('own-room', 'alice');
  if (change === 'recovery') f.db.prepare('INSERT INTO metadata VALUES(?,?)').run('recovery-review-required/alice', 'true');
  f.persist(); expect(f.commit).toThrow('AGENDA_WAITING'); expect(f.append).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n).toBe(0); expect(f.db.isTransaction).toBe(false);
});
it('delivers a fixed user reminder even when unsolicited proactive contact is disabled', () => {
  const f = fixture(); f.rule.flexible = false; f.persist(); f.input.unsolicited = false;
  f.db.prepare('UPDATE companions SET data=? WHERE id=?').run(JSON.stringify({ active: true, proactive: false }), 'alice');
  expect(f.commit()).toBe('receipt'); expect(f.append).toHaveBeenCalledOnce();
});
it('uses the sealed occurrence endpoint even if the current rule changed', () => {
  const f = fixture(); const current = { ...f.rule, conversationId: 'other-room', revision: 2 };
  f.db.prepare('UPDATE companion_agenda_rules SET data=? WHERE id=?').run(JSON.stringify(current), f.rule.id);
  f.input.message.conversationId = 'other-room'; expect(f.commit).toThrow('另一个会话'); expect(f.append).not.toHaveBeenCalled();
});
it('cannot use absent endpoints or an accidental membership to reach another private/group room', () => {
  const f = fixture(); f.rule.conversationId = undefined; f.grant.conversationId = undefined; f.persist();
  f.input.unsolicited = false;
  for (const room of ['other-room', 'group-room']) { f.input.message.conversationId = room; expect(f.commit).toThrow('AGENDA_WAITING'); }
  expect(f.append).not.toHaveBeenCalled(); f.input.message.conversationId = 'own-room'; expect(f.commit()).toBe('receipt');
});
it('rolls back the append if persistence fails and does not fake a receipt', () => {
  const f = fixture(); const append = vi.fn((message: typeof f.input.message) => { f.append(message); throw new Error('write failed'); });
  expect(() => commitCompanionAgendaMessage(f.connection, f.input, append)).toThrow('write failed');
  expect(f.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n).toBe(0); expect(f.db.isTransaction).toBe(false);
});
