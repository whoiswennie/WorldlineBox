import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { companionLoopCheckpointSchema } from '../../src/shared/companion-loop';
import { assertCompanionTaskAssetsBinding } from '../../src/shared/companion-task-assets-binding';
import { companionContextFrameSchema } from '../../src/shared/companion-cognition';
import { companionTaskPreparation } from '../../src/shared/companion-task-preparation';

let store: CompanionsStore, root: string;
const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '真实伙伴。', model: '', avatar: 'sister' as const, active: true, proactive: false }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-30T10:00:00.000Z');
  root = mkdtempSync(path.join(tmpdir(), 'task-assets-seal-')); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
});
afterEach(() => {
  store.close(); vi.useRealTimers();
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('task-assets-seal-')) throw new Error('Invalid fixture cleanup');
  removeOwnedDirectorySync(root);
});
const blob = (binding: { ownerId: string; conversationId: string; sourceMessageId: string; invocationKey?: string }, persona = '此任务开始时的正式人格。') => JSON.stringify({
  schema: 'worldlinebox.task-assets-v1', ...binding, capturedAt: new Date().toISOString(), revocationEpoch: 0,
  snapshot: { profile: { persona } }, cultivationGoals: [], externalRefs: [], rawSources: [],
});
function loop(): CompanionLoopCheckpoint {
  const room = store.openPrivate('alice'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '这是第一项独立任务。', replyDirective: 'none' });
  return { conversationId: room.id, sourceMessageId: source.id, companionId: 'alice', status: 'running', turns: [], supplements: [] };
}

it('seals the first exact loop asset bytes before or after bubble creation and restores them across old callbacks and restart', () => {
  const first = loop(), initial = blob({ ownerId: 'alice', conversationId: first.conversationId, sourceMessageId: first.sourceMessageId });
  store.request({ type: 'loop.save', checkpoint: { ...first, taskAssets: initial } });
  const bubble = store.appendMessage({ conversationId: first.conversationId, authorId: 'alice', content: '', loopStep: 0 });
  // This callback was created before taskAssets existed and now mounts a bubble.
  store.request({ type: 'loop.save', checkpoint: { ...first, messageId: bubble.id } });
  let saved = store.request({ type: 'loop.get', sourceMessageId: first.sourceMessageId, companionId: 'alice' }).loop!;
  expect(saved.taskAssets).toBe(initial);
  expect(() => store.request({ type: 'loop.save', checkpoint: { ...saved, taskAssets: blob({ ownerId: 'alice', conversationId: first.conversationId,
    sourceMessageId: first.sourceMessageId }, '后来的新人格不能覆盖本任务。') } })).toThrow('已封存');
  const { taskAssets: _old, ...stale } = saved; void _old;
  store.request({ type: 'loop.save', checkpoint: stale });
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  saved = store.request({ type: 'loop.get', sourceMessageId: first.sourceMessageId, companionId: 'alice' }).loop!;
  expect(saved.taskAssets).toBe(initial);
  const next = loop(), nextAssets = blob({ ownerId: 'alice', conversationId: next.conversationId, sourceMessageId: next.sourceMessageId }, '下一任务使用新的正式人格。');
  store.request({ type: 'loop.save', checkpoint: { ...next, taskAssets: nextAssets } });
  expect(store.request({ type: 'loop.get', sourceMessageId: next.sourceMessageId, companionId: 'alice' }).loop!.taskAssets).toBe(nextAssets);
  expect(store.request({ type: 'loop.get', sourceMessageId: first.sourceMessageId, companionId: 'alice' }).loop!.taskAssets).toBe(initial);
});

it.each(['ownerId', 'conversationId', 'sourceMessageId', 'invocationKey'] as const)('rejects an initial loop package with a different %s', field => {
  const first = loop(), binding = { ownerId: 'alice', conversationId: first.conversationId, sourceMessageId: first.sourceMessageId };
  expect(() => store.request({ type: 'loop.save', checkpoint: { ...first, taskAssets: blob({ ...binding, [field]: 'other_task' }) } })).toThrow('不属于');
  expect(store.request({ type: 'loop.get', sourceMessageId: first.sourceMessageId, companionId: 'alice' }).loop?.taskAssets).toBeUndefined();
});

it('supports an asset package above 8MiB while enforcing a 16MiB UTF-8 bound and the durable scope marker', () => {
  const first = loop(), binding = { ownerId: 'alice', conversationId: first.conversationId, sourceMessageId: first.sourceMessageId };
  const large = blob(binding, 'a'.repeat(8 * 1024 * 1024 + 1024));
  expect(companionLoopCheckpointSchema.parse({ ...first, taskAssets: large }).taskAssets).toBe(large);
  expect(() => assertCompanionTaskAssetsBinding(large, binding)).not.toThrow();
  expect(() => assertCompanionTaskAssetsBinding(blob(binding, '中'.repeat(6 * 1024 * 1024)), binding)).toThrow('16MiB');
  const marker = companionContextFrameSchema.shape.taskAssets.unwrap().parse({ kind: 'task_initial', capturedAt: new Date().toISOString(),
    conversationId: first.conversationId, sourceMessageId: first.sourceMessageId, digest: 'a'.repeat(64) });
  expect(marker.conversationId).toBe(first.conversationId);
  expect(() => companionContextFrameSchema.shape.taskAssets.unwrap().parse({ ...marker, digest: 'missing_digest' })).toThrow();
});

function advance(ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
it('seals the complete independent-goal input across missing old callbacks and restart', () => {
  const first = { ...loop(), invocationKey: 'goal_independent_initial' };
  const binding = { kind: 'goal' as const, ownerId: first.companionId, conversationId: first.conversationId,
    sourceMessageId: first.sourceMessageId, invocationKey: first.invocationKey };
  const receipt = { kind: 'received', capturedAt: new Date().toISOString(), revocationEpoch: 0 };
  const initial = companionTaskPreparation(binding, { frame: { clock: 'initial', messages: [], role: 'first' } }, receipt);
  store.request({ type: 'loop.save', checkpoint: { ...first, goalPreparation: initial } });
  store.request({ type: 'loop.save', checkpoint: first });
  const saved = store.request({ type: 'loop.get', companionId: first.companionId, sourceMessageId: first.sourceMessageId, invocationKey: first.invocationKey }).loop!;
  expect(saved.goalPreparation).toBe(initial);
  expect(() => store.request({ type: 'loop.save', checkpoint: { ...saved, goalPreparation: companionTaskPreparation(binding,
    { frame: { clock: 'later' } }, { capturedAt: new Date().toISOString(), revocationEpoch: 0 }) } })).toThrow('已封存');
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  expect(store.request({ type: 'loop.get', companionId: first.companionId, sourceMessageId: first.sourceMessageId, invocationKey: first.invocationKey }).loop!.goalPreparation).toBe(initial);
});
function incoming() {
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
  advance(10000);
  const room = store.openPrivate('bob'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请联系alice核对真实读书安排。', replyDirective: 'none' });
  const peer = store.request({ type: 'social.conversation.ensure', companionId: 'bob', memberIds: ['alice', 'bob'] }).socialConversation!;
  const command = { type: 'social.send' as const, companionId: 'bob', conversationId: peer.id, channel: 'phone' as const,
    content: '可以一起核对读书安排吗？', clientId: 'asset_seal_incoming', authorizationMessageId: source.id, agentSource: { conversationId: room.id, messageId: source.id } };
  store.request(command); advance(1300); store.request(command);
  const rule = store.request({ type: 'agenda.read', companionId: 'alice', limit: 100 }).agenda!.rules.find(item => item.referenceVersion === 'world-native-v1')!;
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const parent = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
  const scope = { companionId: 'alice', agendaRunId: parent.run.id, agendaLeaseToken: parent.leaseToken, id: rule.referenceId! };
  const job = store.request({ type: 'social.job.claim', ...scope }).socialJob!;
  return { job, parent, scope };
}

it('seals a social task asset package under its real parent lease and preserves it through retry and restart', () => {
  const { job, scope } = incoming(), initial = blob({ ownerId: 'alice', conversationId: job.conversationId, sourceMessageId: job.sourceMessageId, invocationKey: job.id });
  const command = { type: 'social.job.assets.save' as const, companionId: 'alice', id: job.id, leaseToken: job.leaseToken!, taskAssets: initial };
  const first = store.request(command).socialJob!;
  expect(first.taskAssets).toBe(initial); expect(store.request(command).socialJob).toEqual(first);
  expect(() => store.request({ ...command, taskAssets: blob({ ownerId: 'alice', conversationId: job.conversationId,
    sourceMessageId: job.sourceMessageId, invocationKey: job.id }, '较新的人格只属于下一条消息。') })).toThrow('已封存');
  expect(() => store.request({ ...command, leaseToken: 'wrong_lease' })).toThrow('租约');
  store.request({ type: 'social.job.defer', companionId: 'alice', id: job.id, leaseToken: job.leaseToken!, retryAfterMs: 1000, error: '等待原任务继续' });
  advance(1100);
  const renewed = store.request({ type: 'social.job.claim', ...scope }).socialJob!;
  expect(renewed.taskAssets).toBe(initial);
  expect(() => store.request(command)).toThrow('租约');
  expect(store.request({ ...command, leaseToken: renewed.leaseToken! }).socialJob!.taskAssets).toBe(initial);
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  expect(store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!.taskAssets).toBe(initial);
});

it('rejects a foreign social asset package and prevents a stopped parent from saving even identical bytes', () => {
  const { job, parent } = incoming(), binding = { ownerId: 'alice', conversationId: job.conversationId, sourceMessageId: job.sourceMessageId, invocationKey: job.id };
  const command = { type: 'social.job.assets.save' as const, companionId: 'alice', id: job.id, leaseToken: job.leaseToken!, taskAssets: blob(binding) };
  expect(() => store.request({ ...command, taskAssets: blob({ ...binding, invocationKey: 'other_job' }) })).toThrow('不属于');
  expect(store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!.taskAssets).toBeUndefined();
  store.request(command);
  const run = store.request({ type: 'agenda.run.read', companionId: 'alice', id: parent.run.id }).agendaRun!;
  store.request({ type: 'agenda.run.control', companionId: 'alice', id: run.id, expectedRevision: run.revision, operationId: 'pause_asset_task', authority: { kind: 'user' }, action: 'pause' });
  expect(() => store.request(command)).toThrow(/停止|租约/u);
  expect(store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!.taskAssets).toBe(command.taskAssets);
});

it('seals the complete social preparation under its exact native parent lease and retains it through retry', () => {
  const { job, scope } = incoming();
  const binding = { kind: 'social' as const, ownerId: job.companionId, conversationId: job.conversationId,
    sourceMessageId: job.sourceMessageId, invocationKey: job.id };
  const preparation = companionTaskPreparation(binding, { input: { world: { clock: 'at_receipt' }, memories: [] }, frame: { messages: [] } },
    { capturedAt: new Date().toISOString(), revocationEpoch: 0 });
  const command = { type: 'social.job.preparation.save' as const, companionId: job.companionId, id: job.id, leaseToken: job.leaseToken!, preparation };
  expect(store.request(command).socialJob!.preparation).toBe(preparation);
  expect(() => store.request({ ...command, preparation: companionTaskPreparation(binding, { input: { world: 'later' } },
    { capturedAt: new Date().toISOString(), revocationEpoch: 0 }) })).toThrow('已封存');
  expect(() => store.request({ ...command, leaseToken: 'another_task_lease' })).toThrow('租约');
  store.request({ type: 'social.job.defer', companionId: job.companionId, id: job.id, leaseToken: job.leaseToken!, retryAfterMs: 1000, error: '等待容量恢复' });
  advance(1100);
  const resumed = store.request({ type: 'social.job.claim', ...scope }).socialJob!;
  expect(resumed.preparation).toBe(preparation);
  expect(store.request({ ...command, leaseToken: resumed.leaseToken! }).socialJob!.preparation).toBe(preparation);
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  expect(store.request({ type: 'social.job.read', companionId: job.companionId, id: job.id }).socialJob!.preparation).toBe(preparation);
});

it.each(['owner_inactive', 'membership_removed'] as const)('checks current SQL admission without rebuilding the sealed social frame: %s', change => {
  const { job } = incoming(), command = { type: 'social.job.check' as const, companionId: job.companionId, id: job.id, leaseToken: job.leaseToken! };
  expect(store.request(command).socialJob?.id).toBe(job.id);
  // Simulate a real out-of-band metadata change: no Main notification or
  // task-frame rebuild is needed for the independent SQL admission fence.
  const db = new (Database as { new(filename: string): CompanionConnection })(path.join(root, 'state.sqlite'));
  try {
    if (change === 'owner_inactive') db.prepare("UPDATE companions SET data=json_set(data,'$.active',0) WHERE id=?").run(job.companionId);
    else db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(job.conversationId, job.companionId);
    expect(store.request(command).socialJob).toBeUndefined();
  } finally { db.close(); }
});
