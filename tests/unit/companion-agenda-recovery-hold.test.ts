import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import { holdRestoredCompanionAgenda, assertRestoredCompanionAgendaHeld } from '../../src/companions/agenda-recovery-hold';
import type { CompanionAgendaCommand, CompanionAgendaClaim } from '../../src/shared/companion-agenda';
import { nodeCompanionConnection } from '../fixtures/node-companion-connection';

const closers: Array<() => void> = [], at = '2026-10-29T08:00:00.000Z';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); });
afterEach(() => { for (const close of closers.splice(0)) close(); vi.useRealTimers(); });
function fixture() {
  const { db, connection } = nodeCompanionConnection(); closers.push(() => db.close());
  db.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT,deleted_at TEXT);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO companions VALUES('alice','{\"active\":true}',NULL)");
  const store = new CompanionAgendaStore(connection); store.initialize();
  const send = (command: CompanionAgendaCommand) => store.execute(command)!;
  let sequence = 0;
  const claim = () => {
    send({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'rule_' + ++sequence, authority: { kind: 'system' }, rule: {
      title: '恢复检查', intent: '只处理真实回执', kind: 'self', executor: 'brain', trigger: { kind: 'at', at, timeZone: 'UTC', repeat: 'once' },
      conditions: [], flexible: true, protected: false, overlapPolicy: 'parallel', resourceKeys: [], reason: '测试恢复门' } });
    send({ type: 'agenda.tick', companionId: 'alice', now: at, facts: {} });
    return send({ type: 'agenda.claim', companionId: 'alice', now: at, leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaim!;
  };
  const step = (claim: CompanionAgendaClaim, effectKey: string, status: 'prepared' | 'dispatched' | 'succeeded', result?: string) => send({ type: 'agenda.step.record',
    companionId: 'alice', runId: claim.run.id, leaseToken: claim.leaseToken, effectKey, title: '原始作用', status, now: at, result });
  return { db, connection, send, claim, step };
}

it('holds known work, preserves successful receipts, converts dispatched effects to unknown and revokes restored grants', () => {
  const f = fixture(), known = f.claim(), uncertain = f.claim();
  f.step(known, 'known', 'prepared'); f.step(known, 'known', 'dispatched'); f.step(known, 'known', 'succeeded', '{"messageId":"real_sent_message"}');
  f.step(uncertain, 'uncertain', 'prepared'); f.step(uncertain, 'uncertain', 'dispatched');
  const grant = f.send({ type: 'agenda.grant.configure', companionId: 'alice', operationId: 'grant', authority: { kind: 'user' }, grant: {
    title: '旧授权范围', capabilities: ['observe', 'files.read'], fileRoots: ['C:\\old_scope'], outputRoots: [], windowIds: ['screen:old'], captureSources: [], allowPublicWeb: false } }).agendaGrant!;
  expect(() => assertRestoredCompanionAgendaHeld(f.connection, 'alice')).toThrow('复核门');
  expect(holdRestoredCompanionAgenda(f.connection)).toBe(4);
  const held = f.send({ type: 'agenda.run.read', companionId: 'alice', id: known.run.id }), unknown = f.send({ type: 'agenda.run.read', companionId: 'alice', id: uncertain.run.id });
  expect(held.agendaRun).toMatchObject({ status: 'parked', revision: known.run.revision + 1 });
  expect(held.agendaRun!.leaseToken).toBeUndefined(); expect(held.agendaRun!.leaseUntil).toBeUndefined();
  expect(held.agendaSteps![0]).toMatchObject({ status: 'succeeded', result: '{"messageId":"real_sent_message"}' });
  expect(unknown.agendaRun!.status).toBe('unknown'); expect(unknown.agendaSteps![0]!.status).toBe('unknown');
  const revoked = f.send({ type: 'agenda.grants.read', companionId: 'alice' }).agendaGrants![0]!;
  expect(revoked).toMatchObject({ id: grant.id, status: 'revoked', revision: grant.revision + 1, fileRoots: ['C:\\old_scope'] });
  expect(() => assertRestoredCompanionAgendaHeld(f.connection, 'alice')).not.toThrow();
  expect(f.send({ type: 'agenda.claim', companionId: 'alice', now: at, leaseMs: 30000, limit: 10, excludedOwners: [] }).agendaClaims).toEqual([]);
  expect(() => f.send({ type: 'agenda.run.control', companionId: 'alice', id: uncertain.run.id, expectedRevision: unknown.agendaRun!.revision,
    operationId: 'blind_resume', authority: { kind: 'user' }, action: 'resume' })).toThrow('核对');
  expect(() => f.send({ type: 'agenda.run.heartbeat', companionId: 'alice', id: known.run.id, leaseToken: known.leaseToken, now: at, leaseMs: 30000 })).toThrow('租约');
});

it('is idempotent and leaves terminal receipts and original restore audit intact', () => {
  const f = fixture(), completed = f.claim();
  f.step(completed, 'stable', 'prepared'); f.step(completed, 'stable', 'dispatched'); f.step(completed, 'stable', 'succeeded', 'EXACT_EFFECT_RECEIPT');
  f.send({ type: 'agenda.run.settle', companionId: 'alice', id: completed.run.id, leaseToken: completed.leaseToken, now: at, outcome: 'completed', result: 'EXACT_RUN_RECEIPT' });
  const before = f.send({ type: 'agenda.run.read', companionId: 'alice', id: completed.run.id });
  const pending = f.claim(); f.step(pending, 'not-dispatched', 'prepared');
  expect(holdRestoredCompanionAgenda(f.connection)).toBe(1);
  const audit = f.db.prepare("SELECT data FROM companion_agenda_audit WHERE kind='restore.held'").all();
  expect(audit).toHaveLength(1); expect(JSON.parse(String(audit[0]!.data)).original).toMatchObject({ id: pending.run.id, status: 'running', leaseToken: pending.leaseToken });
  expect(holdRestoredCompanionAgenda(f.connection)).toBe(0);
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: completed.run.id })).toEqual(before);
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: pending.run.id }).agendaSteps![0]!.status).toBe('prepared');
  expect(f.db.prepare("SELECT count(*) AS n FROM companion_agenda_audit WHERE kind='restore.held'").get()!.n).toBe(1);
});

it('does not let a restored rule-held batch auto-resume an uncertain effect when its rule is later resumed', () => {
  const f = fixture(), claim = f.claim(); f.step(claim, 'pending_send', 'prepared'); f.step(claim, 'pending_send', 'dispatched');
  const paused = f.send({ type: 'agenda.rule.control', companionId: 'alice', id: claim.rule.id, expectedRevision: claim.rule.revision,
    operationId: 'pause_before_backup', authority: { kind: 'user' }, action: 'pause' }).agendaRule!;
  holdRestoredCompanionAgenda(f.connection);
  const held = f.send({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!;
  expect(held.status).toBe('unknown'); expect(held.pausedByRuleId).toBeUndefined();
  f.send({ type: 'agenda.rule.control', companionId: 'alice', id: paused.id, expectedRevision: paused.revision,
    operationId: 'resume_after_restore', authority: { kind: 'user' }, action: 'resume' });
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!.status).toBe('unknown');
  expect(f.send({ type: 'agenda.claim', companionId: 'alice', now: at, leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaims).toEqual([]);
});
