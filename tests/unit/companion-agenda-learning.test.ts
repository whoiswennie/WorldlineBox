import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import { CompanionLearningGoalStore } from '../../src/companions/learning-goal-store';
import { CompanionLearningGoalService } from '../../src/main/companions/learning-goal-service';
import { executeAgendaLearning } from '../../src/main/companions/agenda-learning';
import type { CompanionAgendaCommand } from '../../src/shared/companion-agenda';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';

const now = '2026-10-29T10:00:00.000Z';
const databases: DatabaseSync[] = [], services: CompanionLearningGoalService[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  db.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT,deleted_at TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE companion_reset_jobs(companion_id TEXT,status TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,author_id TEXT,status TEXT,content TEXT);");
  for (const id of ['alice', 'bob']) db.prepare('INSERT INTO companions(id,data) VALUES(?,?)').run(id, JSON.stringify({ active: true }));
  let depth = 0;
  const connection: CompanionConnection = {
    prepare(sql) { const stmt = db.prepare(sql); return { all: (...args) => stmt.all(...args as SQLInputValue[]), get: (...args) => stmt.get(...args as SQLInputValue[]), run: (...args) => { const r = stmt.run(...args as SQLInputValue[]); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; } }; },
    exec: sql => { db.exec(sql); }, close: () => db.close(), pragma: sql => db.prepare('PRAGMA ' + sql).get(), function: (name, options, fn) => { db.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const action = () => { const key = 't' + ++depth; db.exec('SAVEPOINT ' + key); try { const result = fn(); db.exec('RELEASE ' + key); return result; } catch (error) { db.exec('ROLLBACK TO ' + key); db.exec('RELEASE ' + key); throw error; } finally { depth--; } }; return Object.assign(action, { immediate: action }); },
  };
  const agenda = new CompanionAgendaStore(connection); agenda.initialize();
  const record = vi.fn(() => { throw new Error('This test must not fabricate a material source'); });
  const learning = new CompanionLearningGoalStore(connection, record, () => { throw new Error('No fake integration'); }, () => true); learning.initialize();
  const request = vi.fn(async (input: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    const result = input.type.startsWith('agenda.') ? agenda.execute(input as CompanionAgendaCommand) : learning.execute(input);
    if (!result) throw new Error('Unexpected request ' + input.type); return result;
  });
  const infer = vi.fn(async () => { throw new Error('No model should be called without material'); });
  const service = new CompanionLearningGoalService({ request, infer, read: async () => ({ reads: [], issues: [] }), integrate: async () => ({ memoryIds: [] }),
    recall: async () => { throw new Error('No recall without actual material'); }, validateRecall: async () => false, changed: vi.fn(), report: vi.fn() }); services.push(service);
  const createGoal = (owner = 'alice') => learning.execute({ type: 'learning.goals.create', companionId: owner, text: '真实学习音频分析', materials: [], allowWeb: false,
    schedule: { intervalMinutes: 60, windows: [], timeZone: 'UTC' } })!.learningGoal!;
  const createParent = (goalId: string, owner = 'alice') => {
    agenda.execute({ type: 'agenda.rule.create', companionId: owner, operationId: 'parent-' + owner + '-' + goalId, authority: { kind: 'system' }, rule: { title: '本次音频分析', intent: '接着真实材料继续学习', kind: 'learning', executor: 'learning',
      trigger: { kind: 'at', at: now, timeZone: 'UTC', repeat: 'once' }, referenceId: goalId, reason: '按统一日程安排', conditions: [], flexible: true, protected: false, overlapPolicy: 'wait', resourceKeys: [] } });
    agenda.execute({ type: 'agenda.tick', companionId: owner, now, facts: {} });
    return agenda.execute({ type: 'agenda.claim', companionId: owner, now, leaseMs: 30000, limit: 1, excludedOwners: [] })!.agendaClaim!;
  };
  return { db, agenda, learning, request, infer, service, createGoal, createParent, record };
}

it('claims only the exact goal of a live owner agenda and ignores the retired domain timer', async () => {
  const f = fixture(), first = f.createGoal(), other = f.createGoal();
  f.db.prepare('UPDATE companion_learning_goals SET next_at=? WHERE id=?').run(Date.parse(now) + 86400000, first.id);
  const parent = f.createParent(first.id);
  const result = f.learning.execute({ type: 'learning.goals.claim', id: first.id, companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 })!.learningGoalJob!;
  expect(result.goal.id).toBe(first.id); expect(result.round.goalId).toBe(first.id);
  expect(f.db.prepare('SELECT lease_token FROM companion_learning_goals WHERE id=?').get(other.id)!.lease_token).toBeNull();
  expect(() => f.learning.execute({ type: 'learning.goals.claim', id: other.id, companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 })).toThrow('父执行');
  expect(() => f.learning.execute({ type: 'learning.goals.claim', id: first.id, companionId: 'bob', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 })).toThrow('父执行');
});

it('processes a selected real round with absent materials as waiting, preserving receipts and not calling a model', async () => {
  const f = fixture(), goal = f.createGoal(), parent = f.createParent(goal.id);
  const result = await f.service.processGoal(goal.id, new AbortController().signal, { companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken });
  expect(result.status).toBe('waiting'); expect(result.round?.status).toBe('deferred'); expect(result.round?.goalId).toBe(goal.id);
  expect(f.infer).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT lease_token FROM companion_learning_goals WHERE id=?').get(goal.id)!.lease_token).toBeNull();
  const before = f.request.mock.calls.length; await f.service.tick(); expect(f.request.mock.calls.length).toBe(before);
});

it('does not reinterpret a prior completed round as a newly acquired round when domain capacity is unavailable', async () => {
  const f = fixture(), goal = f.createGoal(), parent = f.createParent(goal.id);
  const round = { id: 'prior-completed', goalId: goal.id, companionId: 'alice', ordinal: 1, startedAt: now, updatedAt: now, endedAt: now,
    status: 'completed', phase: 'reflecting', reads: [], claims: [], memoryIds: [], gaps: [], nextPlan: [] };
  f.db.prepare('INSERT INTO companion_learning_goal_rounds(id,goal_id,companion_id,ordinal,data,status,input_version) VALUES(?,?,?,?,?,?,?)')
    .run(round.id, goal.id, 'alice', 1, JSON.stringify(round), 'completed', 'old-input');
  f.db.prepare('UPDATE companion_learning_goals SET round_id=?,rounds=1 WHERE id=?').run(round.id, goal.id);
  // Two genuinely leased domain rows establish backpressure, without a model.
  f.db.prepare('UPDATE companion_learning_goals SET lease_until=? WHERE id=?').run(Date.parse(now) + 120000, goal.id);
  const other = f.createGoal(); f.db.prepare('UPDATE companion_learning_goals SET lease_until=? WHERE id=?').run(Date.parse(now) + 120000, other.id);
  const result = await f.service.processGoal(goal.id, new AbortController().signal, { companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken });
  expect(result.status).toBe('waiting'); expect(result.round).toBeUndefined(); expect(f.infer).not.toHaveBeenCalled();
});

it('uses a stable learning creation receipt for crash recovery and rejects changing its payload', () => {
  const f = fixture();
  const input = { type: 'learning.goals.create' as const, companionId: 'alice', clientId: 'agenda-goal-one', text: '真实学习音频分析', materials: [], allowWeb: false, schedule: { intervalMinutes: 60, windows: [], timeZone: 'UTC' } };
  const first = f.learning.execute(input)!.learningGoal!, repeated = f.learning.execute(input)!.learningGoal!;
  expect(repeated.id).toBe(first.id); expect(f.db.prepare('SELECT count(*) AS n FROM companion_learning_goals').get()!.n).toBe(1);
  expect(() => f.learning.execute({ ...input, text: '不同目标不得重用创建回执' })).toThrow('其他内容');
});

it('binds an agenda execution to the domain receipt and reports material waiting without a success effect', async () => {
  const f = fixture(), goal = f.createGoal(), parent = f.createParent(goal.id);
  const context: CompanionAgendaExecutionContext = { checkpoint: vi.fn(async () => undefined), effect: vi.fn(async (_key, _title, operation) => operation('effect')),
    effectId: () => 'effect', bindGrant: vi.fn() };
  const result = await executeAgendaLearning(parent, context, new AbortController().signal, { learningGoals: f.service });
  expect(result.outcome).toBe('waiting'); expect(JSON.parse(result.result!).roundId).toBeTruthy();
  expect(context.checkpoint).toHaveBeenCalledTimes(2); expect(context.effect).not.toHaveBeenCalled(); expect(f.infer).not.toHaveBeenCalled();
});
