import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionActivityTaskStore } from '../../src/companions/activity-task-store';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionWorldStore } from '../../src/companions/world-store';
import type { CompanionSocialStore } from '../../src/companions/social-store';
import { CompanionActivityTaskService } from '../../src/main/companions/activity-task-service';
import { executeCompanionAgendaActivity, reconcileCompanionAgendaActivity, restoreCompanionAgendaActivity } from '../../src/main/companions/agenda-activity';
import type { CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';
import { activityTaskSchema, type CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { CompanionAgendaClaim } from '../../src/shared/companion-agenda';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { boundaryNow, boundaryOccurrence, boundaryRule, boundaryRun } from './companion-agenda-boundary-fixtures';

const databases: DatabaseSync[] = [], services: CompanionActivityTaskService[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(boundaryNow); });
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });
const nativeTask = (id = 'native-activity') => activityTaskSchema.parse({ id, companionId: 'alice', conversationId: 'own-room', title: '去看看实际情况', goal: '等实际结果，再决定下一步。',
  status: 'queued', stage: '等待当前实际条件。', step: 0, attempts: 0, createdAt: boundaryNow, updatedAt: boundaryNow, deadline: '2026-10-29T11:00:00.000Z', nextAt: Date.parse(boundaryNow), history: [] });
function claimFor(task: CompanionActivityTask): CompanionAgendaClaim {
  const rule = { ...boundaryRule(), executor: 'activity' as const, referenceId: task.id, referenceVersion: '0', conversationId: task.conversationId,
    grantId: undefined, goalId: undefined, protected: true, origin: 'system' as const };
  return { rule, occurrence: boundaryOccurrence(), run: boundaryRun(), leaseToken: 'lease' };
}
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db); let depth = 0;
  const connection: CompanionConnection = {
    prepare(sql) { const statement = db.prepare(sql); return { all: (...args) => statement.all(...args as SQLInputValue[]), get: (...args) => statement.get(...args as SQLInputValue[]),
      run: (...args) => { const result = statement.run(...args as SQLInputValue[]); return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }; } }; },
    exec: sql => { db.exec(sql); }, close: () => db.close(), pragma: sql => db.prepare('PRAGMA ' + sql).get(), function: (name, options, fn) => { db.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const action = () => { const level = depth++; db.exec(level ? `SAVEPOINT test_${level}` : 'BEGIN IMMEDIATE'); try { const result = fn(); db.exec(level ? `RELEASE test_${level}` : 'COMMIT'); return result; } catch (error) { db.exec(level ? `ROLLBACK TO test_${level}` : 'ROLLBACK'); if (level) db.exec(`RELEASE test_${level}`); throw error; } finally { depth--; } }; return Object.assign(action, { immediate: action }); },
  };
  db.exec(`CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT NOT NULL,deleted_at TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,kind TEXT,muted INTEGER,private_companion_id TEXT,dissolved_at TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,sequence INTEGER,conversation_id TEXT,author_id TEXT,content TEXT,status TEXT,client_id TEXT UNIQUE);
    CREATE TABLE companion_reset_jobs(companion_id TEXT,status TEXT); CREATE TABLE companion_work_queue(companion_id TEXT,status TEXT,data TEXT);
    CREATE TABLE companion_world_work_records(companion_id TEXT,status TEXT,data TEXT);
    CREATE TABLE companion_social_communication(companion_id TEXT,until_real TEXT,data TEXT); CREATE TABLE companion_social_notifications(companion_id TEXT,status TEXT,lease_until TEXT);
    CREATE TABLE effects(content TEXT);`);
  for (const id of ['alice', 'bob']) db.prepare('INSERT INTO companions VALUES(?,?,NULL)').run(id, JSON.stringify({ active: true }));
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?,NULL)').run('own-room', 'private', 0, 'alice');
  const world = { snapshot: vi.fn(() => ({ backlog: false, actors: [{ companionId: 'alice', routinePhase: 'awake', activity: 'idle' }], works: [], visits: [], scenes: [] })), socialAvailable: vi.fn(() => true) } as unknown as CompanionWorldStore;
  const append = vi.fn(() => { expect(db.isTransaction).toBe(true); return { id: 'published' }; });
  const store = new CompanionActivityTaskStore(connection, world, {} as CompanionSocialStore, () => [], append, vi.fn()); store.initialize();
  const agenda = new CompanionAgendaStore(connection); agenda.initialize();
  const task = nativeTask(), claim = claimFor(task);
  function saveTask(value: CompanionActivityTask & Record<string, unknown>) {
    const stored = { ...value, clientId: 'client-' + value.id, nextAt: value.nextAt ?? Date.parse(boundaryNow) };
    db.prepare('INSERT OR REPLACE INTO companion_activity_tasks(id,companion_id,conversation_id,status,next_at,client_id,report_pending,data) VALUES(?,?,?,?,?,?,?,?)')
      .run(value.id, value.companionId, value.conversationId, value.status, stored.nextAt, stored.clientId, Number(!!value.reportPending), JSON.stringify(stored));
  }
  saveTask(task);
  const rule = claim.rule, run = claim.run, occurrence = claim.occurrence;
  db.prepare('INSERT INTO companion_agenda_rules(id,companion_id,revision,status,data) VALUES(?,?,?,?,?)').run(rule.id, rule.companionId, rule.revision, rule.status, JSON.stringify(rule));
  db.prepare('INSERT INTO companion_agenda_occurrences(id,companion_id,rule_id,scheduled_at,state,rule_data,data) VALUES(?,?,?,?,?,?,?)').run(occurrence.id, occurrence.companionId, rule.id, occurrence.scheduledAt, occurrence.state, JSON.stringify(rule), JSON.stringify(occurrence));
  db.prepare('INSERT INTO companion_agenda_runs(id,companion_id,rule_id,occurrence_id,revision,status,not_before,lease_until,created_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(run.id, run.companionId, rule.id, occurrence.id, run.revision, run.status, run.notBefore, run.leaseUntil!, run.createdAt, JSON.stringify(run));
  const send = (input: CompanionStorageCommand) => store.execute(input)!;
  send({ type: 'activity.agenda.enable' });
  const parent = { companionId: 'alice', id: task.id, agendaRunId: run.id, agendaLeaseToken: claim.leaseToken };
  return { db, connection, store, agenda, task, claim, saveTask, send, parent, append };
}
const context = (): CompanionAgendaExecutionContext => ({ checkpoint: vi.fn(async () => undefined), bindGrant: vi.fn(), effectId: value => value,
  effect: async (_key, _title, operation) => operation('effect') });

it('makes agenda source reads inert and prevents old global activity/report/memory claims', () => {
  const f = fixture(); const before = f.db.prepare('SELECT data FROM companion_activity_tasks').get()!.data;
  expect(f.send({ type: 'activity.agenda.pending', limit: 50 }).activityAgendaPage!.tasks).toHaveLength(1);
  expect(f.send({ type: 'activity.claim', excludedIds: [] }).activityTask).toBeUndefined();
  expect(f.send({ type: 'activity.report.claim', excludedIds: [] }).activityReport).toBeUndefined();
  expect(f.send({ type: 'activity.memory.claim' }).activityMemoryIntent).toBeUndefined();
  expect(f.db.prepare('SELECT data FROM companion_activity_tasks').get()!.data).toBe(before); expect(f.append).not.toHaveBeenCalled();
});
it('claims only the sealed exact native task and lets the already-counted parent own its permit', () => {
  const f = fixture(); f.saveTask(nativeTask('unrelated'));
  const leased = f.send({ type: 'activity.claim', ...f.parent, excludedIds: [] }).activityTask!;
  expect(leased).toMatchObject({ id: f.task.id, agendaRunId: f.claim.run.id, agendaLeaseToken: 'lease', status: 'running' });
  expect(f.send({ type: 'activity.agenda.get', companionId: 'alice', id: 'unrelated' }).activityTask!.status).toBe('queued');
  const publicRead = f.send({ type: 'activity.get', companionId: 'alice', conversationId: 'own-room', id: f.task.id }).activityTask!;
  expect(publicRead.leaseToken).toBeUndefined(); expect(publicRead.agendaLeaseToken).toBeUndefined();
});
it.each(['wrong-owner', 'wrong-task', 'wrong-token', 'paused', 'expired', 'missing-lease'] as const)('fences %s before native claim or late source writes', change => {
  const f = fixture(), parent = { ...f.parent };
  if (change === 'wrong-owner') parent.companionId = 'bob';
  if (change === 'wrong-task') { f.saveTask(nativeTask('unrelated')); parent.id = 'unrelated'; }
  if (change === 'wrong-token') parent.agendaLeaseToken = 'stale-token';
  if (change === 'paused') f.db.prepare("UPDATE companion_agenda_runs SET status='parked'").run();
  if (change === 'expired') f.db.prepare('UPDATE companion_agenda_runs SET lease_until=?').run(boundaryNow);
  if (change === 'missing-lease') f.db.prepare('UPDATE companion_agenda_runs SET lease_until=NULL').run();
  expect(() => f.send({ type: 'activity.claim', ...parent, excludedIds: [] })).toThrow(); expect(f.append).not.toHaveBeenCalled();
});
it('rejects a late native observe/commit after the agenda pauses and preserves the original history', () => {
  const f = fixture(), leased = f.send({ type: 'activity.claim', ...f.parent, excludedIds: [] }).activityTask!;
  f.db.prepare("UPDATE companion_agenda_runs SET status='parked'").run();
  expect(() => f.send({ type: 'activity.observe', id: f.task.id, leaseToken: leased.leaseToken! })).toThrow('日程已停止');
  expect(() => f.send({ type: 'activity.commit', id: f.task.id, leaseToken: leased.leaseToken!, decision: { status: 'blocked', summary: '不能发布的旧判断', action: null, wait: null } })).toThrow('日程已停止');
  expect(f.send({ type: 'activity.agenda.get', companionId: 'alice', id: f.task.id }).activityTask!.history).toEqual([]);
});
function memory(f: ReturnType<typeof fixture>) {
  const operation = { operation: 'organize' as const, ids: ['note'], tags: ['实际资料'] };
  f.saveTask({ ...f.task, memoryIntentId: 'intent' });
  f.db.prepare("INSERT INTO companion_activity_memory_intents(id,task_id,companion_id,conversation_id,status,data) VALUES(?,?,?,?,?,?)")
    .run('intent', f.task.id, 'alice', 'own-room', 'pending', JSON.stringify(operation));
  const intent = f.send({ type: 'activity.memory.claim', taskId: f.task.id, companionId: 'alice', agendaRunId: f.parent.agendaRunId, agendaLeaseToken: 'lease' }).activityMemoryIntent!;
  const command: Extract<CompanionStorageCommand, { type: 'activity.memory.apply' }> = { type: 'activity.memory.apply', id: intent.id, leaseToken: intent.leaseToken,
    agendaRunId: f.parent.agendaRunId, agendaLeaseToken: 'lease', command: { type: 'memory.organize', companionId: 'alice', conversationId: 'own-room',
      ids: operation.ids, tags: operation.tags, operationId: intent.id } };
  return { intent, command };
}
it('does not replay a legacy memory intent even under both valid leases', () => {
  const f = fixture(), { command } = memory(f), effect = vi.fn(() => { expect(f.db.isTransaction).toBe(true); f.db.prepare('INSERT INTO effects VALUES(?)').run('actual'); return { ok: true }; });
  expect(() => f.store.guardMemory(command, effect)).toThrow('已退役'); expect(effect).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT count(*) AS n FROM effects').get()!.n).toBe(0);
});
it.each(['paused-parent', 'stale-native-token', 'changed-payload', 'wrong-inner-owner'] as const)('does not execute a memory write after %s', change => {
  const f = fixture(), { command } = memory(f), effect = vi.fn();
  if (change === 'paused-parent') f.db.prepare("UPDATE companion_agenda_runs SET status='parked'").run();
  if (change === 'stale-native-token') command.leaseToken = 'old-intent-token';
  if (change === 'changed-payload') (command.command as { tags: string[] }).tags = ['另一份提案'];
  if (change === 'wrong-inner-owner') (command.command as { companionId: string }).companionId = 'bob';
  expect(() => f.store.guardMemory(command, effect)).toThrow(); expect(effect).not.toHaveBeenCalled();
});
it('requires the guarded memory envelope and returns its actual native lease to pending on pause', () => {
  const f = fixture(), { command } = memory(f);
  expect(() => f.store.guardMemory(command.command as CompanionStorageCommand, vi.fn())).toThrow('已退役');
  f.db.prepare("UPDATE companion_agenda_runs SET status='parked'").run();
  f.send({ type: 'activity.agenda.release', ...f.parent, action: 'pause' });
  expect(f.db.prepare('SELECT status,lease_token FROM companion_activity_memory_intents WHERE id=?').get('intent')).toMatchObject({ status: 'pending', lease_token: null });
});
it('does not globally flush an unrelated pending report while processing this exact report phase', () => {
  const f = fixture(); f.saveTask({ ...f.task, status: 'failed', reportPending: true });
  f.saveTask({ ...nativeTask('unrelated-report'), status: 'failed', reportPending: true });
  f.send({ type: 'activity.report.claim', ...f.parent, excludedIds: [] });
  expect(f.append).toHaveBeenCalledOnce();
  expect(f.send({ type: 'activity.agenda.get', companionId: 'alice', id: f.task.id }).activityTask!.reportPending).toBe(false);
  expect(f.send({ type: 'activity.agenda.get', companionId: 'alice', id: 'unrelated-report' }).activityTask!.reportPending).toBe(true);
});
it('fences an already-reviewed report before append when the parent pauses', () => {
  const f = fixture(), readset = { schema: 'worldlinebox.companion-execution-readset-v1' as const, companionId: 'alice', conversationId: 'own-room', complete: true,
    sources: [], memories: [], contexts: [], topics: [], knowledgeReads: [] };
  f.saveTask({ ...f.task, status: 'failed', reportPending: true, reportReadset: readset });
  const report = f.send({ type: 'activity.report.claim', ...f.parent, excludedIds: [] }).activityReport!;
  expect(report).toBeTruthy(); f.db.prepare("UPDATE companion_agenda_runs SET status='parked'").run();
  expect(() => f.send({ type: 'activity.report.complete', id: report.id, leaseToken: report.leaseToken, executionReadset: readset })).toThrow('日程已停止');
  expect(f.append).not.toHaveBeenCalled();
});
it('releases a paused native planning lease while conserving its exact attempt/history for parent recovery', async () => {
  const f = fixture(); f.send({ type: 'activity.claim', ...f.parent, excludedIds: [] });
  f.db.prepare("UPDATE companion_agenda_runs SET status='parked'").run();
  f.send({ type: 'activity.agenda.release', ...f.parent, action: 'pause' });
  const task = f.send({ type: 'activity.agenda.get', companionId: 'alice', id: f.task.id }).activityTask!;
  expect(task).toMatchObject({ status: 'queued', agendaRunId: f.claim.run.id, history: [] }); expect(task.leaseToken).toBeUndefined();
  const run = { ...f.claim.run, status: 'parked' as const };
  const request = async (input: CompanionStorageCommand): Promise<CompanionStorageResponse> => input.type === 'agenda.event.read'
    ? { ok: true, agendaEvent: { rule: f.claim.rule, runs: [run], occurrences: [f.claim.occurrence], steps: [] } } : f.send(input);
  expect(await restoreCompanionAgendaActivity(run, { request })).toMatchObject({ canResume: true, task: { id: task.id, agendaRunId: run.id } });
});
it('keeps a deferred proposal for Main revalidation and does not execute it from the worker admission scan', () => {
  const f = fixture(); f.saveTask({ ...f.task, planningMilestoneMs: 4 * 3600000,
    deferredDecision: { step: 0, decision: { status: 'continue', action: { action: 'message', text: '先前提案' }, wait: null, summary: '尚未发送。' }, socialEvidence: [] } });
  const claimed = f.send({ type: 'activity.claim', ...f.parent, excludedIds: [] }).activityTask!;
  expect(claimed.status).toBe('running'); expect(claimed.history).toEqual([]); expect(claimed.deadline).toBeUndefined();
  expect(JSON.parse(f.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(f.task.id)!.data as string).deferredDecision).toBeTruthy();
});
it('reopens a valid failed goal only on explicit parent recovery and keeps its real prior history', () => {
  const f = fixture(), history = [{ step: 1, at: boundaryNow, action: 'observe', result: '上一次受阻', ok: false }];
  f.saveTask({ ...f.task, status: 'failed', step: 1, attempts: 3, history, agendaRunId: f.parent.agendaRunId, agendaLeaseToken: 'lease' });
  f.db.prepare("UPDATE companion_agenda_runs SET status='parked'").run();
  const result = f.send({ type: 'activity.agenda.restore', companionId: 'alice', id: f.task.id, agendaRunId: f.parent.agendaRunId, expectedUpdatedAt: boundaryNow }).activityTask!;
  expect(result).toMatchObject({ status: 'queued', step: 1, attempts: 0, agendaCycle: 1, goal: f.task.goal }); expect(result.history).toHaveLength(1);
});
it('surfaces outbox failures to the agenda failure cycle while preserving their pending payloads', async () => {
  const task = { ...nativeTask(), reportPending: true }, claim = claimFor(task), error = new Error('报告验证暂不可用');
  const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, activityTask: task }));
  const result = await executeCompanionAgendaActivity(claim, context(), new AbortController().signal, { request, run: async () => { throw error; } });
  expect(result).toMatchObject({ outcome: 'failed', error: error.message }); expect(task.reportPending).toBe(true);
});

it('reconciles actual ongoing native goals idempotently and preserves a new explicit attempt as a new rule', async () => {
  const task = nativeTask(), commands: CompanionStorageCommand[] = [];
  const request = vi.fn(async (input: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(input);
    if (input.type === 'activity.agenda.pending') return { ok: true, activityAgendaPage: { tasks: [task], hasMore: false } };
    if (input.type === 'activity.agenda.get') return { ok: true, activityTask: task };
    if (input.type === 'agenda.rule.create') return { ok: true, agendaRule: { ...claimFor(task).rule, ...input.rule } as CompanionAgendaClaim['rule'] };
    throw new Error('Unexpected ' + input.type);
  });
  await reconcileCompanionAgendaActivity({ request }); await reconcileCompanionAgendaActivity({ request });
  const operations = commands.filter((item): item is Extract<CompanionStorageCommand, { type: 'agenda.rule.create' }> => item.type === 'agenda.rule.create');
  expect(operations[0]!.operationId).toBe(operations[1]!.operationId); expect(operations[0]!.rule).toMatchObject({ protected: true, executor: 'activity', referenceId: task.id, referenceVersion: '0' });
  task.agendaAttempt = 1; await reconcileCompanionAgendaActivity({ request });
  expect(commands.filter(item => item.type === 'agenda.rule.create').at(-1)).toMatchObject({ rule: { referenceVersion: '1' }, operationId: expect.not.stringMatching(operations[0]!.operationId) });
});
it('returns native arrival/reply waiting to the agenda instead of retaining its root execution', async () => {
  const task = nativeTask(), claim = claimFor(task), ctx = context();
  const actual = { ...task, status: 'waiting' as const, nextAt: Date.parse(boundaryNow) + 1500, wait: { kind: 'arrival' as const }, stage: '等真正到达后继续。', step: 1 };
  let calls = 0;
  const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, activityTask: calls++ ? actual : task }));
  const run = vi.fn(async () => ({ task: actual, phase: 'planning' as const }));
  const result = await executeCompanionAgendaActivity(claim, ctx, new AbortController().signal, { request, run, now: () => new Date(boundaryNow) });
  expect(result).toMatchObject({ outcome: 'waiting', stage: actual.stage, notBefore: '2026-10-29T10:00:01.500Z', nextCondition: 'activity.arrival' });
  expect(run).toHaveBeenCalledOnce(); expect(ctx.checkpoint).toHaveBeenCalledWith(actual.stage, expect.objectContaining({ nativeStep: 1 }));
});
it('does not resurrect cancelled/failed or source-version-changed native goals during recovery', async () => {
  const task = { ...nativeTask(), status: 'cancelled' as const }, claim = claimFor(task), run = { ...claim.run, status: 'parked' as const };
  const request = vi.fn(async (input: CompanionStorageCommand): Promise<CompanionStorageResponse> => input.type === 'agenda.event.read'
    ? { ok: true, agendaEvent: { rule: claim.rule, runs: [run], occurrences: [claim.occurrence], steps: [] } } : { ok: true, activityTask: task });
  expect(await restoreCompanionAgendaActivity(run, { request })).toMatchObject({ canResume: false });
  expect(request.mock.calls.some(([input]) => input.type === 'activity.agenda.restore')).toBe(false);
});
it('gates the old poller and retires one legacy memory intent without executing or completing the task', async () => {
  let task = { ...nativeTask(), memoryIntentId: 'intent' as string | undefined };
  const calls: CompanionStorageCommand[] = [], parent = { companionId: 'alice', id: task.id, agendaRunId: 'run', agendaLeaseToken: 'lease' };
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    calls.push(command);
    if (command.type === 'activity.agenda.enable') return { ok: true };
    if (command.type === 'activity.agenda.get') return { ok: true, activityTask: task };
    if (command.type === 'activity.memory.claim') return { ok: true, activityMemoryIntent: { id: 'intent', taskId: task.id, companionId: 'alice', conversationId: 'own-room', leaseToken: 'intent-lease', operation: { operation: 'organize', ids: ['note'], tags: ['资料'] } } };
    if (command.type === 'activity.memory.fail') { task = { ...task, step: 1, memoryIntentId: undefined }; return { ok: true, activityTask: task }; }
    throw new Error('Unexpected global/native call ' + command.type);
  });
  const service = new CompanionActivityTaskService({ request, configFor: async () => { throw new Error('No provider'); }, profiles: async () => { throw new Error('No profiles'); }, fetchFn: vi.fn(), excludedIds: () => [], changed: vi.fn(), report: vi.fn() }); services.push(service);
  await service.setAgendaDriven(); const before = calls.length; service.start(); await service.tick(); expect(calls).toHaveLength(before);
  const phase = vi.fn(async () => undefined), result = await service.runAgendaQuantum(parent, new AbortController().signal, phase);
  expect(result).toMatchObject({ phase: 'memory', task: { id: task.id, step: 1 } }); expect(phase).toHaveBeenCalledWith('memory', expect.objectContaining({ id: task.id }));
  const failure = calls.find(item => item.type === 'activity.memory.fail');
  expect(failure).toMatchObject({ id: 'intent', leaseToken: 'intent-lease' });
  expect(failure && 'error' in failure && JSON.parse(failure.error)).toMatchObject({ ok: false, code: 'COMPANION_MEMORY_AUTOMATIC_ONLY' });
  expect(calls.some(item => item.type === 'activity.memory.apply' || item.type === 'activity.memory.complete' || item.type.startsWith('memory.'))).toBe(false);
  expect(result.task.status).not.toBe('succeeded');
  expect(calls.some(item => item.type === 'activity.report.claim' || item.type === 'activity.claim')).toBe(false);
});
