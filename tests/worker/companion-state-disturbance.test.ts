import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionStateStore, type CompanionMemoryStateIntegration } from '../../src/companions/state-store';


let root: string, filename: string, store: CompanionsStore;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-disturbance-')); filename = path.join(root, 'state.sqlite');
  store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, persona: '温柔但有个人边界', description: '', model: '', avatar: 'sister', active: true, proactive: true })));
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const id of ['alice', 'bob']) {
    const s = scope(id), routine = store.request({ type: 'routine.get', ...s }).routine!;
    store.request({ type: 'routine.configure', ...s, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  }
  advance(30000);
});
afterEach(() => { store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-disturbance-')) throw new Error('Unexpected fixture'); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const scope = (id = 'alice') => ({ companionId: id, conversationId: store.openPrivate(id).id });
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; }
const state = (id = 'alice') => store.request({ type: 'state.get', ...scope(id) }).runtimeState!;
const message = (content = '你现在怎么样？', id = 'alice') => store.appendMessage({ conversationId: scope(id).conversationId, authorId: 'user', content, replyDirective: 'chat' });
function sleep(id = 'alice') {
  const s = scope(id), r = store.request({ type: 'routine.get', ...s }).routine!;
  store.request({ type: 'routine.configure', ...s, expectedRevision: r.revision, patch: { sleepAt: '09:00', wakeAt: '11:00' } });
  expect(advance(30000).actors.find(actor => actor.companionId === id)?.activity).toBe('sleeping');
}
function urgent(source: ReturnType<typeof message>) {
  store.request({ type: 'world.attention.record', ...scope(), sourceMessageId: source.id, sourceChecksum: createHash('sha256').update(source.content).digest('hex'), urgency: 'urgent', confidence: 1, evidence: [source.content], reason: '玩家真实指定当前事项需要优先。' });
  return store.request({ type: 'interruption.begin', ...scope(), sourceMessageId: source.id }).interruption!;
}

it('does not turn normal questions or a burst of messages into a measured psychological penalty', () => {
  const before = state(); for (let index = 0; index < 6; index++) message();
  const after = state(); expect(after.energy).toBe(before.energy); expect(after.experience).toEqual(before.experience); expect(after.relationshipRecords).toEqual(before.relationshipRecords);
  expect(after).not.toHaveProperty('affect'); expect(after).not.toHaveProperty('familiarity');
});
it('keeps ordinary communication available during sleep without inventing feelings from the number of messages', () => {
  sleep(); const before = state(); for (let index = 0; index < 5; index++) message();
  const after = state(); expect(after.routine?.phase).toBe('sleeping'); expect(after.routine?.canRespond).toBe(true);
  expect(after.experience).toEqual(before.experience); expect(after.relationshipRecords).toEqual(before.relationshipRecords);
});
it('records real urgent attention once and does not mechanically lower trust or create a subjective feeling', () => {
  sleep(); const source = message('现在有件真实紧急事项需要你先回应。'), before = state();
  expect(urgent(source)).toBeDefined(); const after = state();
  expect(after.relationshipRecords).toEqual(before.relationshipRecords); expect(after.experience).toEqual(before.experience);
  store.request({ type: 'interruption.begin', ...scope(), sourceMessageId: source.id }); expect(state().energy).toBe(after.energy);
  expect(store.request({ type: 'world.snapshot' }).world!.events.some(event => event.kind === 'social_interrupt' && event.sourceMessageId === source.id)).toBe(true);
});
it('preserves a sourced specific boundary, hides it in other rooms and withdraws it on forgetting', () => {
  const source = message('这次请先确认再改文件。');
  const changed = store.request({ type: 'state.update', ...scope(), proposal: { reason: '当前事项的边界。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }],
    relationshipUpdates: [{ targetId: 'user', topic: '文件变更', context: '当前文件检查', kind: 'boundary', statement: '这次先确认再修改。', reassessWhen: ['本次检查结束。'] }] } }).runtimeState!;
  expect(changed.relationshipRecords).toHaveLength(1);
  const group = store.createConversation('公共空间', ['alice', 'bob']);
  expect(store.request({ type: 'state.get', companionId: 'alice', conversationId: group.id }).runtimeState?.relationshipRecords).toEqual([]);
  store.request({ type: 'memory.forget', ...scope(), sourceMessageIds: [source.id] }); expect(state().relationshipRecords).toEqual([]);
});
it('returns at most five actual change receipts without relabeling energy polling as a fresh subjective event', () => {
  for (let index = 0; index < 8; index++) {
    const source = message('我现在先核对第' + index + '步。');
    store.request({ type: 'state.update', ...scope(), proposal: { reason: '真实来源 ' + index, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }],
      experience: { situation: '正在逐项核验。', statement: source.content, reassessWhen: ['本步结束。'] } } });
  }
  const receipts = state().recentChanges!; expect(receipts).toHaveLength(5);
  advance(1000); expect(state().recentChanges).toEqual(receipts);
});
it('applies formal memory integration once per note version and skips a stale delivery update', () => {
  const source = message('我今天读到：把复杂问题分解，逐步核实每一步。');
  const note = store.request({ type: 'memory.record', ...scope(), candidate: { content: '本次读到逐步核实的方法，尚未验证。', diaryName: '资料', artifactKind: 'knowledge', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const Database = BetterSqlite3 as { new(filename: string): CompanionConnection }, db = new Database(filename);
  const engine = new CompanionStateStore(db, (s, ids) => store.request({ type: 'memory.sources.filter', ...s, ids }).memorySources ?? [], (_id, _from, _to, energy) => energy,
    () => ({ phase: 'awake', nextTransitionAt: new Date(Date.now() + 3600000).toISOString(), canRespond: true, simulation: true }), at => at);
  try {
    const input: CompanionMemoryStateIntegration = { eventKey: 'actual-round-1', kind: 'learning', reason: '对读到的方法保持待验证。', expression: 'direct',
      sourceMessageIds: [source.id], memoryVersions: [{ id: note.id, version: note.version }] };
    const first = engine.applyMemoryIntegration(scope(), input);
    expect(first.expression).toBe('direct'); expect(first.relationshipRecords).toEqual([]); expect(first.recentChanges?.[0]).toMatchObject({ kind: 'memory', memoryIds: [note.id] });
    expect(engine.applyMemoryIntegration(scope(), { ...input, eventKey: 'same-version-later' }).revision).toBe(first.revision);
    expect(() => engine.applyMemoryIntegration(scope(), { ...input, memoryVersions: [{ id: note.id, version: note.version + 1 }] })).toThrow('版本');
    const newer = store.request({ type: 'memory.revise', ...scope(), id: note.id, expectedVersion: note.version, candidate: { content: '仍需实践核验。', artifactKind: 'knowledge', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
    engine.invalidateMemoryVersions('alice', [{ id: note.id, version: note.version }]); expect(state().expression).toBe('gentle');
    const skipped = engine.applyMemoryIntegration(scope(), { ...input, expectedRevision: first.revision - 1, expression: 'playful', memoryVersions: [{ id: newer.id, version: newer.version }] });
    expect(skipped.expression).toBe('gentle'); expect(skipped.relationshipRecords).toEqual([]);
    store.request({ type: 'memory.forget', ...scope(), sourceMessageIds: [source.id] }); expect(state().recentChanges).toEqual([]);
  } finally { db.close(); }
});
