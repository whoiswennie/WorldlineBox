import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionAction } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { verifyCompanionCapabilityEvidence } from '../../src/main/companions/capability-evidence';
import { validateCompanionCapabilityAuthorities } from '../../src/companions/capability-evidence-store';
import { createCompanionCapabilityReadPort } from '../../src/companions/capability-evidence-read-port';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const at = '2026-10-29T10:00:00.000Z';
let root: string, store: CompanionsStore, db: CompanionConnection;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
  root = mkdtempSync(path.join(tmpdir(), 'capability-authority-'));
  const filename = path.join(root, 'messages.sqlite');
  store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '根据实际来源交流。', model: '', avatar: 'sister', active: true, proactive: false })));
  db = new (Database as { new(filename: string): CompanionConnection })(filename);
});
afterEach(() => { db.close(); store.close(); vi.useRealTimers(); removeOwnedDirectorySync(root); });
const batch = (actions: CompanionAction[]) => store.request({ type: 'execution.capabilities.validate',
  actions: actions.map(({ id, companionId, conversationId, capability }) => ({ id, companionId, conversationId, capability })) }).capabilityAuthorityResults!.map(value => value.valid);
const asyncChecks = (actions: CompanionAction[]) => Promise.all(actions.map(action => verifyCompanionCapabilityEvidence(action,
  { request: async command => store.request(command), throwTemporaryUnavailable: true })));
function messageCapabilities(count = 1) {
  const room = store.openPrivate('alice'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请查看本人日程。', replyDirective: 'none' });
  const reply = store.appendMessage({ conversationId: room.id, authorId: 'alice', content: '', replyToId: source.id, loopStep: 0 });
  const calls = Array.from({ length: count }, (_, index) => ({ id: 'call_' + index, name: 'agenda', arguments: '{"action":"tasks.read"}' }));
  const checkpoint: CompanionLoopCheckpoint = { companionId: 'alice', conversationId: room.id, sourceMessageId: source.id, messageId: reply.id,
    status: 'running' as const, turns: [{ text: '', rawText: '', calls }], supplements: [] };
  store.request({ type: 'loop.save', checkpoint });
  const actions = calls.map(call => store.request({ type: 'capability.begin', companionId: 'alice', conversationId: room.id, title: '查看日程',
    name: call.name, callId: call.id, invocationId: source.id + ':alice', input: call.arguments, sourceMessageId: source.id, parentMessageId: reply.id, loopStep: 0 }).action!);
  return { room, source, reply, checkpoint, actions };
}
function selfThought() {
  const room = store.openPrivate('alice');
  const grant = store.request({ type: 'agenda.grant.configure', companionId: 'alice', operationId: 'grant', authority: { kind: 'user' },
    grant: { title: '本人思考范围', capabilities: ['dsh'], fileRoots: [], outputRoots: [], windowIds: [], captureSources: [], allowPublicWeb: false,
      expiresAt: '2026-10-29T10:05:00.000Z' } }).agendaGrant!;
  store.request({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'self', authority: { kind: 'system' }, rule: {
    title: '核对想法', intent: '核对已有材料。', kind: 'self', executor: 'brain', trigger: { kind: 'at', at, timeZone: 'UTC' }, reason: '本次实际安排' } });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: at, facts: { active: true } });
  const claim = store.request({ type: 'agenda.claim', companionId: 'alice', now: at, limit: 1, leaseMs: 30000, excludedOwners: [] }).agendaClaim!;
  store.request({ type: 'agenda.run.bindGrant', companionId: 'alice', id: claim.run.id, leaseToken: claim.leaseToken, now: at, grantId: grant.id, grantRevision: grant.revision });
  const action = store.request({ type: 'capability.begin', companionId: 'alice', conversationId: room.id, title: '思考实际材料', name: 'think', callId: 'thought',
    invocationId: claim.run.id, input: '{"question":"核对实际材料。"}', agendaRunId: claim.run.id, leaseToken: claim.leaseToken }).action!;
  return { action, grant, claim, room };
}

it('uses one real synchronous batch and shares common SQL reads while matching Main for distinct tool calls', async () => {
  const f = messageCapabilities(8);
  const dispatch = vi.spyOn(store as unknown as { dispatch(command: CompanionStorageCommand): CompanionStorageResponse }, 'dispatch');
  expect(batch(f.actions)).toEqual(Array(8).fill(true));
  const commands = dispatch.mock.calls.map(([command]) => command.type);
  expect(commands.filter(type => type === 'state')).toHaveLength(0);
  expect(commands.filter(type => type === 'loop.for-message')).toHaveLength(0);
  expect(commands.filter(type => type === 'action.get')).toHaveLength(0);
  expect(commands.filter(type => type === 'memory.sources.filter')).toHaveLength(1);
  dispatch.mockRestore();
  expect(await asyncChecks(f.actions)).toEqual(Array(8).fill(true));
  const reordered = { ...f.actions[1]!, capability: Object.fromEntries(Object.entries(f.actions[1]!.capability!).reverse()) };
  db.prepare('UPDATE actions SET data=? WHERE id=?').run(JSON.stringify(reordered), reordered.id);
  expect(batch(f.actions)).toEqual(Array(8).fill(true));
  f.checkpoint.turns[0]!.calls[0]!.name = 'world'; store.request({ type: 'loop.save', checkpoint: f.checkpoint });
  expect(batch(f.actions)).toEqual([false, ...Array(7).fill(true)]);
  expect(batch(f.actions)).toEqual(await asyncChecks(f.actions));
  for (const field of ['name', 'inputHash', 'callId', 'invocationId'] as const) {
    const substituted = { ...f.actions[1]!.capability!, [field]: field === 'inputHash' ? 'a'.repeat(64) : 'substituted' };
    expect(batch([{ ...f.actions[1]!, capability: substituted }])).toEqual([false]);
  }
});

it('reads the real parent identity, calls and task request without decoding saved context or provider/tool bodies', async () => {
  const f = messageCapabilities();
  f.checkpoint.context = { system: 'OPAQUE_SYSTEM'.repeat(10000), user: JSON.stringify({ taskRequest: { sourceMessageId: f.source.id, prompt: f.source.content }, ignored: 'OPAQUE_CONTEXT'.repeat(100000) }) };
  f.checkpoint.turns[0]!.rawText = 'OPAQUE_RAW'.repeat(6000);
  store.request({ type: 'loop.save', checkpoint: f.checkpoint });
  const projected = createCompanionCapabilityReadPort(db, f.actions, command => store.request(command));
  const view = projected({ type: 'loop.for-message', messageId: f.reply.id }).loop!;
  expect(JSON.stringify(view)).not.toContain('OPAQUE_');
  expect(view.turns[0]!.calls).toEqual(f.checkpoint.turns[0]!.calls);
  expect(JSON.parse(view.context!.user)).toEqual({ taskRequest: { sourceMessageId: f.source.id, prompt: f.source.content } });
  expect(batch(f.actions)).toEqual([true]); expect(batch(f.actions)).toEqual(await asyncChecks(f.actions));
});

it.each(['revoked', 'expired', 'foreign-run', 'missing-run', 'private-port'] as const)('matches Main on a real private thought after %s changes current authority', async change => {
  const f = selfThought(); expect(batch([f.action])).toEqual([true]); expect(await asyncChecks([f.action])).toEqual([true]);
  if (change === 'revoked') store.request({ type: 'agenda.grant.revoke', companionId: 'alice', id: f.grant.id, expectedRevision: f.grant.revision, operationId: 'revoke', authority: { kind: 'user' } });
  if (change === 'expired') vi.setSystemTime('2026-10-29T10:05:00.000Z');
  if (change === 'foreign-run' || change === 'missing-run') db.prepare('UPDATE companion_agenda_runs SET companion_id=?,data=? WHERE id=?').run('bob', JSON.stringify({ ...f.claim.run, companionId: 'bob' }), f.claim.run.id);
  if (change === 'missing-run') db.prepare('DELETE FROM companion_agenda_runs WHERE id=?').run(f.claim.run.id);
  if (change === 'private-port') db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('world-room/' + f.room.id, '{}');
  if (change === 'foreign-run' || change === 'missing-run') {
    // The canonical run read deliberately withholds existence across owners.
    // Availability failure must remain a rejection, never a tombstone proof.
    expect(() => batch([f.action])).toThrow('暂不可核验');
    await expect(asyncChecks([f.action])).rejects.toThrow('暂不可核验'); return;
  }
  expect(batch([f.action])).toEqual([false]); expect(batch([f.action])).toEqual(await asyncChecks([f.action]));
});

it.each(['not-ok', 'throws'] as const)('reports %s verification as unavailable instead of attesting a withdrawal', mode => {
  const action = messageCapabilities().actions[0]!;
  expect(() => validateCompanionCapabilityAuthorities([action], () => {
    if (mode === 'throws') throw new Error('The read port is unavailable.');
    return { ok: false, error: 'The read port is unavailable.' };
  })).toThrow('暂不可核验');
});

it('matches Main after a real cross-owner collaboration grant is cancelled', async () => {
  const origin = store.openPrivate('alice'), child = store.openPrivate('bob');
  const source = store.appendMessage({ conversationId: origin.id, authorId: 'user', content: '请bob核对安排。', replyDirective: 'none' });
  const grant = store.request({ type: 'collaboration.create', companionId: 'alice', conversationId: origin.id, sourceMessageId: source.id,
    title: '核对安排', goal: source.content, parentInvocationId: 'parent', evidence: ['请bob核对安排'], participants: [{ companionId: 'bob', goal: '核对安排。' }], clientId: 'batch_collaboration' }).collaboration!;
  store.request({ type: 'collaboration.respond', id: grant.id, companionId: 'bob', decision: 'accept', reason: '接受。' });
  const invocationId = source.id + ':bob:child';
  store.request({ type: 'collaboration.start', id: grant.id, companionId: 'bob', invocationId: 'child', conversationId: child.id });
  const parent = store.appendMessage({ conversationId: child.id, authorId: 'bob', content: '', loopStep: 0 });
  const call = { id: 'collaboration_call', name: 'agenda', arguments: '{"action":"tasks.read"}' };
  store.request({ type: 'loop.save', checkpoint: { companionId: 'bob', conversationId: child.id, sourceMessageId: source.id, messageId: parent.id,
    authorizationGrantId: grant.id, invocationKey: 'child', status: 'running', turns: [{ text: '', rawText: '', calls: [call] }], supplements: [] } });
  const action = store.request({ type: 'capability.begin', companionId: 'bob', conversationId: child.id, sourceMessageId: source.id,
    parentMessageId: parent.id, authorizationGrantId: grant.id, loopStep: 0, title: '核对安排', name: call.name, callId: call.id, input: call.arguments, invocationId }).action!;
  expect(batch([action])).toEqual([true]); expect(await asyncChecks([action])).toEqual([true]);
  store.request({ type: 'collaboration.cancel', companionId: 'alice', id: grant.id, reason: '撤回本次协作。' });
  // A completed domain check proves revocation; an unavailable read port is
  // still covered separately above and cannot attest a withdrawal.
  expect(batch([action])).toEqual([false]);
  expect(await asyncChecks([action])).toEqual([false]);
});
