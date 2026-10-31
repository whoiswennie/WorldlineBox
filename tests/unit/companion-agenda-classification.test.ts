import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import type { CompanionConnection } from '../../src/companions/store';
import { companionAgendaPublicCommandSchema, companionAgendaRuleDraftSchema, type CompanionAgendaCommand, type CompanionAgendaRuleDraft } from '../../src/shared/companion-agenda';
import { executeCompanionAgendaActivity, reconcileCompanionAgendaActivity } from '../../src/main/companions/agenda-activity';
import { activityTaskSchema } from '../../src/shared/companion-activity-task';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';

const databases: DatabaseSync[] = [];
const at = '2026-10-29T10:00:00.000Z';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); });
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const sql = new DatabaseSync(':memory:'); databases.push(sql);
  sql.exec(`CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT NOT NULL,deleted_at TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO companions VALUES('alice','{"active":true}',NULL),('bob','{"active":true}',NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,author_id TEXT,kind TEXT,status TEXT,request_fingerprint TEXT);
    CREATE TABLE conversation_members(conversation_id TEXT,companion_id TEXT);
    INSERT INTO conversation_members VALUES('private_alice','alice'),('private_bob','bob'),('peer_room','alice'),('peer_room','bob');
    INSERT INTO messages VALUES('human_source','private_alice','user','text','sent',NULL),('peer_source','peer_room','bob','text','sent',NULL),('foreign_source','private_bob','user','text','sent',NULL);
    CREATE TABLE companion_work_queue(id TEXT PRIMARY KEY,companion_id TEXT,data TEXT,status TEXT);
    CREATE TABLE companion_activity_tasks(id TEXT PRIMARY KEY,companion_id TEXT,data TEXT,status TEXT);
    CREATE TABLE companion_world_jobs(id TEXT PRIMARY KEY,companion_id TEXT,data TEXT,kind TEXT,status TEXT,lease_until TEXT);
    CREATE TABLE companion_work_orders(id TEXT,companion_id TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE companion_schedules(id TEXT,companion_id TEXT);
    CREATE TABLE companion_schedule_occurrences(id TEXT,schedule_id TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE actions(id TEXT,companion_id TEXT,status TEXT,data TEXT);
    CREATE TABLE companion_social_jobs(id TEXT,companion_id TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE companion_social_notifications(id TEXT,companion_id TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE companion_life_occurrences(id TEXT,companion_id TEXT,status TEXT,lease_until TEXT);
    CREATE TABLE companion_learning_grants(id TEXT,companion_id TEXT,enabled INTEGER,lease_token TEXT,lease_until INTEGER);
    CREATE TABLE companion_learning_goals(id TEXT,companion_id TEXT,state TEXT,lease_token TEXT,lease_until INTEGER);`);
  let depth = 0;
  const db: CompanionConnection = { prepare(query) { const statement = sql.prepare(query); return { all: (...args) => statement.all(...args as SQLInputValue[]), get: (...args) => statement.get(...args as SQLInputValue[]), run: (...args) => { const result = statement.run(...args as SQLInputValue[]); return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }; } }; },
    exec: query => { sql.exec(query); }, close: () => sql.close(), pragma: query => sql.prepare('PRAGMA ' + query).get(), function: (name, options, fn) => { sql.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const run = () => { const id = 'tx_' + ++depth; sql.exec('SAVEPOINT ' + id); try { const result = fn(); sql.exec('RELEASE ' + id); return result; } catch (error) { sql.exec('ROLLBACK TO ' + id); sql.exec('RELEASE ' + id); throw error; } finally { depth--; } }; return Object.assign(run, { immediate: run }); } };
  const store = new CompanionAgendaStore(db); store.initialize(); let operation = 0;
  const send = (command: unknown) => store.execute(command as CompanionAgendaCommand)!;
  const base: CompanionAgendaRuleDraft = { title: '自己的每小时检查', intent: '根据实际情况检查自己的学习计划。', kind: 'self', executor: 'brain', trigger: { kind: 'interval', anchorAt: at, everyMinutes: 60, timeZone: 'UTC' }, reason: '伙伴自主安排' };
  const create = (patch: Partial<CompanionAgendaRuleDraft> = {}, authority = { kind: 'self' }, owner = 'alice') => send({ type: 'agenda.rule.create', companionId: owner, operationId: 'create_' + ++operation, authority, rule: { ...base, ...patch } }).agendaRule!;
  const tick = () => send({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: {} });
  const claim = () => send({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaim;
  return { sql, db, store, send, base, create, tick, claim };
}

it('classifies autonomous system seeds as tasks but denies self-management of actual maintenance even when unprotected', () => {
  const f = fixture(), own = f.create({}, { kind: 'system' });
  expect(own).toMatchObject({ category: 'task', classification: { basis: 'self_task' } });
  expect(f.send({ type: 'agenda.rule.control', companionId: 'alice', id: own.id, expectedRevision: own.revision, operationId: 'pause_self_seed', authority: { kind: 'self' }, action: 'pause' }).agendaRule!.status).toBe('paused');
  const event = f.create({ executor: 'memory', kind: 'self', protected: false, referenceId: 'system_memory_capture_v1' }, { kind: 'system' });
  expect(event).toMatchObject({ category: 'event', classification: { basis: 'system_maintenance' } });
  expect(() => f.send({ type: 'agenda.rule.control', companionId: 'alice', id: event.id, expectedRevision: event.revision, operationId: 'cannot_pause_event', authority: { kind: 'self' }, action: 'pause' })).toThrow('系统处理事件');
  expect(() => f.create({ executor: 'memory' })).toThrow('系统维护职责');
  expect(companionAgendaPublicCommandSchema.safeParse({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'forge_category', rule: { ...f.base, category: 'task' } }).success).toBe(false);
});

it('allows an owner to negotiate, resume and decline a real protected peer task while preserving its immutable definition', () => {
  const f = fixture();
  const task = f.create({ executor: 'brain', kind: 'research', title: '核对伙伴委托的资料', protected: true, flexible: false, conversationId: 'peer_room', referenceId: 'actual_peer_commission' }, { kind: 'system', sourceMessageId: 'peer_source' } as { kind: string });
  expect(task).toMatchObject({ category: 'task', classification: { basis: 'source_task', sourceAuthorId: 'bob' } });
  const paused = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: task.id, expectedRevision: task.revision, operationId: 'negotiate', authority: { kind: 'self' }, action: 'pause', taskResponse: { decision: 'negotiate', message: '我想先确认时间，再继续这项委托。' } }).agendaRule!;
  expect(paused).toMatchObject({ status: 'paused', intent: task.intent, taskResponse: { decision: 'negotiate', by: 'self' } });
  const resumed = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: task.id, expectedRevision: paused.revision, operationId: 'accept', authority: { kind: 'self' }, action: 'resume', taskResponse: { decision: 'accept', message: '确认后愿意继续原委托。' } }).agendaRule!;
  expect(resumed.status).toBe('active');
  const declined = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: task.id, expectedRevision: resumed.revision, operationId: 'decline', authority: { kind: 'self' }, action: 'retire', taskResponse: { decision: 'decline', message: '我不打算继续这项任务，原始约定保留。' } }).agendaRule!;
  expect(declined).toMatchObject({ status: 'retired', intent: task.intent, taskResponse: { decision: 'decline', by: 'self' } });
});

it('keeps daily routines, ordinary conversations and the seed self-review out of the actual task list', () => {
  const f = fixture();
  f.sql.prepare('INSERT INTO companion_work_queue VALUES(?,?,?,?)').run('actual_chat', 'alice', JSON.stringify({ id: 'actual_chat', companionId: 'alice', conversationId: 'private_alice', sourceMessageId: 'human_source' }), 'queued');
  const chat = f.create({ executor: 'chat', kind: 'chat', conversationId: 'private_alice', referenceId: 'actual_chat' }, { kind: 'system', sourceMessageId: 'human_source' } as { kind: string });
  const routine = f.create({ executor: 'routine', clock: 'world', routine: { kind: 'habit', habitKind: 'rest' },
    trigger: { kind: 'window', startMinute: 540, endMinute: 660, timeZone: 'UTC', probability: 1, checkIntervalMinutes: 15 } }, { kind: 'system' });
  const review = f.create({ referenceId: 'system_self_wake_v1' }, { kind: 'system' });
  expect(chat).toMatchObject({ category: 'daily', classification: { basis: 'daily_conversation', sourceAuthorId: 'user' } });
  expect(routine).toMatchObject({ category: 'daily', classification: { basis: 'daily_routine' } });
  expect(review).toMatchObject({ category: 'daily', classification: { basis: 'daily_review' } });
  const deliberate = f.create({ title: '主动研究新的发声方法' });
  const commissioned = f.create({ title: '一分钟后提醒喝水', kind: 'reminder', executor: 'reminder', conversationId: 'private_alice',
    trigger: { kind: 'at', at: new Date(Date.parse(at) + 60000).toISOString(), timeZone: 'UTC' } }, { kind: 'user', sourceMessageId: 'human_source' } as { kind: string });
  const tasks = f.send({ type: 'agenda.tasks.read', companionId: 'alice', limit: 100 }).agendaTasks!;
  expect(tasks.map(item => item.form === 'scheduled' ? item.rule.id : item.form === 'longterm' ? item.goal.id : item.execution.id).sort()).toEqual([deliberate.id, commissioned.id].sort());
  const daily = f.send({ type: 'agenda.read', companionId: 'alice', category: 'daily', limit: 100 }).agenda!;
  expect(daily.rules.map(rule => rule.id).sort()).toEqual([chat.id, routine.id, review.id].sort());
  f.tick();
  const sealed = f.sql.prepare('SELECT id,rule_data,data FROM companion_agenda_occurrences ORDER BY id').all();
  const executions = f.sql.prepare('SELECT id,data FROM companion_agenda_runs ORDER BY id').all();
  for (const rule of [chat, routine, review]) f.sql.prepare('UPDATE companion_agenda_rules SET data=? WHERE id=?')
    .run(JSON.stringify({ ...rule, category: 'task', classification: { basis: 'self_task', reason: '旧版误分类' } }), rule.id);
  f.store.initialize();
  expect(f.sql.prepare('SELECT id,rule_data,data FROM companion_agenda_occurrences ORDER BY id').all()).toEqual(sealed);
  expect(f.sql.prepare('SELECT id,data FROM companion_agenda_runs ORDER BY id').all()).toEqual(executions);
  for (const rule of [chat, routine, review]) {
    const current = JSON.parse(f.sql.prepare('SELECT data FROM companion_agenda_rules WHERE id=?').get(rule.id)!.data as string);
    expect(current).toMatchObject({ id: rule.id, revision: rule.revision, title: rule.title, trigger: rule.trigger, category: 'daily' });
  }
  expect(f.send({ type: 'agenda.tasks.read', companionId: 'alice', limit: 100 }).agendaTasks).toHaveLength(2);
});

it('rejects foreign native tasks, foreign source ports and foreign goals before creating new authority', () => {
  const f = fixture(); f.sql.prepare('INSERT INTO companion_work_queue VALUES(?,?,?,?)').run('bob_work', 'bob', JSON.stringify({ id: 'bob_work', companionId: 'bob', conversationId: 'private_bob', sourceMessageId: 'foreign_source' }), 'queued');
  expect(() => f.create({ executor: 'chat', kind: 'chat', referenceId: 'bob_work', conversationId: 'private_bob' }, { kind: 'system' })).toThrow('不属于当前伙伴');
  expect(() => f.create({ conversationId: 'private_bob' }, { kind: 'self', sourceMessageId: 'foreign_source' } as { kind: string })).toThrow('任务来源');
  const goal = f.send({ type: 'agenda.goal.create', companionId: 'bob', operationId: 'bob_goal', authority: { kind: 'self' }, goal: { title: '另一位伙伴目标', intent: '保留本人资料', domain: 'knowledge', successCriteria: ['实际核验'] } }).agendaGoal!;
  expect(() => f.create({ goalId: goal.id })).toThrow('不属于当前伙伴');
});

it('projects long-term tasks directly from existing goals without duplicating their linked execution rules', () => {
  const f = fixture(), own = f.create();
  const goal = f.send({ type: 'agenda.goal.create', companionId: 'alice', operationId: 'longterm', authority: { kind: 'self' }, goal: { title: '长期学习', intent: '逐步理解已有资料', domain: 'knowledge', successCriteria: ['实际来源可核验'] } }).agendaGoal!;
  f.create({ goalId: goal.id, executor: 'learning', kind: 'learning', referenceId: 'actual_learning' }, { kind: 'system' });
  const items = f.send({ type: 'agenda.tasks.read', companionId: 'alice', limit: 100 }).agendaTasks!;
  expect(items).toHaveLength(2); expect(items).toContainEqual({ form: 'longterm', goal }); expect(items).toContainEqual({ form: 'scheduled', rule: own });
  const paused = f.send({ type: 'agenda.goal.control', companionId: 'alice', id: goal.id, expectedRevision: goal.revision, operationId: 'goal_negotiate', authority: { kind: 'self' }, action: 'pause', taskResponse: { decision: 'negotiate', message: '先讨论下一步材料。' } }).agendaGoal!;
  expect(paused.taskResponse?.decision).toBe('negotiate');
});

it('classifies actual world-initiated and source-free self activities as tasks', () => {
  const f = fixture(); f.sql.prepare('INSERT INTO companion_world_jobs(id,companion_id,data) VALUES(?,?,?)').run('actual_world', 'alice', '{}');
  for (const [id, clientId] of [['world_child', 'world_activity_actual_world'], ['self_child', 'native_brain_action']]) f.sql.prepare('INSERT INTO companion_activity_tasks VALUES(?,?,?,?)')
    .run(id!, 'alice', JSON.stringify({ id, companionId: 'alice', conversationId: 'world_alice', clientId }), 'queued');
  const system = f.create({ executor: 'activity', referenceId: 'world_child', conversationId: 'world_alice' }, { kind: 'system' });
  const own = f.create({ executor: 'activity', referenceId: 'self_child', conversationId: 'world_alice' }, { kind: 'system' });
  expect(system.category).toBe('task'); expect(own.category).toBe('task');
});

it('keeps world polling as an event and its real named activity as a controllable task without rewriting native or sealed history', async () => {
  const f = fixture(); f.sql.prepare('INSERT INTO companion_world_jobs(id,companion_id,data) VALUES(?,?,?)').run('actual_world', 'alice', '{"intent":"维护世界状态"}');
  const task = activityTaskSchema.parse({ id: 'actual_world_activity', companionId: 'alice', conversationId: 'world_alice',
    title: '去图书馆研究海洋声学', goal: '先核对公开资料，再整理鲸类发声的真实研究与未解决问题。', status: 'queued', stage: '正在核对图书馆是否开放。',
    step: 0, attempts: 0, createdAt: at, updatedAt: at, nextAt: Date.parse(at), history: [], clientId: 'world_activity_actual_world' });
  const nativeBody = JSON.stringify({ ...task, clientId: 'world_activity_actual_world' }); f.sql.prepare('INSERT INTO companion_activity_tasks VALUES(?,?,?,?)').run(task.id, 'alice', nativeBody, task.status);
  const polling = f.create({ executor: 'world', kind: 'world', protected: true, referenceId: 'actual_world' }, { kind: 'system' });
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'activity.agenda.get'
    ? { ok: true, activityTask: task } : f.send(command);
  const [created] = await reconcileCompanionAgendaActivity({ request, tasks: [task] });
  expect(created).toMatchObject({ title: task.title, intent: task.goal, category: 'task', protected: true, classification: { basis: 'native_task' },
    referenceId: task.id, referenceVersion: '0', presentation: { title: task.title, intent: task.goal } });
  expect(polling.category).toBe('event');
  f.send({ type: 'agenda.tick', companionId: 'alice', now: at, facts: { active: true } });
  const original = JSON.parse(f.sql.prepare('SELECT data FROM companion_agenda_rules WHERE id=?').get(created!.id)!.data as string);
  const legacy = { ...original, title: '接续一项持续虚拟行动', intent: '旧版通用显示正文', category: 'event', classification: { basis: 'system_maintenance', reason: '旧版派生分类' } };
  f.sql.prepare('UPDATE companion_agenda_rules SET data=? WHERE id=?').run(JSON.stringify(legacy), created!.id);
  f.sql.prepare('UPDATE companion_agenda_occurrences SET rule_data=? WHERE rule_id=?').run(JSON.stringify(legacy), created!.id);
  const sealedBefore = f.sql.prepare('SELECT rule_data FROM companion_agenda_occurrences WHERE rule_id=?').get(created!.id)!.rule_data;
  const runsBefore = f.sql.prepare('SELECT count(*) AS n FROM companion_agenda_runs').get()!.n;
  f.store.initialize();
  const stored = JSON.parse(f.sql.prepare('SELECT data FROM companion_agenda_rules WHERE id=?').get(created!.id)!.data as string);
  expect(stored).toMatchObject({ title: legacy.title, intent: legacy.intent, revision: original.revision, category: 'task', classification: { basis: 'native_task' } });
  expect(stored.presentation).toBeUndefined(); expect(f.sql.prepare('SELECT rule_data FROM companion_agenda_occurrences WHERE rule_id=?').get(created!.id)!.rule_data).toBe(sealedBefore);
  expect(f.sql.prepare('SELECT count(*) AS n FROM companion_agenda_runs').get()!.n).toBe(runsBefore);
  const items = f.send({ type: 'agenda.tasks.read', companionId: 'alice', limit: 100 }).agendaTasks!;
  expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ form: 'scheduled', rule: { id: created!.id, title: legacy.title, presentation: { title: task.title, intent: task.goal } } });
  const view = f.send({ type: 'agenda.read', companionId: 'alice', category: 'task', compactRecurring: true }).agenda!;
  expect(view.rules).toHaveLength(1); expect(view.rules[0]).toMatchObject({ id: created!.id, presentation: { title: task.title, intent: task.goal } });
  expect(view.occurrences).toHaveLength(1); expect(view.occurrences[0]!.ruleId).toBe(created!.id);
  expect(() => f.send({ type: 'agenda.rule.control', companionId: 'alice', id: polling.id, expectedRevision: polling.revision,
    operationId: 'cannot_control_world_poller', authority: { kind: 'self' }, action: 'pause' })).toThrow('系统处理事件');
  expect(() => f.send({ type: 'agenda.rule.update', companionId: 'alice', id: created!.id, expectedRevision: created!.revision,
    operationId: 'cannot_rewrite_native_action', authority: { kind: 'self' }, rule: { ...f.base, title: '改写原目标' } })).toThrow('完整性');
  let current = stored;
  for (const [decision, action] of [['negotiate', 'pause'], ['accept', 'resume'], ['decline', 'retire']] as const) {
    current = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: created!.id, expectedRevision: current.revision,
      operationId: 'world_activity_response_' + decision, authority: { kind: 'self' }, action, taskResponse: { decision, message: '依据实际情况回应这项行动：' + decision } }).agendaRule!;
    expect(current.taskResponse.decision).toBe(decision); expect(current.intent).toBe(legacy.intent);
  }
  expect(current.status).toBe('retired'); expect(f.sql.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(task.id)!.data).toBe(nativeBody);
  expect(f.sql.prepare('SELECT rule_data FROM companion_agenda_occurrences WHERE rule_id=?').get(created!.id)!.rule_data).toBe(sealedBefore);
  expect(companionAgendaRuleDraftSchema.safeParse({ ...f.base, presentation: { title: '伪造显示', intent: '伪造目标' } }).success).toBe(false);
});

it('reuses the exact legacy activity receipt with a read-only real goal projection and reports its concrete native phase', async () => {
  const f = fixture(); let native = activityTaskSchema.parse({ id: 'existing_native', companionId: 'alice', conversationId: 'world_alice',
    title: '继续核对声学论文', goal: '核对公开论文中的采样方法、限制与仍缺少的证据。', status: 'queued', stage: '等资料读取完成。',
    step: 0, attempts: 0, createdAt: at, updatedAt: at, nextAt: Date.parse(at), history: [] });
  f.sql.prepare('INSERT INTO companion_activity_tasks VALUES(?,?,?,?)').run(native.id, 'alice', JSON.stringify(native), native.status);
  let legacyId: string | undefined;
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'activity.agenda.get') return { ok: true, activityTask: structuredClone(native) };
    if (command.type === 'agenda.rule.create' && !legacyId) legacyId = f.send({ ...command, rule: { ...command.rule, title: '接续一项持续虚拟行动', intent: '旧版绑定说明' } }).agendaRule!.id;
    return f.send(command);
  };
  const [rule] = await reconcileCompanionAgendaActivity({ request, tasks: [native] });
  expect(rule).toMatchObject({ id: legacyId, title: '接续一项持续虚拟行动', intent: '旧版绑定说明', presentation: { title: native.title, intent: native.goal } });
  expect((await reconcileCompanionAgendaActivity({ request, tasks: [native] }))[0]!.id).toBe(legacyId);
  expect(f.sql.prepare('SELECT count(*) AS n FROM companion_agenda_rules').get()!.n).toBe(1);
  f.send({ type: 'agenda.tick', companionId: 'alice', now: at, facts: { active: true } }); const claim = f.claim()!;
  const context: CompanionAgendaExecutionContext = { checkpoint: vi.fn(async () => undefined), bindGrant: vi.fn(), effectId: key => key,
    effect: async (_key, _title, operation) => operation('unused') };
  const concreteStage = '正在逐项核对第一篇论文的采样方法。';
  const result = await executeCompanionAgendaActivity(claim, context, new AbortController().signal, { request,
    run: async (_parent, _signal, onPhase) => {
      native = { ...native, status: 'waiting', stage: concreteStage, step: 1, nextAt: Date.parse(at) + 5000 };
      await onPhase?.('planning', native); return { task: native, phase: 'planning' };
    } });
  expect(result).toMatchObject({ outcome: 'waiting', stage: concreteStage });
  expect(context.checkpoint).toHaveBeenCalledWith(concreteStage, expect.objectContaining({ activityTaskId: native.id, phase: 'planning', nativeStep: 1 }));
  const stored = JSON.parse(f.sql.prepare('SELECT data FROM companion_agenda_rules WHERE id=?').get(legacyId!)!.data as string);
  expect(stored.intent).toBe('旧版绑定说明'); expect(stored.presentation).toBeUndefined();
  const changed = { ...native, agendaAttempt: 1 }; f.sql.prepare('UPDATE companion_activity_tasks SET data=? WHERE id=?').run(JSON.stringify(changed), native.id);
  expect(f.send({ type: 'agenda.event.read', companionId: 'alice', id: legacyId! }).agendaEvent!.rule.presentation).toBeUndefined();
});

it('settles a zero chance once and does not re-roll it when probability is edited at the same instant', () => {
  const f = fixture(), task = f.create({ trigger: { kind: 'at', at, repeat: 'once', timeZone: 'UTC', probability: 0 } }); f.tick();
  const original = f.send({ type: 'agenda.event.read', companionId: 'alice', id: task.id }).agendaEvent!.occurrences[0]!;
  expect(original.state).toBe('silent'); expect(f.claim()).toBeUndefined();
  f.send({ type: 'agenda.rule.update', companionId: 'alice', id: task.id, expectedRevision: task.revision, operationId: 'increase_same_chance', authority: { kind: 'self' }, rule: { ...f.base, trigger: { kind: 'at', at, repeat: 'once', timeZone: 'UTC', probability: 1 } } }); f.tick();
  const after = f.send({ type: 'agenda.event.read', companionId: 'alice', id: task.id }).agendaEvent!.occurrences[0]!;
  expect(after.id).toBe(original.id); expect(after.probabilityThreshold).toBe(original.probabilityThreshold); expect(after.state).toBe('silent'); expect(f.claim()).toBeUndefined();
});

it('persists a 60-percent interval draw and gives the next 100-percent occurrence its own stable identity', () => {
  const f = fixture(), task = f.create({ trigger: { kind: 'interval', anchorAt: at, everyMinutes: 60, timeZone: 'UTC', probability: .6 } }); f.tick();
  const first = f.send({ type: 'agenda.event.read', companionId: 'alice', id: task.id }).agendaEvent!.occurrences[0]!;
  expect(first.state).toBe(first.probabilityThreshold! <= -Math.log(.4) ? 'ready' : 'silent');
  f.send({ type: 'agenda.rule.update', companionId: 'alice', id: task.id, expectedRevision: task.revision, operationId: 'future_full_chance', authority: { kind: 'self' }, rule: { ...f.base, trigger: { kind: 'interval', anchorAt: at, everyMinutes: 60, timeZone: 'UTC', probability: 1 } } }); f.tick();
  expect(f.send({ type: 'agenda.event.read', companionId: 'alice', id: task.id }).agendaEvent!.occurrences[0]!.probabilityThreshold).toBe(first.probabilityThreshold);
  vi.setSystemTime(Date.parse(at) + 3600000); f.tick();
  const all = f.send({ type: 'agenda.event.read', companionId: 'alice', id: task.id }).agendaEvent!.occurrences;
  expect(all).toHaveLength(2); expect(all[0]!.id).not.toBe(first.id); expect(all[0]!.state).toBe('ready');
});

it('shows only the latest recurring occurrence in compact time projection while retaining complete history', () => {
  const f = fixture(), task = f.create();
  for (let hour = 0; hour < 8; hour++) { vi.setSystemTime(Date.parse(at) + hour * 3600000); f.tick(); const run = f.claim()!;
    f.send({ type: 'agenda.run.settle', companionId: 'alice', id: run.run.id, leaseToken: run.leaseToken, now: new Date().toISOString(), outcome: 'completed' }); }
  const compact = f.send({ type: 'agenda.read', companionId: 'alice', category: 'task', compactRecurring: true, limit: 50 }).agenda!;
  expect(compact.occurrences).toHaveLength(1); expect(compact.runs).toHaveLength(1); expect(compact.rules[0]!.nextAt).toBe('2026-10-29T18:00:00.000Z');
  expect(f.send({ type: 'agenda.event.read', companionId: 'alice', id: task.id }).agendaEvent!.occurrences).toHaveLength(8);
  expect(companionAgendaRuleDraftSchema.safeParse({ ...f.base, category: 'task' }).success).toBe(false);
});
