import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionStateStore, type CompanionMemoryStateIntegration } from '../../src/companions/state-store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';

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

it('does not penalize normal questions or turn message count into relationship changes', () => {
  const before = state();
  for (let index = 0; index < 8; index++) message('一个正常问题 ' + index);
  const after = state();
  expect(after.affect).toEqual(before.affect); expect(after.relationship).toEqual(before.relationship); expect(after.energy).toBe(before.energy);
  expect(after.recentChanges?.some(item => item.kind === 'interruption')).toBe(false);
});

it('keeps sleep and chat independent, but records one bounded attention burden for a burst of unanswered notifications', () => {
  sleep(); const before = state();
  const first = message(); message(); message();
  expect(state().affect).toEqual(before.affect);
  const fourth = message(); const affected = state();
  expect(affected.affect.pleasure).toBeLessThan(before.affect.pleasure); expect(affected.energy).toBeCloseTo(before.energy - 1, 8);
  expect(affected.relationship).toEqual(before.relationship);
  expect(affected.recentChanges?.[0]).toMatchObject({ kind: 'interruption', energyDelta: -1, sourceMessageIds: expect.arrayContaining([first.id, fourth.id]) });
  expect(companionStorageResponseSchema.safeParse({ ok: true, runtimeState: affected }).success).toBe(true);
  message(); message(); expect(state().affect).toEqual(affected.affect); expect(state().energy).toBe(affected.energy);
  const work = store.request({ type: 'world.work.begin', ...scope(), kind: 'chat', workId: 'parallel_chat', sourceMessageId: first.id }).worldWork!;
  expect(work.status).toBe('ready'); expect(store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')?.activity).toBe('sleeping');
});

it('does not treat a back-and-forth conversation as a notification burst', () => {
  sleep(); const before = state();
  for (let index = 0; index < 5; index++) {
    message(); store.appendMessage({ conversationId: scope().conversationId, authorId: 'alice', content: '收到，我慢慢和你聊。' });
  }
  const after = state(); expect(after.affect).toEqual(before.affect); expect(after.relationship).toEqual(before.relationship);
  expect(after.recentChanges?.some(item => item.kind === 'interruption')).toBe(false);
});

it.each(['eating', 'working'] as const)('observes actual %s activity while leaving ordinary phone replies available', phase => {
  if (phase === 'eating') {
    const r = store.request({ type: 'routine.get', ...scope() }).routine!;
    store.request({ type: 'routine.configure', ...scope(), expectedRevision: r.revision, patch: { meals: [{ name: '用餐', at: '10:00', durationMinutes: 30 }] } });
  } else {
    const source = store.appendMessage({ conversationId: scope().conversationId, authorId: 'user', content: '先处理这项正式工作。', replyDirective: 'none' });
    store.request({ type: 'world.work.begin', ...scope(), workId: 'computer_focus', kind: 'action', sourceMessageId: source.id });
  }
  expect(advance(30000).actors.find(actor => actor.companionId === 'alice')?.activity).toBe(phase);
  const before = state(); message(); message(); message(); const source = message();
  const after = state(); expect(after.energy).toBeCloseTo(before.energy - 1, 8); expect(after.relationship).toEqual(before.relationship);
  expect(store.request({ type: 'world.work.begin', ...scope(), workId: 'phone_parallel', kind: 'chat', sourceMessageId: source.id }).worldWork?.status).toBe('ready');
});

it('attributes an actual peer interruption to that peer evidence without changing the player relationship', () => {
  const pair = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
  store.request({ type: 'social.message.append', conversationId: pair.id, authorId: 'bob', content: '你好alice，我是bob。', virtualCreatedAt: new Date().toISOString(), clientId: 'known_peer' });
  sleep('bob'); const before = state('bob');
  store.request({ type: 'world.tool', ...scope('alice'), arguments: { action: 'message', recipientIds: ['bob'], text: '现在有件急事，需要先听你说一下。', urgent: true } });
  let job = store.request({ type: 'social.job.claim' }).socialJob;
  for (let i = 0; !job && i < 10; i++) { advance(600); job = store.request({ type: 'social.job.claim' }).socialJob; }
  expect(job?.companionId).toBe('bob');
  const after = state('bob'); expect(after.relationship).toEqual(before.relationship);
  expect(after.recentChanges?.find(change => change.kind === 'interruption')).toMatchObject({ sourceMessageIds: [job!.sourceMessageId], energyDelta: -2 });
  expect(store.getMessage(job!.sourceMessageId).authorId).toBe('alice');
});

it('does not charge dormant companions or mistake formal setting evidence for a chat burst', () => {
  sleep(); message(); message();
  const r = store.request({ type: 'routine.get', ...scope() }).routine!;
  store.request({ type: 'routine.configure', ...scope(), expectedRevision: r.revision, patch: { meals: [] } });
  message(); expect(state().recentChanges?.some(change => change.kind === 'interruption')).toBe(false);
  store.setCompanionActive('alice', false); const before = state();
  for (let i = 0; i < 6; i++) message();
  expect(state().energy).toBe(before.energy); expect(state().affect).toEqual(before.affect);
});

it('uses a real urgent interruption once and preserves the source without mechanically lowering player trust', () => {
  sleep(); const source = message('现在有件真实紧急事项需要你先回应。'), before = state();
  const interruption = urgent(source); expect(interruption).toBeDefined();
  const after = state(); expect(after.affect.pleasure).toBeLessThan(before.affect.pleasure); expect(after.energy).toBeCloseTo(before.energy - 2, 8);
  expect(after.relationship).toEqual(before.relationship);
  expect(after.recentChanges?.[0]).toMatchObject({ kind: 'interruption', sourceMessageIds: [source.id], energyDelta: -2 });
  store.request({ type: 'interruption.begin', ...scope(), sourceMessageId: source.id }); expect(state().affect).toEqual(after.affect); expect(state().energy).toBe(after.energy);
  const events = store.request({ type: 'world.snapshot' }).world!.events;
  expect(events.some(event => event.kind === 'social_interrupt' && event.sourceMessageId === source.id && event.conversationId === source.conversationId)).toBe(true);
});

it('keeps the burden separate from semantic appraisal and withdraws hidden causes after forgetting', () => {
  sleep(); message(); message(); message(); const source = message('我支持你，我也尊重你的边界。');
  const affected = state();
  const supported = store.request({ type: 'state.update', ...scope(), proposal: { sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], reason: '真实表达支持。', appraisals: [{ type: 'support', target: 'user', intensity: .5, confidence: 1 }] } }).runtimeState!;
  expect(supported.relationship.affinity).toBeGreaterThan(affected.relationship.affinity);
  const group = store.createConversation('公共空间', ['alice', 'bob']);
  expect(store.request({ type: 'state.get', companionId: 'alice', conversationId: group.id }).runtimeState?.recentChanges).toEqual([]);
  store.request({ type: 'memory.forget', ...scope(), sourceMessageIds: [source.id] });
  const forgotten = state(); expect(forgotten.recentChanges?.some(change => change.kind === 'interruption' || change.kind === 'appraisal')).toBe(false); expect(forgotten.relationship.affinity).toBe(50);
  for (const dimension of ['pleasure', 'arousal', 'dominance'] as const) expect(forgotten.affect[dimension]).toBeCloseTo(affected.affect[dimension] - affected.recentChanges![0]!.affectDelta[dimension], 8);
});

it('returns at most five applied receipts and never relabels energy polling as a fresh emotional event', () => {
  for (let index = 0; index < 8; index++) {
    const source = message('我支持你，也尊重你。' + index);
    store.request({ type: 'state.update', ...scope(), proposal: { reason: '来自真实支持 ' + index, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], appraisals: [{ type: 'support', target: 'user', intensity: .2, confidence: 1 }] } });
  }
  const receipts = state().recentChanges!; expect(receipts).toHaveLength(5);
  advance(1000); expect(state().recentChanges).toEqual(receipts);
});

it('applies formal memory integration once per note version, cannot alter user relationship, and skips stale expression updates', () => {
  const source = message('我今天读到：把复杂问题分解，逐步核实每一步。');
  const note = store.request({ type: 'memory.record', ...scope(), candidate: { content: '我更愿意逐步核实问题。', diaryName: '自我认知', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const Database = BetterSqlite3 as { new(filename: string): CompanionConnection }, db = new Database(filename);
  const engine = new CompanionStateStore(db, (s, ids) => store.request({ type: 'memory.sources.filter', ...s, ids }).memorySources ?? [], (_id, _from, _to, energy) => energy,
    () => ({ phase: 'awake', nextTransitionAt: new Date(Date.now() + 3600000).toISOString(), canRespond: true, simulation: true }), at => at,
    { virtualAt: at => at, elapsedVirtual: (from, to) => Math.max(0, to - from), timeZone: () => 'UTC' });
  try {
    const input: CompanionMemoryStateIntegration = { eventKey: 'actual-round-1', kind: 'learning', reason: '本次有来源的学习支持了逐步核实的表达方式。', expression: 'direct',
      appraisals: [{ type: 'shared_success', target: 'self', intensity: .2, confidence: 1 }], sourceMessageIds: [source.id], memoryVersions: [{ id: note.id, version: note.version }] };
    const before = state(), first = engine.applyMemoryIntegration(scope(), input);
    expect(first.expression).toBe('direct'); expect(first.relationship).toEqual(before.relationship); expect(first.recentChanges?.[0]).toMatchObject({ kind: 'memory', memoryIds: [note.id], expression: { before: 'gentle', after: 'direct' } });
    expect(engine.applyMemoryIntegration(scope(), { ...input, eventKey: 'later-round-with-same-note' }).affect).toEqual(first.affect);
    expect(() => engine.applyMemoryIntegration(scope(), { ...input, memoryVersions: [{ id: note.id, version: note.version + 1 }] })).toThrow('版本');
    expect(() => engine.applyMemoryIntegration(scope(), { ...input, appraisals: [{ type: 'respect', target: 'user', intensity: 1, confidence: 1 }] })).toThrow('用户关系');
    const newer = store.request({ type: 'memory.revise', ...scope(), id: note.id, expectedVersion: note.version, candidate: { content: '我会更谨慎地逐步核实问题。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
    engine.invalidateMemoryVersions('alice', [{ id: note.id, version: note.version }]);
    const revised = state(); expect(revised.expression).toBe('gentle'); expect(revised.recentChanges?.some(change => change.kind === 'memory')).toBe(false);
    const skipped = engine.applyMemoryIntegration(scope(), { ...input, expectedRevision: first.revision - 1, expression: 'playful', memoryVersions: [{ id: newer.id, version: newer.version }] });
    expect(skipped.expression).toBe('gentle'); expect(skipped.affect).toEqual(revised.affect);
    expect((db.prepare("SELECT value FROM metadata WHERE key GLOB 'state-memory-integration/*'").get() as { value: string }).value).toContain('state_revision_changed');
    store.request({ type: 'memory.forget', ...scope(), sourceMessageIds: [source.id] }); expect(state().recentChanges).toEqual([]);
  } finally { db.close(); }
});
