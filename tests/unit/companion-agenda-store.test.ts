import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import type { CompanionConnection } from '../../src/companions/store';
import { companionTaskCanClaim, companionTaskActiveCount } from '../../src/companions/task-concurrency-store';
import { companionAgendaCommandSchema, companionAgendaPublicCommandSchema, companionAgendaRuleDraftSchema, type CompanionAgendaCommand, type CompanionAgendaRuleDraft } from '../../src/shared/companion-agenda';

const databases: DatabaseSync[] = [], roots: string[] = [];
const at = '2026-10-29T10:00:00.000Z';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(at)); });
afterEach(() => {
  vi.useRealTimers(); for (const db of databases.splice(0)) { try { db.close(); } catch { /* A restart case closes its first connection itself. */ } }
  for (const root of roots.splice(0)) { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('agenda-core-')) throw new Error('Unexpected fixture root'); rmSync(root, { recursive: true, force: true }); }
});
function fixture(file = ':memory:') {
  const db = new DatabaseSync(file); databases.push(db);
  db.exec("CREATE TABLE IF NOT EXISTS companions(id TEXT PRIMARY KEY,data TEXT NOT NULL,deleted_at TEXT); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,author_id TEXT,status TEXT);");
  for (const id of ['alice', 'bob']) db.prepare('INSERT OR IGNORE INTO companions(id,data) VALUES(?,?)').run(id, JSON.stringify({ active: true }));
  const connection: CompanionConnection = {
    prepare(sql) { const stmt = db.prepare(sql); return { all: (...args) => stmt.all(...args as SQLInputValue[]), get: (...args) => stmt.get(...args as SQLInputValue[]),
      run: (...args) => { const r = stmt.run(...args as SQLInputValue[]); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; } }; },
    exec: sql => { db.exec(sql); }, close: () => db.close(), pragma: sql => db.prepare('PRAGMA ' + sql).get(),
    function: (name, options, fn) => { db.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const action = () => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }; return Object.assign(action, { immediate: action }); },
  };
  const store = new CompanionAgendaStore(connection); store.initialize();
  const send = (input: unknown) => store.execute(input as CompanionAgendaCommand)!;
  let sequence = 0;
  const create = (patch: Partial<CompanionAgendaRuleDraft> = {}, authority = { kind: 'self' }) => send({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'create-' + ++sequence,
    authority, rule: { title: '回看安排', intent: '查看今天还有什么值得继续', kind: 'self', executor: 'brain', trigger: { kind: 'at', at, timeZone: 'UTC', repeat: 'once' }, reason: '接着上次未解的问题', ...patch } }).agendaRule!;
  const tick = (now = at, facts = {}) => send({ type: 'agenda.tick', companionId: 'alice', now, facts });
  const claim = (now = at, limit = 1) => send({ type: 'agenda.claim', companionId: 'alice', now, leaseMs: 30000, limit }).agendaClaims!;
  return { db, connection, store, send, create, tick, claim };
}

it('resumes only rule-held runs with the same occurrence and revoked old lease', () => {
  const f = fixture(), rule = f.create(); f.tick(); const claimed = f.claim()[0]!;
  const paused = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: rule.revision,
    operationId: 'pause_rule', authority: { kind: 'user' }, action: 'pause' }).agendaRule!;
  const held = f.send({ type: 'agenda.run.read', companionId: 'alice', id: claimed.run.id }).agendaRun!;
  expect(held).toMatchObject({ status: 'parked', pausedByRuleId: rule.id, cycleFailureCount: 0 });
  expect(() => f.send({ type: 'agenda.run.heartbeat', companionId: 'alice', id: held.id, leaseToken: claimed.leaseToken, now: at, leaseMs: 30000 })).toThrow('租约');
  f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: paused.revision,
    operationId: 'resume_rule', authority: { kind: 'user' }, action: 'resume' });
  const restored = f.send({ type: 'agenda.run.read', companionId: 'alice', id: held.id }).agendaRun!;
  expect(restored.status).toBe('queued'); expect(restored.pausedByRuleId).toBeUndefined();
  expect(restored.occurrenceId).toBe(claimed.occurrence.id); expect(f.claim()[0]!.run.id).toBe(held.id);
});

it.each(['parked', 'unknown', 'abandoned'] as const)('automatic rule resume preserves a %s outcome instead of retrying it', outcome => {
  const f = fixture(), rule = f.create(); f.tick(); const claimed = f.claim()[0]!;
  let run = f.send({ type: 'agenda.run.settle', companionId: 'alice', id: claimed.run.id, leaseToken: claimed.leaseToken, now: at,
    outcome, error: '保留原来的处理状态' }).agendaRun!;
  const paused = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: rule.revision,
    operationId: 'pause_quality', authority: { kind: 'user' }, action: 'pause' }).agendaRule!;
  f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: paused.revision,
    operationId: 'resume_quality', authority: { kind: 'user' }, action: 'resume' });
  run = f.send({ type: 'agenda.run.read', companionId: 'alice', id: run.id }).agendaRun!;
  expect(run.status).toBe(outcome); expect(run.pausedByRuleId).toBeUndefined(); expect(f.claim()).toHaveLength(0);
});

it('automatic rule resume does not supersede a later explicit pause of one run', () => {
  const f = fixture(), rule = f.create(); f.tick(); const claimed = f.claim()[0]!;
  const paused = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: rule.revision,
    operationId: 'rule_pause_then_manual', authority: { kind: 'user' }, action: 'pause' }).agendaRule!;
  const held = f.send({ type: 'agenda.run.read', companionId: 'alice', id: claimed.run.id }).agendaRun!;
  const manual = f.send({ type: 'agenda.run.control', companionId: 'alice', id: held.id, expectedRevision: held.revision,
    operationId: 'manual_pause_after_rule', authority: { kind: 'user' }, action: 'pause' }).agendaRun!;
  expect(manual.pausedByRuleId).toBeUndefined();
  f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: paused.revision,
    operationId: 'rule_resume_keep_manual', authority: { kind: 'user' }, action: 'resume' });
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: held.id }).agendaRun!.status).toBe('parked');
});

it('allows human recovery of a protected semantic batch while its system rule remains protected', () => {
  const f = fixture(), rule = f.create({ protected: true, kind: 'memory', executor: 'memory' }, { kind: 'system' });
  f.tick(); const claim = f.claim()[0]!;
  const parked = f.send({ type: 'agenda.run.settle', companionId: 'alice', id: claim.run.id, leaseToken: claim.leaseToken, now: at,
    outcome: 'parked', error: '原始来源保留，等待处理' }).agendaRun!;
  expect(() => f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: rule.revision,
    operationId: 'cannot_disable_integrity', authority: { kind: 'user' }, action: 'pause' })).toThrow('完整性');
  expect(() => f.send({ type: 'agenda.run.control', companionId: 'alice', id: parked.id, expectedRevision: parked.revision,
    operationId: 'self_cannot_resume', authority: { kind: 'self' }, action: 'resume' })).toThrow('系统处理事件');
  const resumed = f.send({ type: 'agenda.run.control', companionId: 'alice', id: parked.id, expectedRevision: parked.revision,
    operationId: 'human_resume_batch', authority: { kind: 'user' }, action: 'resume' }).agendaRun!;
  expect(resumed.status).toBe('queued');
  expect(f.send({ type: 'agenda.event.read', companionId: 'alice', id: rule.id }).agendaEvent!.rule).toMatchObject({ protected: true, status: 'active' });
});

it.each(['rule', 'goal'] as const)('rule and goal holds remain independent when %s resumes first', first => {
  const f = fixture();
  const goal = f.send({ type: 'agenda.goal.create', companionId: 'alice', operationId: 'held_goal', authority: { kind: 'user' },
    goal: { title: '长期方向', intent: '有依据地继续理解问题。', domain: 'project', successCriteria: ['存在真实结果'], nextQuestions: [] } }).agendaGoal!;
  const rule = f.create({ goalId: goal.id }); f.tick(); const run = f.claim()[0]!.run;
  const pausedRule = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: rule.revision,
    operationId: 'hold_rule', authority: { kind: 'user' }, action: 'pause' }).agendaRule!;
  const pausedGoal = f.send({ type: 'agenda.goal.control', companionId: 'alice', id: goal.id, expectedRevision: goal.revision,
    operationId: 'hold_goal', authority: { kind: 'user' }, action: 'pause' }).agendaGoal!;
  const resumeRule = () => f.send({ type: 'agenda.rule.control', companionId: 'alice', id: rule.id, expectedRevision: pausedRule.revision,
    operationId: 'restore_rule', authority: { kind: 'user' }, action: 'resume' });
  const resumeGoal = () => f.send({ type: 'agenda.goal.control', companionId: 'alice', id: goal.id, expectedRevision: pausedGoal.revision,
    operationId: 'restore_goal', authority: { kind: 'user' }, action: 'resume' });
  (first === 'rule' ? resumeRule : resumeGoal)();
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: run.id }).agendaRun!.status).toBe('parked');
  (first === 'rule' ? resumeGoal : resumeRule)();
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: run.id }).agendaRun!.status).toBe('queued');
});

it('keeps model/renderer commands free of host authority and strictly separates internal claims', () => {
  expect(companionAgendaPublicCommandSchema.safeParse({ type: 'agenda.claim', now: at }).success).toBe(false);
  expect(companionAgendaCommandSchema.safeParse({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'one', rule: {} }).success).toBe(false);
  expect(companionAgendaPublicCommandSchema.safeParse({ type: 'agenda.grants.read', companionId: 'alice', authority: { kind: 'user' } }).success).toBe(false);
});

it('creates a real durable rule, prevents operation key rebinding and keeps reads inert', () => {
  const f = fixture(), rule = f.create();
  const before = f.db.prepare('SELECT count(*) AS n FROM companion_agenda_occurrences').get()!.n;
  const page = f.send({ type: 'agenda.read', companionId: 'alice' }).agenda!;
  expect(page.rules[0]!.id).toBe(rule.id); expect(page.rules[0]!.nextAt).toBe(at);
  expect(f.db.prepare('SELECT count(*) AS n FROM companion_agenda_occurrences').get()!.n).toBe(before);
  expect(() => f.send({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'create-1', authority: { kind: 'self' }, rule: { ...rule, title: '换了目标' } })).toThrow();
  expect(f.send({ type: 'agenda.read', companionId: 'bob' }).agenda!.rules).toEqual([]);
});

it('enforces CAS and preserves fixed task definitions while allowing negotiation controls', () => {
  const f = fixture(), rule = f.create({ flexible: false }, { kind: 'user' });
  const paused = f.send({ type: 'agenda.rule.control', companionId: 'alice', operationId: 'pause', id: rule.id, expectedRevision: rule.revision, action: 'pause', authority: { kind: 'self' } }).agendaRule!;
  expect(paused.status).toBe('paused');
  expect(() => f.send({ type: 'agenda.rule.update', companionId: 'alice', operationId: 'rewrite_fixed', id: rule.id, expectedRevision: paused.revision, rule: { title: '改写约定', intent: rule.intent, kind: rule.kind, executor: rule.executor, trigger: rule.trigger, reason: rule.reason, flexible: false }, authority: { kind: 'self' } })).toThrow('固定约定');
  expect(() => f.send({ type: 'agenda.rule.control', companionId: 'alice', operationId: 'badrev', id: rule.id, expectedRevision: 9, action: 'pause', authority: { kind: 'user' } })).toThrow('版本');
  const protectedRule = f.create({ protected: true, kind: 'memory', executor: 'memory' }, { kind: 'system' });
  expect(() => f.send({ type: 'agenda.rule.control', companionId: 'alice', operationId: 'system-pause', id: protectedRule.id, expectedRevision: 1, action: 'pause', authority: { kind: 'user' } })).toThrow('完整性');
});

it('retains a conditional occurrence identity across checks and only claims on actual host conditions', () => {
  const f = fixture(); f.create({ conditions: [{ key: 'user.available', equals: true, label: '等待用户空闲' }] });
  f.tick(at, { 'user.available': false }); expect(f.claim()).toHaveLength(0);
  f.tick('2026-10-29T10:01:00.000Z', { 'user.available': false });
  expect(f.db.prepare('SELECT count(*) AS n FROM companion_agenda_occurrences').get()!.n).toBe(1);
  f.tick('2026-10-29T10:02:00.000Z', { 'user.available': true });
  const [claim] = f.claim('2026-10-29T10:02:00.000Z'); expect(claim!.occurrence.scheduledAt).toBe(at);
});

it('applies one probability threshold per window, including across re-open and rule revision', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agenda-core-')); roots.push(directory); const file = path.join(directory, 'ledger.sqlite');
  const f = fixture(file), rule = f.create({ trigger: { kind: 'window', startMinute: 600, endMinute: 660, timeZone: 'UTC', probability: .5, checkIntervalMinutes: 5 } });
  f.tick(); const first = f.send({ type: 'agenda.event.read', companionId: 'alice', id: rule.id }).agendaEvent!.occurrences[0]!;
  f.db.close(); const next = fixture(file); next.tick('2026-10-29T10:05:00.000Z');
  const second = next.send({ type: 'agenda.event.read', companionId: 'alice', id: rule.id }).agendaEvent!.occurrences[0]!;
  expect(second.id).toBe(first.id); expect(second.probabilityThreshold).toBe(first.probabilityThreshold); expect(second.accumulatedHazard).toBeGreaterThanOrEqual(first.accumulatedHazard);
  const draft = Object.fromEntries(Object.keys(companionAgendaRuleDraftSchema.shape).map(key => [key, rule[key as keyof typeof rule]]));
  next.send({ type: 'agenda.rule.update', companionId: 'alice', operationId: 'revise', id: rule.id, expectedRevision: 1, rule: { ...draft, title: '只是调整标题' }, authority: { kind: 'self' } });
  next.tick('2026-10-29T10:10:00.000Z'); const third = next.send({ type: 'agenda.event.read', companionId: 'alice', id: rule.id }).agendaEvent!.occurrences[0]!;
  expect(third.id).toBe(first.id); expect(third.probabilityThreshold).toBe(first.probabilityThreshold);
});

it('supports two parallel conversations and a learning event within owner capacity, with exclusive resources', () => {
  const f = fixture(); for (let index = 0; index < 4; index++) f.create({ kind: index < 2 ? 'chat' : 'learning', resourceKeys: index === 3 ? ['desktop.control'] : [], overlapPolicy: 'parallel' });
  f.tick(); expect(f.claim(at, 10)).toHaveLength(3); expect(f.claim()).toHaveLength(0);
  const other = fixture(); other.create({ resourceKeys: ['desktop.control'] }); other.create({ resourceKeys: ['desktop.control'] }); other.tick(); expect(other.claim(at, 10)).toHaveLength(1);
});

it('releases cognitive capacity during a wait and resumes the same checkpoint without counting waiting as failure', () => {
  const f = fixture(); f.create(); f.tick(); const first = f.claim()[0]!;
  f.send({ type: 'agenda.run.checkpoint', companionId: 'alice', id: first.run.id, leaseToken: first.leaseToken, now: at, checkpoint: '{"step":2}', stage: '等待对方回复' });
  const settled = f.send({ type: 'agenda.run.settle', companionId: 'alice', id: first.run.id, leaseToken: first.leaseToken, now: at, outcome: 'waiting', notBefore: '2026-10-29T10:00:20.000Z', nextCondition: '等待真实回信' }).agendaRun!;
  expect(settled.failureCount).toBe(0); expect(settled.leaseToken).toBeUndefined();
  const second = f.claim('2026-10-29T10:00:20.000Z')[0]!; expect(second.run.id).toBe(first.run.id); expect(second.run.checkpoint).toBe('{"step":2}');
});

it('parks after three real failures, explicit resume resets cycle only and abandonment retains raw sources', () => {
  const f = fixture(); f.create(); f.tick(); let now = at, run = f.claim()[0]!;
  for (let failure = 1; failure <= 3; failure++) {
    const settled = f.send({ type: 'agenda.run.settle', companionId: 'alice', id: run.run.id, leaseToken: run.leaseToken, now, outcome: 'failed', error: '格式或处理失败', notBefore: now }).agendaRun!;
    expect(settled.failureCount).toBe(failure);
    if (failure < 3) { now = isoTime(Date.parse(now) + 1000); run = f.claim(now)[0]!; }
    else {
      expect(settled.status).toBe('parked'); expect(f.claim(now)).toHaveLength(0);
      const resumed = f.send({ type: 'agenda.run.control', companionId: 'alice', id: settled.id, expectedRevision: settled.revision, operationId: 'resume', action: 'resume', authority: { kind: 'user' } }).agendaRun!;
      expect(resumed.failureCount).toBe(3); expect(resumed.cycleFailureCount).toBe(0); expect(resumed.retryCycle).toBe(1);
      const abandoned = f.send({ type: 'agenda.run.control', companionId: 'alice', id: resumed.id, expectedRevision: resumed.revision, operationId: 'abandon', action: 'abandon', authority: { kind: 'user' } }).agendaRun!;
      expect(abandoned.status).toBe('abandoned'); expect(f.db.prepare('SELECT count(*) AS n FROM companion_agenda_occurrences').get()!.n).toBe(1);
      expect(f.db.prepare('SELECT count(*) AS n FROM companion_agenda_audit WHERE entity_id=?').get(settled.id)!.n).toBeGreaterThan(5);
    }
  }
});

it('does not replay expired running leases or unknown external effects, and fences old writers', () => {
  const f = fixture(); f.create(); f.tick(); const run = f.claim()[0]!;
  const step = { companionId: 'alice', runId: run.run.id, leaseToken: run.leaseToken, now: at, effectKey: 'send-report', title: '交付报告' };
  f.send({ type: 'agenda.step.record', ...step, status: 'prepared' }); f.send({ type: 'agenda.step.record', ...step, status: 'dispatched' });
  expect(f.claim('2026-10-29T10:00:31.000Z')).toHaveLength(0);
  const actual = f.send({ type: 'agenda.run.read', companionId: 'alice', id: run.run.id }).agendaRun!; expect(actual.status).toBe('unknown');
  expect(() => f.send({ type: 'agenda.run.checkpoint', companionId: 'alice', id: run.run.id, leaseToken: run.leaseToken, now: '2026-10-29T10:00:31.000Z', checkpoint: '{}', stage: '旧进程' })).toThrow('租约');
  expect(() => f.send({ type: 'agenda.run.control', companionId: 'alice', id: actual.id, expectedRevision: actual.revision, operationId: 'blind', action: 'resume', authority: { kind: 'user' } })).toThrow('核对');
  f.send({ type: 'agenda.step.reconcile', companionId: 'alice', runId: actual.id, expectedRunRevision: actual.revision, effectKey: 'send-report', now: at, outcome: 'succeeded', result: 'actual-message-1', evidence: '宿主已查询到相同交付作用的真实消息回执' });
  const done = f.send({ type: 'agenda.run.reconcile', companionId: 'alice', id: actual.id, expectedRevision: actual.revision, now: at, outcome: 'completed', evidence: '真实交付已经核对' }).agendaRun!; expect(done.status).toBe('completed');
});

it('requires a real dispatched step before success and makes its receipt immutable', () => {
  const f = fixture(); f.create(); f.tick(); const claim = f.claim()[0]!, step = { companionId: 'alice', runId: claim.run.id, leaseToken: claim.leaseToken, now: at, effectKey: 'file', title: '保存产物' };
  expect(() => f.send({ type: 'agenda.step.record', ...step, status: 'succeeded' })).toThrow('准备');
  f.send({ type: 'agenda.step.record', ...step, status: 'prepared' }); f.send({ type: 'agenda.step.record', ...step, status: 'dispatched' }); f.send({ type: 'agenda.step.record', ...step, status: 'succeeded', result: 'hash-one' });
  expect(() => f.send({ type: 'agenda.step.record', ...step, status: 'succeeded', result: 'hash-two' })).toThrow('不可改写');
  expect(f.send({ type: 'agenda.step.read', companionId: 'alice', runId: claim.run.id, effectKey: 'file' }).agendaStep!.result).toBe('hash-one');
});

it('allows only users to grant external abilities and revokes queued/running use immediately', () => {
  const f = fixture(), grantInput = { title: '只看工作窗口', capabilities: ['observe'], windowIds: ['window:123:0'], captureSources: [{ id: 'window:123:0', title: '工作窗口' }] };
  expect(() => f.send({ type: 'agenda.grant.configure', companionId: 'alice', operationId: 'badgrant', grant: grantInput, authority: { kind: 'self' } })).toThrow('用户');
  const grant = f.send({ type: 'agenda.grant.configure', companionId: 'alice', operationId: 'grant', grant: grantInput, authority: { kind: 'user' } }).agendaGrant!;
  expect(() => f.create({ kind: 'observation', executor: 'observation' })).toThrow('持续授权');
  f.create({ kind: 'observation', executor: 'observation', grantId: grant.id }, { kind: 'self', grantId: grant.id } as { kind: string });
  f.tick(); const claim = f.claim()[0]!;
  f.send({ type: 'agenda.grant.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision, operationId: 'revoke', authority: { kind: 'user' } });
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!.status).toBe('unknown'); expect(f.claim()).toHaveLength(0);
});

it('deduplicates real events, merges quiet windows without dropping their source ledger, and prevents self-certified learning', () => {
  const f = fixture(); f.create({ kind: 'memory', executor: 'memory', trigger: { kind: 'event', topic: 'experience', quietSeconds: 60 }, overlapPolicy: 'merge' }, { kind: 'system' });
  const emission = { type: 'agenda.emit', companionId: 'alice', eventKey: 'message-one', topic: 'experience', at, input: 'source-one' };
  f.send(emission); f.send(emission); f.send({ ...emission, eventKey: 'message-two', input: 'source-two' });
  expect(f.db.prepare('SELECT count(*) AS n FROM companion_agenda_emissions').get()!.n).toBe(2); expect(f.db.prepare('SELECT count(*) AS n FROM companion_agenda_runs').get()!.n).toBe(1);
  expect(f.claim()).toHaveLength(0); expect(f.claim('2026-10-29T10:01:00.000Z')).toHaveLength(1);
  const goal = f.send({ type: 'agenda.goal.create', companionId: 'alice', operationId: 'goal', authority: { kind: 'self' }, goal: { title: '学习混音', intent: '学会有依据地分析', domain: 'knowledge', successCriteria: ['真实练习并核对结果'] } }).agendaGoal!;
  expect(() => f.send({ type: 'agenda.goal.control', companionId: 'alice', id: goal.id, expectedRevision: 1, operationId: 'mastered', action: 'complete', evidence: '我觉得已经学会', authority: { kind: 'self' } })).toThrow('宿主');
});

it('keeps owner capacity shared in both directions during cutover without double-counting an agenda child', () => {
  const f = fixture();
  f.db.exec(`CREATE TABLE companion_work_queue(id TEXT,companion_id TEXT,status TEXT,data TEXT);
    CREATE TABLE companion_work_orders(id TEXT,companion_id TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE companion_schedules(id TEXT,companion_id TEXT);
    CREATE TABLE companion_schedule_occurrences(id TEXT,schedule_id TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE actions(id TEXT,companion_id TEXT,status TEXT,data TEXT);
    CREATE TABLE companion_activity_tasks(id TEXT,companion_id TEXT,status TEXT,data TEXT);
    CREATE TABLE companion_social_jobs(id TEXT,companion_id TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE companion_social_notifications(id TEXT,companion_id TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE companion_world_jobs(id TEXT,companion_id TEXT,kind TEXT,status TEXT,lease_until TEXT,data TEXT);
    CREATE TABLE companion_life_occurrences(id TEXT,companion_id TEXT,status TEXT,lease_until TEXT);
    CREATE TABLE companion_learning_grants(id TEXT,companion_id TEXT,enabled INTEGER,lease_token TEXT,lease_until INTEGER);
    CREATE TABLE companion_learning_goals(id TEXT,companion_id TEXT,state TEXT,lease_token TEXT,lease_until INTEGER);`);
  f.db.prepare('INSERT INTO companion_work_queue VALUES(?,?,?,?)').run('old-chat', 'alice', 'running', '{}');
  for (let index = 0; index < 3; index++) f.create({ kind: 'chat', overlapPolicy: 'parallel' });
  f.tick(); const claims = f.claim(at, 10); expect(claims).toHaveLength(2);
  expect(companionTaskCanClaim(f.connection, 'alice')).toBe(false); expect(companionTaskActiveCount(f.connection, 'alice')).toBe(3);
  f.db.prepare('INSERT INTO actions VALUES(?,?,?,?)').run('agenda-child', 'alice', 'running', JSON.stringify({ agendaRunId: claims[0]!.run.id }));
  expect(companionTaskActiveCount(f.connection, 'alice')).toBe(3);
  f.db.prepare("UPDATE companion_work_queue SET status='done' WHERE id='old-chat'").run(); expect(f.claim()).toHaveLength(1);
});

it('normalizes offset instants and keeps yesterday unfinished activity visible in today query', () => {
  const f = fixture(); f.create({ trigger: { kind: 'at', at: '2026-10-29T18:00:00+08:00', timeZone: 'Asia/Shanghai', repeat: 'once' } }); f.tick();
  const claim = f.claim()[0]!; expect(claim.occurrence.scheduledAt).toBe(at);
  const nextDay = f.send({ type: 'agenda.read', companionId: 'alice', from: '2026-10-30T00:00:00Z', to: '2026-10-31T00:00:00Z' }).agenda!;
  expect(nextDay.runs.some(run => run.id === claim.run.id)).toBe(true);
});

it('keeps restored agenda readable while recovery review prevents execution', () => {
  const f = fixture(); f.create(); f.tick();
  f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('recovery-review-required/alice', 'true');
  expect(f.claim()).toHaveLength(0); expect(f.send({ type: 'agenda.read', companionId: 'alice' }).agenda!.rules).toHaveLength(1);
});

it('lets the owner adjust an unprotected system starting rhythm and rejects foreign/draft human sources', () => {
  const f = fixture(), rule = f.create({ protected: false, flexible: true }, { kind: 'system' });
  expect(f.send({ type: 'agenda.rule.control', companionId: 'alice', operationId: 'self-pause-start', id: rule.id, expectedRevision: 1, action: 'pause', authority: { kind: 'self' } }).agendaRule!.status).toBe('paused');
  f.db.exec("ALTER TABLE messages ADD COLUMN conversation_id TEXT; ALTER TABLE messages ADD COLUMN kind TEXT; ALTER TABLE messages ADD COLUMN request_fingerprint TEXT; CREATE TABLE conversation_members(conversation_id TEXT,companion_id TEXT);");
  f.db.prepare('INSERT INTO conversation_members VALUES(?,?)').run('bob-private', 'bob');
  f.db.prepare('INSERT INTO messages(id,author_id,status,conversation_id,kind) VALUES(?,?,?,?,?)').run('foreign-user', 'user', 'sent', 'bob-private', 'text');
  expect(() => f.create({}, { kind: 'user', sourceMessageId: 'foreign-user' } as { kind: string })).toThrow('来源');
  f.db.prepare('INSERT INTO conversation_members VALUES(?,?)').run('alice-private', 'alice');
  f.db.prepare('INSERT INTO messages(id,author_id,status,conversation_id,kind,request_fingerprint) VALUES(?,?,?,?,?,?)').run('draft-user', 'user', 'sent', 'alice-private', 'text', '{"loopStep":0}');
  expect(() => f.create({}, { kind: 'user', sourceMessageId: 'draft-user' } as { kind: string })).toThrow('来源');
});
function isoTime(value: number) { return new Date(value).toISOString(); }

it('keeps world body windows out of real-time semantic claims and flushes prior physical history before editing', () => {
  const f = fixture(), before = vi.fn(); f.store.connectRoutineChanges(before);
  const rule = f.create({ executor: 'routine', clock: 'world', routine: { kind: 'sleep' },
    trigger: { kind: 'window', startMinute: 1380, endMinute: 420, timeZone: 'UTC', probability: 1 } });
  expect(rule.nextAt).toBeUndefined(); expect(before).toHaveBeenCalledWith('alice');
  f.tick('2026-10-29T23:30:00.000Z', { active: true }); expect(f.claim('2026-10-29T23:30:00.000Z')).toHaveLength(0);
  const draft = companionAgendaRuleDraftSchema.parse({ title: rule.title, intent: rule.intent, kind: rule.kind, executor: rule.executor,
    clock: rule.clock, routine: rule.routine, trigger: { ...rule.trigger, startMinute: 1320 }, reason: rule.reason });
  f.send({ type: 'agenda.rule.update', companionId: 'alice', id: rule.id, expectedRevision: rule.revision, operationId: 'adjust_body_window', authority: { kind: 'self' }, rule: draft });
  expect(before).toHaveBeenCalledTimes(2);
});

it('rejects a duplicate active daily sleep window on creation and on resuming an older rule', () => {
  const f = fixture(), patch: Partial<CompanionAgendaRuleDraft> = { executor: 'routine', clock: 'world', routine: { kind: 'sleep' },
    trigger: { kind: 'window', startMinute: 1380, endMinute: 420, timeZone: 'UTC', probability: 1 } };
  const first = f.create(patch);
  expect(() => f.create(patch)).toThrow('已有生效');
  const held = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: first.id, expectedRevision: first.revision,
    operationId: 'hold_sleep', authority: { kind: 'self' }, action: 'pause' }).agendaRule!;
  f.create(patch);
  expect(() => f.send({ type: 'agenda.rule.control', companionId: 'alice', id: first.id, expectedRevision: held.revision,
    operationId: 'resume_conflicting_sleep', authority: { kind: 'self' }, action: 'resume' })).toThrow('已有生效');
});

it('returns a lean batched calendar while exact event details retain every original checkpoint and receipt', () => {
  const f = fixture(), rule = f.create({ trigger: { kind: 'event', topic: 'actual_source', quietSeconds: 0 }, overlapPolicy: 'parallel' });
  for (const [key, time] of [['old_source', '2026-10-28T09:00:00.000Z'], ['new_source', at]] as const)
    f.send({ type: 'agenda.emit', companionId: 'alice', eventKey: key, topic: 'actual_source', at: time, input: 'RAW_SOURCE_PAYLOAD_CANARY_' + key });
  const first = f.claim()[0]!;
  f.send({ type: 'agenda.run.checkpoint', companionId: 'alice', id: first.run.id, leaseToken: first.leaseToken, now: at,
    checkpoint: JSON.stringify({ nativeJobs: [], body: 'LARGE_CHECKPOINT_CANARY'.repeat(2000) }), stage: '已记录原始处理位置' });
  f.send({ type: 'agenda.run.settle', companionId: 'alice', id: first.run.id, leaseToken: first.leaseToken, now: at,
    outcome: 'waiting', result: 'PRIVATE_RESULT_CANARY', error: 'PRIVATE_ERROR_CANARY', notBefore: '2027-01-01T00:00:00.000Z' });
  const second = f.claim()[0]!;
  const prepare = vi.spyOn(f.connection, 'prepare');
  const view = f.send({ type: 'agenda.read', companionId: 'alice', from: '2026-10-30T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z', limit: 50 }).agenda!;
  const statements = prepare.mock.calls.map(([sql]) => sql); prepare.mockRestore();
  expect(view.runs.map(run => run.id).sort()).toEqual([first.run.id, second.run.id].sort());
  expect(view.occurrences).toHaveLength(2); // Live work survives a dated filter even without dated history.
  for (const run of view.runs) expect(run).not.toHaveProperty('checkpoint');
  expect(JSON.stringify(view)).not.toContain('CANARY');
  expect(view.runs.every(run => !run.leaseToken && !run.leaseUntil && !run.result && !run.error)).toBe(true);
  expect(view.occurrences.every(occurrence => !occurrence.input && !occurrence.eventKey)).toBe(true);
  expect(statements.filter(sql => sql.includes('WITH selected AS'))).toHaveLength(1);
  expect(statements.filter(sql => sql.includes('occurrence_id=?'))).toHaveLength(0);
  const detail = f.send({ type: 'agenda.event.read', companionId: 'alice', id: rule.id }).agendaEvent!;
  expect(detail.runs.find(run => run.id === first.run.id)).toMatchObject({ result: 'PRIVATE_RESULT_CANARY', error: 'PRIVATE_ERROR_CANARY', checkpoint: expect.stringContaining('LARGE_CHECKPOINT_CANARY') });
  expect(detail.runs.find(run => run.id === second.run.id)!.leaseToken).toBe(second.leaseToken);
  expect(detail.occurrences.every(occurrence => occurrence.input?.startsWith('RAW_SOURCE_PAYLOAD_CANARY_') && occurrence.eventKey)).toBe(true);
});

it('keeps rule pagination and bounded history in a single joined calendar statement across many rules', () => {
  const f = fixture();
  for (let index = 0; index < 30; index++) f.create({ title: '并列安排 ' + index });
  f.tick();
  const prepare = vi.spyOn(f.connection, 'prepare');
  const first = f.send({ type: 'agenda.read', companionId: 'alice', limit: 25 }).agenda!;
  const statements = prepare.mock.calls.map(([sql]) => sql); prepare.mockRestore();
  expect(first).toMatchObject({ hasMore: true }); expect(first.rules).toHaveLength(25); expect(first.occurrences).toHaveLength(25); expect(first.runs).toHaveLength(25);
  expect(statements.filter(sql => sql.includes('WITH selected AS'))).toHaveLength(1);
  expect(statements.length).toBeLessThanOrEqual(7);
  const last = f.send({ type: 'agenda.read', companionId: 'alice', afterId: first.nextId, limit: 25 }).agenda!;
  expect(last.rules).toHaveLength(5); expect(last.hasMore).toBe(false);
  expect(new Set([...first.rules, ...last.rules].map(rule => rule.id)).size).toBe(30);
});
