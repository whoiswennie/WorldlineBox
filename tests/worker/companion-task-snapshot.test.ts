import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import { companionsRequestSchema, type CompanionMessage } from '../../src/shared/companions';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionReplyReceivedState } from '../../src/shared/companion-reply-observation';
import type { CompanionReplyTaskSnapshot } from '../../src/shared/companion-reply-task-snapshot';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));
const fixtures: ReturnType<typeof managedMemoryFiles>[] = [], connections: CompanionConnection[] = [];
afterEach(async () => { for (const db of connections.splice(0)) db.close(); for (const f of fixtures.splice(0)) await f.close(); vi.useRealTimers(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-31T04:00:00.000Z'));
  const f = managedMemoryFiles(); fixtures.push(f);
  f.store.request({ type: 'world.tick' });
  for (const owner of ['alice', 'bob']) f.store.request({ type: 'state.get', companionId: owner, conversationId: f.store.openPrivate(owner).id });
  const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite')); connections.push(db);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const dataVersion = () => db.prepare('PRAGMA data_version').get();
  return { f, db, dataVersion };
}

it('captures one SQL task boundary with exact source, paged history and pure current clock while leaving all committed data unchanged', () => {
  const { f, db, dataVersion } = fixture();
  for (let index = 0; index < 110; index++) f.source('真实旧消息 ' + index);
  const source = f.source('当前的新任务。'), before = dataVersion();
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
  const writes: string[] = [], prototype = Object.getPrototypeOf(db.prepare('SELECT 1')), original = prototype.run;
  const spy = vi.spyOn(prototype, 'run').mockImplementation(function (this: { source: string }, ...args: unknown[]) {
    writes.push(this.source); return Reflect.apply(original, this, args);
  });
  let result;
  try { result = f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id }); }
  finally { spy.mockRestore(); }
  expect(writes.filter(sql => !/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/u.test(sql.trim()))).toEqual([]);
  expect(dataVersion()).toEqual(before);
  const snapshot = result.replyTaskSnapshot!, actor = snapshot.actors[0]!;
  expect(snapshot).toMatchObject({ sourceMessageId: source.id, sourceRevision: source.revision ?? 1, sourceChecksum: hash(source.content), sourceSequence: source.sequence });
  expect(actor.historyIds).toHaveLength(111); expect(result.replyTaskMessages!.map(message => message.id)).toEqual(actor.historyIds);
  expect(actor.observation?.capturedAt).toBe(new Date().toISOString());
  const world = JSON.parse(actor.observation!.worldJson);
  expect(world.clock.realNow).toBe(new Date().toISOString()); expect(world.clock.virtualNow).toBe(new Date().toISOString());
  expect(Date.parse(actor.worldSettledAt!)).toBeLessThan(Date.now()); expect(actor.energyElapsedMs).toBeGreaterThan(0);
  expect(world.backlog).toBe(true); expect(actor.observation).toMatchObject({ worldSettledAt: actor.worldSettledAt, worldBacklog: true,
    energySampledAt: actor.energySampledAt, energyElapsedMs: actor.energyElapsedMs });
});

it.each(['player-profile', 'primary-topic'] as const)('does not lazily initialize missing %s while taking a private task snapshot', missing => {
  const { f, db, dataVersion } = fixture(), source = f.source('只读取已提交的任务事实。');
  if (missing === 'player-profile') db.prepare("DELETE FROM player_profile WHERE id='user'").run();
  else db.prepare('DELETE FROM metadata WHERE key=?').run('primary-chat-topic/' + f.scope.conversationId);
  const before = dataVersion(), result = f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id });
  expect(dataVersion()).toEqual(before);
  if (missing === 'player-profile') { expect(result.state!.playerProfile).toBeUndefined(); expect(db.prepare("SELECT 1 FROM player_profile WHERE id='user'").get()).toBeUndefined(); }
  else { expect(result.state!.conversations[0]!.defaultTopicId).toBeUndefined(); expect(db.prepare('SELECT 1 FROM metadata WHERE key=?').get('primary-chat-topic/' + f.scope.conversationId)).toBeUndefined(); }
});

it('derives the same energy over committed occupancy as the real live getter without advancing or persisting it during preparation', () => {
  const { f, db, dataVersion } = fixture(), source = f.source('读取当前精力的任务。');
  db.prepare("UPDATE companion_runtime_states SET data=json_set(data,'$.energy',40),energy_clock=? WHERE companion_id=?").run(Date.now() - 60000, 'alice');
  const before = dataVersion(), result = f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id });
  expect(dataVersion()).toEqual(before);
  const snapshotEnergy = JSON.parse(result.replyTaskSnapshot!.actors[0]!.observation!.runtimeStateJson).energy;
  expect(JSON.parse((db.prepare('SELECT data FROM companion_runtime_states WHERE companion_id=?').get('alice') as { data: string }).data).energy).toBe(40);
  const actual = f.store.request({ type: 'state.get', ...f.scope }).runtimeState!;
  expect(snapshotEnergy).toBeCloseTo(actual.energy, 8); expect(snapshotEnergy).toBeLessThan(40);
});

it('lets actual Main lock the captured observation once and gives the next task a fresh committed version', async () => {
  const { f, db } = fixture(), source = f.source('第一项任务。');
  const first = f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id }).replyTaskSnapshot!;
  type Host = { replyTaskState(checkpoint: CompanionLoopCheckpoint, scope: typeof f.scope, captured?: CompanionReplyReceivedState): Promise<{ world: { clock: { virtualNow: string } }; runtimeState: { energy: number }; marker: { worldSettledAt?: string; energySampledAt?: string } }> };
  const observe = vi.fn(async () => { throw new Error('A formal captured observation must not rerun world advancement.'); });
  const host = Object.assign(Object.create(CompanionService.prototype), { call: f.request, world: { observe } }) as Host;
  const checkpoint: CompanionLoopCheckpoint = { ...f.scope, sourceMessageId: source.id, status: 'running', turns: [], supplements: [] };
  const original = await withCompanionExecutionValidation(() => host.replyTaskState(checkpoint, f.scope, first.actors[0]!.observation));
  expect(original.marker.worldSettledAt).toBe(first.actors[0]!.worldSettledAt); expect(original.marker.energySampledAt).toBe(first.actors[0]!.energySampledAt);
  vi.setSystemTime(Date.now() + 120000);
  db.prepare("UPDATE companion_runtime_states SET data=json_set(data,'$.energy',25),energy_clock=? WHERE companion_id=?").run(Date.now(), 'alice');
  const nextSource = f.source('第二项独立任务。'), next = f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: nextSource.id }).replyTaskSnapshot!;
  const same = await withCompanionExecutionValidation(() => host.replyTaskState(checkpoint, f.scope, next.actors[0]!.observation));
  expect(same.world.clock.virtualNow).toBe(original.world.clock.virtualNow); expect(same.runtimeState.energy).toBe(original.runtimeState.energy);
  expect(JSON.parse(next.actors[0]!.observation!.runtimeStateJson).energy).toBe(25);
  expect(next.actors[0]!.observation!.capturedAt).not.toBe(first.actors[0]!.observation!.capturedAt); expect(observe).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'loop.get', companionId: f.scope.companionId, sourceMessageId: source.id }).loop!.receivedState).toEqual(checkpoint.receivedState);
});

it('keeps concurrent actors individual history and forget scope while transporting the body union only inside the host', () => {
  const { f } = fixture(), group = f.store.request({ type: 'conversation.create-group', title: '同时收到任务', memberIds: ['alice', 'bob'] }).conversation!;
  const old = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: '一条已正式发生的旧消息。' });
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: group.id, sourceMessageIds: [old.id], persistent: true });
  const source = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: '两位同时处理各自的新任务。' });
  const result = f.store.request({ type: 'reply.task.snapshot', conversationId: group.id, sourceMessageId: source.id });
  const snapshot = result.replyTaskSnapshot!;
  type Host = { replySnapshotInputs(snapshot: CompanionReplyTaskSnapshot, bodies: readonly CompanionMessage[], owner: string): { messages: CompanionMessage[] } };
  const host = Object.create(CompanionService.prototype) as Host;
  expect(host.replySnapshotInputs(snapshot, result.replyTaskMessages!, 'alice').messages.map(message => message.id)).not.toContain(old.id);
  expect(host.replySnapshotInputs(snapshot, result.replyTaskMessages!, 'bob').messages.map(message => message.id)).toContain(old.id);
  expect(result.replyTaskMessages!.some(message => message.id === old.id)).toBe(true);
  const next = f.store.request({ type: 'reply.task.snapshot', conversationId: group.id, sourceMessageId: source.id });
  expect(next.replyTaskSnapshot!.actors.map(actor => actor.companionId)).toEqual(['alice', 'bob']);
});

it('excludes known invalid historical placeholders, refuses an unavailable task source and never exposes the private command publicly', () => {
  const { f, db } = fixture(), original = f.source('旧回复最初的真实依据。');
  const old = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '现在已撤回的旧回复。',
    executionReadset: captureCompanionExecutionReadset(f.scope, { sources: [{ id: original.id, conversationId: original.conversationId, checksum: hash(original.content) }] }) });
  const source = f.source('仍然有效的新任务。');
  db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run('execution-source-invalid/message/' + old.id, JSON.stringify({ invalidatedAt: new Date().toISOString() }));
  const result = f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id });
  expect(result.replyTaskSnapshot!.actors[0]!.historyIds).not.toContain(old.id);
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id], persistent: true });
  expect(() => f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id })).toThrow('来源');
  expect(companionsRequestSchema.safeParse({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id }).success).toBe(false);
});

it.each(['habit', 'withdrawn-routine-source', 'missing-runtime', 'missing-routine'] as const)('does not migrate or write through pure world rendering for %s', condition => {
  const { f, db, dataVersion } = fixture(), prior = f.source('正式的已有作息来源。'), source = f.source('这次只读取任务状态。');
  if (condition === 'missing-runtime') db.prepare('DELETE FROM companion_runtime_states WHERE companion_id=?').run('alice');
  if (condition === 'missing-routine') db.prepare('DELETE FROM companion_routines WHERE companion_id=?').run('alice');
  if (condition === 'habit' || condition === 'withdrawn-routine-source') {
    const row = db.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string };
    const world = JSON.parse(row.data), actor = world.actors.find((value: { companionId: string }) => value.companionId === 'alice');
    actor.activity = 'habit'; actor.routinePhase = 'habit'; delete actor.manualArtAction;
    db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(world));
  }
  if (condition === 'withdrawn-routine-source') {
    db.prepare("UPDATE companion_routines SET data=json_set(data,'$.configurationSources',json(?)) WHERE companion_id=?")
      .run(JSON.stringify([{ messageId: prior.id, conversationId: prior.conversationId }]), 'alice');
    f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [prior.id], persistent: true });
  }
  const before = dataVersion(), result = f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id });
  expect(dataVersion()).toEqual(before);
  if (condition === 'habit') expect(result.replyTaskSnapshot!.actors[0]!.observation).toBeDefined();
  else expect(result.replyTaskSnapshot!.actors[0]!.observation).toBeUndefined();
});

it('does not re-read history or create a new state receipt for an already prepared task', () => {
  const { f } = fixture(), source = f.source('继续当前已经准备的任务。');
  f.store.request({ type: 'loop.save', checkpoint: { ...f.scope, sourceMessageId: source.id, status: 'running', turns: [], supplements: [], context: { system: '固定正式输入', user: '{}' } } });
  const result = f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id });
  expect(result.replyTaskMessages).toEqual([]); expect(result.replyTaskSnapshot!.actors[0]!).toMatchObject({ companionId: 'alice', historyIds: [] });
  expect(result.replyTaskSnapshot!.actors[0]!.observation).toBeUndefined();
});

it('reads current library metadata in one batch with the exact old single-row visibility and ownership rules', () => {
  const { f } = fixture(), source = f.source('实际日记来源。'), first = f.record('第一项准确记录。', [source.id]), second = f.record('第二项准确记录。', [source.id]);
  const expected = [first, second].map(note => f.store.request({ type: 'memory.library.read', companionId: 'alice', id: note.id }).memoryRead!.memory);
  expect(f.store.request({ type: 'memory.library.read-many', companionId: 'alice', ids: [first.id, second.id, first.id, 'missing'] }).memories).toEqual(expected);
  expect(() => f.store.request({ type: 'memory.library.read-many', companionId: 'bob', ids: [first.id] })).toThrow('不属于');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id], persistent: true });
  expect(f.store.request({ type: 'memory.library.read-many', companionId: 'alice', ids: [first.id, second.id] }).memories).toEqual([]);
  expect(companionsRequestSchema.safeParse({ type: 'memory.library.read-many', companionId: 'alice', ids: [first.id] }).success).toBe(false);
});
