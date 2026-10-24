import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';

const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
let directory: string, filename: string, store: CompanionsStore, db: CompanionConnection;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const canary = 'ACTUAL_OWN_SEND_WITHDRAWAL_CANARY';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-16T10:00:00Z');
  directory = mkdtempSync(path.join(tmpdir(), 'companion-activity-source-closure-')); filename = path.join(directory, 'state.sqlite');
  store = new CompanionsStore(filename, ['alice', 'bob', 'charlie'].map(id => ({ id, name: id, persona: '友好且尊重边界', description: '', model: '', avatar: 'sister', proactive: true, active: true })));
  db = new Database(filename);
  const settings = store.request({ type: 'world.snapshot' }).world!.settings;
  store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const owner of ['alice', 'bob', 'charlie']) {
    const scope = { companionId: owner, conversationId: store.openPrivate(owner).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', meals: [], habits: [], sleepAt: '23:00', wakeAt: '07:00' } });
  }
});
afterEach(() => {
  db?.close(); store?.close(); vi.useRealTimers();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-activity-source-closure-') || lstatSync(resolved).isSymbolicLink()) throw new Error('Invalid test cleanup root.');
  rmSync(resolved, { recursive: true, force: true });
});
const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); };
const stored = (id: string) => JSON.parse((db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(id) as { data: string }).data);
function observedOwnSend() {
  const alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '联系bob，依据实际发信情况继续行动并如实汇报。', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...alice, sourceMessageId: source.id, clientId: 'actual_goal', title: '联系并汇报', goal: source.content }).activityTask!;
  const peer = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
  store.request({ type: 'social.send', companionId: 'alice', conversationId: peer.id, authorizationMessageId: source.id,
    content: canary, channel: 'phone', clientId: 'actual_outbound_before_planning' });
  advance(3000);
  const sent = store.request({ type: 'social.job.claim' }).socialMessage!.message;
  expect(sent.authorId).toBe('alice'); expect(sent.content).toBe(canary); advance(3000);
  const leased = store.request({ type: 'activity.claim' }).activityTask!; expect(leased.id).toBe(task.id);
  const observed = store.request({ type: 'activity.observe', id: task.id, leaseToken: leased.leaseToken! });
  expect(observed.activityProgressEvidence?.outbound.some(item => item.message.id === sent.id)).toBe(true);
  // This is the actual extra host readset path: own outbound is observed, while
  // the worker's peer-only evidence does not independently cover that message.
  expect(stored(task.id).evidence.some((item: { id: string }) => item.id === sent.id)).toBe(false);
  const executionReadset = captureCompanionExecutionReadset(alice, { sources: [source, sent].map(message => ({
    id: message.id, conversationId: message.conversationId, checksum: sha(message.content) })) });
  const withdraw = () => {
    store.request({ type: 'memory.forget', companionId: 'alice', conversationId: peer.id, sourceMessageIds: [sent.id] });
    expect(store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: peer.id, ids: [sent.id] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.sources.filter', ...alice, ids: [source.id] }).memorySources?.[0]?.id).toBe(source.id);
  };
  const route = () => store.request({ type: 'world.observe', ...alice }).world!.actors.find(actor => actor.companionId === 'alice')!.route;
  return { alice, bob, source, task, peer, sent, leased, executionReadset, withdraw, route };
}

it('invalidates a leased pending terminal report after extra own-send withdrawal, hides its stage and keeps unrelated tasks claimable', () => {
  const f = observedOwnSend();
  const unrelated = store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '独立聊天暂时占用手机。', replyDirective: 'none' });
  expect(store.request({ type: 'world.work.begin', ...f.alice, sourceMessageId: unrelated.id, workId: 'unrelated_phone', kind: 'chat' }).worldWork?.status).toBe('ready');
  expect(store.request({ type: 'activity.commit', id: f.task.id, leaseToken: f.leased.leaseToken!, expectedStep: f.leased.step,
    decision: { status: 'complete', action: null, wait: null, summary: '实际发信包含 ' + canary }, executionReadset: f.executionReadset }).activityTask?.status).toBe('succeeded');
  expect(stored(f.task.id).reportPending).toBe(true);
  store.request({ type: 'world.work.end', companionId: 'alice', workId: 'unrelated_phone' });
  advance(5100); // The real phone admission scheduled the pending report five seconds later.
  // The report protocol is host provenance validation, not a simulated LLM
  // endorsement. A real source revocation during its lease must still win.
  const report = store.request({ type: 'activity.report.claim', id: f.task.id }).activityReport!;
  expect(report.id).toBe(f.task.id); expect(report.executionReadset.sources.some(item => item.id === f.sent.id)).toBe(true);
  f.withdraw();
  expect(() => store.request({ type: 'activity.report.complete', id: report.id, leaseToken: report.leaseToken,
    executionReadset: report.executionReadset })).toThrow('来源');
  // Bob is the actual peer and may legitimately still be reading that phone
  // delivery. Charlie has no part in it, so this proves global queue admission.
  const charlie = { companionId: 'charlie', conversationId: store.openPrivate('charlie').id };
  const otherSource = store.appendMessage({ conversationId: charlie.conversationId, authorId: 'user', content: '核对自己的联系人。', replyDirective: 'none' });
  const other = store.request({ type: 'activity.start', ...charlie, sourceMessageId: otherSource.id, clientId: 'unrelated_other_owner', title: '核对资料', goal: otherSource.content }).activityTask!;
  advance(5100);
  expect(store.request({ type: 'activity.claim' }).activityTask?.id).toBe(other.id);
  for (let retry = 0; retry < 2; retry++) { advance(5100); expect(() => store.request({ type: 'activity.claim' })).not.toThrow(); }
  expect(stored(f.task.id)).toMatchObject({ status: 'succeeded', reportPending: false });
  expect(stored(f.task.id).reportReadset.sources.some((item: { id: string }) => item.id === f.sent.id)).toBe(true);
  const projected = store.request({ type: 'activity.get', ...f.alice, id: f.task.id }).activityTask!;
  expect(projected.historyAvailable).toBe(false); expect(projected.history).toEqual([]); expect(JSON.stringify(projected)).not.toContain(canary);
  expect(store.messages({ conversationId: f.alice.conversationId }).messages.filter(message => message.replyToId === f.source.id && message.authorId === 'alice'
    && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft)).toEqual([]);
  expect(store.request({ type: 'activity.report.claim', id: f.task.id }).activityReport).toBeUndefined();
});

it('atomically rejects a continue action whose extra own-send source was withdrawn after host review and before the commit RPC', () => {
  const f = observedOwnSend(), beforeRoute = f.route(); f.withdraw();
  expect(() => store.request({ type: 'activity.commit', id: f.task.id, leaseToken: f.leased.leaseToken!, expectedStep: f.leased.step,
    decision: { status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '依据所读发信继续原步骤。' },
    executionReadset: f.executionReadset })).toThrow('真实来源');
  expect(f.route()).toEqual(beforeRoute);
  expect(stored(f.task.id)).toMatchObject({ status: 'running', step: 0, history: [] });
  expect(stored(f.task.id).leaseToken).toBe(f.leased.leaseToken);
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_id=?').get('actual_outbound_before_planning')).toEqual({ n: 1 });
});

it('does not execute a saved deferred proposal after its extra own-send source is withdrawn while the Main lane is occupied', () => {
  const f = observedOwnSend(), beforeRoute = f.route();
  store.request({ type: 'work.enqueue', work: { id: 'same_source_main_lane', ...f.alice, sourceMessageId: f.source.id,
    status: 'queued', proactive: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  const decision = { status: 'continue' as const, action: { action: 'move' as const, destinationId: 'alice_sofa' }, wait: null, summary: '等待实际手机空闲后执行原步骤。' };
  expect(store.request({ type: 'activity.commit', id: f.task.id, leaseToken: f.leased.leaseToken!, expectedStep: f.leased.step,
    decision, executionReadset: f.executionReadset }).activityTask).toMatchObject({ status: 'queued', step: 0, history: [] });
  expect(stored(f.task.id).deferredDecision).toBeDefined();
  expect(stored(f.task.id).evidence.some((item: { id: string }) => item.id === f.sent.id)).toBe(true);
  f.withdraw(); store.request({ type: 'work.status', id: 'same_source_main_lane', status: 'done' }); advance(5100);
  expect(store.request({ type: 'activity.claim' }).activityTask).toBeUndefined();
  expect(stored(f.task.id)).toMatchObject({ status: 'cancelled', step: 0, history: [], reportPending: false });
  expect(stored(f.task.id).deferredDecision).toBeUndefined(); expect(f.route()).toEqual(beforeRoute);
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_id=?').get('actual_outbound_before_planning')).toEqual({ n: 1 });
  expect(store.messages({ conversationId: f.alice.conversationId }).messages.filter(message => message.replyToId === f.source.id && message.authorId === 'alice'
    && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft)).toEqual([]);
});
