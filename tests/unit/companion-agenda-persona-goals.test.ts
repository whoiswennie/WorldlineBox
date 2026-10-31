import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import type { CompanionConnection } from '../../src/companions/store';
import type { companionAgendaGoalDraftSchema, CompanionAgendaCommand } from '../../src/shared/companion-agenda';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionAgendaPersonaGoalDefinitionHash, readCompanionAgendaPersonaDirections, validateCompanionAgendaPersonaDirections } from '../../src/main/companions/agenda-persona-goals';

const databases: DatabaseSync[] = [];
type CompanionAgendaGoalDraft = z.output<typeof companionAgendaGoalDraftSchema>;
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const sql = new DatabaseSync(':memory:'); databases.push(sql); sql.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT NOT NULL,deleted_at TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO companions VALUES('alice','{\"active\":true}',NULL),('bob','{\"active\":true}',NULL)");
  let depth = 0;
  const db: CompanionConnection = { prepare(query) { const statement = sql.prepare(query); return { all: (...args) => statement.all(...args as SQLInputValue[]), get: (...args) => statement.get(...args as SQLInputValue[]), run: (...args) => { const result = statement.run(...args as SQLInputValue[]); return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }; } }; },
    exec: query => { sql.exec(query); }, close: () => sql.close(), pragma: query => sql.prepare('PRAGMA ' + query).get(), function: (name, options, fn) => { sql.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const run = () => { const id = 'nested_' + ++depth; sql.exec('SAVEPOINT ' + id); try { const result = fn(); sql.exec('RELEASE ' + id); return result; } catch (error) { sql.exec('ROLLBACK TO ' + id); sql.exec('RELEASE ' + id); throw error; } finally { depth--; } }; return Object.assign(run, { immediate: run }); } };
  const store = new CompanionAgendaStore(db); store.initialize(); let operation = 0;
  const send = (command: CompanionAgendaCommand) => store.execute(command)!;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => send(command as CompanionAgendaCommand));
  const base: CompanionAgendaGoalDraft = { title: '说清楚适用条件', intent: '希望逐步练习在建议前说明未知。', domain: 'persona', successCriteria: ['在真实机会中根据自己的判断尝试。'], nextQuestions: [], conversationId: 'private_alice', materials: [], allowWeb: false };
  const create = (patch: Partial<CompanionAgendaGoalDraft> = {}, companionId = 'alice') => send({ type: 'agenda.goal.create', companionId, operationId: 'create_' + ++operation, authority: { kind: 'user' }, goal: { ...base, ...patch } }).agendaGoal!;
  return { sql, send, request, create, base };
}

it('reads current agenda directions only from the exact owner and real source conversation as future proposals', async () => {
  const f = fixture(), selected = f.create(); f.create({ conversationId: 'peer_group' }); f.create({ domain: 'knowledge' }); f.create({}, 'bob'); f.create({ conversationId: undefined });
  const view = await readCompanionAgendaPersonaDirections('alice', 'private_alice', f.request);
  expect(view.directions).toEqual([expect.objectContaining({ id: selected.id, intent: selected.intent, meaning: 'proposed_future_direction_not_established_personality' })]);
  expect(view.readset).toEqual([{ id: selected.id, definitionHash: companionAgendaPersonaGoalDefinitionHash(selected) }]);
  expect(f.request.mock.calls.every(([command]) => command.type === 'agenda.goals.read' && command.companionId === 'alice')).toBe(true);
});

it('does not invalidate a fixed definition for progress alone but fences pause, changed criteria and moved ports', async () => {
  const f = fixture(), goal = f.create(), view = await readCompanionAgendaPersonaDirections('alice', 'private_alice', f.request);
  const progressed = f.send({ type: 'agenda.goal.update', companionId: 'alice', id: goal.id, expectedRevision: goal.revision, operationId: 'progress', authority: { kind: 'user' }, goal: f.base, progress: '记下一次实际尝试。' }).agendaGoal!;
  expect(companionAgendaPersonaGoalDefinitionHash(progressed)).toBe(view.readset[0]!.definitionHash);
  await validateCompanionAgendaPersonaDirections('alice', 'private_alice', view.readset, view.revision, f.request);
  const paused = f.send({ type: 'agenda.goal.control', companionId: 'alice', id: goal.id, expectedRevision: progressed.revision, operationId: 'pause', authority: { kind: 'user' }, action: 'pause' }).agendaGoal!;
  await expect(validateCompanionAgendaPersonaDirections('alice', 'private_alice', view.readset, view.revision, f.request)).rejects.toThrow('暂停');
  const resumed = f.send({ type: 'agenda.goal.control', companionId: 'alice', id: goal.id, expectedRevision: paused.revision, operationId: 'resume', authority: { kind: 'user' }, action: 'resume' }).agendaGoal!;
  await validateCompanionAgendaPersonaDirections('alice', 'private_alice', view.readset, view.revision, f.request);
  const changed = f.send({ type: 'agenda.goal.update', companionId: 'alice', id: goal.id, expectedRevision: resumed.revision, operationId: 'adjust', authority: { kind: 'user' }, goal: { ...f.base, successCriteria: ['可以提出与原方向不同的建议，不强制改变语气。'] } }).agendaGoal!;
  await expect(validateCompanionAgendaPersonaDirections('alice', 'private_alice', view.readset, view.revision, f.request)).rejects.toThrow('调整');
  const latest = await readCompanionAgendaPersonaDirections('alice', 'private_alice', f.request);
  f.send({ type: 'agenda.goal.update', companionId: 'alice', id: goal.id, expectedRevision: changed.revision, operationId: 'move', authority: { kind: 'user' }, goal: { ...f.base, conversationId: 'peer_group' } });
  await expect(validateCompanionAgendaPersonaDirections('alice', 'private_alice', latest.readset, latest.revision, f.request)).rejects.toThrow('来源域');
});

it('reads all owner pages without silently dropping directions after a hundred other goals', async () => {
  const f = fixture(); for (let index = 0; index < 120; index++) f.create({ domain: 'knowledge', title: '实际知识方向' + index });
  const goal = f.create(), view = await readCompanionAgendaPersonaDirections('alice', 'private_alice', f.request);
  expect(view.directions.map(value => value.id)).toEqual([goal.id]); expect(f.request).toHaveBeenCalledTimes(2);
});

it('rejects foreign owner pages and broken cursors instead of treating partial goals as current', async () => {
  const f = fixture(), foreign = f.create({}, 'bob');
  f.request.mockResolvedValue({ ok: true, agendaGoals: [foreign], agendaHasMore: false });
  await expect(readCompanionAgendaPersonaDirections('alice', 'private_alice', f.request)).rejects.toThrow('伙伴归属');
  f.request.mockResolvedValue({ ok: true, agendaGoals: [], agendaHasMore: true });
  await expect(readCompanionAgendaPersonaDirections('alice', 'private_alice', f.request)).rejects.toThrow('分页没有前进');
});
