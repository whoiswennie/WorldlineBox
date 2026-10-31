import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import { commitCompanionAgendaMessage } from '../../src/companions/agenda-message-guard';
import { companionAgendaModelView } from '../../src/main/companions/agenda-model-view';
import { companionAgendaPublicCommandSchema, type CompanionAgendaCommand } from '../../src/shared/companion-agenda';
import { nodeCompanionConnection } from '../fixtures/node-companion-connection';

const closers: Array<() => void> = [], at = '2026-10-29T08:00:00.000Z';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); });
afterEach(() => { for (const close of closers.splice(0)) close(); vi.useRealTimers(); });
function fixture() {
  const { db, connection } = nodeCompanionConnection(); closers.push(() => db.close());
  db.exec(`CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT,deleted_at TEXT);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,kind TEXT,muted INTEGER,private_companion_id TEXT,dissolved_at TEXT);
    CREATE TABLE conversation_members(conversation_id TEXT,companion_id TEXT);CREATE TABLE deliveries(content TEXT);
    INSERT INTO companions VALUES('alice','{"active":true,"proactive":true}',NULL);
    INSERT INTO conversations VALUES('own_room','private',0,'alice',NULL);INSERT INTO conversation_members VALUES('own_room','alice');`);
  const store = new CompanionAgendaStore(connection); store.initialize();
  const send = (command: unknown) => store.execute(command as CompanionAgendaCommand)!;
  const rule = send({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'rule', authority: { kind: 'system' }, rule: {
    title: '本人自主事件', intent: '在已绑定范围内进行', kind: 'self', executor: 'brain', trigger: { kind: 'at', at, timeZone: 'UTC' },
    conversationId: 'own_room', reason: '测试准确能力绑定' } }).agendaRule!;
  send({ type: 'agenda.tick', companionId: 'alice', now: at, facts: {} });
  const claim = send({ type: 'agenda.claim', companionId: 'alice', now: at }).agendaClaim!;
  let sequence = 0;
  const grantDraft = { title: '全局本人范围', capabilities: ['files.deliver'], fileRoots: [], outputRoots: [], windowIds: [], captureSources: [], allowPublicWeb: false };
  const grant = (patch = {}) => send({ type: 'agenda.grant.configure', companionId: 'alice', operationId: 'grant_' + ++sequence,
    authority: { kind: 'user' }, grant: { ...grantDraft, ...patch } }).agendaGrant!;
  const bind = (id: string, revision: number) => send({ type: 'agenda.run.bindGrant', companionId: 'alice', id: claim.run.id,
    leaseToken: claim.leaseToken, now: at, grantId: id, grantRevision: revision });
  const append = vi.fn((message: { content: string }) => { db.prepare('INSERT INTO deliveries VALUES(?)').run(message.content); return { messageId: 'actual_delivery' }; });
  const commit = () => commitCompanionAgendaMessage(connection, { companionId: 'alice', runId: claim.run.id, leaseToken: claim.leaseToken,
    unsolicited: true, message: { authorId: 'alice', conversationId: 'own_room', content: '本次实际产物' } }, append);
  return { db, send, rule, claim, grantDraft, grant, bind, append, commit };
}

it('binds an exact global scope idempotently and keeps that binding out of calendar/model projections', () => {
  const f = fixture(), grant = f.grant(), first = f.bind(grant.id, grant.revision).agendaRun!;
  expect(first).toMatchObject({ activeGrantId: grant.id, activeGrantRevision: 1 });
  expect(f.bind(grant.id, grant.revision).agendaRun!.revision).toBe(first.revision);
  expect(companionAgendaPublicCommandSchema.safeParse({ type: 'agenda.run.bindGrant', companionId: 'alice', id: first.id,
    leaseToken: f.claim.leaseToken, now: at, grantId: grant.id, grantRevision: 1 }).success).toBe(false);
  const actual = f.send({ type: 'agenda.run.read', companionId: 'alice', id: first.id });
  expect(actual.agendaRun!.activeGrantId).toBe(grant.id);
  const model = companionAgendaModelView(actual, { conversationId: 'own_room', allowPrivate: true });
  expect(model.agendaRun!.activeGrantId).toBeUndefined(); expect(model.agendaRun!.activeGrantRevision).toBeUndefined();
  const calendar = f.send({ type: 'agenda.read', companionId: 'alice', limit: 50 }).agenda!;
  expect(calendar.runs[0]!.activeGrantId).toBeUndefined(); expect(calendar.runs[0]!.activeGrantRevision).toBeUndefined();
});

it.each(['goal', 'conversation'] as const)('does not borrow a %s-specific scope for an otherwise ungranted self event', kind => {
  const f = fixture();
  const goal = f.send({ type: 'agenda.goal.create', companionId: 'alice', operationId: 'specific_goal', authority: { kind: 'user' }, goal: {
    title: '另一个具体方向', intent: '仅限这个方向', domain: 'project', successCriteria: ['有实际产物'] } }).agendaGoal!;
  const grant = f.grant(kind === 'goal' ? { goalId: goal.id } : { conversationId: 'own_room' });
  expect(() => f.bind(grant.id, grant.revision)).toThrow(/持续|范围/u);
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: f.claim.run.id }).agendaRun!.activeGrantId).toBeUndefined();
});

it('cannot replace a bound grant revision and refuses message delivery after that grant is edited', () => {
  const f = fixture(), grant = f.grant(); f.bind(grant.id, grant.revision);
  const changed = f.send({ type: 'agenda.grant.configure', companionId: 'alice', id: grant.id, expectedRevision: grant.revision,
    operationId: 'revise_actual_scope', authority: { kind: 'user' }, grant: { ...f.grantDraft, title: '已经修订的范围' } }).agendaGrant!;
  expect(changed.revision).toBe(2); expect(() => f.bind(grant.id, changed.revision)).toThrow('准确授权');
  expect(f.send({ type: 'agenda.run.read', companionId: 'alice', id: f.claim.run.id }).agendaRun!.activeGrantRevision).toBe(1);
  expect(f.commit).toThrow('已经修订'); expect(f.append).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n).toBe(0);
});

it('revoking a scope stops a bound run even when the original sealed rule did not name that grant', () => {
  const f = fixture(), grant = f.grant(); f.bind(grant.id, grant.revision);
  expect(f.rule.grantId).toBeUndefined();
  f.send({ type: 'agenda.grant.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision,
    operationId: 'revoke_bound_scope', authority: { kind: 'user' } });
  const actual = f.send({ type: 'agenda.run.read', companionId: 'alice', id: f.claim.run.id }).agendaRun!;
  expect(actual.status).toBe('unknown'); expect(actual.leaseToken).toBeUndefined(); expect(actual.activeGrantId).toBe(grant.id);
  expect(f.commit).toThrow('已停止'); expect(f.append).not.toHaveBeenCalled();
});
