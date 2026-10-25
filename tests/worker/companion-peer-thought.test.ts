import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionsRequestSchema } from '../../src/shared/companions';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '独立且尊重边界', description: '', model: '', avatar: 'sister', proactive: true }));
const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
let root: string, filename: string, store: CompanionsStore;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-25T10:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-peer-thought-')); filename = path.join(root, 'messages.sqlite');
  store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true })));
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
  advance(10000);
});
afterEach(() => {
  store?.close();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-peer-thought-')) throw new Error('Invalid fixture cleanup');
  rmSync(resolved, { recursive: true, force: true }); vi.useRealTimers();
});
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function inbound() {
  const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
  const send = { type: 'social.send' as const, companionId: 'alice', conversationId: room.id, channel: 'phone' as const,
    clientId: 'discussion_source', content: '我们讨论一下这个计划的前后依赖，你愿意先独立想清楚再回复吗？' };
  expect(store.request(send).socialPending).toBe(true); advance(1300);
  const source = store.request(send).socialMessage!.message, job = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(job).toMatchObject({ companionId: 'bob', sourceMessageId: source.id, status: 'running' });
  const executionReadset = captureCompanionExecutionReadset({ companionId: 'bob', conversationId: room.id, beforeSequence: job.throughSequence },
    { sources: [{ id: source.id, conversationId: source.conversationId, checksum: createHash('sha256').update(source.content).digest('hex') }] });
  const command = { type: 'peer.thought.create' as const, companionId: 'bob', conversationId: room.id, jobId: job.id,
    leaseToken: job.leaseToken!, effectId: 'native_analysis_1', executionReadset, title: '核对当前讨论', prompt: '只独立分析已提供的当前讨论，不执行工具或替任何人做决定。' };
  return { room, source, job, command };
}
function count(sql: string) { const db = new Database(filename); try { return Number((db.prepare(sql).get() as { n: number }).n); } finally { db.close(); } }

it('binds native peer analysis to the actual live job, renews its lease across a long thought, and retains a private idempotent record', () => {
  const { room, source, job, command } = inbound();
  expect(companionsRequestSchema.safeParse(command).success).toBe(false);
  expect(() => store.request({ ...command, companionId: 'alice' })).toThrow('租约');
  expect(() => store.request({ ...command, leaseToken: 'forged' })).toThrow('租约');
  expect(() => store.request({ ...command, executionReadset: { ...command.executionReadset, companionId: 'alice' } })).toThrow('归属');
  const created = store.request(command), action = created.action!, checkpoint = created.checkpoint!, authorization = checkpoint.activityThought!;
  expect(action).toMatchObject({ companionId: 'bob', conversationId: room.id, sourceMessageId: source.id,
    thought: { kind: 'peer', jobId: job.id, effectId: command.effectId }, status: 'queued' });
  expect(action.authorizationGrantId).toBeUndefined(); expect(checkpoint.dshTask).toBeUndefined();
  expect(authorization).toMatchObject({ kind: 'peer', jobId: job.id, companionId: 'bob', sourceMessageId: source.id, leaseToken: job.leaseToken });
  expect(checkpoint.executionReadset?.sources).toContainEqual(command.executionReadset.sources[0]);
  expect(store.request(command).action!.id).toBe(action.id);
  expect(() => store.request({ ...command, prompt: 'another proposal' })).toThrow('幂等');
  expect(() => store.request({ type: 'checkpoint.save', id: action.id, checkpoint: { ...checkpoint,
    activityThought: { ...authorization, leaseToken: 'forged' } } })).toThrow('凭证');
  const validate = { type: 'activity.thought.validate' as const, authorization, executionReadset: checkpoint.executionReadset!, mode: 'execute' as const, renew: true };
  advance(170000); expect(store.request(validate).activityThoughtValid).toBe(true);
  advance(20000); expect(store.request(validate).activityThoughtValid).toBe(true);
  expect(store.request({ ...validate, authorization: { ...authorization, leaseToken: 'forged' } }).activityThoughtValid).toBe(false);
  store.close(); store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true })));
  expect(store.request(command).action!.id).toBe(action.id);
  const messages = store.messages({ conversationId: room.id }).messages.length;
  store.updateAction(action.id, { status: 'running' }); store.updateAction(action.id, { status: 'succeeded', result: 'PRIVATE_COGNITIVE_RESULT' });
  expect(store.messages({ conversationId: room.id }).messages).toHaveLength(messages);
  expect(count('SELECT COUNT(*) AS n FROM companion_activity_tasks')).toBe(0);
  expect(count('SELECT COUNT(*) AS n FROM actions')).toBe(1);
  expect(store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null,
    executionReadset: checkpoint.executionReadset }).ok).toBe(true);
  expect(store.request(validate).activityThoughtValid).toBe(false);
  expect(store.request({ ...validate, mode: 'read' }).activityThoughtValid).toBe(true);
  expect(() => store.request({ ...command, effectId: 'cannot_revive' })).toThrow('租约');
  expect(count('SELECT COUNT(*) AS n FROM actions')).toBe(1);
});

it('withholds an in-flight analysis after its exact source is withdrawn and never renews an expired job', () => {
  const { room, source, job, command } = inbound(), created = store.request(command), checkpoint = created.checkpoint!;
  const validate = { type: 'activity.thought.validate' as const, authorization: checkpoint.activityThought!, executionReadset: checkpoint.executionReadset!, mode: 'execute' as const, renew: true };
  expect(store.request(validate).activityThoughtValid).toBe(true);
  advance(180001);
  expect(store.request(validate).activityThoughtValid).toBe(false);
  expect(() => store.request(command)).toThrow('租约');
  store.request({ type: 'memory.forget', companionId: 'bob', conversationId: room.id, sourceMessageIds: [source.id] });
  expect(store.request({ ...validate, mode: 'read' }).activityThoughtValid).toBe(false);
  expect(store.request(validate).activityThoughtValid).toBe(false);
  expect(() => store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '不可发布旧分析',
    executionReadset: checkpoint.executionReadset })).toThrow();
  expect(store.messages({ conversationId: room.id }).messages.some(message => message.content === '不可发布旧分析')).toBe(false);
});
