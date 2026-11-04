import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BotDshBrain, type BotDshHandoff, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotRetention } from '../../src/main/companion-bot/retention';
import { BotStore, botLaneRetentionKey } from '../../src/main/companion-bot/store';
import type { BotClaim } from '../../src/main/companion-bot/types';

const stores: BotStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-handoff-proof-')) throw Error('Invalid test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(limits: { maxTurns?: number; maxBytes?: number } = {}, filename = ':memory:') {
  const store = new BotStore(filename); stores.push(store);
  const companion = store.createCompanion({ id: 'alice', name: 'Alice', persona: '伙伴' }), conversation = store.openDirect(companion.id);
  const calls: Array<Omit<BotDshRun, 'prompt' | 'onEvent'>> = [];
  let nextHandoff: ((input: Omit<BotDshRun, 'prompt' | 'onEvent'>) => Promise<BotDshHandoff>) | undefined;
  const handoff = (input: Omit<BotDshRun, 'prompt' | 'onEvent'>): BotDshHandoff => ({ format: 'worldlinebox-bot-handoff-v1', laneId: input.laneId,
    sessionId: BotDshBrain.sessionId(input.laneId), throughEventId: input.eventId, nativeCursor: 11, summaryText: 'DSH原生摘要：已确认当前计划。', summarySeq: 8,
    compactionId: 'native-compaction-1', coveredEventSeqs: [1, 2], tail: [{ id: 'native-tail', role: 'assistant', content: [{ type: 'text', text: '继续未完成的任务。' }], source: { eventId: input.eventId } }] });
  const options = { store, root: path.resolve('artifacts/test-only-retention'), model: () => ({ apiFormat: 'openai_chat' as const, model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'never-persist-this-key' }),
    callback: async () => ({ url: 'http://127.0.0.1/bot/tool', token: 'never-persist-this-capability' }),
    brain: { async handoff(input: Omit<BotDshRun, 'prompt' | 'onEvent'>) { calls.push(input); return nextHandoff ? nextHandoff(input) : handoff(input); } } };
  const retention = new BotRetention({ ...options, ...limits }); let sequence = 0;
  const claim = () => {
    store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId: `message-${sequence++}`, content: '本轮输入' });
    const value = store.claim({ workerId: 'fixture', leaseMs: 60000 }); expect(value).toBeDefined(); return value!;
  };
  const complete = async (value: BotClaim, inputBytes = 20, outputBytes = 10) => {
    const prepared = await retention.beforeTurn(value.event, new AbortController().signal);
    const metadata = retention.completionMetadata({ event: value.event, system: '身份与路由系统指令', cwd: options.root,
      inputBytes, outputBytes, nativeLaneId: prepared.nativeLaneId });
    store.saveSession(value.event.laneId, BotDshBrain.sessionId(prepared.nativeLaneId));
    expect(store.settle({ eventId: value.event.id, leaseToken: value.leaseToken, status: 'done', content: '已完成', metadata })).toBe(true);
    return prepared;
  };
  return { store, retention, options, claim, complete, calls, conversation, companion, handoff,
    setHandoff: (implementation: NonNullable<typeof nextHandoff>) => { nextHandoff = implementation; } };
}

it('rolls only before the next new event at the default 128-turn or 512KiB boundary', async () => {
  for (const boundary of ['turns', 'bytes'] as const) {
    const f = fixture(); let last!: BotClaim;
    for (let index = 0; index < (boundary === 'turns' ? 128 : 1); index++) {
      last = f.claim(); await f.complete(last, boundary === 'bytes' ? 512 * 1024 - 10 : 20, 10);
    }
    expect(f.calls).toHaveLength(0); expect(f.store.getLane(last.event.laneId)?.epoch).toBe(1);
    const next = f.claim(), result = await f.retention.beforeTurn(next.event, new AbortController().signal);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.eventId).toBe(last.event.id);
    expect(result).toMatchObject({ epoch: 2, nativeLaneId: `${last.event.laneId}-epoch-2`, handoff: { summaryText: 'DSH原生摘要：已确认当前计划。' } });
    expect(next.event.id).not.toBe(last.event.id); expect(f.store.getLane(next.event.laneId)?.sessionId).toBeUndefined();
    expect(f.store.getConversation(f.conversation.id)?.id).toBe(f.conversation.id);
  }
});

it('persists native summary and tail for one durable first event, including retries, then stops injecting it', async () => {
  const f = fixture({ maxTurns: 1 });
  f.setHandoff(async input => Object.assign(f.handoff(input), { model: { apiKey: 'never-persist-this-key' }, callback: { token: 'never-persist-this-capability' } }));
  await f.complete(f.claim());
  const first = f.claim(), prepared = await f.retention.beforeTurn(first.event, new AbortController().signal);
  expect(prepared.handoff?.tail[0]?.id).toBe('native-tail');
  expect(f.store.getMetadata(botLaneRetentionKey(first.event.laneId))).not.toContain('never-persist-this-key');
  expect(f.store.getMetadata(botLaneRetentionKey(first.event.laneId))).not.toContain('never-persist-this-capability');
  const restarted = new BotRetention({ ...f.options, maxTurns: 1 });
  expect(await restarted.beforeTurn(first.event, new AbortController().signal)).toEqual(prepared);
  expect(f.calls).toHaveLength(1);
  const metadata = restarted.completionMetadata({ event: first.event, system: 'identity', cwd: f.options.root, inputBytes: 40, outputBytes: 20, nativeLaneId: prepared.nativeLaneId });
  expect(f.store.settle({ eventId: first.event.id, leaseToken: first.leaseToken, status: 'done', content: '继续完成', metadata })).toBe(true);
  // With a larger limit, the existing epoch continues without repeating its imported history.
  const next = f.claim(), resumed = await new BotRetention({ ...f.options, maxTurns: 128 }).beforeTurn(next.event, new AbortController().signal);
  expect(resumed).toEqual({ epoch: 2, nativeLaneId: prepared.nativeLaneId, handoff: undefined });
  const persisted = f.store.getMetadata(botLaneRetentionKey(first.event.laneId))!;
  expect(persisted).not.toContain('never-persist-this-key'); expect(persisted).not.toContain('never-persist-this-capability');
  expect(f.store.getLaneRetention(first.event.laneId)).toMatchObject({ turns: 1, bytes: 60 });
});

it('transfers a pending handoff reservation after the first event is stopped before any native dispatch', async () => {
  const f = fixture({ maxTurns: 1 }); await f.complete(f.claim());
  const stopped = f.claim(), prepared = await f.retention.beforeTurn(stopped.event, new AbortController().signal);
  expect(prepared.handoff).toBeDefined(); expect(f.store.cancelEvent(stopped.event.id)).toBe(true);
  const next = f.claim(), resumed = await f.retention.beforeTurn(next.event, new AbortController().signal);
  expect(resumed.handoff).toEqual(prepared.handoff); expect(resumed.nativeLaneId).toBe(prepared.nativeLaneId);
  expect(f.store.getLaneRetention(next.event.laneId).handoffEventId).toBe(next.event.id);
  expect(f.calls).toHaveLength(1);
});

it('allows actual failed or cancelled native terminal turns to count bytes and anchor a bounded handoff', async () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const f = fixture({ maxBytes: 100 }), previous = f.claim();
    const active = await f.retention.beforeTurn(previous.event, new AbortController().signal);
    f.store.markDispatched(previous.event.id, previous.leaseToken, previous.event.id);
    const metadata = f.retention.completionMetadata({ event: previous.event, system: 'identity', cwd: f.options.root,
      inputBytes: 70, outputBytes: 30, nativeLaneId: active.nativeLaneId });
    expect(f.store.settle({ eventId: previous.event.id, leaseToken: previous.leaseToken, status, metadata })).toBe(true);
    const next = f.claim(), rollover = await f.retention.beforeTurn(next.event, new AbortController().signal);
    expect(rollover.epoch).toBe(2); expect(f.calls[0]!.eventId).toBe(previous.event.id);
  }
});

it('retains the original native session and counters when handoff fails or its result is invalid', async () => {
  const f = fixture({ maxTurns: 1 }); const previous = f.claim(); await f.complete(previous);
  const next = f.claim(), before = f.store.getLane(previous.event.laneId);
  f.setHandoff(async () => { throw new Error('native compaction failed'); });
  await expect(f.retention.beforeTurn(next.event, new AbortController().signal)).rejects.toThrow('native compaction failed');
  expect(f.store.getLane(previous.event.laneId)).toEqual(before);
  expect(f.store.getEventNativeEpoch(next.event.id)).toBeUndefined();
  f.setHandoff(async input => ({ ...f.handoff(input), summaryText: '', tail: [] }));
  await expect(f.retention.beforeTurn(next.event, new AbortController().signal)).rejects.toThrow('有效、有界');
  expect(f.store.getLaneRetention(previous.event.laneId)).toMatchObject({ epoch: 1, turns: 1, bytes: 30 });
});

it('resumes an admitted event in its bound epoch after a restart instead of replaying it across a new epoch', async () => {
  const f = fixture(); await f.complete(f.claim());
  const current = f.claim(), first = await f.retention.beforeTurn(current.event, new AbortController().signal);
  f.store.markDispatched(current.event.id, current.leaseToken, current.event.id);
  expect(f.store.requeue(current.event.id, current.leaseToken)).toBe(true);
  const recovered = f.store.claim({ workerId: 'after-crash' })!;
  const tighter = new BotRetention({ ...f.options, maxTurns: 1 });
  expect(await tighter.beforeTurn(recovered.event, new AbortController().signal)).toEqual(first);
  expect(f.calls).toHaveLength(0); expect(f.store.getEventNativeEpoch(current.event.id)).toBe(1);
  f.store.rotateDomain(f.companion.id, f.conversation.securityDomainId);
  await expect(tighter.beforeTurn(recovered.event, new AbortController().signal)).rejects.toMatchObject({ code: 'BOT_RETENTION_STALE' });
});

it('fences a handoff finishing after forget and atomically discards already committed handoff material on either withdrawal path', async () => {
  for (const method of ['withdrawSources', 'rotateDomain'] as const) {
    const f = fixture({ maxTurns: 1 }); const prior = f.claim(); await f.complete(prior);
    const next = f.claim(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setHandoff(async input => { await gate; return f.handoff(input); });
    const pending = f.retention.beforeTurn(next.event, new AbortController().signal);
    // callback acquisition is async; let the native operation reach its actual boundary.
    await Promise.resolve(); await Promise.resolve();
    if (method === 'withdrawSources') f.store.withdrawSources(f.companion.id, f.conversation.securityDomainId, [prior.event.id]);
    else f.store.rotateDomain(f.companion.id, f.conversation.securityDomainId);
    release(); await expect(pending).rejects.toMatchObject({ code: 'BOT_RETENTION_STALE' });
    expect(f.store.getLaneRetention(next.event.laneId)).toEqual({ epoch: 2, turns: 0, bytes: 0 });
    expect(f.store.getMetadata(botLaneRetentionKey(next.event.laneId))).toBeUndefined();
    expect(f.store.commitLaneHandoff(next.event.laneId, 1, f.handoff(f.calls[0]!))).toBe(false);
  }
  const f = fixture({ maxTurns: 1 }); await f.complete(f.claim()); const first = f.claim();
  await f.retention.beforeTurn(first.event, new AbortController().signal);
  expect(f.store.getLaneRetention(first.event.laneId).handoff).toBeDefined();
  f.store.rotateDomain(f.companion.id, f.conversation.securityDomainId);
  expect(f.store.getLaneRetention(first.event.laneId)).toEqual({ epoch: 3, turns: 0, bytes: 0 });
});

it('commits completion counters exactly with the accepted reply and rolls metadata back on another transaction error', async () => {
  const f = fixture(), current = f.claim(), prepared = await f.retention.beforeTurn(current.event, new AbortController().signal);
  const metadata = f.retention.completionMetadata({ event: current.event, system: 'identity', cwd: f.options.root, inputBytes: 100, outputBytes: 50, nativeLaneId: prepared.nativeLaneId });
  expect(f.store.settle({ eventId: current.event.id, leaseToken: 'stale-lease', status: 'done', metadata })).toBe(false);
  expect(f.store.getLaneRetention(current.event.laneId).turns).toBe(0);
  f.store.enqueueMemoryJob({ id: 'conflicting-job', kind: 'response', payload: { text: 'original' } });
  expect(() => f.store.settle({ eventId: current.event.id, leaseToken: current.leaseToken, status: 'done', metadata,
    memoryJobs: [{ id: 'conflicting-job', kind: 'response', payload: { text: 'different' } }] })).toThrow();
  expect(f.store.getEvent(current.event.id)?.status).toBe('running'); expect(f.store.getLaneRetention(current.event.laneId).bytes).toBe(0);
  expect(f.store.settle({ eventId: current.event.id, leaseToken: current.leaseToken, status: 'done', content: 'answer', metadata })).toBe(true);
  expect(f.store.settle({ eventId: current.event.id, leaseToken: current.leaseToken, status: 'done', metadata })).toBe(false);
  expect(f.store.getLaneRetention(current.event.laneId)).toMatchObject({ turns: 1, bytes: 150, last: { eventId: current.event.id } });
});

it('records a confirmed native terminal once after UI cancellation has fenced the reply lease', async () => {
  const f = fixture(), current = f.claim(), active = await f.retention.beforeTurn(current.event, new AbortController().signal);
  const input = { event: current.event, system: 'identity', cwd: f.options.root, inputBytes: 90, nativeLaneId: active.nativeLaneId };
  f.retention.trackAdmission(input); f.store.cancelEvent(current.event.id);
  const result = { eventId: current.event.id, sessionId: BotDshBrain.sessionId(active.nativeLaneId), status: 'cancelled' as const, text: 'partial' };
  expect(f.retention.recordCancelledTerminal(input, result)).toBe(true);
  expect(f.retention.recordCancelledTerminal(input, result)).toBe(false);
  expect(f.store.getLaneRetention(current.event.laneId)).toMatchObject({ turns: 1, bytes: 97, last: { eventId: current.event.id } });
  expect(f.store.pendingCancelledNativeAdmissions(current.event.laneId)).toHaveLength(0);
  expect(f.store.getEvent(current.event.id)?.status).toBe('cancelled');
});

it('reconciles a persisted cancelled admission before the next event can hand off its native lane', async () => {
  const f = fixture(), stopped = f.claim(), active = await f.retention.beforeTurn(stopped.event, new AbortController().signal);
  f.retention.trackAdmission({ event: stopped.event, system: 'identity', cwd: f.options.root, inputBytes: 40, nativeLaneId: active.nativeLaneId });
  f.store.cancelEvent(stopped.event.id);
  const order: string[] = [];
  const retention = new BotRetention({ ...f.options, maxTurns: 1, brain: { handoff: async input => { order.push('handoff'); return f.handoff(input); },
    cancelDurable: async input => { order.push('cancel'); return { accepted: true,
      result: { eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), status: 'cancelled', text: '' } }; } } });
  const next = f.claim(), result = await retention.beforeTurn(next.event, new AbortController().signal);
  expect(order).toEqual(['cancel', 'handoff']); expect(result.epoch).toBe(2);
  expect(f.store.pendingCancelledNativeAdmissions(next.event.laneId)).toHaveLength(0);
});

it('keeps an unknown native cancellation durable and accepts only an explicit absence proof without counting a turn', async () => {
  const f = fixture(), stopped = f.claim(), active = await f.retention.beforeTurn(stopped.event, new AbortController().signal);
  f.retention.trackAdmission({ event: stopped.event, system: 'identity', cwd: f.options.root, inputBytes: 40, nativeLaneId: active.nativeLaneId });
  f.store.cancelEvent(stopped.event.id); const next = f.claim();
  const unknown = new BotRetention({ ...f.options, brain: { ...f.options.brain, cancelDurable: async () => { throw new Error('transport interrupted'); } } });
  await expect(unknown.beforeTurn(next.event, new AbortController().signal)).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN' });
  expect(f.store.pendingCancelledNativeAdmissions(next.event.laneId)).toHaveLength(1); expect(f.store.getEventNativeEpoch(next.event.id)).toBeUndefined();
  const absent = new BotRetention({ ...f.options, brain: { ...f.options.brain, cancelDurable: async () => ({ accepted: false, absent: true }) } });
  await expect(absent.beforeTurn(next.event, new AbortController().signal)).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN' });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2100);
  try { expect((await absent.beforeTurn(next.event, new AbortController().signal)).epoch).toBe(1); } finally { clock.mockRestore(); }
  expect(f.store.getLaneRetention(next.event.laneId)).toMatchObject({ turns: 0, bytes: 0 });
});
it('shares one pending native retirement proof between background maintenance and a new turn', async () => {
  const f = fixture(), stopped = f.claim(), active = await f.retention.beforeTurn(stopped.event, new AbortController().signal);
  f.retention.trackAdmission({ event: stopped.event, system: 'identity', cwd: f.options.root, inputBytes: 40, nativeLaneId: active.nativeLaneId });
  f.store.cancelEvent(stopped.event.id);
  let release!: () => void, calls = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new BotRetention({ ...f.options, brain: { ...f.options.brain, cancelDurable: async () => { calls++; await gate; return { accepted: true, absent: true }; } } });
  const background = runtime.reconcileCancelled(stopped.event.laneId, new AbortController().signal), next = f.claim();
  const beforeTurn = runtime.beforeTurn(next.event, new AbortController().signal);
  await Promise.resolve(); await Promise.resolve(); expect(calls).toBe(1);
  release(); await background; expect((await beforeTurn).epoch).toBe(1);
  expect(f.store.pendingCancelledNativeAdmissions(next.event.laneId)).toEqual([]);
});
it('limits native retirement proof concurrency across lanes before any remote I/O', async () => {
  const f = fixture(), lanes: string[] = [];
  for (let index = 0; index < 3; index++) {
    const conversation = f.store.createGroup({ title: `lane ${index}`, kind: 'world', memberIds: [f.companion.id] });
    f.store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId: `source-${index}`, content: '原生事件' });
    const claim = f.store.claim({ workerId: 'fixture' })!, retained = await f.retention.beforeTurn(claim.event, new AbortController().signal);
    f.retention.trackAdmission({ event: claim.event, system: 'identity', cwd: f.options.root, inputBytes: 20, nativeLaneId: retained.nativeLaneId });
    f.store.cancelEvent(claim.event.id); lanes.push(claim.event.laneId);
  }
  let release!: () => void, calls = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new BotRetention({ ...f.options, brain: { ...f.options.brain, cancelDurable: async () => { calls++; await gate; return { accepted: true, absent: true }; } } });
  const first = runtime.reconcileCancelled(lanes[0]!, new AbortController().signal), second = runtime.reconcileCancelled(lanes[1]!, new AbortController().signal);
  await expect(runtime.reconcileCancelled(lanes[2]!, new AbortController().signal)).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN' });
  expect(calls).toBe(2); release(); await Promise.all([first, second]);
  await runtime.reconcileCancelled(lanes[2]!, new AbortController().signal); expect(calls).toBe(3);
});

it('resolves an old-epoch cancellation after forget without restoring its counters or context', async () => {
  const f = fixture(), stopped = f.claim(), active = await f.retention.beforeTurn(stopped.event, new AbortController().signal);
  f.retention.trackAdmission({ event: stopped.event, system: 'forgotten identity', cwd: f.options.root, inputBytes: 40, nativeLaneId: active.nativeLaneId });
  f.store.cancelEvent(stopped.event.id); f.store.rotateDomain(f.companion.id, f.conversation.securityDomainId);
  const retention = new BotRetention({ ...f.options, brain: { ...f.options.brain, cancelDurable: async input => ({ accepted: true,
    result: { eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), status: 'cancelled', text: '' } }) } });
  const next = f.claim(); expect((await retention.beforeTurn(next.event, new AbortController().signal)).epoch).toBe(2);
  expect(f.store.getLaneRetention(next.event.laneId)).toMatchObject({ epoch: 2, turns: 0, bytes: 0 });
  expect(f.store.getMetadata(botLaneRetentionKey(next.event.laneId))).toBeUndefined();
});

it('keeps the first-epoch handoff after native admission/turn-start without user-context commit, and consumes it only with commit proof', async () => {
  for (const committed of [false, true]) {
    const f = fixture({ maxTurns: 1 }); await f.complete(f.claim());
    const stopped = f.claim(), active = await f.retention.beforeTurn(stopped.event, new AbortController().signal);
    expect(active.handoff).toBeDefined();
    const input = { event: stopped.event, system: 'identity', cwd: f.options.root, inputBytes: 90, nativeLaneId: active.nativeLaneId };
    f.retention.trackAdmission(input); f.store.markDispatched(stopped.event.id, stopped.leaseToken, stopped.event.id);
    f.store.cancelEvent(stopped.event.id);
    expect(f.retention.recordCancelledTerminal(input, { eventId: stopped.event.id, sessionId: BotDshBrain.sessionId(active.nativeLaneId),
      status: 'cancelled', text: '', inputContextCommitted: committed })).toBe(true);
    const next = f.claim(), runtime = new BotRetention({ ...f.options, maxTurns: 128 });
    const continued = await runtime.beforeTurn(next.event, new AbortController().signal);
    expect(continued.epoch).toBe(2);
    if (committed) expect(continued.handoff).toBeUndefined();
    else expect(continued.handoff).toEqual(active.handoff);
    expect(f.calls).toHaveLength(1);
  }
});

it('does not consume an unproven first-epoch handoff across a real SQLite close/reopen', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wlb-handoff-proof-')); roots.push(root);
  const filename = path.join(root, 'bot.sqlite'), f = fixture({ maxTurns: 1 }, filename); await f.complete(f.claim());
  const stopped = f.claim(), active = await f.retention.beforeTurn(stopped.event, new AbortController().signal);
  const input = { event: stopped.event, system: 'identity', cwd: root, inputBytes: 50, nativeLaneId: active.nativeLaneId };
  f.retention.trackAdmission(input); f.store.markDispatched(stopped.event.id, stopped.leaseToken, stopped.event.id); f.store.cancelEvent(stopped.event.id);
  f.retention.recordCancelledTerminal(input, { eventId: stopped.event.id, sessionId: BotDshBrain.sessionId(active.nativeLaneId), status: 'cancelled', text: '' });
  stores.splice(stores.indexOf(f.store), 1); f.store.close();
  const reopened = new BotStore(filename); stores.push(reopened);
  reopened.enqueue({ conversationId: f.conversation.id, senderId: 'user', sourceMessageId: 'after-durable-restart', content: '继续' });
  const next = reopened.claim({ workerId: 'after-restart' })!;
  const runtime = new BotRetention({ ...f.options, store: reopened, maxTurns: 128 });
  expect((await runtime.beforeTurn(next.event, new AbortController().signal)).handoff).toEqual(active.handoff);
  const metadata = runtime.completionMetadata({ event: next.event, system: 'identity', cwd: root, inputBytes: 50, outputBytes: 10,
    nativeLaneId: active.nativeLaneId, inputContextCommitted: true });
  expect(reopened.settle({ eventId: next.event.id, leaseToken: next.leaseToken, status: 'done', metadata })).toBe(true);
  expect(reopened.getLaneRetention(next.event.laneId).handoff).toBeUndefined();
});
