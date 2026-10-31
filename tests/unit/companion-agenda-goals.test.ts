import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import { CompanionLearningGoalStore } from '../../src/companions/learning-goal-store';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionLearningGoalService } from '../../src/main/companions/learning-goal-service';
import { ensureAgendaLearningGoal, type CompanionAgendaGoalBridgeOptions } from '../../src/main/companions/agenda-goals';
import { companionAgendaGoalDraftSchema, companionAgendaRuleDraftSchema, type CompanionAgendaCommand, type CompanionAgendaGoal, type CompanionAgendaRule } from '../../src/shared/companion-agenda';
import type { CompanionLearningGrant } from '../../src/shared/companion-learning';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const stamp = '2026-10-29T10:00:00.000Z', databases: DatabaseSync[] = [], services: CompanionLearningGoalService[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(stamp); });
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const database of databases.splice(0)) database.close(); vi.useRealTimers(); });
function fixture() {
  const database = new DatabaseSync(':memory:'); databases.push(database);
  database.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT,deleted_at TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE companion_reset_jobs(companion_id TEXT,status TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,author_id TEXT,status TEXT,content TEXT);");
  for (const id of ['alice', 'bob']) database.prepare('INSERT INTO companions(id,data) VALUES(?,?)').run(id, JSON.stringify({ active: true }));
  let depth = 0;
  const db: CompanionConnection = {
    prepare(sql) { const s = database.prepare(sql); return { all: (...args) => s.all(...args as SQLInputValue[]), get: (...args) => s.get(...args as SQLInputValue[]), run: (...args) => { const r = s.run(...args as SQLInputValue[]); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; } }; },
    exec: sql => { database.exec(sql); }, close: () => database.close(), pragma: sql => database.prepare('PRAGMA ' + sql).get(), function: (name, options, fn) => { database.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const run = () => { const key = 't' + ++depth; database.exec('SAVEPOINT ' + key); try { const value = fn(); database.exec('RELEASE ' + key); return value; } catch (error) { database.exec('ROLLBACK TO ' + key); database.exec('RELEASE ' + key); throw error; } finally { depth--; } }; return Object.assign(run, { immediate: run }); },
  };
  const agenda = new CompanionAgendaStore(db); agenda.initialize();
  const learning = new CompanionLearningGoalStore(db, () => { throw new Error('No synthetic material record'); }, () => { throw new Error('No model integration in bridge'); }, () => true); learning.initialize();
  let failLinkOnce = false;
  const sources: CompanionLearningGrant[] = [];
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'agenda.rule.create' && failLinkOnce) { failLinkOnce = false; throw new Error('injected crash before rule linkage'); }
    if (command.type === 'learning.status') return { ok: true, learning: { grants: sources, reads: [] } };
    const result = command.type.startsWith('agenda.') ? agenda.execute(command as CompanionAgendaCommand) : learning.execute(command);
    if (!result) throw new Error('Unexpected request: ' + command.type); return result;
  });
  const infer = vi.fn(async () => { throw new Error('Bridge cannot invoke a model'); });
  const service = new CompanionLearningGoalService({ request, infer, read: async () => ({ reads: [], issues: [] }), integrate: async () => ({ memoryIds: [] }),
    recall: async () => { throw new Error('No recall during linkage'); }, validateRecall: async () => false, changed: vi.fn(), report: vi.fn() }); services.push(service);
  const options: CompanionAgendaGoalBridgeOptions = { request, learningGoalsService: service };
  let operation = 0;
  const create = (patch: Record<string, unknown> = {}) => agenda.execute({ type: 'agenda.goal.create', companionId: 'alice', operationId: 'goal-' + ++operation, authority: { kind: 'user' },
    goal: { title: '理解混音', intent: '依据获准材料解释听到的现象', domain: 'knowledge', successCriteria: ['每次解释保留真实出处'], nextQuestions: ['为何折叠会减弱'], materials: [], allowWeb: false, ...patch } } as CompanionAgendaCommand)!.agendaGoal!;
  const revise = (goal: CompanionAgendaGoal, patch: Record<string, unknown>) => agenda.execute({ type: 'agenda.goal.update', companionId: 'alice', id: goal.id, expectedRevision: goal.revision,
    operationId: 'revise-' + ++operation, authority: { kind: 'user' }, goal: { ...companionAgendaGoalDraftSchema.parse(Object.fromEntries(Object.keys(companionAgendaGoalDraftSchema.shape).map(key => [key, goal[key as keyof typeof goal]]))), ...patch } } as CompanionAgendaCommand)!.agendaGoal!;
  const grant = (goal: CompanionAgendaGoal, allowPublicWeb = false) => {
    const result = agenda.execute({ type: 'agenda.grant.configure', companionId: 'alice', operationId: 'grant-' + ++operation, authority: { kind: 'user' }, grant: { title: '持续学习范围', capabilities: ['learning'], goalId: goal.id,
      allowPublicWeb, fileRoots: [], outputRoots: [], windowIds: [], captureSources: [] } })!.agendaGrant!;
    return { goal: revise(goal, { grantId: result.id }), authority: { kind: 'self' as const, grantId: result.id } };
  };
  return { database, agenda, learning, request, sources, infer, options, create, revise, grant, service, failNextLink: () => { failLinkOnce = true; } };
}

it('links one real learning goal to one persistent agenda rule without starting semantic work', async () => {
  const f = fixture(), goal = f.create(), first = await ensureAgendaLearningGoal(goal, { kind: 'user' }, f.options);
  if (!first.handled) throw new Error(first.reason);
  expect(first.rule.referenceId).toBe(first.learningGoalId); expect(first.rule.goalId).toBe(goal.id);
  expect(first.rule.trigger).toMatchObject({ kind: 'interval', anchorAt: '2026-10-29T11:00:00.000Z', everyMinutes: 60 });
  expect(first.learningGoal.text).toContain(goal.intent); expect(first.learningGoal.text).toContain(goal.successCriteria[0]);
  const repeated = await ensureAgendaLearningGoal(goal, { kind: 'user' }, f.options);
  expect(repeated.handled && repeated.learningGoalId).toBe(first.learningGoalId);
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_learning_goals').get()!.n).toBe(1);
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_agenda_rules').get()!.n).toBe(1);
  expect(f.infer).not.toHaveBeenCalled();
  const reads = f.request.mock.calls.length; await f.service.tick(); expect(f.request.mock.calls.length).toBe(reads);
});

it('recovers creation after a lost linkage with a newer generic revision and no duplicate targets', async () => {
  const f = fixture(), original = f.create(); f.failNextLink();
  await expect(ensureAgendaLearningGoal(original, { kind: 'user' }, f.options)).rejects.toThrow('injected crash');
  const changed = f.revise(original, { intent: '按新要求核实相位与响度，保留原始数据' });
  const recovered = await ensureAgendaLearningGoal(changed, { kind: 'user' }, f.options);
  expect(recovered.handled && recovered.learningGoal.text).toContain(changed.intent);
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_learning_goals').get()!.n).toBe(1);
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_agenda_rules').get()!.n).toBe(1);
});

it('retains an existing user-edited rhythm and follows rule pages beyond the first hundred', async () => {
  const f = fixture(), goal = f.create(), first = await ensureAgendaLearningGoal(goal, { kind: 'user' }, f.options);
  if (!first.handled) throw new Error(first.reason);
  const draft = companionAgendaRuleDraftSchema.parse(Object.fromEntries(Object.keys(companionAgendaRuleDraftSchema.shape).map(key => [key, first.rule[key as keyof CompanionAgendaRule]])));
  const edited = f.agenda.execute({ type: 'agenda.rule.update', companionId: 'alice', id: first.rule.id, expectedRevision: 1, operationId: 'custom-time', authority: { kind: 'user' },
    rule: { ...draft, trigger: { kind: 'interval', anchorAt: '2026-10-29T16:00:00.000Z', everyMinutes: 240, timeZone: 'Asia/Shanghai' } } })!.agendaRule!;
  f.database.prepare('UPDATE companion_agenda_rules SET id=?,data=? WHERE id=?').run('zz-linked-rule', JSON.stringify({ ...edited, id: 'zz-linked-rule' }), edited.id);
  for (let i = 0; i < 101; i++) f.agenda.execute({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'other-' + i, authority: { kind: 'system' }, rule: { ...draft, title: '另一项安排', goalId: undefined, referenceId: undefined, executor: 'brain' } });
  const changed = f.revise(goal, { nextQuestions: ['下一次先核对相关性'] });
  const linked = await ensureAgendaLearningGoal(changed, { kind: 'user' }, f.options);
  expect(linked.handled && linked.rule.id).toBe('zz-linked-rule');
  expect(linked.handled && linked.rule.trigger).toEqual(edited.trigger);
  expect(linked.handled && linked.learningGoal.text).toContain('下一次先核对相关性');
  expect(f.request.mock.calls.some(([command]) => command.type === 'agenda.read' && !!command.afterId)).toBe(true);
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_learning_goals').get()!.n).toBe(1);
});

it('rejects foreign, revoked and non-autonomous library scopes before writing domain state', async () => {
  const f = fixture(), goal = f.create({ materials: [{ kind: 'library', grantId: 'source' }] });
  f.sources.push({ id: 'source', companionId: 'bob', libraryId: 'lib', libraryName: 'Other scope', libraryPath: 'C:/other', enabled: true, autonomous: true,
    intervalMinutes: 30, revision: 1, createdAt: stamp, updatedAt: stamp, status: 'idle', reads: 0 });
  await expect(ensureAgendaLearningGoal(goal, { kind: 'user' }, f.options)).rejects.toThrow('范围');
  f.sources[0]!.companionId = 'alice'; f.sources[0]!.enabled = false;
  await expect(ensureAgendaLearningGoal(goal, { kind: 'user' }, f.options)).rejects.toThrow('范围');
  f.sources[0]!.enabled = true; f.sources[0]!.autonomous = false;
  const scoped = f.grant(goal);
  await expect(ensureAgendaLearningGoal(scoped.goal, scoped.authority, f.options)).rejects.toThrow('自主');
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_learning_goals').get()!.n).toBe(0);
});

it('does not treat an arbitrary file attachment ID or a direct web material as autonomous permission', async () => {
  const f = fixture(), file = f.create({ materials: [{ kind: 'file', attachmentId: 'global-file' }] });
  await expect(ensureAgendaLearningGoal(file, { kind: 'user' }, f.options)).rejects.toThrow('附件');
  const validate = vi.fn<NonNullable<CompanionAgendaGoalBridgeOptions['validateMaterials']>>(async () => { throw new Error('attachment belongs to a different source'); });
  await expect(ensureAgendaLearningGoal(file, { kind: 'user' }, { ...f.options, validateMaterials: validate })).rejects.toThrow('different source');
  expect(validate.mock.calls[0]![0]).toMatchObject({ companionId: 'alice', goalId: file.id });
  const web = f.grant(f.create({ allowWeb: false, materials: [{ kind: 'web', url: 'https://example.test/read' }] }));
  await expect(ensureAgendaLearningGoal(web.goal, web.authority, f.options)).rejects.toThrow('网络范围');
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_learning_goals').get()!.n).toBe(0);
});

it('keeps persona and ended directions outside the knowledge processor and does not truncate requirements', async () => {
  const f = fixture(), persona = f.create({ domain: 'persona' });
  expect((await ensureAgendaLearningGoal(persona, { kind: 'user' }, f.options)).handled).toBe(false);
  const huge = f.create({ intent: '字'.repeat(11900), successCriteria: ['必须保留'.repeat(100)] });
  await expect(ensureAgendaLearningGoal(huge, { kind: 'user' }, f.options)).rejects.toThrow('没有截断');
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_learning_goals').get()!.n).toBe(0);
});

it('rejects a stale generic revision and guards the domain write atomically if the source changes after validation', async () => {
  const f = fixture(), old = f.create(), current = f.revise(old, { intent: '新的明确要求' });
  await expect(ensureAgendaLearningGoal(old, { kind: 'user' }, f.options)).rejects.toThrow('AGENDA_CONFLICT');
  let changed = false;
  const request = async (command: CompanionStorageCommand) => {
    if (command.type === 'learning.goals.update' && !changed) { changed = true; f.revise(current, { intent: '刚刚再次修正' }); }
    return f.options.request(command);
  };
  await expect(ensureAgendaLearningGoal(current, { kind: 'user' }, { ...f.options, request })).rejects.toThrow('AGENDA_CONFLICT');
  const row = f.database.prepare('SELECT data FROM companion_learning_goals').get()!;
  expect(JSON.parse(String(row.data)).text).toBe('统一长期方向 ' + old.id);
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_agenda_rules').get()!.n).toBe(0);
});

it('blocks an outdated learning definition between generic commit and bridge, then admits its exact updated definition', async () => {
  const f = fixture(), initial = f.create(), linked = await ensureAgendaLearningGoal(initial, { kind: 'user' }, f.options);
  if (!linked.handled) throw new Error(linked.reason);
  const changed = f.revise(initial, { intent: '新方向要求先核对峰值与响度' });
  vi.setSystemTime('2026-10-29T11:00:00.000Z');
  f.agenda.execute({ type: 'agenda.tick', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', facts: { active: true, 'model.available': true } });
  const parent = f.agenda.execute({ type: 'agenda.claim', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', leaseMs: 30000, limit: 1, excludedOwners: [] })!.agendaClaim!;
  const command = { type: 'learning.goals.claim' as const, id: linked.learningGoalId, companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 };
  expect(f.learning.execute(command)!.learningGoalJob).toBeUndefined();
  expect(() => f.learning.execute({ type: 'learning.goals.bind', companionId: 'alice', id: linked.learningGoalId, expectedRevision: linked.learningGoal.revision, sourceAgendaGoal: { id: changed.id, revision: changed.revision } })).toThrow('完整对应');
  await ensureAgendaLearningGoal(changed, { kind: 'user' }, f.options);
  const actual = f.learning.execute(command)!.learningGoalJob!;
  expect(actual.goal.text).toContain(changed.intent); expect(actual.goal.id).toBe(linked.learningGoalId);
});

it('keeps an unchanged live learning round valid across a progress-only generic revision and no-op binding', async () => {
  const f = fixture(), initial = f.create(), linked = await ensureAgendaLearningGoal(initial, { kind: 'user' }, f.options);
  if (!linked.handled) throw new Error(linked.reason);
  vi.setSystemTime('2026-10-29T11:00:00.000Z');
  f.agenda.execute({ type: 'agenda.tick', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', facts: { active: true, 'model.available': true } });
  const parent = f.agenda.execute({ type: 'agenda.claim', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', leaseMs: 30000, limit: 1, excludedOwners: [] })!.agendaClaim!;
  const current = f.revise(initial, {});
  const actual = f.learning.execute({ type: 'learning.goals.claim', id: linked.learningGoalId, companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 })!.learningGoalJob!;
  expect(actual).toBeDefined();
  await ensureAgendaLearningGoal(current, { kind: 'user' }, f.options);
  const row = f.database.prepare('SELECT lease_token,round_id,revision FROM companion_learning_goals WHERE id=?').get(linked.learningGoalId)!;
  expect(row.lease_token).toBe(actual.leaseToken); expect(row.round_id).toBe(actual.round.id); expect(row.revision).toBe(actual.goal.revision);
});

it('fences every old learning stage when its generic direction changes, preserving cleanup and raw round', async () => {
  const f = fixture(), initial = f.create(), linked = await ensureAgendaLearningGoal(initial, { kind: 'user' }, f.options);
  if (!linked.handled) throw new Error(linked.reason);
  vi.setSystemTime('2026-10-29T11:00:00.000Z');
  f.agenda.execute({ type: 'agenda.tick', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', facts: { active: true, 'model.available': true } });
  const parent = f.agenda.execute({ type: 'agenda.claim', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', leaseMs: 30000, limit: 1, excludedOwners: [] })!.agendaClaim!;
  const actual = f.learning.execute({ type: 'learning.goals.claim', id: linked.learningGoalId, companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 })!.learningGoalJob!;
  f.revise(initial, { intent: '刚刚修订，旧定义不应继续阅读或生成' });
  expect(() => f.learning.execute({ type: 'learning.goals.heartbeat', id: actual.goal.id, leaseToken: actual.leaseToken, phase: 'reading', leaseMs: 120000 })).toThrow('旧学习阶段停止');
  expect(() => f.learning.execute({ type: 'learning.goals.checkpoint', id: actual.goal.id, leaseToken: actual.leaseToken, round: { ...actual.round, phase: 'reading' } })).toThrow('旧学习阶段停止');
  f.learning.execute({ type: 'learning.goals.finish', id: actual.goal.id, leaseToken: actual.leaseToken,
    round: { ...actual.round, status: 'stale', error: '输入已修订' }, failureKind: 'stale' });
  expect(f.database.prepare('SELECT lease_token FROM companion_learning_goals WHERE id=?').get(actual.goal.id)!.lease_token).toBeNull();
  expect(f.database.prepare('SELECT count(*) AS n FROM companion_learning_goal_rounds WHERE id=?').get(actual.round.id)!.n).toBe(1);
});

it('pauses and resumes current goal-derived runs without reviving failed parked work', async () => {
  const f = fixture(), initial = f.create(), linked = await ensureAgendaLearningGoal(initial, { kind: 'user' }, f.options);
  if (!linked.handled) throw new Error(linked.reason);
  vi.setSystemTime('2026-10-29T11:00:00.000Z');
  f.agenda.execute({ type: 'agenda.tick', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', facts: { active: true, 'model.available': true } });
  const parent = f.agenda.execute({ type: 'agenda.claim', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', leaseMs: 30000, limit: 1, excludedOwners: [] })!.agendaClaim!;
  const actual = f.learning.execute({ type: 'learning.goals.claim', id: linked.learningGoalId, companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 })!.learningGoalJob!;
  const paused = f.agenda.execute({ type: 'agenda.goal.control', companionId: 'alice', id: initial.id, expectedRevision: 1, operationId: 'pause-live-goal', authority: { kind: 'user' }, action: 'pause' })!.agendaGoal!;
  const held = f.agenda.execute({ type: 'agenda.run.read', companionId: 'alice', id: parent.run.id })!.agendaRun!;
  expect(held.status).toBe('parked'); expect(held.leaseToken).toBeUndefined();
  expect(() => f.learning.execute({ type: 'learning.goals.heartbeat', id: actual.goal.id, leaseToken: actual.leaseToken, phase: 'reading', leaseMs: 120000 })).toThrow('旧学习阶段停止');
  const resumedGoal = f.agenda.execute({ type: 'agenda.goal.control', companionId: 'alice', id: initial.id, expectedRevision: paused.revision, operationId: 'resume-live-goal', authority: { kind: 'user' }, action: 'resume' })!.agendaGoal!;
  expect(f.agenda.execute({ type: 'agenda.run.read', companionId: 'alice', id: parent.run.id })!.agendaRun!.status).toBe('queued');
  const ready = f.agenda.execute({ type: 'agenda.run.read', companionId: 'alice', id: parent.run.id })!.agendaRun!;
  f.agenda.execute({ type: 'agenda.run.control', companionId: 'alice', id: ready.id, expectedRevision: ready.revision, operationId: 'manual-park', action: 'pause', authority: { kind: 'user' } });
  const pauseAgain = f.agenda.execute({ type: 'agenda.goal.control', companionId: 'alice', id: initial.id, expectedRevision: resumedGoal.revision, operationId: 'pause-again', action: 'pause', authority: { kind: 'user' } })!.agendaGoal!;
  f.agenda.execute({ type: 'agenda.goal.control', companionId: 'alice', id: initial.id, expectedRevision: pauseAgain.revision, operationId: 'resume-again', action: 'resume', authority: { kind: 'user' } });
  expect(f.agenda.execute({ type: 'agenda.run.read', companionId: 'alice', id: ready.id })!.agendaRun!.status).toBe('parked');
});

it('fences a live learning stage immediately when its scoped continuous grant is revoked', async () => {
  const f = fixture(), scope = f.grant(f.create()), linked = await ensureAgendaLearningGoal(scope.goal, scope.authority, f.options);
  if (!linked.handled) throw new Error(linked.reason);
  vi.setSystemTime('2026-10-29T11:00:00.000Z');
  f.agenda.execute({ type: 'agenda.tick', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', facts: { active: true, 'model.available': true } });
  const parent = f.agenda.execute({ type: 'agenda.claim', companionId: 'alice', now: '2026-10-29T11:00:00.000Z', leaseMs: 30000, limit: 1, excludedOwners: [] })!.agendaClaim!;
  const actual = f.learning.execute({ type: 'learning.goals.claim', id: linked.learningGoalId, companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 })!.learningGoalJob!;
  const grant = f.agenda.execute({ type: 'agenda.grants.read', companionId: 'alice' })!.agendaGrants![0]!;
  f.agenda.execute({ type: 'agenda.grant.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision, operationId: 'revoke-live-learning', authority: { kind: 'user' } });
  expect(() => f.learning.execute({ type: 'learning.goals.heartbeat', id: actual.goal.id, leaseToken: actual.leaseToken, phase: 'reading', leaseMs: 120000 })).toThrow('旧学习阶段停止');
});

it('does not accept an old child or old claim after the same parent run is resumed with a new lease', async () => {
  const f = fixture(), initial = f.create(), linked = await ensureAgendaLearningGoal(initial, { kind: 'user' }, f.options);
  if (!linked.handled) throw new Error(linked.reason);
  const time = '2026-10-29T11:00:00.000Z'; vi.setSystemTime(time);
  f.agenda.execute({ type: 'agenda.tick', companionId: 'alice', now: time, facts: { active: true, 'model.available': true } });
  const parent = f.agenda.execute({ type: 'agenda.claim', companionId: 'alice', now: time, leaseMs: 30000, limit: 1, excludedOwners: [] })!.agendaClaim!;
  const claim = { type: 'learning.goals.claim' as const, id: linked.learningGoalId, companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, excludedOwners: [], leaseMs: 120000 };
  const child = f.learning.execute(claim)!.learningGoalJob!;
  const paused = f.agenda.execute({ type: 'agenda.run.control', companionId: 'alice', id: parent.run.id, expectedRevision: parent.run.revision, operationId: 'aba-pause', authority: { kind: 'user' }, action: 'pause' })!.agendaRun!;
  f.agenda.execute({ type: 'agenda.run.control', companionId: 'alice', id: parent.run.id, expectedRevision: paused.revision, operationId: 'aba-resume', authority: { kind: 'user' }, action: 'resume' });
  const renewed = f.agenda.execute({ type: 'agenda.claim', companionId: 'alice', now: time, leaseMs: 30000, limit: 1, excludedOwners: [] })!.agendaClaim!;
  expect(renewed.run.id).toBe(parent.run.id); expect(renewed.leaseToken).not.toBe(parent.leaseToken);
  expect(() => f.learning.execute(claim)).toThrow('父执行');
  expect(() => f.learning.execute({ type: 'learning.goals.heartbeat', id: child.goal.id, leaseToken: child.leaseToken, phase: 'reading', leaseMs: 120000 })).toThrow('旧学习阶段停止');
  f.learning.execute({ type: 'learning.goals.finish', id: child.goal.id, leaseToken: child.leaseToken, round: { ...child.round, status: 'cancelled' }, failureKind: 'cancelled' });
  expect(f.database.prepare('SELECT lease_token FROM companion_learning_goals WHERE id=?').get(child.goal.id)!.lease_token).toBeNull();
});
